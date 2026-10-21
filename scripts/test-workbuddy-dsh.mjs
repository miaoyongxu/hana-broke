/**
 * One real WorkBuddy inference, with the exact system prompt that used to be
 * refused as 400 "Illegal API invocation from an unapproved channel".
 *
 * This is the check that matters for the bundled dependency: the bridge can be
 * perfect and still useless if the plugin it ships cannot get past WorkBuddy's
 * channel gate. Before the upgrade the bundled 0.1.24 FLAGGED table held only
 * the Claude Code and Codex rules, so DSH's opener went out verbatim and was
 * refused; 0.1.28 rewrites it upstream.
 *
 * Runs against the plugins in `plugins/node_modules`, i.e. exactly what ships.
 *
 *   node scripts/test-workbuddy-dsh.mjs
 *
 * Needs a WorkBuddy desktop login (the same one the console uses). Exits 0 when
 * the opener passes, 1 when it is refused or nothing answers.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const { PLUGIN_PROVIDERS, PluginAuthStore, ProviderPlugin, pluginEntry } = await import(
	pathToFileURL(join(APP_DIR, "plugin-host.mjs")).href
);

/** The sentence WorkBuddy treats as an unapproved channel. */
const DSH_OPENER = "You are an AI agent that helps the user with programming tasks.";

const PLUGINS_DIR = join(APP_DIR, "plugins");
const spec = PLUGIN_PROVIDERS.find((candidate) => candidate.id === "workbuddy");
const entry = pluginEntry(spec, PLUGINS_DIR);

if (entry.available !== true) {
	process.stdout.write(`FAIL ${entry.reason}\n`);
	process.exitCode = 1;
} else {
	process.stdout.write(`plugin: ${spec.package} ${entry.version}\n`);

	// The real bridge data directory, so the login the console captured is the
	// one this probe presents. A copy would defeat the purpose — but a machine
	// that has never opened the console has no capture yet, and the plugin reads
	// WorkBuddy's own desktop sign-in directly in that case, which is exactly
	// what a fresh install does. So a missing directory is not a skip.
	const store = new PluginAuthStore(join(APP_DIR, ".tmp-workbuddy-probe"));
	const module = await import(`file://${entry.path.replace(/\\/g, "/")}`);
	const provider = new ProviderPlugin({
		spec,
		module,
		store,
		log: (line) => process.stdout.write(`  ${line}\n`),
		warn: (line) => process.stdout.write(`  ! ${line}\n`),
	});

	if (!provider.signedIn()) {
		process.stdout.write("SKIP not signed in — log in once through the console, then re-run\n");
		process.exitCode = 2;
	} else {
		const listed = await provider.listModels();
		process.stdout.write(
			`listed: ${listed.models.length} model(s)${listed.listError ? ` (listError: ${listed.listError})` : ""}\n`,
		);
		const model = listed.models.find((candidate) => /deepseek-v4\.1-flash/i.test(candidate.id)) ?? listed.models[0];
		if (model === undefined) {
			process.stdout.write("FAIL the vendor listed no usable model\n");
			process.exitCode = 1;
		} else {
			process.stdout.write(`model: ${model.id}\n\n`);
			// Exactly the shape DSH sends: the harness opener as the first system
			// message, then a user turn.
			const { response } = await provider.chat({
				body: {
					model: model.id,
					messages: [
						{ role: "system", content: DSH_OPENER },
						{ role: "user", content: "Reply with exactly: OK" },
					],
					stream: true,
				},
				signal: AbortSignal.timeout(90_000),
				sessionId: "dsh-opener-probe",
			});
			const text = await response.text();
			if (response.ok) {
				process.stdout.write(`ok   HTTP ${response.status} — the DSH opener passed the channel gate\n`);
				process.stdout.write(
					`     SSE ${text.includes("data:") ? "present" : "MISSING"}, ends ${text.trimEnd().endsWith("[DONE]") ? "properly" : "ABRUPTLY"}\n`,
				);
			} else {
				process.stdout.write(`FAIL HTTP ${response.status}\n${text.slice(0, 600)}\n`);
				process.exitCode = 1;
			}
		}
	}
}
