#!/usr/bin/env node
/**
 * Tests for provider registration against HanaAgent's own files.
 *
 * The interesting behaviour here is not "write a JSON file" — it is what happens around
 * that: a provider the user deleted in HanaAgent is tombstoned in
 * `provider-catalog.json`'s `meta.deletedProviders`, and re-declaring it then writes files
 * that HanaAgent ignores forever. A sync that keeps reporting success while the provider
 * never appears is worse than a sync that fails, so the tombstone is checked before
 * anything is written.
 *
 * Everything runs in a temp directory that looks like a HanaAgent home. No app, no network.
 *
 *   node scripts/test-hana-registration.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isBridgeOwnedProvider, providerTombstoned, toModelDeclarations, writeProviderPlugin, BRIDGE_MARKER } from "../hana-providers.mjs";

let failures = 0;
let checks = 0;
function check(name, condition, detail) {
	checks += 1;
	if (!condition) failures += 1;
	process.stdout.write(`  ${condition ? "ok  " : "FAIL"}  ${name}${detail === undefined ? "" : `  (${detail})`}\n`);
}
function section(title) {
	process.stdout.write(`\n${title}\n`);
}

const root = mkdtempSync(join(tmpdir(), "hana-broke-reg-"));
/**
 * The bearer every declaration must now carry.
 *
 * `writeProviderPlugin` refuses an empty key: a provider registered without one
 * would be called with no `Authorization` header, which the bridge no longer
 * accepts. Making that a hard error here is the point — a test that could
 * register an unkeyed provider would be testing a shape that cannot ship.
 */
const TOKEN = "test-bearer-0123456789abcdefghij";
/** A HanaAgent home with an optional set of tombstoned provider ids. */
function homeWith(deleted) {
	const home = join(root, `home-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "provider-catalog.json"), `${JSON.stringify({
		catalogVersion: 2,
		providers: {},
		meta: deleted === undefined ? {} : { deletedProviders: deleted },
	}, null, 2)}\n`);
	return home;
}
const models = [{ id: "m1", name: "Model One", contextWindow: 1000, maxTokens: 100, supportsImages: true }];

try {
	section("declaration file");
	{
		const home = homeWith([]);
		const written = writeProviderPlugin({ id: "bridge-one", displayName: "Bridge One", baseUrl: "http://127.0.0.1:1/v1", models, apiKey: TOKEN, hanaHome: home, description: `via ${BRIDGE_MARKER}` });
		check("the provider file is written", written.changed === true && written.modelCount === 1);
		const provider = JSON.parse(readFileSync(join(home, "provider-plugins", "bridge-one", "providers", "bridge-one.json"), "utf8"));
		check("it names a loopback base URL", provider.defaultBaseUrl === "http://127.0.0.1:1/v1");
		check("it declares the OpenAI completions dialect", provider.defaultApi === "openai-completions");
		// `none` was the old value, and it is the defect: HanaAgent skips the key
		// for a loopback base URL when the provider says `none`, so the bridge would
		// have accepted anonymous callers. `api-key` plus the shared bearer is what
		// makes the per-request check real.
		check("it declares api-key auth, not none", provider.authType === "api-key", String(provider.authType));
		check("it carries the bearer HanaAgent must present", provider.apiKey === TOKEN, provider.apiKey === undefined ? "absent" : "present");
		check("the model carries its limits", provider.models[0].context === 1000 && provider.models[0].maxOutput === 100);
		check("the manifest is present", JSON.parse(readFileSync(join(home, "provider-plugins", "bridge-one", "manifest.json"), "utf8")).type === "provider-plugin");
		check("the bridge can recognise its own work", isBridgeOwnedProvider("bridge-one", home) === true);

		// Writing identical content must not touch the file: every re-sync would otherwise
		// rewrite a user's config for no reason.
		const again = writeProviderPlugin({ id: "bridge-one", displayName: "Bridge One", baseUrl: "http://127.0.0.1:1/v1", models, apiKey: TOKEN, hanaHome: home, description: `via ${BRIDGE_MARKER}` });
		check("an unchanged declaration writes nothing", again.changed === false);
	}

	// The field names are HanaAgent's, not ours. Both of these were wrong once and failed
	// silently: a list under the wrong key is dropped by the normalizer (the model appears
	// without its thinking levels) and a missing boolean hides the thinking control
	// entirely, with nothing reporting why.
	section("model field names");
	{
		const [declared] = toModelDeclarations([{
			id: "m", name: "M", contextWindow: 1000, maxTokens: 100, supportsImages: true,
			reasoning: true, supportedEfforts: ["low", "high", "max", "bogus"],
		}]);
		check("reasoning is a boolean, not a level list", declared.reasoning === true);
		check("levels live in customThinkingLevels", JSON.stringify(declared.customThinkingLevels) === JSON.stringify(["low", "high", "max"]), JSON.stringify(declared.customThinkingLevels));
		check("an unknown level is dropped", declared.customThinkingLevels.includes("bogus") === false);
		check("the spellings HanaAgent ignores are not written", declared.efforts === undefined && declared.defaultEffort === undefined && declared.supportedEfforts === undefined);
		const [bare] = toModelDeclarations([{ id: "b", name: "B" }]);
		// A declaration is merged over the previous one, so an absent flag keeps the old
		// value — which is how a model ends up advertising vision it never had.
		check("vision is stated even when absent", bare.image === false);
		check("reasoning is stated even when absent", bare.reasoning === false);
		check("no levels means no level list", bare.customThinkingLevels === undefined);
		const [levelsOnly] = toModelDeclarations([{ id: "l", supportedEfforts: ["high"] }]);
		check("levels alone still enable reasoning", levelsOnly.reasoning === true);
	}

	section("tombstone");
	{
		const home = homeWith(["bridge-two"]);
		check("a tombstoned id reads as deleted", providerTombstoned("bridge-two", home) === true);
		check("a provider that was never added reads as not deleted", providerTombstoned("bridge-three", home) === false);
		const blocked = writeProviderPlugin({ id: "bridge-two", displayName: "Bridge Two", baseUrl: "http://127.0.0.1:2/v1", models, apiKey: TOKEN, hanaHome: home });
		check("declaring a tombstoned provider is refused", blocked.tombstoned === true && blocked.changed === false);
		check("and it writes no provider file", (() => {
			try {
				readFileSync(join(home, "provider-plugins", "bridge-two", "providers", "bridge-two.json"), "utf8");
				return false;
			} catch {
				return true;
			}
		})());
		// The catalogue can be sealed by the app, in which case the tombstone state is
		// unknown — which must not be reported as "not deleted".
		const sealed = join(root, "home-sealed");
		mkdirSync(sealed, { recursive: true });
		writeFileSync(join(sealed, "provider-catalog.json"), "HANA-SECRET-1.AES-256-GCM.abc.def");
		check("a sealed catalogue reports unknown, not clean", providerTombstoned("bridge-two", sealed) === undefined);
		check("a sealed catalogue does not block a write", (() => {
			const written = writeProviderPlugin({ id: "bridge-four", displayName: "Bridge Four", baseUrl: "http://127.0.0.1:4/v1", models, apiKey: TOKEN, hanaHome: sealed });
			return written.changed === true && written.tombstoned === undefined;
		})());
		check("a home with no catalogue at all reports unknown", providerTombstoned("bridge-two", join(root, "home-missing")) === undefined);
	}

	section("validation");
	{
		const home = homeWith([]);
		let threw = false;
		try {
			writeProviderPlugin({ id: "../escape", displayName: "x", baseUrl: "http://127.0.0.1:1/v1", models, hanaHome: home });
		} catch {
			threw = true;
		}
		check("a path-ish id is refused", threw);
		threw = false;
		try {
			writeProviderPlugin({ id: "empty", displayName: "x", baseUrl: "http://127.0.0.1:1/v1", models: [], hanaHome: home });
		} catch {
			threw = true;
		}
		check("a provider with no models is refused", threw);
	}
} finally {
	// Cleaned up at the very end, after the report, rather than here: a `rmSync` racing the
	// process exit on Windows trips a libuv assertion ("UV_HANDLE_CLOSING") after every check
	// has already passed, which reads as a crash even though nothing failed.
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
rmSync(root, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);

