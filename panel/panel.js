/**
 * Hana Broke console.
 *
 * Plain ES module, no build step: it is copied verbatim into the App's `ui/`
 * tree, so there is nothing to compile after a checkout. It runs as a **HanaAgent
 * App page**, talking to the bridge's `/admin/*` API through the App's own proxy
 * (`index.js`), which is where the bridge bearer lives.
 *
 * There is deliberately no standalone host any more. The bridge used to serve
 * this page from its own `/panel` route, and that route could not sit behind the
 * bearer check without the page needing the bearer — which put the secret into
 * HTML that any local process could fetch. Removing the route removes the
 * choice: the token never leaves the App process, and this file never sees it.
 *
 * The layout follows magpie's information architecture — Providers, then each one's
 * Models — because that is the shape of the problem: several subscriptions, each with a
 * sign-in, a roster, and a per-model switch. The markup is this App's own: an App page
 * lives in a WebView with the host's chrome, while magpie's window is a desktop shell with
 * agents, sessions and a library this App has no business showing.
 *
 * It is a *view* of the bridge: when something is not signed in, or a vendor did not
 * answer, the page says so rather than showing a stale list as if it were current.
 */

const boot = window.__HANABROKE__ ?? { base: "/api" };

// The SDK only exists in the App host, which is now the only host.
let hana = null;
try {
	({ hana } = await import("./sdk.js"));
	await hana.ready();
} catch (error) {
	console.warn("Hana Broke 控制台：宿主 SDK 不可用，改用直接请求。", error);
}

/** Normalize one route path: the App's `/api` base wants the path relative. */
function routePath(path) {
	let text = String(path ?? "").trim();
	if (!text.startsWith("/")) text = `/${text}`;
	if (text.startsWith("/api/")) text = text.slice(4);
	return text;
}

/**
 * Call one bridge admin route through the App's proxy.
 *
 * No token handling here, on purpose: the proxy attaches the bearer server-side,
 * and this file has no way to obtain it. That is the property the marketplace
 * review asked for, so it is worth keeping visible rather than implicit.
 */
async function api(path, options = {}) {
	const relative = routePath(path);
	const url = `${boot.base}${relative}`;
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
	providers: undefined,
	bridge: undefined,
	/** Open sign-in flows, keyed by provider id. */
	signIns: {},
	busy: new Set(),
	toast: undefined,
	confirm: undefined,
};

const el = (tag, props = {}, children = []) => {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === "class") node.className = value;
		else if (key === "text") node.textContent = value;
		else if (key === "html") node.innerHTML = value;
		else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
		// `false` must mean "attribute absent": in HTML the *presence* of
		// `disabled`/`checked` is what counts, so `disabled="false"` would disable
		// every button on the page.
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
 * Not `window.confirm`: an App page is an iframe, and a sandbox without `allow-modals`
 * makes `confirm()` return false without drawing a dialog — the button then looks dead.
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

async function refresh() {
	const status = await api("/status");
	state.providers = status.ok === false ? undefined : status.providers ?? [];
	state.bridge = status.bridge;
	render();
}

/** Poll a sign-in until it settles, then refresh the page's state. */
async function pollSignIn(providerId) {
	for (let attempt = 0; attempt < 600; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		let answer;
		try {
			answer = await api(`/providers/${providerId}/signin`);
		} catch {
			continue;
		}
		if (answer.signIn === null || answer.signIn === undefined) {
			delete state.signIns[providerId];
			if (answer.signedIn === true) toast("登录成功");
			await refresh();
			return;
		}
		state.signIns[providerId] = answer.signIn;
		render();
		if (answer.signIn.state === "failed") {
			delete state.signIns[providerId];
			toast(answer.signIn.error ?? "登录失败");
			await refresh();
			return;
		}
	}
}

//#region sections

function headerSection() {
	return el("header", {}, [
		hana ? null : el("h1", { text: "Hana Broke" }),
		state.providers === undefined
			? el("span", { class: "pill", text: "读取中…" })
			: el("span", { class: "pill ok", text: `桥接运行中 · ${state.bridge?.port ?? "?"}` }),
		el("span", { class: "spacer" }),
		el("button", {
			text: busy("refresh") ? "刷新中…" : "刷新",
			disabled: busy("refresh"),
			onClick: () => run("refresh", refresh, { done: "已刷新" }),
		}),
	]);
}

/**
 * One provider's card: identity, sign-in, roster, and the model switches.
 *
 * The three states are shown differently on purpose. *Not signed in* offers a sign-in;
 * *signed in but the vendor did not answer* shows the vendor's own words, because a
 * missing model there is the vendor's problem and not a switch the user forgot; *listed*
 * is the roster.
 */
function providerCard(provider) {
	const signIn = state.signIns[provider.id] ?? provider.signIn;
	const signingIn = signIn !== undefined && signIn !== null && signIn.state === "running";
	const models = Array.isArray(provider.models) ? provider.models : [];
	const hidden = models.filter((model) => model.hidden).length;
	const shown = models.length - hidden;

	const startSignIn = (methodIndex, inputs) =>
		run(`signin:${provider.id}`, async () => {
			const result = await api(`/providers/${provider.id}/signin`, {
				method: "POST",
				body: { method: methodIndex, ...(inputs === undefined ? {} : { inputs }) },
			});
			if (result.signIn) state.signIns[provider.id] = result.signIn;
			await pollSignIn(provider.id);
			return result;
		});

	/** A method that wants input first (a PAT, an instance name) renders a small form. */
	const promptForm = (method) => {
		if (!Array.isArray(method?.prompts) || method.prompts.length === 0) return null;
		const inputs = {};
		return el("div", { class: "prompts" }, [
			...method.prompts.map((prompt) =>
				el("label", { class: "field" }, [
					el("span", { text: prompt.message ?? prompt.key }),
					el("input", {
						type: prompt.type === "password" ? "password" : "text",
						placeholder: prompt.placeholder ?? "",
						onInput: (event) => {
							inputs[prompt.key] = event.target.value;
						},
					}),
				])
			),
			el("button", {
				class: "primary",
				text: "提交",
				disabled: busy(`signin:${provider.id}`),
				onClick: () => startSignIn(method.index, inputs),
			}),
		]);
	};

	const signInBlock = () => {
		if (provider.signedIn === true) {
			return el("div", { class: "row" }, [
				el("span", { class: "pill ok", text: "已登录" }),
				provider.account ? el("span", { class: "sub", text: provider.account }) : null,
				provider.expiresAt ? el("span", { class: "sub", text: `有效期至 ${when(provider.expiresAt)}` }) : null,
				provider.expired ? el("span", { class: "pill bad", text: "已过期" }) : null,
				el("span", { class: "spacer" }),
				el("button", {
					text: busy(`signout:${provider.id}`) ? "退出中…" : "退出登录",
					disabled: busy(`signout:${provider.id}`),
					onClick: () =>
						askConfirm(`signout:${provider.id}`, `退出 ${provider.label} 后，HanaAgent 里它的模型会立刻不可用，确定吗？`, async () => {
							const result = await api(`/providers/${provider.id}/signout`, { method: "POST" });
							await refresh();
							return result;
						}),
				}),
			]);
		}
		if (signingIn) return el("p", { class: "sub", text: "正在登录…" });
		const methods = signIn?.methods ?? [];
		return el("div", {}, [
			el("p", { class: "sub", text: methods.length > 1 ? "还没有登录。选一种登录方式：" : "还没有登录。" }),
			...(methods.length > 0
				? methods.map((method) =>
						Array.isArray(method.prompts) && method.prompts.length > 0
							? el("div", { class: "method" }, [el("span", { class: "sub", text: method.label }), promptForm(method)])
							: el("button", {
									class: "primary",
									text: method.label,
									disabled: busy(`signin:${provider.id}`),
									onClick: () => startSignIn(method.index),
								})
					)
				: [el("button", {
						class: "primary",
						text: busy(`signin:${provider.id}`) ? "准备中…" : "开始登录",
						disabled: busy(`signin:${provider.id}`),
						onClick: () => startSignIn(0),
					})]),
		]);
	};

	/** A browser hand-off: show the URL, keep polling until the flow settles. */
	const signInPanel = () =>
		signingIn && provider.signedIn !== true
			? el("div", { class: "signin-live" }, [
					el("p", { class: "sub", text: signIn.instructions ?? "在浏览器里完成授权…" }),
					signIn.url
						? el("div", { class: "row" }, [
								el("a", { class: "url", href: signIn.url, target: "_blank", rel: "noreferrer", text: signIn.url }),
								el("button", {
									text: "复制",
									onClick: () => navigator.clipboard?.writeText(signIn.url).then(() => toast("已复制链接")),
								}),
							])
						: el("p", { class: "sub", text: "正在准备授权链接…" }),
					el("button", {
						text: "取消登录",
						onClick: () =>
							run(`cancel:${provider.id}`, async () => {
								const result = await api(`/providers/${provider.id}/signin`, { method: "DELETE" });
								delete state.signIns[provider.id];
								await refresh();
								return result;
							}),
					}),
				])
			: null;

	const modelRow = (model) =>
		el("div", { class: "row model" }, [
			el("span", { class: model.hidden ? "pill" : "pill ok", text: model.hidden ? "已隐藏" : "显示中" }),
			el("code", { text: model.id }),
			el("span", {
				class: "sub",
				text: [
					model.name !== model.id ? model.name : null,
					model.context ? `上下文 ${Math.round(model.context / 1000)}K` : null,
					model.maxOutput ? `输出 ${Math.round(model.maxOutput / 1000)}K` : null,
					model.reasoning ? (model.efforts.length > 0 ? `思考 ${model.efforts.join("/")}` : "支持思考") : null,
					model.vision ? "视觉" : null,
					model.tools ? "工具" : null,
					model.free ? "免费" : null,
				]
					.filter(Boolean)
					.join(" · "),
			}),
			el("label", { class: "row" }, [
				el("input", {
					type: "checkbox",
					checked: model.hidden ? undefined : "checked",
					disabled: busy(`hide:${provider.id}:${model.id}`),
					onChange: (event) =>
						run(`hide:${provider.id}:${model.id}`, async () => {
							const current = models.filter((entry) => entry.hidden).map((entry) => entry.id);
							const next = event.target.checked ? current.filter((id) => id !== model.id) : [...current, model.id];
							const result = await api(`/providers/${provider.id}/visibility`, { method: "PUT", body: { hidden: next } });
							await refresh();
							return result;
						}),
				}),
				el("span", { text: "显示" }),
			]),
		]);

	return el("section", { class: "card" }, [
		el("h2", {}, [
			el("span", { text: provider.label }),
			el("span", { class: "hint", text: provider.package ?? "" }),
		]),
		signInBlock(),
		signInPanel(),
		provider.listError ? el("p", { class: "sub", text: `上游提示：${provider.listError}` }) : null,
		provider.fellBack ? el("p", { class: "sub", text: "上游模型列表没读到，下面是插件自带的兜底清单。" }) : null,
		provider.signedIn === true
			? el("div", { class: "row" }, [
					el("span", { class: shown > 0 ? "pill ok" : "pill", text: `HanaAgent 里 ${shown} 个${hidden > 0 ? `（另有 ${hidden} 个已隐藏）` : ""}` }),
					el("span", { class: "sub", text: provider.baseUrl ?? "" }),
					el("span", { class: "spacer" }),
					el("button", {
						text: busy(`relist:${provider.id}`) ? "读取中…" : "重新读取模型",
						disabled: busy(`relist:${provider.id}`),
						onClick: () =>
							run(
								`relist:${provider.id}`,
								async () => {
									const result = await api(`/providers/${provider.id}?refresh=1`);
									await refresh();
									return result;
								},
								{ done: "已重新读取" },
							),
					}),
				])
			: null,
		...models.map(modelRow),
	]);
}

function render() {
	const root = document.getElementById("root");
	if (!root) return;
	// `replaceChildren` rebuilds the page, which would throw away the scroll position.
	const scroll = [window.scrollX, window.scrollY];
	const inner = [...root.querySelectorAll(".scroll")].map((node) => node.scrollTop);
	root.replaceChildren(
		...[
			headerSection(),
			el("p", {
				class: "sub",
				text:
					"每个供应商都是一个可独立安装的插件；登录态由插件自己换取与刷新，本页面只显示状态，不接触令牌。" +
					`桥接端口 ${state.bridge?.port ?? "?"}，与 magpie 的 3425 互不干扰。`,
			}),
			state.providers === undefined
				? el("p", { class: "sub", text: "正在读取桥接状态…" })
				: state.providers.length === 0
					? el("p", { class: "sub", text: "桥接里没有加载到任何供应商插件。" })
					: el("div", { class: "providers" }, state.providers.map(providerCard)),
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
void refresh();
