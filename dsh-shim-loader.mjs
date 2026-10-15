/**
 * ESM resolve hook: point the plugin's `@deepseek-ai/dsh-atomic-write` import
 * at the local shim, because that package only exists inside the DeepSeek
 * Harness runtime, not on disk next to the plugin.
 *
 * Registered by `bridge.mjs` through `module.register()` before the plugin
 * chunk is imported. Every other specifier falls through to Node.
 */

const SHIM_URL = new URL("./dsh-atomic-write-shim.mjs", import.meta.url).href;
const SHIMMED = new Set(["@deepseek-ai/dsh-atomic-write"]);

export async function resolve(specifier, context, nextResolve) {
	if (SHIMMED.has(specifier)) return { url: SHIM_URL, shortCircuit: true };
	return nextResolve(specifier, context);
}
