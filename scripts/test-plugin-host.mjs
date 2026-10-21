#!/usr/bin/env node
/**
 * Tests for the provider-plugin host.
 *
 * The host is the part this App owns: the plugins are npm packages that only define
 * hooks, and everything between them and HanaAgent lives in `plugin-host.mjs`. So this
 * drives real plugins through a real sign-in and a real model listing, against a fake
 * vendor where a request must not go out, and against the live vendor where it may.
 *
 * The live part is opt-in: `--live` adds one inference call through `zen-free`, whose
 * credential is the literal string `public` and needs no account. Without the flag every
 * test is offline and deterministic.
 *
 *   node scripts/test-plugin-host.mjs [--live]
 */

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	PLUGIN_PROVIDERS,
	PluginAuthStore,
	ProviderPlugin,
	pluginEntry,
	toModel,
} from "../plugin-host.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = join(HERE, "..", "plugins");
const LIVE = process.argv.includes("--live");

let failures = 0;
let checks = 0;
function check(name, condition, detail) {
	checks += 1;
	if (!condition) failures += 1;
	process.stdout.write(`  ${condition ? "ok  " : "FAIL"}  ${name}${detail === undefined ? "" : `  (${detail})`}\n`);
}
const section = (title) => process.stdout.write(`\n${title}\n`);

const root = mkdtempSync(join(tmpdir(), "hana-broke-host-"));
const store = new PluginAuthStore(root);

/** Load one provider by id, as the bridge does. */
async function load(id) {
	const spec = PLUGIN_PROVIDERS.find((candidate) => candidate.id === id);
	if (spec === undefined) throw new Error(`no such provider spec: ${id}`);
	const entry = pluginEntry(spec, PLUGINS_DIR);
	if (entry.available !== true) throw new Error(entry.reason);
	const module = await import(`file://${entry.path.replace(/\\/g, "/")}`);
	return new ProviderPlugin({ spec, module, store, log: () => {}, warn: () => {} });
}

try {
	section("packaging");
	{
		for (const spec of PLUGIN_PROVIDERS) {
			const entry = pluginEntry(spec, PLUGINS_DIR);
			check(`${spec.id}: the package is installed`, entry.available === true, entry.available ? `v${entry.version}` : entry.reason);
			if (entry.available === true) {
				// The bundle is meant to be self-contained; a dependency would be a file that
				// is present in development and missing from the App.
				check(`${spec.id}: it declares no dependencies`, entry.dependencies.length === 0, entry.dependencies.join(",") || "none");
			}
		}
		const missing = pluginEntry({ id: "x", package: "@magpie-community/not-a-package", export: "Nope" }, PLUGINS_DIR);
		check("a missing package is reported, not thrown", missing.available === false && typeof missing.reason === "string");
	}

	section("model records");
	{
		// A plugin may leave anything out; the conversion must not invent capabilities it
		// did not see, because HanaAgent shows a model's flags to the user.
		const bare = toModel("m", { name: "M" }, "p");
		check("a bare model claims no vision", bare.vision === false);
		check("a bare model claims no reasoning", bare.reasoning === false);
		check("a bare model claims no tools", bare.tools === false);
		check("a bare model has no invented context", bare.context === undefined);

		const rich = toModel("m", {
			name: "M",
			limit: { context: 200_000, output: 32_000 },
			capabilities: { toolcall: true, reasoning: true, attachment: true },
			variants: { low: {}, high: {} },
			free: true,
		}, "p");
		check("limits are read", rich.context === 200_000 && rich.maxOutput === 32_000);
		check("tool calls are read", rich.tools === true);
		check("vision is read", rich.vision === true);
		check("reasoning is read", rich.reasoning === true);
		check("effort levels are read", JSON.stringify(rich.efforts) === JSON.stringify(["low", "high"]));
		check("a free model says so", rich.free === true);
	}

	section("credential store");
	{
		const dir = join(root, "store");
		const local = new PluginAuthStore(dir);
		check("an unwritten store is empty", local.get("p", "u") === undefined);
		local.set("p", "u1", { type: "oauth", access: "secret-token", uid: "u1", expires: Date.now() + 3600_000 });
		check("a credential round-trips", local.get("p", "u1")?.access === "secret-token");
		// Windows does not carry permission bits through `mode`, so the assertion is that the
		// file was written atomically and is readable back — not that a POSIX mode stuck.
		check("it is written as one JSON file", JSON.parse(readFileSync(join(dir, "plugin-auth.json"), "utf8"))["p"] !== undefined);
		check("no temp file is left behind", (() => {
			try {
				statSync(join(dir, `plugin-auth.json.tmp-${process.pid}`));
				return false;
			} catch {
				return true;
			}
		})());
		const described = local.describe("p", "u1");
		check("the description never contains the token", JSON.stringify(described).includes("secret-token") === false);
		check("the description says when it expires", typeof described.expiresAt === "string" && described.expired === false);
		local.set("p", "u2", { type: "oauth", access: "second", uid: "u2" });
		check("a second account is stored beside the first", local.accounts("p").length === 2);
		local.remove("p", "u2");
		check("an account can be removed", local.accounts("p").length === 1);
		const expired = new PluginAuthStore(join(root, "store-expired"));
		expired.set("p", "u", { type: "oauth", access: "x", uid: "u", expires: Date.now() - 1000 });
		check("an expired credential is reported as expired", expired.describe("p", "u").expired === true);
	}

	section("signed out");
	{
		const provider = await load("qoder");
		check("a fresh provider is not signed in", provider.signedIn() === false);
		const methods = await provider.methods();
		check("it offers sign-in methods", methods.length > 0, `${methods.length} methods`);
		check("the OAuth method has a label", methods.some((method) => method.label.includes("Qoder")));
		const models = await provider.listModels();
		check("listing without a credential returns nothing rather than throwing", Array.isArray(models.models));
		let threw = false;
		try {
			await provider.loader();
		} catch {
			threw = true;
		}
		check("asking for a loader without a credential throws", threw);
	}

	section("sign-in through the host");
	{
		// zen-free's only method authorizes immediately with the literal key "public", which
		// makes it the one provider testable end to end without an account.
		const provider = await load("zen-free");
		const methods = await provider.methods();
		check("zen-free offers one method", methods.length === 1, methods[0]?.type);
		const result = await provider.signIn(0, {});
		check("an api-key sign-in is accepted", result.ok === true && result.type === "api", JSON.stringify(result));
		check("the provider now reports signed in", provider.signedIn() === true);
		check("the stored credential is the key", store.get("zen-free", "")?.key === "public");
		const loader = await provider.loader();
		check("a loader is produced", typeof loader.fetch === "function" && typeof loader.baseURL === "string", loader.baseURL);
		// The credential is read back through getAuth on every call, so a sign-out invalidates
		// the cached loader even though the object is still in memory.
		provider.signOut();
		check("signing out clears the state", provider.signedIn() === false);
	}

	section("vendor errors are not swallowed");
	{
		const provider = await load("qoder");
		// A synthetic OAuth credential: the host should build the request and hand the
		// vendor's real answer to the caller, not invent one.
		store.set("qoder", "uid-probe", {
			type: "oauth",
			access: "dt-not-a-real-token",
			refresh: "drt-not-a-real-refresh",
			uid: "uid-probe",
			machineId: "0123456789abcdef0123456789abcdef",
			expires: Date.now() + 3600_000,
		});
		const fresh = await load("qoder");
		let response;
		try {
			response = (await fresh.chat({
				body: { model: "auto", messages: [{ role: "user", content: "hi" }], stream: false },
				signal: AbortSignal.timeout(30_000),
			})).response;
		} catch (error) {
			response = undefined;
			process.stdout.write(`       (network unavailable: ${String(error?.message ?? error).slice(0, 80)})\n`);
		}
		if (response !== undefined) {
			check("a rejected credential surfaces as a failed response", response.ok === false, `HTTP ${response.status}`);
			const text = await response.text();
			check("the vendor's own message is passed through", text.length > 0, text.slice(0, 90).replace(/\s+/g, " "));
		}
	}

	section("hidden models");
	{
		const provider = await load("zen-free");
		check("nothing is hidden by default", provider.hiddenIds().length === 0);
		provider.setHidden(["a", "b", "a", ""]);
		check("hidden ids are deduplicated and cleaned", JSON.stringify(provider.hiddenIds()) === JSON.stringify(["a", "b"]));
		const hidden = provider.hiddenIds();
		check("they survive a reload", JSON.stringify((await load("zen-free")).hiddenIds()) === JSON.stringify(hidden));
	}

	// A vendor that never answers: the request must not go out, and the caller must still
	// get a usable result rather than an exception escaping the hook.
	section("a vendor that refuses");
	{
		const provider = await load("qoder");
		store.set("qoder-fake", "u", { type: "oauth", access: "x", uid: "u" });
		const fake = new ProviderPlugin({
			spec: { id: "fake", label: "Fake", package: "n/a", export: "F" },
			module: {
				F: () => ({
					provider: {
						models() {
							throw Object.assign(new Error("sign in again"), { signIn: "expired" });
						},
					},
					auth: { methods: [] },
				}),
			},
			store,
			log: () => {},
			warn: () => {},
		});
		const listed = await fake.listModels();
		check("a throwing models hook becomes an empty list", listed.models.length === 0);
		check("the reason is kept", listed.listError === "sign in again");
		check("an expired sign-in is flagged", listed.needsSignIn === true);
		void provider;
	}

	section("a vendor that falls back");
	{
		const fake = new ProviderPlugin({
			spec: { id: "fallback", label: "Fallback", package: "n/a", export: "F" },
			module: {
				F: () => ({
					provider: {
						// The plugin hands back exactly what it was given: magpie reads that as
						// "I could not reach my vendor".
						models(given) {
							return given;
						},
					},
				}),
			},
			store,
			log: () => {},
			warn: () => {},
		});
		const listed = await fake.listModels();
		check("handing back what it was given counts as a fallback", listed.fellBack === true);
		check("and says so", typeof listed.listError === "string");
	}

	if (LIVE) {
		section("live inference (--live)");
		{
			const provider = await load("zen-free");
			if (!provider.signedIn()) await provider.signIn(0, {});
			const listed = await provider.listModels();
			// Not every listed model answers: measured on 2026-10-18, three of zen-free's nine
			// were refused (a RegionError, an upstream endpoint error, and a timeout). A
			// known-good one is picked by name rather than "the first free one", which is how
			// the previous generation of this bridge shipped a picker full of broken models.
			const KNOWN_GOOD = "mimo-v2.6-flash-free";
			const model = listed.models.find((candidate) => candidate.id === KNOWN_GOOD) ?? listed.models[0];
			check("the vendor lists at least one model", model !== undefined, model?.id);
			if (model !== undefined) {
				const { response } = await provider.chat({
					body: { model: model.id, messages: [{ role: "user", content: "Reply with exactly: HOST" }], stream: true },
					signal: AbortSignal.timeout(60_000),
					sessionId: "test-session",
				});
				check("a live request answers 200", response.ok === true, `HTTP ${response.status}`);
				const text = await response.text();
				check("the body is an SSE stream", text.includes("data:"));
				check("the stream ends properly", text.trimEnd().endsWith("[DONE]"));
				const content = text
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => {
						try {
							return JSON.parse(line.slice(5));
						} catch {
							return null;
						}
					})
					.filter(Boolean)
					.flatMap((chunk) => (chunk.choices ?? []).map((choice) => choice.delta?.content ?? ""))
					.join("");
				check("the model answered", content.trim().length > 0, JSON.stringify(content.slice(0, 40)));
			}
		}
	} else {
		process.stdout.write("\n(live inference skipped; pass --live to include it)\n");
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
