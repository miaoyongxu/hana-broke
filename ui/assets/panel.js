/**
 * WorkBuddy control panel.
 *
 * Plain ES module, no build step: it is served straight from the `panel/`
 * directory, so there is nothing to compile after a checkout.
 *
 * The same file runs in three hosts, and `window.__WORKBUDDY__.base` is the only
 * thing that differs between them:
 *
 * - **standalone** — served by the bridge itself (`/panel`), talking to the
 *   bridge's own `/admin/*` API. This is the primary way to use it: an ordinary
 *   browser tab, or an Edge/Chrome `--app=` window that looks like a native app.
 * - **HanaAgent plugin (v1)** — served from the plugin's route and talking to
 *   its `/api/*` proxy, which forwards to the same admin API.
 * - **HanaAgent App (v2)** — served from the app's `ui/` tree as an iframe. That
 *   iframe has no ambient credentials, so calls go through the host SDK
 *   (`hana.api.fetch`, which mints the surface session); the same `/api/*`
 *   proxy answers them.
 *
 * It is a *view* of the bridge. It never decides anything about WorkBuddy
 * itself; when the bridge is not running every section says so instead of
 * showing stale data as if it were current.
 */

const boot = window.__WORKBUDDY__ ?? { base: "/admin", token: "" };

// The SDK only exists in the v2 App host. Where it does not resolve (the
// standalone console, the v1 plugin page) plain fetch against the same origin
// is already the right thing.
let hana = null;
try {
	({ hana } = await import("./sdk.js"));
	await hana.ready();
} catch (error) {
	console.warn("WorkBuddy 控制台：宿主 SDK 不可用，改用直接请求。", error);
}

/**
 * Normalize one route path.
 *
 * Both `boot.base` values (`/admin`, `/api`) want the path *relative*, but a
 * few call sites below still pass the full `/api/...` form. Stripping the
 * prefix here keeps both spellings pointing at the same route.
 */
function routePath(path) {
	let text = String(path ?? "").trim();
	if (!text.startsWith("/")) text = `/${text}`;
	if (text.startsWith("/api/")) text = text.slice(4);
	return text;
}

/** Call one bridge admin route (directly, or through the App's proxy). */
async function api(path, options = {}) {
	const relative = routePath(path);
	const search = boot.token === "" ? "" : `${relative.includes("?") ? "&" : "?"}token=${encodeURIComponent(boot.token)}`;
	const url = `${boot.base}${relative}${search}`;
	const init = {
		method: options.method ?? "GET",
		headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	};
	const response = hana ? await hana.api.fetch(url, init) : await fetch(url, init);
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch {
		return { ok: false, error: `响应不是 JSON：${text.slice(0, 200)}` };
	}
}

const state = {
	bridge: undefined,
	status: undefined,
	credits: {},
	models: {},
	profiles: undefined,
	opencode: undefined,
	/** Last `/refresh` result, so the page can say whether HanaAgent took the change. */
	lastSync: undefined,
	visibility: {},
	variant: "workbuddy-ai",
	logLines: [],
	busy: new Set(),
	toast: undefined,
	confirm: undefined,
	settings: undefined,
};

const el = (tag, props = {}, children = []) => {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === "class") node.className = value;
		else if (key === "text") node.textContent = value;
		else if (key === "html") node.innerHTML = value;
		else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
		// `false` must mean "attribute absent": in HTML the *presence* of
		// `disabled`/`checked` is what counts, so `disabled="false"` would
		// disable every button on the page.
		else if (value === undefined || value === null || value === false) continue;
		else node.setAttribute(key, String(value));
	}
	for (const child of [].concat(children)) if (child) node.append(child);
	return node;
};

function toast(message) {
	state.toast = message;
	render();
	setTimeout(() => {
		if (state.toast === message) {
			state.toast = undefined;
			render();
		}
	}, 4200);
}

/** Run a button's action with the busy flag set, surfacing any error as a toast. */
async function run(key, action, options = {}) {
	if (state.busy.has(key)) return;
	state.busy.add(key);
	render();
	try {
		const result = await action();
		if (result && result.ok === false) toast(result.error ?? "操作失败");
		else if (options.done) toast(options.done);
	} catch (error) {
		toast(String(error));
	} finally {
		state.busy.delete(key);
		render();
	}
}

const busy = (key) => state.busy.has(key);

/**
 * Ask before doing something that cannot be quietly undone.
 *
 * Not `window.confirm`: an App page is an iframe, and a sandbox without
 * `allow-modals` makes `confirm()` return false without ever drawing a dialog —
 * the button then looks simply dead. Asking inside the page also keeps the
 * wording on screen next to the thing it is about to stop.
 */
function askConfirm(key, message, action) {
	state.confirm = { key, message, action };
	render();
}

function confirmBar() {
	const pending = state.confirm;
	if (!pending) return null;
	return el("div", { class: "confirm" }, [
		el("span", { class: "confirm-text", text: pending.message }),
		el("button", {
			class: "danger",
			text: busy(pending.key) ? "处理中…" : "确定",
			disabled: busy(pending.key),
			onClick: () => {
				const { key, action } = pending;
				state.confirm = undefined;
				void run(key, action);
			},
		}),
		el("button", {
			text: "取消",
			onClick: () => {
				state.confirm = undefined;
				render();
			},
		}),
	]);
}

function when(iso) {
	if (typeof iso !== "string") return "—";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const days = Math.round((date.getTime() - Date.now()) / 86_400_000);
	const label = date.toLocaleString();
	if (days < 0) return `${label}（已过期）`;
	if (days === 0) return `${label}（今天）`;
	return `${label}（${days} 天后）`;
}

function statePill(variant) {
	if (variant.state === "signed-in") return el("span", { class: "pill ok", text: "已登录" });
	if (variant.state === "signed-out") return el("span", { class: "pill bad", text: "未登录" });
	return el("span", { class: "pill warn", text: variant.state ?? "未知" });
}

async function refreshBridge() {
	const bridge = await api("/bridge");
	state.bridge = bridge;
	if (bridge.running) {
		const status = await api("/status");
		state.status = status.ok === false ? undefined : status;
		const profiles = await api("/profiles");
		state.profiles = profiles.ok === false ? undefined : profiles;
		// Cached, so this is cheap; a probe only happens on an explicit refresh.
		const opencode = await api("/opencode");
		state.opencode = opencode.ok === false || opencode.running === false ? undefined : opencode;
		// Load the WorkBuddy roster for the selected account without being asked. The
		// per-model switches live in that table, so an empty table made "which models
		// show" look like a feature that did not exist.
		if (state.models[state.variant] === undefined) {
			const models = await api(`/api/models?variant=${encodeURIComponent(state.variant)}`);
			if (models.ok !== false) state.models[state.variant] = models;
		}
	} else {
		state.status = undefined;
		state.profiles = undefined;
		state.opencode = undefined;
	}
	render();
}

async function refreshSettings() {
	const settings = await api("/settings");
	state.settings = settings?.ok === false ? undefined : { autoStart: settings?.autoStart === true };
	render();
}

//#region sections

function headerSection() {
	const running = state.bridge?.running === true;
	return el("header", {}, [
		// Inside the App the host draws the page title from the manifest, so
		// repeating it here would print it twice. The standalone console has no
		// such chrome and needs its own.
		hana ? null : el("h1", { text: "Hana Broke" }),
		running ? el("span", { class: "pill ok", text: "桥接运行中" }) : el("span", { class: "pill bad", text: "桥接未运行" }),
		el("span", { class: "spacer" }),
		el("button", {
			text: busy("refresh") ? "刷新中…" : "刷新状态",
			disabled: busy("refresh"),
			onClick: () => run("refresh", refreshBridge, { done: "状态已刷新" }),
		}),
		running
			? el("button", {
					text: busy("stop") ? "停止中…" : "停止桥接",
					disabled: busy("stop"),
					onClick: () =>
						askConfirm("stop", "停止桥接后 HanaAgent 里的 WorkBuddy 模型会立刻不可用，确定吗？", async () => {
							const result = await api("/bridge/stop", { method: "POST" });
							await refreshBridge();
							return result;
						}),
				})
			: el("button", {
					class: "primary",
					text: busy("start") ? "启动中…" : "启动桥接",
					disabled: busy("start"),
					onClick: () =>
						run("start", async () => {
							const result = await api("/bridge/start", { method: "POST" });
							await refreshBridge();
							return result;
						}),
				}),
	]);
}

function bridgeInfoSection() {
	const bridge = state.bridge;
	if (bridge === undefined) return el("p", { class: "sub", text: "正在读取桥接状态…" });
	const endpoint = bridge.endpoint;
	const lines = [
		["桥接地址", endpoint ? `http://${endpoint.host}:${endpoint.port}` : "（没有 endpoint.json）"],
		["桥接脚本", `${bridge.script ?? "—"}${bridge.scriptExists ? "" : "（文件不存在！）"}`],
		["数据目录", bridge.dataDir ?? "—"],
		["上游插件", endpoint?.pluginLib ?? "—"],
		["进程", endpoint ? `PID ${endpoint.pid}，启动于 ${when(endpoint.startedAt)}` : "—"],
	];
	return el("section", { class: "card" }, [
		el("h2", {}, [el("span", { text: "桥接" }), el("span", { class: "hint", text: "桥接是独立进程，负责凭据与上游协议；这个页面只是它的控制台" })]),
		...(bridge.running ? [] : [el("p", { class: "error", text: bridge.error ?? bridge.lastStartError ?? "桥接没有在运行" })]),
		autoStartRow(),
		el(
			"dl",
			{ class: "kv" },
			lines.flatMap(([key, value]) => [el("dt", { text: key }), el("dd", { class: "mono", text: value })]),
		),
	]);
}

/**
 * Whether the bridge comes up on its own when HanaAgent starts.
 *
 * Off by default: a background process should not be started by a console just
 * because it was opened. The switch lives in the bridge card rather than the
 * header, because it is a preference, not a status — and unlike the status it
 * is readable even while the bridge is down.
 */
function autoStartRow() {
	const on = state.settings?.autoStart === true;
	return el("div", { class: "row setting-row" }, [
		el("span", { class: "grow" }, [
			el("span", { text: "HanaAgent 启动时自动拉起桥接" }),
			el("span", { class: "hint block", text: "关掉后桥接只在这个页面点「启动桥接」时才会运行，启动 HanaAgent 也不会弹后台窗口。" }),
		]),
		el("button", {
			class: on ? "ok" : "",
			text: busy("settings") ? "保存中…" : on ? "自动：开" : "自动：关",
			disabled: busy("settings") || state.settings === undefined,
			onClick: () =>
				run("settings", async () => {
					const result = await api("/settings", { method: "PUT", body: { autoStart: !on } });
					if (result?.ok === false) return result;
					state.settings = { autoStart: result.autoStart === true };
					return { ok: true };
				}, { done: !on ? "已改为自动启动" : "已改为手动启动" }),
		}),
	]);
}

function creditsBlock(variant) {
	const entry = state.credits[variant.id];
	const key = `credits:${variant.id}`;
	const children = [
		el("div", { class: "row" }, [
			el("span", { class: "grow", text: entry?.ok ? `剩余积分 ${entry.credits?.total ?? "—"}` : "剩余积分" }),
			el("button", {
				text: busy(key) ? "查询中…" : "查询积分",
				disabled: busy(key),
				onClick: () =>
					run(
						key,
						async () => {
							const result = await api(`/api/credits?variant=${encodeURIComponent(variant.id)}`);
							const mine = result.credits?.find((item) => item.id === variant.id);
							state.credits[variant.id] = mine;
							return mine?.ok === false ? mine : result;
						},
						{ confirm: "查询积分会向 WorkBuddy 发送一次真实的计费请求（会记录在账单接口里），继续吗？" },
					),
			}),
		]),
	];
	if (entry?.ok === false) children.push(el("p", { class: "error", text: entry.error }));
	if (entry?.ok === true && Array.isArray(entry.credits?.accounts)) {
		children.push(
			el(
				"ul",
				{ class: "credits" },
				entry.credits.accounts.slice(0, 6).map((account) =>
					el("li", {}, [
						el("span", { text: account.packageName ?? "套餐" }),
						el("b", { text: `${account.remain ?? "?"} / ${account.size ?? "?"}` }),
					]),
				),
			),
		);
		if (entry.credits.expiry) {
			const within7 = entry.credits.expiry.within7d;
			if (within7 && within7.total > 0) {
				children.push(el("p", { class: "error", text: `有 ${within7.total} 积分将在 7 天内过期` }));
			}
		}
	}
	return el("div", {}, children);
}

function variantCard(variant) {
	const profile = state.profiles?.variants?.find((item) => item.id === variant.id);
	return el("section", { class: "card" }, [
		el("h2", {}, [
			el("span", { text: variant.displayName }),
			statePill(variant),
			el("span", { class: "hint", text: `${variant.modelCount} 个模型` }),
		]),
		el(
			"dl",
			{ class: "kv" },
			[
				["账号", variant.account?.uid ? `${variant.account.uid}${variant.account.domain ? ` @ ${variant.account.domain}` : ""}` : variant.account?.error ?? "—"],
				["登录有效期", when(variant.account?.expiresAt)],
				["当前档案", variant.activeProfile ? `${variant.activeProfile}（不跟随桌面 App）` : "跟随桌面 App 的登录"],
				["最近成功", variant.lastSuccessAt ? when(variant.lastSuccessAt) : "—"],
				["最近错误", variant.lastError ? `${variant.lastError.kind}（${variant.lastError.model ?? "—"}）` : "无"],
				["配额冻结", Array.isArray(variant.quotaBlocked) && variant.quotaBlocked.length > 0 ? variant.quotaBlocked.map((item) => `${item.model} → ${item.resetsAt}`).join("；") : "无"],
				["目录来源", variant.catalogError ? `上游读取失败：${variant.catalogError}` : "实时目录"],
			].flatMap(([key, value]) => [el("dt", { text: key }), el("dd", { text: String(value) })]),
		),
		creditsBlock(variant),
		el("div", { class: "row" }, [
			el("button", {
				text: busy("refresh-models") ? "刷新中…" : "刷新模型目录",
				disabled: busy("refresh-models"),
				onClick: () =>
					run("refresh-models", async () => {
						const result = await api("/refresh", { method: "POST" });
						await refreshBridge();
						return result;
					}),
			}),
			profile?.liveAuthPath ? el("span", { class: "mono", text: `桌面登录文件：${profile.liveAuthPath}` }) : null,
		]),
	]);
}

function profilesSection(variant) {
	const entry = state.profiles?.variants?.find((item) => item.id === variant.id);
	const inputId = `profile-name-${variant.id}`;
	const rows = (entry?.profiles ?? []).map((profile) =>
		el("tr", {}, [
			el("td", {}, [el("b", { text: profile.name }), el("div", { class: "mono", text: profile.id })]),
			el("td", {}, [
				profile.state === "signed-in" ? el("span", { class: "pill ok", text: "可用" }) : el("span", { class: "pill bad", text: "不可用" }),
				profile.reason ? el("div", { class: "error", text: profile.reason.slice(0, 120) }) : null,
			]),
			el("td", { class: "mono", text: profile.uid ? `${profile.uid}${profile.domain ? ` @ ${profile.domain}` : ""}` : "—" }),
			el("td", { text: when(profile.expiresAt) }),
			el("td", {}, [
				entry.activeProfile === profile.id
					? el("span", { class: "pill ok", text: "使用中" })
					: el("button", {
							text: busy(`activate:${profile.id}`) ? "切换中…" : "切换到它",
							disabled: busy(`activate:${profile.id}`) || profile.state !== "signed-in",
							onClick: () =>
								run(
									`activate:${profile.id}`,
									async () => {
										const result = await api("/profiles/activate", { method: "POST", body: { variant: variant.id, id: profile.id } });
										await refreshBridge();
										return result;
									},
									{ done: `已切换到 ${profile.name}` },
								),
						}),
				el("button", {
					class: "danger",
					text: "删除",
					disabled: busy(`delete:${profile.id}`),
					onClick: () =>
						run(
							`delete:${profile.id}`,
							async () => {
								const result = await api("/profiles", { method: "DELETE", body: { variant: variant.id, id: profile.id } });
								await refreshBridge();
								return result;
							},
							{ confirm: `删除档案「${profile.name}」？只是删掉这份保存的登录，不影响桌面 App。` },
						),
				}),
			]),
		]),
	);

	return el("section", { class: "card" }, [
		el("h2", {}, [
			el("span", { text: `${variant.displayName} 的账号档案` }),
			el("span", { class: "hint", text: "切换是手动的：配额用尽时不会自动换号" }),
		]),
		rows.length === 0
			? el("p", { class: "empty", text: "还没有档案。先用这个账号在桌面 App 里登录，然后采集一次。" })
			: el("div", { class: "scroll" }, [
					el("table", {}, [
						el("thead", {}, [el("tr", {}, [el("th", { text: "档案" }), el("th", { text: "状态" }), el("th", { text: "账号" }), el("th", { text: "登录有效期" }), el("th", { text: "操作" })])]),
						el("tbody", {}, rows),
					]),
				]),
		el("div", { class: "row" }, [
			el("input", { type: "text", id: inputId, placeholder: "档案名字，例如 工作号" }),
			el("button", {
				text: busy(`capture:${variant.id}`) ? "采集中…" : "采集当前登录",
				disabled: busy(`capture:${variant.id}`),
				onClick: () =>
					run(
						`capture:${variant.id}`,
						async () => {
							const input = document.getElementById(inputId);
							const name = (input?.value ?? "").trim() || "默认档案";
							const result = await api("/profiles", { method: "POST", body: { variant: variant.id, name } });
							if (result.ok !== false && input) input.value = "";
							await refreshBridge();
							return result;
						},
						{
							confirm:
								`采集会把桌面 App 当前的登录复制一份存到插件数据目录（只在本机，仅用于切换账号）。\n\n` +
								`注意：${variant.displayName} 采到的必须是它自己的登录，否则会被拒绝。继续吗？`,
						},
					),
			}),
			entry?.activeProfile
				? el("button", {
						text: "恢复跟随桌面 App",
						disabled: busy(`activate:${variant.id}`),
						onClick: () =>
							run(
								`activate:${variant.id}`,
								async () => {
									const result = await api("/profiles/activate", { method: "POST", body: { variant: variant.id, id: null } });
									await refreshBridge();
									return result;
								},
								{ done: "已恢复跟随桌面 App" },
							),
					})
				: null,
		]),
	]);
}

function modelsSection() {
	const variant = state.status?.variants?.find((item) => item.id === state.variant);
	const entry = state.models[state.variant];
	const loadKey = `models:${state.variant}`;
	const rows = (entry?.variants?.[0]?.models ?? []).map((model) =>
		el("tr", { class: model.hidden ? "hidden-model" : undefined }, [
			el("td", {}, [el("b", { text: model.displayName }), el("div", { class: "mono", text: model.id })]),
			el("td", { text: model.badges?.length ? model.badges.join(" · ") : "—" }),
			el("td", { text: model.rate === null || model.rate === undefined ? "—" : `x${model.rate}` }),
			el("td", {}, [
				model.supportsImages ? el("span", { class: "pill", text: "图片" }) : null,
				model.declaredEfforts?.length ? el("span", { class: "pill", text: `档位 ${model.declaredEfforts.join("/")}` }) : null,
			]),
			el("td", {}, [
				el("label", { class: "row" }, [
					el("input", {
						type: "checkbox",
						// "显示", not "隐藏": the same direction as the OpenCode section, so a
						// ticked box means the same thing on both.
						checked: model.hidden ? undefined : "checked",
						disabled: busy(`hide:${model.id}`),
						onChange: (event) =>
							run(`hide:${model.id}`, async () => {
								const current = entry.variants[0].models.filter((item) => item.hidden).map((item) => item.id);
								const next = event.target.checked ? current.filter((id) => id !== model.id) : [...current, model.id];
								const result = await api("/visibility", { method: "PUT", body: { variant: state.variant, hidden: next } });
								state.models[state.variant] = await api(`/api/models?variant=${encodeURIComponent(state.variant)}`);
								await refreshBridge();
								return result;
							}),
					}),
					el("span", { text: "显示" }),
				]),
			]),
			el("td", {}, [
				el("button", {
					text: busy(`probe:${model.id}`) ? "探测中…" : "探测档位",
					disabled: busy(`probe:${model.id}`),
					onClick: () =>
						run(
							`probe:${model.id}`,
							async () => {
								const result = await api("/probe", { method: "POST", body: { variant: state.variant, model: model.id, confirm: true } });
								if (result.ok === false) return result;
								const verdict =
									result.validation === "validating"
										? `支持：${result.efforts.join(" / ") || "（没有可用档位）"}`
										: result.validation === "non-validating"
											? "该端点不校验档位，任何值都接受"
											: `无法判定：${result.reason ?? "未知原因"}`;
								toast(`${model.name}：${verdict}（${result.requests} 次请求）`);
								return result;
							},
							{ confirm: `探测会向 WorkBuddy 连续发送若干真实请求（可能消耗积分，也可能撞上限流），继续吗？\n\n模型：${model.displayName}` },
						),
				}),
			]),
		]),
	);

	return el("section", { class: "card" }, [
		el("h2", {}, [
			el("span", { text: "模型" }),
			el("span", { class: "hint", text: "取消勾选即从 HanaAgent 的模型列表移除；显隐按账号保存，改了会立刻重新同步" }),
		]),
		el("div", { class: "row" }, [
			el(
				"select",
				{
					onChange: (event) => {
						state.variant = event.target.value;
						render();
						void run(`models:${state.variant}`, async () => {
							state.models[state.variant] = await api(`/api/models?variant=${encodeURIComponent(state.variant)}`);
						});
					},
				},
				(state.status?.variants ?? []).map((item) =>
					el("option", { value: item.id, text: item.displayName, selected: item.id === state.variant ? "selected" : undefined }),
				),
			),
			el("span", { class: "grow" }),
			el("button", {
				text: busy(loadKey) ? "读取中…" : "读取模型列表",
				disabled: busy(loadKey),
				onClick: () =>
					run(loadKey, async () => {
						state.models[state.variant] = await api(`/api/models?variant=${encodeURIComponent(state.variant)}`);
					}),
			}),
			el("button", {
				text: busy(`reload:${state.variant}`) ? "拉取并同步中…" : "重新从上游拉取并同步",
				disabled: busy(`reload:${state.variant}`),
				onClick: () =>
					run(
						`reload:${state.variant}`,
						async () => {
							state.models[state.variant] = await api(`/api/models?variant=${encodeURIComponent(state.variant)}&refresh=1`);
							// Re-reading the catalog only fills this table. What the session's model
							// picker reads is the declaration HanaAgent holds, so push it too —
							// otherwise "re-pulled" models never reach the picker.
							const sync = await api("/refresh", { method: "POST" });
							state.lastSync = sync;
							await refreshBridge();
							return sync;
						},
						{ done: "已重新拉取并同步给 HanaAgent" },
					),
			}),
		]),
		entry === undefined
			? el("p", { class: "empty", text: "点「读取模型列表」查看当前账号能用的模型。" })
			: rows.length === 0
				? el("p", { class: "empty", text: "没有读到模型。" })
				: el("div", { class: "scroll" }, [
						el("table", {}, [
							el("thead", {}, [el("tr", {}, [el("th", { text: "模型" }), el("th", { text: "徽标" }), el("th", { text: "倍率" }), el("th", { text: "能力" }), el("th", { text: "显示" }), el("th", { text: "" })])]),
							el("tbody", {}, rows),
						]),
					]),
		variant ? el("p", { class: "sub", text: `当前账号：${variant.account?.uid ?? "—"}；共 ${variant.modelCount} 个模型（含已隐藏的）。` }) : null,
		// The page cannot tell from its own state whether HanaAgent accepted the push, so
		// the last sync result is reported explicitly.
		syncLine(state.lastSync),
	]);
}

/** One line describing what a `/refresh` push did, per provider. */
function syncLine(result) {
	const results = result?.results;
	if (!Array.isArray(results)) return null;
	const parts = results.map((entry) => {
		if (entry.error !== null && entry.error !== undefined) return `${entry.id} 失败：${entry.error}`;
		if (entry.skipped !== null && entry.skipped !== undefined) return `${entry.id} 未注册（${entry.skipped}）`;
		return `${entry.id} ${entry.models ?? "?"} 个`;
	});
	return el("p", { class: "sub", text: `已同步给 HanaAgent：${parts.join("；")}` });
}

function logSection() {
	return el("section", { class: "card" }, [
		el("h2", {}, [el("span", { text: "桥接日志" }), el("span", { class: "hint", text: "最近 200 行，来自桥接自己的日志文件" })]),
		el("div", { class: "row" }, [
			el("button", {
				text: busy("log") ? "读取中…" : "读取日志",
				disabled: busy("log"),
				onClick: () =>
					run("log", async () => {
						const result = await api("/log?lines=200");
						state.logLines = result.lines ?? [];
						if (result.ok === false) return result;
					}),
			}),
		]),
		state.logLines.length === 0 ? el("p", { class: "empty", text: "还没有读取。" }) : el("pre", { class: "log", text: state.logLines.join("\n") }),
	]);
}

//#endregion

/**
 * OpenCode free models — the bridge's second upstream.
 *
 * Every listed model is shown, not just the usable ones: a model that has been
 * deprecated or is blocked in this country is worth seeing, otherwise it looks like the
 * bridge silently dropped it.
 *
 * `重新探测` re-measures every model AND re-declares the provider, so a model that
 * became reachable shows up in HanaAgent without restarting anything — probing alone
 * only refreshed this page.
 */
function opencodeSection() {
	const info = state.opencode;
	if (info === undefined || info.enabled === false) return null;
	const models = Array.isArray(info.models) ? info.models : [];
	const usable = models.filter((model) => model.working && !model.hidden).length;
	const working = models.filter((model) => model.working).length;
	const hidden = models.filter((model) => model.hidden).length;
	const sync = Array.isArray(info.sync) ? info.sync.find((entry) => entry.id === "opencode") : undefined;

	/** One model row: reachability, identity, and the show/hide switch. */
	const row = (model) =>
		el("div", { class: "row" }, [
			el("span", {
				class: model.hidden ? "pill" : model.working ? "pill ok" : "pill bad",
				text: model.hidden ? "已隐藏" : model.working ? "可用" : "不可用",
			}),
			el("code", { text: model.id }),
			el("span", {
				class: "sub",
				text: model.hidden
					? "已从 HanaAgent 的模型列表移除"
					: model.working
						? `上下文 ${model.context ?? "?"} · 输出上限 ${model.maxOutput ?? "?"}`
						: (model.error ?? "探测失败"),
			}),
			// Hide is only meaningful for a model that could be published; offering it on
			// one that never answers would suggest the switch was what removed it.
			model.working || model.hidden
				? el("label", { class: "row" }, [
						el("input", {
							type: "checkbox",
							// Ticked means shown. `hidden` is absent for a normal model, so the
							// box starts ticked — the opposite binding (ticked = hidden) put the
							// box and its "显示" label in direct contradiction.
							checked: model.hidden ? undefined : "checked",
							disabled: busy(`oc-hide:${model.id}`),
							onChange: (event) =>
								run(
									`oc-hide:${model.id}`,
									async () => {
										const current = models.filter((item) => item.hidden).map((item) => item.id);
										const next = event.target.checked ? current.filter((id) => id !== model.id) : [...current, model.id];
										const result = await api("/opencode/visibility", { method: "PUT", body: { hidden: next } });
										state.opencode = await api("/opencode");
										return result;
									},
								),
						}),
						el("span", { text: "显示" }),
					])
				: null,
		]);

	return el("section", { class: "card" }, [
		el("h2", {}, [
			el("span", { text: "OpenCode 免费模型" }),
			el("span", { class: "hint", text: "不勾「显示」的模型不会进 HanaAgent 的模型列表" }),
		]),
		el("p", {
			class: "sub",
			text: "通过 OpenCode 桌面版自带的 v2 CLI 访问，不需要登录；免费额度与可用性由上游决定，随时可能变化。",
		}),
		info.error ? el("p", { class: "sub", text: `读取失败：${info.error}` }) : null,
		el("div", { class: "row" }, [
			el("span", {
				class: usable > 0 ? "pill ok" : "pill bad",
				text: models.length === 0 ? "未探测" : `HanaAgent 里 ${usable} 个${hidden > 0 ? `（另有 ${hidden} 个已隐藏）` : ""}`,
			}),
			el("span", { class: "sub", text: `上游列出 ${models.length} 个，实测可用 ${working} 个` }),
			info.running === false ? el("span", { class: "sub", text: "服务未启动（首次请求时会自动启动）" }) : null,
			el("span", { class: "spacer" }),
			el("button", {
				text: busy("opencode-refresh") ? "探测并同步中…" : "重新探测并同步",
				disabled: busy("opencode-refresh"),
				onClick: () =>
					run(
						"opencode-refresh",
						async () => {
							state.opencode = await api("/opencode?refresh=1");
						},
						{ done: "已重新探测并同步到 HanaAgent" },
					),
			}),
		]),
		// Whether HanaAgent took the change is the question this page cannot answer from
		// its own state, so the push result is reported explicitly.
		sync === undefined
			? null
			: el("p", {
					class: "sub",
					text: sync.error !== undefined
						? `同步到 HanaAgent 失败：${sync.error}`
						: sync.skipped !== null && sync.skipped !== undefined
							? `HanaAgent 未更新：${sync.skipped}`
							: `已同步给 HanaAgent：${sync.models ?? "?"} 个模型`,
				}),
		...models.map(row),
	]);
}

function render() {
	const root = document.getElementById("root");
	if (!root) return;
	// `replaceChildren` rebuilds the whole page, which throws away the scroll position —
	// so every click (a busy flag, a toast) snapped the view back to the top. The window
	// and each inner scroller are captured and restored around the swap.
	const scroll = [window.scrollX, window.scrollY];
	const inner = [...root.querySelectorAll(".scroll")].map((node) => node.scrollTop);
	// `replaceChildren` takes variadic nodes, not an array — handing it an
	// array stringifies it into "[object HTMLElement],…" on the page. It also
	// stringifies a bare `null`, which is why the empties are filtered out
	// rather than passed through.
	root.replaceChildren(
		...[
			headerSection(),
			el("p", { class: "sub", text: "凭据由桥接直接读取 WorkBuddy 桌面 App 的登录，本页面不接触令牌；查询积分与档位探测会发出真实请求。" }),
			bridgeInfoSection(),
			...(state.status?.variants ?? []).flatMap((variant) => [variantCard(variant), profilesSection(variant)]),
			modelsSection(),
			opencodeSection(),
			logSection(),
			confirmBar(),
			state.toast ? el("div", { class: "toast", text: state.toast }) : null,
		].filter(Boolean),
	);
	[...root.querySelectorAll(".scroll")].forEach((node, index) => {
		if (inner[index] !== undefined) node.scrollTop = inner[index];
	});
	window.scrollTo(scroll[0], scroll[1]);
}

render();
void refreshBridge();
void refreshSettings();
