/**
 * Follow the HanaAgent theme.
 *
 * The console is an upstream control surface with a palette of its own, which
 * is exactly why it reads as a foreign window once it is a page inside
 * HanaAgent. It does not have to. HanaAgent publishes the colours it is
 * actually using as CSS custom properties — `--bg`, `--bg-card`, `--text`,
 * `--text-muted`, `--border`, `--accent`, `--green`, `--danger` — and the
 * panel's own palette already uses the same idea with partly the same names.
 *
 * Three sources are tried, best first:
 *
 * 1. **The host window.** An App page is same-origin with the host, so the
 *    real, currently-applied values can be read straight off it. This is the
 *    only source that stays correct for a named or custom theme.
 * 2. **The host push.** The host announces every theme change on
 *    `hana.theme.changed`, and the SDK surfaces it as `hana.theme.subscribe`.
 *    This is what makes a switch apply without a reload: the host tells us,
 *    we do not have to notice.
 * 3. **The iframe URL.** The host stamps `hana-css` onto the page URL, and the
 *    stylesheet that points at defines the same variables. Used when the parent
 *    document is not reachable and nothing has been pushed yet.
 *
 * Whatever is found is written as inline custom properties, which outrank the
 * panel's own `:root` block without editing it — the panel stays byte-identical
 * to the copy the bridge serves standalone.
 *
 * @module hana-broke/hana-theme
 */

/** Whether a successful round has written the host's values at least once. */
let appliedOnce = false;

// The SDK is what turns the host's `hana.theme.changed` push into a callback.
// It only resolves inside the App host; everywhere else the layer still works
// off the host window and the URL, so a failed import just means "no push".
let hana = null;
try {
	({ hana } = await import("./sdk.js"));
} catch {
	hana = null;
}

/** Local palette variable → the host variable that should feed it. */
const MIRROR = {
  "--bg": "--bg",
  "--panel": "--bg-card",
  "--panel-2": "--bg-card",
  "--border": "--border",
  "--text": "--text",
  "--muted": "--text-muted",
  "--accent": "--accent",
  "--ok": "--green",
  "--bad": "--danger",
  // Type follows the host too, so the console does not read as a foreign app.
  "--font-ui": "--font-ui",
  "--font-mono": "--font-mono",
};

/** Parse `#rgb`, `#rrggbb` or `rgb()/rgba()` into components, else null. */
function parseRgb(value) {
  const raw = String(value ?? "").trim();
  let match = raw.match(/^#([0-9a-f]{6})$/i);
  if (match) return [0, 2, 4].map((index) => Number.parseInt(match[1].slice(index, index + 2), 16));
  match = raw.match(/^#([0-9a-f]{3})$/i);
  if (match) return [...match[1]].map((char) => Number.parseInt(char + char, 16));
  match = raw.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Perceived brightness, so the panel's own dark/light rules still land. */
function isDark(value) {
  const rgb = parseRgb(value);
  if (!rgb) return null;
  return (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 < 128;
}

/**
 * The element the host's theme is actually applied to.
 *
 * HanaAgent sets `data-theme` on the document element, but the default theme is
 * declared as `:root:not([data-theme])` — so reading the root blindly can hand
 * back the *default* palette while the real theme lives one element down.
 * Whichever element carries `data-theme` is the one whose values are in use.
 */
function themeHostElement(parentWindow) {
  try {
    const doc = parentWindow.document;
    for (const candidate of [doc.documentElement, doc.body]) {
      if (candidate && typeof candidate.hasAttribute === "function" && candidate.hasAttribute("data-theme")) return candidate;
    }
    return doc.documentElement ?? null;
  } catch {
    return null;
  }
}

/** Read variables straight off the host document, when it is reachable. */
function hostWindowSource() {
  try {
    const parentWindow = window.parent;
    if (!parentWindow || parentWindow === window) return null;
    const host = themeHostElement(parentWindow);
    if (!host) return null;
    return {
      source: "host-window",
      read: (name) => parentWindow.getComputedStyle(host).getPropertyValue(name).trim(),
    };
  } catch {
    // Cross-origin or not actually embedded; the URL fallback takes over.
    return null;
  }
}

/** Load the host-issued stylesheet named in the iframe URL and read from it. */
function urlStylesheetSource() {
  const cssUrl = new URLSearchParams(window.location.search).get("hana-css");
  if (!cssUrl) return null;
  let link = document.getElementById("hana-host-stylesheet");
  if (!link) {
    link = document.createElement("link");
    link.id = "hana-host-stylesheet";
    link.rel = "stylesheet";
    // Land the theme the moment the host sheet arrives instead of a tick later.
    link.addEventListener("load", () => sync());
    document.head.append(link);
  }
  if (link.getAttribute("href") !== cssUrl) link.setAttribute("href", cssUrl);

  // Not ready until the sheet is actually applied — and this gate is the whole
  // fix for a bug that showed up as a light page with dark cards.
  //
  // `read` below asks *this* document for the variables, and `panel.css` states
  // its own fallbacks in `:root` (`--bg: #fbfbfd`). So a read taken before the
  // host sheet loads returns the panel's own fallback — a perfectly non-empty
  // value — and `sync` writes it as an inline property. Inline beats every
  // stylesheet, so from that moment `read('--bg')` returns the pin rather than
  // the host's colour and re-writes it forever: the page can never follow the
  // theme again. `--bg-card` is not declared by `panel.css`, so it read as empty
  // and was skipped; later it resolved to the host's value. The pair of those is
  // exactly one screen showing two palettes.
  if (!link.sheet) return null;

  const root = document.documentElement;
  return {
    source: "url-stylesheet",
    read: (name) => window.getComputedStyle(root).getPropertyValue(name).trim(),
  };
}

/** Copy one round of host values onto this document. False means "not yet". */
function sync() {
  const from = hostWindowSource() ?? urlStylesheetSource();
  if (!from) return false;
  const root = document.documentElement;
  // Written to both the root and <body>: a custom property declared on an
  // element beats the one it inherits, so anything that redefines these on
  // <body> would otherwise shadow the live theme.
  const targets = document.body ? [root, document.body] : [root];
  // A pin from a stale round is the one thing that can outlive its cause, so the
  // first successful round drops them before writing the host's values.
  if (!appliedOnce) {
    clearPins();
    appliedOnce = true;
  }
  let applied = 0;
  for (const [local, remote] of Object.entries(MIRROR)) {
    const value = from.read(remote);
    if (!value) continue;
    for (const target of targets) target.style.setProperty(local, value);
    applied += 1;
  }
  if (applied === 0) return false;

  // The panel keys its own dark/light rules off `data-hana-theme`, and a named
  // theme is neither, so pick the face that matches the host background.
  const mode = isDark(from.read("--bg"));
  if (mode !== null) {
    root.dataset.theme = mode ? "dark" : "light";
    if (document.body) document.body.dataset.hanaTheme = mode ? "dark" : "light";
  }
  root.dataset.themeSource = from.source;
  return true;
}

/**
 * Drop the pins this layer wrote itself, so the host's values can be read again.
 *
 * This is the escape hatch for a self-sustaining wrong value. `read` resolves
 * against *this* document, and `panel.css` declares fallbacks of its own — so a
 * round that runs too early reads the panel's fallback (a valid, non-empty
 * colour), writes it inline, and every later round reads that pin back instead of
 * the host. Inline wins over every stylesheet, so nothing short of removing the
 * property can break the loop; clearing it is safe because the host values are
 * re-applied immediately by the `sync` that follows.
 */
function clearPins() {
  for (const target of [document.documentElement, document.body]) {
    if (!target) continue;
    for (const local of Object.keys(MIRROR)) target.style.removeProperty(local);
  }
  delete document.documentElement.dataset.themeSource;
}

/** Keep following: first until it lands, then on every host theme change. */
function follow() {
  // The host window is re-read on a slow tick for the lifetime of the page, not
  // just until the first success. A reload, a surface re-mount or a window move
  // can all land the page somewhere the first round could not read, and the
  // only price of a one-second re-read is a timer that costs nothing.
  window.setInterval(sync, 1_000);
  window.addEventListener("focus", sync);
  document.addEventListener("visibilitychange", sync);

  // Theme switches announced by the host: this is the path that makes the
  // change land without a reload. Subscribing twice is harmless (the SDK
  // hands back an unsubscribe) and the callback fires once with the current
  // snapshot, which doubles as the fastest first paint.
  try {
    const unsubscribe = hana.theme.subscribe(() => sync());
    window.addEventListener("beforeunload", () => {
      try {
        unsubscribe();
      } catch {
        // The page is going away anyway.
      }
    });
  } catch {
    // Not in a host that pushes themes; the re-read loop above still covers it.
  }

  try {
    const parentWindow = window.parent;
    const root = parentWindow?.document?.documentElement;
    if (root) {
      new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
      if (parentWindow.document.body) {
        new MutationObserver(sync).observe(parentWindow.document.body, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
      }
      parentWindow.addEventListener("storage", sync);
    }
  } catch {
    // Not embedded (or cross-origin): the polling loop above still covers it.
  }
}

follow();
