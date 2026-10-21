/**
 * The bridge's operator surface, used by the console and by the HanaAgent App page.
 *
 * Separate from the OpenAI-compatible surface under `/<provider>/v1`: that one is a model
 * endpoint, this one is a console (who is signed in, what the vendor listed, which models
 * are shown, one sign-in at a time). It shares the loopback bind and the optional bearer
 * of the main server, so `--token` protects both.
 *
 * Sign-in is the one operation that is stateful and slow, so it is modelled as a job
 * rather than a request: `POST /admin/providers/<id>/signin` starts it and answers with a
 * URL, `GET .../signin` reports where it got to. A browser flow waits for a person, and a
 * request that simply blocked for two minutes would look like a hang — and could not be
 * polled for the URL it is waiting on.
 *
 * @module hana-broke/admin-api
 */

import { randomUUID } from "node:crypto";

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
				reject(Object.assign(new Error(`invalid JSON body: ${String(error)}`), { status: 400 }));
			}
		});
		req.on("error", reject);
	});
}

/**
 * Build the admin request handler.
 *
 * @param {object} deps
 * @param {import("./plugin-host.mjs").ProviderPlugin[]} deps.providers loaded plugins
 * @param {object} deps.store the plugin credential store
 * @param {object} deps.options bridge options
 * @param {(req: object) => boolean} deps.bearerOk the bridge's own bearer check
 * @param {() => Promise<object[]>} deps.syncNow re-run catalog sync + registration
 * @param {(provider: object, force: boolean) => Promise<object>} deps.catalogFor one provider's models
 * @param {() => void} deps.shutdown stop the bridge gracefully
 * @param {(message: string) => void} deps.log
 * @param {(message: string) => void} deps.warn
 */
export function createAdminApi(deps) {
	const { providers, store, options, bearerOk, syncNow, catalogFor, shutdown, log, warn } = deps;

	/**
	 * Sign-ins in flight, keyed by provider id.
	 *
	 * One per provider: two device flows for the same account would race for the same
	 * credential slot, and the second would overwrite the first mid-poll.
	 */
	const signIns = new Map();

	const providerOf = (id) => {
		const found = providers.find((candidate) => candidate.id === id);
		if (found === undefined) throw Object.assign(new Error(`unknown provider: ${String(id)}`), { status: 404 });
		return found;
	};

	/** A provider's row: who it is, whether signed in, what it listed. */
	async function providerRow(provider, { force = false } = {}) {
		const row = {
			...provider.describe(),
			baseUrl: `http://${options.host}:${options.port}/${provider.id}/v1`,
			signIn: signIns.has(provider.id) ? describeSignIn(signIns.get(provider.id)) : null,
		};
		if (!provider.signedIn()) {
			return { ...row, models: [], listError: "还没有登录" };
		}
		try {
			const catalog = await catalogFor(provider, force);
			const hidden = new Set(provider.hiddenIds());
			return {
				...row,
				models: catalog.models.map((model) => ({
					...model,
					hidden: hidden.has(model.id),
				})),
				modelCount: catalog.models.length,
				listed: catalog.models.length,
				shown: catalog.models.filter((model) => !hidden.has(model.id)).length,
				fellBack: catalog.fellBack === true,
				listError: catalog.listError ?? null,
			};
		} catch (error) {
			return { ...row, models: [], listError: String(error?.message ?? error) };
		}
	}

	/** What a caller is told about a sign-in in progress. */
	const describeSignIn = (job) => ({
		id: job.id,
		state: job.state,
		url: job.url ?? null,
		instructions: job.instructions ?? null,
		error: job.error ?? null,
		methods: job.methods,
	});

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
				const rows = [];
				for (const provider of providers) rows.push(await providerRow(provider));
				sendJson(res, 200, {
					ok: true,
					bridge: {
						port: options.port,
						host: options.host,
						dataDir: options.dataDir,
						...(options.logFile === "" ? {} : { logFile: options.logFile }),
						pid: process.pid,
					},
					providers: rows,
				});
				return true;
			}

			/** Every provider, with its models. `?refresh=1` re-asks each vendor. */
			if (path === "/admin/providers" && method === "GET") {
				const force = url.searchParams.get("refresh") === "1";
				const rows = [];
				for (const provider of providers) rows.push(await providerRow(provider, { force }));
				sendJson(res, 200, { ok: true, providers: rows });
				return true;
			}

			if (path === "/admin/sync" && method === "POST") {
				const results = await syncNow();
				sendJson(res, 200, {
					ok: true,
					results: results.map((entry) => ({
						id: entry.id,
						models: entry.modelCount ?? null,
						skipped: entry.skipped ?? null,
						error: entry.error ?? null,
					})),
				});
				return true;
			}

			// ---- one provider -------------------------------------------------------
			const one = /^\/admin\/providers\/([a-z0-9-]+)(\/[a-z-]+)?$/.exec(path);
			if (one !== null) {
				const provider = providerOf(one[1]);
				const action = one[2] ?? "";

				if (action === "" && method === "GET") {
					sendJson(res, 200, { ok: true, ...(await providerRow(provider, { force: url.searchParams.get("refresh") === "1" })) });
					return true;
				}

				if (action === "/signin" && method === "POST") {
					const body = await readJsonBody(req);
					if (signIns.has(provider.id)) {
						sendJson(res, 200, { ok: false, error: "这个供应商已经有一个登录在进行", signIn: describeSignIn(signIns.get(provider.id)) });
						return true;
					}
					const methods = await provider.methods();
					const index = Number.isInteger(body.method) ? body.method : 0;
					const job = {
						id: randomUUID(),
						state: "running",
						methods: methods.map((entry) => ({ index: entry.index, label: entry.label, type: entry.type, prompts: entry.prompts })),
						prompts: methods[index]?.prompts ?? [],
					};
					signIns.set(provider.id, job);
					// Start the flow and answer at once: the URL arrives asynchronously (a PAT
					// method has none), and the callback may wait for a person for minutes.
					void provider
						.signIn(index, body.inputs ?? {}, {
							onUrl: (url_, instructions) => {
								job.url = url_;
								job.instructions = typeof instructions === "string" ? instructions : null;
							},
						})
						.then(() => {
							job.state = "done";
							signIns.delete(provider.id);
							log(`[admin] ${provider.id} 登录完成`);
						})
						.catch((error) => {
							job.state = "failed";
							job.error = String(error?.message ?? error);
							signIns.delete(provider.id);
							warn(`[admin] ${provider.id} 登录失败：${job.error}`);
						});
					sendJson(res, 200, { ok: true, signIn: describeSignIn(job) });
					return true;
				}

				if (action === "/signin" && method === "GET") {
					const job = signIns.get(provider.id);
					sendJson(res, 200, { ok: true, signIn: job === undefined ? null : describeSignIn(job), signedIn: provider.signedIn() });
					return true;
				}

				if (action === "/signin" && method === "DELETE") {
					const job = signIns.get(provider.id);
					if (job !== undefined) {
						job.state = "cancelled";
						signIns.delete(provider.id);
					}
					sendJson(res, 200, { ok: true, cancelled: job !== undefined });
					return true;
				}

				if (action === "/signout" && method === "POST") {
					const result = provider.signOut();
					sendJson(res, 200, { ok: true, ...result });
					return true;
				}

				/** Show or hide models; hiding changes the declaration, so a sync follows. */
				if (action === "/visibility" && method === "PUT") {
					const body = await readJsonBody(req);
					const stored = provider.setHidden(body?.hidden);
					let sync = null;
					try {
						const results = await syncNow();
						sync = results.map((entry) => ({ id: entry.id, models: entry.modelCount ?? null, skipped: entry.skipped ?? null, error: entry.error ?? null }));
					} catch (error) {
						sync = [{ id: provider.id, error: String(error) }];
					}
					sendJson(res, 200, { ok: true, hidden: stored, sync });
					return true;
				}

				/** Renew the credential now, rather than waiting for the timer. */
				if (action === "/refresh" && method === "POST") {
					const result = await provider.refreshIfDue();
					sendJson(res, 200, { ok: true, ...result });
					return true;
				}

				sendJson(res, 404, { ok: false, error: `no such admin route: ${method} ${path}` });
				return true;
			}

			if (path === "/admin/log" && method === "GET") {
				sendJson(res, 200, { ok: true, lines: [], note: "日志在 bridge.log 里；面板读取它需要文件路径" });
				return true;
			}

			if (path === "/admin/shutdown" && method === "POST") {
				sendJson(res, 200, { ok: true });
				if (typeof shutdown === "function") shutdown();
				return true;
			}

			sendJson(res, 404, { ok: false, error: `no such admin route: ${method} ${path}` });
			return true;
		} catch (error) {
			const status = typeof error?.status === "number" ? error.status : 500;
			sendJson(res, status, { ok: false, error: String(error?.message ?? error) });
			return true;
		}
	};
}
