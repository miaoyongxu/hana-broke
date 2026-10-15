/**
 * The bridge's own HTTP surface, used by the HanaAgent settings page.
 *
 * Everything here is deliberately separate from the OpenAI-compatible surface
 * under `/<variant>/v1`: that one is a model endpoint, this one is an operator
 * console (account, credits, model roster, visibility, probes). It shares the
 * loopback bind and the optional bearer of the main server, so setting
 * `--token` protects both.
 *
 * Two rules shape the endpoints:
 *
 * - **Credits cost a real request.** WorkBuddy answers the balance from a
 *   billing endpoint, so `GET /admin/status` never touches it; only
 *   `GET /admin/credits` does, and the UI labels it as such.
 * - **Probes cost real requests too.** They are opt-in per call
 *   (`confirm: true`), never part of a status read.
 *
 * @module hana-broke/admin-api
 */

import { readFileSync } from "node:fs";

import { RATE_SEPARATOR } from "./hana-providers.mjs";

/** JSON response helper (mirrors the bridge's own, kept local to stay standalone). */
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

/** Read a JSON request body with a small cap (these are operator calls). */
function readJsonBody(req, limit = 1_000_000) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(Object.assign(new Error("request body too large"), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8").trim();
			if (text === "") {
				resolve({});
				return;
			}
			try {
				const parsed = JSON.parse(text);
				resolve(parsed !== null && typeof parsed === "object" ? parsed : {});
			} catch (error) {
				// A malformed body is the caller's mistake, so 400 — not 500.
				reject(Object.assign(new Error(`invalid JSON body: ${String(error)}`), { status: 400 }));
			}
		});
		req.on("error", reject);
	});
}

/** A short, non-secret description of a credential. */
function describeCredential(credential) {
	return {
		uid: credential.uid ?? "",
		domain: credential.domain ?? "",
		...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
		...(credential.enterpriseId === undefined || credential.enterpriseId === "" ? {} : { enterpriseId: credential.enterpriseId }),
		expiresAt: new Date(credential.expiresAtMs).toISOString(),
		...(credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAt: new Date(credential.refreshExpiresAtMs).toISOString() }),
		source: credential.source ?? "unknown",
	};
}

/**
 * Build the admin request handler.
 *
 * @param {object} deps
 * @param {object} deps.chunk loaded upstream module
 * @param {object[]} deps.runtimes per-variant runtimes from the bridge
 * @param {(runtime: object) => object} deps.storeFor credential store honouring the active profile
 * @param {(runtime: object) => object[]} deps.listProfiles profiles of one variant
 * @param {(runtime: object, id: string) => Promise<object>} deps.describeProfile read one profile back (never refreshes)
 * @param {(runtime: object, name: string, sourcePath?: string) => Promise<object>} deps.captureProfile snapshot the live desktop login
 * @param {(runtime: object) => string|undefined} deps.liveAuthPath the desktop app's own auth file
 * @param {(runtime: object, id?: string) => string|undefined} deps.activateProfile select a profile
 * @param {(runtime: object, id: string) => boolean} deps.deleteProfile remove a profile
 * @param {() => Promise<object[]>} deps.syncNow re-run catalog sync + registration
 * @param {(runtime: object, force: boolean) => Promise<{models: object[], error?: string}>} deps.catalogFor
 * @param {() => Map<string, object>} deps.quotaBlocks live quota short-circuit state
 * @param {(runtime: object, info: object) => string} deps.displaySuffix picker suffix for one model
 * @param {object} deps.options bridge options (port, host, dataDir, logFile)
 * @param {string} deps.pluginLib plugin lib path, for the status header
 * @param {(req: object) => boolean} deps.bearerOk the bridge's own bearer check
 * @param {() => void} deps.shutdown stop the bridge gracefully (settings page "stop" button)
 * @param {(message: string) => void} deps.log
 * @param {(message: string) => void} deps.warn
 * @returns {(req: object, res: object, url: URL) => Promise<boolean>} true when handled
 */
export function createAdminApi(deps) {
	const { chunk, runtimes, storeFor, syncNow, catalogFor, displaySuffix, options, pluginLib, bearerOk, log, warn, opencode } = deps;

	/** Model list for one variant, with the picker suffix and hidden flag. */
	async function modelRows(runtime, force) {
		const catalog = await catalogFor(runtime, force);
		const store = storeFor(runtime);
		let accountKey;
		try {
			accountKey = deps.accountKeyOf(await store.resolve());
		} catch {
			accountKey = undefined;
		}
		const hidden = new Set(accountKey === undefined ? [] : deps.hiddenModelsFor(runtime, accountKey));
		return {
			error: catalog.error,
			models: catalog.models.map((info) => {
				const live = chunk.modelWithCurrentPromotion(info);
				const suffix = displaySuffix(live) ?? "";
				const name = typeof info.name === "string" && info.name !== "" ? info.name : info.id;
				return {
					id: info.id,
					name,
					suffix,
					// The picker's own spelling, so the page never has to know the
					// separator HanaAgent uses.
					displayName: suffix === "" ? name : `${name}${RATE_SEPARATOR}${suffix}`,
					rate: chunk.normalizeCredits(live?.billing?.credits) ?? null,
					badges: live?.billing?.badges ?? [],
					free: live?.billing?.free === true,
					contextWindow: info.contextWindow ?? null,
					maxTokens: info.maxTokens ?? null,
					supportsImages: info.supportsImages === true,
					declaredEfforts: info.supportedEfforts ?? [],
					defaultEffort: info.defaultEffort ?? null,
					hidden: hidden.has(info.id),
				};
			}),
		};
	}

	async function variantStatus(runtime) {
		const store = storeFor(runtime);
		const status = await store.status();
		const blocked = [];
		for (const [key, block] of deps.quotaBlocks()) {
			const [variantId, model] = key.split("\u0000");
			if (variantId !== runtime.id) continue;
			blocked.push({ model, resetsAt: block.resetLabel });
		}
		let account;
		try {
			account = describeCredential(await store.resolve());
		} catch (error) {
			account = { error: String(error) };
		}
		return {
			id: runtime.id,
			displayName: runtime.displayName,
			route: runtime.route,
			providerId: runtime.providerId,
			baseUrl: runtime.baseUrl,
			state: status.state,
			...(status.reason === undefined ? {} : { reason: status.reason }),
			account,
			activeProfile: runtime.activeProfileId ?? null,
			modelCount: runtime.catalog.models.length,
			catalogError: runtime.catalog.error ?? null,
			...(runtime.lastError === undefined ? {} : { lastError: runtime.lastError }),
			...(runtime.lastSuccessAt === undefined ? {} : { lastSuccessAt: runtime.lastSuccessAt }),
			...(blocked.length === 0 ? {} : { quotaBlocked: blocked }),
		};
	}

	/** Fetch the balance for one variant; this is a real billing request. */
	async function creditsFor(runtime) {
		const store = storeFor(runtime);
		try {
			const credential = await store.resolve();
			const credits = await runtime.client.fetchCredits(credential);
			return { id: runtime.id, ok: true, credits };
		} catch (error) {
			return { id: runtime.id, ok: false, error: String(error) };
		}
	}

	function runtimeOf(id) {
		const runtime = runtimes.find((candidate) => candidate.id === id);
		if (runtime === undefined) throw Object.assign(new Error(`unknown variant: ${String(id)}`), { status: 404 });
		return runtime;
	}

	return async function handleAdmin(req, res, url) {
		if (!url.pathname.startsWith("/admin")) return false;
		if (!bearerOk(req)) {
			sendJson(res, 401, { error: "missing or invalid Authorization bearer" });
			return true;
		}
		const path = url.pathname.replace(/\/+$/, "") || "/admin";
		const method = req.method ?? "GET";

		try {
			if (path === "/admin/status" && method === "GET") {
				const variants = [];
				for (const runtime of runtimes) variants.push(await variantStatus(runtime));
				sendJson(res, 200, {
					ok: true,
					bridge: {
						port: options.port,
						host: options.host,
						dataDir: options.dataDir,
						pluginLib,
						...(options.logFile === "" ? {} : { logFile: options.logFile }),
						pid: process.pid,
					},
					variants,
					// The second upstream. `enabled: false` when it is switched off, so the
					// panel can tell "not configured" apart from "not working".
					opencode: opencode === undefined || opencode === null
						? { enabled: false }
						: { enabled: true, ...opencode.describe(), listed: (opencode.modelsCache ?? []).length },
				});
				return true;
			}

			/**
			 * OpenCode free models: which are reachable, and a refresh that re-measures.
			 *
			 * Availability is cached, so the plain GET is cheap; `?refresh=1` re-probes
			 * every model, which is what the panel's refresh button uses.
			 */
			if (path === "/admin/opencode" && method === "GET") {
				if (opencode === undefined || opencode === null) {
					sendJson(res, 200, { ok: true, enabled: false });
					return true;
				}
				const force = url.searchParams.get("refresh") === "1";
				try {
					const discovered = await opencode.discoverModels({ force });
					const hidden = new Set(opencode.hiddenIds());
					// An explicit re-probe must also re-declare. Probing alone only refreshes
					// this page: the provider HanaAgent holds keeps the old roster until the
					// declaration is pushed again, which is what `syncNow` does.
					let sync = null;
					if (force) {
						try {
							const results = await syncNow();
							sync = results.map((entry) => ({ id: entry.id, models: entry.modelCount ?? null, skipped: entry.skipped ?? null, error: entry.error ?? null }));
						} catch (error) {
							sync = [{ id: "opencode", error: String(error) }];
						}
					}
					sendJson(res, 200, {
						ok: true,
						enabled: true,
						...opencode.describe(),
						baseUrl: `http://${options.host}:${options.port}/opencode/v1`,
						modelCount: discovered.filter((model) => model.working && !hidden.has(model.id)).length,
						workingCount: discovered.filter((model) => model.working).length,
						hiddenCount: hidden.size,
						sync,
						models: discovered.map((model) => ({
							id: model.id,
							name: model.name,
							working: model.working,
							hidden: hidden.has(model.id),
							error: model.probeError ?? null,
							context: model.context ?? null,
							maxOutput: model.maxOutput ?? null,
						})),
					});
				} catch (error) {
					sendJson(res, 200, { ok: false, enabled: true, ...opencode.describe(), error: String(error) });
				}
				return true;
			}

			/**
			 * Choose which OpenCode models HanaAgent offers.
			 *
			 * Like the WorkBuddy variant, hiding works by leaving the model out of the
			 * declaration that gets pushed, so it disappears from the client's picker
			 * rather than being merely unlisted here. The re-sync runs immediately.
			 */
			if (path === "/admin/opencode/visibility" && method === "PUT") {
				if (opencode === undefined || opencode === null) {
					sendJson(res, 200, { ok: false, enabled: false, error: "OpenCode 上游未启用" });
					return true;
				}
				let body;
				try {
					body = await readJsonBody(req);
				} catch {
					sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
					return true;
				}
				try {
					const stored = opencode.setHidden(body?.hidden);
					const results = await syncNow();
					sendJson(res, 200, {
						ok: true,
						hidden: stored,
						sync: results.map((entry) => ({ id: entry.id, models: entry.modelCount ?? null, skipped: entry.skipped ?? null, error: entry.error ?? null })),
					});
				} catch (error) {
					sendJson(res, 200, { ok: false, error: String(error) });
				}
				return true;
			}

			if (path === "/admin/credits" && method === "GET") {
				const id = url.searchParams.get("variant");
				const targets = id === null ? runtimes : [runtimeOf(id)];
				const results = [];
				for (const runtime of targets) results.push(await creditsFor(runtime));
				sendJson(res, 200, { ok: true, note: "每次查询都是一次真实的计费请求", credits: results });
				return true;
			}

			if (path === "/admin/models" && method === "GET") {
				const id = url.searchParams.get("variant");
				const force = url.searchParams.get("refresh") === "1";
				const targets = id === null ? runtimes : [runtimeOf(id)];
				const result = [];
				for (const runtime of targets) result.push({ id: runtime.id, ...(await modelRows(runtime, force)) });
				sendJson(res, 200, { ok: true, variants: result });
				return true;
			}

			if (path === "/admin/refresh" && method === "POST") {
				const results = await syncNow();
				sendJson(res, 200, { ok: true, results: results.map((entry) => ({ id: entry.id, models: entry.modelCount ?? null, skipped: entry.skipped ?? null, error: entry.error ?? null })) });
				return true;
			}

			if (path === "/admin/visibility" && method === "GET") {
				const runtime = runtimeOf(url.searchParams.get("variant") ?? "");
				const store = storeFor(runtime);
				let accountKey;
				try {
					accountKey = deps.accountKeyOf(await store.resolve());
				} catch (error) {
					sendJson(res, 200, { ok: false, error: String(error), hidden: [] });
					return true;
				}
				sendJson(res, 200, { ok: true, variant: runtime.id, accountKey: accountKey ?? null, hidden: accountKey === undefined ? [] : deps.hiddenModelsFor(runtime, accountKey) });
				return true;
			}

			if (path === "/admin/visibility" && method === "PUT") {
				const body = await readJsonBody(req);
				const runtime = runtimeOf(body.variant ?? "");
				const store = storeFor(runtime);
				const accountKey = deps.accountKeyOf(await store.resolve());
				if (accountKey === undefined) {
					sendJson(res, 400, { ok: false, error: "该账号没有 uid，无法按账号保存模型显隐" });
					return true;
				}
				const hidden = deps.setHiddenModelsFor(runtime, accountKey, body.hidden ?? []);
				// The declaration changes, so push it right away.
				const results = await syncNow();
				sendJson(res, 200, { ok: true, hidden, sync: results.map((entry) => ({ id: entry.id, models: entry.modelCount ?? null, skipped: entry.skipped ?? null })) });
				return true;
			}

			if (path === "/admin/profiles" && method === "GET") {
				const variants = [];
				for (const runtime of runtimes) {
					const profiles = [];
					// Read each profile back so a broken one is visible before it is
					// activated, instead of taking down a working account silently.
					for (const profile of deps.listProfiles(runtime)) {
						profiles.push({ ...profile, ...(await deps.describeProfile(runtime, profile.id)) });
					}
					variants.push({
						id: runtime.id,
						displayName: runtime.displayName,
						activeProfile: runtime.activeProfileId ?? null,
						liveAuthPath: deps.liveAuthPath(runtime) ?? null,
						profiles,
					});
				}
				sendJson(res, 200, { ok: true, variants });
				return true;
			}

			if (path === "/admin/profiles" && method === "POST") {
				const body = await readJsonBody(req);
				const runtime = runtimeOf(body.variant ?? "");
				const captured = await deps.captureProfile(runtime, body.name, body.sourcePath);
				sendJson(res, 200, { ok: true, profile: captured });
				return true;
			}

			if (path === "/admin/profiles/activate" && method === "POST") {
				const body = await readJsonBody(req);
				const runtime = runtimeOf(body.variant ?? "");
				const active = deps.activateProfile(runtime, body.id === null || body.id === "" ? undefined : body.id);
				const results = await syncNow();
				sendJson(res, 200, { ok: true, activeProfile: active ?? null, sync: results.map((entry) => ({ id: entry.id, models: entry.modelCount ?? null, skipped: entry.skipped ?? null })) });
				return true;
			}

			if (path === "/admin/profiles" && method === "DELETE") {
				const body = await readJsonBody(req);
				const runtime = runtimeOf(body.variant ?? "");
				const removed = deps.deleteProfile(runtime, body.id);
				sendJson(res, 200, { ok: true, removed, activeProfile: runtime.activeProfileId ?? null });
				return true;
			}

			if (path === "/admin/probe" && method === "POST") {
				const body = await readJsonBody(req);
				if (body.confirm !== true) {
					sendJson(res, 400, { ok: false, error: "探测会向 WorkBuddy 发送若干真实请求（可能消耗积分），需要 confirm: true" });
					return true;
				}
				const runtime = runtimeOf(body.variant ?? "");
				if (typeof body.model !== "string" || body.model === "") {
					sendJson(res, 400, { ok: false, error: "缺少 model" });
					return true;
				}
				const credential = await storeFor(runtime).resolve();
				const region = runtime.variant?.region === "global" ? "global" : "cn";
				const outcome = await chunk.probeModel({
					candidates: chunk.PROBE_EFFORT_CANDIDATES,
					region,
					send: (effort, signal) => runtime.client.probeEffort(credential, body.model, effort, signal),
				});
				log(`[admin] probe ${runtime.id}/${body.model} -> ${outcome.validation} ${JSON.stringify(outcome.efforts)} (${outcome.requests} requests)`);
				sendJson(res, 200, { ok: true, model: body.model, variant: runtime.id, ...outcome });
				return true;
			}

			if (path === "/admin/log" && method === "GET") {
				if (options.logFile === "") {
					sendJson(res, 200, { ok: false, error: "本次启动没有 --log-file，日志只在进程输出里", lines: [] });
					return true;
				}
				const limit = Math.min(Math.max(Number(url.searchParams.get("lines") ?? 200) || 200, 1), 2000);
				try {
					const text = readFileSync(options.logFile, "utf8");
					sendJson(res, 200, { ok: true, file: options.logFile, lines: text.split(/\r?\n/).filter((line) => line !== "").slice(-limit) });
				} catch (error) {
					sendJson(res, 200, { ok: false, error: String(error), lines: [] });
				}
				return true;
			}

			if (path === "/admin/shutdown" && method === "POST") {
				// The settings page stops the bridge through this instead of
				// killing a PID it guessed: a stale pid file must never be able
				// to take down an unrelated process.
				sendJson(res, 200, { ok: true, message: "bridge is shutting down" });
				log("[admin] shutdown requested by the settings page");
				setTimeout(() => deps.shutdown(), 50).unref?.();
				return true;
			}

			sendJson(res, 404, { error: `no such admin route: ${method} ${path}` });
			return true;
		} catch (error) {
			const status = typeof error?.status === "number" ? error.status : 500;
			if (status === 500) warn(`[admin] ${method} ${path} failed: ${String(error)}`);
			sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
			return true;
		}
	};
}
