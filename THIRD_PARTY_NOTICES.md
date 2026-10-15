# Third-party notices

## dsh-workbuddy-connect — the implementation this project is built on

- Package: `dsh-workbuddy-connect` (`0.7.4` at the time of writing)
- Author: corrinehu
- Source: <https://github.com/corrinehu/dsh-workbuddy-connect>
- License: MIT
- npm: <https://www.npmjs.com/package/dsh-workbuddy-connect>

**Credit where it is due: the hard parts are upstream's.** Reading and
decrypting the WorkBuddy desktop apps' at-rest credentials, the WorkBuddy
upstream wire protocol (chat body preparation, request headers, OAuth token
refresh), and the model catalog including its billing/promotion metadata are
all implemented by `dsh-workbuddy-connect`. This project is an adapter layer for
HanaAgent on top of it; it does not reimplement, rename, or claim those parts.

**This project deliberately does not vendor that code.** It is resolved as a
runtime dependency (an explicit `WORKBUDDY_PLUGIN_DIR`, this repo's own
`node_modules`, or a DeepSeek Harness profile) and called through its exported
helpers. Keeping it a dependency rather than a copy keeps authorship
unambiguous, keeps the upstream copyright and MIT permission notice travelling
with the upstream package where they belong, and means a change to WorkBuddy's
private protocol is fixed by upgrading upstream instead of by a fork.

**If you ever vendor (copy) that code into this repository instead**, you must
reproduce its copyright notice and its MIT permission notice — either in this
file or in a bundled `LICENSE` — because the MIT terms travel with the code.
That obligation is not a formality; it is the licence.

## DeepSeek Harness packages

`dsh-workbuddy-connect` declares several `@deepseek-ai/dsh-*` packages as peer
dependencies; `npm install` pulls them in alongside it. This project imports
`@deepseek-ai/dsh-home-paths` only indirectly, through the upstream chunk.

`dsh-atomic-write-shim.mjs` is this project's **own independent implementation**
of the two functions (`writeFileAtomic`, `withFileLock`) the upstream chunk
imports from `@deepseek-ai/dsh-atomic-write`, written so the bridge can run when
that DeepSeek Harness package is not installed. It is not copied from that
package; it exists so this adapter layer does not require a DeepSeek Harness
installation.

## Trademarks

WorkBuddy, WorkBuddy AI, CodeBuddy, DeepSeek Harness and HanaAgent are the
property of their respective owners. This project is an unofficial
interoperability tool and is not affiliated with, endorsed by, or supported by
any of them.
