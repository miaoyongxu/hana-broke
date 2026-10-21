/**
 * Check the provider plugins this bundle ships, before the bundle ships.
 *
 * A plugin is not code this App owns: it is a package installed from npm,
 * vendored into `plugins/node_modules` and redistributed inside the zip. That
 * makes every defect in it this App's defect too — a user installs Hana Broke
 * and gets whatever the bundled copy does.
 *
 * The rules are easy to get wrong in both directions, so this asserts behaviour
 * rather than reading the source:
 *
 *  - a rule whose replacement equals its match rewrites nothing, and looks
 *    present in the source (`opencode-workbuddy-auth` 0.1.28 does exactly this
 *    for the DeepSeek Harness opener);
 *  - a lookbehind may block a sentence on purpose (`(?<!the )Codex CLI …` must
 *    not fire on "The Codex CLI …"), so a naive "does it change anything" test
 *    reports a working rule as broken.
 *
 * Each case below therefore states the sentence and what should happen to it.
 *
 *   node scripts/check-bundled-plugins.mjs
 *
 * Exits 0 when every case matches, 1 when one does not.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGINS_DIR = join(APP_DIR, "plugins");

/**
 * Cases per plugin: [label, sentence, expected].
 *
 * `"rewritten"` means the output must differ from the input; `"unchanged"` means
 * the plugin must leave it alone — which is a real requirement, not padding: a
 * rule that fires too broadly mangles prompts that were never a problem.
 */
const CASES = {
	"@magpie-community/opencode-workbuddy-auth": [
		["Claude Code opener", "You are Claude Code, Anthropic's official CLI for Claude.", "rewritten"],
		["Main branch note", "Main branch (you will usually use this for PRs)", "rewritten"],
		// No leading article: this is the form the rule targets.
		["Codex CLI sentence, no article", "Codex CLI is an open source project led by OpenAI.", "rewritten"],
		// With "The" in front the lookbehind must leave it alone, by design.
		["Codex CLI sentence after an article", "The Codex CLI is an open source project led by OpenAI.", "unchanged"],
		// An ordinary prompt must survive untouched.
		["an unrelated prompt", "You are a helpful assistant.", "unchanged"],
	],
};

const results = [];
function check(label, passed, detail) {
	results.push({ label, passed, detail });
	process.stdout.write(`${passed ? "ok  " : "FAIL"} ${label}${detail === undefined ? "" : ` — ${detail}`}\n`);
}

for (const [packageName, cases] of Object.entries(CASES)) {
	const root = join(PLUGINS_DIR, "node_modules", packageName);
	const entryPath = join(root, "index.mjs");
	process.stdout.write(`\n${packageName}\n`);

	let pkg;
	try {
		pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	} catch (error) {
		check(`${packageName} is installed`, false, String(error?.message ?? error));
		continue;
	}
	process.stdout.write(`  version ${pkg.version}\n`);

	const module = await import(pathToFileURL(entryPath).href);
	const unflagged = module?._internal?.unflagged;
	if (typeof unflagged !== "function") {
		check("exposes unflagged()", false, "cannot verify the rewriting rules without it");
		continue;
	}

	for (const [label, sentence, expected] of cases) {
		const output = unflagged(sentence);
		// `!==` is not enough. A rule whose replacement is the sentence plus a
		// full stop changes one character and rewrites nothing that matters —
		// which is exactly the shape of a dead rule that still looks alive. What
		// "rewritten" has to mean is that the gate's words are gone, so compare
		// the *words* after collapsing punctuation and case.
		const normalize = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
		const changed = output !== sentence;
		const wordsChanged = normalize(output) !== normalize(sentence);
		const wanted = expected === "rewritten";
		check(
			`${wanted ? "rewrites" : "leaves alone"}: ${label}`,
			wanted ? wordsChanged : !wordsChanged,
			wanted
				? wordsChanged
					? `-> ${output.slice(0, 48)}`
					: changed
						? `only punctuation changed (${JSON.stringify(output.slice(-24))}) — the words still match`
						: "sent through unchanged"
				: wordsChanged
					? `mangled -> ${output.slice(0, 48)}`
					: "clean",
		);
	}
}

process.stdout.write("\n");
const failed = results.filter((entry) => !entry.passed);
process.stdout.write(`${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length > 0) {
	process.stdout.write(
		`\nA failure here means the bundled copy does not do what its version claims.\n` +
			`Reinstall a version whose rules behave, or patch the vendored file and record\n` +
			`why in THIRD_PARTY_NOTICES.md — do not ship it as-is.\n`,
	);
	process.exitCode = 1;
}
