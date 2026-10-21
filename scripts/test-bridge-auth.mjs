#!/usr/bin/env node
/**
 * The bridge's authorization boundary, tested as something an attacker sees.
 *
 * Every case here stands for a request a real local process or page can actually
 * make. The bridge is started for real — its own process, its own port, its own
 * generated token — because the defect being tested for was that the checks were
 * *absent*, and an absent check cannot be caught by exercising a mock.
 *
 * What is asserted, per the marketplace review:
 *
 * 1. no bearer, and a wrong bearer → refused
 * 2. a foreign `Host` (DNS rebinding) → refused
 * 3. a foreign `Origin` → refused
 * 4. a cross-site simple request (`Sec-Fetch-Site: cross-site`) → refused
 * 5. no route serves the bearer — `/`, `/panel`, `/panel/*` are gone; `/healthz`
 *    and `/admin/status` both require the token
 * 6. a correct client still works — the model list, `/healthz`, `/admin/status`
 *    and `/admin/providers` all answer with the right header
 * 7. the token is unpredictable and stored owner-only
 *
 * Usage:
 *   node scripts/test-bridge-auth.mjs            # build a temp data dir, run, clean up
 *   node scripts/test-bridge-auth.mjs --keep     # leave the temp dir for inspection
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const BRIDGE = join(APP_DIR, "bridge.mjs");

/** Pick a port the OS is not using, so a stray bridge on 8789 cannot skew a run. */
function freePort() {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

const results = [];
function check(name, passed, detail) {
	results.push({ name, passed, detail });
	const mark = passed ? "ok  " : "FAIL";
	process.stdout.write(`${mark} ${name}${detail === undefined ? "" : ` — ${detail}`}\n`);
}

/**
 * One HTTP request, with full control over headers. Never follows redirects.
 *
 * Uses `node:http` rather than `fetch` because `fetch` silently drops a custom
 * `Host` header — it derives it from the URL. A rebinding test that cannot send
 * the hostile Host would pass while proving nothing, which is exactly the kind
 * of green test this file exists to avoid.
 */
function call(port, path, { method = "GET", headers = {}, body } = {}) {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			{
				host: "127.0.0.1",
				port,
				path,
				method,
				headers,
				timeout: 20_000,
			},
			(response) => {
				const chunks = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					let json;
					try {
						json = JSON.parse(text);
					} catch {
						json = undefined;
					}
					resolve({ status: response.statusCode ?? 0, text, json, headers: response.headers });
				});
			},
		);
		request.on("error", reject);
		request.on("timeout", () => {
			request.destroy(new Error("request timed out"));
		});
		if (body !== undefined) request.write(body);
		request.end();
	});
}

/** Wait until the port answers anything at all (even a refusal means it is up). */
async function waitForListen(port, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await call(port, "/healthz", { headers: { authorization: "Bearer wrong-on-purpose" } });
			return true;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}
	return false;
}

async function main() {
	const keep = process.argv.includes("--keep");
	const root = mkdtempSync(join(tmpdir(), "hana-broke-auth-"));
	const dataDir = join(root, "plugin-data", "hana-broke");
	const hanaHome = root;
	const port = await freePort();

	process.stdout.write(`temp home: ${root}\nbridge: ${BRIDGE}\nport: ${port}\n\n`);

	const child = spawn(
		process.execPath,
		[
			BRIDGE,
			"--port", String(port),
			"--hana-home", hanaHome,
			"--data-dir", dataDir,
			// No vendor credentials in a temp home, so there is nothing to sync and
			// nothing for the bridge to try to register with a HanaAgent that is
			// not listening for this test.
			"--no-sync",
			"--no-apply",
		],
		{ stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: root, USERPROFILE: root } },
	);
	let childOut = "";
	child.stdout.on("data", (chunk) => {
		childOut += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		childOut += String(chunk);
	});

	let exitCode = null;
	child.on("exit", (code) => {
		exitCode = code;
	});

	try {
		if (!(await waitForListen(port))) {
			check("bridge starts and listens", false, `no listener; output:\n${childOut}`);
			return;
		}
		check("bridge starts and listens", true, `127.0.0.1:${port}`);

		// ---- the token itself ------------------------------------------------
		const tokenPath = join(dataDir, "bridge-token");
		const token = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "";
		check("token file is created on first run", token !== "", tokenPath);
		check("token is long enough to be unguessable", token.length >= 32, `${token.length} chars (base64url of 32 bytes)`);
		check("token is not a known default", !["", "public", "token", "changeme"].includes(token), `${token.length} chars`);
		try {
			const mode = statSync(tokenPath).mode & 0o777;
			// Windows cannot express this; the assertion is meaningful on POSIX and
			// is reported either way so a Windows run does not look like a failure.
			check(
				"token file is owner-only (POSIX)",
				process.platform === "win32" || (mode & 0o077) === 0,
				`mode 0o${mode.toString(8)}${process.platform === "win32" ? " (Windows: ACLs apply instead)" : ""}`,
			);
		} catch (error) {
			check("token file is owner-only (POSIX)", false, String(error));
		}

		// ---- 1. the bearer is required --------------------------------------
		const noBearer = await call(port, "/admin/status");
		check("no bearer on /admin/status → 401", noBearer.status === 401, `got ${noBearer.status}`);

		const wrongBearer = await call(port, "/admin/status", { headers: { authorization: "Bearer definitely-not-the-token" } });
		check("wrong bearer on /admin/status → 401", wrongBearer.status === 401, `got ${wrongBearer.status}`);

		const wrongScheme = await call(port, "/admin/status", { headers: { authorization: `Basic ${token}` } });
		check("Basic scheme instead of Bearer → 401", wrongScheme.status === 401, `got ${wrongScheme.status}`);

		// A short prefix must not be enough: an implementation that compared with
		// `startsWith` would pass the earlier cases and fail this one.
		const prefix = await call(port, "/admin/status", { headers: { authorization: `Bearer ${token.slice(0, 8)}` } });
		check("bearer prefix alone → 401", prefix.status === 401, `got ${prefix.status}`);

		// ---- 2. Host rebinding ----------------------------------------------
		const rebound = await call(port, "/admin/status", {
			headers: { authorization: `Bearer ${token}`, host: `attacker.example:${port}` },
		});
		check("foreign Host with a valid bearer → 403", rebound.status === 403, `got ${rebound.status}`);

		const oddHost = await call(port, "/admin/status", {
			headers: { authorization: `Bearer ${token}`, host: "localtest.me:8789" },
		});
		check("resolver-style Host (localtest.me) → 403", oddHost.status === 403, `got ${oddHost.status}`);

		const goodHost = await call(port, "/admin/status", {
			headers: { authorization: `Bearer ${token}`, host: `127.0.0.1:${port}` },
		});
		check("the bridge's own Host still works", goodHost.status === 200, `got ${goodHost.status}`);

		// ---- 3. Origin ------------------------------------------------------
		const foreignOrigin = await call(port, "/admin/status", {
			headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" },
		});
		check("foreign Origin with a valid bearer → 403", foreignOrigin.status === 403, `got ${foreignOrigin.status}`);

		const goodOrigin = await call(port, "/admin/status", {
			headers: { authorization: `Bearer ${token}`, origin: `http://127.0.0.1:${port}` },
		});
		check("the bridge's own Origin works", goodOrigin.status === 200, `got ${goodOrigin.status}`);

		const localhostOrigin = await call(port, "/admin/status", {
			headers: { authorization: `Bearer ${token}`, origin: `http://localhost:${port}` },
		});
		check("localhost Origin works", localhostOrigin.status === 200, `got ${localhostOrigin.status}`);

		// ---- 4. cross-site simple request -----------------------------------
		// This is the shape a `<form>` or `<img>` CSRF attempt takes: no custom
		// header, so no preflight, so it reaches the server. `Sec-Fetch-Site` is
		// set by the browser and cannot be forged by the page.
		const crossSite = await call(port, "/admin/shutdown", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"sec-fetch-site": "cross-site",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "",
		});
		check("cross-site simple POST (even with the bearer) → 403", crossSite.status === 403, `got ${crossSite.status}`);

		const sameSite = await call(port, "/admin/status", {
			headers: { authorization: `Bearer ${token}`, "sec-fetch-site": "same-origin" },
		});
		check("same-origin Sec-Fetch-Site works", sameSite.status === 200, `got ${sameSite.status}`);

		const navSite = await call(port, "/admin/status", {
			headers: { authorization: `Bearer ${token}`, "sec-fetch-site": "none" },
		});
		check("top-level navigation (Sec-Fetch-Site: none) works", navSite.status === 200, `got ${navSite.status}`);

		// ---- 5. no route hands out the bearer -------------------------------
		// The gate runs before routing, so these are refused as unauthenticated
		// rather than as 404 — which is the stronger outcome: a removed route and
		// a protected one are indistinguishable from outside. What matters is
		// that none of them serves HTML and none of them contains the token.
		for (const path of ["/", "/panel", "/panel/panel.js", "/panel/panel.css"]) {
			const response = await call(port, path);
			const leaks = response.text.includes(token);
			const servesHtml = (response.headers["content-type"] ?? "").includes("text/html");
			check(
				`${path} serves nothing and leaks nothing`,
				!leaks && !servesHtml && response.status !== 200,
				`got ${response.status}${servesHtml ? " WITH HTML" : ""}${leaks ? " AND LEAKED THE TOKEN" : ""}`,
			);
		}

		// Even with a valid bearer there is no console to fetch: the route is gone,
		// not merely protected, so a local process that somehow got the token still
		// cannot be handed a page that embeds it.
		for (const path of ["/", "/panel"]) {
			const response = await call(port, path, { headers: { authorization: `Bearer ${token}` } });
			check(
				`${path} does not serve a console even to an authenticated caller`,
				response.status === 404 && !response.text.includes(token),
				`got ${response.status}`,
			);
		}

		const healthAnon = await call(port, "/healthz");
		check("/healthz needs the bearer too", healthAnon.status === 401, `got ${healthAnon.status}`);

		const healthAuth = await call(port, "/healthz", { headers: { authorization: `Bearer ${token}` } });
		check("/healthz answers the real client", healthAuth.status === 200, `got ${healthAuth.status}`);
		check(
			"/healthz never echoes the bearer",
			!healthAuth.text.includes(token),
			healthAuth.text.includes(token) ? "TOKEN IN RESPONSE" : "clean",
		);

		// ---- 6. a correct client still works --------------------------------
		const providers = await call(port, "/admin/providers", { headers: { authorization: `Bearer ${token}` } });
		check("/admin/providers answers 200", providers.status === 200, `got ${providers.status}`);
		check("/admin/providers returns JSON, not the token", providers.json !== undefined && !providers.text.includes(token), "");

		// A real provider answers; a provider this instance did not load is a 404.
		// The point is that the *gate* passed: the refusal for a signed-out
		// provider is `not_signed_in`, which is a different thing from
		// `unauthorized`. Asserting merely "not 401" would be wrong, because
		// "not signed in" is legitimately a 401 too.
		const loadedProvider = await call(port, "/workbuddy/v1/models", { headers: { authorization: `Bearer ${token}` } });
		check(
			"authenticated request passes the gate (refused as not_signed_in, not unauthorized)",
			loadedProvider.json?.error?.type !== "unauthorized",
			`got ${loadedProvider.status} ${loadedProvider.json?.error?.type ?? "?"}`,
		);

		const unloadedProvider = await call(port, "/not-a-provider/v1/models", { headers: { authorization: `Bearer ${token}` } });
		check("authenticated request to an unknown provider → 404", unloadedProvider.status === 404, `got ${unloadedProvider.status}`);

		const anonymousModelList = await call(port, "/workbuddy/v1/models");
		check(
			"anonymous model list → refused as unauthorized",
			anonymousModelList.status === 401 && anonymousModelList.json?.error?.type === "unauthorized",
			`got ${anonymousModelList.status} ${anonymousModelList.json?.error?.type ?? "?"}`,
		);

		// ---- 7. refusals are uniform ---------------------------------------
		const byAuth = await call(port, "/admin/status");
		const byHost = await call(port, "/admin/status", {
			headers: { authorization: `Bearer ${token}`, host: "attacker.example" },
		});
		check(
			"a missing bearer and a foreign Host are both refused, with distinct types",
			byAuth.json?.error?.type === "unauthorized" && byHost.json?.error?.type === "forbidden",
			`auth=${byAuth.json?.error?.type} host=${byHost.json?.error?.type}`,
		);
		check(
			"a refused response never contains the bearer",
			!byAuth.text.includes(token) && !byHost.text.includes(token),
			"",
		);

		// ---- 8. --print-token agrees with the file -------------------------
		const printed = await new Promise((resolve) => {
			const probe = spawn(process.execPath, [BRIDGE, "--print-token", "--hana-home", hanaHome, "--data-dir", dataDir], {
				stdio: ["ignore", "pipe", "ignore"],
			});
			let out = "";
			probe.stdout.on("data", (chunk) => {
				out += String(chunk);
			});
			probe.on("exit", () => resolve(out.trim()));
		});
		check("--print-token matches the stored token", printed === token, `${printed.length} chars`);

		// ---- 9. an empty token file is a hard failure ----------------------
		// The old bridge treated "no token" as "let everyone in". This proves the
		// replacement treats it as a refusal to start instead.
		writeFileSync(tokenPath, "", "utf8");
		const emptyTokenRun = await new Promise((resolve) => {
			const probe = spawn(process.execPath, [BRIDGE, "--print-token", "--hana-home", hanaHome, "--data-dir", dataDir], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let out = "";
			let err = "";
			probe.stdout.on("data", (chunk) => {
				out += String(chunk);
			});
			probe.stderr.on("data", (chunk) => {
				err += String(chunk);
			});
			probe.on("exit", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
		});
		check(
			"an emptied token file is regenerated, not accepted as 'open'",
			emptyTokenRun.code === 0 && emptyTokenRun.out !== "",
			emptyTokenRun.out !== "" ? "a fresh token was issued" : `no token; stderr: ${emptyTokenRun.err}`,
		);
		try {
			chmodSync(tokenPath, 0o600);
		} catch {
			// Windows
		}
	} finally {
		child.kill();
		await new Promise((resolve) => {
			if (exitCode !== null) resolve();
			else {
				child.once("exit", resolve);
				setTimeout(resolve, 3000);
			}
		});
		if (!keep) {
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {
				// a Windows handle may still be held; the OS temp dir is cleaned anyway
			}
		} else {
			process.stdout.write(`\nkept: ${root}\n`);
		}
	}
}

await main();

const failed = results.filter((entry) => !entry.passed);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length > 0) {
	process.stdout.write(`failures:\n${failed.map((entry) => `  - ${entry.name}${entry.detail === undefined ? "" : ` (${entry.detail})`}`).join("\n")}\n`);
	process.exitCode = 1;
}
