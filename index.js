/**
 * Hana Broke — HanaAgent v2 App entry.
 *
 * The App owns no WorkBuddy logic of its own. It is a **console** for the local
 * bridge (`dsh-workbuddy-connect`), which holds the credential, talks to the
 * upstream and writes the provider declaration. Keeping the split means there
 * is exactly one place that understands WorkBuddy's private protocol.
 *
 * Two things are specific to running as a v2 App instead of the v1 plugin:
 *
 * 1. **The bridge is a plain child process, not a managed runtime.** The host
 *    launches a managed runtime with a sanitized environment (`USERPROFILE`,
 *    `APPDATA` and `LOCALAPPDATA` all point into a scratch directory), and the
 *    bridge finds WorkBuddy's desktop login through exactly those variables.
 * 2. **The console is proxied, not embedded.** This AppHost child cannot open
 *    raw sockets, so every admin call goes out through `sdk.network.fetch`
 *    (loopback + `network.allowLocalhost` in the manifest). The page in
 *    `ui/panel.html` calls these routes through `hana.api.fetch`, so the
 *    bridge's bearer never has to reach the browser.
 *
 * The bridge is started through a hidden shell that clears `NODE_OPTIONS`; see
 * {@link shellLaunch} for why that is load-bearing rather than cosmetic. Its console output is captured into
 * the App data directory instead of being discarded, because a bridge that dies
 * during module loading writes no log of its own and `stdio: "ignore"` hides
 * exactly the failure you need to read.
 *
 * @module hana-broke/app
 */

import { defineApp } from "./sdk/app-contract/server-client.js";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "hana-broke";

/** This App's install directory (readable); the bridge script sits beside us. */
const APP_DIR = dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = join(APP_DIR, "bridge.mjs");
/**
 * What actually gets started.
 *
 * A thin wrapper that ignores console control events: the bridge was twice
 * killed by a stray Ctrl-C/Ctrl-Break (exit 3221225786, `STATUS_CONTROL_C_EXIT`)
 * seconds after a successful start, which takes the models offline for no
 * reason. See `bridge-launch.mjs`.
 */
const LAUNCH_SCRIPT = join(APP_DIR, "bridge-launch.mjs");

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = Number(process.env["WORKBUDDY_BRIDGE_PORT"] ?? 8788) || 8788;
const BRIDGE_ORIGIN = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;

/** A ping is a liveness question, not a data question: keep it short. */
const PING_TIMEOUT_MS = 8_000;
/** How long `apply` is willing to wait for a cold start before giving up. */
const START_WAIT_MS = 25_000;

/** POSIX single-quoting, so a path with spaces survives `/bin/sh -c`. */
function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Write the hidden launcher a Windows start goes through.
 *
 * The bridge has to start through a shell that clears `NODE_OPTIONS`, because
 * the AppHost hands every spawned child its own permission flags in that
 * variable: a plain `spawn` produces a child running under `--permission`,
 * which dies at its first `module.register()` (`ERR_ACCESS_DENIED`
 * `WorkerThreads`) and cannot even read `~/.dsh`. This is exactly the failure
 * v0.4.0 shipped with — a probe run outside the host looked clean, the probe
 * was the wrong environment, and every manual start died at boot.
 *
 * But `cmd.exe` as the direct child is also what made a console window flash
 * at every start: `detached` puts the child in its own console and
 * `windowsHide` does not cover that combination. `wscript.exe` is a GUI-subsystem
 * binary, so it never owns a console at all, and `WshShell.Run(…, 0, false)`
 * starts the shell with the window hidden. Hidden launcher, working
 * permission strip, no flash — all three at once.
 *
 * Split in two: {@link shellPlan} decides *what* would run and is pure, so the
 * diagnostics route can report the command line without touching the data
 * directory; this function persists the launcher and reports what to spawn.
 *
 * @param {string} appDataDir this App's writable directory; the script lives here
 * @param {string[]} argv arguments for the script (script path first)
 * @param {string} [scriptName] basename of the generated `.vbs`. The self-check
 *   probe passes its own name: it must not overwrite the launcher the bridge
 *   starts through, or the next start would spawn the probe instead.
 * @param {string|null} [redirectTo] file the shell appends the child's console
 *   to. Needed because `wscript.exe` is a GUI-subsystem binary: it has no stdio
 *   to hand down, so opening a log file and passing it as `spawn`'s stdio (what
 *   this App used to do) captures nothing once the VBScript sits in between.
 *   The redirect has to happen *inside* `cmd.exe`, which does have the handles.
 * @returns {{file: string, args: string[], verbatim: boolean}}
 */
function shellLaunch(appDataDir, argv, scriptName = "start-bridge-hidden.vbs", redirectTo = null) {
  const plan = shellPlan(appDataDir, argv, scriptName, redirectTo);
  if (plan.vbsPath === null) return plan.shell;
  try {
    // UTF-16LE with a BOM, not UTF-8. The Windows Script Host reads a `.vbs`
    // using the system ANSI code page unless the file declares otherwise, and a
    // UTF-8 BOM is not a declaration it accepts (it fails with "无效字符").
    // Writing UTF-8 silently corrupts every non-ASCII path in the file: on a
    // GBK (936) machine `桥接` becomes `妗ユ帴`, so the `.vbs` would launch the
    // bridge with a mangled `--hana-home`/`--data-dir` and the bridge would die
    // on startup. This is not hypothetical for this App's audience — a Windows
    // account name in Chinese puts non-ASCII into `%USERPROFILE%`, and every
    // path here is derived from it.
    writeFileSync(plan.vbsPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(plan.vbsText, "utf16le")]));
  } catch {
    // Fall back to the visible shell rather than failing the start entirely:
    // a working bridge with a window flash beats no bridge.
    return plan.shell;
  }
  return plan.launch;
}

/**
 * Decide how the child is started, without starting it or writing anything.
 *
 * On Windows the result is three things at once: the `cmd.exe` shell that
 * clears `NODE_OPTIONS`, the `.vbs` that runs it with no window, and the
 * `wscript.exe` that runs the `.vbs`.
 *
 * The VBScript matters more than it looks. `WshShell.Run` is
 * `Run(command, windowStyle, waitOnReturn)` — **three** arguments, with the
 * whole command line in the first one. Passing the executable and its
 * arguments as two separate strings, as this generator did, is a VBScript
 * argument-count error: `wscript` aborts before launching anything, the
 * launcher exits non-zero, and the bridge simply never starts. The visible
 * symptom is "启动后 25 秒内没有响应", which reads like a slow cold start and
 * is not one. Quoting the executable and keeping the argument text verbatim
 * inside one string is what `cmd.exe` expects on its own command line.
 *
 * @param {string} appDataDir this App's writable directory; the script lives here
 * @param {string[]} argv arguments for the script (script path first)
 * @param {string} scriptName basename of the generated `.vbs`
 * @param {string|null} redirectTo file the shell appends the child's console to
 * @returns {{shell: object, vbsPath: string|null, vbsText: string|null, launch: object|null,
 *   commandLine: string}}
 */
function shellPlan(appDataDir, argv, scriptName = "start-bridge-hidden.vbs", redirectTo = null) {
  if (process.platform !== "win32") {
    const command = ["unset NODE_OPTIONS;", "exec", shQuote(process.execPath), ...argv.map(shQuote)].join(" ");
    const shell = { file: "/bin/sh", args: ["-c", command], verbatim: false };
    return { shell, vbsPath: null, vbsText: null, launch: null, commandLine: `${shell.file} ${shell.args.join(" ")}` };
  }
  const root = process.env["SystemRoot"] ?? process.env["WINDIR"] ?? "C:\\Windows";
  const base = ['set "NODE_OPTIONS="', "&&", `"${process.execPath}"`, ...argv.map((value) => `"${value}"`)].join(" ");
  // `cmd.exe` does the redirect because it is the first thing in this chain with
  // real stdio handles; see the `redirectTo` note on {@link shellLaunch}. `>>`
  // keeps it append-only, matching what `openSync(…, "a")` used to do.
  const command = redirectTo === null ? base : `${base} >> ${quoteForCmd(redirectTo)} 2>&1`;
  // `windowsVerbatimArguments` keeps Node from re-quoting this command line
  // out from under cmd; the command deliberately starts with `set` rather than
  // a quote, which is the form cmd parses predictably.
  const shell = { file: join(root, "System32", "cmd.exe"), args: ["/d", "/c", command], verbatim: true };
  const vbsPath = join(appDataDir, scriptName);
  // One argument to `Run`, never two: see this function's comment.
  const commandLine = [`"${shell.file}"`, ...shell.args].join(" ");
  const vbsText =
    `' Generated by hana-broke; hidden launcher for the bridge.\r\n` +
    `CreateObject("WScript.Shell").Run ${vbsString(commandLine)}, 0, False\r\n`;
  return {
    shell,
    vbsPath,
    vbsText,
    // `//B` (batch mode) is load-bearing, not tidiness. `wscript` is the *windowed*
    // host, so a script error makes it put up a modal dialog and wait — measured:
    // a malformed `.vbs` never returns (still blocked at a 12 s timeout), while
    // `//B` exits in ~30 ms with status 1. Without it, any future mistake in this
    // generator reaches the user as a dialog box they cannot act on, which is
    // exactly the failure this App was reported for. `//B` does not weaken normal
    // runs: a valid script still executes and still returns 0.
    launch: { file: join(root, "System32", "wscript.exe"), args: ["//B", "//NoLogo", vbsPath], verbatim: false },
    commandLine,
  };
}

/** A path as `cmd.exe` wants it on a redirect target: quoted, quote-escaped. */
function quoteForCmd(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

/** A VBScript string literal: the payload with every quote doubled. */
function vbsString(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * The environment the bridge must see.
 *
 * The AppHost child is launched with only a handful of variables, and on
 * Windows `HOME` is normally absent entirely. `os.homedir()` still answers with
 * the real profile — the system API is the fallback once `USERPROFILE` is
 * missing — so the Windows directories can be reconstructed from it. That is
 * what makes WorkBuddy's desktop login reachable at all.
 */
function bridgeEnv() {
  const env = { ...process.env };
  const home = homedir();
  if (!env["HOME"]) env["HOME"] = home;
  if (!env["USERPROFILE"]) env["USERPROFILE"] = home;
  if (!env["LOCALAPPDATA"]) env["LOCALAPPDATA"] = join(home, "AppData", "Local");
  if (!env["APPDATA"]) env["APPDATA"] = join(home, "AppData", "Roaming");
  const tmp = tmpdir();
  if (!env["TMPDIR"]) env["TMPDIR"] = tmp;
  if (!env["TEMP"]) env["TEMP"] = tmp;
  if (!env["TMP"]) env["TMP"] = tmp;
  return env;
}

/* ── console settings ───────────────────────────────────────────────
 *
 * Persisted in this App's own data directory rather than through the bridge:
 * the whole point of manual mode is that the bridge may not be running, so the
 * preference has to be readable while there is nothing to ask.
 */

function readSettings(dataDir) {
	try {
		const parsed = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** Replace the stored settings atomically, so a crash mid-write cannot lose them. */
function writeSettings(dataDir, next) {
	const path = join(dataDir, "settings.json");
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	renameSync(temp, path);
	return next;
}

/**
 * Whether the bridge should come up on its own.
 *
 * Manual is the default: a console that starts a background process the moment
 * HanaAgent opens is a console that takes a decision away from the person using
 * it, and that decision is also what keeps a console window from appearing at
 * every startup. The page's「自动启动」switch writes `true` for people who want
 * the models ready without a click.
 */
function autoStartWanted(dataDir) {
	return readSettings(dataDir).autoStart === true;
}

/** One bridge, and the small amount of state the console needs about it. */
class Bridge {
  /**
   * @param {object} options
   * @param {string} options.hanaHome  the HanaAgent data directory
   * @param {string} options.dataDir   bridge state (profiles, visibility, endpoint)
   * @param {string} options.appDataDir this App's own writable directory
   * @param {(url: string, init?: object) => Promise<Response>} options.fetch
   * @param {(message: string) => void} options.note
   */
  constructor({ hanaHome, dataDir, appDataDir, fetch, note }) {
    this.hanaHome = hanaHome;
    this.dataDir = dataDir;
    this.appDataDir = appDataDir;
    this.logFile = join(dataDir, "bridge.log");
    this.childLog = join(appDataDir, "bridge-child.log");
    this.fetch = fetch;
    this.note = note;
    /** Why the last start attempt failed, surfaced by `/api/bridge`. */
    this.lastStartError = undefined;
    /** Start attempts are rare and short; a bounded ring is plenty. */
    this.events = [];
    /** When a start was last attempted, so the watchdog does not race one. */
    this.lastStartAt = 0;
    /** Set when the user stops the bridge on purpose; the watchdog respects it. */
    this.userStopped = false;
  }

  /** The bridge's own arguments, in one place. */
  bridgeArgv() {
    return [
      "--disable-warning=ExperimentalWarning",
      LAUNCH_SCRIPT,
      "--hana-home", this.hanaHome,
      "--data-dir", this.dataDir,
      "--port", String(BRIDGE_PORT),
      "--log-file", this.logFile,
    ];
  }

  record(kind, detail) {
    this.events.push({ at: new Date().toISOString(), kind, detail: String(detail).slice(0, 300) });
    if (this.events.length > 40) this.events.splice(0, this.events.length - 40);
  }

  /** Last lines of the child's captured output; empty is a normal answer. */
  childLogTail(lines = 120) {
    try {
      return readFileSync(this.childLog, "utf8").split(/\r?\n/).slice(-lines).join("\n");
    } catch {
      return "";
    }
  }

  /** What went in, and what the child process actually did. */
  diagnostics() {
    // Pure: this route must not rewrite the launcher as a side effect of being
    // read, and the old call here passed the arguments in the wrong slot.
    const plan = shellPlan(this.appDataDir, this.bridgeArgv());
    return {
      execPath: process.execPath,
      command: plan.commandLine,
      launchCommand: `${plan.launch?.file ?? plan.shell.file} ${(plan.launch?.args ?? plan.shell.args).join(" ")}`,
      bridgeScript: BRIDGE_SCRIPT,
      launchScript: LAUNCH_SCRIPT,
      scriptExists: existsSync(LAUNCH_SCRIPT),
      homedir: homedir(),
      cwd: this.hanaHome,
      nodeVersion: process.version,
      envKeys: Object.keys(process.env).sort(),
      childLog: this.childLog,
      events: this.events,
      childLogTail: this.childLogTail(),
    };
  }

  /**
   * Report what a child started exactly like the bridge actually inherits.
   *
   * This is the check that matters when the bridge "does not start": it shows
   * whether `NODE_OPTIONS` still carries the AppHost's permission model, and
   * whether the child can read the directories the bridge depends on.
   *
   * It runs the **whole** launcher — `wscript` → generated `.vbs` → `cmd.exe` →
   * node — rather than just the shell, because the failing step in 0.4.1 was the
   * `.vbs` itself: a malformed `WshShell.Run` aborts `wscript` before any child
   * exists, and a probe that skipped the VBScript would still have called that
   * launch path healthy. The probe reports through a file, not stdout: `wscript`
   * is a GUI-subsystem binary with no stdout to capture.
   */
  async selfCheck() {
    const probePath = join(this.appDataDir, "selfcheck.cjs");
    const outPath = join(this.appDataDir, "selfcheck.json");
    const home = homedir();
    const probeSource = [
      'const fs = require("node:fs");',
      'const out = { nodeOptions: process.env.NODE_OPTIONS ?? null, permission: process.permission ? Object.keys(process.permission) : null };',
      `try { fs.accessSync(${JSON.stringify(join(home, ".dsh"))}); out.readDsh = "ok"; } catch (e) { out.readDsh = e.code; }`,
      'try { new (require("node:worker_threads").Worker)("0", { eval: true }).terminate(); out.worker = "ok"; } catch (e) { out.worker = e.code; }',
      'try { const s = require("node:net").createServer(); s.listen(0, "127.0.0.1", () => s.close()); out.net = "ok"; } catch (e) { out.net = e.code; }',
      `fs.writeFileSync(${JSON.stringify(outPath)}, JSON.stringify(out), "utf8");`,
    ].join("\n");
    // Its own script name: writing the probe over `start-bridge-hidden.vbs`
    // would make the next real start run the probe instead of the bridge.
    const launch = shellLaunch(this.appDataDir, [probePath], "selfcheck-hidden.vbs");
    try {
      writeFileSync(probePath, probeSource, "utf8");
      rmSync(outPath, { force: true });
    } catch (error) {
      return { command: `${launch.file} ${launch.args.join(" ")}`, error: String(error) };
    }
    const result = spawnSync(launch.file, launch.args, {
      env: bridgeEnv(),
      encoding: "utf8",
      timeout: 20_000,
      windowsVerbatimArguments: launch.verbatim,
    });
    // `Run(..., 0, False)` does not wait, so poll briefly for the probe's file
    // instead of assuming it is there the moment `wscript` returns. Sleeping
    // rather than blocking: this runs inside the host's event loop.
    let stdout = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        stdout = readFileSync(outPath, "utf8");
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    return {
      command: `${launch.file} ${launch.args.join(" ")}`,
      status: result.status,
      stdout: stdout.trim().slice(0, 900),
      stderr: (result.stderr ?? "").trim().slice(0, 400),
      error: result.error ? String(result.error) : null,
    };
  }

  /**
   * Call one bridge admin route.
   *
   * The port and bearer are fixed rather than read from the bridge's
   * `endpoint.json`: that file lives under `plugin-data/`, outside this App's
   * read roots, and the bridge's own defaults are exactly this pair.
   *
   * @returns {Promise<{ok: boolean, running: boolean, status?: number, body?: any, error?: string}>}
   */
  async call(path, options = {}) {
    const query = options.query && Object.keys(options.query).length > 0 ? `?${new URLSearchParams(options.query).toString()}` : "";
    const headers = {};
    if (options.body !== undefined) headers["content-type"] = "application/json";
    try {
      const response = await this.fetch(`${BRIDGE_ORIGIN}/admin${path}${query}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        timeoutMs: options.timeoutMs ?? 120_000,
        cacheTtlMs: 0,
      });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text.slice(0, 400) };
      }
      return { ok: response.ok === true, running: true, status: response.status, body };
    } catch (error) {
      // A refused connection is the normal "not running" case, not an error
      // worth a stack trace on the page.
      return { ok: false, running: false, error: String(error?.message ?? error) };
    }
  }

  /** Whether the bridge answers right now. */
  async ping() {
    const result = await this.call("/status", { timeoutMs: PING_TIMEOUT_MS });
    return result.running ? { running: true, body: result.body } : { running: false, error: result.error };
  }

  /**
   * Start the bridge and wait until it answers.
   *
   * Detached: the bridge must outlive this App's process tree, and its own
   * `--log-file` (under `plugin-data/`, which only the unsandboxed child can
   * write) is what the page's log view reads.
   */
  async start({ waitMs = START_WAIT_MS, byWatchdog = false } = {}) {
    // An explicit start means the user wants it up. The watchdog passes
    // `byWatchdog` so it never resurrects a bridge the user stopped on purpose.
    if (!byWatchdog) this.userStopped = false;
    this.lastStartAt = Date.now();
    if ((await this.ping()).running) return { started: false, alreadyRunning: true };
    if (!existsSync(LAUNCH_SCRIPT)) {
      this.lastStartError = `找不到桥接启动脚本：${LAUNCH_SCRIPT}`;
      return { started: false, error: this.lastStartError };
    }

    // Capturing the child's console is the difference between "it did not
    // start" and knowing why. It cannot be done through `spawn`'s stdio any
    // more: `wscript.exe` sits between this process and the bridge and is a
    // GUI-subsystem binary, so it hands no handles down and the log stayed
    // empty. `cmd.exe` appends the output itself instead (see `shellPlan`).
    //
    // The redirect is only added when its target is known to be usable: `cmd.exe`
    // refuses to run the command at all when a redirect target cannot be opened,
    // which would turn a logging problem into the very "bridge will not start"
    // symptom this App exists to avoid. So the directory is created and the file
    // is opened once (catching a missing dir, a permission problem and a lock).
    // The `isDirectory` test is not redundant: on Windows `openSync(dir, "a")`
    // *succeeds*, so opening alone would happily approve a redirect that cmd then
    // refuses. Losing the log is survivable; losing the bridge is not.
    //
    // `%` is rejected for the same reason as a directory: the path reaches cmd
    // as text, so `%NAME%` inside it would be expanded into something else and
    // the redirect would point at a path that does not exist. A `%` in the real
    // path is vanishingly unlikely here, and skipping the log keeps the start
    // working; there is no way to escape it that survives `cmd /c`.
    let redirectTo = null;
    try {
      mkdirSync(dirname(this.childLog), { recursive: true });
      if (existsSync(this.childLog) && statSync(this.childLog).isDirectory()) {
        throw new Error("日志路径被同名目录占用");
      }
      if (this.childLog.includes("%")) {
        throw new Error("日志路径含 %，cmd 会把它当变量展开");
      }
      closeSync(openSync(this.childLog, "a"));
      redirectTo = this.childLog;
    } catch (error) {
      this.record("log-unavailable", `日志将不会捕获：${String(error?.message ?? error)}`);
    }

    const launch = shellLaunch(this.appDataDir, this.bridgeArgv(), "start-bridge-hidden.vbs", redirectTo);
    let child;
    try {
      child = spawn(launch.file, launch.args, {
        // Deliberately *not* APP_DIR. On Windows a directory that is any live
        // process's working directory cannot be removed, so a bridge running
        // with the App's own install directory as its cwd makes every
        // uninstall and reinstall fail with EBUSY — the App can end up
        // impossible to update. Every path the bridge uses is absolute, so the
        // working directory is free to be somewhere durable.
        cwd: this.hanaHome,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: bridgeEnv(),
        windowsVerbatimArguments: launch.verbatim,
      });
    } catch (error) {
      this.lastStartError = `启动失败：${String(error?.message ?? error)}`;
      this.record("spawn-threw", this.lastStartError);
      return { started: false, error: this.lastStartError };
    }

    this.record("spawned", `${launch.file} ${launch.args.join(" ")}`);
    child.on("error", (error) => {
      this.lastStartError = `子进程错误：${String(error?.message ?? error)}`;
      this.record("child-error", this.lastStartError);
    });
    child.on("exit", (code, signal) => {
      this.record("child-exit", `code=${code} signal=${signal}`);
    });
    child.unref();
    this.note(`hana-broke: started bridge pid ${child.pid}`);

    const deadline = Date.now() + waitMs;
    for (;;) {
      if ((await this.ping()).running) return { started: true, alreadyRunning: false };
      if (Date.now() > deadline) {
        // Not necessarily fatal: the first catalog sync can outlast this
        // budget and the bridge will start answering on its own.
        this.lastStartError = `启动后 ${Math.round(waitMs / 1000)} 秒内没有响应，可能还在首次同步，详见 ${this.logFile}`;
        return { started: false, pending: true, error: this.lastStartError };
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }

  /** Ask the bridge to stop (it exits by itself; no PID guessing here). */
  async stop() {
    this.userStopped = true;
    const result = await this.call("/shutdown", { method: "POST", body: {}, timeoutMs: 10_000 });
    if (!result.running) return { stopped: false, error: "桥接本来就没有在运行" };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (!(await this.ping()).running) return { stopped: true };
    }
    return { stopped: false, error: "桥接没有在 8 秒内退出" };
  }

  /** What the console shows about the bridge itself. */
  async describe() {
    const pinged = await this.ping();
    const reported = pinged.running ? pinged.body?.bridge ?? {} : {};
    return {
      running: pinged.running,
      ...(pinged.running ? {} : { error: pinged.error }),
      endpoint: {
        host: reported.host ?? BRIDGE_HOST,
        port: reported.port ?? BRIDGE_PORT,
        pid: reported.pid ?? null,
        pluginLib: reported.pluginLib ?? null,
        dataDir: reported.dataDir ?? this.dataDir,
        logFile: reported.logFile ?? this.logFile,
      },
      script: BRIDGE_SCRIPT,
      dataDir: this.dataDir,
      scriptExists: existsSync(LAUNCH_SCRIPT),
      lastStartError: this.lastStartError ?? null,
      diagnostics: this.diagnostics(),
    };
  }
}

export default defineApp(async (sdk) => {
  await sdk.logger.info("hana-broke loaded");

  // dataDir is <hanaHome>/app-data/<appId>; the bridge keeps its state in the
  // same place the v1 plugin used, so existing profiles and visibility carry
  // over instead of being orphaned.
  const hanaHome = dirname(dirname(sdk.dataDir));
  const bridge = new Bridge({
    hanaHome,
    dataDir: join(hanaHome, "plugin-data", "workbuddy-bridge"),
    appDataDir: sdk.dataDir,
    fetch: (url, init) => sdk.network.fetch(url, init),
    note: (message) => void sdk.logger.info(message),
  });

  // Bring the bridge up without letting a slow cold start fail the App — but
  // only when the user asked for it. Manual mode (the default) leaves it down
  // until the console's「启动桥接」is pressed, which is also why no console
  // window appears when HanaAgent starts.
  if (autoStartWanted(sdk.dataDir)) {
    bridge.start().catch((error) => {
      bridge.lastStartError = String(error?.message ?? error);
      bridge.record("start-threw", bridge.lastStartError);
      void sdk.logger.warn(`hana-broke: bridge start threw: ${bridge.lastStartError}`);
    });
  } else {
    bridge.record("skip-autostart", "手动桥接模式：等待页面里点击启动");
    void sdk.logger.info("hana-broke: 手动桥接模式，桥接等待手动启动");
  }

  // The bridge is a long-lived process, and nothing else brings it back if it
  // dies — an AppHost reload, a killed process group, a crash. Without this the
  // models silently stop answering until someone notices and clicks a button.
  const WATCHDOG_MS = 60_000;
  const watchdog = setInterval(async () => {
    try {
      if (bridge.userStopped) return;
      // Manual mode means the user decides when the bridge runs, including "not
      // yet": resurrecting it would quietly undo their choice every minute.
      if (!autoStartWanted(sdk.dataDir)) return;
      // A start in flight (or one that just finished) already covers this tick.
      if (Date.now() - bridge.lastStartAt < 90_000) return;
      if ((await bridge.ping()).running) return;
      bridge.record("watchdog", "bridge was down; starting it again");
      await bridge.start({ waitMs: 20_000, byWatchdog: true });
    } catch (error) {
      bridge.record("watchdog-error", String(error?.message ?? error));
    }
  }, WATCHDOG_MS);
  if (typeof watchdog.unref === "function") watchdog.unref();

  await sdk.routes.register((app) => {
    /** Forward one admin route, turning "not running" into a normal JSON answer. */
    const forward = async (c, path, options = {}) => {
      let body;
      if (options.body === true) {
        try {
          body = await c.req.json();
        } catch {
          return c.json({ ok: false, error: "请求体不是合法 JSON" }, 400);
        }
      }
      const result = await bridge.call(path, {
        method: options.method,
        body,
        query: c.req.query(),
        timeoutMs: options.timeoutMs,
      });
      if (!result.running) {
        return c.json({ ok: false, running: false, error: result.error ?? "桥接没有在运行" }, 200);
      }
      return c.json({ running: true, ...result.body }, result.ok ? 200 : result.status ?? 502);
    };

    app.get("/api/bridge", async (c) => c.json(await bridge.describe()));
    app.get("/api/settings", (c) => c.json({ ok: true, autoStart: autoStartWanted(sdk.dataDir) }));
    app.put("/api/settings", async (c) => {
      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ ok: false, error: "请求体不是合法 JSON" }, 400);
      }
      const next = writeSettings(sdk.dataDir, { ...readSettings(sdk.dataDir), autoStart: body?.autoStart === true });
      return c.json({ ok: true, autoStart: next.autoStart === true });
    });
    app.post("/api/bridge/start", async (c) => {
      const result = await bridge.start();
      return c.json({ ok: result.error === undefined, ...result });
    });
    app.post("/api/bridge/stop", async (c) => {
      const result = await bridge.stop();
      return c.json({ ok: result.error === undefined, ...result });
    });
    app.get("/api/bridge/diagnostics", (c) => c.json(bridge.diagnostics()));
    app.get("/api/bridge/selfcheck", async (c) => c.json(await bridge.selfCheck()));

    app.get("/api/status", (c) => forward(c, "/status", { timeoutMs: 30_000 }));
    app.get("/api/credits", (c) => forward(c, "/credits", { timeoutMs: 60_000 }));
    app.get("/api/models", (c) => forward(c, "/models", { timeoutMs: 90_000 }));
    app.post("/api/refresh", (c) => forward(c, "/refresh", { method: "POST", timeoutMs: 120_000 }));
    app.get("/api/visibility", (c) => forward(c, "/visibility", { timeoutMs: 30_000 }));
    app.put("/api/visibility", (c) => forward(c, "/visibility", { method: "PUT", body: true, timeoutMs: 120_000 }));
    app.get("/api/profiles", (c) => forward(c, "/profiles", { timeoutMs: 60_000 }));
    app.post("/api/profiles", (c) => forward(c, "/profiles", { method: "POST", body: true, timeoutMs: 60_000 }));
    app.post("/api/profiles/activate", (c) => forward(c, "/profiles/activate", { method: "POST", body: true, timeoutMs: 120_000 }));
    app.delete("/api/profiles", (c) => forward(c, "/profiles", { method: "DELETE", body: true, timeoutMs: 30_000 }));
    app.post("/api/probe", (c) => forward(c, "/probe", { method: "POST", body: true, timeoutMs: 180_000 }));
    // OpenCode free models: reachability per model. `?refresh=1` re-measures every
    // model, which is slow by design (each probe is a real request), hence the
    // generous budget; the cached answer returns immediately.
    app.get("/api/opencode", (c) => forward(c, "/opencode", { timeoutMs: 600_000 }));
    app.put("/api/opencode/visibility", (c) => forward(c, "/opencode/visibility", { method: "PUT", body: true, timeoutMs: 300_000 }));
    app.get("/api/log", (c) => forward(c, "/log", { timeoutMs: 15_000 }));

    app.get("/health", (c) => c.json({ ok: true, app: "hana-broke" }));
  });

  await sdk.logger.info("hana-broke ready");
});
