# Compatibility

The plugin declares which DSH releases it supports under
`dsh.compatibility.dshReleases` in `package.json`. DSH STORE requires a **per
release** declaration — a version range is not accepted — and each value must be
one of `compatible`, `incompatible` or `unknown`.

## Current declarations

| DSH release | Declared | Basis |
|---|---|---|
| `0.1.7-alpha.1` | `compatible` | Signal check passed; every service and slot the plugin uses is present |
| `0.1.7-alpha.2` | `compatible` | Signal check passed |
| `0.1.7-rc.1` | `compatible` | Signal check passed |

Node.js: `>=20` — the plugin uses `node:fs`, `node:http` and `node:net` only,
with no version-specific syntax. Platforms: `win32`, `darwin`, `linux` — the host
half is plain Node with no native dependency. Profile: `web` (the plugin renders
into the right sidebar).

## What "compatible" means here, and what it does not

The signal check verifies that the **API surface** the plugin depends on exists
in the target release. It does not prove the plugin installs and runs there.

```
node scripts/check-compat.mjs 0.1.7-rc.1
```

That is a static check against the published packages. It is reproducible and
does not install anything, but it is **not** runtime acceptance. Declaring
`compatible` on this basis is honest only because the surface is small and
entirely declared by type contracts — but a real acceptance run is still the
stronger evidence and should replace this when it has been done.

## What the plugin relies on

| Service / slot | Package | Used for |
|---|---|---|
| `ctx.get('slots')` → `slots.register()` | `@deepseek-ai/dsh-client-ui-slots` | every panel entry point |
| `ctx.reflect.provide('sidebarRightTabs')` | `@deepseek-ai/dsh-client-ui-sidebar-right` | the sidebar tab |
| `sidebar.right.pane.tab` | `@deepseek-ai/dsh-client-ui-sidebar-right` | where the panel mounts |
| `conversation.input.dock` | `@deepseek-ai/dsh-client-ui-slots` | the composer bridge |
| `webServer` (`kind: 'prefix'` route) | harness host half | proxy route and HTTP API |
| `timer` | harness host half | preview idle sweep |

The host half injects only `webServer` and `timer`, both long-standing core
services.

## Runtime acceptance — not yet performed

DSH STORE wants install / start / uninstall evidence collected in a disposable
profile. That has **not** been done yet, so it is recorded here rather than
implied. The procedure, for whoever runs it:

```bash
# 1. disposable profile, never the working one
dsh --profile compat-check plugin add 'git+https://github.com/TheYoungChen/dsh-annotate.git#<40-char-commit>'

# 2. config must compose
dsh --profile compat-check --dump-config

# 3. start, then confirm in the UI that the 标注 tab appears in the right
#    sidebar and that opening a local page renders a preview

# 4. remove
dsh --profile compat-check plugin remove dsh-annotate
```

Record the profile name, DSH version, OS, timestamps and outcome. A run that only
proves the files downloaded — `client.js` returning 200 — does **not** count:
activation has to be confirmed by the tab actually appearing.

## Adding a release

When a new DSH release appears:

1. `node scripts/check-compat.mjs <version>`
2. If it passes, add `"<version>": "compatible"` to `dsh.compatibility.dshReleases`.
3. If it fails, add `"<version>": "incompatible"` and fix the plugin.
4. If the packages could not be fetched, use `"unknown"` — never guess.

`unknown` is the honest value when there is no evidence. Declaring `compatible`
without evidence is what causes a listing to be withdrawn.
