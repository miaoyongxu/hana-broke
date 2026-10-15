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
 * HanaAgent's normalizer reads `context`/`contextWindow`, `maxOutput`, `image`,
 * `efforts` and `defaultEffort`; unknown spellings in `efforts` are dropped
 * rather than rejected, and an empty list simply means "no declared levels".
 *
 * `suffixOf` supplies the billing/promo suffix (`x0.06 · 夜间免费`) appended to
 * the display name. HanaAgent has no price or badge slot of its own, so the
 * name is the only place a suffix can live — the same conclusion DSH's plugin
 * reached for its picker. This is display-only: model selection is stored as
 * `{id, provider}` in `config.yaml` and nothing resolves a model by name.
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
	if (typeof info.supportsImages === "boolean") model.image = info.supportsImages;
	if (Array.isArray(info.supportedEfforts)) {
		const efforts = info.supportedEfforts.filter((effort) => typeof effort === "string" && KNOWN_EFFORTS.has(effort));
		if (efforts.length > 0) model.efforts = [...new Set(efforts)];
	}
	if (typeof info.defaultEffort === "string" && KNOWN_EFFORTS.has(info.defaultEffort)) {
		model.defaultEffort = info.defaultEffort;
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
 * @param {object} options
 * @param {string} options.id provider id, e.g. `workbuddy-ai`
 * @param {string} options.displayName human-readable provider name
 * @param {string} options.baseUrl OpenAI-compatible base URL, ending in `/v1`
 * @param {object[]} options.models catalog entries from the plugin
 * @param {string} [options.description]
 * @param {string} [options.hanaHome]
 * @returns {{ dir: string, changed: boolean, modelCount: number }}
 */
export function writeProviderPlugin(options) {
	const { id, displayName, baseUrl, models } = options;
	if (!isValidProviderId(id)) throw new Error(`invalid provider id: ${String(id)}`);
	const declarations = toModelDeclarations(models, { suffixOf: options.suffixOf });
	if (declarations.length === 0) throw new Error(`provider ${id} would be registered with no models`);
	const home = options.hanaHome ?? resolveHanaHome();
	const dir = join(home, PROVIDER_PLUGIN_DIR, id);
	const manifest = {
		id,
		type: "provider-plugin",
		schemaVersion: 1,
		provider: id,
	};
	const provider = {
		id,
		displayName,
		authType: "none",
		defaultBaseUrl: baseUrl,
		defaultApi: "openai-completions",
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
