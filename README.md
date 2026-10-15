# Hana Broke

> 每到周末和月末，总有一段难熬的日子。这个 App 把你**已经登录的 WorkBuddy / WorkBuddy AI
> 桌面账号**，连同 **OpenCode 的免费模型**，一起接进 HanaAgent —— 不花一分钱，先把这个月撑过去。

两个上游，一个控制台：

| 上游 | 从哪来 | 要钱吗 |
| --- | --- | --- |
| **WorkBuddy / WorkBuddy AI** | 你桌面 App 里已经登录的账号 | 复用桌面登录，不需要 API Key |
| **OpenCode 免费模型** | OpenCode 桌面版自带的 v2 CLI | 免费，无需登录 |

App 自己不实现任何 WorkBuddy 逻辑：协议、凭据、供应商声明都在上游
`dsh-workbuddy-connect` 里，这个 App 是它的**控制台 + HanaAgent 适配层**。

## 目录

- [Why it is built this way](#why-it-is-built-this-way) — 为什么桥接是子进程、为什么要清 `NODE_OPTIONS`
- [OpenCode free models](#opencode-free-models-second-upstream) — 免费模型那条线的全部实测结论
- [Layout](#layout) / [Releasing](#releasing) / [Diagnostics](#diagnostics) / [Known limits](#limits)

## Why it is built this way

The HanaAgent side of the WorkBuddy bridge. It owns no WorkBuddy logic: the
protocol, the credential and the provider declaration all live in
`dsh-workbuddy-connect`, and this App is a **console** for it.

A v2 App's `apply()` runs in an isolated Node child launched by the host with a
deliberately narrow environment. Two consequences shaped this App.

**The bridge is a child process, not a managed runtime.** A managed runtime is
re-launched with `USERPROFILE`, `APPDATA` and `LOCALAPPDATA` pointed into a
scratch directory, and the bridge finds WorkBuddy's desktop login through
exactly those variables. A `child_process.spawn` here does not go through that
sanitiser, and `os.homedir()` still answers with the real profile (Node falls
back to the system API once `USERPROFILE` is missing), so the Windows
directories can be rebuilt before spawning.

**The bridge is started through a shell that clears `NODE_OPTIONS`.** This is
load-bearing, not cosmetic. Node hands every spawned child the AppHost's own
permission flags in `NODE_OPTIONS`, and it appends them *after* whatever the
parent passes — so the parent can neither see nor strip them. A plain `spawn`
therefore yields a child running under `--permission` with the AppHost's read
roots, which:

- dies at the bridge's first `module.register()` — its ESM loader hook needs a
  worker thread, and Node refuses (`ERR_ACCESS_DENIED`, permission
  `WorkerThreads`);
- cannot read `~/.dsh` or `~/.hanako` even if it survives that;
- breaks the **WorkBuddy key helper** the bridge runs to open the at-rest
  encrypted tokens. That helper is WorkBuddy's own Electron binary, it rejects
  the unknown flags, and it exits 9 — which silently turns a signed-in account
  into `signed-out` with no error on the page.

Widening the child's permissions is the wrong answer: it does not stop the
flags reaching the helper. The documented contract for an authorized
`app/process.spawn` child is that external commands are not restricted by the
AppHost's model, so the script goes through `cmd.exe` (`/bin/sh` elsewhere) with
`NODE_OPTIONS` cleared. `windowsVerbatimArguments` keeps Node from re-quoting
the command line out from under cmd.

**The console is proxied, not embedded.** This AppHost child cannot open raw
sockets, so every admin call goes out through `sdk.network.fetch` (loopback +
`network.allowLocalhost` in the manifest). The page calls these routes through
`hana.api.fetch`, so the bridge's bearer never has to reach the browser.

**The child's console is captured.** `stdio: "ignore"` hides exactly the failure
you most need to read, and a bridge that dies during module loading writes no log
of its own. Output goes to `bridge-child.log` in the App data directory.

The capture cannot go through `spawn`'s stdio any more. Once `wscript.exe` sits
between this process and the bridge it hands nothing down, so opening the log
file and passing it as the child's stdio silently captured nothing (verified with
`wscript` detached *and* not detached — the interpreter, not `detached`, is what
breaks it). `cmd.exe` appends the output itself instead (`>> "<log>" 2>&1`),
because it is the first thing in the chain with real stdio handles. The redirect
is added only after the target is proven usable — a missing directory, a
directory sitting at the log path, or a `%` in the path would make `cmd.exe`
refuse to run the command (or expand the name into something else), turning a
logging problem into a bridge that does not start.

The generated `.vbs` is written as **UTF-16LE with a BOM**. Windows Script Host
reads a script with the system ANSI code page unless the file declares otherwise,
and a UTF-8 BOM is not a declaration it accepts. Written as UTF-8, every
non-ASCII path in the file is silently corrupted — on a GBK machine `桥接`
becomes `妗ユ帴` — so the launcher would hand the bridge a mangled
`--hana-home`. A Chinese Windows account name is enough to trigger that, because
every path here derives from `%USERPROFILE%`.

**A watchdog keeps it up.** The bridge is a long-lived process and nothing else
brings it back if it dies — an AppHost reload, a killed process group, a crash.
A 60-second check restarts it when it stops answering, and skips that when the
user stopped it on purpose (`POST /api/bridge/stop` sets the flag, an explicit
start clears it). Without this the models silently stop answering until someone
notices.

## OpenCode free models (second upstream)

Alongside WorkBuddy, the bridge serves OpenCode's free models on
`/opencode/v1`, registered as a separate HanaAgent provider. It needs **no login**.

### Only the desktop app's v2 CLI can reach them

OpenCode gates its free tier server-side, and the gate is not about credentials:

| Path | Result |
| --- | --- |
| `https://opencode.ai/inference/v1/chat/completions` directly | **403** `FreeTierError` |
| v1 CLI (npm `opencode-ai`) — its `run` and its provider path | **403** `FreeTierError` |
| **v2 CLI bundled with the OpenCode desktop app**, over its own loopback API | **works** |

The 403 body reads *"OpenCode's free tier can only be used from within OpenCode."*
No bearer, `user-agent` or `x-opencode-*` header changes it — measured against the v1
CLI at 1.19.0 and at 1.18.34 (the version OW Bridge validated against), and against the
public endpoint with several header combinations. Listing is not gated: `/models`
answers 200 with 86 entries while every inference request is refused.

So `opencode-upstream.mjs` resolves `opencode-cli.exe` from
`%APPDATA%\ai.opencode.desktop\cli\<version>-<arch>\` (override with
`WORKBUDDY_OPENCODE_CLI`) and manages it under an isolated `XDG_*` home, so the user's
own OpenCode sessions and config are never touched. `WORKBUDDY_OPENCODE=0` turns the
whole upstream off.

### Two behaviours of that API that shape the code

1. `serve` prints `server password <PW>` on stdout and then requires HTTP Basic auth
   (`opencode:<PW>`) on every route.
2. **The first inference after startup always fails** (FreeTierError or RegionError);
   every request after it succeeds. `warmUp` spends it deliberately, and `chatStream`
   retries once if the warm-up did not land, so a user's first message is not the one
   that pays.

Fresh `serve` instances also default to `cat-jam-free`, which is region-blocked here —
which is why the warm-up selects a model from the catalog instead of using the default.

### Only reachable models are declared

The free roster is not a list of working models. On 2026-10-15 it held 11 entries of
which 4 never answered: `exo-free` is announced as `status: active` yet replies "has
been deprecated", `muse-spark-1.3-contributor-free` and `cat-jam-free` are refused with
"This model is not available in your country", and two `ling-…` models never respond.
Declaring those would put models in HanaAgent's picker that fail on every use, so each
one is probed once and the result is cached for 6h in
`<data-dir>/opencode/model-probe.json`. The panel lists every model with its reason.

The roster also drifts: two models that failed in one run worked in the next, and new
entries appear on their own.

### Choosing which models appear

The panel lists every model the upstream advertises, with a **显示** switch. A model that
is switched off is left out of the declaration pushed to HanaAgent, so it disappears from
the client's picker rather than merely being hidden on this page.

`重新探测并同步` does two things in one action, and the order matters: it re-measures
every model (one real request each), **then re-declares the provider**. Probing alone only
refreshed the panel — the declaration HanaAgent held kept the old roster, so a model that
had just become reachable still did not appear in a session until something else happened
to trigger a sync. The panel now reports the push result (`已同步给 HanaAgent：N 个模型`),
because whether HanaAgent accepted the change cannot be inferred from this page's own
state.

The same reasoning applies to WorkBuddy: `重新从上游拉取并同步` re-reads the catalog
**and** pushes the declaration. Re-reading alone only refilled the table on this page,
which is exactly why a refreshed roster never reached the session's model list.

### Tool calls, and the one thing that cannot be prevented

HanaAgent sends `tools` on essentially every request. OpenCode would normally **execute**
those calls itself, on this machine, and hand back a result for an action the client never
asked for. So the bridge asks the model for a JSON envelope instead
(`{"content": …, "calls": [{"name","arguments"}]}`) and turns `calls` into ordinary OpenAI
`tool_calls`. `WORKBUDDY_OPENCODE_TOOLS=0` disables tool use and keeps the models as
chat-only.

`format: json_schema` — the mechanism OW Bridge relies on — **does not work here**: with a
schema attached the model still answered in prose, and only a prompt-level instruction made
it comply. The reply is therefore parsed leniently (raw JSON, a fenced block, or the
outermost `{…}`), and a reply that ignores the envelope is returned as plain text rather
than failing the turn.

**The residual risk is real and worth stating plainly.** Every attempt to stop OpenCode
executing tools trips the free-tier gate, because the gate inspects the request's shape.
Measured 2026-10-15 — each of these turned *every* inference into
`403 FreeTierError: "can only be used from within OpenCode"`:

| Attempt | Result |
| --- | --- |
| a custom agent in the config | rejected |
| overriding the built-in `build` agent's `tools` | rejected |
| top-level `permission` deny (`permission` and `permissions[]` spellings) | rejected |
| `permission` when creating the session | accepted but **ignored** (`permission: null`) |

Only a completely stock configuration passes, and a stock OpenCode runs its own tools. In
practice the envelope instruction keeps it from doing so — across the measured runs no
local action occurred — but that is the model complying, not a sandbox. Two things reduce
the blast radius: the agent works in an empty scratch directory
(`<data-dir>/opencode/project`), so relative paths cannot reach the user's files; and any
local action that *does* happen is appended to the answer as a warning rather than hidden.

### Limits

- **Not token-streamed.** OpenCode's session API returns a finished message, so the
  reply is emitted as a single content delta behind an otherwise normal SSE stream.
- Tool calls depend on the model obeying the envelope instruction; a reply that ignores it
  is returned as text, so a turn may occasionally answer instead of acting.
- Model availability, quotas and this gate itself are upstream decisions that can
  change at any time — the v1 path already closed.

## Layout

| Path | Role |
| --- | --- |
| `index.js` | v2 entry: launch the bridge, register the `/api/*` admin proxy |
| `bridge.mjs` | the bridge process itself (upstream, unmodified), plus the `/opencode/v1` route |
| `opencode-upstream.mjs` | manages the OpenCode v2 CLI and adapts its session API to OpenAI chat-completions |
| `plugin.mjs`, `hana-*.mjs`, `*-api.mjs`, … | upstream bridge internals |
| `panel/` | the console as served by the bridge's own `/panel` route |
| `ui/panel.html` | the same console as an App page, talking to the proxy |
| `ui/assets/panel.js` | one file for both hosts: `hana.api.fetch` when the SDK resolves, plain `fetch` otherwise |
| `ui/assets/hana-theme.js` | mirrors the host's theme variables so the panel is not a foreign window |

`panel/panel.js` and `ui/assets/panel.js` are kept byte-identical on purpose —
the panel is a single file that adapts to its host, so a fix lands in both. The
theme layer lives beside them rather than inside them, which is what keeps that
possible.

## Releasing

1. Bump the version in `manifest.json` **and** `package.json`.
2. Bump the `?v=` query on the three assets in `ui/panel.html` to match. A
   WebView that keeps the old module in memory will otherwise keep painting the
   old UI after an update, which looks exactly like "the fix did not work".
3. `node scripts/pack_app.mjs --dir <app> --publisher miaoyongxu --out dist-extensions`
4. `node scripts/extension-index-build.mjs --entries dist-extensions --base-url https://github.com/miaoyongxu/hana-broke/releases/download/v<version> --source-id miaoyongxu --name "Hana Broke" --out dist-extensions/index.v2.json`
5. `gh release create v<version>` with the zip, the `.entry.json` and the new
   `index.v2.json` as assets. The custom source points at
   `releases/latest/download/index.v2.json`, so it picks the new index up on its
   own; every release still has to carry a freshly built one, because the
   archive URLs inside it are pinned to the tag.

## Diagnostics

- `GET /api/bridge` — running state, endpoint, last start error, and the launch
  events.
- `GET /api/bridge/diagnostics` — the exact command line used, `homedir()`,
  environment keys, and the tail of `bridge-child.log`.
- `GET /api/bridge/selfcheck` — starts a child exactly like the bridge and
  reports what it inherited: `NODE_OPTIONS`, whether `~/.dsh` is readable,
  whether a worker can be created, whether a socket can be bound.

## Known limits

- The bridge listens on `127.0.0.1:8788` with an open bearer. That matches the
  upstream defaults; the App cannot read the bridge's `endpoint.json` (it lives
  under `plugin-data/`, outside this App's read roots), so a bridge started with
  a **custom** `--port`/`--token` will not be found.
- `apply()` starts the bridge without blocking on it. A cold first catalog sync
  can outlast the wait budget; the page re-checks on demand.
- The theme layer only fills in the variables the host publishes. The panel's
  own `--warn` and `--accent-text` keep the panel's values, picked by the
  dark/light face inferred from the host background.
