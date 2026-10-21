/**
 * Register the bridge as a HanaAgent "local provider plugin".
 *
 * HanaAgent reads `<hanakoHome>/provider-plugins/<storageId>/manifest.json`
 * plus `providers/<storageId>.json` for drop-in providers, and lists the models
 * declared there. A loopback base URL is a supported shape for exactly this
 * case (the catalog core classifies loopback providers as needing no API key),
 * so the bridge needs no HanaAgent patch and no restart of the app to be
 * addressable once the files are in place.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** HanaAgent's local provider-plugin directory. */
export const PROVIDER_PLUGIN_DIR = "provider-plugins";

/** Effort spellings HanaAgent accepts in a model declaration. */
const KNOWN_EFFORTS = new Set(["off", "low", "medium", "high", "xhigh", "max"]);

/** Whether `id` is a legal local provider-plugin id. */
function isValidProviderId(id) {
	return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

/** HanaAgent home, honouring the same override the app itself uses. */
export function resolveHanaHome() {
	const override = process.env["HANA_HOME"]?.trim();
	return override && override !== "" ? override : join(homedir(), ".hanako");
}

/** Separator between a model's own name and its billing/promo suffix. */
export const RATE_SEPARATOR = " · ";

/**
 * Convert one bridge catalog entry into HanaAgent's model declaration shape.
 *
 * The field names are HanaAgent's own, read off a provider declaration the app itself
 * wrote (`provider-plugins/claude/providers/claude.json` on this machine):
 * `id` / `name` / `context` / `maxOutput` / `image` / `reasoning` / `customThinkingLevels`.
 *
 * Two of those are easy to get wrong and fail silently:
 *
 * - **The reasoning flag is `reasoning`, not a list of levels.** HanaAgent decides whether
 *   to show the thinking control from a boolean; a declaration that only carries an
 *   effort array shows no control at all, and nothing reports why.
 * - **The levels are `customThinkingLevels`.** An unknown key is dropped by the
 *   normalizer rather than rejected, so `supportedEfforts` (a name from a different
 *   tool's schema) is written and then ignored — the model appears, but its levels do not.
 *
 * Both are written whenever the caller knows anything about reasoning, and `image` is
 * always written: HanaAgent merges a declaration over an older one, so a field left out
 * keeps its previous value, which is how a model ends up advertising vision it never had.
 *
 * `suffixOf` supplies the billing/promo suffix (`x0.06 · 夜间免费`) appended to the
 * display name. HanaAgent has no price or badge slot of its own, so the name is the only
 * place a suffix can live — the same conclusion DSH's plugin reached for its picker. This
 * is display-only: model selection is stored as `{id, provider}` in `config.yaml` and
 * nothing resolves a model by name.
 */
function toModelDeclaration(info, suffixOf) {
	const id = String(info.id);
	const base = typeof info.name === "string" && info.name.trim() !== "" ? info.name.trim() : id;
	const suffix = typeof suffixOf === "function" ? suffixOf(info) : undefined;
	const model = { id, name: typeof suffix === "string" && suffix !== "" ? `${base}${RATE_SEPARATOR}${suffix}` : base };
	const context = typeof info.contextWindow === "number" ? info.contextWindow : undefined;
	if (context !== undefined && context > 0) model.context = context;
	const maxOutput = typeof info.maxTokens === "number" ? info.maxTokens : undefined;
	if (maxOutput !== undefined && maxOutput > 0) model.maxOutput = maxOutput;
	// Always stated, both ways: a missing field inherits the previous declaration's value.
	model.image = info.supportsImages === true;
	const levels = Array.isArray(info.supportedEfforts)
		? [...new Set(info.supportedEfforts.filter((effort) => typeof effort === "string" && KNOWN_EFFORTS.has(effort)))]
		: [];
	const thinking = info.reasoning === true || levels.length > 0;
	model.reasoning = thinking;
	if (levels.length > 0) model.customThinkingLevels = levels;
	if (typeof info.defaultEffort === "string" && KNOWN_EFFORTS.has(info.defaultEffort)) {
		model.defaultThinkingLevel = info.defaultEffort;
	}
	return model;
}

/** Normalize a catalog list, dropping duplicates and unusable rows. */
export function toModelDeclarations(models, options = {}) {
	const seen = new Set();
	const declarations = [];
	for (const info of models) {
		if (info === null || typeof info !== "object") continue;
		const id = typeof info.id === "string" ? info.id.trim() : "";
		if (id === "" || seen.has(id)) continue;
		seen.add(id);
		declarations.push(toModelDeclaration({ ...info, id }, options.suffixOf));
	}
	return declarations;
}

/** Serialize deterministically so an unchanged sync does not rewrite files. */
function serialize(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

/** Write only when the content changed, renaming into place. */
function writeIfChanged(path, content) {
	if (existsSync(path)) {
		try {
			if (readFileSync(path, "utf8") === content) return false;
			renameSync(path, `${path}.bak`);
		} catch {
			// fall through: an unreadable file is simply replaced
		}
	}
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}`;
	writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
	renameSync(temp, path);
	return true;
}

/**
 * Write (or refresh) one local provider plugin.
 *
 * `authType` and `apiKey` are what make HanaAgent authenticate to this bridge
 * instead of trusting it because the URL is loopback. HanaAgent skips the key
 * for a loopback `base_url` when `authType` is `none` (its own
 * `allowsMissingApiKey` short-circuits on loopback), so declaring
 * `authType: "api-key"` plus the shared bearer is what actually makes the
 * per-request check enforceable on the model endpoints too. With
 * `openai-completions` that lands as `Authorization: Bearer <token>`, which is
 * exactly what `bridge-auth.mjs` verified.
 *
 * @param {object} options
 * @param {string} options.id provider id, e.g. `workbuddy-ai`
 * @param {string} options.displayName human-readable provider name
 * @param {string} options.baseUrl OpenAI-compatible base URL, ending in `/v1`
 * @param {object[]} options.models catalog entries from the plugin
 * @param {string} options.apiKey the bridge bearer HanaAgent must present
 * @param {string} [options.description]
 * @param {string} [options.hanaHome]
 * @returns {{ dir: string, changed: boolean, modelCount: number }}
 */
export function writeProviderPlugin(options) {
	const { id, displayName, baseUrl, models, apiKey } = options;
	if (!isValidProviderId(id)) throw new Error(`invalid provider id: ${String(id)}`);
	if (typeof apiKey !== "string" || apiKey === "") {
		throw new Error(`provider ${id} needs the bridge bearer: an empty key disables the request check`);
	}
	const declarations = toModelDeclarations(models, { suffixOf: options.suffixOf });
	if (declarations.length === 0) throw new Error(`provider ${id} would be registered with no models`);
	const home = options.hanaHome ?? resolveHanaHome();
	const dir = join(home, PROVIDER_PLUGIN_DIR, id);
	// A tombstoned provider is checked here rather than at each caller: every path that
	// declares a provider goes through this function, so the guard cannot be forgotten by
	// one of them. Writing the files anyway would look like a successful sync in the log
	// while HanaAgent keeps the provider deleted and never shows it.
	if (providerTombstoned(id, home) === true) {
		return { dir, changed: false, modelCount: 0, models: [], tombstoned: true };
	}
	const manifest = {
		id,
		type: "provider-plugin",
		schemaVersion: 1,
		provider: id,
	};
	const provider = {
		id,
		displayName,
		// Not "none": see the doc comment. HanaAgent reads this spelling, and
		// `api-key` is what makes it keep the key for a loopback base URL.
		authType: "api-key",
		defaultBaseUrl: baseUrl,
		defaultApi: "openai-completions",
		apiKey,
		models: declarations,
		...(options.description === undefined ? {} : { description: options.description }),
	};
	const a = writeIfChanged(join(dir, "manifest.json"), serialize(manifest));
	const b = writeIfChanged(join(dir, "providers", `${id}.json`), serialize(provider));
	return { dir, changed: a || b, modelCount: declarations.length, models: declarations };
}

/** Marker written into every bridge-created provider so it can be recognised later. */
export const BRIDGE_MARKER = "via the local WorkBuddy bridge";

/** Whether a provider declaration on disk was written by this bridge. */
export function isBridgeOwnedProvider(id, hanaHome) {
	try {
		const path = join(hanaHome ?? resolveHanaHome(), PROVIDER_PLUGIN_DIR, id, "providers", `${id}.json`);
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed?.description === "string" && parsed.description.includes(BRIDGE_MARKER);
	} catch {
		return false;
	}
}

/**
 * Whether a local provider plugin directory already exists.
 *
 * Used to keep a provider that is temporarily unreachable (an expired desktop
 * sign-in, an offline upstream) from silently disappearing out of HanaAgent's
 * model list.
 */
export function providerPluginExists(id, hanaHome) {
	return existsSync(join(hanaHome ?? resolveHanaHome(), PROVIDER_PLUGIN_DIR, id));
}

/**
 * Whether HanaAgent has recorded this provider as deleted by the user.
 *
 * A tombstone, not a declaration: when the user removes a provider in Settings → Models,
 * HanaAgent appends its id to `meta.deletedProviders` in `provider-catalog.json` so the
 * entry is not resurrected from `models.json` on the next start. Writing the
 * `provider-plugins/` files again does **not** clear it — the id stays deleted, the
 * provider never appears in the picker, and the bridge's own "did it register?" probe
 * cannot tell that apart from a provider that is simply absent.
 *
 * That makes it a state the bridge has to read rather than guess at: re-declaring a
 * tombstoned provider is invisible work, and the honest thing is to say so — clearing
 * the tombstone is the user's decision, made in HanaAgent, not something a bridge should
 * do behind their back.
 *
 * The catalog is plain JSON in the layouts shipped so far, but HanaAgent can seal it
 * (`HANA-SECRET-1.AES-256-GCM.…`) with a key from the OS keychain. A sealed or unreadable
 * catalog answers `undefined` — "unknown" — rather than `false`, so the caller does not
 * report a tombstone it never saw.
 *
 * @param {string} id provider id
 * @param {string} [hanaHome]
 * @returns {boolean|undefined} true = tombstoned, false = not listed, undefined = unreadable
 */
export function providerTombstoned(id, hanaHome) {
	try {
		const raw = readFileSync(join(hanaHome ?? resolveHanaHome(), "provider-catalog.json"), "utf8");
		if (raw.trimStart().startsWith("HANA-SECRET")) return undefined;
		const catalog = JSON.parse(raw);
		const deleted = catalog?.meta?.deletedProviders;
		if (!Array.isArray(deleted)) return false;
		return deleted.includes(id);
	} catch {
		return undefined;
	}
}
