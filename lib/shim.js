/**
 * dsh-annotate — page shim.
 *
 * Runs inside every proxied document, before any app script.
 *
 * The preview keeps the app's own paths and is served from an origin the browser
 * treats as belonging to the app, so most things Just Work. What does not is
 * anything the app addresses by absolute origin: a `fetch('https://api.…')`, an
 * `XMLHttpRequest` to the same host it was served from, or a WebSocket. Those
 * would leave the preview origin, and two things go wrong — the request misses
 * the proxy (so cookie namespacing and header rewriting are skipped), and a
 * cross-origin response is unreadable to the page, which breaks apps that
 * expect an opaque same-origin reply.
 *
 * So we rewrite those three carriers to stay on the preview origin. Nothing
 * else is touched: no globals are replaced wholesale and no DOM is edited, so
 * an app that does not use these APIs sees no difference at all.
 */

;(function () {
  var config = window.__DSH_ANNOTATE__
  if (!config || !config.upstream) return
  if (window.__DSH_ANNOTATE_SHIM__) return
  window.__DSH_ANNOTATE_SHIM__ = true

  var UPSTREAM = config.upstream
  var SELF = location.origin
  var RELAY = config.relay || '/__dsh_annotate_ws'

  /** Rewrite one URL when it points at the app's real origin. */
  function rewrite(url) {
    if (!url) return url
    var text = String(url)
    // Scheme-relative (`//host/path`) is uncommon enough to leave alone unless
    // it names the upstream host.
    if (text.indexOf('//') === 0) {
      if (text.indexOf('//' + UPSTREAM.replace(/^https?:\/\//, '')) === 0) {
        return SELF + text.slice(2 + UPSTREAM.replace(/^https?:\/\//, '').length)
      }
      return text
    }
    if (text.indexOf(UPSTREAM) === 0) return SELF + text.slice(UPSTREAM.length)
    return text
  }

  var httpProtocol = location.protocol === 'http:'
  var wsProtocol = httpProtocol ? 'ws:' : 'wss:'
  var wsOrigin = wsProtocol + '//' + location.host
  var upstreamWs = UPSTREAM.replace(/^http/, 'ws')

  /** Send websockets to the relay path, which knows how to reach the target. */
  function rewriteSocket(url) {
    if (!url) return url
    var text = String(url)
    var path = null
    if (text.indexOf(upstreamWs) === 0) path = text.slice(upstreamWs.length) || '/'
    else if (text.indexOf(wsOrigin) === 0) path = text.slice(wsOrigin.length) || '/'
    else if (text.charAt(0) === '/') path = text
    if (path === null) return url
    var separator = path.indexOf('?') === -1 ? '?' : '&'
    return wsOrigin + RELAY + separator + 'path=' + encodeURIComponent(path)
  }

  // ------------------------------------------------------------------ fetch
  if (typeof window.fetch === 'function') {
    var nativeFetch = window.fetch
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') {
          input = rewrite(input)
        } else if (input && typeof input === 'object' && input.url) {
          var rewritten = rewrite(input.url)
          if (rewritten !== input.url) input = new Request(rewritten, input)
        }
      } catch (error) {
        // A rewrite must never be the reason a request fails.
        void error
      }
      return nativeFetch.call(this, input, init)
    }
  }

  // ------------------------------------------------------- XMLHttpRequest
  if (window.XMLHttpRequest) {
    var nativeOpen = window.XMLHttpRequest.prototype.open
    window.XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments)
      try {
        args[1] = rewrite(url)
      } catch (error) {
        void error
      }
      return nativeOpen.apply(this, args)
    }
  }

  // ------------------------------------------------------------ WebSocket
  if (window.WebSocket) {
    var NativeSocket = window.WebSocket
    var Shimmed = function (url, protocols) {
      return protocols === undefined
        ? new NativeSocket(rewriteSocket(url))
        : new NativeSocket(rewriteSocket(url), protocols)
    }
    Shimmed.prototype = NativeSocket.prototype
    for (var key in NativeSocket) {
      if (Object.prototype.hasOwnProperty.call(NativeSocket, key)) Shimmed[key] = NativeSocket[key]
    }
    try {
      window.WebSocket = Shimmed
    } catch (error) {
      void error
    }
  }

  // ------------------------------------------------------------- navigation
  /**
   * A same-origin `history.pushState` is fine; the overlay re-anchors on
   * `popstate`. What needs care is `location.assign` to an absolute upstream
   * URL, which would leave the preview entirely. `pagehide` is the last
   * reliable moment to warn the panel that annotations are about to be lost.
   */
  window.addEventListener('pagehide', function () {
    try {
      parent.postMessage({ source: 'dsh-annotate-page', type: 'pagehide' }, config.parentOrigin || '*')
    } catch (error) {
      void error
    }
  })
})()
