/**
 * Make a running HanaAgent server pick up the bridge's provider plugins.
 *
 * HanaAgent reads `provider-plugins/` once, when the provider registry is
 * constructed, and only calls `reload()` again after a provider change goes
 * through its own settings service. Writing the files alone therefore shows
 * nothing until the app restarts. Rather than ask the user to restart, this
 * module drives the same route the Settings → Models UI drives:
 * `PUT /api/config` with a `providers` patch, which writes the plugin, live
 * registers it, and reloads the registry.
 *
 * The call is strictly local (127.0.0.1, token from `server-info.json`) and is
 * skipped silently when no server is running.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveHanaHome } from "./hana-providers.mjs";

const REQUEST_TIMEOUT_MS = 15_000;

/** Read the running server's port and bearer token. */
function readServerInfo(hanaHome) {
	try {
		const parsed = JSON.parse(readFileSync(join(hanaHome, "server-info.json"), "utf8"));
		const port = parsed?.network?.actualPort ?? parsed?.port;
		const token = parsed?.token;
		if (typeof port !== "number" || port <= 0) return { error: "server-info.json has no usable port" };
		if (typeof token !== "string" || token === "") return { error: "server-info.json has no token" };
		return { port, token, version: parsed?.version };
	} catch (error) {
		return { error: `server-info.json unreadable: ${String(error)}` };
	}
}

/** One authenticated JSON request against the local server. */
async function request(base, token, path, init = {}) {
	const response = await fetch(`${base}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
			...(init.headers ?? {}),
		},
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const text = await response.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { ok: response.ok, status: response.status, body };
}

/** The model ids HanaAgent currently exposes, grouped by provider. */
export async function listAgentModels(options = {}) {
	const hanaHome = options.hanaHome ?? resolveHanaHome();
	const info = readServerInfo(hanaHome);
	if (info.error !== undefined) return { running: false, reason: info.error };
	const base = `http://127.0.0.1:${info.port}`;
	try {
		const health = await request(base, info.token, "/api/health");
		if (!health.ok) return { running: false, reason: `GET /api/health → ${health.status}` };
		const models = await request(base, info.token, "/api/models");
		if (!models.ok) return { running: true, reason: `GET /api/models → ${models.status}`, models: [] };
		return { running: true, port: info.port, models: Array.isArray(models.body?.models) ? models.body.models : [] };
	} catch (error) {
		return { running: false, reason: `server unreachable: ${String(error)}` };
	}
}

/**
 * Whether the running server currently exposes this provider.
 *
 * Used to decide whether an unchanged declaration still needs pushing: the
 * user can delete the provider from HanaAgent's own settings while the bridge
 * keeps running, and the bridge re-creates the file on the next sync. Without
 * this check the "declaration unchanged, skip the write" optimisation would
 * leave the model group missing until HanaAgent restarts.
 *
 * @param {string} id provider id
 * @param {{ hanaHome?: string }} [options]
 * @returns {Promise<boolean>}
 */
export async function providerRegistered(id, options = {}) {
	const state = await listAgentModels(options);
	return (state.models ?? []).some((model) => model.provider === id);
}

/**
 * Push one provider declaration into the running server.
 *
 * The patch uses the app's own snake_case config keys; the server converts it
 * to the provider-plugin file format itself, so the written file and the one
 * the bridge generated stay equivalent.
 *
 * @param {{ id: string, displayName: string, baseUrl: string, models: object[] }} provider
 * @param {{ hanaHome?: string }} [options]
 * @returns {Promise<{ applied: boolean, reason?: string, registered?: boolean }>}
 */
export async function applyProvider(provider, options = {}) {
	const hanaHome = options.hanaHome ?? resolveHanaHome();
	const info = readServerInfo(hanaHome);
	if (info.error !== undefined) return { applied: false, reason: info.error };
	const base = `http://127.0.0.1:${info.port}`;
	let health;
	try {
		health = await request(base, info.token, "/api/health");
	} catch (error) {
		return { applied: false, reason: `server unreachable: ${String(error)}` };
	}
	if (!health.ok) return { applied: false, reason: `GET /api/health → ${health.status}` };

	const patch = {
		[provider.id]: {
			display_name: provider.displayName,
			auth_type: "none",
			base_url: provider.baseUrl,
			api: "openai-completions",
			// Kept in the patch so the marker survives the server's own rewrite
			// of the provider-plugin file.
			...(provider.description === undefined ? {} : { description: provider.description }),
			models: provider.models,
		},
	};
	let saved;
	try {
		saved = await request(base, info.token, "/api/config", {
			method: "PUT",
			body: JSON.stringify({ providers: patch }),
		});
	} catch (error) {
		return { applied: false, reason: `PUT /api/config failed: ${String(error)}` };
	}
	if (!saved.ok) {
		const detail = typeof saved.body === "object" ? saved.body?.error : String(saved.body).slice(0, 200);
		return { applied: false, reason: `PUT /api/config → ${saved.status}${detail === undefined ? "" : `: ${detail}`}` };
	}
	const after = await listAgentModels({ hanaHome });
	const registered = (after.models ?? []).some((model) => model.provider === provider.id);
	return { applied: true, registered, port: info.port };
}
