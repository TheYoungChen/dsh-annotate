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

/** `webServer` gives us the route; `timer` drives the idle sweep. */
export const inject = ['webServer', 'timer']

const ROUTE = '/__dsh-annotate'
const WS_RELAY = '/__dsh_annotate_ws'

/** Dev servers people actually run, probed even when the OS tells us nothing. */
const COMMON_PORTS = [5173, 3000, 4173, 5180, 8080, 8000, 5000, 5500, 9000, 3001, 1234, 4200, 4321, 5174, 6006, 7000, 8001, 8888]

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

  async function open(target) {
    for (const preview of previews.values()) {
      if (preview.target.origin === target.origin && preview.fileRoot === target.fileRoot) {
        preview.touched = Date.now()
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
      target: target.target || null,
      fileRoot: target.fileRoot || null,
      origin: `http://localhost:${address.port}`,
      server,
      touched: Date.now(),
      parentOrigin: null,
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
    // One request is not enough: a server that answers 401 or 404 at `/` may
    // still identify itself on /login or /docs, and its headers arrive either way.
    let attempt = 0
    // The first response that proves *something* is listening, kept as a
    // fallback so an unlabelled server is still offered to the user.
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
    type: one.type || null,
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
      sendJson(res, 200, { ok: true, version: '0.2.0' })
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
  ctx.effect(() => () => {
    for (const sid of [...manager.previews.keys()]) manager.close(sid)
  })
}
