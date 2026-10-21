# Hana Broke

> 每到周末和月末，总有一段难熬的日子。这个 App 把你**已经登录的那些订阅**——WorkBuddy /
> WorkBuddy AI、Qoder、OpenCode Zen 的免费额度——一起接进 HanaAgent。装这一个插件，
> 不用再装别的东西。

## 它是什么

一个桥接：HanaAgent 只讲 OpenAI 协议，而这些订阅各讲各的。App 在 `127.0.0.1:8789` 上起一个
服务器，把它们都变成 OpenAI 的形状，再把自己注册成 HanaAgent 的供应商。

**供应商不是这个 App 写的，是可安装的插件。** 每个订阅对应一个 npm 包——来自
[magpie](https://github.com/yetone/magpie) 的社区插件库，纯 JS、零依赖。这个 App 提供的是
驱动它们的宿主（登录、刷新、模型清单、一次请求），以及插件做不到的那部分：**怎么把供应商
正确注册进 HanaAgent**。

| 供应商 | 插件包 | 要什么 |
| --- | --- | --- |
| Qoder / Qoder CN | `opencode-qoder-auth` | 浏览器里登录一次（或 PAT） |
| WorkBuddy / WorkBuddy AI | `opencode-workbuddy-auth` | 桌面 App 已登录的账号 |
| OpenCode Zen 免费 | `opencode-zen-free-auth` | 什么都不用，key 就是 `public` |

没有 magpie 二进制，没有 53 MB 的 Go 程序，也没有需要单独下载的运行时。

### 为什么不直接用 magpie

它是独立 App，面向所有 agent：改别的 agent 的配置、管路由组、界面是它自己的。这个 App 只做
一件事——把订阅接进 HanaAgent，包括 HanaAgent 特有的那些规则（供应商声明读哪些字段、用户
删掉供应商后怎么不把它复活、模型列表怎么写）。

两者可以共存：magpie 的网关（`127.0.0.1:3425`）本身就是一个合格上游，在 HanaAgent 里加一个
指向它的供应商即可，与本 App 的 8789 互不干扰。**不要两边都指向同一份订阅再套娃**——同一份
额度会有两条路径，选哪个模型变成猜谜。

### 借了什么，出自哪里

这些不是这个 App 的原创，`THIRD_PARTY_NOTICES.md` 有完整记录：

- **供应商协议**：`@magpie-community/opencode-*-auth`，来自 magpie 及其社区插件库（MIT）。
  运行时依赖，原样安装、原样调用，不复制进这个仓库。
- **宿主契约**：读自 magpie 的 `internal/plugin/host.js`（MIT）。
- **HanaAgent 的模型字段名**：读自 HanaAgent 自己写出的声明文件，不是推测。
- **Qoder 协议细节**：`Liki4/qodercli2api`（AGPL）与 `shuishuipingan/qoder2api-hub`（MIT）的
  公开文档，以及保留下来做交叉验证的协议向量。

上一版自己实现的三条上游（`qoder-sign.mjs`、`qoder-upstream.mjs`、`opencode-upstream.mjs`，
约 2500 行）已删除——插件做得更好，而且会跟着上游一起更新。

## 目录

- [Why it is built this way](#why-it-is-built-this-way) — AppHost 的限制如何塑造了这个桥接
- [Qoder](#qoder-a-provider-plugin) — 那条协议里值得知道的事
- [OpenCode Zen Free](#opencode-zen-free-a-provider-plugin) — 免费额度现在的形态
- [Model measurement](#model-measurement) — 为什么列出的模型要实测
- [Layout](#layout) / [Releasing](#releasing) / [Diagnostics](#diagnostics) / [Known limits](#limits)

## Why it is built this way

What this App adds on top of a plugin is the part a plugin cannot do: running the plugins, and
registering what they serve into HanaAgent. A v2 App's `apply()` runs in an isolated Node child
launched by the host with a deliberately narrow environment, and two consequences of that
shaped everything below.

The loader-shim gymnastics the previous generation needed — `module.register()` for a
WorkBuddy chunk — went away with that chunk. The `NODE_OPTIONS` problem did not, because it
affects any Node child.

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

## Qoder (a provider plugin)

Qoder's subscription is served through `@magpie-community/opencode-qoder-auth`, the same way
every other provider is. It needs **no API key**: the plugin runs the same device authorisation
Qoder's own client runs, and keeps the resulting credential in `plugin-auth.json` under this
App's data directory.

This App used to implement the protocol itself — the COSY signature, the body codec, the 22
conditional headers, the credential file, the SSE envelope unwrapping. All of that is gone, for
one reason: **the plugin does it better and keeps doing it.** When Qoder ships a client that
changes `cosy-version` or the pinned RSA key, the plugin's maintainers fix it and `npm update`
delivers the fix; a hand-written implementation would need this App's author to notice, diagnose
and ship a release.

What is worth knowing about that protocol is still recorded here, because it explains behaviour
you will see:

- **Inference is a POST; the model catalogue is a GET that carries a body.** The signature
  covers that body, and a bare GET is refused.
- **Errors arrive inside HTTP 200.** A response can be `200 OK` and still carry an envelope with
  a non-200 `statusCodeValue`. The plugin surfaces that as a failed response, which is why the
  bridge reports the vendor's own words rather than a bare status.
- **Qoder silently ignores a reasoning level the model does not offer**, answering at the
  model's default. The plugin snaps the request onto the model's own table before sending.
- **A refresh token is spent once.** Two processes refreshing the same account can log it out;
  the plugin serialises its renewals, and this App reads the credential file rather than writing
  it.

The registered provider ids are `qoder` (international) and `qoder-cn` (China). They are
separate accounts on separate hosts, and signing in to one does not sign in to the other.

## OpenCode Zen Free (a provider plugin)

This used to be a subsystem: the free models were reachable only through the desktop app's v2
CLI, so the bridge spawned `opencode-cli.exe`, parsed its session API, and asked it for a JSON
envelope because letting it run its own tools would execute them on the machine.

**That is no longer how it works, and none of that code is left.** OpenCode moved its free tier
to a plain HTTP API on `https://opencode.ai/inference/v1`. The old `/zen/v1` path still answers
`403 FreeTierError` for the same request, which is what made the CLI look indispensable; the new
endpoint takes the credential `public` and answers normally.

Measured 2026-10-18 through the plugin, no CLI and no magpie running:

| Model | Result |
| --- | --- |
| `mimo-v2.6-flash-free` | 200, streamed a short answer |
| `big-pickle`, `deepseek-v4.1-flash-free`, `longcat-2.5-preview-free`, `space-bunny-free`, `nemotron-3.5-super-vl-free` | 200 |
| `beam-free` | **403** `RegionError`: not available in this country |
| `glm-5.3-flash-free` | **503** upstream request failed |
| `nemotron-3.5-lightning-free` | no answer within 25 s |

So the roster is still not a list of working models — six of nine answered. That is why
measurement exists; it is not specific to this provider.

## Model measurement

A provider's model list is a claim, not evidence. Measured across these providers, a meaningful
fraction of listed models do not answer at all: region blocks, deprecated entries, upstream
faults, and names that simply never reply.

Declaring those puts models in HanaAgent's picker that fail on every use, so each model is
probed once with one minimal completion and the verdict is cached for six hours in
`<data-dir>/probe/<provider>.json`. A probe is a real request and costs what the vendor charges
for a few tokens — which is why the answer is cached rather than recomputed.

Two consequences worth knowing:

- **A first sync is slow.** Nine models took about 70 seconds on this machine; a re-sync with
  every verdict still fresh takes about 4. The work happens once, not on every start.
- **`WORKBUDDY_PROBE=off` skips it.** Then every listed model is declared, including the ones
  that do not answer: the picker will be honest about the roster and dishonest about what works.

The panel shows each model's verdict, and the hiding switch removes a model from the declaration
so it leaves HanaAgent's picker rather than merely disappearing from this page.


## Layout

| Path | Role |
| --- | --- |
| `index.js` | v2 App entry: launches the bridge, registers the `/api/*` proxy |
| `bridge.mjs` | the bridge: routing, error shape, HanaAgent registration, model measurement |
| `plugin-host.mjs` | drives a provider plugin: sign-in, refresh, model list, one request |
| `plugins/` | the provider packages, as `npm install`ed (`@magpie-community/opencode-*-auth`) |
| `hana-providers.mjs` | writes a declaration in the field names HanaAgent reads |
| `hana-apply.mjs` | pushes a declaration into a running HanaAgent |
| `admin-api.mjs` | the console's own routes |
| `bridge-auth.mjs` | the request gate: bearer, Host, Origin, `Sec-Fetch-Site` |
| `bridge-launch.mjs` | the launcher that clears `NODE_OPTIONS` and hides the console window |
| `ui/panel.html` | the console, as a HanaAgent App page |
| `ui/assets/panel.js` | the console's only host; a copy of `panel/panel.js` |
| `scripts/` | the tests, and the retained protocol-vector cross-check |

`panel/panel.js` and `ui/assets/panel.js` are kept byte-identical on purpose — one file,
copied into the App's `ui/` tree at pack time, so a fix lands in both.

There is no standalone console any more. The bridge used to serve one from its own `/panel`
route, and that route had to inject the bearer into the page's HTML for the page to be able
to call `/admin/*` — while the route itself could not sit behind the bearer check without
becoming unusable. So any local process could fetch `/` and read the token. The route is
gone; the console exists only inside HanaAgent, and the token stays in the App process.

## Who may call the bridge

The bridge listens on `127.0.0.1`, and that is treated as reachability, **not** as
permission. Any process running as this user can reach a loopback port, and a page that gets
past PNA/LNA rules can reach one too, so every request is checked three ways
(`bridge-auth.mjs`):

| Check | What it stops | What it allows |
| --- | --- | --- |
| `Authorization: Bearer <token>` | everything without the key, including local processes | the App's proxy and HanaAgent itself |
| `Host` names this listener | DNS rebinding — a hostile name resolved to 127.0.0.1 | a missing `Host` (HTTP/1.0, some local clients) |
| `Origin` / `Sec-Fetch-Site` | cross-site requests a browser attaches an `Origin` to | no `Origin` (CLI clients), `null`, and this listener's own origin |

The token is 32 random bytes from `crypto.randomBytes`, written to
`<data-dir>/bridge-token` (that is `<hanaHome>/plugin-data/hana-broke/bridge-token`) with
mode `0600` on first run. It is never defaulted to empty: an unreadable or emptied file is
regenerated, and `--token` with no value no longer means "any caller". On Windows the mode
is advisory — the per-user profile ACL is what restricts the file — which is why `/healthz`
reports whether the file is owner-only rather than silently assuming it is.

The token is **not** passed as an argument. `--token` exists for tests, but the App and the
bridge share the file, because a command line is readable by every process that can list the
process table. `bridge.mjs --print-token` prints it for a local script that needs to call
`/admin` itself.

Model endpoints are protected by the same gate, and that required a declaration change:
HanaAgent skips the API key for a loopback `base_url` when a provider declares
`authType: "none"`, so every provider this bridge writes now declares `api-key` plus the
shared bearer, and `PUT /api/config` carries `api_key` too. With `openai-completions` that
arrives as `Authorization: Bearer`, which is exactly what the gate checks. A bridge that
declared `none` would be *callable without a key* no matter what the gate did.

`GET /healthz` also reports `refusals` — counts per reason — so a user can see that
something is probing the port instead of reading it only in the log.

### The model field names are HanaAgent's, and some are easy to get wrong

A provider declaration is not a generic OpenAI descriptor; HanaAgent reads specific keys from
it, and an unknown key is **dropped rather than rejected**. Two cost real defects:

| Written now | Was written | What went wrong |
| --- | --- | --- |
| `reasoning: true` | — | without it HanaAgent shows no thinking control at all |
| `customThinkingLevels: […]` | `supportedEfforts`, `efforts` | the list was dropped, so the model appeared but its levels did not |
| `image: <bool>` | only when known | an absent field inherits the previous declaration's value — a model can inherit vision it never had |

These were read off a file HanaAgent itself wrote
(`provider-plugins/claude/providers/claude.json`), not inferred.

### A provider deleted in HanaAgent stays deleted

HanaAgent remembers a removal by appending the provider id to `meta.deletedProviders` in
`provider-catalog.json` — a tombstone, so the entry is not resurrected from `models.json` at
start-up. Writing the `provider-plugins/` files again does **not** clear it: the provider stays
out of the picker, and a sync that keeps re-declaring it looks like success in the log while
nothing reaches the user.

So the tombstone is read before anything is written, and a tombstoned provider is skipped with
the reason in the panel and the log. Clearing it is the user's decision — re-add the provider
in HanaAgent's Settings → Models — not something a bridge should do behind their back. A
**sealed** catalog (`HANA-SECRET-1.AES-256-GCM.…`, which some builds write) is reported as
*unknown* rather than *clean*, so an unreadable catalog never silently blocks or unblocks
anything.

## Tests

```bash
node scripts/check-bundled-plugins.mjs        # the bundled plugin rules actually fire
node scripts/test-bridge-auth.mjs              # the authorization boundary, against a real bridge
node scripts/test-plugin-host.mjs              # the host, against the real plugins
node scripts/test-plugin-host.mjs --live       # adds one real inference (needs no account)
node scripts/test-hana-registration.mjs        # declarations, tombstone and field names
node scripts/verify-qoder-sign.mjs --fixtures <qodercli2api>/testdata/protocol/1.1.34
```

`test-bridge-auth.mjs` starts an actual bridge on a free port with a temporary data
directory and attacks it: no bearer, a wrong bearer, a bearer that is only a prefix, the
wrong scheme, a foreign `Host` (rebinding), a foreign `Origin`, a cross-site simple POST,
and anonymous requests to `/`, `/panel`, `/healthz` and a model route. It then checks the
other direction — a correct client still gets `/admin/status`, `/admin/providers` and
`/healthz` — and that no response anywhere contains the token. It uses `node:http` rather
than `fetch` on purpose: `fetch` drops a custom `Host` header, so a rebinding test written
with it would pass while proving nothing.

`check-bundled-plugins.mjs` is the guard against shipping a plugin that is worse than its version number. It feeds each bundled rule the sentence it claims to rewrite and requires the *words* to change — not just the bytes: a replacement that differs only in punctuation is a dead rule that still looks alive in the source. `opencode-workbuddy-auth` 0.1.28 ships exactly such a rule for the DeepSeek Harness opener (replacement == match), and one lookbehind that must *not* fire on `The Codex CLI …`, so both directions are asserted.

`test-plugin-host.mjs` installs nothing and needs no account: it drives the plugins already in
`plugins/`, and its live half uses `zen-free`, whose credential is the literal string
`public`. It covers packaging, model-record conversion, the credential store, a real sign-in, a
vendor that refuses, and a vendor that falls back to its own list.

`test-hana-registration.mjs` writes real `provider-plugins/` declarations into a temporary
HanaAgent home and asserts the fields HanaAgent actually reads — `reasoning`,
`customThinkingLevels`, `image` — plus the tombstone rule and the `api-key` declaration
without which the bridge's own check would be pointless.

`verify-qoder-sign.mjs` is kept from the previous generation: it replays public protocol
vectors against `qoder-sign.mjs`, which no longer exists. It now cross-checks the plugin's COSY
envelope rather than this App's code.

## Releasing

1. Bump the version in `manifest.json` **and** `package.json`.
2. Bump the `?v=` query on the assets in `ui/panel.html` to match. A WebView that keeps the
   old module in memory will otherwise keep painting the old UI after an update, which looks
   exactly like "the fix did not work".
3. Run all four test scripts. `test-bridge-auth.mjs` must pass before a build is published:
   it is the release gate the marketplace review asked for.
4. The plugins in `plugins/` are pinned by `package-lock.json`; commit it with any upgrade.
5. `node scripts/pack_app.mjs --dir <app> --publisher miaoyongxu --out dist-extensions`
6. `node scripts/extension-index-build.mjs --entries dist-extensions --base-url
   https://github.com/miaoyongxu/hana-broke/releases/download/v<version> --source-id miaoyongxu
   --name "Hana Broke" --out dist-extensions/index.v2.json`
7. `gh release create v<version>` with the zip, the `.entry.json` and the new
   `index.v2.json` as assets.

The scripts referenced in steps 5–6 live in the marketplace repository (`extension-market-sync`'s
toolkit), not here; this repository ships sources and the zip is built from them.

## Ports

| Listener | What | Why |
| --- | --- | --- |
| `127.0.0.1:8789` | this bridge | never 3425 (magpie's gateway) and never 8788 (already taken on the machine it was developed on) |
| `127.0.0.1:3425` | magpie, if installed | a different program with a different job; both may run |

The bridge refuses to start on a taken port rather than picking another, because a provider
declaration points at a fixed URL: a bridge that quietly moved would leave HanaAgent pointing
at nothing.

## Diagnostics

Every route below needs `Authorization: Bearer <token>`; there is no anonymous diagnostic
surface. `bridge.mjs --print-token` prints the token for a local script.

- `GET /healthz` — every provider's state: signed in or not, how many models it listed, whether
  the list was a fallback, and the last list error. Also `tokenFile` (path, mode, whether it is
  owner-only) and `refusals` (counts per reason a request was turned away). Never a token.
- `GET /admin/status` — the same, plus each provider's base URL and any sign-in in flight.
- `GET /admin/providers?refresh=1` — re-ask every vendor for its roster.
- `POST /admin/sync` — declare everything and push the changes into a running HanaAgent.
- In the App these are `/api/status` and `/api/providers`, which forward here and attach the
  bearer themselves.

## Known limits

- **A first sync is slow, by design.** Every model is probed once; nine models took about 70
  seconds. Later syncs reuse the verdicts and take about 4.
- **Two files are protected by their directory, not their mode.** On Windows `mode` does not
  carry permission bits, so `plugin-auth.json` and `bridge-token` both stat as `0666`; what
  keeps them private is the per-user profile directory. On POSIX the mode does apply, and
  `/healthz` reports which of the two you are getting.
- **The token is a shared secret between one App and one bridge.** Anyone who can read
  `<hanaHome>/plugin-data/hana-broke/bridge-token` can call the bridge as the App does. That
  is a smaller blast radius than "any local process", which was the previous state, but it is
  not a per-user capability system — deleting the file and restarting rotates the token.
- **A plugin that wants the local machine may not find it.** The Qoder plugin shells out to
  Qoder's own `runtime-info` binary for the daily check-in — not for inference — and throws if
  the desktop app is absent. Sign-in, model listing and chat are unaffected.
- A sync is single-flight, and a model list shares one in-flight request, so concurrent panel
  refreshes cannot multiply the probe cost or each other's latency.
- The App and the bridge must agree on the data directory for the token file to be shared; the
  App passes `--data-dir` explicitly, so a bridge started by hand with a **different**
  `--data-dir` will generate its own token and the App will be refused.
- The theme layer only fills in the variables the host publishes. The panel's own `--warn` and
  `--accent-text` keep the panel's values.




