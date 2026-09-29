/**
 * dsh-annotate — host half.
 *
 * The job: let someone point at a web page that is already running on their
 * machine, click on pieces of its UI, and turn each click into one entry in a
 * block of text that goes into the conversation.
 *
 * Two things make that possible.
 *
 *  1. Preview servers. A page cannot be inspected by a script from another
 *     origin, so we do not frame the app directly. We start a small proxy on
 *     the harness origin that forwards to the app, and the sidebar frames
 *     *that*. Same origin, so the injected picker can read the DOM, while the
 *     app's own storage and cookies stay walled off from the harness.
 *
 *  2. Injection. Every proxied HTML document gets a config object, a page shim
 *     and the picker overlay prepended to its `<head>`, before any app script
 *     has had a chance to run.
 *
 * Responses are rewritten on the way back: framing headers are dropped (an app
 * that refuses to be framed would otherwise show up blank), cookies are
 * namespaced per target, and redirects are kept on the preview origin so the
 * next document still carries the overlay.
 *
 * All of it is reached from the client at POST /__dsh-annotate/api.
 */

import http from 'node:http'
import https from 'node:https'
import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-annotate'

/**
 * `webServer` gives us the route; `timer` drives the idle sweep.
 *
 * The agent hook that carries annotations into a turn is registered through the
 * ambient event bus rather than an injected service, so no further dependency is
 * declared: on a host without the agent loop the listener is simply never called,
 * and the preview keeps working.
 */
export const inject = ['webServer', 'timer']

/** Reported by `ping`, so a running host can be checked against the manifest. */
const VERSION = '0.2.3'

const ROUTE = '/__dsh-annotate'
const WS_RELAY = '/__dsh_annotate_ws'

/** One-line clip used wherever a field is quoted back to the model. */
const clip = (value, max) => {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Dev servers people actually run, probed even when the OS tells us nothing.
 *
 * Ranked by how often they turn up, because the list is truncated: a port that is
 * common but far down can be dropped before it is ever probed. `1420` is Tauri's
 * default and `1421` its fallback, which is why they sit high — a Tauri app is
 * exactly the kind of thing someone wants to annotate.
 */
const COMMON_PORTS = [
  5173, // Vite (Vue/React)
  3000, // Next.js, CRA, generic Node
  1420, // Tauri
  1421, // Tauri (fallback)
  8080, // generic / Java / Tomcat
  8000, // Django, generic
  4173, // Vite preview
  5000, // Flask, ASP.NET
  4200, // Angular
  4321, // Astro
  5500, // Live Server (VS Code)
  5174, // Vite (second instance)
  3001, // Next.js (second instance)
  8001,
  8888,
  9000,
  1234,
  5180,
  6006, // Storybook
  7000,
]

/** Preference order, not a list of answers: anything absent ranks last. */
const commonRank = (port) => {
  const index = COMMON_PORTS.indexOf(port)
  return index === -1 ? COMMON_PORTS.length : index
}

/** Where a built or hand-written page might live, relative to the workspace. */
const STATIC_DIRS = ['', 'dist', 'build', 'out', 'public']
const STATIC_PAGE_LIMIT = 24
/** Bound on one static response so a stray large file cannot be buffered. */
const STATIC_FILE_LIMIT = 64 * 1024 * 1024
const PREVIEW_TTL_MS = 5 * 60_000

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}
const staticMime = (file) => STATIC_MIME[extname(file).toLowerCase()] || 'application/octet-stream'
const isHtmlFile = (file) => /\.html?$/i.test(file)

/** Both paths are already fully resolved, so a prefix test is exact. */
function insideRoot(target, root) {
  if (!target || !root) return false
  if (target === root) return true
  return target.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** Dot segments are VCS metadata, env files and editor state. `..` fails too. */
const hasHiddenSegment = (pathname) => pathname.split('/').some((part) => part.startsWith('.'))

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
])

/**
 * Headers that would stop a proxied page from being framed or injected.
 *
 * `x-frame-options` and CSP's `frame-ancestors` are the obvious two. The
 * cross-origin trio matters because a document that demands to be alone in its
 * browsing context will refuse to load in an iframe, and a COEP'd page cannot
 * talk to the harness window at all.
 */
const UNFRAMEABLE = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
])

/** Shipped next to this file. A missing asset degrades to "no injection". */
function asset(file) {
  try {
    return readFileSync(new URL(file, import.meta.url), 'utf8')
  } catch (error) {
    console.warn(`dsh-annotate: ${file} unavailable —`, String((error && error.message) || error))
    return ''
  }
}
const SHIM_SRC = asset('./shim.js')
const OVERLAY_SRC = asset('./overlay.js')

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))

/**
 * A preview target must be http(s), must not carry credentials in the URL, and
 * must be loopback.
 *
 * This is the one gate that keeps the proxy from becoming a way to reach
 * anything the host can reach. Remote sites are deliberately out of scope for
 * now; opening them up needs metadata-address and private-range blocking that
 * this check does not attempt.
 */
function isLocalTarget(url, allowRemote) {
  if (!url || !['http:', 'https:'].includes(url.protocol)) return false
  if (url.username || url.password) return false
  if (allowRemote) return true
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

const encodeTarget = (origin) => Buffer.from(origin, 'utf8').toString('base64url')
const decodeTarget = (value) => Buffer.from(String(value), 'base64url').toString('utf8')

/** `127.0.0.1:3099` -> 3099, `[::1]:3099` -> 3099, `localhost` -> 0.
 *  Splitting on ':' is wrong for bracketed IPv6 literals. */
function hostPort(host) {
  const text = String(host || '')
  const close = text.lastIndexOf(']')
  const colon = text.lastIndexOf(':')
  if (colon === -1 || (close !== -1 && colon < close)) return 0
  const value = Number(text.slice(colon + 1))
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : 0
}

/** The origin the browser used. Behind a TLS-terminating proxy the socket is
 *  plain http, so an explicit forwarded scheme wins. */
function requestOrigin(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const scheme = forwarded === 'https' || forwarded === 'http' ? forwarded : req.socket.encrypted ? 'https' : 'http'
  return `${scheme}://${req.headers.host}`
}

const originOf = (value) => {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

/**
 * A preview server must not become a readable gateway for unrelated pages.
 *
 * Chromium sends fetch metadata, which is authoritative. Firefox and Safari
 * send none, so fall back to the browser's own Origin/Referer. A request with
 * no provenance at all is local tooling (curl, a health check), which cannot
 * be told apart from a navigation, so it is allowed.
 */
function allowedPreviewRequest(req, parentOrigin, previewOrigin) {
  const parents = [parentOrigin, previewOrigin]
  const site = req.headers['sec-fetch-site']
  const dest = req.headers['sec-fetch-dest']
  if (site === 'cross-site' && dest !== 'iframe') return false
  // A framed load may legitimately be cross-site (the harness can be on
  // 127.0.0.1 while the preview is on localhost), so it must name its parent.
  if (dest === 'iframe' || site === 'cross-site') return parents.includes(originOf(req.headers.referer))
  if (site) return true
  const declared = originOf(req.headers.origin) || originOf(req.headers.referer)
  return declared === null || parents.includes(declared)
}

// --------------------------------------------------------------------- cookies

/**
 * Apps set cookies for their own origin. Passing them through unchanged would
 * both leak into the harness and collide between two previews of the same app,
 * so each one is tagged with its target and rewritten to a path that only this
 * preview serves.
 */
function tagCookieName(name, enc) {
  return `dsa_${enc}_${name}`
}

function splitCookies(header, enc) {
  const prefix = `dsa_${enc}_`
  const kept = []
  for (const part of String(header).split(';')) {
    const [rawName, ...rest] = part.split('=')
    const trimmed = rawName.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('dsa_')) {
      if (trimmed.startsWith(prefix)) kept.push(`${trimmed.slice(prefix.length)}=${rest.join('=')}`)
      continue
    }
    kept.push(`${trimmed}=${rest.join('=')}`)
  }
  return kept.join('; ')
}

function rewriteSetCookie(value, enc, target) {
  void target
  const parts = String(value).split(';')
  const pair = parts[0]
  const equals = pair.indexOf('=')
  if (equals === -1) return value
  const name = pair.slice(0, equals).trim()
  const val = pair.slice(equals + 1)
  const attributes = parts
    .slice(1)
    .map((one) => one.trim())
    .filter(Boolean)
    .filter((attr) => {
      const lower = attr.toLowerCase()
      // The app's Domain would reject our rewritten name outright.
      if (lower.startsWith('domain')) return false
      // `SameSite=None` without `Secure` is dropped by browsers, and the
      // preview is same-origin with the harness, so Lax is valid and enough.
      if (lower.startsWith('samesite')) return false
      return true
    })
  attributes.push('Path=/', 'SameSite=Lax')
  return `${tagCookieName(name, enc)}=${val}; ${attributes.join('; ')}`
}

// -------------------------------------------------------------------- previews

/**
 * One preview = one target the user picked, reached through one ephemeral
 * loopback server. The server exists so the framed document shares an origin
 * with... itself, not with the harness: absolute paths, SPA routes and
 * root-relative assets all keep working with no rewriting.
 */
function createPreviewManager(ctx, config) {
  const previews = new Map()

  const allowRemote = Boolean(config && config.allowRemote)
  const idleMs = Number(config && config.idleMs) > 0 ? Number(config.idleMs) : PREVIEW_TTL_MS

  /**
   * Open a preview for one request, reusing an existing one when it matches.
   * @param request - `{ origin, target, fileRoot }`. `origin` is the resolved
   *   identity and is always a string; `target` is the parsed URL for a remote
   *   page and `null` for a file preview.
   */
  async function open(request) {
    const { origin, target, fileRoot, accent } = request
    // Reuse compares the identity the caller resolved. It must not compare
    // `preview.origin` (the ephemeral loopback address, different every time) nor
    // `preview.target` (null for a file preview, which is what made the second
    // open throw `Cannot read properties of null (reading 'origin')`).
    for (const preview of previews.values()) {
      if (preview.targetOrigin === origin && preview.fileRoot === fileRoot) {
        preview.touched = Date.now()
        // A reused preview still has to adopt a changed accent: the reader picked a
        // new colour and the page is already open, so the value has to land on the
        // existing record rather than only on newly created ones.
        //
        // The record itself is returned, not a copy. Callers mutate what they get
        // back — the `/open` route sets `parentOrigin` on it — and handing them a
        // copy meant that assignment silently landed on a throwaway object, so the
        // reused preview never received the origin its page needed.
        if (accent) preview.accent = accent
        return preview
      }
    }
    const sid = randomUUID().slice(0, 8)
    const server = http.createServer()
    server.on('request', (req, res) => {
      const preview = previews.get(sid)
      if (!preview) {
        res.writeHead(404).end()
        return
      }
      preview.touched = Date.now()
      void handlePreviewRequest(req, res, preview)
    })
    server.on('upgrade', (req, socket, head) => {
      const preview = previews.get(sid)
      if (!preview) {
        socket.destroy()
        return
      }
      preview.touched = Date.now()
      void relayUpgrade(req, socket, head, preview)
    })
    // Port 0: the OS picks a free one. Bound to loopback only.
    await new Promise((done, fail) => {
      server.once('error', fail)
      server.listen(0, '127.0.0.1', done)
    })
    const address = server.address()
    // `localhost` and `127.0.0.1` are different origins to a browser, which is
    // exactly what we want: the preview's storage is walled off from the
    // harness even when the harness itself is on 127.0.0.1.
    const preview = {
      sid,
      // `target` is null for a workspace page: those are served from disk and
      // never proxied anywhere.
      target: target || null,
      // The identity the preview was opened for, resolved by the caller. Kept
      // separately because `origin` below is the ephemeral loopback address,
      // and `target` is null for every file preview — neither can be compared
      // against a new request on its own.
      targetOrigin: origin,
      fileRoot: fileRoot || null,
      origin: `http://localhost:${address.port}`,
      server,
      touched: Date.now(),
      parentOrigin: null,
      // The reader's chosen mark colour, handed to the page. The overlay is a
      // separate document, so it cannot inherit the custom property the panel sets
      // on the shell; it has to be told. Kept on the preview record so the value
      // travels with the page even when the page reloads on its own.
      accent: accent || null,
    }
    previews.set(sid, preview)
    return preview
  }

  function close(sid) {
    const preview = previews.get(sid)
    if (!preview) return
    previews.delete(sid)
    try {
      preview.server.close()
    } catch {
      /* already gone */
    }
  }

  // Fiber-scoped: the interval dies with the plugin, no manual teardown.
  ctx.interval(() => {
    const now = Date.now()
    for (const [sid, preview] of previews) {
      if (now - preview.touched > idleMs) close(sid)
    }
  }, 60_000)

  return { open, close, previews }
}

// ----------------------------------------------------------------- detection

/**
 * A response that proves the port is worth offering, not merely that it is open.
 *
 * Offering everything that answers means listing ports that then show a 404 for
 * the reader — a long list of dead links, which is worse than a shorter honest
 * one. Several servers were reported exactly like that (2869, 9180, 9210).
 *
 * `HTTP/1.1 200 OK` is not the test either: the probe walks several paths because
 * a real app may well 401 or redirect at `/`, and those are still a service a
 * person wants to open. What is refused is the *nothing here* answer — a 404, a
 * 405, or a 5xx from a bare listener that is not serving a site at all.
 * @param status - the status code the probe received.
 * @returns whether the row belongs in the list at all.
 */
function servable(status) {
  if (typeof status !== 'number') return false
  if (status === 404 || status === 405 || status === 501) return false
  return status < 500
}

/**
 * Accept an accent only in the exact shape the overlay expects.
 *
 * The value is interpolated into a stylesheet inside the previewed page, so an
 * unchecked string would be a style-injection primitive. Matching HSL channels
 * with a strict pattern and rebuilding the string from the matched groups means
 * anything else — including a valid-looking colour carrying extra declarations —
 * is discarded rather than concatenated.
 * @param value - whatever the client sent.
 * @returns the channels as `H S% L%`, or null when it is not that shape.
 */
function normaliseAccent(value) {
  if (typeof value !== 'string') return null
  const match = /^\s*(\d{1,3})\s+(\d{1,3})%\s+(\d{1,3})%\s*$/.exec(value)
  if (!match) return null
  const [, h, s, l] = match
  if (Number(h) > 360 || Number(s) > 100 || Number(l) > 100) return null
  return `${Number(h)} ${Number(s)}% ${Number(l)}%`
}

/** Ask a port whether something is really listening and speaking HTTP. */
/**
 * Fingerprint the framework behind a dev server from its response.
 *
 * Headers are the reliable signal (Vite, Next, Nuxt and friends all announce
 * themselves), with a look at the body for the ones that stay quiet. This is a
 * best-effort label for a human reading a list, never a security decision, so
 * an unknown server simply gets no label.
 */
function detectStack(headers, body) {
  const header = (name) => String(headers[name] || '').toLowerCase()
  const powered = header('x-powered-by')
  const generator = header('x-generator')
  const server = header('server')
  const lower = body.slice(0, 64 * 1024).toLowerCase()

  const has = (...keys) => keys.some((key) => lower.includes(key))

  // API gateways and app servers announce themselves with a vendor header
  // rather than a framework's asset paths, so they are matched first.
  if (header('x-new-api-version') || header('x-oneapi-request-id') || has('new-api', 'one-api')) {
    return { id: 'newapi', label: 'New API', kind: 'llm-gateway' }
  }
  if (header('x-dsh') || has('deepseek harness')) return { id: 'dsh', label: 'DSH', kind: 'node' }

  // Order matters: the most specific signal wins.
  if (header('x-nextjs-cache') || header('x-nextjs-request-id') || has('__next_data__', '/_next/static')) {
    return { id: 'next', label: 'Next.js', kind: 'react' }
  }
  if (has('__nuxt', '/_nuxt/') || header('x-nuxt-render')) return { id: 'nuxt', label: 'Nuxt', kind: 'vue' }
  if (has('/@vite/client', '/@react-refresh') || /vite/.test(server)) {
    return has('vue') ? { id: 'vite', label: 'Vite + Vue', kind: 'vue' } : { id: 'vite', label: 'Vite', kind: 'node' }
  }
  if (has('__svelte', 'svelte-')) return { id: 'svelte', label: 'Svelte', kind: 'svelte' }
  if (has('ng-version', 'angular')) return { id: 'angular', label: 'Angular', kind: 'angular' }
  // A production bundle leaves a weaker trace than a dev server: match the
  // framework's asset names and runtime markers, not just its dev-server paths.
  // Bundlers split React into files like `lib-react.js`, so `react` as a bare
  // substring is the signal that survives minification.
  if (has('data-reactroot', 'react-dom', 'react.development', 'react.production', '_react', 'react')) {
    return { id: 'react', label: 'React', kind: 'react' }
  }
  if (has('data-v-', 'vue.js', 'vue.runtime', '__vue__')) return { id: 'vue', label: 'Vue', kind: 'vue' }
  if (/django/.test(server) || has('csrfmiddlewaretoken')) return { id: 'django', label: 'Django', kind: 'python' }
  if (/flask|werkzeug/.test(server) || /werkzeug/.test(powered)) return { id: 'flask', label: 'Flask', kind: 'python' }
  if (/uvicorn|gunicorn/.test(server)) return { id: 'fastapi', label: 'Python ASGI', kind: 'python' }
  if (/express/.test(powered)) return { id: 'express', label: 'Express', kind: 'node' }
  if (/tomcat|jetty/.test(server)) return { id: 'java', label: 'Java', kind: 'java' }
  if (/nginx/.test(server)) return { id: 'nginx', label: 'nginx', kind: 'static' }
  if (/python/.test(server)) return { id: 'python', label: 'Python', kind: 'python' }
  if (/go-http|golang/.test(server)) return { id: 'go', label: 'Go', kind: 'go' }
  if (/node|deno|bun/.test(server)) return { id: 'node', label: server.split('/')[0], kind: 'node' }
  return null
}

/** Paths worth trying when `/` alone does not identify a server. */
const PROBE_PATHS = ['/', '/index.html', '/login', '/docs', '/api']

function probe(port, timeout = 700) {
  return new Promise((done) => {
    // One request is not enough: a server that answers 401 at `/` may still serve
    // a page at `/login`, and its headers arrive either way.
    let attempt = 0
    // The first response that is worth opening, kept as a fallback so a real but
    // unlabelled server is still offered to the reader.
    let fallback = null
    const tryNext = () => {
      if (attempt >= PROBE_PATHS.length) {
        done(fallback || { port, ok: false })
        return
      }
      const path = PROBE_PATHS[attempt++]
      probePath(port, path, timeout, (result) => {
        if (!result) {
          tryNext()
          return
        }
        // A 404 here is the server saying it has nothing at this path. It still
        // proves something is listening, so the sweep goes on to the other paths,
        // but it is never offered on its own — that is what produced rows the
        // reader clicked straight into a "not found" page.
        if (!servable(result.status)) {
          tryNext()
          return
        }
        if (!fallback) fallback = result
        if (result.stack || result.title) done(result)
        else tryNext()
      })
    }
    tryNext()
  })
}

/** Shape one probe result for the panel. */
function toServerRow(one) {
  return {
    port: one.port,
    origin: `http://127.0.0.1:${one.port}`,
    title: one.title || null,
    // Carried so a service with no `<title>` is still identifiable in the list.
    // A bare `200 text/html` used to render as "localhost" with no mark, which is
    // exactly the row a reader cannot tell apart from any other.
    path: one.path || '/',
    type: one.type || null,
    status: typeof one.status === 'number' ? one.status : null,
    stack: one.stack || null,
  }
}

function probePath(port, path, timeout, done) {
  const req = http.request(
    { host: '127.0.0.1', port, path, method: 'GET', timeout },
    (res) => {
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size < 64 * 1024) chunks.push(chunk)
      })
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)
        done({
          port,
          ok: true,
          path,
          status: res.statusCode,
          title: title ? title[1].trim().slice(0, 120) : null,
          type: String(res.headers['content-type'] || '').split(';')[0],
          stack: detectStack(res.headers, body),
        })
      })
      res.on('error', () => done(null))
    },
  )
  req.on('timeout', () => {
    req.destroy()
    done(null)
  })
  req.on('error', () => done(null))
  req.end()
}

/** Every loopback port the environment admits to listening on. */
async function listeningPorts() {
  const { execFile } = await import('node:child_process')
  const run = (cmd, args) =>
    new Promise((done) => {
      execFile(cmd, args, { windowsHide: true, timeout: 4000 }, (error, stdout) => {
        done(error ? '' : String(stdout || ''))
      })
    })
  const ports = new Set()
  if (process.platform === 'win32') {
    const out = await run('netstat', ['-ano', '-p', 'TCP'])
    for (const line of out.split(/\r?\n/)) {
      const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING/i.exec(line)
      if (match) ports.add(Number(match[1]))
    }
  } else {
    const out = await run('sh', ['-c', "netstat -an 2>/dev/null || ss -ltn 2>/dev/null"])
    for (const line of out.split(/\r?\n/)) {
      const match = /[:.](\d+)\s+\S*\s*LISTEN/i.exec(line)
      if (match) ports.add(Number(match[1]))
    }
  }
  return [...ports].filter((port) => port > 0 && port < 65536)
}

/** Static pages in the workspace, so a hand-written or built page needs no
 *  dev server at all. */
async function workspacePages(root) {
  const found = []
  const seen = new Set()
  for (const dir of STATIC_DIRS) {
    const base = dir ? join(root, dir) : root
    let entries
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (found.length >= STATIC_PAGE_LIMIT) break
      if (!entry.isFile() || !isHtmlFile(entry.name)) continue
      if (entry.name.startsWith('.')) continue
      const full = join(base, entry.name)
      if (seen.has(full)) continue
      seen.add(full)
      found.push({ path: full, label: dir ? `${dir}/${entry.name}` : entry.name })
    }
  }
  return found
}

// ------------------------------------------------------------------ injection

/**
 * Config, shim and picker go in first, immediately after `<head>`.
 *
 * Nothing is removed: a document may only carry one `<base>` and one CSP meta,
 * and ours would win over the app's. We only add.
 */
function injectIntoHtml(html, config) {
  const head =
    `<script>window.__DSH_ANNOTATE__=${JSON.stringify(config).replace(/</g, '\\u003c')};</script>` +
    (SHIM_SRC ? `<script>${SHIM_SRC}</script>` : '') +
    (config.isolated && OVERLAY_SRC ? `<script>${OVERLAY_SRC}</script>` : '')
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (match) => match + head)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (match) => match + head)
  return head + html
}

// -------------------------------------------------------------------- proxying

function proxyHttp(req, res, preview) {
  const incoming = new URL(req.url, 'http://localhost')
  const origin = preview.target.origin
  const enc = encodeTarget(origin)
  const tail = incoming.pathname
  const search = incoming.search

  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (lower === 'host' || HOP_BY_HOP.has(lower)) continue
    // Keep bodies readable so HTML can be rewritten.
    if (lower === 'accept-encoding') continue
    if (lower === 'cookie') {
      const forwarded = splitCookies(value, enc)
      if (forwarded) headers.cookie = forwarded
      continue
    }
    if (lower === 'origin') {
      headers.origin = origin
      continue
    }
    if (lower === 'referer') {
      // The preview keeps the app's own paths, so only the origin changes.
      try {
        const ref = new URL(value)
        headers.referer = origin + ref.pathname + ref.search
      } catch {
        /* leave it off */
      }
      continue
    }
    headers[key] = value
  }
  headers.host = preview.target.host
  headers['accept-encoding'] = 'identity'

  const upstream = (preview.target.protocol === 'https:' ? https : http).request(
    {
      protocol: preview.target.protocol,
      hostname: preview.target.hostname.replace(/^\[|\]$/g, ''),
      port: preview.target.port || (preview.target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: tail + search,
      headers,
    },
    (upstreamRes) => {
      const type = String(upstreamRes.headers['content-type'] || '')
      const out = {}
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        const lower = key.toLowerCase()
        if (HOP_BY_HOP.has(lower)) continue
        if (UNFRAMEABLE.has(lower)) continue
        if (lower === 'content-length' || lower === 'content-encoding') continue
        if (lower === 'set-cookie') {
          out['set-cookie'] = (Array.isArray(value) ? value : [value]).map((one) => rewriteSetCookie(one, enc, preview.target))
          continue
        }
        if (lower === 'location' && typeof value === 'string') {
          // An absolute upstream redirect must stay on the preview origin, or
          // the next document loses the shim and the overlay.
          try {
            const destination = new URL(value, origin + tail + search)
            out.location =
              destination.origin === origin ? destination.pathname + destination.search + destination.hash : value
          } catch {
            out.location = value
          }
          continue
        }
        out[key] = value
      }

      if (!type.includes('text/html')) {
        res.writeHead(upstreamRes.statusCode ?? 502, out)
        upstreamRes.pipe(res)
        return
      }

      // HTML: inject config, shim and overlay before any app script runs.
      const chunks = []
      upstreamRes.on('data', (chunk) => chunks.push(chunk))
      upstreamRes.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8')
        const body = Buffer.from(
          injectIntoHtml(html, {
            upstream: origin,
            relay: WS_RELAY,
            enc,
            isolated: true,
            parentOrigin: preview.parentOrigin,
            session: preview.sid,
            accent: preview.accent,
          }),
          'utf8',
        )
        out['content-length'] = String(body.length)
        res.writeHead(upstreamRes.statusCode ?? 200, out)
        res.end(body)
      })
      upstreamRes.on('error', () => res.end())
    },
  )

  upstream.setTimeout(15_000, () => upstream.destroy(new Error('connection timed out')))
  upstream.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      `<body style="font:12px ui-monospace,SFMono-Regular,Menlo,monospace;padding:20px;color:#666">${escapeHtml(error.message)}` +
        `<script>parent.postMessage({source:'dsh-annotate-page',type:'error',code:'upstreamUnreachable'},${JSON.stringify(preview.parentOrigin)})</script></body>`,
    )
  })
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy()
  })
  req.pipe(upstream)
}

/** WebSocket upgrades cannot go through the HTTP handler, so the shim points
 *  sockets at a relay path carrying the target in a query parameter. */
function relayUpgrade(req, socket, head, preview) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const target = preview.target
  if (!isLocalTarget(target, false)) {
    socket.destroy()
    return
  }
  const upstream = (target.protocol === 'https:' ? https : http).request({
    hostname: target.hostname.replace(/^\[|\]$/g, ''),
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: 'GET',
    path: url.searchParams.get('path') || '/',
    headers: {
      host: target.host,
      connection: 'Upgrade',
      upgrade: 'websocket',
      ...(req.headers['sec-websocket-key'] ? { 'sec-websocket-key': req.headers['sec-websocket-key'] } : {}),
      ...(req.headers['sec-websocket-version'] ? { 'sec-websocket-version': req.headers['sec-websocket-version'] } : {}),
      ...(req.headers['sec-websocket-protocol'] ? { 'sec-websocket-protocol': req.headers['sec-websocket-protocol'] } : {}),
    },
  })
  upstream.on('upgrade', (res, upstreamSocket, upstreamHead) => {
    const lines = ['HTTP/1.1 101 Switching Protocols']
    for (const [key, value] of Object.entries(res.headers)) {
      if (Array.isArray(value)) for (const one of value) lines.push(`${key}: ${one}`)
      else lines.push(`${key}: ${value}`)
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    if (upstreamHead && upstreamHead.length) socket.write(upstreamHead)
    if (head && head.length) upstreamSocket.write(head)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    const bye = () => {
      upstreamSocket.destroy()
      socket.destroy()
    }
    upstreamSocket.on('error', bye)
    socket.on('error', bye)
    upstreamSocket.on('close', bye)
    socket.on('close', bye)
  })
  upstream.on('error', () => socket.destroy())
  upstream.end()
}

/** Serve one file out of the workspace, refusing anything outside the root. */
async function serveStatic(req, res, root, preview) {
  const incoming = new URL(req.url, 'http://localhost')
  let pathname
  try {
    pathname = decodeURIComponent(incoming.pathname)
  } catch {
    res.writeHead(400).end('bad path')
    return
  }
  if (hasHiddenSegment(pathname)) {
    res.writeHead(403).end('forbidden')
    return
  }
  if (pathname.endsWith('/')) pathname += 'index.html'

  const candidate = resolve(root, '.' + normalize(pathname))
  let real
  try {
    real = await realpath(candidate)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
    return
  }
  // Resolve first, then compare: a symlink out of the root must not pass.
  const realRoot = await realpath(root).catch(() => root)
  if (!insideRoot(real, realRoot)) {
    res.writeHead(403).end('forbidden')
    return
  }
  let info
  try {
    info = await stat(real)
  } catch {
    res.writeHead(404).end('not found')
    return
  }
  if (!info.isFile()) {
    // A directory: try its index, since static servers usually do.
    const index = join(real, 'index.html')
    try {
      const indexInfo = await stat(index)
      if (!indexInfo.isFile()) throw new Error('not a file')
      return serveFile(req, res, index, preview)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('no index')
      return
    }
  }
  return serveFile(req, res, real, preview)
}

async function serveFile(req, res, file, preview) {
  if (isHtmlFile(file)) {
    const html = await readFile(file, 'utf8').catch(() => null)
    if (html === null) {
      res.writeHead(404).end('not found')
      return
    }
    const body = Buffer.from(
      injectIntoHtml(html, {
        upstream: null,
        relay: WS_RELAY,
        enc: encodeTarget(`file://${file}`),
        isolated: true,
        parentOrigin: preview.parentOrigin,
        session: preview.sid,
        accent: preview.accent,
      }),
      'utf8',
    )
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-store' })
    res.end(body)
    return
  }
  let info
  try {
    info = await stat(file)
  } catch {
    res.writeHead(404).end('not found')
    return
  }
  if (info.size > STATIC_FILE_LIMIT) {
    res.writeHead(413).end('too large')
    return
  }
  res.writeHead(200, { 'content-type': staticMime(file), 'content-length': String(info.size), 'cache-control': 'no-store' })
  createReadStream(file).pipe(res)
}

async function handlePreviewRequest(req, res, preview) {
  const url = new URL(req.url || '/', 'http://localhost')
  if (url.pathname === WS_RELAY) {
    res.writeHead(400).end('upgrade required')
    return
  }
  // `localhost` and `127.0.0.1` are distinct origins, so the Referer check
  // needs the harness origin that framed us, learned from the API call.
  if (!allowedPreviewRequest(req, preview.parentOrigin, preview.origin)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('cross-origin preview request refused')
    return
  }
  if (preview.fileRoot) return serveStatic(req, res, preview.fileRoot, preview)
  return proxyHttp(req, res, preview)
}

// ------------------------------------------------------------------------ api

/** Read a JSON body with a hard ceiling so a stuck client cannot balloon it. */
function readJson(req, limit = 4 * 1024 * 1024) {
  return new Promise((done, fail) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        fail(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return done({})
      try {
        done(JSON.parse(text))
      } catch (error) {
        fail(error)
      }
    })
    req.on('error', fail)
  })
}

const sendJson = (res, status, body) => {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length) })
  res.end(payload)
}

export function apply(ctx, config) {
  const options = config || {}
  const manager = createPreviewManager(ctx, options)

  /**
   * Annotations per session, held in memory between the sidebar writing them and
   * the next turn's prompt assembly reading them.
   *
   * Keyed by session id because one browser can drive several conversations at
   * once. The value is replaced wholesale on every update, so there is no merge
   * to get wrong. Entries are dropped once delivered, which is what keeps the
   * context from growing turn after turn.
   */
  const pending = new Map()

  /**
   * The text currently rendered for a session, held for the length of the turn.
   *
   * The loop assembles before EVERY step, not once per turn, so a turn that calls
   * a tool reads this twice. Re-rendering each time would be a mistake: the client
   * reports marks as they are made, so a mark arriving mid-turn would change the
   * text between step one and step two and the model would be handed a second,
   * slightly different copy of the same attachment.
   *
   * Holding the first rendering keeps every step of a turn consistent. The entry
   * is dropped when the turn ends, which is the first moment it is safe to — see
   * the `turn/end` note on the event handler.
   */
  /**
   * How many times each session's annotations have been cleared.
   *
   * The sidebar mirrors its own list and is not told when the host drops one, so
   * without a signal the two halves disagree: the host holds nothing while the
   * panel still lists every mark, and the next re-report uploads them again. The
   * dock polls this to notice that the host has let go, so it can tell the panel
   * to do the same.
   *
   * Declared here rather than inside the installer because the diagnostic route
   * reports it, and the route is defined outside that scope.
   */
  const clearEpoch = new Map()

  /**
   * The batch each session was last cleared of, so a stale re-report can be
   * recognised and dropped instead of resurrecting it.
   *
   * The sidebar learns that the host let go by polling, so for up to one interval
   * it is still holding — and re-asserting — the batch the host has already
   * delivered. Accepting that repeat is what made the capsule come back after a
   * send and the attachment row look like it never went away.
   */
  const clearedBatches = new Map()

  const delivered = new Map()

  /**
   * The last few session events this plugin was handed, for diagnosis.
   *
   * The turn-boundary clear is attached to `session/event`, and that event is
   * published from the session service's OWN scope. When the listener is not
   * consulted the failure is silent: the annotations simply stay, and from outside
   * that is indistinguishable from a clear that ran and did not work. Recording
   * what arrived is what separates the two.
   */
  const eventLog = []

  /**
   * When and why each batch was let go of, for the diagnostic route.
   *
   * Declared HERE, beside the other maps, rather than inside the agent-hook
   * installer that writes it. The `/pending` route lives outside that installer, so
   * a variable declared within it is not in scope at the route — which is a
   * `ReferenceError` at request time, not at load time, so it only appears once
   * someone asks for the diagnostic.
   *
   * The reader's report was "the capsule did not clear", and the held state alone
   * cannot distinguish "the clear never ran" from "the clear ran at the wrong
   * moment". A short history of releases answers that directly.
   */
  const released = []

  /**
   * The name that appears on the transcript row.
   *
   * The transcript labels a plugin-sourced message with this string, so it is the
   * only thing identifying who attached the annotations. It has to be readable at
   * a glance.
   */
  const PLUGIN = 'dsh-annotate'

  /**
   * Build a user-role message carrying plugin context.
   *
   * Hand-rolled rather than imported: this half is plain ESM with no build step,
   * so it cannot reach the harness's `createUserMessage`. The shape is small and
   * fixed — a user-role message is an id plus text content plus a source — and
   * the loop reads exactly those fields.
   *
   * The id must be unique per message; the loop keys its transcript entries on it.
   * @param text - model-facing content.
   * @param source - provenance, which decides the row's label and form.
   * @returns a user message suitable for `decision.messages`.
   */
  const createUserMessage = (text, source) => Object.freeze({
    id: `annotate-${randomUUID()}`,
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze(source),
  })

  /**
   * Render the pending annotations for one session as model-facing text.
   *
   * Returns the empty string when there is nothing to send, which is how the
   * runtime is told to contribute nothing at all.
   *
   * The input crosses an HTTP boundary, so every field is treated as unknown:
   * only strings are used, and an entry that yields nothing is dropped rather
   * than emitted as an empty section. A malformed report therefore costs some
   * tokens at worst; it cannot produce a block of empty headings.
   */
  const renderAnnotations = (sessionId, options) => {
    const list = pending.get(sessionId)
    if (!Array.isArray(list) || !list.length) return ''
    // A diagnostic read must not advance the state it reports.
    const consume = !options || options.consume !== false
    if (consume) {
      // Everything this session sends is written into the transcript as ONE
      // message, so it must read identically on every assembly of that turn.
      // Re-rendering would risk a different string on a later step (the client
      // could have reported another mark mid-turn), which the runtime context
      // would treat as a change and log a second message for.
      const held = delivered.get(sessionId)
      if (held !== undefined) return held
    }
    /** Read one field as a string, ignoring any other type. */
    const field = (entry, key) => (typeof entry?.[key] === 'string' ? entry[key].trim() : '')
    const sections = []
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const selector = field(entry, 'selector')
      const text = field(entry, 'text')
      const note = field(entry, 'note')
      // Geometry is only worth its tokens when the selector is positional and
      // may therefore match more than one element.
      const at = typeof entry.at === 'string' && entry.matches > 1 ? entry.at.trim() : ''
      const body = [
        selector && `selector: ${selector}`,
        text && `text: ${clip(text, 160)}`,
        note && `note: ${clip(note, 600)}`,
        at && `at: ${clip(at, 32)}`,
      ].filter(Boolean)
      // An element with nothing to say is not worth a heading.
      if (body.length) sections.push([`## Element ${sections.length + 1}`, ...body].join('\n'))
    }
    if (!sections.length) return ''
    const block = ['# Web page elements', '', sections.join('\n\n')].join('\n')
    // Remembered so every later assembly of this turn reads identically.
    if (consume) delivered.set(sessionId, block)
    return block
  }

  /**
   * Attach the pending annotations to the turn as their own transcript entry.
   *
   * Two ways exist to get text in front of the model, and the difference is
   * entirely about what the reader can see afterwards.
   *
   * `systemPrompt.context()` is the tidier one, but it funnels every contributor
   * through a single message whose source is stamped `@deepseek-ai/dsh-system-prompt`
   * by the agent loop. The reader's transcript therefore shows a row labelled with
   * that internal package name, with no collapsed summary — nothing that says
   * anything about annotations. The section name this plugin passes reaches only
   * the expanded body, and the snapshot form is hard-coded to carry no summary at
   * all. A reader could not tell their annotations had been attached, which is the
   * whole point of attaching them.
   *
   * So this appends its own message instead, exactly as the built-in time-context
   * does. That puts `dsh-annotate` in the `plugin` field — which IS the label — and
   * lets us declare the `notice` form, the only form allowed a collapsed summary.
   * The row then reads "Context injection · dsh-annotate · N elements attached"
   * before it is expanded.
   *
   * The message is appended in `agent/pre-step`, after the loop's own decision, so
   * it rides with the turn the reader actually sent rather than needing a turn of
   * its own.
   */
  const installContext = () => {
    /**
     * The block already handed to the current turn, per session.
     *
     * `agent/pre-step` fires once per STEP and each step starts from a fresh
     * message list, so there is nothing in the decision itself that says whether
     * this turn has already been given the annotations. Without this marker every
     * step appended another copy: a single act of attaching produced 24 identical
     * transcript rows and 24 copies of the block in one request.
     *
     * Holding the TEXT rather than a flag is what lets a mark added mid-turn still
     * reach the next step: the value changes, so the comparison fails and the new
     * block goes out.
     */
    const attachedInTurn = new Map()
    /**
     * Let go of a batch once it has been handed to the model.
     *
     * The moment that matters is not `turn/end`. It is when the loop appends the
     * message carrying the block (`agent.ts:374-375`), which happens inside the very
     * first step. Waiting for the turn to end meant the capsule stayed on screen for
     * the whole of the assistant's reply: the reader sent a message, the capsule
     * still said "2 elements attached", and nothing looked wrong from this side
     * because the turn genuinely had not finished. From the reader's side the
     * attachment was plainly gone.
     *
     * `clearedBatches` is still written, because the sidebar mirrors its own copy of
     * the list and will re-assert it until it polls the new epoch. Recognising that
     * re-assertion as stale is what stops the batch from being resurrected.
     * @param id - the session to release.
     * @param reason - recorded for the diagnostic route.
     */
    /**
     * Let go of a batch once it has been handed to the model.
     *
     * The moment that matters is not `turn/end`. It is when the loop is about to
     * append the message carrying the block (`agent.ts:374-375`), which happens inside
     * the very first step. Waiting for the turn to end meant the capsule stayed on
     * screen for the whole of the assistant's reply: the reader sent a message, the
     * capsule still said "2 elements attached", and nothing looked wrong from this
     * side because the turn genuinely had not finished. From the reader's side the
     * attachment was plainly gone.
     *
     * `clearedBatches` is still written, because the sidebar mirrors its own copy of
     * the list and will re-assert it until it polls the new epoch. Recognising that
     * re-assertion as stale is what stops the batch from being resurrected.
     * @param id - the session to release.
     * @param reason - recorded for the diagnostic route.
     * @param keepTurn - leave the once-per-turn guard in place. True on the delivery
     *   path: that guard is what stops a later step of the SAME turn from attaching a
     *   second copy, so clearing it there would reintroduce the duplicate rows.
     */
    const releaseBatch = (id, reason, keepTurn) => {
      if (typeof id !== 'string' || !id) return
      const wasHeld = pending.get(id)
      const heldCount = Array.isArray(wasHeld) ? wasHeld.length : 0
      // Nothing held: this is the `turn/end` that follows a delivery which already
      // released the batch, and there is nothing to announce.
      //
      // Returning early keeps the epoch meaning "the batch changed". It used to
      // advance unconditionally, so every delivered batch moved the counter twice
      // — once at handover, once at the boundary — and the sidebar, which polls this
      // to decide whether to drop its mirror, was told to reset on a turn where
      // nothing had changed.
      if (heldCount === 0) return
      clearedBatches.set(id, { signature: JSON.stringify(wasHeld), at: Date.now() })
      pending.delete(id)
      delivered.delete(id)
      if (!keepTurn) attachedInTurn.delete(id)
      clearEpoch.set(id, (clearEpoch.get(id) || 0) + 1)
      released.push({ session: id, reason, count: heldCount, at: Date.now() })
      if (released.length > 20) released.shift()
    }

    /**
     * The turn is over, so whatever it carried has gone out.
     *
     * This is now a backstop rather than the primary signal. Clearing here alone was
     * correct about ordering but wrong about timing: it is the first moment at which
     * "these have gone out" is true, but it is not the first moment at which the
     * reader expects the capsule to clear.
     *
     * The signal is `turn/end`, NOT `turn/start`, and the difference is not
     * stylistic. The agent appends `turn/start` before it enters the step loop
     * (`agent.ts:278` versus the first `preStep` at `:289`), and appends it
     * synchronously, so a listener sees it before any assembly has run. Clearing
     * there deleted the annotations before they were ever read: the first
     * assembly found nothing pending, and the feature silently did nothing on
     * every normal turn.
     *
     * `subject` is the Session itself, and `Session.id` is the same SessionId that
     * `Agent.id` carries, so the two sides key identically.
     */
    const onEvent = (subject, event) => {
      // Recorded so the diagnostic route can report whether this listener is being
      // consulted at all, and whether the turn boundary is reaching it.
      //
      // ONLY the boundaries are kept. A first attempt logged every event and capped
      // the list at 20; a single busy turn emits far more than that, so `turn/end`
      // was pushed out before anyone could read it and the list looked like the
      // clear had never run. A log that cannot show the event it exists to show is
      // worse than no log.
      const type = event && event.type
      if (type !== 'turn/start' && type !== 'turn/end') return
      eventLog.push({
        type,
        session: subject && subject.id,
        turn: event && event.data && event.data.turn,
        at: Date.now(),
      })
      if (eventLog.length > 20) eventLog.shift()
      if (type !== 'turn/end') return
      // Nothing to do when the pre-step already released it, which is the normal
      // path. A batch that is still held here was never delivered — the turn was
      // rejected, aborted, or assembled no messages — and waiting for the boundary
      // is exactly right for that case.
      releaseBatch(subject && subject.id, 'turn-end')
    }
    // `ctx.on` returns its own disposer, so the subscription is released with
    // the context registration rather than outliving it.
    //
    // `{ global: true }` is required, and its absence was invisible from the
    // outside: the session emits this through its OWN scope
    // (`collectSessionCallbacks(entry.emitCtx, ...)`), so a listener registered at
    // the composition scope is never consulted. The host kept handing the same
    // annotations to every later turn — which is exactly what the reader saw, a
    // capsule that never went away after sending. `time-context` subscribes the
    // same way for the same reason (`time-context/src/invariant.ts:177`).
    const offEvent = ctx.on('session/event', onEvent, { global: true })

    /**
     * Append the annotations to the step the loop is about to propose.
     *
     * Hooking `agent/pre-step` rather than the prompt's context is what makes the
     * attachment legible afterwards: this message carries its own `source`, so the
     * reader sees `dsh-annotate` as the label and our own summary line, instead of
     * everything being funnelled under the prompt package's name.
     *
     * The decision is taken from `next()` first, so a step the loop rejects — or
     * one that assembles no messages — is left alone rather than being given an
     * annotation block for a request that will never be sent.
     *
     * Attached ONCE per turn, on its first step. That is forced by the loop rather
     * than chosen: every message in `decision.messages` is appended to the session
     * unconditionally (`agent.ts:374-375`), with no flag to carry one to the model
     * without also recording it. So attaching per step does not merely repeat
     * context — it writes one identical row per step into the reader's
     * conversation. A tool-using turn left a dozen copies of the same attachment.
     *
     * Once per turn is also sufficient. The row is a durable session event, so it
     * is part of the history every later step of the turn is built from: the model
     * on step two sees it exactly as step one did. Guarding on the turn number
     * rather than a boolean keeps that correct across turns.
     *
     * `global: true` because the agent dispatches this through its own scope while
     * the plugin is registered at the composition scope; without it the listener
     * is never consulted and the annotations silently never attach.
     */
    const offPreStep = ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      const agent = payload && payload.agent
      const signal = payload && payload.signal
      if (!decision || decision.kind === 'reject') return decision
      if (signal && signal.aborted) return decision
      const session = agent && agent.id
      if (typeof session !== 'string' || !session) return decision
      // The turn this step belongs to, from the payload — `agent.ts:250` spreads
      // the loop's own `position` into it. The message array cannot identify the
      // step: `preStep` builds a fresh array every time, so an identity check never
      // matches and every step appends another copy.
      const turn = payload && payload.turn
      // Checked before rendering, because rendering consumes the batch.
      if (attachedInTurn.get(session) === turn) return decision
      // Read once and keep the result. `renderAnnotations` drops what it returns, so
      // calling it here and again below would hand the model an empty block on the
      // second read — and the count in the summary would disagree with the body.
      const text = renderAnnotations(session)
      if (!text) return decision
      const marks = pending.get(session)
      const count = Array.isArray(marks) ? marks.length : 0
      // Recorded before the release, which drops this map's entry along with the
      // batch. Marking the turn here is what stops a later step of the SAME turn from
      // attaching a second copy.
      attachedInTurn.set(session, turn)
      // Released synchronously, in the same turn of the event loop that produced the
      // decision. An earlier version deferred this with `setTimeout(…, 0)` to let the
      // loop's own `session.append` land first, but that made the clear race the rest
      // of the step: the batch was sometimes still held when the next step assembled,
      // so the test failed roughly one run in three and, in real use, the capsule
      // could survive a step it should not have. The append does not need to have
      // happened for the value to be correct — only for the diagnostic history to be
      // precise — and determinism is worth more than that precision.
      releaseBatch(session, 'delivered', true)
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage(text, {
            kind: 'plugin',
            plugin: PLUGIN,
            // `notice` is the only form the transcript gives a collapsed summary,
            // and that summary is what tells the reader, without expanding
            // anything, that their marks went along.
            form: 'notice',
            summary: `${count} ${count === 1 ? 'element' : 'elements'} attached`,
          }),
        ],
      }
    }, { global: true })

    return () => {
      offPreStep()
      offEvent()
    }
  }

  /**
   * The workspace root arrives from the client, which knows the session cwd.
   * It is validated once per request against the filesystem rather than
   * trusted, and every static read is confined to it.
   */
  const existingDirectory = (value) => {
    if (typeof value !== 'string' || !value || !isAbsolute(value)) return null
    try {
      const real = realpathSync(value)
      return statSync(real).isDirectory() ? real : null
    } catch {
      return null
    }
  }

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    // A prefix route hands us the full path, so the mount point comes off
    // first; what remains is the action name.
    const action = url.pathname.slice(ROUTE.length).replace(/^\/+|\/+$/g, '') || 'ping'

    if (req.method === 'GET' && action === 'ping') {
      sendJson(res, 200, { ok: true, version: VERSION })
      return
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    let body
    try {
      body = await readJson(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
      return
    }

    // Two actions carry no preview work and are answered before the workspace
    // gate, because the sidebar calls them while composing rather than while
    // browsing a page.
    if (action === 'context') {
      const session = typeof body.session === 'string' ? body.session : ''
      if (!session) {
        sendJson(res, 200, { ok: false, code: 'noSession', error: 'session id required' })
        return
      }
      // A report must carry a list. Anything else is a caller bug, and treating
      // it as "empty" would silently clear annotations the reader can still see
      // in the sidebar, so it is refused instead of absorbed.
      if (body.annotations !== undefined && !Array.isArray(body.annotations)) {
        sendJson(res, 200, { ok: false, code: 'badAnnotations', error: 'annotations must be an array' })
        return
      }
      // Entries that are not objects carry no field this plugin understands.
      // Dropping them here keeps the stored list honest about its own shape.
      const list = (Array.isArray(body.annotations) ? body.annotations : [])
        .filter((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry))
      if (list.length) pending.set(session, list)
      else pending.delete(session)
      // A report that repeats what the host just cleared is not new information —
      // it is the sidebar re-asserting a list it has not yet been told to drop.
      //
      // The dock learns about a clear by polling, so there is a window of up to one
      // interval in which the sidebar can re-upload the batch the host has already
      // let go of. Left alone, that window is a loop: the host clears, the panel
      // re-reports, the capsule comes back, the label reappears, and the reader
      // sees an attachment that never goes away. The epoch recorded at the clear is
      // compared here so a stale repeat is absorbed rather than resurrecting it.
      const cleared = clearedBatches.get(session)
      const signature = JSON.stringify(list)
      // Bounded in time: the window being closed is the one poll interval between
      // the host clearing and the sidebar learning of it. A reader who deliberately
      // re-marks the very same elements a while later is making a new request and
      // must be honoured, so the memory expires.
      const stale = cleared !== undefined && Date.now() - cleared.at < 10_000
      if (list.length && stale && cleared.signature === signature) {
        pending.delete(session)
        sendJson(res, 200, { ok: true, count: 0, ignored: 'already delivered' })
        return
      }
      if (!list.length) clearedBatches.delete(session)
      else clearedBatches.set(session, { signature, at: Date.now() })
      // An explicit empty report is the panel saying "I have nothing left" — the
      // state the host was trying to reach on its own. Recording it as a clear
      // keeps the two halves agreeing instead of ping-ponging.
      if (!list.length) clearEpoch.set(session, (clearEpoch.get(session) || 0) + 1)
      // The rendered text is dropped so the new batch is picked up.
      //
      // This does mean a mark made while a turn is already running changes the
      // block the NEXT step of that turn will carry. That is the honest reading of
      // the request — the reader pointed at something and expects it to go — and
      // the alternative, ignoring it until the turn ends, would silently drop a
      // mark the reader can see in their own sidebar.
      delivered.delete(session)
      sendJson(res, 200, { ok: true, count: list.length })
      return
    }

    if (action === 'pending') {
      // Read back what is held, rendered exactly as the model would receive it.
      // The sidebar reports on change rather than on submit, so without this
      // there is no way to tell "attached but not yet sent" from "never arrived"
      // — which is the question a user asks after clicking.
      //
      // Called with no session it lists every session being held, which is what
      // makes a mismatch diagnosable: the id the shell hands the sidebar is not
      // always the id a caller would guess.
      const session = typeof body.session === 'string' ? body.session : ''
      if (!session) {
        sendJson(res, 200, {
          ok: true,
          sessions: [...pending.entries()].map(([id, list]) => ({
            session: id,
            count: Array.isArray(list) ? list.length : 0,
          })),
        })
        return
      }
      const held = pending.get(session)
      sendJson(res, 200, {
        ok: true,
        count: Array.isArray(held) ? held.length : 0,
        // What the turn-boundary listener has actually been handed. An empty list
        // after a completed turn means the subscription is not being reached at
        // all, rather than the clear running and failing.
        events: eventLog.slice(-8),
        // When and why each batch was let go of. Reported separately from `events`
        // because the interesting failure is not "the clear never ran" but "the
        // clear ran at the wrong moment", and only this list distinguishes them.
        released: released.filter((one) => one.session === session).slice(-8),
        // Rendered without the read-side drop: this action exists to *inspect*
        // what is held, and a diagnostic that consumed the value it reports would
        // be worse than none at all.
        block: renderAnnotations(session, { consume: false }),
        // How many times this session has been cleared. The dock watches for this
        // changing, which is how the sidebar learns to drop a list the host has
        // already let go of.
        epoch: clearEpoch.get(session) || 0,
        sessions: pending.size,
      })
      return
    }

    if (action === 'consume') {
      // Called after a submission is accepted: the annotations were delivered
      // with that turn, so they must not ride along on the next one too.
      const session = typeof body.session === 'string' ? body.session : ''
      const had = pending.delete(session)
      delivered.delete(session)
      sendJson(res, 200, { ok: true, cleared: had === true })
      return
    }

    const workspace = existingDirectory(body && body.root)
    // Local pages outside the workspace are opened only when the plugin config
    // allows it. The caller still names one exact file, and only that file and
    // its siblings are reachable, so this widens what may be previewed without
    // turning the preview into a general filesystem reader.
    const externalAllowed = options.allowExternalFiles === true
    // Detection and static pages need a root; opening a loopback URL does not,
    // as long as the caller is not asking for a `file://` page.
    const needsRoot = ['detect', 'pages'].includes(action) || String((body && body.url) || '').startsWith('file:')
    if (needsRoot && !workspace) {
      sendJson(res, 200, { ok: false, code: 'noRoot', error: 'workspace directory unknown or not a directory' })
      return
    }

    try {
      switch (action) {
        case 'detect': {
          // An explicit `ports` list is scanned as given: the automatic sweep is
          // capped and ranked, so a caller that already knows which ports matter
          // (a test, or a follow-up after opening a server) must be able to say so.
          const requested = Array.isArray(body && body.ports)
            ? body.ports.map(Number).filter((port) => Number.isInteger(port) && port > 0 && port < 65536)
            : null
          if (requested && requested.length) {
            const probed = await Promise.all(requested.map((port) => probe(port)))
            const servers = probed.filter((one) => one.ok).map(toServerRow)
            sendJson(res, 200, { ok: true, servers, workspace })
            return
          }
          const known = await listeningPorts()
          const candidates = [...new Set([...known, ...COMMON_PORTS])]
            .filter((port) => port !== Number(url.port))
            .sort((a, b) => commonRank(a) - commonRank(b) || a - b)
            .slice(0, 40)
          const probed = await Promise.all(candidates.map((port) => probe(port)))
          const servers = probed.filter((one) => one.ok).map(toServerRow)
          sendJson(res, 200, { ok: true, servers, workspace })
          return
        }

        case 'pages': {
          sendJson(res, 200, { ok: true, pages: await workspacePages(workspace), workspace })
          return
        }

        case 'open': {
          const raw = String(body.url || '').trim()
          if (!raw) {
            sendJson(res, 400, { ok: false, error: 'url required' })
            return
          }
          let target = null
          let fileRoot = null
          let filePath = null
          if (raw.startsWith('file:')) {
            // A workspace page: served from disk, never proxied.
            let path
            try {
              path = realpathSync(decodeURIComponent(new URL(raw).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
            } catch {
              sendJson(res, 200, { ok: false, code: 'staticUnavailable', error: 'page not found' })
              return
            }
            if (!insideRoot(path, workspace) && !externalAllowed) {
              // Opening a local page outside the workspace is a deliberate act:
              // the caller names the exact file, and this serves that one page
              // plus the assets beside it. `allowExternalFiles` turns it on.
              sendJson(res, 403, {
                ok: false,
                code: 'outsideWorkspace',
                error: 'page is outside the workspace',
                path,
                hint: 'enable allowExternalFiles in the plugin config to preview local pages outside the workspace',
              })
              return
            }
            if (!isHtmlFile(path)) {
              sendJson(res, 400, { ok: false, error: 'only html pages can be previewed' })
              return
            }
            fileRoot = dirname(path)
            filePath = path
          } else {
            try {
              target = new URL(raw)
            } catch {
              sendJson(res, 400, { ok: false, error: 'unparseable url' })
              return
            }
            if (!isLocalTarget(target, options.allowRemote)) {
              sendJson(res, 403, {
                ok: false,
                code: 'notLocal',
                error: 'only loopback targets are supported in this release',
              })
              return
            }
          }
          const preview = await manager.open({
            origin: target ? target.origin : `file://${fileRoot}`,
            target,
            fileRoot,
            accent: normaliseAccent(body && body.accent),
          })
          preview.parentOrigin = requestOrigin(req)
          // A file preview is served from the page's own directory, so the
          // entry URL must name the file. Pointing at "/" asked that directory
          // for index.html, which usually does not exist: the iframe showed
          // "not found" even though the page was sitting right there.
          const entryPath = fileRoot
            ? '/' + relative(fileRoot, filePath).split(sep).map(encodeURIComponent).join('/')
            : '/'
          sendJson(res, 200, {
            ok: true,
            sid: preview.sid,
            origin: preview.origin,
            url: preview.origin + entryPath,
            target: target ? target.origin : `file://${fileRoot}`,
            fileRoot,
          })
          return
        }

        case 'close': {
          const sid = String(body.sid || '')
          if (!sid || !manager.previews.has(sid)) {
            sendJson(res, 200, { ok: false, code: 'unknownPreview', error: 'unknown preview' })
            return
          }
          manager.close(sid)
          sendJson(res, 200, { ok: true })
          return
        }

        default:
          sendJson(res, 404, { ok: false, error: `unknown action: ${action}` })
      }
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
    }
  }

  // `effect` owns teardown: disposing the plugin removes the route.
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }))
  // Annotations reach the model through a runtime-context contribution rather
  // than through the reader's own message, so their text never appears as
  // something the user typed.
  ctx.effect(() => installContext())
  ctx.effect(() => () => {
    pending.clear()
    delivered.clear()
    for (const sid of [...manager.previews.keys()]) manager.close(sid)
  })
}
