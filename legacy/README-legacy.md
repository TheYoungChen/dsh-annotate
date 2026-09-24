# legacy/ — the archived Chrome-extension implementation

This directory holds the **first implementation** of dsh-annotate: a Chrome
extension (MV3) that paired with a DSH bridge. It is kept for reference and
history. It is **not** the current plugin, is not installed by anything, and is
not built by CI.

The current implementation lives at the repository root: a native DSH cordis
plugin (`lib/` host half + `client.js` browser half).

## Why it was replaced

The extension approach had a structural problem: it needed a paired browser
extension installed in the user's Chrome, plus a bridge the DSH side talked to.
That is a lot of setup for "click an element and tell the agent about it", and
it only worked in the user's own browser — not in the preview inside the DSH
sidebar, which is where the work actually happens.

The current plugin removes both moving parts. It serves the target page through
a same-origin proxy on the harness origin and injects its picker into that
proxy, so:

- no browser extension to install or keep in sync
- the annotation UI lives in the DSH sidebar, next to the conversation
- cookies and storage stay partitioned per preview target

## What is still worth reading here

| Path | Why it may still be useful |
|---|---|
| `extension/src/content/facts.ts` | The deepest element-fact collector in the project — attributes, style summary, nearby text, safe HTML excerpt. The current plugin deliberately sends far less, but this is the reference if richer facts are ever wanted. |
| `extension/src/content/picker.ts` | Picker interaction model: hover highlight, click capture, scroll/zoom repositioning. |
| `docs/DESIGN-PRINCIPLES.md` | The design reasoning that carried over into the current plugin. |

## Status

Frozen. No further work happens here.

```bash
# For reference only — not part of the current build.
cd legacy
node scripts/build.mjs
```
