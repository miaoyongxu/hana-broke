/**
 * Locate and load the installed `dsh-workbuddy-connect` bundle.
 *
 * `dsh-workbuddy-connect` (MIT, by corrinehu — https://github.com/corrinehu/dsh-workbuddy-connect)
 * owns the hard parts: the desktop apps' at-rest credential decryption, the
 * WorkBuddy wire protocol, and the model catalog. This bridge is an adapter
 * layer for HanaAgent and reuses that implementation rather than copying it,
 * so authorship and the upstream licence stay with the upstream package.
 *
 * The bridge reuses the plugin's own credential store and upstream client so
 * that WorkBuddy's private wire format (forced streaming, string `tool_choice`,
 * CLI-shaped headers, at-rest credential envelopes) is implemented in exactly
 * one place. Nothing about the plugin's DSH-specific half — cordis, pi-ai,
 * settings, loopback shim — is touched.
 *
 * The plugin ships a hashed chunk (`host-heartbeat-<hash>.js`) whose name
 * changes on every release, so it is discovered by pattern rather than by
 * literal name.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Package name of the plugin whose internals this bridge drives. */
export const PLUGIN_PACKAGE = "dsh-workbuddy-connect";

const require = createRequire(import.meta.url);

/**
 * The copy npm installed for *this* package, if there is one.
 *
 * Resolved through Node's own algorithm rather than by guessing a path: npm
 * hoists dependencies to the top-level `node_modules`, so
 * `<our package>/node_modules/dsh-workbuddy-connect` only exists for a nested
 * install. `createRequire(...).resolve()` walks the real tree, which also
 * covers pnpm layouts, global installs and symlinks — and, crucially, makes
 * `npm install hana-broke` sufficient on a machine that has no
 * DeepSeek Harness at all.
 */
function dependencyRoot() {
	try {
		return dirname(require.resolve(`${PLUGIN_PACKAGE}/package.json`));
	} catch {
		return undefined;
	}
}

/** Automatic candidate install roots, most specific first (the env override is handled separately). */
function candidateRoots() {
	const roots = [];
	// Declared dependency of this package (`npm install`), wherever npm put it.
	const dependency = dependencyRoot();
	if (dependency !== undefined) roots.push(dependency);
	// Fallback: reuse an existing DeepSeek Harness installation.
	const profilesDir = join(homedir(), ".dsh", "profiles");
	let profiles = [];
	try {
		profiles = readdirSync(profilesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		profiles = [];
	}
	for (const profile of profiles) roots.push(join(profilesDir, profile, "node_modules", PLUGIN_PACKAGE));
	return roots;
}

/** Find `host-heartbeat-*.js` inside a plugin `lib` directory. */
function heartbeatChunkIn(libDir) {
	let names = [];
	try {
		names = readdirSync(libDir).filter((name) => /^host-heartbeat-.*\.js$/.test(name));
	} catch {
		return;
	}
	let best;
	for (const name of names) {
		const path = join(libDir, name);
		const mtime = statSync(path).mtimeMs;
		if (best === undefined || mtime > best.mtime) best = { path, mtime };
	}
	return best?.path;
}

/** Inspect one candidate root; `undefined` when it holds no usable plugin. */
function inspectRoot(root) {
	const libDir = existsSync(join(root, "lib")) ? join(root, "lib") : root;
	const chunkPath = heartbeatChunkIn(libDir);
	if (chunkPath === undefined) return undefined;
	if (!existsSync(join(libDir, "index.js"))) return undefined;
	return { packageRoot: root, libDir, chunkPath };
}

/**
 * Resolve the plugin's `lib` directory and its credential/upstream chunk.
 *
 * An explicit `WORKBUDDY_PLUGIN_DIR` is authoritative: if the user names a
 * directory, silently using a *different* copy found elsewhere would hide the
 * mistake, so an unusable override is an error rather than a fallback. The
 * automatic candidates, by contrast, are a search and fall through in order.
 *
 * @returns {{ packageRoot: string, libDir: string, chunkPath: string }}
 * @throws when no usable install exists
 */
export function resolvePlugin() {
	const override = process.env["WORKBUDDY_PLUGIN_DIR"]?.trim();
	if (override) {
		const inspected = inspectRoot(override);
		if (inspected === undefined) {
			throw new Error(
				`WORKBUDDY_PLUGIN_DIR is set to "${override}", but that directory does not hold a usable ${PLUGIN_PACKAGE} ` +
					`(expected <dir>/lib/index.js and <dir>/lib/host-heartbeat-*.js). ` +
					"Fix or unset WORKBUDDY_PLUGIN_DIR and let the bridge find its own copy.",
			);
		}
		return inspected;
	}

	const tried = [];
	for (const root of candidateRoots()) {
		tried.push(root);
		const inspected = inspectRoot(root);
		if (inspected !== undefined) return inspected;
	}
	throw new Error(
		`${PLUGIN_PACKAGE} was not found; looked in:\n  ${tried.join("\n  ")}\n` +
			`Run \`npm install\` in this directory (it is a declared dependency), or install it into a DSH profile ` +
			"(`dsh plugin --profile <name> add dsh-workbuddy-connect`).",
	);
}

/**
 * Semantic names the bridge needs, and the exports that may carry them.
 *
 * The chunk is a bundler artifact whose *exported* names are short minified
 * identifiers (`m`, `O`, `S`, …) whose letters change between releases. The
 * stable structure is `index.js`'s import statement, which aliases each short
 * name to the semantic one (`m as WorkBuddyCredentialStore`). The mapping is
 * therefore read out of `index.js` instead of hardcoding letters.
 */
const REQUIRED_EXPORTS = [
	"WorkBuddyCredentialStore",
	"WorkBuddyUpstreamClient",
	"CN_VARIANT",
	"AI_VARIANT",
	"prepareChatBody",
	"atRestKeyProviderFor",
	// Billing display: the picker suffix (`· x0.06 · 夜间免费`) is built from
	// the same two helpers DSH uses, so the two surfaces cannot drift.
	"normalizeCredits",
	"modelWithCurrentPromotion",
	// Settings surface: account profiles copy the desktop app's auth file, so
	// the platform candidate list is needed to find the live one; the effort
	// probe reuses the upstream client's own measured request shape.
	"defaultDesktopAuthCandidates",
	"probeModel",
	"PROBE_EFFORT_CANDIDATES",
	"FALLBACK_WORKBUDDY_MODELS",
	"FALLBACK_WORKBUDDY_AI_MODELS",
];

/**
 * Read the `{ shortName as SemanticName }` map that `index.js` uses to import
 * from the hashed chunk.
 *
 * @param {string} libDir plugin `lib` directory
 * @param {string} chunkPath absolute path to the hashed chunk
 * @returns {Map<string, string>} semantic name → exported name
 */
function semanticExportMap(libDir, chunkPath) {
	const indexPath = join(libDir, "index.js");
	const chunkName = basename(chunkPath);
	const source = readFileSync(indexPath, "utf8");
	const mapping = new Map();
	const pattern = new RegExp(`import\\s*\\{([\\s\\S]*?)\\}\\s*from\\s*"\\./${chunkName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g");
	for (const match of source.matchAll(pattern)) {
		for (const entry of match[1].split(",")) {
			const [local, imported] = entry.split(/\s+as\s+/).map((part) => part.trim());
			if (local === undefined || local === "") continue;
			mapping.set(imported === undefined || imported === "" ? local : imported, local);
		}
	}
	return mapping;
}

/**
 * Import the plugin chunk and expose its internals under semantic names.
 *
 * Must be called after the atomic-write shim loader is registered, because the
 * chunk imports a package that only exists inside the DeepSeek Harness runtime.
 *
 * @param {{ libDir: string, chunkPath: string }} plugin resolved plugin paths
 * @returns {Promise<Record<string, unknown> & { __module: Record<string, unknown>, __mapping: Map<string, string> }>}
 */
export async function loadPluginChunk(plugin) {
	const module = await import(pathToFileURL(plugin.chunkPath).href);
	const mapping = semanticExportMap(plugin.libDir, plugin.chunkPath);
	const resolved = {};
	const missing = [];
	for (const name of REQUIRED_EXPORTS) {
		if (module[name] !== undefined) {
			resolved[name] = module[name];
			continue;
		}
		const short = mapping.get(name);
		if (short !== undefined && module[short] !== undefined) {
			resolved[name] = module[short];
			continue;
		}
		missing.push(name);
	}
	if (missing.length > 0) {
		throw new Error(
			`${PLUGIN_PACKAGE} chunk is missing expected exports: ${missing.join(", ")}. ` +
				"The plugin's internal layout changed; the bridge needs updating.",
		);
	}
	resolved.__module = module;
	resolved.__mapping = mapping;
	return resolved;
}
