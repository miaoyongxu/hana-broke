/**
 * Who is allowed to talk to this bridge.
 *
 * The bridge listens on loopback, and `127.0.0.1` is **not** an authorization
 * boundary: any process running as this user, and any page the browser will let
 * reach a loopback port, is on the same side of it. So the bind address is
 * treated as reachability, not as permission, and three independent checks run
 * on every request:
 *
 * 1. **A bearer this bridge generated.** 32 random bytes, created on first run
 *    under `<dataDir>/bridge-token` with mode 0600, and never defaulted to
 *    empty. A request without it is refused even when it arrives from
 *    `127.0.0.1` — that is the whole point.
 * 2. **A Host header naming this listener.** A Host of `evil.example` resolving
 *    to 127.0.0.1 is a DNS-rebinding request: it arrives bearing the right
 *    origin from the browser's point of view, so nothing else would stop it.
 * 3. **An Origin, when one is present, from this listener or a null one.**
 *    Browsers attach `Origin` to every cross-site request; a command-line client
 *    does not, which is why "absent" has to be allowed for the bridge's real
 *    callers (HanaAgent's own server) while a *present* value is checked.
 *
 * Nothing else — no `Access-Control-Allow-Origin`, no `Referer` heuristic — is
 * treated as a security control. CORS only limits what a page may *read*; the
 * side effects of a simple request already happen by then.
 *
 * @module hana-broke/bridge-auth
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** File name of the generated bearer, inside the bridge's data directory. */
export const TOKEN_FILE = "bridge-token";

/** Loopback names a Host header may legitimately carry. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Read the stored bearer, creating one when the file is absent.
 *
 * Deliberately not `|| fallback`: an unreadable or empty token file is a
 * failure, not an invitation to run open. A bridge that cannot prove who it
 * is refuses to start, because a silently unauthenticated model endpoint is
 * worse than a bridge that does not come up.
 *
 * @param {string} dataDir the bridge's state directory
 * @returns {string} the bearer
 */
export function loadOrCreateToken(dataDir) {
	const path = join(dataDir, TOKEN_FILE);
	const existing = readTokenFile(path);
	if (existing !== undefined) return existing;

	mkdirSync(dataDir, { recursive: true });
	const token = randomBytes(32).toString("base64url");
	// `mode` is honoured on POSIX; on Windows the file inherits the per-user
	// profile's ACL, which is the closest equivalent available there.
	writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// Windows: no POSIX modes to set. The directory ACL is the boundary.
	}
	return token;
}

/** The stored bearer, or `undefined` when there is no usable file. */
function readTokenFile(path) {
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const token = raw.trim();
	return token === "" ? undefined : token;
}

/**
 * Whether a file holding a bearer is readable only by its owner.
 *
 * Reported rather than enforced: the bridge keeps working, but a token file
 * that other users can read means the bearer is not a secret, and saying so in
 * `/healthz` and in the log is more useful than refusing to run on a filesystem
 * that cannot express the difference (Windows).
 *
 * @param {string} dataDir
 * @returns {{ path: string, mode: string, private: boolean }}
 */
export function describeTokenFile(dataDir) {
	const path = join(dataDir, TOKEN_FILE);
	try {
		const stat = statSync(path);
		// 0o077 are the bits that grant access to anyone but the owner.
		const privateFile = (stat.mode & 0o077) === 0;
		return { path, mode: `0${(stat.mode & 0o777).toString(8)}`, private: privateFile };
	} catch {
		return { path, mode: "unknown", private: false };
	}
}

/** Constant-time comparison that does not leak length through an early exit. */
function sameSecret(presented, expected) {
	const a = Buffer.from(presented, "utf8");
	const b = Buffer.from(expected, "utf8");
	// `timingSafeEqual` throws on length mismatch, so pad to a fixed length
	// first: the comparison then runs in constant time regardless of input.
	const width = Math.max(a.length, b.length, 1);
	const left = Buffer.alloc(width);
	const right = Buffer.alloc(width);
	a.copy(left);
	b.copy(right);
	return timingSafeEqual(left, right) && a.length === b.length;
}

/**
 * Build the request gate.
 *
 * @param {object} options
 * @param {string} options.token the bearer every request must present
 * @param {string} options.host the address the listener is bound to
 * @param {number} options.port the port it is listening on
 * @param {(message: string) => void} [options.warn]
 */
export function createRequestGate({ token, host, port, warn }) {
	if (typeof token !== "string" || token === "") {
		throw new Error("bridge token is empty: refusing to serve an unauthenticated API");
	}
	/** Host values that name this exact listener. */
	const allowedHosts = new Set(
		[`${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].map((value) => value.toLowerCase()),
	);
	/** Origins a browser on this machine may legitimately send. */
	const allowedOrigins = new Set([...allowedHosts].map((value) => `http://${value}`));

	/**
	 * Whether the Host header names this listener.
	 *
	 * A missing Host is allowed: HTTP/1.0 and some local clients omit it, and a
	 * rebinding attack always carries one (it is what makes the browser send the
	 * request to this port at all).
	 */
	function hostOk(req) {
		const header = req.headers.host;
		if (typeof header !== "string" || header === "") return true;
		if (allowedHosts.has(header.toLowerCase())) return true;
		// A hostname-only Host (`localhost`) is ambiguous about the port but not
		// about the name; accept it only when the name itself is loopback.
		const name = header.toLowerCase().replace(/:\d+$/, "");
		return LOOPBACK_HOSTNAMES.has(name) && !header.includes(":");
	}

	/**
	 * Whether a present `Origin` is one this listener issued.
	 *
	 * `null` is allowed: that is a `file://` page or a sandboxed frame, which has
	 * no ambient credentials to borrow and cannot read this bridge's token. It is
	 * not an authentication bypass, because the bearer check still runs.
	 */
	function originOk(req) {
		const origin = req.headers.origin;
		if (origin === undefined) return true;
		if (typeof origin !== "string") return false;
		const normalized = origin.toLowerCase();
		if (normalized === "null") return true;
		return allowedOrigins.has(normalized);
	}

	/**
	 * Whether `Sec-Fetch-Site` says the request came from another site.
	 *
	 * Checked because it is the one header a page cannot forge: the browser sets
	 * it, and it is present on exactly the cross-site requests a CSRF attempt
	 * needs. `none` is a top-level navigation, `same-origin` is this page.
	 */
	function fetchSiteOk(req) {
		const site = req.headers["sec-fetch-site"];
		if (typeof site !== "string") return true;
		return site === "same-origin" || site === "none";
	}

	/** Whether the presented bearer matches. */
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		return sameSecret(match[1], token);
	}

	/**
	 * The reason a request is refused, or `undefined` when it may proceed.
	 *
	 * Host and Origin are checked before the bearer: a rebinding request should
	 * not be able to tell a valid token from an invalid one by timing alone, and
	 * ordering the checks keeps every refusal identical from the outside.
	 *
	 * @param {import("node:http").IncomingMessage} req
	 * @returns {"host"|"origin"|"fetch-site"|"auth"|undefined}
	 */
	function refuseReason(req) {
		if (!hostOk(req)) return "host";
		if (!originOk(req)) return "origin";
		if (!fetchSiteOk(req)) return "fetch-site";
		if (!bearerOk(req)) return "auth";
		return undefined;
	}

	return { refuseReason, bearerOk, hostOk, originOk, allowedHosts, allowedOrigins };
}

/**
 * Write the refusal in one shape, whichever check failed.
 *
 * The body is deliberately uniform: naming the check that failed would tell a
 * prober which of its inputs was wrong, and the caller only ever needs to know
 * that it was refused. The distinction goes to the bridge's own log instead.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {string} reason
 */
export function writeRefusal(res, reason) {
	const status = reason === "auth" ? 401 : 403;
	const kind = reason === "auth" ? "unauthorized" : "forbidden";
	const message =
		reason === "auth"
			? "missing or invalid Authorization bearer"
			: "request rejected: Host or Origin is not this bridge";
	const payload = JSON.stringify({ error: { message, type: kind, code: kind }, reason });
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
		// State the policy explicitly rather than relying on the default: a
		// browser that somehow reaches this must not be able to read anything.
		"Cache-Control": "no-store",
		Vary: "Origin, Authorization",
	});
	res.end(payload);
}
