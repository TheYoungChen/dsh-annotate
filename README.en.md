<div align="center">

# dsh-annotate

**Pick any element on any page — local or online — leave a comment, and send its DOM context straight into your DeepSeek Harness chat.**

**English** · [简体中文](README.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js ^22.19](https://img.shields.io/badge/node-%5E22.19%20%7C%20%3E%3D24-339933.svg)](package.json)
[![DSH 0.1.5-rc.1+](https://img.shields.io/badge/DSH-0.1.5--rc.1%2B-4d6bfe.svg)](https://www.npmjs.com/package/@deepseek-ai/dsh)
[![awesome · DSH plugin](https://img.shields.io/badge/awesome%C2%B7DSH%20plugin-annotation-5B4CF0.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

<!-- TODO: demo image pending (screenshots are generated from the test suite to avoid staleness)
![dsh-annotate demo](assets/hero.png)
-->

> 🚧 **Work in progress** — under active development. Star to follow along.

</div>

---

## Why

Describing a UI bug in words never lands precisely:

> "That button… the one top-right… it does nothing when I click it…"

`dsh-annotate` lets you **just point at it**. Select the element, write your note, and the
model receives this:

```text
🎯 UI annotation · https://example.com/settings · viewport 1440×900 (2 items)
#1 button.primary
   semantics: aria-label="Save changes" · data-testid=save
   component chain: SettingsPage > SettingsForm > SubmitButton
   selector: #root > form > button.primary (1 match)
   rect: 96×32 @ (640, 512) · viewport: center
   computed style: display:inline-block; padding:8px 16px; border-radius:6px
   text: Save changes
   comment: This should be disabled when the form has no changes.

#2 div.toast.error
   selector: div.toast.error (1 match)
   text: Save failed
   comment: This toast disappears after 3s — too fast to read. Make it dismiss manually.
```

**Not a screenshot — structured facts.** The model can pinpoint the exact line of code.

---

## How it differs

| Capability | dsh-annotate | ZCode-style | Codex-style |
|---|:---:|:---:|:---:|
| Element annotation (pick + DOM facts) | ✅ | ✅ | ✅ |
| **Comment feedback** (pick → write) | ✅ | ❌ | ✅ |
| **Annotate live online sites** | ✅ | ✅ | ❌ |
| **Annotate local HTML files** (`file://`) | ✅ | ❌ | ❌ |
| Built-in sidebar browser | ✅ | separate window | ❌ |
| Model can read the page (AI/ARIA tree) | ✅ | ✅ | ❌ |
| One-click online-access switch | ✅ | ❌ | — |

**The difference that matters**: existing tools either only reach live sites (so they can't
read your local prototypes) or only reach `localhost` / loopback. `dsh-annotate` does
**both — including HTML files you open directly in the browser**.

---

## Why a browser extension is required

You might ask: **why not just put an iframe in the sidebar?**

Because of the **same-origin policy** — that's a web security model, not an implementation
detail:

| Approach | Live sites | Read page DOM |
|---|:---:|:---:|
| Embedded iframe | ❌ blocked by `X-Frame-Options` | ❌ **cross-origin DOM is unreachable** |
| Temporary loopback proxy | ❌ loopback only | ✅ local only |
| **Browser extension** | ✅ any site | ✅ **content script runs inside the page** |

Even if you defeat `X-Frame-Options`, a **cross-origin iframe still cannot run
`document.querySelector`**.

Only an extension's content script runs *inside* the target page — it can read the DOM,
highlight elements, and observe clicks. **It is the only legitimate path.**

**Bonus**: you use your own browser, so **cookies, logins, and other extensions all stay**.

---

## Install

### 1. Install the plugin

```sh
dsh plugin --profile web add dsh-annotate
```

Or paste this into your DSH chat:

> Install the dsh-annotate plugin: run `dsh plugin --profile web add dsh-annotate`,
> then tell me how to load the browser extension.

### 2. Load the browser extension

After the plugin installs, the extension lives at `~/.dsh/dsh-annotate/extension/`
(Windows: `C:\Users\<you>\.dsh\dsh-annotate\extension\`).

1. Open `edge://extensions` (or `chrome://extensions`)
2. Turn on **Developer mode**
3. Click **Load unpacked** and pick that folder
4. Pin the whale icon to your toolbar

> **Why can't the extension install itself?** Browser security — no software may install an
> extension silently. It's a one-time manual step.

### 3. Restart

Restart DSH and refresh the page.

---

## Usage

Press `Ctrl+Shift+A` (`⌘+Shift+A` on macOS) to enter annotation mode.

```text
open the sidebar browser → visit any page → click "Annotate" → hover to highlight → click to pick
   → write a comment → send
```

### Two ways to send

| Mode | How | When |
|---|---|---|
| **Send directly** | press `Enter` after picking | you just want the model to look at the element |
| **Comment then send** | pick → write → send | **tell the model what's wrong and how to fix it** |

Both are available, always.

### Shortcuts

| Key | Action |
|---|---|
| `Ctrl/⌘ + Shift + A` | toggle annotation mode |
| `Esc` | leave annotation mode |
| `Enter` | save the comment and keep annotating |
| `Shift + Enter` | newline inside a comment |
| `Ctrl/⌘ + click` | save and send the whole batch |
| `Tab` | cycle through overlapping elements |

### Supported page types

| Type | Supported |
|---|---|
| `https://` live sites | ✅ |
| `http://` local servers | ✅ |
| **`file://` local HTML files** | ✅ **(prototypes opened directly in the browser)** |
| `about:blank` / special schemes | ❌ browser limitation |

---

## The one-click online-access switch

The first time you annotate on a **non-local address**, a switch appears:

> ⚠️ **Allow dsh-annotate to access live websites?**
> When on, the extension may read page structure and the elements you pick on any site you
> browse. Data is sent only to your local DSH (`127.0.0.1`) — never uploaded anywhere.
> You can turn this off at any time in settings.

**Off by default.** Once enabled it applies to all sites; turning it off stops it immediately.

---

## What the model receives

Each annotation carries:

| Field | Description |
|---|---|
| **Selector** | CSS selector + match count |
| **Semantics** | `aria-label`, `data-testid`, `role`, etc. |
| **Component chain** | React / Vue component path (dev builds) |
| **Geometry** | position, size, in-viewport |
| **Computed style** | key CSS properties |
| **Visible text** | up to 120 characters |
| **Your comment** | what you wrote |

**Not included**: screenshots (unless you opt in), sensitive form values, password fields.

---

## Security

- **Data never leaves your machine.** Annotations travel over a loopback WebSocket
  (`127.0.0.1`) to your own DSH.
- **The page is never modified.** The content script is read-only — no style injection, no
  DOM mutation.
- **No credentials collected.** Password, credit-card and similar fields are skipped.
- **Page content is untrusted.** Text from a page is marked as data and never executed as
  instructions.
- **Live-site access is off by default** and requires your explicit opt-in.

---

## Configuration

```yaml
- insert:
    name: dsh-annotate
    config:
      host: 127.0.0.1
      port: 43120
      allowedExtensionId: ""      # optional; set it for a tighter binding
      requestTimeoutMs: 300000
      maxPayloadBytes: 16777216
      includeScreenshot: false    # screenshots are opt-in
```

---

## Development

```sh
npm ci
npm run build       # build the plugin and the extension
npm test            # drives client / overlay in a real browser
npm run check       # typecheck + lint
```

Layout:

```
dsh-annotate/
├── src/                 DSH plugin (host half)
│   ├── index.ts         entry
│   ├── bridge.ts        loopback WebSocket bridge
│   └── protocol.ts      annotation data model
├── extension/           browser extension (MV3)
│   ├── manifest.json
│   ├── content.js       element picking + DOM extraction
│   └── background.js
├── assets/              README images
└── docs/                screenshots and notes
```

---

## Known limitations

- **Chromium only in practice** (Edge / Chrome). Firefox is untested.
- **React component chains need dev builds** — names are minified in production.
- **Shadow DOM**: open roots are supported; closed roots are unreachable.
- **Cross-origin iframes**: partially blocked by the browser.
- **Canvas internals**: cannot be picked — those are pixels, not DOM.

---

## Contributing

Issues and PRs welcome. Especially wanted:

- Firefox compatibility verification
- Component-chain extraction for Vue / Svelte / Angular
- More UI languages

---

## License

[MIT](LICENSE)

An independent community plugin. Not affiliated with or endorsed by DeepSeek.

---

<div align="center">

If this plugin saves you time explaining UI problems, a ⭐ helps others
with the same problem find it.

</div>
