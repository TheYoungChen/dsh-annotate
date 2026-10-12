/**
 * dsh-annotate — picker overlay.
 *
 * Injected into every proxied document. Owns everything that happens *inside*
 * the framed page: hit-testing, the highlight frame, the pin flags, the note
 * card, and the page-side store. It talks to the sidebar panel over
 * postMessage and never touches the host.
 *
 * The one idea worth stating up front: an annotation has two shapes.
 *
 *   - **标注 (mark)** — the user pointed at something and wrote nothing. The
 *     position and the element's facts are the whole message.
 *   - **批注 (annotation)** — the user also wrote a note, so the entry reads as
 *     an instruction about that element.
 *
 * Both are real annotations and both are sent. An empty note is a deliberate
 * outcome, not a cancelled edit, which is why `commit()` never discards one.
 */

;(function () {
  var config = window.__DSH_ANNOTATE__ || {}
  if (window.__DSH_ANNOTATE_OVERLAY__) return
  window.__DSH_ANNOTATE_OVERLAY__ = true

  var CHANNEL = 'dsh-annotate-overlay'
  var PANEL = 'dsh-annotate-panel'
  var STORE_PREFIX = 'dsh-annotate:v1:'
  var session = String(config.session || 'standalone')

  /**
   * The page the reader is on, as an address.
   *
   * The hash belongs in it. Hash-routed apps keep every view on one pathname —
   * `app/#/home` and `app/#/command` are different pages to the reader and the
   * same string to `pathname + search` — so a route that drops the hash cannot
   * tell one view from another, and neither pins nor the panel's address can be
   * right.
   *
   * This is a route, not a storage key. The reader's marks belong to the whole
   * browsing session (see `storeKey`); the route says which of them are on
   * screen and where each one was made.
   */
  function currentPath() {
    return location.pathname + location.search + location.hash
  }

  var pagePath = currentPath()
  // The accent is the reader's choice, handed in with the page config. Stored as
  // HSL channels so the overlay can build its tints and rings from one value;
  // falling back to the same default the panel uses keeps an older host working.
  var ACCENT = String(config.accent || '32 88% 65%')
  var MARKER = 'hsl(' + ACCENT + ')'
  var MARKER_SOFT = 'hsl(' + ACCENT + ' / .22)'
  var MARKER_STRONG = 'hsl(' + ACCENT + ' / .3)'
  var MARKER_GLOW = 'hsl(' + ACCENT + ' / .45)'
  var MARKER_FAINT = 'hsl(' + ACCENT + ' / .04)'

  // The modifier is named for the platform the reader is on: telling a Mac user to
  // press Ctrl is a small lie that costs a moment every time.
  var IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')

  var strings = {
    mark: '标注',
    note: '批注',
    placeholder: '说明要改什么（可留空，留空即标注）',
    save: '保存',
    cancel: '取消',
    remove: '删除',
    title: '标注此元素',
    editTitle: '编辑标注',
    // Says what the two exits do, because the textarea gives no hint: Enter inserts
    // a newline (the note is prose, often several lines), and the modifier chord or
    // the button commits. Without this the reader presses Enter expecting to save
    // and silently gets a second line instead.
    hintEmpty: '留空即「标注」，只标记位置',
    keyNewline: '换行',
    keySave: '保存',
    keyCancel: '关闭',
    saveFailed: '本地存储写入失败，标注可能不会保留',
  }

  var state = {
    mode: 'idle', // idle | marking
    hover: null,
    selected: null,
    anchor: null, // element the open card belongs to
    drafting: null,
    annotations: [],
    sending: false,
  }

  var live = new Map() // annotation id -> element

  /**
   * Signature of the annotations that could not be placed on the last render.
   *
   * Held so the page only speaks up when the situation changes, not on every frame
   * the viewport produces.
   */
  var lastUnplaced = ''

  // ------------------------------------------------------------------ styles

  function css() {
    return [
      '.dsa-layer{position:fixed;inset:0;z-index:2147483000;pointer-events:none;font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111}',
      '.dsa-layer[data-dark="1"]{color:#eee}',
      // While marking, the surface swallows every pointer event so a click picks
      // an element instead of pressing whatever control is underneath. It also
      // carries a faint tint, which is the signal that the page is in pick mode.
      '.dsa-capture{position:absolute;inset:0;pointer-events:auto;cursor:crosshair;background:' + MARKER_FAINT + '}',
      // The hover highlight has to be obvious on any page, light or dark, busy or
  // plain. A translucent fill alone reads as a vague overlay, so the box is
  // marked three ways at once: a solid ring, an inset glow, and corner handles.
  // `mix-blend-mode: difference` keeps the outline visible over both a white
  // page and a black one without knowing which is underneath.
  '.dsa-frame{position:absolute;border:2px solid ' + MARKER + ';background:' + MARKER_SOFT + ';border-radius:2px;pointer-events:none;display:none;box-shadow:0 0 0 1px rgba(255,255,255,.55) inset,0 0 0 1px rgba(0,0,0,.25),0 0 12px ' + MARKER_GLOW + ';transition:none}',
  '.dsa-frame[data-locked="1"]{border-style:solid;background:' + MARKER_STRONG + '}',
      '.dsa-frame i{position:absolute;width:6px;height:6px;background:' + MARKER + ';border:1px solid #fff;border-radius:1px}',
      '.dsa-frame i:nth-child(1){left:-4px;top:-4px}.dsa-frame i:nth-child(2){right:-4px;top:-4px}',
      '.dsa-frame i:nth-child(3){left:-4px;bottom:-4px}.dsa-frame i:nth-child(4){right:-4px;bottom:-4px}',
      '.dsa-readout{position:absolute;pointer-events:none;background:rgba(17,17,17,.92);color:#f5f5f5;padding:3px 6px;border-radius:4px;font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:none}',
      '.dsa-pin{position:absolute;pointer-events:auto;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50% 50% 50% 2px;border:none;background:' + MARKER + ';color:#fff;font:600 11px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;padding:0}',
      // The pin container must re-enable pointer events for its children.
      //
      // `.dsa-layer` sets `pointer-events:none` so the overlay does not swallow the
      // page's own clicks, and a child cannot opt back in across an ancestor that
      // said no: `pointer-events:auto` on the pin was therefore inert, and clicking
      // a number did nothing. The container is the level that has to re-enable it,
      // and it stays empty apart from the pins, so the page underneath is reachable
      // everywhere else.
      '.dsa-pins{position:absolute;inset:0;pointer-events:none}',
      '.dsa-pins>.dsa-pin{pointer-events:auto}',
      '.dsa-pin[data-open="true"]{outline:2px solid #fff;outline-offset:1px}',
      '.dsa-pin[data-kind="mark"]{background:#7f8c9b}',
      '.dsa-card{position:absolute;pointer-events:auto;width:304px;background:#fff;color:#111;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.28);padding:10px;border:1px solid rgba(0,0,0,.08)}',
      '.dsa-layer[data-dark="1"] .dsa-card{background:#1e1e1e;color:#eee;border-color:rgba(255,255,255,.12)}',
      '.dsa-card h4{margin:0 0 4px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px}',
      '.dsa-kind{font-size:10px;font-weight:600;padding:1px 5px;border-radius:3px;background:' + MARKER + ';color:#fff}',
      '.dsa-kind[data-kind="mark"]{background:#7f8c9b}',
      '.dsa-sel{font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.7;word-break:break-all;margin:0 0 7px}',
      '.dsa-card textarea{width:100%;box-sizing:border-box;min-height:62px;resize:vertical;border-radius:6px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font:12px/1.45 inherit;padding:6px}',
      '.dsa-card textarea:focus{outline:2px solid ' + MARKER + ';outline-offset:-1px}',
      '.dsa-hint{font-size:10px;opacity:.6;margin:4px 0 0}',
      // The keyboard legend. Kept small and low-contrast: it is a reference, not
      // something to read every time, but it has to be present because nothing else
      // on the card says which key commits the note.
      '.dsa-keys{display:flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:10px;opacity:.62;margin:6px 0 0}',
      '.dsa-keys kbd{font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;padding:1px 4px;border-radius:4px;border:1px solid rgba(128,128,128,.4);background:rgba(128,128,128,.1)}',
      '.dsa-keys .dsa-dot{opacity:.5}',
      '.dsa-actions{display:flex;gap:6px;justify-content:flex-end;margin-top:8px}',
      '.dsa-actions button{font:12px/1 inherit;padding:6px 10px;border-radius:6px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;cursor:pointer}',
      '.dsa-actions button[data-primary]{background:' + MARKER + ';border-color:' + MARKER + ';color:#fff;font-weight:600}',
      '.dsa-actions .dsa-spacer{flex:1}',
    ].join('')
  }

  // ----------------------------------------------------------------- helpers

  var esc = function (value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
    })
  }
  var clip = function (text, max) {
    var value = String(text || '').replace(/\s+/g, ' ').trim()
    return value.length > max ? value.slice(0, max - 1) + '…' : value
  }

  /** A CSS path that survives a re-render, preferring stable hooks. */
  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return ''
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
      // An id is only usable if it is unique, which is the common case.
      try {
        if (document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + el.id
      } catch (error) {
        void error
      }
    }
    var testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id')
    if (testId) {
      // Only when it names ONE node. A test hook is often shared across a repeated
      // row — a list of users, a grid of cards — and returning it unchecked meant two
      // different elements received the same selector. The second annotation then
      // resolved to the first element, so its pin landed on the wrong node and its
      // number was never drawn while the count still included it.
      var byTestId = '[data-testid="' + testId + '"]'
      try {
        if (document.querySelectorAll(byTestId).length === 1) return byTestId
      } catch (error) {
        void error
      }
    }
    // The element's OWN class, when one is unique. This is the good case: short,
    // readable, and it names the annotated node exactly.
    //
    // Only the element's own class may short-circuit here. Asking for an ancestor's
    // class as a complete selector is what produced `.row` for an `<i>` inside it —
    // a unique selector that resolves to the wrong element, which is worse than a
    // long path because it looks correct. Ancestors are used as anchors by the
    // positional builder below, where the path still reaches the target.
    var byClass = firstUniqueClass(el)
    if (byClass) return byClass
    // A positional path that always ENDS at the element being annotated.
    //
    // The earlier version walked up from the element and, on finding a nameable
    // ancestor, prepended that ancestor and stopped — so the path ended at the parent
    // and never mentioned the target. Annotating `<i>` inside `.row` produced `.row`,
    // which resolves to the container, not to the `<i>`.
    //
    // The shape is now: the nearest nameable ancestor as an anchor, then the chain of
    // segments DOWN to the element, so the final segment is always the target itself.
    var segments = []
    var node = el
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var tag = node.tagName.toLowerCase()
      var parent = node.parentElement
      if (!parent) {
        segments.unshift(tag)
        break
      }
      var sameTag = Array.prototype.filter.call(parent.children, function (child) {
        return child.tagName === node.tagName
      })
      var index = sameTag.indexOf(node) + 1
      segments.unshift(sameTag.length > 1 ? tag + ':nth-of-type(' + index + ')' : tag)
      // Named before the element itself: try the parent as an anchor, and stop there.
      // `uniqueClassSelector(parent)` is asked for the parent's OWN classes, so the
      // anchor names the container while the collected segments still reach the child.
      var anchor = parent.id && /^[A-Za-z][\w-]*$/.test(parent.id)
        ? '#' + parent.id
        : firstUniqueClass(parent)
      if (anchor) {
        segments.unshift(anchor)
        break
      }
      node = parent
      if (segments.length > 6) break
    }
    return segments.join(' > ')
  }

  /**
   * A `.class` selector for the element or one of its ancestors, when it matches
   * exactly one element.
   *
   * `skip` walks that many ancestors up first, which lets the chain builder try
   * to anchor on a parent while the element itself is tried first.
   *
   * Every name the element itself carries is tried before any ancestor's, and that
   * ordering is the point. Returning an ancestor's class describes where the element
   * lives, not which element it is: two different children of one container both
   * resolve through the same parent class, so an ancestor hit is only a fallback.
   *
   * This was the reader's report. Two plainly different nodes — `<span class="badge v">`
   * and `<b style="color:var(--ink)">` — were both recorded as `.l2`, the class of a
   * shared ancestor. Neither annotation ever produced its own selector, both pins were
   * drawn at the ancestor's position, and the second number never appeared.
   */
  function uniqueClassSelector(el, skip) {
    var node = el
    for (var up = 0; up < skip && node; up += 1) node = node.parentElement
    // The element's own classes first, at any depth of the ancestor walk: a class on
    // the node being annotated always identifies it better than one on its parent.
    var self = firstUniqueClass(el)
    if (self) return self
    for (var depth = 0; depth < 3 && node && node.nodeType === 1; depth += 1) {
      if (node === el) {
        node = node.parentElement
        continue
      }
      var hit = firstUniqueClass(node)
      if (hit) return hit
      node = node.parentElement
    }
    return null
  }

  /** The first of a node's own class names that resolves to exactly one element. */
  function firstUniqueClass(node) {
    if (!node || node.nodeType !== 1) return null
    var raw = node.getAttribute('class') || ''
    var names = raw.split(/\s+/).filter(function (one) {
      return one && /^[A-Za-z][\w-]*$/.test(one)
    })
    for (var i = 0; i < names.length; i += 1) {
      var candidate = '.' + CSS.escape(names[i])
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate
      } catch (error) {
        void error
      }
    }
    return null
  }

  function matchesOf(selector) {
    try {
      return document.querySelectorAll(selector).length
    } catch (error) {
      void error
      return -1
    }
  }

  /** Everything the agent needs to find the element again without a screenshot. */
  function detailOf(el) {
    var rect = el.getBoundingClientRect()
    var selector = selectorOf(el)
    var classes = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 4)
    return {
      selector: selector,
      selectorMatches: matchesOf(selector),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      testId: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      name: el.getAttribute('name') || null,
      type: el.getAttribute('type') || null,
      classes: classes,
      text: clip(el.textContent || '', 120),
      page: pagePath,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      doc: {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
    }
  }

  // ------------------------------------------------------------- persistence

  /**
   * One bucket per preview session, not one per route.
   *
   * The key used to end in the route, so switching views inside a single-page app
   * emptied the reader's list: the new route's bucket was a different key,
   * `load()` returned nothing, and the panel was told the annotations were gone.
   * The reader's complaint was exactly that — "切换了页面 之前的标注会失效" — and the
   * root cause was that the marks were filed per view when they belong to the
   * browsing session.
   *
   * A route is still recorded, on each annotation, as `page`. That is what lets
   * the pins be drawn only on the view they were made on while the list, the
   * count and the attachment survive every switch. The two questions — "what is
   * attached?" (the session) and "what is on screen?" (the route) — no longer
   * share one answer.
   *
   * The page is an ephemeral loopback origin walled off from the harness, and the
   * session id is fixed when the preview is created (a reused preview keeps its
   * own), so this bucket outlives navigation and reloads within one preview.
   */
  function storeKey() {
    return STORE_PREFIX + session
  }

  /** Annotations that belong to the view on screen now. */
  function annotationsOn(path) {
    return state.annotations.filter(function (annotation) {
      // Absent `page` means an entry stored before routes were recorded. Those are
      // shown everywhere rather than nowhere: dropping them would silently lose
      // marks the reader can still see attached in the panel.
      return !annotation || typeof annotation.page !== 'string' || annotation.page === path
    })
  }

  /**
   * The marks on one page, in the order that page reads.
   *
   * The sidebar sorts by where an element sits on the page — top to bottom, then
   * left to right — so that a list of marks reads down the page. The pins were
   * numbered by the order the marks were MADE instead, and the two disagree the
   * moment a reader marks something and then marks something above it: the pin
   * labelled 1 sits at the bottom of the page while row 1 of the list is the one
   * at the top.
   *
   * The coordinates are document-space, recorded when the mark was made, and they
   * only mean anything within their own document. This function is therefore
   * scoped to ONE page and takes marks from one page: comparing `y` across two
   * pages compares two rulers, which is what put a mark made later above a mark
   * made earlier. The panel groups by page for the same reason; see `pageGroups`
   * in `client.js`.
   *
   * @param list - annotations from a single page.
   * @returns a new array; the caller's order is not disturbed.
   */
  function readingOrder(list) {
    var at = function (annotation, axis) {
      var doc = annotation && annotation.doc
      var value = doc && doc[axis]
      return typeof value === 'number' && isFinite(value) ? value : 0
    }
    return list
      .map(function (annotation, index) {
        return { annotation: annotation, index: index }
      })
      .sort(function (a, b) {
        var ay = at(a.annotation, 'y')
        var by = at(b.annotation, 'y')
        if (ay !== by) return ay - by
        var ax = at(a.annotation, 'x')
        var bx = at(b.annotation, 'x')
        if (ax !== bx) return ax - bx
        // Ties keep the order they were made in, so the list does not reshuffle
        // between renders when two marks share a position.
        return a.index - b.index
      })
      .map(function (one) {
        return one.annotation
      })
  }

  function load() {
    try {
      var raw = localStorage.getItem(storeKey())
      var list = raw ? JSON.parse(raw) : []
      return Array.isArray(list) ? list : []
    } catch (error) {
      void error
      return []
    }
  }

  /**
   * Read back a bucket written by the per-route build and fold it into this one.
   *
   * The old keys are `prefix + session + ':' + route`, which are distinguishable
   * from the new bare key by the colon. Reading them once means a reader who
   * upgrades does not lose the marks they had on the page they are looking at,
   * and the entries arrive already tagged with the route they came from.
   */
  function migrate() {
    var merged = []
    var stale = []
    try {
      var prefix = STORE_PREFIX + session + ':'
      for (var i = 0; i < localStorage.length; i += 1) {
        var key = localStorage.key(i)
        if (!key || key.indexOf(prefix) !== 0) continue
        stale.push(key)
        var list = JSON.parse(localStorage.getItem(key) || '[]')
        if (!Array.isArray(list)) continue
        var route = key.slice(prefix.length)
        list.forEach(function (annotation) {
          if (!annotation || typeof annotation !== 'object') return
          merged.push(Object.assign({}, annotation, { page: annotation.page || route }))
        })
      }
      // Written before the old keys are dropped: a failure here leaves the old
      // buckets in place, so the next load tries again instead of losing them.
      if (merged.length) localStorage.setItem(storeKey(), JSON.stringify(merged))
      stale.forEach(function (key) {
        localStorage.removeItem(key)
      })
    } catch (error) {
      void error
      return []
    }
    return merged
  }

  function save() {
    try {
      localStorage.setItem(storeKey(), JSON.stringify(state.annotations))
    } catch (error) {
      void error
      post('warning', { message: strings.saveFailed })
    }
  }

  // ------------------------------------------------------------------ chrome

  var root = document.createElement('div')
  root.className = 'dsa-layer'
  var styleEl = document.createElement('style')
  var capture = document.createElement('div')
  capture.className = 'dsa-capture'
  var frame = document.createElement('div')
  frame.className = 'dsa-frame'
  frame.innerHTML = '<i></i><i></i><i></i><i></i>'
  var readout = document.createElement('div')
  readout.className = 'dsa-readout'
  var pinLayer = document.createElement('div')
  pinLayer.className = 'dsa-pins'
  var card = null

  function mount() {
    styleEl.textContent = css()
    root.appendChild(styleEl)
    root.appendChild(pinLayer)
    root.appendChild(frame)
    root.appendChild(readout)    // Mount on <body>, and wait for it when this script runs from <head>.
    //
    // The overlay is injected into <head>, so at parse time <body> does not
    // exist yet. Attaching to <html> instead put the layer in a containing
    // block the page can transform, which made the highlight drift and resize
    // as the page scrolled.
    attach()
    render()
  }

  /**
   * Adopt a new mark colour, live.
   *
   * Rewriting the stylesheet rather than setting a custom property on the layer:
   * every accent use is already built from these channels at parse time, and the
   * pins and frame live inside the page's own document where an inherited
   * variable from the shell cannot reach them. Rebuilding is a few hundred bytes
   * of CSS and happens only when the reader changes the setting.
   * @param value - HSL channels, already validated by the host.
   */
  function setAccent(value) {
    if (typeof value !== 'string' || !/^\d{1,3} \d{1,3}% \d{1,3}%$/.test(value)) return
    ACCENT = value
    MARKER = 'hsl(' + ACCENT + ')'
    MARKER_SOFT = 'hsl(' + ACCENT + ' / .22)'
    MARKER_STRONG = 'hsl(' + ACCENT + ' / .3)'
    MARKER_GLOW = 'hsl(' + ACCENT + ' / .45)'
    MARKER_FAINT = 'hsl(' + ACCENT + ' / .04)'
    styleEl.textContent = css()
    // The pins and the frame are created from the variables above at render
    // time, so the marks already on the page have to be redrawn to pick them up.
    render()
  }

  function attach() {
    var host = document.body
    if (host) {
      host.appendChild(root)
      return
    }
    // Still parsing: take the first moment a body exists.
    var observer = new MutationObserver(function () {
      if (document.body) {
        observer.disconnect()
        document.body.appendChild(root)
        render()
      }
    })
    observer.observe(document.documentElement, { childList: true })
  }

  function mountCapture() {
    var active = state.mode === 'marking'
    if (active && capture.parentNode !== root) root.insertBefore(capture, pinLayer)
    if (!active && capture.parentNode === root) root.removeChild(capture)
  }

  // The capture surface is mounted and unmounted with the mode, so its pointer
  // handlers are bound once here rather than on every mount.
  capture.addEventListener('mousemove', function (event) {
    onMove(event)
  })
  // Leaving the page at all — reaching for the composer, or for anything
  // outside the preview — must read as "nothing is hovered".
  //
  // No `mousemove` follows the pointer out of the frame, so without this the
  // last hovered element stayed framed and named after the pointer had already
  // gone somewhere else. The reader described that as the page still looking
  // selected while they were typing, which is the same complaint as the
  // whole-document one and has the same answer: no pointer, no highlight.
  capture.addEventListener('mouseleave', function () {
    if (state.mode !== 'marking' || card) return
    if (state.hover === null) return
    state.hover = null
    renderFrame()
  })
  capture.addEventListener('click', function (event) {
    pick(event)
  })
  // A card that is open still needs the surface inert: writing happens in the
  // card, and a stray click underneath it should not start a new pick.
  capture.addEventListener('mousedown', function (event) {
    if (card) event.preventDefault()
  })

  /**
   * The capture surface owns the pointer while marking, so `event.target` is
   * always the surface. Ask the document for the real element with our own
   * hit-testing switched off for exactly one call.
   */
  function elementAt(x, y) {
    var previous = capture.style.pointerEvents
    capture.style.pointerEvents = 'none'
    var el = document.elementFromPoint(x, y)
    capture.style.pointerEvents = previous || 'auto'
    if (!el || el === root || root.contains(el)) return null
    // Empty space resolves to the document itself; see `isPageItself`.
    if (isPageItself(el)) return null
    return el
  }

  /**
   * Is this element the page itself rather than something on it?
   *
   * `elementFromPoint` answers with the nearest element under the cursor, and
   * where the page has no content under the cursor the nearest element IS the
   * document: `elementFromPoint` returns `<html>` for a point in a margin, a gap
   * between blocks, or anywhere past the last element on a short page.
   *
   * The reader's report was that moving the pointer off the sidebar — reaching
   * for the composer to type — made the whole page look selected. Nothing was
   * being selected: the hover target had become `<html>`, so the frame was
   * outlining the entire document and the readout was naming it. On a page that
   * fills the viewport that is indistinguishable from "everything is selected",
   * and it is the one reading that is never useful: nobody annotates the
   * document element.
   *
   * So the page-level elements are treated as empty space. The frame and the
   * readout then hide exactly as they do over any other gap, which is what
   * "there is nothing here" is supposed to look like.
   */
  function isPageItself(el) {
    return el === document.documentElement || el === document.body
  }

  function isDark() {
    try {
      var bg = getComputedStyle(document.body).backgroundColor
      var match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg)
      if (!match) return false
      return (Number(match[1]) * 299 + Number(match[2]) * 587 + Number(match[3]) * 114) / 1000 < 128
    } catch (error) {
      void error
      return false
    }
  }

  function render() {
    root.setAttribute('data-dark', isDark() ? '1' : '0')
    mountCapture()
    renderFrame()
    renderPins()
  }

  function renderFrame() {
    var target = state.selected || state.hover
    if (!target || !target.isConnected) {
      frame.style.display = 'none'
      readout.style.display = 'none'
      return
    }
    var rect = target.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) {
      frame.style.display = 'none'
      readout.style.display = 'none'
      return
    }
    frame.style.display = 'block'
    // A committed pick keeps a stronger fill than a passing hover, so the one
    // element that is about to be annotated stands out from the one under the
    // cursor.
    frame.setAttribute('data-locked', state.selected ? '1' : '0')
    frame.style.left = rect.left + 'px'
    frame.style.top = rect.top + 'px'
    frame.style.width = rect.width + 'px'
    frame.style.height = rect.height + 'px'

    var label = selectorOf(target)
    readout.textContent = label + (matchesOf(label) > 1 ? ' (' + matchesOf(label) + ' matches)' : '')
    readout.style.display = 'block'
    var top = rect.top - 22
    if (top < 4) top = Math.min(rect.bottom + 4, window.innerHeight - 22)
    readout.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 200)) + 'px'
    readout.style.top = top + 'px'
  }

  /**
   * Dock the note card.
   *
   * Below first, because a note reads as belonging to the thing it describes
   * and the eye continues downward; only when there is no room below do we try
   * above, then the right, then the left. The element itself is never covered.
   */
  function anchorCard() {
    if (!card || !state.anchor || !state.anchor.isConnected) return
    var rect = state.anchor.getBoundingClientRect()
    var width = card.offsetWidth || 304
    var height = card.offsetHeight || 190
    var gap = 10

    var top
    if (window.innerHeight - rect.bottom >= height + gap) top = rect.bottom + gap
    else if (rect.top >= height + gap) top = rect.top - height - gap
    else top = Math.max(8, Math.min(rect.bottom + gap, window.innerHeight - height - 8))

    var left
    if (window.innerWidth - rect.left >= width + 8) left = rect.left
    else left = Math.min(rect.right - width, window.innerWidth - width - 8)

    card.style.left = Math.max(8, left) + 'px'
    card.style.top = Math.max(8, top) + 'px'
  }

  /** Resolve an annotation back to its element, refusing lookalike swaps. */
  function elementFor(annotation) {
    var cached = live.get(annotation.id)
    if (cached && cached.isConnected) return cached
    var found
    try {
      found = annotation.selector ? document.querySelector(annotation.selector) : null
    } catch (error) {
      void error
      found = null
    }
    if (!found) return null
    // A reused selector can land on a different kind of node after a re-render.
    if (annotation.tag && found.tagName.toLowerCase() !== String(annotation.tag).toLowerCase()) return null
    // Refuse an ambiguous selector rather than silently picking the first match.
    //
    // `querySelector` returns the first node in document order, so when two
    // annotations share a selector they both resolve to the SAME element: one pin is
    // drawn twice on top of itself and the other element gets none, while the count
    // still reports both. The reader sees a number missing and a count that keeps
    // climbing. Matched against the recorded text where there is one, so the correct
    // node is preferred over merely rejecting the annotations.
    var candidates
    try {
      candidates = document.querySelectorAll(annotation.selector)
    } catch (error) {
      void error
      candidates = null
    }
    if (candidates && candidates.length > 1) {
      var wanted = typeof annotation.text === 'string' ? annotation.text.trim() : ''
      var exact = null
      for (var i = 0; i < candidates.length; i += 1) {
        var text = (candidates[i].textContent || '').trim()
        if (wanted && text === wanted) {
          exact = candidates[i]
          break
        }
        // Recorded text is clipped, so the node's text may be longer.
        if (!exact && wanted && text.indexOf(wanted) === 0) exact = candidates[i]
      }
      if (exact) found = exact
      else found = null
    }
    live.set(annotation.id, found)
    return found
  }

  /**
   * Where a pin belongs right now, in viewport coordinates.
   *
   * Returns the reason as well as the anchor, because "no anchor" covers three
   * unrelated situations and the caller has to tell them apart:
   *
   *   - `missing`   the selector no longer resolves — the page really did change
   *                 under the reader, and saying so is useful
   *   - `hidden`    the element is there but paints nothing right now (a collapsed
   *                 accordion, an inactive tab)
   *   - `offscreen` the element is simply scrolled out of view
   *
   * Only the first is worth reporting. Scrolling is not an error, and a report that
   * fires on it is worse than no report at all: the reader scrolls down, is told
   * "N 项标注无法定位到页面元素", scrolls back, and the warning disappears — which
   * teaches them to ignore the one message that is supposed to mean their page
   * changed.
   *
   * @param annotation - the mark to locate.
   * @returns `{ anchor, reason }`; `anchor` is null whenever `reason` is set.
   */
  function pinAnchor(annotation) {
    var el = elementFor(annotation)
    if (!el || !el.isConnected) return { anchor: null, reason: 'missing' }
    if (!el.getClientRects().length) return { anchor: null, reason: 'hidden' }
    var rect = el.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) return { anchor: null, reason: 'hidden' }
    var bounds = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
    for (var node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      var style = getComputedStyle(node)
      var box = node.getBoundingClientRect()
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        bounds.left = Math.max(bounds.left, box.left)
        bounds.right = Math.min(bounds.right, box.right)
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        bounds.top = Math.max(bounds.top, box.top)
        bounds.bottom = Math.min(bounds.bottom, box.bottom)
      }
    }
    // A pin floating over an unrelated component is worse than no pin.
    if (rect.bottom <= bounds.top || rect.top >= bounds.bottom || rect.right <= bounds.left || rect.left >= bounds.right) {
      return { anchor: null, reason: 'offscreen' }
    }
    return {
      anchor: {
        x: Math.max(bounds.left + 12, Math.min(bounds.right - 12, rect.left + rect.width / 2)),
        y: Math.max(12, Math.min(bounds.bottom - 12, rect.top)),
      },
      reason: null,
    }
  }

  function renderPins() {
    pinLayer.innerHTML = ''
    var here = annotationsOn(pagePath)
    // The number is this mark's row on THIS page's group of the panel's list.
    //
    // Three surfaces put a number on a mark: the pin, the panel's row, and the
    // `## Element n` heading in the block the model receives. All three have to
    // name the same mark with the same number, or the number is worse than none.
    //
    // Numbering by position in the SESSION was tried and could not hold, because
    // this document cannot see the other pages. Each tab is its own origin and so
    // its own storage: a page loads only its own marks, and any count it computes
    // therefore starts at 1 no matter where those marks sit in the session list.
    // With marks on two pages the reader got a panel reading 1, 2 while both pins
    // read 1 — the panel and the page disagreeing about the same two marks. A
    // session-wide number is not merely awkward here, it is unrepresentable: it
    // would have to be pushed in from the panel before it could be drawn, and
    // until that message arrived the page's own count would contradict it.
    //
    // So the page is the unit of numbering, and the panel groups by page to match
    // (`pageGroups` in `client.js`). Within the page the rule is the panel's own —
    // read down the page, top to bottom then left to right — so pin n and the nth
    // row of this page's group are the same element. Numbering by the order marks
    // were MADE instead put pin 1 at the bottom while row 1 was the element at the
    // top; that disagreement is what this mirrors to avoid.
    //
    // A mark that cannot be placed here keeps its number rather than closing the
    // gap, so the pins on screen may read 1 and 3. That is the honest reading:
    // those numbers name real rows, and the panel says which entry could not be
    // placed and why.
    //
    // The one case this cannot reconcile: an entry stored before marks recorded
    // their page. It is shown on the page it is drawn on, but the panel cannot
    // know which page that was and groups it separately, so the two can disagree
    // about it. Nothing in the record says where it came from, so no numbering
    // rule could agree about it.
    var numbered = readingOrder(here.filter(function (one) {
      // Mirrors the panel's own filter, so an entry it refuses to list does not
      // shift the numbers of the ones it does.
      return one !== null && typeof one === 'object'
    }))
    var unplaced = []
    here.forEach(function (annotation) {
      var placed = pinAnchor(annotation)
      var anchor = placed.anchor
      if (!anchor) {
        // Only a selector that no longer resolves counts as "cannot be placed".
        //
        // Scrolling out of view and being temporarily hidden both land here, and
        // neither is a problem: the pin reappears the moment the reader scrolls
        // back. Reporting those made the warning fire on ordinary scrolling — the
        // reader scrolls down, is told the marks cannot be located, scrolls back,
        // and the warning goes away. A warning that fires on scrolling is not a
        // warning; it just trains the reader to ignore the one that matters.
        if (placed.reason === 'missing') {
          unplaced.push({
            id: annotation.id,
            selector: annotation.selector,
            text: annotation.text,
            note: annotation.note,
          })
        }
        return
      }
      // This page's row number — the number the panel prints on the row in this
      // page's group. Read from the ordered list rather than from a counter here,
      // because a counter over just the pins that could be drawn is what made a
      // mark that came and went change its number.
      var ordinal = numbered.indexOf(annotation) + 1
      var pin = document.createElement('button')
      pin.type = 'button'
      pin.className = 'dsa-pin'
      pin.textContent = String(ordinal)
      pin.title = annotation.note ? annotation.note : strings.mark
      pin.setAttribute('data-kind', annotation.note ? 'note' : 'mark')
      pin.setAttribute('data-open', state.drafting && state.drafting.id === annotation.id ? 'true' : 'false')
      pin.dataset.index = String(ordinal)
      // Kept on the element so `positionPins` can follow whatever the pins are
      // actually numbered, rather than re-deriving the pairing from list order.
      pin.__annotation = annotation
      pin.style.left = anchor.x + 'px'
      pin.style.top = anchor.y + 'px'
      pin.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        var el = elementFor(annotation)
        if (!el) {
          post('missing', { id: annotation.id, selector: annotation.selector })
          return
        }
        openCard({ id: annotation.id, existing: true, detail: detailOf(el), note: annotation.note || '' }, el)
      })
      pinLayer.appendChild(pin)
    })
    // Announced only when the set changes. `renderPins` runs on every scroll and
    // resize, so posting unconditionally would flood the channel with the same fact.
    //
    // The route is part of the signature because the same entries mean different
    // things on different views: without it, navigating to a page where every mark
    // is absent would look like "nothing changed" and the previous view's clean bill
    // of health would stand.
    var signature = pagePath + '|' + unplaced.map(function (one) { return one.id }).sort().join(',')
    if (signature !== lastUnplaced) {
      lastUnplaced = signature
      // `total` is what this route should be showing, and `session` is the whole
      // attached list. The two differ exactly when the reader has marks on more
      // than one page, which the panel says out loud rather than treating as a
      // failure to place them.
      post('unplaced', {
        count: unplaced.length,
        total: here.length,
        session: state.annotations.length,
        page: pagePath,
        items: unplaced,
      })
    }
    // Keep the frame honest when the annotated element moved under us.
    renderFrame()
  }

  // -------------------------------------------------------------- note card

  function closeCard() {
    if (card && card.parentNode) card.parentNode.removeChild(card)
    card = null
    state.anchor = null
    state.drafting = null
    state.selected = null
    post('drafting', { id: null })
    renderPins()
  }

  function openCard(draft, el) {
    closeCard()
    state.drafting = draft
    state.anchor = el
    state.selected = el

    card = document.createElement('div')
    card.className = 'dsa-card'
    var hasNote = Boolean(draft.note)
    card.innerHTML =
      '<h4>' +
      esc(draft.existing ? strings.editTitle : strings.title) +
      '<span class="dsa-kind" data-kind="' + (hasNote ? 'note' : 'mark') + '">' +
      esc(hasNote ? strings.note : strings.mark) +
      '</span></h4>' +
      '<p class="dsa-sel">' +
      esc(draft.detail.selector || '') +
      (draft.detail.selectorMatches > 1 ? ' (' + draft.detail.selectorMatches + ' matches)' : '') +
      '</p>' +
      '<textarea placeholder="' + esc(strings.placeholder) + '"></textarea>' +
      '<p class="dsa-hint">' + esc(strings.hintEmpty) + '</p>' +
      '<p class="dsa-keys">' +
      '<kbd>Enter</kbd> ' + esc(strings.keyNewline) +
      '<span class="dsa-dot">·</span>' +
      '<kbd>' + esc(IS_MAC ? '⌘' : 'Ctrl') + '</kbd><span>+</span><kbd>Enter</kbd> ' + esc(strings.keySave) +
      '<span class="dsa-dot">·</span>' +
      '<kbd>Esc</kbd> ' + esc(strings.keyCancel) +
      '</p>' +
      '<div class="dsa-actions">' +
      (draft.existing ? '<button type="button" data-remove>' + esc(strings.remove) + '</button>' : '') +
      '<span class="dsa-spacer"></span>' +
      '<button type="button" data-cancel>' + esc(strings.cancel) + '</button>' +
      '<button type="button" data-primary>' + esc(strings.save) + '</button>' +
      '</div>'

    var area = card.querySelector('textarea')
    area.value = draft.note || ''

    var kind = card.querySelector('.dsa-kind')
    var sync = function () {
      // The badge previews what saving will produce, so the empty case is
      // visibly "still an annotation" rather than looking unfinished.
      var filled = Boolean(area.value.trim())
      kind.setAttribute('data-kind', filled ? 'note' : 'mark')
      kind.textContent = filled ? strings.note : strings.mark
    }
    area.addEventListener('input', sync)
    area.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeCard()
        return
      }
      // ⌘/Ctrl+Enter commits; plain Enter stays a newline, since notes are prose.
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        commit()
      }
    })
    card.querySelector('[data-cancel]').addEventListener('click', closeCard)
    card.querySelector('[data-primary]').addEventListener('click', commit)
    var remove = card.querySelector('[data-remove]')
    if (remove) {
      remove.addEventListener('click', function () {
        state.annotations = state.annotations.filter(function (annotation) {
          return annotation.id !== draft.id
        })
        live.delete(draft.id)
        save()
        closeCard()
        post('changed', { annotations: state.annotations })
      })
    }

    root.appendChild(card)
    anchorCard()
    setTimeout(function () {
      area.focus()
      area.setSelectionRange(area.value.length, area.value.length)
    }, 10)
    post('drafting', { id: draft.id, selector: draft.detail.selector })
    renderPins()
  }

  /**
   * Save the open card.
   *
   * An empty note is kept. That is the whole point of this build: pointing at
   * something is itself a complete statement, and turning it into an
   * annotation whose note happens to be blank is correct — not the same as
   * cancelling. `⌘/Ctrl`-click still means "save and send".
   */
  function commit() {
    if (!card || !state.drafting || !state.anchor) return
    var el = state.anchor
    if (!el.isConnected) {
      closeCard()
      return
    }
    var note = card.querySelector('textarea').value.trim()
    var detail = detailOf(el)
    var draft = state.drafting

    if (draft.existing) {
      state.annotations = state.annotations.map(function (annotation) {
        return annotation.id === draft.id ? Object.assign({}, annotation, detail, { note: note }) : annotation
      })
    } else {
      state.annotations = state.annotations.concat([
        // `page` is the view this mark belongs to, recorded so the pin can follow
        // its own route while the list stays whole across navigation.
        Object.assign({ id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), note: note, createdAt: Date.now(), page: pagePath }, detail),
      ])
    }
    live.set(draft.id, el)
    save()
    var ship = state.sendOnCommit
    state.sendOnCommit = false
    closeCard()
    renderPins()
    post('changed', { annotations: state.annotations })
    if (ship) post('send', { annotations: state.annotations })
  }

  // ----------------------------------------------------------------- picking

  function pick(event) {
    var el = elementAt(event.clientX, event.clientY)
    if (!el) {
      // A click on nothing while writing means "put the card away".
      if (card) {
        event.preventDefault()
        event.stopPropagation()
        closeCard()
      }
      return
    }
    event.preventDefault()
    event.stopPropagation()
    state.selected = el
    state.hover = null
    // ⌘/Ctrl-click is the shortcut for "write it and send it straight away".
    state.sendOnCommit = Boolean(event.metaKey || event.ctrlKey)
    openCard({ id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), detail: detailOf(el), note: '' }, el)
  }

  function onMove(event) {
    if (state.mode !== 'marking' || card) return
    var el = elementAt(event.clientX, event.clientY)
    if (el === state.hover) return
    state.hover = el
    renderFrame()
  }

  function setMode(mode) {
    state.mode = mode === 'marking' ? 'marking' : 'idle'
    if (state.mode === 'idle') {
      state.hover = null
      closeCard()
    }
    render()
    post('mode', { mode: state.mode, count: state.annotations.length })
  }

  // -------------------------------------------------------------- messaging

  function post(type, payload) {
    try {
      parent.postMessage(
        Object.assign({ source: CHANNEL, type: type, page: pagePath }, payload || {}),
        config.parentOrigin || '*',
      )
    } catch (error) {
      void error
    }
  }

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || data.source !== PANEL) return
    switch (data.type) {
      case 'mode':
        setMode(data.mode)
        break
      case 'accent':
        // Recolour in place. The panel sends this when the reader picks a new mark
        // colour, so an already-open page does not have to be reloaded (which would
        // drop the annotations the reader is looking at).
        setAccent(data.accent)
        break
      case 'focus': {
        var annotation = state.annotations.filter(function (one) {
          return one.id === data.id
        })[0]
        if (!annotation) return
        var el = elementFor(annotation)
        if (!el) {
          post('missing', { id: annotation.id, selector: annotation.selector })
          return
        }
        try {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        } catch (error) {
          void error
          el.scrollIntoView()
        }
        state.hover = el
        renderFrame()
        break
      }
      case 'edit': {
        // The panel asked to reopen one entry for editing.
        var target = state.annotations.filter(function (one) {
          return one.id === data.id
        })[0]
        if (!target) return
        var node = elementFor(target)
        if (!node) {
          post('missing', { id: target.id, selector: target.selector })
          return
        }
        openCard({ id: target.id, existing: true, detail: detailOf(node), note: target.note || '' }, node)
        break
      }
      case 'key': {
        // Leaving marking mode. The page keeps its marks: they are the durable
        // record for this session, and an earlier version cleared them here,
        // which made every new mark silently replace the previous batch — the
        // page restarted from empty, the panel mirrored that, and the host was
        // told the list had shrunk.
        if (data.clear) {
          setMode('idle')
        }
        break
      }
      case 'keep': {
        // The panel removed one entry and sent back the list that should survive.
        //
        // Deletion used to be panel-only: the pin stayed on the page, the page's
        // next `changed` mirrored it back, and the mark the reader had just deleted
        // reappeared on its own. Removing it here is what makes the two sides agree.
        //
        // Matched by identity rather than by id. The panel's list and this store
        // label the same mark differently once an entry has been adopted from a
        // host report — those carry an id the panel invented — so selector, note
        // and route are the only fields both sides can compare. That is the same
        // key `restore` merges on, which keeps the two paths consistent.
        var wanted = Array.isArray(data.annotations) ? data.annotations : []
        var alive = {}
        wanted.forEach(function (one) {
          if (!one || typeof one !== 'object') return
          alive[(one.page || '') + '\u0000' + (one.selector || '') + '\u0000' + (one.note || '')] = true
        })
        var kept = state.annotations.filter(function (one) {
          if (!one) return false
          return alive[(one.page || '') + '\u0000' + (one.selector || '') + '\u0000' + (one.note || '')] === true
        })
        // Nothing actually went away: rebuilding and re-posting would only bounce
        // the panel's own list back at it.
        if (kept.length === state.annotations.length) break
        state.annotations = kept
        live.clear()
        save()
        render()
        post('changed', { annotations: state.annotations })
        break
      }
      case 'purge': {
        // The panel's "clear all" is the one act that empties the page, because
        // it is the one act the reader performs deliberately rather than as a
        // side effect of using the feature.
        //
        // `render()` is the whole of what makes the clear VISIBLE. Emptying the
        // store and saving it is invisible on its own: the pins are drawn by
        // `renderPins()`, which only ever runs from `render()`, so without this
        // line the reader is told the marks are gone — the sidebar empties, the
        // composer capsule clears — while the numbered bubbles stay on the page
        // until some unrelated event happens to redraw them. `keep` above calls
        // it for the same reason; this case was written without it.
        state.annotations = []
        live.clear()
        save()
        render()
        post('changed', { annotations: [] })
        break
      }
      case 'restore': {
        // The host handed back a batch it is still holding.
        //
        // This is what makes the marks survive the panel being unmounted, the
        // preview being rebuilt, or the reader coming back later: the page's own
        // storage is per origin and an ephemeral preview is a fresh origin, so the
        // page can come up empty while the attachment the reader can still see
        // counted in the composer is very much alive. The host is the durable side
        // for that window, and this puts its copy back where the pins are drawn.
        //
        // Merged rather than assigned. The page may already hold the same marks —
        // a reused preview keeps its origin and therefore its storage — and the two
        // copies have different ids (one side invented them), so identity is the
        // selector together with the note and the route it was made on.
        var incoming = Array.isArray(data.annotations) ? data.annotations : []
        if (!incoming.length) break
        var seen = {}
        state.annotations.forEach(function (one) {
          if (one) seen[one.page + '\u0000' + one.selector + '\u0000' + one.note] = true
        })
        var added = 0
        incoming.forEach(function (one) {
          if (!one || typeof one !== 'object' || typeof one.selector !== 'string' || !one.selector) return
          var key = (one.page || '') + '\u0000' + one.selector + '\u0000' + (one.note || '')
          if (seen[key]) return
          seen[key] = true
          added += 1
          state.annotations = state.annotations.concat([
            {
              id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              selector: one.selector,
              text: typeof one.text === 'string' ? one.text : '',
              note: typeof one.note === 'string' ? one.note : '',
              matches: typeof one.matches === 'number' ? one.matches : 1,
              page: typeof one.page === 'string' ? one.page : pagePath,
              createdAt: Date.now(),
              restored: true,
            },
          ])
        })
        if (!added) break
        save()
        live.clear()
        // The batch is re-anchored against the DOM that is on screen now, so a pin
        // whose element is gone is reported as unplaceable rather than silently
        // dropped — the reader gets the honest version.
        lastUnplaced = null
        render()
        post('changed', { annotations: state.annotations })
        break
      }
      default:
        break
    }
  })

  // ------------------------------------------------------------ re-anchoring

  var frameQueued = false
  function onViewportChange() {
    if (frameQueued) return
    frameQueued = true
    requestAnimationFrame(function () {
      frameQueued = false
      renderFrame()
      // Re-render rather than only reposition. A pin that scrolls out of its
      // container can no longer be placed, and the numbering counts only the pins
      // that are drawn — so the numbers have to be recomputed whenever placement
      // can change, not merely when the annotation list changes. Repositioning
      // alone left the labels stale: the reader scrolled, a pin vanished, and the
      // remaining ones still read 1 and 3.
      renderPins()
    })
  }

  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)

  // ------------------------------------------------- client-side navigation

  /**
   * Re-anchor after the address changed without a document load.
   *
   * Only `popstate` used to be handled, which covers the back button and
   * nothing else. The two ways an app actually navigates in place — calling
   * `history.pushState`/`replaceState`, and changing the hash — fire no event
   * this file ever listened for, so the marks stayed bound to the view the
   * reader had left: the pins went stale or disappeared, and the panel reported
   * entries it could no longer place.
   *
   * The history methods are wrapped rather than polled, because they fire no
   * event of their own and a timer sampling `location` would both miss the
   * moment and cost a wake-up on every page.
   *
   * Navigating does not touch the annotations. They belong to the session, not to
   * the view, so the only thing that changes here is which of them are on screen —
   * `renderPins` reads the route and draws the ones that belong to it. The list is
   * re-announced because the panel's address and its "N of M on this page" both
   * changed, not because anything was lost.
   */
  function onRouteChange() {
    // Deferred, because `pushState` returns before the app has rendered the new
    // view: anchoring synchronously here would resolve selectors against the
    // DOM that is still on screen and call every pin unplaceable.
    setTimeout(function () {
      var next = currentPath()
      var moved = next !== pagePath
      if (moved) {
        pagePath = next
        // Forced rather than compared: the new view must be re-announced even
        // when it cannot place exactly the same entries, otherwise the panel
        // keeps a warning about a page the reader has already left. `null`
        // matches no signature, so the next `renderPins` always speaks.
        lastUnplaced = null
        // A card left open is anchored to an element that is going away, so it
        // would offer to save against a detached node.
        if (card) closeCard()
      }
      // Anchors always belong to the DOM that is on screen now, whether or not
      // the route moved. The annotations themselves are untouched: they were
      // never filed by route, so there is nothing to reload and nothing is lost.
      live.clear()
      render()
      post('ready', { annotations: state.annotations, path: pagePath, url: location.href })
    }, 0)
  }

  // `popstate` covers back/forward; `hashchange` covers a hash edit that history
  // traversal did not cause. Both are idempotent against the same route: the
  // second pass sees no move and only re-anchors.
  window.addEventListener('popstate', onRouteChange)
  window.addEventListener('hashchange', onRouteChange)
  ;['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name]
    if (typeof original !== 'function') return
    history[name] = function () {
      var result = original.apply(this, arguments)
      onRouteChange()
      return result
    }
  })

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && state.mode === 'marking') {
      event.preventDefault()
      setMode('idle')
    }
  })

  // ------------------------------------------------------------------- boot

  // Fold in anything the per-route build left behind before reading the session
  // bucket, so an upgrade does not hide marks the reader already made.
  migrate()
  state.annotations = load()
  mount()
  post('ready', { annotations: state.annotations, path: pagePath, url: location.href })
})()
