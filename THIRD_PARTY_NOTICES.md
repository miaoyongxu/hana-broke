# Third-party notices

## dsh-workbuddy-connect — no longer used

Earlier versions of this App drove `dsh-workbuddy-connect` (corrinehu, MIT,
<https://github.com/corrinehu/dsh-workbuddy-connect>) for the WorkBuddy protocol, its
credential store and its model catalog. That dependency is **gone**: WorkBuddy is served by a
provider plugin like every other vendor, and the WorkBuddy adapter code, its loader shim and its
atomic-write shim were deleted with it.

The notice is kept because the work is worth acknowledging, and because a reader of an older
release will find this file there. Nothing from that package is present in this repository now.


## magpie and its provider plugins — where the provider adapters come from

This App does not implement any vendor's protocol. Every provider is an npm package from the
magpie project's community plugin library, installed under `plugins/` and loaded at run time.

- **magpie** — <https://github.com/yetone/magpie>, **MIT**.
  The plugin host this App re-implements for one purpose: driving a provider plugin. The
  contract it follows — what a `loader` returns, how `provider.models` is called, the
  `Symbol.for("magpie.fellBack")` convention, `error.signIn` — was read from
  `internal/plugin/host.js` and `docs/subsystems/provider-plugins.md`. No magpie code is
  copied; `plugin-host.mjs` is written against the documented behaviour.
- **magpie-community/plugins** — <https://github.com/magpie-community/plugins>, **MIT**.
  The packages themselves, installed as dependencies:

  | Package | Version | Licence |
  | --- | --- | --- |
  | `@magpie-community/opencode-qoder-auth` | 0.2.18 | MIT |
  | `@magpie-community/opencode-workbuddy-auth` | 0.1.24 | MIT |
  | `@magpie-community/opencode-zen-free-auth` | 0.1.11 | MIT |

  They are shipped as-is inside the App bundle and called through their exported hooks. Any
  modification to them would be this repository's responsibility, and is avoided: a fix
  belongs upstream, delivered by `npm update`.

  `opencode-qoder-auth` additionally carries `LICENSE-CLIProxyAPI`, because its Qoder support
  is ported from **CLIProxyAPI** (<https://github.com/ufec/CLIProxyAPI>, MIT, Copyright (c)
  2025-2005.9 Luis Pater and 2025.9-present Router-For.ME). That notice travels with the
  package and must be kept if the package is ever vendored rather than installed.

The design lessons taken from magpie are noted where they are implemented: the provider/model
split (`plugin-host.mjs`), model measurement and the picker (`bridge.mjs`), and the
HanaAgent-specific registration rules (`hana-providers.mjs`).

## DeepSeek Harness packages

The previous generation depended on `@deepseek-ai/dsh-home-paths` and `dsh-atomic-write`
through the WorkBuddy plugin chunk, and shipped a hand-written shim for the latter. Both the
chunk and the shim are gone with it; this App no longer imports any DeepSeek Harness package.

## Qoder protocol — prior art, retained as a cross-check

`qoder-sign.mjs` used to implement Qoder's COSY envelope here. It is deleted — the plugin does
it — but `scripts/verify-qoder-sign.mjs` is kept, because the vectors it replays are an
independent check of that envelope:

- **Liki4/qodercli2api** — <https://github.com/Liki4/qodercli2api> (**AGPL-3.0**).
  Its `docs/inference-protocol.md` and `docs/oauth.md` document the COSY signature, the body
  codec, the header presence matrix and the credential file; `testdata/protocol/1.1.34/` holds
  the input/output vectors the script replays.
- **shuishuipingan/qoder2api-hub** — <https://github.com/shuishuipingan/qoder2api-hub>
  (**MIT**). An independent Python implementation of the same protocol, used to cross-check
  the RSA public key, the alphabet and the SSE envelope shape.

**No code from either project is present in this repository.** The verification script reads
the vectors from a checkout the user supplies rather than shipping them, so their licence stays
with them. The earlier hand-written implementation was also independent — built from the
documented behaviour on `node:crypto` primitives — and even that is now gone. If you ever copy
code from the first project into this repository, note that AGPL-3.0 has consequences well
beyond attribution.


## Trademarks

WorkBuddy, WorkBuddy AI, CodeBuddy, Qoder, DeepSeek Harness and HanaAgent are the
property of their respective owners. This project is an unofficial
interoperability tool and is not affiliated with, endorsed by, or supported by
any of them.
