/**
 * Launcher for the bridge.
 *
 * Why this exists at all: the bridge kept getting taken down by a console
 * control event aimed at something else entirely. Twice it died seconds after a
 * perfectly successful start, both times as exit code 3221225786
 * (`0xC000013A`, `STATUS_CONTROL_C_EXIT`) — and the second time it happened
 * while an unrelated command was running in a terminal, which is exactly the
 * kind of stray Ctrl-C / Ctrl-Break this guards against.
 *
 * A Node process that never registers a SIGINT handler terminates on that
 * event. Registering one is all it takes to stay up.
 *
 * This does not make the bridge unkillable, and it is not meant to:
 *
 * - `POST /api/bridge/stop` still shuts it down cleanly — that goes through the
 *   bridge's own `/admin/shutdown`, not through a signal.
 * - The OS can always kill the process.
 *
 * It only stops a signal that was never aimed at the bridge from silently
 * taking the WorkBuddy models offline.
 *
 * The bridge reads its arguments from `process.argv.slice(2)`, and this module
 * is imported rather than spawned, so that stays exactly as it was.
 *
 * @module hana-broke/bridge-launch
 */

process.on("SIGINT", () => {
  // Deliberately ignored: see the comment above.
});

process.on("SIGBREAK", () => {
  // Same, for Ctrl-Break.
});

await import("./bridge.mjs");
