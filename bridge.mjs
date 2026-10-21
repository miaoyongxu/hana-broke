#!/usr/bin/env node
/**
 * Hana Broke's bridge: provider plugins → one OpenAI-compatible server for HanaAgent.
 *
 * The design changed with the plugin host. Instead of one hand-written adapter per
 * vendor, the vendors are `@magpie-community/opencode-*-auth` packages — Qoder,
 * WorkBuddy, OpenCode Zen Free and a growing list — and this process is the thing that
 * drives them (see `plugin-host.mjs`). What is left here is the part no plugin can do:
 *
 *   HanaAgent ──▶ http://127.0.0.1:<port>/<provider>/v1/chat/completions
 *                        │
 *                        ├── plugin: sign-in, model list, one vendor request
 *                        └── this file: routing, error shape, HanaAgent registration
 *
 * Two boundaries are deliberate.
 *
 * **Plugins own the vendor; this file owns the client contract.** A request arrives in
 * OpenAI's shape and the plugin answers in whatever its vendor speaks; the response body
 * is passed through untouched, because rewriting it would drop the streaming, tool calls
 * and reasoning the plugin translated. Only errors are normalised, so a caller sees one
 * error shape whichever vendor failed.
 *
 * **HanaAgent registration is this App's own knowledge.** Which model fields HanaAgent
 * reads, the tombstone it writes when a provider is deleted, and how a declaration is
 * pushed to a running app: none of that is a plugin's business, and all of it is in
 * `hana-providers.mjs` / `hana-apply.mjs`.
 *
 * @module hanako-bridge
 */

import { createServer } from "node:http";
import { createWriteStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

import { createAdminApi } from "./admin-api.mjs";
import { TOKEN_FILE, createRequestGate, describeTokenFile, loadOrCreateToken, writeRefusal } from "./bridge-auth.mjs";
import {
	PLUGIN_PROVIDERS,
	PluginAuthStore,
	ProviderPlugin,
	pluginEntry,
	sessionIdFor,
} from "./plugin-host.mjs";

const {
	writeProviderPlugin,
	isBridgeOwnedProvider,
	providerTombstoned,
	BRIDGE_MARKER,
	resolveHanaHome,
} = await import("./hana-providers.mjs");
const { applyProvider, providerRegistered } = await import("./hana-apply.mjs");

/** Where the plugin packages live, relative to this file. */
const PLUGINS_DIR = join(dirname(fileURLToPath(import.meta.url)), "plugins");

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024;
/** How long a provider's model list is trusted before it is asked again. */
const CATALOG_TTL_MS = 10 * 60_000;
/** How long a measured "this model answers" verdict is trusted. */
const PROBE_TTL_MS = 6 * 60 * 60_000;

//#region arguments

function parseArgs(argv) {
	const options = {
		port: Number(process.env["HANABROKE_PORT"] ?? 8789),
		host: process.env["HANABROKE_HOST"] ?? "127.0.0.1",
		/**
		 * No empty default and no environment fallback for the bearer.
		 *
		 * An empty token used to mean "any caller is welcome", which is exactly
		 * the defect this bridge was rejected for: loopback is reachable by every
		 * local process. The value comes from `bridge-token` on disk (see
		 * `bridge-auth.mjs`), never from an inherited variable that a caller could
		 * set to "".
		 */
		token: "",
		hanaHome: resolveHanaHome(),
		dataDir: process.env["HANABROKE_DATA_DIR"] ?? "",
		logFile: process.env["HANABROKE_LOG"] ?? "",
		resyncMinutes: Number(process.env["HANABROKE_RESYNC_MINUTES"] ?? 15),
		sync: true,
		apply: true,
		syncOnly: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--port") options.port = Number(argv[++index]);
		else if (arg === "--host") options.host = argv[++index];
		else if (arg === "--token") options.token = argv[++index] ?? "";
		else if (arg === "--print-token") options.printToken = true;
		else if (arg === "--hana-home") options.hanaHome = argv[++index];
		else if (arg === "--data-dir") options.dataDir = argv[++index] ?? "";
		else if (arg === "--log-file") options.logFile = argv[++index] ?? "";
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
	if (options.dataDir === "") options.dataDir = join(options.hanaHome, "plugin-data", "hana-broke");
	// The bearer is never defaulted to empty: `--token` wins when given, and
	// otherwise the persisted file is read (created on first run).
	if (options.token === "") options.token = loadOrCreateToken(options.dataDir);
	if (options.token === "") throw new Error(`no bearer available: ${join(options.dataDir, TOKEN_FILE)} is empty`);
	return options;
}

const HELP = `Hana Broke bridge — provider plugins into HanaAgent

  node bridge.mjs [options]

Options:
  --port <n>        listen port (default 8789, env HANABROKE_PORT). Deliberately not
                    magpie's 3425: both may run, and they are different gateways.
  --host <addr>     listen address (default 127.0.0.1)
  --token <value>   bearer every request must present. Omitted: the bridge reads
                    it from <data-dir>/bridge-token, creating it on first run.
                    There is no "any bearer" mode.
  --print-token     print the token file's contents and exit (for a local script
                    that needs to call /admin itself)
  --hana-home <dir> HanaAgent data directory (default ~/.hanako)
  --data-dir <dir>  bridge state: plugin credentials, visibility
                    (default <hana-home>/plugin-data/hana-broke)
  --log-file <path> also append logs to this UTF-8 file
  --resync-minutes <n> re-check provider catalogs every n minutes (default 15, 0 = never)
  --no-sync         do not (re)write the HanaAgent provider plugins
  --no-apply        only write the files, do not hot-register a running HanaAgent
  --sync-only       refresh the provider plugins and exit
  -h, --help        this text
`;

//#endregion

//#region logging

let logStream;

/** Keep a broken console stream from killing the daemon. */
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

const timestamp = () => new Date().toISOString().slice(11, 19);

function emit(stream, line) {
	logStream?.write(line);
	try {
		stream.write(line);
	} catch {
		// the console went away mid-write; the log file already has the line
	}
}

const log = (message) => emit(process.stdout, `${timestamp()} ${message}\n`);
const warn = (message) => emit(process.stderr, `${timestamp()} ! ${message}\n`);

//#endregion

//#region HTTP helpers

function writeJson(res, status, body, headers = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
		...headers,
	});
	res.end(payload);
}

/** The one error shape, whichever vendor failed. */
function writeOpenAIError(res, status, kind, message, headers) {
	writeJson(res, status, { error: { message, type: kind, code: kind } }, headers);
}

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

/** Pass an upstream SSE response through, unchanged. */
async function streamCompletion(res, upstream) {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		"Connection": "keep-alive",
		"X-Accel-Buffering": "no",
	});
	const body = Readable.fromWeb(upstream.body);
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

//#region providers

/**
 * Load every provider this build ships.
 *
 * A package that is missing or broken is reported and skipped rather than taking the
 * whole bridge down: one unavailable vendor should not stop the other four from serving.
 */
async function loadProviders({ store, log: say, warn: complain }) {
	const loaded = [];
	for (const spec of PLUGIN_PROVIDERS) {
		const entry = pluginEntry(spec, PLUGINS_DIR);
		if (entry.available !== true) {
			complain(`provider ${spec.id}: ${entry.reason}`);
			continue;
		}
		if (entry.dependencies.length > 0) {
			complain(`provider ${spec.id}: ${spec.package} declares dependencies (${entry.dependencies.join(", ")}); the bundle expects none`);
		}
		let module;
		try {
			module = await import(`file://${entry.path.replace(/\\/g, "/")}`);
		} catch (error) {
			complain(`provider ${spec.id}: ${spec.package} 加载失败：${String(error)}`);
			continue;
		}
		if (typeof module[spec.export] !== "function") {
			complain(`provider ${spec.id}: ${spec.package} 没有导出 ${spec.export}`);
			continue;
		}
		loaded.push(new ProviderPlugin({ spec, module, store, log: say, warn: complain }));
	}
	return loaded;
}

/**
 * One provider's model list, cached.
 *
 * Concurrent callers share one in-flight request. Without that, the model list route and a
 * running sync each ask the vendor at the same time, and because the sync also *probes*
 * every model the list route would sit behind it for a minute — which reads as a hang, and
 * was measured as one.
 */
async function catalogFor(provider, force) {
	const now = Date.now();
	if (!force && provider.catalog !== undefined && now - provider.catalogAt < CATALOG_TTL_MS) return provider.catalog;
	if (provider.catalogPending !== undefined) return provider.catalogPending;
	provider.catalogPending = (async () => {
		try {
			const result = await provider.listModels();
			provider.catalog = result;
			provider.catalogAt = Date.now();
			return result;
		} finally {
			provider.catalogPending = undefined;
		}
	})();
	return provider.catalogPending;
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

	process.on("uncaughtException", (error) => {
		warn(`uncaught exception (continuing): ${error?.stack ?? String(error)}`);
	});
	process.on("unhandledRejection", (reason) => {
		warn(`unhandled rejection (continuing): ${reason?.stack ?? String(reason)}`);
	});
	process.on("exit", (code) => {
		if (code !== 0) warn(`bridge exiting with code ${String(code)}`);
	});

	mkdirSync(options.dataDir, { recursive: true });
	const store = new PluginAuthStore(options.dataDir);
	const providers = await loadProviders({ store, log, warn });
	if (providers.length === 0) {
		throw new Error(`没有一个供应商插件可用；检查 ${PLUGINS_DIR} 下是否装好了 @magpie-community/opencode-*-auth`);
	}
	log(`providers: ${providers.map((provider) => provider.id).join(", ")}`);

	const baseUrlFor = (provider) => `http://${options.host}:${options.port}/${provider.id}/v1`;

	/** Declarations last pushed, per provider, so an unchanged one is not rewritten. */
	const appliedSignatures = new Map();

	/**
	 * Build one provider's HanaAgent declaration.
	 *
	 * Only models the plugin actually listed are declared. A plugin that fell back to a
	 * short built-in list says so, and those models are still declared — they are the
	 * vendor's own names — but the panel reports the fallback so a missing model is not a
	 * mystery.
	 */
	async function declare(provider) {
		if (!provider.signedIn()) {
			return {
				id: provider.id,
				skipped: "还没有登录（在控制台里先登录一次）",
				keptExisting: isBridgeOwnedProvider(provider.id, options.hanaHome),
			};
		}
		let catalog;
		try {
			catalog = await catalogFor(provider, true);
		} catch (error) {
			return {
				id: provider.id,
				skipped: String(error?.message ?? error),
				keptExisting: isBridgeOwnedProvider(provider.id, options.hanaHome),
			};
		}
		let models = catalog.models;
		if (models.length === 0) {
			return {
				id: provider.id,
				skipped: catalog.listError ?? "上游没有列出任何模型",
				keptExisting: isBridgeOwnedProvider(provider.id, options.hanaHome),
			};
		}
		const hidden = new Set(provider.hiddenIds());
		models = models.filter((model) => !hidden.has(model.id));
		if (models.length === 0) {
			return {
				id: provider.id,
				skipped: `全部 ${catalog.models.length} 个模型都被你隐藏了`,
				keptExisting: isBridgeOwnedProvider(provider.id, options.hanaHome),
			};
		}
		// A listed model is not a working model: measured on zen-free's roster, three of
		// nine were listed and refused. Declaring those fills the picker with models that
		// fail on every use, so each is probed once and the verdict cached.
		const probe = await measureModels(provider, models);
		models = probe.usable;
		if (models.length === 0) {
			return {
				id: provider.id,
				skipped: `没有一个模型真正可用（试了 ${probe.tried} 个，全部失败）`,
				keptExisting: isBridgeOwnedProvider(provider.id, options.hanaHome),
			};
		}
		const outcome = writeProviderPlugin({
			id: provider.id,
			displayName: provider.label,
			baseUrl: baseUrlFor(provider),
			models: models.map((model) => ({
				id: model.id,
				name: model.name,
				contextWindow: model.context,
				maxTokens: model.maxOutput,
				supportsImages: model.vision,
				reasoning: model.reasoning,
				supportedEfforts: model.efforts,
			})),
			hanaHome: options.hanaHome,
			// The bearer HanaAgent must present on every model call. Writing it
			// here is what turns the bridge's check from "loopback callers are
			// trusted" into "callers that were issued the key are served".
			apiKey: options.token,
			description: `${provider.label} via the Hana Broke bridge (${models.length} models).`,
		});
		if (outcome.tombstoned === true) {
			return { id: provider.id, skipped: "已被 HanaAgent 删除（meta.deletedProviders）", keptExisting: false };
		}
		return {
			id: provider.id,
			displayName: provider.label,
			dir: outcome.dir,
			changed: outcome.changed,
			models: outcome.models,
			modelCount: outcome.modelCount,
			baseUrl: baseUrlFor(provider),
			source: catalog.fellBack ? "fallback" : "live",
			listError: catalog.listError,
			unreachable: probe.tried - models.length,
		};
	}

	/**
	 * Split a roster into the models that answered and the ones that did not.
	 *
	 * A cached verdict is trusted for {@link PROBE_TTL_MS}; only stale or unknown models are
	 * asked again. Probing is serial on purpose: a vendor refusing this machine should not
	 * get nine concurrent requests to prove it.
	 */
	async function measureModels(provider, models) {
		if (process.env["WORKBUDDY_PROBE"] === "off") return { usable: models, tried: 0 };
		const cache = provider.probeCache();
		const now = Date.now();
		const fresh = (entry) => entry !== undefined && typeof entry.at === "number" && now - entry.at < PROBE_TTL_MS;
		const usable = [];
		let tried = 0;
		for (const model of models) {
			const cached = cache[model.id];
			if (fresh(cached)) {
				if (cached.ok === true) usable.push(model);
				continue;
			}
			tried += 1;
			const result = await provider.probeModel(model.id);
			cache[model.id] = result.ok === true ? { ok: true, at: Date.now() } : { ok: false, at: Date.now(), error: result.error };
			if (result.ok === true) usable.push(model);
			else warn(`provider ${provider.id}: ${model.id} 不可用 — ${result.error}`);
		}
		if (tried > 0) {
			try {
				provider.setProbeCache(cache);
			} catch (error) {
				warn(`provider ${provider.id}: could not cache probe results (${String(error)})`);
			}
		}
		return { usable, tried };
	}

	/** Declare one provider and, when it changed, push it into a running HanaAgent. */
	async function publish(result) {
		if (result.error !== undefined) {
			warn(`provider ${result.id}: ${result.error}`);
			return;
		}
		if (result.skipped !== undefined) {
			const note = result.keptExisting === true ? "；先前的声明保持不动" : "";
			warn(`provider ${result.id} not registered: ${result.skipped}${note}`);
			return;
		}
		if (providerTombstoned(result.id, options.hanaHome) === true) {
			warn(
				`provider ${result.id}: 已在 HanaAgent 里被删除（provider-catalog.json 的 meta.deletedProviders 记着这个 id），` +
					"桥接不会把它加回来。要恢复就在 HanaAgent 的「设置 → 模型」里重新添加。",
			);
			return;
		}
		log(`provider ${result.id}: ${result.modelCount} models (${result.source}) → ${result.dir}`);
		if (result.listError !== undefined) warn(`provider ${result.id}: ${result.listError}`);
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
				apiKey: options.token,
				description: `${result.displayName} models ${BRIDGE_MARKER}.`,
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

	/**
	 * One sync at a time.
	 *
	 * A visibility change, a panel refresh and the timer can all ask for one within a
	 * second of each other, and each would otherwise re-probe the same models — spending the
	 * user's allowance several times over for one edit. A caller that arrives mid-sync
	 * waits for it and shares its result, which is what it wanted anyway.
	 */
	let syncInFlight;

	/**
	 * Declare every provider and push the changed ones into HanaAgent.
	 *
	 * @returns {Promise<object[]>} one result per provider
	 */
	async function runSync() {
		if (syncInFlight !== undefined) return syncInFlight;
		syncInFlight = (async () => {
			try {
				const results = [];
				for (const provider of providers) {
					let result;
					try {
						result = await declare(provider);
					} catch (error) {
						result = { id: provider.id, error: String(error?.message ?? error) };
					}
					results.push(result);
					await publish(result);
				}
				return results;
			} finally {
				syncInFlight = undefined;
			}
		})();
		return syncInFlight;
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

	/**
	 * Every request passes this gate before any route sees it: Host, Origin and
	 * `Sec-Fetch-Site` first, then the bearer. Refusals are logged with the reason
	 * they actually failed and answered with one uniform body, so a prober cannot
	 * tell which input it got wrong.
	 */
	const gate = createRequestGate({ token: options.token, host: options.host, port: options.port, warn });

	function refuse(res, reason) {
		gateFailures.set(reason, (gateFailures.get(reason) ?? 0) + 1);
		writeRefusal(res, reason);
	}
	/** Counts per reason, surfaced by `/healthz` so a user can see the probes. */
	const gateFailures = new Map();

	/**
	 * `/<provider>/v1/...` — one route shape for every vendor.
	 *
	 * The plugin owns the vendor's protocol, so this layer only does the things a client
	 * contract needs: validate, authenticate, pass the body through, and turn a failure
	 * into one error shape.
	 */
	async function handleProvider(req, res, path, url) {
		const match = /^\/([a-z0-9-]+)\/v1\/(models|chat\/completions)$/.exec(path);
		if (match === null) {
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${path}`);
			return;
		}
		const provider = providers.find((candidate) => candidate.id === match[1]);
		if (provider === undefined) {
			writeOpenAIError(res, 404, "not_found", `unknown provider: ${match[1]}`);
			return;
		}

		if (match[2] === "models") {
			if (req.method !== "GET") {
				writeOpenAIError(res, 405, "method_not_allowed", "models is GET-only");
				return;
			}
			if (!provider.signedIn()) {
				writeOpenAIError(res, 401, "not_signed_in", `${provider.label} 还没有登录：先在控制台登录一次`);
				return;
			}
			try {
				const catalog = await catalogFor(provider, url.searchParams.get("refresh") === "1");
				const hidden = new Set(provider.hiddenIds());
				writeJson(res, 200, {
					object: "list",
					data: catalog.models
						.filter((model) => !hidden.has(model.id))
						.map((model) => ({ id: model.id, object: "model", created: 0, owned_by: provider.id })),
				});
			} catch (error) {
				writeOpenAIError(res, 503, "unavailable", `${provider.label} 的模型列表读不到：${String(error?.message ?? error)}`);
			}
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
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			writeOpenAIError(res, 400, "invalid_request_error", "request body is not valid JSON");
			return;
		}
		const requested = typeof parsed?.model === "string" ? parsed.model : "unknown";
		if (!provider.signedIn()) {
			writeOpenAIError(res, 401, "not_signed_in", `${provider.label} 还没有登录：先在控制台登录一次`);
			return;
		}
		// The caller's signal comes from the client disconnecting: cancelling the vendor
		// request with it is what stops a closed tab from billing a full generation.
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		const sessionId = typeof req.headers["x-session-id"] === "string"
			? req.headers["x-session-id"]
			: sessionIdFor(JSON.stringify(parsed?.messages ?? []));
		let out;
		try {
			out = await provider.chat({ body: parsed, signal: controller.signal, sessionId });
		} catch (error) {
			writeOpenAIError(res, 502, "server", `桥接调用 ${provider.label} 时出错：${String(error?.message ?? error)}`);
			return;
		}
		const upstream = out.response;
		if (!upstream.ok) {
			const detail = await upstream.text().catch(() => "");
			// A vendor's error body is more useful than its status: it names the reason
			// (login expired, quota, model not served) in the vendor's own words.
			const message = detail.trim() === "" ? `HTTP ${upstream.status}` : detail.slice(0, 600);
			log(`[${provider.id}] ${requested} ✗ ${upstream.status}`);
			writeOpenAIError(res, upstream.status === 401 || upstream.status === 403 ? 401 : 502, "upstream_error", message);
			return;
		}
		const wantsStream = parsed?.stream !== false;
		const type = String(upstream.headers.get("content-type") ?? "");
		if (!wantsStream || !type.includes("text/event-stream")) {
			const body = await upstream.text();
			res.on("finish", () => log(`[${provider.id}] ${requested} ✓ buffered`));
			if (type.includes("text/event-stream")) {
				writeJson(res, 200, sseToCompletion(body, requested));
			} else {
				// A plugin may answer a non-streaming request with plain JSON; pass it on.
				res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
				res.end(body);
			}
			return;
		}
		res.on("finish", () => log(`[${provider.id}] ${requested} ✓ stream`));
		await streamCompletion(res, upstream);
	}

	/**
	 * Operator console (`/admin/...`), kept in its own module: a different surface from
	 * the model endpoint, sharing only the bind address and the optional bearer.
	 */
	const handleAdmin = createAdminApi({
		providers,
		store,
		options,
		bearerOk: gate.bearerOk,
		syncNow: runSync,
		catalogFor,
		log,
		warn,
		shutdown: () => {
			server.close(() => process.exit(0));
			server.closeAllConnections();
		},
	});

	const server = createServer((req, res) => {
		void handle(req, res).catch((error) => {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
			else res.end();
		});
	});

	async function handle(req, res) {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const path = url.pathname.replace(/\/+$/, "") || "/";

		// One gate in front of every route, including `/healthz`: it reports
		// sign-in state and model counts, which is the bridge's business and not
		// an anonymous caller's. There is no unauthenticated surface left to
		// leak the bearer from, so no route needs an exemption to keep the
		// console working — the console lives in HanaAgent and holds the token
		// itself, delivered over the App's own authenticated route.
		const refused = gate.refuseReason(req);
		if (refused !== undefined) {
			refuse(res, refused);
			return;
		}

		if (path === "/admin" || path.startsWith("/admin/")) {
			await handleAdmin(req, res, url);
			return;
		}
		if (path === "/healthz") {
			const rows = [];
			for (const provider of providers) {
				rows.push({
					...provider.describe(),
					baseUrl: baseUrlFor(provider),
					listed: (provider.catalog?.models ?? []).length,
					fellBack: provider.catalog?.fellBack === true,
					listError: provider.catalog?.listError ?? null,
				});
			}
			writeJson(res, 200, {
				ok: true,
				port: options.port,
				providers: rows,
				// Non-secret, but worth surfacing: a user whose token file is
				// readable by others should know before someone else does.
				tokenFile: describeTokenFile(options.dataDir),
				refusals: Object.fromEntries(gateFailures),
			});
			return;
		}
		if (path.startsWith("/") && /^\/[a-z0-9-]+\/v1\//.test(path)) {
			await handleProvider(req, res, path, url);
			return;
		}
		writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${path}`);
	}

	try {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.port, options.host, resolve);
		});
	} catch (error) {
		if (error?.code === "EADDRINUSE") {
			throw new Error(
				`端口 ${options.port} 已被占用：可能是另一个桥接，或者 magpie（它默认用 3425）。用 --port 换一个端口。`,
			);
		}
		if (error?.code === "EACCES") throw new Error(`无法绑定 ${options.host}:${options.port}（权限不足）。`);
		throw error;
	}
	log(`listening on http://${options.host}:${options.port}`);
	for (const provider of providers) log(`  ${provider.label}: ${baseUrlFor(provider)}`);

	try {
		mkdirSync(options.dataDir, { recursive: true });
		// No bearer in here. It lives in exactly one place — `bridge-token` — so
		// there is one file to protect and one file to rotate; a second copy in a
		// less-obvious file would be the one that leaks.
		writeFileSync(
			join(options.dataDir, "endpoint.json"),
			`${JSON.stringify(
				{
					port: options.port,
					host: options.host,
					pid: process.pid,
					startedAt: new Date().toISOString(),
					hanaHome: options.hanaHome,
					logFile: options.logFile,
					tokenFile: join(options.dataDir, TOKEN_FILE),
					adminUrl: `http://${options.host}:${options.port}/admin`,
				},
				null,
				2,
			)}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		log(`endpoint file: ${join(options.dataDir, "endpoint.json")}`);
	} catch (error) {
		warn(`could not write endpoint.json: ${String(error)}`);
	}

	const shutdown = () => {
		server.close(() => process.exit(0));
		server.closeAllConnections();
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

try {
	// `--print-token` is answered before anything starts: a caller that only wants
	// the bearer should not leave a bridge running behind it. Help and normal
	// starts fall through to `main()`, which already handles `--help`.
	const argv = process.argv.slice(2);
	if (argv.includes("--print-token")) process.stdout.write(`${parseArgs(argv).token}\n`);
	else await main();
} catch (error) {
	warn(`启动失败：${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
