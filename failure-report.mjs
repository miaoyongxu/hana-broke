/**
 * Turning a WorkBuddy rejection into the one sentence the user actually reads.
 *
 * HanaAgent surfaces exactly `error.message` from a failed response (see
 * `$lr()` in its bundle) and adds no context of its own, so this module owns
 * the whole user-facing explanation: whose fault it is, whether retrying can
 * help, and what to do instead.
 *
 * It is deliberately a separate, dependency-free module so the attribution
 * rules can be unit-tested — mis-blaming the user's network for a local
 * failure would be worse than saying nothing.
 *
 * @module hana-broke/failure-report
 */

/**
 * Parse the upstream's own reset timestamp out of a rejection body.
 *
 * WorkBuddy spells the deadline as `... will reset at 2026-10-14 23:21:18
 * UTC+8`, i.e. `UTC` followed by a signed hour offset rather than a timezone
 * name.
 *
 * @param {string} text raw upstream body
 * @returns {{ ms: number, label: string } | undefined}
 */
export function parseResetTime(text) {
	if (typeof text !== "string") return undefined;
	const match = /reset at (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC([+-]\d{1,2})(?::(\d{2}))?/i.exec(text);
	if (match === null) return undefined;
	const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
	const sign = offsetHour.startsWith("-") ? "-" : "+";
	const hh = String(Math.abs(Number(offsetHour))).padStart(2, "0");
	const mm = String(Number(offsetMinute ?? "0")).padStart(2, "0");
	const ms = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${hh}:${mm}`);
	if (!Number.isFinite(ms)) return undefined;
	const offset = `${offsetHour}${offsetMinute === undefined ? "" : `:${offsetMinute}`}`;
	return { ms, label: `${year}-${month}-${day} ${hour}:${minute}:${second} UTC${offset}` };
}

/** Trim a raw body so a message stays readable inside a chat bubble. */
export function trimRaw(text, limit = 400) {
	const collapsed = String(text).replace(/\s+/g, " ").trim();
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}

/** Structured facts pulled out of one upstream rejection. */
export function describeFailure(result) {
	const raw = typeof result?.message === "string" ? result.message : "";
	return {
		raw,
		code: /"code"\s*:\s*(\d+)/.exec(raw)?.[1],
		reset: parseResetTime(raw),
	};
}

/**
 * Build the message for one rejected call.
 *
 * Attribution rules, in order:
 *
 * 1. `status === 0` means the bridge never got an HTTP answer from WorkBuddy —
 *    the cause may genuinely be local (network, proxy, DNS), so this branch
 *    must not claim the problem is upstream-only.
 * 2. A real HTTP answer lets the bridge name the upstream class. Known classes
 *    (limit, credit, dead session, missing model, 5xx) are stated plainly.
 * 3. An unclassified 4xx is *not* attributed: an unsupported model parameter
 *    and a request this bridge built wrong look identical from here.
 *
 * WorkBuddy's own wording is always appended — it is the only text naming the
 * concrete limit, and it is what a maintainer needs from a bug report.
 *
 * @param {string} model model id the caller asked for
 * @param {{ ok: boolean, status: number, kind: string, message: string }} result upstream outcome
 * @returns {string} the text to place in `error.message`
 */
export function failureMessage(model, result) {
	const facts = describeFailure(result);
	const raw = facts.raw === "" ? "" : ` 上游原文：${trimRaw(facts.raw)}`;

	if (!(result?.status > 0)) {
		return (
			`桥接无法连接 WorkBuddy 服务端（模型 ${model}）：${trimRaw(facts.raw, 200)}。` +
			`这可能是本机网络/代理问题，也可能是 WorkBuddy 侧暂时不可达；模型本身和额度不受影响。`
		);
	}

	const upstream = "与本插件无关";
	switch (result.kind) {
		case "soft_rate":
			if (facts.reset !== undefined) {
				return (
					`WorkBuddy 服务端限流（${upstream}，也不是你的网络问题）：模型 ${model} 的使用频率/额度已用尽。` +
					`额度将在 ${facts.reset.label} 重置；在此之前重试不会成功，请改用其它模型。${raw}`
				);
			}
			return (
				`WorkBuddy 服务端短时限流（${upstream}，也不是你的网络问题）：请求过于频繁。` +
				`建议等待约 1 分钟后重试，或改用其它模型。${raw}`
			);
		case "session_dead":
			return `WorkBuddy 登录态已失效（${upstream}）：打开 WorkBuddy / WorkBuddy AI 桌面 App 重新登录一次，桥接会在下次复查时自动恢复。${raw}`;
		case "hard_credit":
			return `WorkBuddy 账号额度不足（${upstream}）：当前账号积分/配额已用尽，请到 WorkBuddy 客户端查看。${raw}`;
		case "not_found":
			return `WorkBuddy 服务端没有这个模型（${upstream}）：模型 ${model} 可能已下架，请刷新模型列表后重选。${raw}`;
		case "server":
			return `WorkBuddy 服务端故障（${upstream}，HTTP ${result.status}）：通常稍后自行恢复，可换模型或稍后重试。${raw}`;
		default:
			// `client`: WorkBuddy answered 4xx. Could be an unsupported model
			// parameter *or* a request the bridge built wrong — do not pin it.
			return `WorkBuddy 拒绝了这次请求（HTTP ${result.status}）：可能是该模型不支持的参数，也可能是桥接构造的请求有问题。反复出现请带上原文报 issue。${raw}`;
	}
}
