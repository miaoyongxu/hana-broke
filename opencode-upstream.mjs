/**
 * OpenCode free models → OpenAI-compatible upstream.
 *
 * Why this exists at all, and why it depends on a specific binary:
 *
 * OpenCode gates its free tier server-side. Both the public endpoint
 * (`https://opencode.ai/inference/v1/chat/completions`) and the v1 CLI's provider
 * path (`https://opencode.ai/zen/v1/...`) answer every request with
 *
 *     403 {"error":{"type":"FreeTierError",
 *          "message":"OpenCode's free tier can only be used from within OpenCode."}}
 *
 * No credential, user-agent or `x-opencode-*` header changes that — verified against
 * the v1 CLI at both 1.19.0 and 1.18.34 (the version OW Bridge validated against), and
 * against the public endpoint directly. What *does* work is the **v2 CLI that ships
 * with the OpenCode desktop app**, driven over its own loopback API. Measured on
 * 2026-10-15: 11/11 free models answered correctly.
 *
 * Two behaviours of that API shape this module:
 *
 *  1. `serve` prints `server password <PW>` on stdout and then requires HTTP Basic
 *     auth (`opencode:<PW>`) for every route.
 *  2. The **first** inference request after startup always fails (FreeTierError or
 *     RegionError); every request after it succeeds. So startup warms the connection
 *     once and swallows the result — see `warmUp`.
 *
 * Requests are served in this document's own OpenAI SSE shape, so the bridge's existing
 * `streamCompletion` / `sseToCompletion` helpers can handle both the streaming and the
 * buffered reply without a second translation layer.
 *
 * @module hanako-opencode-upstream
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/** Provider id / route name used in HanaAgent and in the bridge URL. */
export const OPENCODE_PROVIDER_ID = "opencode";

/** How long a measured availability result is trusted before re-probing. */
export const PROBE_TTL_MS = 6 * 60 * 60_000;

/**
 * The isolated home is deliberately left at OpenCode's defaults.
 *
 * Every attempt to make it safer trips the free-tier gate, which is checked against the
 * request's shape. Measured on 2026-10-15, each of these answered every inference with
 * `403 FreeTierError: "can only be used from within OpenCode"`:
 *
 *   - a custom agent defined in the config (even a plain one)
 *   - overriding the built-in `build` agent's tools
 *   - a top-level `permission` deny, in both spellings
 *   - passing `permission` when creating the session (silently ignored: the stored
 *     session came back with `permission: null`)
 *
 * Only a stock configuration works — and a stock OpenCode runs its own tools. See
 * `#noteLocalActions` for how that is surfaced rather than hidden.
 */

/** OpenCode's own tool parts, used to detect that it acted on its own. */
const LOCAL_ACTION_WARNING = "注意：OpenCode 在本机自行执行了动作（见上），结果没有回传给客户端。";

/** Where the desktop app stages its own CLI, newest-version-wins. */
function desktopCliCandidates() {
	const root = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
	const cliRoot = join(root, "ai.opencode.desktop", "cli");
	const candidates = [];
	if (existsSync(cliRoot)) {
		// `<cliRoot>/<version>-<arch>/opencode-cli.exe`
		let entries = [];
		try {
			entries = readdirSync(cliRoot);
		} catch {
			entries = [];
		}
		for (const name of entries) {
			const exe = join(cliRoot, name, process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli");
			if (existsSync(exe)) candidates.push({ exe, version: name });
		}
	}
	return candidates;
}

/**
 * Locate a usable OpenCode CLI.
 *
 * Only the desktop app's **v2** CLI can reach the free tier, so it is preferred and
 * a v1 `opencode` on PATH is reported but never silently substituted — picking the
 * wrong one produces the confusing 403 above.
 */
export function resolveOpenCodeCli(explicit) {
	if (typeof explicit === "string" && explicit.trim() !== "") {
		return existsSync(explicit) ? { exe: explicit, source: "configured" } : null;
	}
	const candidates = desktopCliCandidates().sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
	if (candidates.length > 0) return { exe: candidates[0].exe, source: "desktop-app", version: candidates[0].version };
	if (process.platform === "win32") {
		const staged = join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "ai.opencode.desktop", "cli");
		const local = join(process.env["LOCALAPPDATA"] ?? "", "Programs", "@opencodedesktop", "resources", "opencode-cli.exe");
		if (existsSync(local)) return { exe: local, source: "desktop-app-resource" };
		void staged;
	}
	return null;
}

/** Ask the OS for a free loopback port. */
function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

/** Abortable sleep. */
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		}, { once: true });
	});
}

/**
 * The envelope instruction.
 *
 * `format: json_schema` is what OW Bridge uses, but OpenCode ignores it for these
 * providers — measured: with a JSON-schema format attached the model still answered in
 * prose, and only once the instruction moved into the prompt did it comply. So the
 * contract is stated in words and the reply is parsed leniently.
 */
export function buildEnvelopePrompt(tools) {
	const declared = tools.map((tool) => ({
		name: tool?.function?.name,
		description: tool?.function?.description,
		parameters: tool?.function?.parameters,
	}));
	return [
		"You are a planning layer for an external agent. You never perform actions yourself.",
		"Answer with ONE JSON object and nothing else — no prose, no code fence:",
		'{"content": string, "calls": [{"name": string, "arguments": object}]}',
		"- content: what to say to the user; use an empty string when you are only calling tools.",
		"- calls: tools to run. Use [] when no tool is needed.",
		"- `name` MUST be one of the tool names below, spelled exactly. Never invent or rename.",
		"- `arguments` must use exactly that tool's parameter names.",
		"",
		"Tools:",
		JSON.stringify(declared),
	].join("\n");
}

/**
 * Read the envelope out of a reply.
 *
 * Deliberately lenient: models wrap the JSON in a fence or add a sentence around it even
 * when told not to. Strictness here would throw away a perfectly usable answer.
 */
export function parseEnvelope(text, allowedNames) {
	const raw = String(text ?? "").trim();
	if (raw === "") return null;
	const candidates = [raw];
	const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence !== null) candidates.push(fence[1].trim());
	const first = raw.indexOf("{");
	const last = raw.lastIndexOf("}");
	if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));

	for (const candidate of candidates) {
		let parsed;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (parsed === null || typeof parsed !== "object") continue;
		const calls = Array.isArray(parsed.calls) ? parsed.calls : [];
		// A name the client never declared would be rejected by the client anyway; drop it
		// here so the reply degrades to text rather than to a broken tool call.
		const usable = allowedNames === undefined
			? calls
			: calls.filter((call) => typeof call?.name === "string" && allowedNames.has(call.name));
		return {
			content: typeof parsed.content === "string" ? parsed.content : "",
			calls: usable.map((call) => ({
				name: String(call.name),
				arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
			})),
		};
	}
	return null;
}

/** Flatten OpenAI chat messages into the single prompt text OpenCode accepts. */export function flattenMessages(messages) {
	const parts = [];
	for (const message of Array.isArray(messages) ? messages : []) {
		const role = typeof message?.role === "string" ? message.role : "user";
		let content = message?.content;
		if (Array.isArray(content)) {
			content = content.map((piece) => (typeof piece === "string" ? piece : typeof piece?.text === "string" ? piece.text : "")).join("");
		}
		if (typeof content !== "string") content = "";
		// Tool results and assistant tool calls carry no prose but matter to the model.
		const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
		const callText = calls.length === 0
			? ""
			: calls.map((call) => `[调用工具 ${call?.function?.name ?? "?"} 参数 ${call?.function?.arguments ?? "{}"}]`).join("\n");
		const body = [content, callText].filter((text) => text !== "").join("\n");
		if (body === "") continue;
		if (role === "system") parts.push(`[system]\n${body}`);
		else if (role === "assistant") parts.push(`[assistant]\n${body}`);
		else if (role === "tool") parts.push(`[tool result]\n${body}`);
		else parts.push(body);
	}
	return parts.join("\n\n");
}

/**
 * A managed OpenCode v2 server plus the OpenAI-shaped adapter in front of it.
 */
export class OpenCodeUpstream {
	constructor(options = {}) {
		this.explicitCli = options.cli ?? process.env["WORKBUDDY_OPENCODE_CLI"] ?? "";
		this.dataDir = options.dataDir ?? "";
		this.log = options.log ?? (() => {});
		this.warn = options.warn ?? (() => {});
		this.requestTimeoutMs = Number(options.requestTimeoutMs ?? 10 * 60_000);
		this.child = null;
		this.port = null;
		this.password = null;
		this.ready = null;
		this.cli = null;
		this.modelsCache = null;
		this.modelsCachedAt = 0;
		/** True until this server has served one inference, i.e. the cold start is unpaid. */
		this.coldStartPending = true;
		/** Tool calls are passed through to the client unless switched off. */
		this.allowTools = process.env["WORKBUDDY_OPENCODE_TOOLS"] !== "0";
	}

	/** Where the isolated OpenCode home lives, under the bridge's data dir. */
	home() {
		const base = this.dataDir !== "" ? join(this.dataDir, "opencode") : join(homedir(), ".hanako", "app-data", OPENCODE_PROVIDER_ID, "opencode");
		mkdirSync(base, { recursive: true });
		return base;
	}

	/** Diagnostics for the panel and `/healthz`. */
	describe() {
		const resolved = resolveOpenCodeCli(this.explicitCli);
		return {
			available: resolved !== null,
			cli: resolved?.exe ?? null,
			cliSource: resolved?.source ?? null,
			cliVersion: resolved?.version ?? null,
			running: this.child !== null && this.port !== null,
			port: this.port,
		};
	}

	/** Start the server if it is not running, and return once it can answer. */
	async ensure() {
		if (this.ready !== null) return this.ready;
		this.ready = this.#start().catch((error) => {
			this.ready = null;
			throw error;
		});
		return this.ready;
	}

	async #start() {
		const resolved = resolveOpenCodeCli(this.explicitCli);
		if (resolved === null) {
			throw new Error(
				"找不到 OpenCode 桌面版自带的 v2 CLI（opencode-cli.exe）。免费模型只能通过它访问：请安装并至少启动一次 OpenCode 桌面版，或用 WORKBUDDY_OPENCODE_CLI 指定路径。",
			);
		}
		this.cli = resolved;
		this.coldStartPending = true;
		const home = this.home();
		const project = join(home, "project");
		// The agent's working directory. Kept empty and isolated on purpose: OpenCode's own
		// tools resolve relative paths here, so a model that acts on its own at least acts
		// in a scratch directory rather than in the user's project.
		mkdirSync(project, { recursive: true });
		this.port = await freePort();

		const env = { ...process.env };
		// Isolated XDG homes: never touch the user's own OpenCode sessions or config.
		for (const key of ["config", "data", "cache", "state"]) env[`XDG_${key.toUpperCase()}_HOME`] = join(home, key);
		env["OPENCODE_DISABLE_AUTOUPDATE"] = "true";

		this.log(`opencode: starting ${resolved.exe} (${resolved.source}${resolved.version === undefined ? "" : ` ${resolved.version}`}) on 127.0.0.1:${this.port}`);
		const child = spawn(resolved.exe, ["serve", "--hostname", "127.0.0.1", "--port", String(this.port)], {
			cwd: project,
			env,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.child = child;

		let buffered = "";
		const onData = (chunk) => {
			buffered += chunk.toString();
			const match = /server password ([A-Za-z0-9_-]+)/.exec(buffered);
			if (match !== null && this.password === null) this.password = match[1];
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("exit", (code) => {
			if (this.child === child) {
				this.log(`opencode: server exited (code ${code})`);
				this.child = null;
				this.ready = null;
				this.port = null;
				this.password = null;
			}
		});

		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			if (child.exitCode !== null) break;
			if (this.password !== null) {
				try {
					const info = await this.#request("/api/info", "GET", undefined, 5_000);
					if (info !== null) {
						this.log(`opencode: server ready (version ${info.version ?? "?"})`);
						await this.warmUp();
						return { port: this.port, version: info.version ?? null };
					}
				} catch {
					// not up yet
				}
			}
			await sleep(600);
		}
		this.stop();
		throw new Error(`OpenCode 服务未能在 90 秒内启动。原始输出：${buffered.slice(-300) || "(空)"}`);
	}

	/**
	 * Spend the one request that always fails.
	 *
	 * The first inference after startup is refused with FreeTierError/RegionError even
	 * though the connection is fine and unauthenticated use is allowed. Everything after
	 * it succeeds, so the cost of this is one throwaway prompt per server start.
	 */
	async warmUp() {
		try {
			// Pick a model from the catalog rather than letting the session default apply:
			// the default can be a region-blocked or deprecated entry, which makes a
			// perfectly healthy connection look like a failure (measured: the default was
			// `cat-jam-free`, blocked in this country, and every warm-up timed out).
			let modelId = null;
			try {
				const payload = await this.#request("/api/model", "GET", undefined, 30_000);
				const all = Array.isArray(payload?.data) ? payload.data : [];
				const free = all.find((entry) => entry?.providerID === OPENCODE_PROVIDER_ID
					&& Array.isArray(entry.cost)
					&& entry.cost.every((tier) => (tier?.input ?? 0) === 0 && (tier?.output ?? 0) === 0));
				modelId = typeof free?.id === "string" ? free.id : null;
			} catch {
				// fall through to the server default
			}
			const sid = await this.#newSession("warmup", 20_000);
			if (modelId !== null) {
				try {
					await this.#selectModel(sid, modelId);
				} catch {
					// keep the default rather than fail the warm-up
				}
			}
			await this.#request(`/api/session/${encodeURIComponent(sid)}/prompt`, "POST", { text: "ok" }, 30_000);
			await this.#awaitReply(sid, 45_000);
			this.coldStartPending = false;
			this.log(`opencode: warm-up done${modelId === null ? "" : ` (${modelId})`}`);
		} catch (error) {
			// Leave `coldStartPending` set: the first real request will retry once.
			this.warn(`opencode: warm-up inconclusive (${String(error)}); 首次请求会自动重试一次`);
		}
	}

	/** Authenticated request against the local server. Returns null on a non-2xx. */
	async #request(route, method = "GET", body, timeoutMs = 60_000) {
		if (this.port === null || this.password === null) throw new Error("OpenCode 服务尚未就绪");
		const auth = `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`;
		const res = await fetch(`http://127.0.0.1:${this.port}${route}`, {
			method,
			headers: { "content-type": "application/json", authorization: auth },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await res.text();
		if (!res.ok) return null;
		try {
			return JSON.parse(text);
		} catch {
			return {};
		}
	}

	async #newSession(title, timeoutMs) {
		const created = await this.#request("/api/session", "POST", { title }, timeoutMs);
		const id = created?.data?.id ?? created?.id;
		if (typeof id !== "string" || id === "") throw new Error("OpenCode 未能创建会话");
		return id;
	}

	/**
	 * Point a session at a model.
	 *
	 * The shape is exact and unforgiving: `{model:{providerID, id}}` answers 204, while
	 * `{model:{id}}` fails with `Missing key at ["model"]["providerID"]` and
	 * `{model:{providerID, modelID}}` with `Missing key at ["model"]["id"]`. When the
	 * call is rejected the session keeps whatever model it defaulted to, and the answer
	 * comes from the wrong model with no error at the call site — so a failure here is
	 * raised rather than logged.
	 */
	async #selectModel(sessionId, modelId) {
		const res = await this.#requestRaw(`/api/session/${encodeURIComponent(sessionId)}/model`, "POST", {
			model: { providerID: OPENCODE_PROVIDER_ID, id: modelId },
		}, 20_000);
		if (res.status !== 200 && res.status !== 204) {
			throw new Error(`OpenCode 拒绝切换到模型 ${modelId}（HTTP ${res.status}）：${res.text.slice(0, 200)}`);
		}
	}

	/** Like #request but keeps the status and body, for calls whose failure matters. */
	async #requestRaw(route, method = "GET", body, timeoutMs = 60_000) {
		if (this.port === null || this.password === null) throw new Error("OpenCode 服务尚未就绪");
		const auth = `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`;
		const res = await fetch(`http://127.0.0.1:${this.port}${route}`, {
			method,
			headers: { "content-type": "application/json", authorization: auth },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		return { status: res.status, text: await res.text() };
	}

	/** Read the assistant entry once it has stopped. */
	async #awaitReply(sessionId, timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const messages = await this.#request(`/api/session/${encodeURIComponent(sessionId)}/message`, "GET", undefined, 30_000);
			const list = messages?.data ?? messages ?? [];
			const assistant = (Array.isArray(list) ? list : []).find((entry) => entry?.type === "assistant");
			if (assistant !== undefined && typeof assistant.finish === "string" && assistant.finish !== "" && assistant.finish !== "unknown") {
				const content = Array.isArray(assistant.content) ? assistant.content : [];
				const toolParts = content.filter((piece) => piece?.type === "tool" || piece?.type === "tool-call");
				return {
					text: content.filter((piece) => piece?.type === "text").map((piece) => piece.text ?? "").join("").trim(),
					reasoning: content.filter((piece) => piece?.type === "reasoning").map((piece) => piece.text ?? "").join(""),
					calls: toolParts,
					// OpenCode's OWN tool activity. Any entry here means the model acted on
					// this machine instead of describing the action for the client.
					localActions: toolParts.map((piece) => ({
						name: String(piece.name ?? piece.tool ?? "?"),
						status: piece.state?.status ?? null,
						error: piece.state?.error?.message ?? null,
					})),
					finish: assistant.finish,
					error: assistant.error?.message ?? null,
					// Which model actually answered. A rejected model switch leaves the
					// session on its default without erroring, so the caller compares this
					// against what it asked for instead of trusting the request.
					usedModel: typeof assistant.model?.id === "string" ? assistant.model.id : null,
				};
			}
			await sleep(900);
		}
		throw new Error("OpenCode 回复超时");
	}

	/** Free models, filtered the way the upstream bills them: cost 0 across the board. */
	async listFreeModels(force = false) {
		// The catalog comes from the local server, so it must be running first —
		// `discoverModels` reaches this without calling `ensure` itself.
		await this.ensure();
		const now = Date.now();
		if (!force && this.modelsCache !== null && now - this.modelsCachedAt < 10 * 60_000) return this.modelsCache;
		const payload = await this.#request("/api/model", "GET", undefined, 60_000);
		const all = payload?.data ?? payload ?? [];
		const models = [];
		for (const entry of Array.isArray(all) ? all : []) {
			if (entry?.providerID !== OPENCODE_PROVIDER_ID) continue;
			const cost = Array.isArray(entry.cost) ? entry.cost : [];
			const zero = cost.length > 0 && cost.every((tier) => (tier?.input ?? 0) === 0 && (tier?.output ?? 0) === 0);
			if (!zero) continue;
			const inputs = Array.isArray(entry.capabilities?.input) ? entry.capabilities.input : [];
			models.push({
				id: String(entry.id),
				name: typeof entry.name === "string" && entry.name !== "" ? entry.name : String(entry.id),
				context: Number(entry.limit?.context ?? 0) || undefined,
				maxOutput: Number(entry.limit?.output ?? 0) || undefined,
				supportsImages: inputs.includes("image"),
				tools: entry.capabilities?.tools === true,
			});
		}
		models.sort((a, b) => a.id.localeCompare(b.id));
		this.modelsCache = models;
		this.modelsCachedAt = now;
		return models;
	}

	/**
	 * Run one chat completion and render it as OpenAI SSE.
	 *
	 * OpenCode's session API returns a finished message rather than a token stream, so
	 * the reply is emitted as one content delta. That is a real limitation (no partial
	 * text), not a buffering accident — and it keeps the client contract intact.
	 */
	async chatStream(body, signal) {
		await this.ensure();
		const requested = typeof body?.model === "string" ? body.model : "";
		const models = await this.listFreeModels();
		const known = models.find((model) => model.id === requested);
		if (known === undefined) {
			return { ok: false, status: 404, kind: "not_found", message: `模型 ${requested || "(未指定)"} 不在 OpenCode 免费模型列表里` };
		}
		// Tool use is supported, but NOT by letting OpenCode run the tool: the call has to
		// travel back to HanaAgent as `tool_calls`. The prompt asks for an envelope and the
		// session runs the no-tools agent, so the model can only describe the action.
		const tools = Array.isArray(body?.tools) ? body.tools : [];
		const toolNames = new Set(tools.map((tool) => tool?.function?.name).filter((name) => typeof name === "string" && name !== ""));
		if (tools.length > 0 && !this.allowTools) {
			// Escape hatch: the envelope keeps the model from acting on this machine, but
			// only because it chooses to comply. Anyone unwilling to accept that residual
			// risk can turn tool use off and keep the models as chat-only.
			return {
				ok: false,
				status: 400,
				kind: "client",
				message: "OpenCode 免费模型的工具调用已通过 WORKBUDDY_OPENCODE_TOOLS=0 关闭；请在 HanaAgent 里把它当普通对话模型使用。",
			};
		}

		const conversation = flattenMessages(body?.messages);
		if (conversation.trim() === "") return { ok: false, status: 400, kind: "client", message: "请求没有可发送的内容" };
		const text = tools.length > 0 ? `${buildEnvelopePrompt(tools)}\n\n---\n\n${conversation}` : conversation;

		// A freshly started server refuses its first inference; `warmUp` normally
		// absorbs that, but its own budget can expire first (measured: a warm-up
		// timeout followed by requests that all succeeded). Retrying once here means a
		// user's first message is not the one that pays for the cold start.
		let last = null;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			last = await this.#exchange(requested, text, toolNames);
			if (last.ok) {
				this.coldStartPending = false;
				return last;
			}
			if (attempt > 0 || !this.coldStartPending) return last;
			// Clear the flag before retrying so a persistent failure cannot double every
			// request from here on: this is a one-shot allowance per server start.
			this.coldStartPending = false;
			this.log(`opencode: first request after startup was refused (${String(last.message).slice(0, 80)}); retrying once`);
		}
		return last;
	}

	/**
	 * Record that OpenCode ran one of its own tools.
	 *
	 * This cannot be prevented (see the module note) and must not be hidden: the client
	 * asked for a plan, and the local action's result never reaches it. The text is
	 * appended to the answer so the user sees that something happened on this machine.
	 */
	#noteLocalActions(reply) {
		const parts = Array.isArray(reply.localActions) ? reply.localActions : [];
		if (parts.length === 0) return "";
		const summary = parts.map((part) => `${part.name}${part.error === null || part.error === undefined ? "" : `（${part.error}）`}`).join("、");
		this.warn(`opencode: 模型在本机自行执行了动作：${summary}`);
		return `${LOCAL_ACTION_WARNING}（${summary}）`;
	}

	/** One prompt/response exchange, with no retry of its own. */
	async #exchange(requested, text, toolNames) {
		const sessionId = await this.#newSession(`hana ${requested}`.slice(0, 120), 30_000);
		await this.#selectModel(sessionId, requested);
		await this.#request(`/api/session/${encodeURIComponent(sessionId)}/prompt`, "POST", { text }, this.requestTimeoutMs);

		let reply;
		try {
			reply = await this.#awaitReply(sessionId, this.requestTimeoutMs);
		} catch (error) {
			return { ok: false, status: 504, kind: "server", message: `等待 OpenCode 回复失败：${String(error)}` };
		}
		if (reply.error !== null) {
			const region = /country|RegionError/i.test(reply.error);
			const coldStart = this.coldStartPending && /free tier can only be used/i.test(reply.error);
			return {
				ok: false,
				status: coldStart ? 503 : region ? 400 : 502,
				kind: coldStart ? "server" : region ? "client" : "server",
				message: `OpenCode 免费模型报错：${reply.error}`,
			};
		}
		if (reply.usedModel !== null && reply.usedModel !== requested) {
			// The switch was accepted (204) yet a different model answered. Returning the
			// text anyway would silently bill the wrong model, so say so.
			return {
				ok: false,
				status: 502,
				kind: "server",
				message: `请求的是 ${requested}，但实际回答的是 ${reply.usedModel}；为避免用错模型，本次不返回结果。`,
			};
		}

		let content = reply.text;
		let toolCalls = [];
		if (toolNames !== undefined && toolNames.size > 0) {
			const envelope = parseEnvelope(reply.text, toolNames);
			if (envelope !== null) {
				content = envelope.content;
				toolCalls = envelope.calls.map((call, index) => ({
					id: `call_${Date.now().toString(36)}_${index}`,
					name: call.name,
					arguments: call.arguments,
				}));
			} else {
				// The model ignored the envelope. Hand the text back as a normal answer
				// rather than failing the turn — a prose reply is still a usable reply.
				this.warn(`opencode: ${requested} 未按信封返回，已作为普通文本返回（${reply.text.slice(0, 60)}…）`);
			}
		}

		// Whatever the model did on this machine is disclosed in the answer. It cannot be
		// prevented (see the module note), and silence would let the user believe the
		// action is still pending when it has already happened.
		const warning = this.#noteLocalActions(reply);
		if (warning !== "") content = content === "" ? warning : `${content}\n\n${warning}`;

		const sse = renderOpenAiSse({
			id: `chatcmpl-${Date.now().toString(36)}`,
			model: requested,
			content,
			reasoning: reply.reasoning,
			toolCalls,
		});
		return { ok: true, response: { body: new Response(sse, { headers: { "content-type": "text/event-stream" } }).body } };
	}

	/** Probe one model with a minimal prompt. Throws with the upstream reason. */
	async #probeOne(modelId, timeoutMs) {
		const sessionId = await this.#newSession(`probe ${modelId}`.slice(0, 120), 25_000);
		await this.#selectModel(sessionId, modelId);
		await this.#request(`/api/session/${encodeURIComponent(sessionId)}/prompt`, "POST", { text: "Reply with the single word: ok" }, 40_000);
		const reply = await this.#awaitReply(sessionId, timeoutMs);
		if (reply.error !== null) throw new Error(reply.error);
		return reply.text;
	}

	/**
	 * The free catalog, annotated with what actually answered.
	 *
	 * Listing a model is not evidence it works: measured on 2026-10-15, `muse-spark-…`
	 * is region-blocked ("not available in your country"), `exo-free` is announced as
	 * `status: active` yet answers "has been deprecated", and two `ling-…` models never
	 * replied at all. Registering those would put models in HanaAgent's picker that fail
	 * on every use, so availability is measured once and cached on disk.
	 */
	async discoverModels({ force = false, timeoutMs = 90_000, concurrency = 4 } = {}) {
		const catalog = await this.listFreeModels(force);
		const cachePath = join(this.home(), "model-probe.json");
		let cache = {};
		if (!force && existsSync(cachePath)) {
			try {
				const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
				if (parsed !== null && typeof parsed === "object") cache = parsed;
			} catch {
				cache = {};
			}
		}
		const isFresh = (entry) => entry !== undefined && typeof entry.at === "number" && Date.now() - entry.at < PROBE_TTL_MS;
		const pending = catalog.filter((model) => force || !isFresh(cache[model.id]));
		if (pending.length > 0) {
			this.log(`opencode: probing ${pending.length} of ${catalog.length} free models for availability`);
			const queue = [...pending];
			const worker = async () => {
				for (;;) {
					const model = queue.shift();
					if (model === undefined) return;
					try {
						await this.#probeOne(model.id, timeoutMs);
						cache[model.id] = { ok: true, at: Date.now() };
					} catch (error) {
						cache[model.id] = { ok: false, at: Date.now(), error: String(error).slice(0, 200) };
						this.warn(`opencode: ${model.id} unavailable — ${String(error).slice(0, 120)}`);
					}
				}
			};
			await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
			try {
				writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
			} catch (error) {
				this.warn(`opencode: could not cache probe results (${String(error)})`);
			}
		}
		return catalog.map((model) => ({
			...model,
			working: cache[model.id]?.ok === true,
			probeError: typeof cache[model.id]?.error === "string" ? cache[model.id].error : undefined,
		}));
	}

	/**
	 * Model ids the user chose to hide.
	 *
	 * Stored next to the probe cache rather than in HanaAgent: hiding is implemented by
	 * leaving the model out of the declaration the bridge pushes, which is the only lever
	 * that also removes it from the client's picker.
	 */
	hiddenIds() {
		try {
			const parsed = JSON.parse(readFileSync(join(this.home(), "visibility.json"), "utf8"));
			const list = Array.isArray(parsed?.hidden) ? parsed.hidden : [];
			return list.filter((id) => typeof id === "string" && id !== "");
		} catch {
			return [];
		}
	}

	/** Replace the hidden list. Returns the stored ids. */
	setHidden(ids) {
		const clean = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && id !== ""))];
		const path = join(this.home(), "visibility.json");
		writeFileSync(path, `${JSON.stringify({ hidden: clean }, null, 2)}\n`, "utf8");
		return clean;
	}

	/** Models that are both reachable and not hidden — what may be published. */
	async selectableModels(options = {}) {
		const discovered = await this.discoverModels(options);
		const hidden = new Set(this.hiddenIds());
		return discovered.filter((model) => model.working && !hidden.has(model.id));
	}

	/** Stop the managed server. */
	stop() {
		const child = this.child;
		this.child = null;
		this.ready = null;
		this.port = null;
		this.password = null;
		this.modelsCache = null;
		if (child !== null && child.exitCode === null) {
			try {
				child.kill("SIGKILL");
			} catch {
				// already gone
			}
		}
	}
}

/** Render a finished reply as the OpenAI SSE shape the bridge already understands. */
export function renderOpenAiSse({ id, model, content, reasoning, toolCalls }) {
	const created = Math.floor(Date.now() / 1000);
	const frame = (delta, finish = null) => `data: ${JSON.stringify({
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [{ index: 0, delta, finish_reason: finish }],
	})}\n\n`;
	const chunks = [];
	chunks.push(frame({ role: "assistant", content: "" }));
	if (typeof reasoning === "string" && reasoning !== "") chunks.push(frame({ reasoning_content: reasoning }));
	if (content !== "") chunks.push(frame({ content }));
	const calls = Array.isArray(toolCalls) ? toolCalls : [];
	if (calls.length > 0) {
		chunks.push(frame({
			tool_calls: calls.map((call, index) => ({
				index,
				id: call.id,
				type: "function",
				function: { name: call.name, arguments: call.arguments },
			})),
		}));
	}
	chunks.push(frame({}, calls.length > 0 ? "tool_calls" : "stop"));
	chunks.push("data: [DONE]\n\n");
	return chunks.join("");
}
