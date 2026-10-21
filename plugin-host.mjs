/**
 * A host for `@magpie-community/opencode-*-auth` provider plugins.
 *
 * The provider adapters are not written here. They are npm packages — Qoder, WorkBuddy,
 * OpenCode Zen Free, Grok, Cursor, Trae, Zed, Cline, Devin, Kiro, MiniMax, MiMo, ZCode,
 * Factory — published by the magpie project (github.com/yetone/magpie, MIT) and its
 * community plugin repo. Each is a plain ES module with no dependencies, and each speaks
 * one vendor's protocol: sign-in, model list, and one inference request.
 *
 * What they are *not* is self-contained: they only define hooks, and something has to call
 * them. In magpie that something is a Go binary that embeds a JS runtime. This module is
 * the same host, written for the one thing this App is: a bridge into HanaAgent. So the
 * binary is not needed, and neither is magpie's notion of adapters, agents or a second
 * gateway — only the four hooks below are.
 *
 *   { config(cfg), auth: { methods, loader, refresh, usage }, provider: { models } }
 *
 * The contract was read off magpie's `internal/plugin/host.js`, and the parts that matter
 * here are: a loader receives `getAuth` and may return `{ baseURL, apiKey, fetch }`; the
 * `fetch` it returns must answer a `Response`, with the body passed through untouched so
 * streaming, tool calls and reasoning survive; `provider.models` receives the models it
 * was given and returns the vendor's list. Where magpie invents a convention the plugins
 * rely on — `Symbol.for("magpie.fellBack")`, `error.signIn` — it is honoured, because a
 * plugin that uses it would otherwise be misread.
 *
 * See THIRD_PARTY_NOTICES.md for the provenance of these packages and the licence that
 * travels with them.
 *
 * @module hanako-plugin-host
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where a plugin's own credentials are kept, under the bridge's data directory. */
const AUTH_FILE = "plugin-auth.json";

/**
 * The provider ids this App publishes, and the package that serves each.
 *
 * `id` is what HanaAgent sees (and what a model id is prefixed with); `package` is the npm
 * package. Keeping the list here rather than discovering it on disk means a missing
 * install is a clear error instead of a provider that silently has no models.
 */
export const PLUGIN_PROVIDERS = [
	{ id: "qoder", package: "@magpie-community/opencode-qoder-auth", export: "QoderAuthPlugin", label: "Qoder", site: "international" },
	{ id: "qoder-cn", package: "@magpie-community/opencode-qoder-auth", export: "QoderCNAuthPlugin", label: "Qoder CN", site: "china" },
	{ id: "workbuddy", package: "@magpie-community/opencode-workbuddy-auth", export: "WorkBuddyAuthPlugin", label: "WorkBuddy" },
	{ id: "workbuddy-ai", package: "@magpie-community/opencode-workbuddy-auth", export: "WorkBuddyAIAuthPlugin", label: "WorkBuddy AI" },
	{ id: "zen-free", package: "@magpie-community/opencode-zen-free-auth", export: "ZenFreePlugin", label: "OpenCode Zen Free" },
];

/**
 * Read a plugin package's manifest to find what to import.
 *
 * The export name is taken from `PLUGIN_PROVIDERS` and verified against the module, so a
 * package that renames an export is a clear startup error rather than a provider that
 * quietly serves nothing.
 */
export function pluginEntry(spec, resolveFrom) {
	const root = join(resolveFrom, "node_modules", spec.package);
	const manifestPath = join(root, "package.json");
	if (!existsSync(manifestPath)) {
		return { available: false, reason: `未安装 ${spec.package}（在 plugins/ 目录里 npm install）` };
	}
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		return { available: false, reason: `${spec.package}/package.json 读不了：${String(error)}` };
	}
	const entry = typeof manifest.exports === "string"
		? manifest.exports
		: manifest.exports?.["."] ?? manifest.exports?.["./server"] ?? manifest.main;
	if (typeof entry !== "string") return { available: false, reason: `${spec.package} 没有入口文件` };
	return {
		available: true,
		version: manifest.version,
		path: join(root, entry),
		// The plugin declares no dependencies of its own; a non-empty map would mean the
		// package needs something the bundle does not carry.
		dependencies: Object.keys(manifest.dependencies ?? {}),
	};
}

/** Stable key for one account of one provider. */
function accountKey(providerId, uid) {
	const who = typeof uid === "string" && uid !== "" ? uid : "default";
	return `${providerId}:${who}`;
}

/**
 * Keep plugin credentials out of reach while still being able to read them.
 *
 * The plugins own their credential format, and the host is told to hand it back through
 * `getAuth` — so this file is a cache of whatever they returned, keyed by provider and
 * account. It is written with `0600` and never logged; the token itself is never returned
 * by any diagnostic method here.
 */
export class PluginAuthStore {
	constructor(dataDir) {
		this.dir = dataDir;
		this.path = join(dataDir, AUTH_FILE);
		this.cache = undefined;
	}

	#read() {
		if (this.cache !== undefined) return this.cache;
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8"));
			this.cache = parsed !== null && typeof parsed === "object" ? parsed : {};
		} catch {
			this.cache = {};
		}
		return this.cache;
	}

	/** Every stored credential, as `{ [providerId]: { [accountKey]: auth } }`. */
	all() {
		return this.#read();
	}

	/** One credential, or undefined. */
	get(providerId, uid) {
		const byProvider = this.#read()[providerId];
		if (byProvider === undefined || byProvider === null) return undefined;
		return byProvider[accountKey(providerId, uid)] ?? Object.values(byProvider)[0];
	}

	/** The accounts stored for a provider. */
	accounts(providerId) {
		const byProvider = this.#read()[providerId];
		return byProvider !== undefined && byProvider !== null && typeof byProvider === "object" ? Object.keys(byProvider) : [];
	}

	/** Store one credential, replacing any previous one for the same account. */
	set(providerId, uid, auth) {
		const data = this.#read();
		const id = accountKey(providerId, uid);
		data[providerId] = { ...(data[providerId] ?? {}), [id]: auth };
		this.#write(data);
		return auth;
	}

	/**
	 * Write the credential file.
	 *
	 * `mode: 0o600` is asked for but is only effective on POSIX: on Windows `mode` does
	 * not carry the permission bits, and a file created either way stats as `0666`. The
	 * protection there is the per-user profile directory the file lives in, not the mode —
	 * so this is stated rather than dressed up as stricter than it is. What the mode does
	 * buy is that a POSIX install cannot accidentally leave the file world-readable.
	 */
	#write(data) {
		mkdirSync(this.dir, { recursive: true });
		const temp = `${this.path}.tmp-${process.pid}`;
		writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temp, this.path);
	}

	/** Remove one account. */
	remove(providerId, uid) {
		const data = this.#read();
		const id = accountKey(providerId, uid);
		if (data[providerId] === undefined) return false;
		delete data[providerId][id];
		if (Object.keys(data[providerId]).length === 0) delete data[providerId];
		this.#write(data);
		return true;
	}

	/**
	 * A non-secret description of one credential, for the panel.
	 *
	 * Deliberately reports *whether* a field exists, never its value: this object is
	 * rendered on a page and logged.
	 */
	describe(providerId, uid) {
		const auth = this.get(providerId, uid);
		if (auth === undefined) return { signedIn: false };
		const expires = Number(auth?.expires ?? 0);
		return {
			signedIn: true,
			// The plugins name the account differently (uid, email, accountId); show whichever
			// is present rather than forcing one shape on them.
			account: String(auth?.uid ?? auth?.email ?? auth?.accountId ?? ""),
			email: typeof auth?.email === "string" ? auth.email : undefined,
			type: typeof auth?.type === "string" ? auth.type : undefined,
			expiresAt: expires > 0 ? new Date(expires).toISOString() : undefined,
			expired: expires > 0 ? expires < Date.now() : false,
		};
	}
}

/**
 * One loaded provider plugin, driven through its hooks.
 *
 * Mirrors what magpie's host does around a plugin, minus everything specific to magpie:
 * no routing, no quota accounting, no agent adapters, no `plugin://` base. Sign-in,
 * refresh, model listing and one request are all this App needs.
 */
export class ProviderPlugin {
	constructor({ spec, module, store, log, warn }) {
		this.spec = spec;
		this.id = spec.id;
		this.label = spec.label;
		this.module = module;
		this.store = store;
		this.log = log ?? (() => {});
		this.warn = warn ?? (() => {});
		this.hooks = undefined;
		this.loaderCache = undefined;
	}

	/** Instantiate the plugin's hooks. OpenCode passes a context; these plugins ignore it. */
	async ensureHooks() {
		if (this.hooks !== undefined) return this.hooks;
		const factory = this.module[this.spec.export];
		if (typeof factory !== "function") {
			throw new Error(`${this.spec.package} 没有导出 ${this.spec.export}`);
		}
		// A plugin is `(context) => hooks` in OpenCode; magpie also accepts a bare object.
		// Both shapes are handled because a plugin may use either.
		const produced = typeof factory === "function" ? await factory({ client: {} }) : factory;
		this.hooks = produced ?? {};
		return this.hooks;
	}

	/** The `getAuth` the plugin calls: always the current stored credential for this provider. */
	#getAuth() {
		return async () => this.store.get(this.id, this.accountUid());
	}

	/** Which stored account this instance serves; the first one, until multi-account lands. */
	accountUid() {
		const accounts = this.store.accounts(this.id);
		if (accounts.length === 0) return undefined;
		// Keys are `provider:uid`; the uid is what the plugin wants back.
		return accounts[0].slice(this.id.length + 1);
	}

	/** Whether a sign-in exists at all. */
	signedIn() {
		return this.store.get(this.id, this.accountUid()) !== undefined;
	}

	/** The sign-in methods this provider offers, described for a caller. */
	async methods() {
		const hooks = await this.ensureHooks();
		return (hooks.auth?.methods ?? []).map((method, index) => ({
			index,
			type: method.type,
			label: method.label,
			// A method with `prompts` wants input first (a PAT, an instance name); one
			// without starts a browser flow by itself.
			prompts: Array.isArray(method.prompts)
				? method.prompts.map((prompt) => ({
						key: prompt.key,
						type: prompt.type,
						message: prompt.message,
						placeholder: prompt.placeholder,
					}))
				: [],
		}));
	}

	/**
	 * Run one sign-in to completion.
	 *
	 * `method.authorize(inputs)` answers either a finished credential (`{type:"success"}`,
	 * a PAT exchange) or a browser hand-off: a URL, instructions, and a `callback()` that
	 * polls the vendor until the user authorizes. Both are handled; `onUrl` is called with
	 * the URL so the caller can show it, and the returned credential is stored.
	 */
	async signIn(index, inputs, { onUrl, signal } = {}) {
		const hooks = await this.ensureHooks();
		const method = (hooks.auth?.methods ?? [])[index];
		if (method === undefined) throw new Error(`${this.label} 没有第 ${index + 1} 种登录方式`);
		const started = await method.authorize(inputs ?? {});
		if (started?.type === "success") {
			return this.#acceptSignIn(started);
		}
		if (typeof started?.url !== "string" || typeof started?.callback !== "function") {
			throw new Error(`${this.label} 的登录没有返回可用的地址或回调`);
		}
		if (typeof onUrl === "function") onUrl(started.url, started.instructions);
		this.log(`plugin ${this.id}: 等待浏览器里完成登录授权`);
		// The callback polls the vendor; it can outlive an HTTP request, so it is awaited
		// here and the caller decides how long to wait.
		const credential = await started.callback({ signal });
		return this.#acceptSignIn(credential);
	}

	/**
	 * Normalise what a plugin calls a successful sign-in, then store it.
	 *
	 * Two shapes are in use and both are valid: an OAuth result carrying `access` (and a
	 * refresh token, an expiry, a uid), and an API-key result carrying `key`. The check is
	 * sequential rather than exclusive — an earlier version tested `access` first and
	 * rejected every API-key sign-in with "no credential returned".
	 */
	#acceptSignIn(result) {
		if (result?.type !== "success") {
			throw new Error(`${this.label}：${result?.error ?? "登录没有返回凭据"}`);
		}
		if (result.key !== undefined && result.access === undefined) {
			// A plain API-key method: the credential is the key itself.
			this.store.set(this.id, "", { type: "api", key: String(result.key) });
			this.loaderCache = undefined;
			this.log(`plugin ${this.id}: 已保存 API key`);
			return { ok: true, type: "api" };
		}
		if (result.access === undefined) {
			throw new Error(`${this.label}：登录既不返回 access 也不返回 key`);
		}
		const { type, ...auth } = result;
		this.store.set(this.id, auth.uid ?? "", { ...auth, type: "oauth" });
		this.loaderCache = undefined;
		this.log(`plugin ${this.id}: 登录成功${auth.uid === undefined ? "" : ` (${String(auth.uid).slice(0, 8)}…)`}`);
		return { ok: true, type: "oauth" };
	}

	/** Sign out: drop the stored credential. */
	signOut() {
		this.store.remove(this.id, this.accountUid());
		this.loaderCache = undefined;
		return { ok: true };
	}

	/**
	 * The `{ baseURL, apiKey, fetch }` the plugin's loader produced.
	 *
	 * Cached per credential, as magpie caches it per sign-in: building it again would
	 * re-run the loader, which for these plugins means re-running whatever setup it does
	 * per process.
	 */
	async loader() {
		if (this.loaderCache !== undefined) return this.loaderCache;
		const hooks = await this.ensureHooks();
		const auth = this.store.get(this.id, this.accountUid());
		if (auth === undefined) throw new Error(`${this.label} 还没有登录`);
		const produced = hooks.auth?.loader === undefined
			? {}
			: await hooks.auth.loader(this.#getAuth(), { id: this.id, name: this.label });
		if (typeof produced?.fetch !== "function" || typeof produced?.baseURL !== "string") {
			throw new Error(`${this.label} 的 loader 没有返回可用的 fetch/baseURL`);
		}
		this.loaderCache = produced;
		return produced;
	}

	/**
	 * Refresh the credential ahead of expiry, when the plugin asks for it.
	 *
	 * `auth.refresh` is a magpie extension; a plugin without it leaves renewal to the
	 * vendor-facing fetch, which is what OpenCode does.
	 */
	async refreshIfDue() {
		const hooks = await this.ensureHooks();
		if (typeof hooks.auth?.refresh !== "function") return { refreshed: false, reason: "plugin has no refresh hook" };
		const auth = this.store.get(this.id, this.accountUid());
		if (auth === undefined) return { refreshed: false, reason: "not signed in" };
		const lead = Number(hooks.auth.refreshLead ?? 0);
		const expires = Number(auth.expires ?? 0);
		if (expires <= 0 || expires - lead > Date.now()) return { refreshed: false, reason: "not due" };
		try {
			const next = await hooks.auth.refresh(auth, { id: this.id, name: this.label });
			if (next !== undefined && next !== null) {
				this.store.set(this.id, next.uid ?? auth.uid ?? "", { ...auth, ...next, type: "oauth" });
				this.loaderCache = undefined;
				return { refreshed: true };
			}
			return { refreshed: false, reason: "refresh returned nothing" };
		} catch (error) {
			const expired = error?.signIn === "expired";
			this.warn(`plugin ${this.id}: 刷新失败${expired ? "（需要重新登录）" : ""}：${String(error?.message ?? error)}`);
			return { refreshed: false, reason: String(error?.message ?? error), needsSignIn: expired };
		}
	}

	/**
	 * The vendor's model list, in this App's own shape.
	 *
	 * The plugin answers a map keyed by model id. A plugin that could not reach its vendor
	 * hands back what it was given and marks it, or marks its own list; `fellBack` reports
	 * that, because otherwise the short built-in list looks like the account's real one.
	 */
	async listModels() {
		const hooks = await this.ensureHooks();
		if (typeof hooks.provider?.models !== "function") return { models: [], fellBack: false };
		const auth = this.store.get(this.id, this.accountUid());
		const given = { models: {} };
		let next;
		try {
			next = await hooks.provider.models(given.models, { auth });
		} catch (error) {
			const signIn = error?.signIn;
			return {
				models: [],
				fellBack: true,
				listError: String(error?.message ?? error),
				needsSignIn: signIn === "expired",
			};
		}
		const fellBack = next === given.models || next?.[Symbol.for("magpie.fellBack")] === true;
		const models = [];
		for (const [key, model] of Object.entries(next ?? {})) {
			if (model === null || typeof model !== "object") continue;
			models.push(toModel(key, model, this.id));
		}
		models.sort((a, b) => a.id.localeCompare(b.id));
		return { models, fellBack, listError: fellBack ? "插件没能拿到上游的模型列表，这是它自己的兜底清单" : undefined };
	}

	/**
	 * One chat completion, passed through.
	 *
	 * The request body arrives in OpenAI's shape and the plugin is responsible for
	 * speaking its vendor's protocol; the response body is returned **as the plugin
	 * produced it** — an SSE stream or a JSON object — because rewriting it here would
	 * drop the streaming, tool calls and reasoning the plugin went to the trouble of
	 * translating. Only the request is normalised.
	 */
	async chat({ body, signal, sessionId }) {
		const hooks = await this.ensureHooks();
		const loaded = await this.loader();
		const headers = { "content-type": "application/json" };
		// A plugin may add per-request headers from its own hook (magpie's `chat.headers`),
		// which is how a session id reaches the vendor for its cache.
		if (typeof hooks["chat.headers"] === "function") {
			try {
				const output = { headers: {} };
				await hooks["chat.headers"]({ model: body?.model, sessionID: sessionId }, output);
				for (const [key, value] of Object.entries(output.headers ?? {})) {
					if (typeof value === "string") headers[key] = value;
				}
			} catch (error) {
				this.warn(`plugin ${this.id}: chat.headers 失败（忽略）：${String(error?.message ?? error)}`);
			}
		}
		const response = await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
		});
		return { response, loaded };
	}

	/**
	 * Whether one model actually answers, measured with a real request.
	 *
	 * A listed model is not a working model. Measured on 2026-10-18 against zen-free's nine
	 * entries: one was refused with `RegionError`, one failed upstream, and one never
	 * answered — and every one of them was listed as available. Declaring those puts models
	 * in HanaAgent's picker that fail on every use, which is exactly the failure this App
	 * shipped once already.
	 *
	 * The probe is one minimal completion. It costs whatever the vendor charges for a few
	 * tokens, which is why the answer is cached on disk and why the caller decides when to
	 * pay for it.
	 */
	async probeModel(modelId, { timeoutMs = 45_000 } = {}) {
		try {
			const { response } = await this.chat({
				body: {
					model: modelId,
					messages: [{ role: "user", content: "Reply with the single word: ok" }],
					stream: false,
					max_tokens: 8,
				},
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				return { ok: false, error: `HTTP ${response.status}${detail === "" ? "" : `: ${detail.slice(0, 160)}`}` };
			}
			// A model can answer 200 with an error object inside the body; reading the text
			// keeps that visible instead of counting it as a success.
			const text = await response.text();
			if (/"type"\s*:\s*"error"|"error"\s*:\s*\{/.test(text)) {
				return { ok: false, error: text.slice(0, 160) };
			}
			return { ok: true, at: Date.now() };
		} catch (error) {
			return { ok: false, error: String(error?.message ?? error).slice(0, 160) };
		}
	}

	/** The probe results this App has cached, keyed by model id. */
	probeCache() {
		const path = join(dirname(this.store.path), "probe", `${this.id}.json`);
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			return parsed !== null && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	}

	/** Replace the probe cache. */
	setProbeCache(cache) {
		const path = join(dirname(this.store.path), "probe", `${this.id}.json`);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
		return cache;
	}

	/** A short, non-secret description for the panel. */
	describe() {
		return {
			id: this.id,
			label: this.label,
			package: this.spec.package,
			...this.store.describe(this.id, this.accountUid()),
		};
	}

	/**
	 * Model ids the user chose to hide.
	 *
	 * Hiding is implemented by leaving the model out of the declaration pushed to
	 * HanaAgent, which is the only lever that also removes it from the client's picker;
	 * a purely local filter would leave the model selectable and failing.
	 */
	hiddenIds() {
		const path = join(dirname(this.store.path), "visibility", `${this.id}.json`);
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const list = Array.isArray(parsed?.hidden) ? parsed.hidden : [];
			return list.filter((id) => typeof id === "string" && id !== "");
		} catch {
			return [];
		}
	}

	/** Replace the hidden list. Returns the stored ids. */
	setHidden(ids) {
		const clean = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && id !== ""))];
		const path = join(dirname(this.store.path), "visibility", `${this.id}.json`);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ hidden: clean }, null, 2)}\n`, "utf8");
		return clean;
	}
}

/**
 * Convert one model of a plugin's list into the shape the rest of this App uses.
 *
 * The plugin's own record is the source of truth for capabilities — `limit.context`,
 * `capabilities.toolcall`, `modalities.input`, `variants` keyed by effort, `cost` — and the
 * fields are read defensively because a plugin is free to leave any of them out.
 */
export function toModel(id, model, providerId) {
	const context = Number(model?.limit?.context ?? 0) || undefined;
	const output = Number(model?.limit?.output ?? 0) || undefined;
	const inputs = Array.isArray(model?.modalities?.input)
		? model.modalities.input
		: Array.isArray(model?.capabilities?.input?.text)
			? ["text"]
			: [];
	const vision = inputs.includes("image") || model?.capabilities?.attachment === true || model?.attachment === true;
	const variants = model?.variants !== undefined && model?.variants !== null && typeof model.variants === "object"
		? Object.keys(model.variants)
		: [];
	const reasoning = model?.capabilities?.reasoning === true || model?.reasoning === true || variants.length > 0;
	const tools = model?.tool_call === true || model?.capabilities?.toolcall === true;
	return {
		id: String(id),
		name: typeof model?.name === "string" && model.name !== "" ? model.name : String(id),
		context,
		maxOutput: output,
		vision,
		reasoning,
		tools,
		efforts: variants,
		providerId,
		// A model the plugin marks free costs nothing on this account; the panel shows it.
		free: model?.free === true,
	};
}

/** A short hash, so a session id is stable for one conversation without being the id itself. */
export function sessionIdFor(text) {
	return createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);
}
