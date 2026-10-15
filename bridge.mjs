#!/usr/bin/env node
/**
 * WorkBuddy → HanaAgent bridge.
 *
 * HanaAgent can only reach a provider that speaks the OpenAI chat-completions
 * shape, while the WorkBuddy desktop apps talk a private variant of it
 * (forced streaming, string `tool_choice`, `X-IDE-*` identity headers, rotated
 * OAuth tokens). This process sits between them:
 *
 *   HanaAgent ──▶ http://127.0.0.1:<port>/<variant>/v1/chat/completions
 *                        │
 *                        ├── credential: dsh-workbuddy-connect's store
 *                        │   (reads the desktop app's at-rest auth file)
 *                        └── upstream: copilot.tencent.com / *.workbuddy.ai
 *
 * The translation layer is not reimplemented here: it is the installed
 * `dsh-workbuddy-connect` bundle, loaded directly. See `plugin.mjs`.
 *
 * @module hanako-workbuddy-bridge
 */

import { register } from "node:module";
import { createServer } from "node:http";
import { createWriteStream, createReadStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { describeFailure, failureMessage, trimRaw } from "./failure-report.mjs";
import { activeProfile, captureProfile, deleteProfile, describeProfile, listProfiles, liveDesktopAuthPath, profileStoreOptions, setActiveProfile } from "./account-profiles.mjs";
import { accountKeyOf, hiddenModels, setHiddenModels } from "./model-visibility.mjs";
import { createAdminApi } from "./admin-api.mjs";
import { OpenCodeUpstream, OPENCODE_PROVIDER_ID } from "./opencode-upstream.mjs";

register("./dsh-shim-loader.mjs", import.meta.url);

const { resolvePlugin, loadPluginChunk, PLUGIN_PACKAGE } = await import("./plugin.mjs");
const { writeProviderPlugin, isBridgeOwnedProvider, BRIDGE_MARKER, resolveHanaHome } = await import("./hana-providers.mjs");
const { applyProvider, providerRegistered } = await import("./hana-apply.mjs");

/** Variant routes exposed to HanaAgent. */
const ROUTE_VARIANTS = [
	{ route: "workbuddy", providerId: "workbuddy", displayName: "WorkBuddy", variantKey: "CN_VARIANT" },
	{ route: "workbuddy-ai", providerId: "workbuddy-ai", displayName: "WorkBuddy AI", variantKey: "AI_VARIANT" },
];

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024;
const JSON_TIMEOUT_MS = 20_000;
const CATALOG_TTL_MS = 10 * 60_000;

/** HTTP status for each upstream failure class, mirroring the plugin's shim. */
const KIND_STATUS = {
	hard_credit: 402,
	soft_rate: 429,
	session_dead: 401,
	not_found: 502,
	server: 502,
	client: 400,
};

//#region arguments

function parseArgs(argv) {
	const options = {
		port: Number(process.env["WORKBUDDY_BRIDGE_PORT"] ?? 8788),
		host: process.env["WORKBUDDY_BRIDGE_HOST"] ?? "127.0.0.1",
		token: process.env["WORKBUDDY_BRIDGE_TOKEN"] ?? "",
		hanaHome: resolveHanaHome(),
		dataDir: process.env["WORKBUDDY_BRIDGE_DATA_DIR"] ?? "",
		logFile: process.env["WORKBUDDY_BRIDGE_LOG"] ?? "",
		plainNames: process.env["WORKBUDDY_BRIDGE_PLAIN_NAMES"] === "1",
		resyncMinutes: Number(process.env["WORKBUDDY_BRIDGE_RESYNC_MINUTES"] ?? 15),
		sync: true,
		apply: true,
		syncOnly: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--port") options.port = Number(argv[++index]);
		else if (arg === "--host") options.host = argv[++index];
		else if (arg === "--token") options.token = argv[++index] ?? "";
		else if (arg === "--hana-home") options.hanaHome = argv[++index];
		else if (arg === "--data-dir") options.dataDir = argv[++index] ?? "";
		else if (arg === "--log-file") options.logFile = argv[++index] ?? "";
		else if (arg === "--plain-names") options.plainNames = true;
		else if (arg === "--resync-minutes") options.resyncMinutes = Number(argv[++index]);
		else if (arg === "--no-sync") options.sync = false;
		else if (arg === "--no-apply") options.apply = false;
		else if (arg === "--sync-only") options.syncOnly = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else throw new Error(`unknown argument: ${arg}`);
	}
	if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
		throw new Error(`invalid port: ${String(options.port)}`);
	}
	if (options.dataDir === "") options.dataDir = join(options.hanaHome, "plugin-data", "workbuddy-bridge");
	return options;
}

const HELP = `WorkBuddy → HanaAgent bridge

  node bridge.mjs [options]

Options:
  --port <n>       listen port (default 8788, env WORKBUDDY_BRIDGE_PORT)
  --host <addr>    listen address (default 127.0.0.1)
  --token <value>  require this bearer on every request (default: any bearer)
  --hana-home <dir> HanaAgent data directory (default ~/.hanako)
  --data-dir <dir>  bridge state: account profiles, model visibility, endpoint info
                    (default <hana-home>/plugin-data/workbuddy-bridge)
  --log-file <path> also append logs to this UTF-8 file
  --plain-names    show bare model names, without the "· x0.06 · 夜间免费" suffix
  --resync-minutes <n> re-check the catalog every n minutes (default 15, 0 = never)
  --no-sync        do not (re)write the HanaAgent provider plugins
  --no-apply       only write the files, do not hot-register a running HanaAgent
  --sync-only      refresh the provider plugins and exit
  -h, --help       this text
`;

//#endregion

//#region logging

/**
 * Optional mirror of stdout/stderr into a UTF-8 file.
 *
 * Redirecting the child's streams from a PowerShell 5.1 host re-encodes them
 * through the console code page, which mangles non-ASCII log lines. Writing the
 * file from Node keeps the log readable, so `--log-file` is the supported way
 * to capture output.
 */
let logStream;

/**
 * Keep a broken console stream from killing the daemon.
 *
 * `EPIPE`/`ERR_STREAM_DESTROYED` on process.stdout/stderr surface as an
 * unhandled `error` event, which terminates Node by default. This process runs
 * detached, so its inherited stdout/stderr can point at a pipe whose reader has
 * already exited — that used to take the bridge down without leaving a single
 * log line.
 */
function ignoreConsoleErrors(stream) {
	stream.on("error", () => {
		/* the console is gone; the log file is the remaining record */
	});
}

function initLog(path) {
	ignoreConsoleErrors(process.stdout);
	ignoreConsoleErrors(process.stderr);
	try {
		mkdirSync(dirname(path), { recursive: true });
		try {
			if (statSync(path).size > 8 * 1024 * 1024) createWriteStream(path, { flags: "w" }).end();
		} catch {
			// no existing file
		}
		logStream = createWriteStream(path, { flags: "a" });
		logStream.on("error", () => {
			logStream = undefined;
		});
	} catch (error) {
		process.stderr.write(`could not open log file ${path}: ${String(error)}\n`);
	}
}

function timestamp() {
	return new Date().toISOString().slice(11, 19);
}

/** Write the log file first, then the console; a dead console is not fatal. */
function emit(stream, line) {
	logStream?.write(line);
	try {
		stream.write(line);
	} catch {
		// the console went away mid-write; the log file already has the line
	}
}

function log(message) {
	emit(process.stdout, `${timestamp()} ${message}\n`);
}

function warn(message) {
	emit(process.stderr, `${timestamp()} ! ${message}\n`);
}

//#endregion

//#region standalone control panel

/** Files the panel is allowed to serve, with their content types. */
const PANEL_FILES = {
	"panel.css": "text/css; charset=utf-8",
	"panel.js": "text/javascript; charset=utf-8",
};

/** Directory holding the panel's own assets (this file's sibling `panel/`). */
const PANEL_DIR = join(dirname(fileURLToPath(import.meta.url)), "panel");

/**
 * The control panel's HTML shell.
 *
 * The panel is served by the bridge itself, which is what makes it independent
 * of any host application: an ordinary browser tab, or an Edge/Chrome
 * `--app=` window that has no browser chrome and looks like a native tool.
 *
 * The bearer is injected here rather than typed by the user — the page is
 * same-origin with the API it calls, and anyone who can read this response on
 * loopback can read `endpoint.json` anyway.
 */
function panelShell(options) {
	const boot = JSON.stringify({ base: "/admin", token: options.token }).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WorkBuddy 控制台</title>
<link rel="stylesheet" href="/panel/panel.css">
</head>
<body>
<div id="root"></div>
<script>window.__WORKBUDDY__ = ${boot};</script>
<script type="module" src="/panel/panel.js"></script>
</body>
</html>`;
}

//#endregion

//#region per-variant runtime

/**
 * Build the credential store + upstream client for one variant.
 *
 * The store is not built once and kept: an account profile can be switched at
 * runtime from the settings page, and each profile reads a different captured
 * auth file. `makeStore(runtime, profileId)` supplies the right one, and
 * `runtime.store` is a getter over the profile that is active right now, so
 * every existing call site keeps working unchanged.
 *
 * @param {object} chunk loaded upstream module
 * @param {string} variantKey `CN_VARIANT` / `AI_VARIANT`
 * @param {(runtime: object, profileId: string|undefined) => object} makeStore
 */
function createVariantRuntime(chunk, variantKey, makeStore) {
	const variant = chunk[variantKey];
	if (variant === undefined) throw new Error(`plugin chunk has no ${variantKey} export`);
	const client = new chunk.WorkBuddyUpstreamClient();
	const runtime = {
		variant,
		id: variant.id,
		displayName: variant.displayName,
		client,
		catalog: { models: [], fetchedAtMs: 0, error: undefined },
		/** Most recent upstream rejection, surfaced by `/healthz`. */
		lastError: undefined,
		/** Most recent successful upstream call, surfaced by `/healthz`. */
		lastSuccessAt: undefined,
		/** Profile selected in the settings page (`undefined` = follow the desktop app). */
		activeProfileId: undefined,
		storeCache: undefined,
		storeProfileId: undefined,
	};
	/** @returns {object} the store for one profile, cached until the profile changes */
	runtime.storeForProfile = (profileId) => {
		if (runtime.storeCache === undefined || runtime.storeProfileId !== profileId) {
			runtime.storeCache = makeStore(runtime, profileId);
			runtime.storeProfileId = profileId;
		}
		return runtime.storeCache;
	};
	Object.defineProperty(runtime, "store", {
		get() {
			return runtime.storeForProfile(runtime.activeProfileId);
		},
	});
	return runtime;
}

/**
 * Return a live model catalog for a variant, refreshing at most every
 * {@link CATALOG_TTL_MS}. Falls back to the plugin's compiled-in roster.
 */
async function catalogFor(chunk, runtime, force) {
	const now = Date.now();
	if (!force && runtime.catalog.models.length > 0 && now - runtime.catalog.fetchedAtMs < CATALOG_TTL_MS) {
		return runtime.catalog;
	}
	try {
		const credential = await runtime.store.resolve();
		const models = await runtime.client.fetchModels(credential, AbortSignal.timeout(JSON_TIMEOUT_MS));
		runtime.catalog = { models, fetchedAtMs: now, error: undefined };
	} catch (error) {
		runtime.catalog.error = error instanceof Error ? error.message : String(error);
		if (runtime.catalog.models.length === 0) {
			const fallback = runtime.id === chunk.CN_VARIANT.id ? chunk.FALLBACK_WORKBUDDY_MODELS : chunk.FALLBACK_WORKBUDDY_AI_MODELS;
			runtime.catalog.models = Array.isArray(fallback) ? fallback : [];
		}
	}
	return runtime.catalog;
}

//#endregion

//#region display suffix

/**
 * The suffix HanaAgent shows after a model name, mirroring DSH's picker:
 * the billing multiplier first, then the upstream's own promo badge labels
 * (`限时免费`, `夜间免费`, `夜间折扣`, `Free now`).
 *
 * Both halves come from the plugin's catalog, and both helpers are the ones
 * DSH itself calls, so the two surfaces cannot drift apart. Time-boxed
 * promotions are re-derived here at every sync (`modelWithCurrentPromotion`),
 * which is why an expired badge disappears on its own — at the cost of up to
 * one re-sync interval of staleness, where DSH re-derives on every read.
 *
 * Display-only: model selection is stored as `{id, provider}` in
 * `agents/<agent>/config.yaml` and nothing in HanaAgent resolves a model by
 * name.
 *
 * This is a re-statement of upstream's `displaySuffix` convention (rate, then
 * badges, joined by " · ") in `dsh-workbuddy-connect`, applied to HanaAgent's
 * single display slot; the data itself is upstream's.
 */
function makeDisplaySuffix(chunk) {
	return (info) => {
		const live = chunk.modelWithCurrentPromotion(info);
		const parts = [
			chunk.normalizeCredits(live?.billing?.credits),
			...(Array.isArray(live?.billing?.badges) ? live.billing.badges : []),
		].filter((part) => typeof part === "string" && part !== "");
		return parts.length === 0 ? "" : parts.join(" · ");
	};
}

//#endregion

//#region registration

/** (Re)write the HanaAgent local provider plugins for every variant. */
/**
 * Apply the per-account hide list to a live catalog.
 *
 * HanaAgent's own hide list is per *provider*, so an account-specific choice
 * has to be applied to the declaration instead. Hiding everything is refused:
 * a zero-model declaration would unregister a working provider and leave an
 * empty group in the picker, which is never what "hide these" means.
 *
 * @returns {Promise<{models: object[], hidden: string[], refused?: string}>}
 */
async function applyVisibility(chunk, runtime, models, options) {
	let accountKey;
	try {
		accountKey = accountKeyOf(await runtime.store.resolve());
	} catch {
		return { models, hidden: [] };
	}
	if (accountKey === undefined) return { models, hidden: [] };
	const hidden = hiddenModels(options.dataDir, runtime.id, accountKey);
	if (hidden.length === 0) return { models, hidden: [] };
	const kept = models.filter((info) => !hidden.includes(info.id));
	if (kept.length === 0) {
		return { models, hidden, refused: "hide list matches every model; ignored" };
	}
	return { models: kept, hidden };
}

async function syncProviders(chunk, runtimes, baseUrlFor, options) {
	const suffixOf = options.plainNames ? undefined : makeDisplaySuffix(chunk);
	const results = [];
	for (const runtime of runtimes) {
		const catalog = await catalogFor(chunk, runtime, true);
		const baseUrl = baseUrlFor(runtime);
		if (catalog.models.length === 0) {
			results.push({ id: runtime.providerId, skipped: catalog.error ?? "no models" });
			continue;
		}
		if (catalog.error !== undefined) {
			// A variant that cannot be authenticated right now must not be
			// (re)published with a stale roster: every model would fail. A
			// declaration this bridge wrote earlier is left untouched so a
			// transient upstream failure cannot unregister a working provider.
			results.push({
				id: runtime.providerId,
				skipped: catalog.error,
				keptExisting: isBridgeOwnedProvider(runtime.providerId, runtime.hanaHome),
			});
			continue;
		}
		const visibility = await applyVisibility(chunk, runtime, catalog.models, options);
		if (visibility.refused !== undefined) warn(`provider ${runtime.providerId}: ${visibility.refused}`);
		try {
			const outcome = writeProviderPlugin({
				id: runtime.providerId,
				displayName: runtime.displayName,
				baseUrl,
				models: visibility.models,
				suffixOf,
				description: `${runtime.displayName} models ${BRIDGE_MARKER} (${PLUGIN_PACKAGE}).`,
				hanaHome: runtime.hanaHome,
			});
			results.push({
				id: runtime.providerId,
				displayName: runtime.displayName,
				dir: outcome.dir,
				changed: outcome.changed,
				models: outcome.models,
				modelCount: outcome.modelCount,
				hiddenCount: visibility.hidden.length,
				baseUrl,
				source: "live",
			});
		} catch (error) {
			results.push({ id: runtime.providerId, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return results;
}

//#endregion

//#region upstream failure reporting

// The user-facing explanation lives in `failure-report.mjs` so its attribution
// rules can be unit-tested (`failure-report.test.mjs`): telling a user "not
// your network" when their proxy is down would be worse than saying nothing.
// This region keeps only the quota bookkeeping that needs bridge state.

/**
 * Quota blocks learned from upstream, per variant+model.
 *
 * A quota rejection carries a deadline; until then every retry is guaranteed
 * to fail, and HanaAgent retries 429s automatically (`LLM_RATE_LIMITED` is
 * `retryable: true`, budget 4–6). Without this cache a failing model is
 * hammered dozens of times a minute, which is pointless load on someone
 * else's service and makes the client look abusive. Cached rejections are
 * answered from memory, so the retries cost nothing.
 *
 * The block is capped well below the announced deadline: a re-probe every
 * {@link QUOTA_REPROBE_MS} costs one request and keeps a shortened or lifted
 * limit from being cached for hours.
 */
const quotaBlocks = new Map();
const QUOTA_REPROBE_MS = 30 * 60_000;

function quotaKey(runtime, model) {
	return `${runtime.id}\u0000${model}`;
}

/** Remember a quota rejection so later retries short-circuit. */
function blockQuota(runtime, model, result, facts) {
	if (facts.reset === undefined || facts.reset.ms <= Date.now()) return;
	const untilMs = Math.min(facts.reset.ms, Date.now() + QUOTA_REPROBE_MS);
	quotaBlocks.set(quotaKey(runtime, model), {
		untilMs,
		resetLabel: facts.reset.label,
		message: failureMessage(model, result),
		kind: result.kind,
		status: KIND_STATUS[result.kind] ?? 502,
	});
}

/** The active block for this variant+model, if any. */
function activeQuotaBlock(runtime, model) {
	const key = quotaKey(runtime, model);
	const block = quotaBlocks.get(key);
	if (block === undefined) return undefined;
	if (Date.now() < block.untilMs) return block;
	quotaBlocks.delete(key);
	return undefined;
}

//#endregion

//#region HTTP

function writeJson(res, status, body, headers = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
		...headers,
	});
	res.end(payload);
}

function writeOpenAIError(res, status, kind, message, headers) {
	writeJson(res, status, { error: { message, type: kind, code: kind } }, headers);
}

/** Read a request body with a size cap. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/** Collapse an SSE completion stream into a single non-streaming response. */
function sseToCompletion(text, model) {
	let content = "";
	let reasoning = "";
	let finishReason = "stop";
	let usage;
	let role = "assistant";
	const toolCalls = new Map();
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const payload = trimmed.slice(5).trim();
		if (payload === "" || payload === "[DONE]") continue;
		let event;
		try {
			event = JSON.parse(payload);
		} catch {
			continue;
		}
		if (event?.usage !== undefined) usage = event.usage;
		for (const choice of Array.isArray(event?.choices) ? event.choices : []) {
			if (typeof choice?.finish_reason === "string" && choice.finish_reason !== "") finishReason = choice.finish_reason;
			const delta = choice?.delta;
			if (delta === undefined || delta === null) continue;
			if (typeof delta.role === "string") role = delta.role;
			if (typeof delta.content === "string") content += delta.content;
			if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
			for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
				const index = typeof call.index === "number" ? call.index : 0;
				const existing = toolCalls.get(index) ?? { id: call.id ?? "", type: "function", function: { name: "", arguments: "" } };
				if (typeof call.id === "string" && call.id !== "") existing.id = call.id;
				if (typeof call.function?.name === "string") existing.function.name += call.function.name;
				if (typeof call.function?.arguments === "string") existing.function.arguments += call.function.arguments;
				toolCalls.set(index, existing);
			}
		}
	}
	const message = { role, content };
	if (reasoning !== "") message.reasoning_content = reasoning;
	if (toolCalls.size > 0) message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
	const completion = {
		id: `chatcmpl-${Date.now().toString(36)}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, message, finish_reason: finishReason }],
	};
	if (usage !== undefined) completion.usage = usage;
	return completion;
}

/** Streaming pass-through of the upstream SSE response. */
async function streamCompletion(res, upstream) {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		"Connection": "keep-alive",
		"X-Accel-Buffering": "no",
	});
	const body = Readable.fromWeb(upstream.response.body);
	await new Promise((resolve) => {
		body.on("error", (error) => {
			warn(`upstream stream failed mid-flight: ${String(error)}`);
			if (res.writable) res.end("data: [DONE]\n\n");
			resolve();
		});
		body.on("end", resolve);
		body.pipe(res);
		res.on("close", () => {
			body.destroy();
			resolve();
		});
	});
}

//#endregion

//#region main

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(HELP);
		return;
	}
	if (options.logFile !== "") initLog(options.logFile);

	// A detached service must not die on a stream or timer error it cannot act
	// on: record it and keep serving, so the next request still works.
	process.on("uncaughtException", (error) => {
		warn(`uncaught exception (continuing): ${error?.stack ?? String(error)}`);
	});
	process.on("unhandledRejection", (reason) => {
		warn(`unhandled rejection (continuing): ${reason?.stack ?? String(reason)}`);
	});
	process.on("exit", (code) => {
		// `--sync-only` exits 0 by design; only a real termination is worth a line.
		if (code !== 0) warn(`bridge exiting with code ${String(code)}`);
	});

	const plugin = resolvePlugin();
	log(`plugin: ${plugin.libDir}`);
	const chunk = await loadPluginChunk(plugin);

	const runtimes = [];
	for (const spec of ROUTE_VARIANTS) {
		const runtime = createVariantRuntime(chunk, spec.variantKey, (target, profileId) =>
			new chunk.WorkBuddyCredentialStore({
				variant: target.variant,
				// The store's own default key provider has discovery disabled, so
				// the variant's platform discovery must be supplied explicitly —
				// without it the encrypted desktop credential is unreadable.
				keyProvider: chunk.atRestKeyProviderFor(target.variant),
				refresh: (credential) => target.client.refreshToken(credential),
				...profileStoreOptions(options.dataDir, target.variant, profileId),
			}),
		);
		runtime.route = spec.route;
		runtime.providerId = spec.providerId;
		runtime.displayName = spec.displayName || runtime.displayName;
		runtime.hanaHome = options.hanaHome;
		runtime.activeProfileId = activeProfile(options.dataDir, runtime.id);
		if (runtime.activeProfileId !== undefined) log(`provider ${runtime.providerId}: 账号档案 ${runtime.activeProfileId}`);
		runtimes.push(runtime);
	}

	/** The store for whichever profile is active right now (profile switches are picked up here). */
	const storeFor = (runtime) => {
		runtime.activeProfileId = activeProfile(options.dataDir, runtime.id);
		return runtime.store;
	};

	const baseUrlFor = (runtime) => `http://${options.host}:${options.port}/${runtime.route}/v1`;
	for (const runtime of runtimes) runtime.baseUrl = baseUrlFor(runtime);

	/**
	 * OpenCode free models, as a second upstream behind the same HTTP server.
	 *
	 * Deliberately not a `ROUTE_VARIANTS` entry: a variant runtime is built around
	 * `dsh-workbuddy-connect`'s credential store and `chatStream`, and OpenCode needs
	 * none of that — it talks to a locally spawned copy of its own CLI. Sharing the
	 * listener and the OpenAI SSE rendering is enough, so this stays a separate object
	 * with its own route.
	 *
	 * `WORKBUDDY_OPENCODE=0` disables it for anyone who only wants the WorkBuddy side.
	 */
	const opencode = process.env["WORKBUDDY_OPENCODE"] === "0"
		? null
		: new OpenCodeUpstream({ dataDir: options.dataDir, log, warn });
	const opencodeBaseUrl = `http://${options.host}:${options.port}/${OPENCODE_PROVIDER_ID}/v1`;

	/**
	 * Declaration signature last pushed to HanaAgent, per provider.
	 *
	 * `PUT /api/config` is the app's own settings write path: it saves the
	 * provider *and* rewrites agent config files (verified: byte-identical
	 * content, but the mtime moves). Re-pushing an unchanged declaration every
	 * re-sync would therefore touch a user's config file on a timer for no
	 * reason, and could interleave with the user editing settings. So a write
	 * happens only when the declaration actually changed — and once on the
	 * first sync after this process starts, which also guarantees a HanaAgent
	 * that was restarted in the meantime ends up with the provider registered.
	 */
	const appliedSignatures = new Map();

	/**
	 * Refresh each variant's declaration from the live catalog and, when a
	 * HanaAgent server is running, hot-register it. Re-run periodically so a
	 * sign-in that happens after startup starts working without a restart, and
	 * so a model roster change is picked up on its own.
	 *
	 * @returns {Promise<object[]>} one result per provider — the admin API
	 * reports them back to the settings page, so this must not be undefined.
	 */
	/**
	 * Build the OpenCode provider declaration (and write its plugin files).
	 *
	 * Only models measured as reachable are declared. The free roster is not a list of
	 * working models: on 2026-10-15 it held 11 entries of which 4 always failed — one
	 * deprecated, one region-blocked ("not available in your country"), two never
	 * answering. Declaring those would fill HanaAgent's picker with models that fail on
	 * every use, so availability is measured and cached (see `discoverModels`).
	 */
	async function declareOpenCode() {
		const discovered = await opencode.discoverModels();
		const usable = await opencode.selectableModels();
		if (usable.length === 0) {
			const hidden = opencode.hiddenIds().length;
			const note = discovered.length === 0
				? "上游没有列出任何免费模型"
				: `没有可发布的免费模型（上游列出 ${discovered.length} 个，其中 ${discovered.length - discovered.filter((model) => model.working).length} 个探测失败、${hidden} 个被你隐藏）`;
			return { id: OPENCODE_PROVIDER_ID, skipped: note, keptExisting: isBridgeOwnedProvider(OPENCODE_PROVIDER_ID, options.hanaHome) };
		}
		const outcome = writeProviderPlugin({
			id: OPENCODE_PROVIDER_ID,
			displayName: "OpenCode 免费模型",
			baseUrl: opencodeBaseUrl,
			models: usable.map((model) => ({
				id: model.id,
				name: model.name,
				contextWindow: model.context,
				maxTokens: model.maxOutput,
				supportsImages: model.supportsImages,
			})),
			hanaHome: options.hanaHome,
			description: `OpenCode free models via this bridge (${discovered.length} listed, ${usable.length} published).`,
		});
		return {
			id: OPENCODE_PROVIDER_ID,
			displayName: "OpenCode 免费模型",
			dir: outcome.dir,
			changed: outcome.changed,
			models: outcome.models,
			modelCount: outcome.modelCount,
			hiddenCount: discovered.filter((model) => model.working).length - usable.length,
			baseUrl: opencodeBaseUrl,
			source: "live",
			unreachable: discovered.length - discovered.filter((model) => model.working).length,
		};
	}

	/** Report one provider result and, when it changed, push it into HanaAgent. */
	async function publishProvider(result) {
		if (result.error !== undefined) {
			warn(`provider ${result.id}: ${result.error}`);
			return;
		}
		if (result.skipped !== undefined) {
			const note = result.keptExisting === true ? "; an earlier declaration is left in place" : "";
			warn(`provider ${result.id} not registered: ${result.skipped}${note}`);
			return;
		}
		log(`provider ${result.id}: ${result.modelCount} models (${result.source}) → ${result.dir}`);
		if (!options.apply) return;
		const signature = JSON.stringify({ baseUrl: result.baseUrl, models: result.models });
		if (appliedSignatures.get(result.id) === signature && (await providerRegistered(result.id, { hanaHome: options.hanaHome }))) {
			log(`provider ${result.id}: unchanged and still registered, nothing written to HanaAgent`);
			return;
		}
		const applied = await applyProvider(
			{
				id: result.id,
				displayName: result.displayName,
				baseUrl: result.baseUrl,
				models: result.models,
				description: `${result.displayName} models ${BRIDGE_MARKER} (${PLUGIN_PACKAGE}).`,
			},
			{ hanaHome: options.hanaHome },
		);
		if (!applied.applied) log(`provider ${result.id}: not hot-registered (${applied.reason})`);
		else {
			appliedSignatures.set(result.id, signature);
			if (applied.registered) log(`provider ${result.id}: hot-registered with HanaAgent on :${applied.port}`);
			else warn(`provider ${result.id}: pushed to HanaAgent but it is not in /api/models yet`);
		}
	}

	async function runSync() {
		const results = await syncProviders(chunk, runtimes, baseUrlFor, options);
		for (const result of results) await publishProvider(result);
		if (opencode !== null) {
			let extra;
			try {
				extra = [await declareOpenCode()];
			} catch (error) {
				extra = [{ id: OPENCODE_PROVIDER_ID, error: error instanceof Error ? error.message : String(error) }];
			}
			for (const result of extra) await publishProvider(result);
			results.push(...extra);
		}
		return results;
	}

	if (options.sync || options.syncOnly) {
		await runSync();
		log(`HanaAgent home: ${options.hanaHome}`);
	}
	if (options.syncOnly) return;
	if (options.sync && options.resyncMinutes > 0) {
		const timer = setInterval(() => {
			log("re-sync: checking catalogs");
			void runSync().catch((error) => warn(`re-sync failed: ${String(error)}`));
		}, options.resyncMinutes * 60_000);
		timer.unref?.();
		log(`re-syncing every ${options.resyncMinutes} min`);
	}

	/** Whether the presented bearer is acceptable (constant-time, optional). */
	function bearerOk(req) {
		if (options.token === "") return true;
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		return match !== null && match[1] === options.token;
	}

	const server = createServer((req, res) => {
		void handle(req, res).catch((error) => {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
			else res.end();
		});
	});

	/** Graceful stop: used by SIGINT/SIGTERM and by the settings page's stop button. */
	const shutdown = () => {
		// Stop the OpenCode child too: it is this process's own spawn, so leaving it
		// behind would keep a loopback server (and its port) alive with no owner.
		try {
			opencode?.stop();
		} catch {
			// already gone
		}
		server.close(() => process.exit(0));
		server.closeAllConnections();
	};

	/**
	 * Operator console for the HanaAgent settings page (`/admin/...`).
	 *
	 * Kept in its own module: it is a different surface from the model endpoint
	 * (account, credits, roster, visibility, probes) and shares only the bind
	 * address and the optional bearer.
	 */
	const handleAdmin = createAdminApi({
		chunk,
		runtimes,
		options,
		pluginLib: plugin.libDir,
		storeFor,
		bearerOk,
		syncNow: runSync,
		catalogFor: (runtime, force) => catalogFor(chunk, runtime, force),
		displaySuffix: makeDisplaySuffix(chunk),
		quotaBlocks: () => quotaBlocks,
		accountKeyOf,
		hiddenModelsFor: (runtime, accountKey) => hiddenModels(options.dataDir, runtime.id, accountKey),
		setHiddenModelsFor: (runtime, accountKey, ids) => setHiddenModels(options.dataDir, runtime.id, accountKey, ids),
		liveAuthPath: (runtime) => liveDesktopAuthPath(runtime.storeForProfile(undefined)),
		listProfiles: (runtime) => listProfiles(options.dataDir, runtime.id),
		describeProfile: (runtime, id) => describeProfile(chunk, runtime.variant, options.dataDir, id),
		captureProfile: (runtime, name, sourcePath) =>
			captureProfile({
				chunk,
				variant: runtime.variant,
				dataDir: options.dataDir,
				name,
				sourcePath,
				// Capture reads the *live* desktop login, never a profile copy.
				liveStore: runtime.storeForProfile(undefined),
			}),
		activateProfile: (runtime, id) => {
			const active = setActiveProfile(options.dataDir, runtime.id, id);
			runtime.activeProfileId = active;
			return active;
		},
		deleteProfile: (runtime, id) => {
			const removed = deleteProfile(options.dataDir, runtime.id, id);
			runtime.activeProfileId = activeProfile(options.dataDir, runtime.id);
			return removed;
		},
		log,
		warn,
		shutdown,
		opencode,
	});

	async function handle(req, res) {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
		const path = url.pathname.replace(/\/+$/, "") || "/";

		if (path === "/admin" || path.startsWith("/admin/")) {
			await handleAdmin(req, res, url);
			return;
		}

		// The control panel: `/` and `/panel` serve the shell, `/panel/<file>`
		// the two assets. Only names on the allow-list are readable, so a path
		// like `/panel/../../secret` cannot escape the directory.
		if (path === "/" || path === "/panel") {
			const body = panelShell(options);
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Length": Buffer.byteLength(body),
				"Cache-Control": "no-cache",
			});
			res.end(body);
			return;
		}
		if (path.startsWith("/panel/")) {
			const name = basename(path);
			const type = PANEL_FILES[name];
			if (type === undefined) {
				writeOpenAIError(res, 404, "not_found", `no such panel asset: ${name}`);
				return;
			}
			res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
			createReadStream(join(PANEL_DIR, name)).on("error", () => {
				if (!res.headersSent) writeOpenAIError(res, 500, "internal", `panel asset unreadable: ${name}`);
				else res.end();
			}).pipe(res);
			return;
		}

		if (path === "/healthz") {
			const variants = [];
			for (const runtime of runtimes) {
				const status = await runtime.store.status();
				const blocked = [];
				for (const [key, block] of quotaBlocks) {
					const [variantId, model] = key.split("\u0000");
					if (variantId !== runtime.id) continue;
					blocked.push({ model, resetsAt: block.resetLabel });
				}
				variants.push({
					id: runtime.id,
					route: runtime.route,
					baseUrl: baseUrlFor(runtime),
					...status,
					// Self-diagnosis: lets a user (or their agent) tell an
					// upstream limit apart from a bridge or network fault
					// without reading the log file. The last failure is kept
					// even after a later success — it is timestamped, and
					// `lastSuccessAt` says whether things recovered.
					...(runtime.lastError === undefined ? {} : { lastError: runtime.lastError }),
					...(runtime.lastSuccessAt === undefined ? {} : { lastSuccessAt: runtime.lastSuccessAt }),
					...(blocked.length === 0 ? {} : { quotaBlocked: blocked }),
				});
			}
			const opencodeStatus = opencode === null
				? { enabled: false }
				: {
					enabled: true,
					route: OPENCODE_PROVIDER_ID,
					baseUrl: opencodeBaseUrl,
					...opencode.describe(),
					// The catalog as last fetched; whether each entry answers is cached
					// separately and is not recomputed here, because a probe would make
					// this endpoint slow.
					listed: (opencode.modelsCache ?? []).map((model) => model.id),
				};
			writeJson(res, 200, { ok: true, plugin: plugin.libDir, port: options.port, variants, opencode: opencodeStatus });
			return;
		}

		/**
		 * `/opencode/v1/...` — the second upstream.
		 *
		 * Shares this listener and the OpenAI SSE helpers, but not the variant runtime,
		 * which is built around WorkBuddy's credential store. Only reachable models are
		 * listed, so HanaAgent never offers one that cannot answer.
		 */
		async function handleOpenCode(req, res, path) {
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const tail = path.slice(`/${OPENCODE_PROVIDER_ID}/v1/`.length);

			if (tail === "models") {
				if (req.method !== "GET") {
					writeOpenAIError(res, 405, "method_not_allowed", "models is GET-only");
					return;
				}
				try {
					// Only what would actually be published: a model the user hid must not be
					// selectable here either, or hiding would be advisory only.
					const usable = await opencode.selectableModels();
					writeJson(res, 200, {
						object: "list",
						data: usable.map((model) => ({ id: model.id, object: "model", created: 0, owned_by: OPENCODE_PROVIDER_ID })),
					});
				} catch (error) {
					writeOpenAIError(res, 503, "unavailable", `OpenCode 免费模型不可用：${trimRaw(String(error), 300)}`);
				}
				return;
			}

			if (tail !== "chat/completions") {
				writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${path}`);
				return;
			}
			if (req.method !== "POST") {
				writeOpenAIError(res, 405, "method_not_allowed", "chat/completions is POST-only");
				return;
			}
			if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
				writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
				return;
			}

			const raw = (await readBody(req)).toString("utf8");
			let requestedModel = "unknown";
			let wantsStream = true;
			let parsed;
			try {
				parsed = JSON.parse(raw);
				if (typeof parsed?.model === "string") requestedModel = parsed.model;
				if (parsed?.stream === false) wantsStream = false;
			} catch {
				writeOpenAIError(res, 400, "invalid_request_error", "request body is not valid JSON");
				return;
			}

			let result;
			try {
				result = await opencode.chatStream(parsed, undefined);
			} catch (error) {
				writeOpenAIError(res, 502, "server", `桥接调用 OpenCode 时出错（桥接层）：${trimRaw(String(error), 300)}`);
				return;
			}
			if (!result.ok) {
				log(`[${OPENCODE_PROVIDER_ID}] ${requestedModel} ✗ ${result.kind} (http ${result.status})`);
				writeOpenAIError(res, result.status ?? 502, result.kind ?? "server", result.message ?? "OpenCode 调用失败");
				return;
			}

			if (wantsStream) {
				res.on("finish", () => log(`[${OPENCODE_PROVIDER_ID}] ${requestedModel} ✓ stream`));
				await streamCompletion(res, result);
				return;
			}
			const body = await new Response(result.response.body).text();
			res.on("finish", () => log(`[${OPENCODE_PROVIDER_ID}] ${requestedModel} ✓ buffered`));
			writeJson(res, 200, sseToCompletion(body, requestedModel));
		}

		if (opencode !== null && path.startsWith(`/${OPENCODE_PROVIDER_ID}/v1/`)) {
			await handleOpenCode(req, res, path);
			return;
		}

		const match = /^\/([a-z0-9-]+)\/v1\/(models|chat\/completions)$/.exec(path);
		if (match === null) {
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${path}`);
			return;
		}
		const runtime = runtimes.find((candidate) => candidate.route === match[1]);
		if (runtime === undefined) {
			writeOpenAIError(res, 404, "not_found", `unknown variant: ${match[1]}`);
			return;
		}
		if (!bearerOk(req)) {
			writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
			return;
		}

		if (match[2] === "models") {
			if (req.method !== "GET") {
				writeOpenAIError(res, 405, "method_not_allowed", "models is GET-only");
				return;
			}
			const catalog = await catalogFor(chunk, runtime, url.searchParams.get("refresh") === "1");
			writeJson(res, 200, {
				object: "list",
				data: catalog.models.map((model) => ({ id: model.id, object: "model", created: 0, owned_by: runtime.id })),
			});
			return;
		}

		if (req.method !== "POST") {
			writeOpenAIError(res, 405, "method_not_allowed", "chat/completions is POST-only");
			return;
		}
		if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}

		const raw = (await readBody(req)).toString("utf8");
		let requestedModel = "unknown";
		let wantsStream = true;
		try {
			const parsed = JSON.parse(raw);
			if (typeof parsed?.model === "string") requestedModel = parsed.model;
			if (parsed?.stream === false) wantsStream = false;
		} catch {
			writeOpenAIError(res, 400, "invalid_request_error", "request body is not valid JSON");
			return;
		}

		let credential;
		try {
			credential = await runtime.store.resolve();
		} catch (error) {
			// Local credential problem: neither WorkBuddy's servers nor the
			// network are involved, so say so instead of forwarding the
			// upstream helper's English text alone.
			writeOpenAIError(
				res,
				401,
				"not_signed_in",
				`WorkBuddy 桌面 App 的登录凭据读不到（本地凭据问题，与 WorkBuddy 服务端无关）：打开对应的桌面 App 登录一次，或检查凭据文件位置。原始信息：${trimRaw(String(error), 300)}`,
			);
			return;
		}

		// A quota rejection already told us when it lifts. Answering retries
		// from memory keeps HanaAgent's automatic 429 retries off WorkBuddy's
		// servers entirely.
		const blocked = activeQuotaBlock(runtime, requestedModel);
		if (blocked !== undefined) {
			log(`[${runtime.route}] ${requestedModel} ⏳ quota cached (resets ${blocked.resetLabel})`);
			writeOpenAIError(res, blocked.status, blocked.kind, blocked.message, {
				"Retry-After": String(Math.max(1, Math.ceil((blocked.untilMs - Date.now()) / 1000))),
			});
			return;
		}

		const prepared = chunk.prepareChatBody(raw);
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		let result;
		try {
			result = await runtime.client.chatStream(credential, prepared, controller.signal);
		} catch (error) {
			writeOpenAIError(res, 502, "server", `桥接调用 WorkBuddy 时出错（桥接层）：${trimRaw(String(error), 300)}。详见 logs/bridge.log。`);
			return;
		}
		if (!result.ok) {
			const status = KIND_STATUS[result.kind] ?? 502;
			const message = failureMessage(requestedModel, result);
			const facts = describeFailure(result);
			if (result.kind === "soft_rate") blockQuota(runtime, requestedModel, result, facts);
			runtime.lastError = {
				at: new Date().toISOString(),
				model: requestedModel,
				kind: result.kind,
				upstreamStatus: result.status,
				upstreamCode: facts.code,
				resetAt: facts.reset?.label,
				message,
			};
			log(`[${runtime.route}] ${requestedModel} ✗ ${result.kind} (http ${result.status})${facts.code === undefined ? "" : ` code=${facts.code}`}${facts.reset === undefined ? "" : ` resets ${facts.reset.label}`}`);
			writeOpenAIError(res, status, result.kind, message, facts.reset === undefined ? undefined : {
				"Retry-After": String(Math.max(1, Math.ceil((Math.min(facts.reset.ms, Date.now() + QUOTA_REPROBE_MS) - Date.now()) / 1000))),
			});
			return;
		}

		runtime.lastSuccessAt = new Date().toISOString();
		quotaBlocks.delete(quotaKey(runtime, requestedModel));
		if (wantsStream) {
			res.on("finish", () => log(`[${runtime.route}] ${requestedModel} ✓ stream`));
			await streamCompletion(res, result);
			return;
		}
		const body = await new Response(result.response.body).text();
		res.on("finish", () => log(`[${runtime.route}] ${requestedModel} ✓ buffered`));
		writeJson(res, 200, sseToCompletion(body, requestedModel));
	}

	try {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.port, options.host, resolve);
		});
	} catch (error) {
		// A taken port is the most common startup failure; say what to do
		// instead of surfacing a bare EADDRINUSE stack.
		if (error?.code === "EADDRINUSE") {
			throw new Error(`端口 ${options.port} 已被占用（可能已经有一个桥接在运行）：先停止它（start-workbuddy-bridge.ps1 -Stop），或用 --port 换一个端口。`);
		}
		if (error?.code === "EACCES") throw new Error(`无法绑定 ${options.host}:${options.port}（权限不足）。`);
		throw error;
	}
	log(`listening on http://${options.host}:${options.port}`);
	for (const runtime of runtimes) log(`  ${runtime.displayName}: ${baseUrlFor(runtime)}`);

	// The settings page is a HanaAgent plugin in a different process: this file
	// is how it finds the bridge, so a custom --port or --token never has to be
	// configured twice. It is written after the socket is up, so its presence
	// means the bridge really is serving.
	try {
		mkdirSync(options.dataDir, { recursive: true });
		writeFileSync(
			join(options.dataDir, "endpoint.json"),
			`${JSON.stringify(
				{
					port: options.port,
					host: options.host,
					token: options.token,
					pid: process.pid,
					startedAt: new Date().toISOString(),
					hanaHome: options.hanaHome,
					logFile: options.logFile,
					pluginLib: plugin.libDir,
					adminUrl: `http://${options.host}:${options.port}/admin`,
				},
				null,
				2,
			)}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		log(`endpoint file: ${join(options.dataDir, "endpoint.json")}`);
	} catch (error) {
		warn(`could not write endpoint.json (the settings page will not find this port): ${String(error)}`);
	}

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

try {
	await main();
} catch (error) {
	// Startup failures (plugin missing, port taken, bad arguments) are fatal.
	// They must not go through the runtime `uncaughtException` handler, whose
	// "(continuing)" wording would be a lie, and they must leave a non-zero
	// exit code so a script or supervisor can tell that nothing is serving.
	warn(`启动失败：${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
