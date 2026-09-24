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
  var pagePath = location.pathname + location.search
  var MARKER = '#f0a05a'

  var strings = {
    mark: '标注',
    note: '批注',
    placeholder: '说明要改什么（可留空，留空即标注）',
    save: '保存',
    cancel: '取消',
    remove: '删除',
    title: '标注此元素',
    editTitle: '编辑标注',
    hintEmpty: '留空即「标注」，只标记位置',
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

  // ------------------------------------------------------------------ styles

  function css() {
    return [
      '.dsa-layer{position:fixed;inset:0;z-index:2147483000;pointer-events:none;font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111}',
      '.dsa-layer[data-dark="1"]{color:#eee}',
      // While marking, the surface swallows every pointer event so a click picks
      // an element instead of pressing whatever control is underneath. It also
      // carries a faint tint, which is the signal that the page is in pick mode.
      '.dsa-capture{position:absolute;inset:0;pointer-events:auto;cursor:crosshair;background:rgba(240,160,90,.04)}',
      // The hover highlight has to be obvious on any page, light or dark, busy or
  // plain. A translucent fill alone reads as a vague overlay, so the box is
  // marked three ways at once: a solid ring, an inset glow, and corner handles.
  // `mix-blend-mode: difference` keeps the outline visible over both a white
  // page and a black one without knowing which is underneath.
  '.dsa-frame{position:absolute;border:2px solid ' + MARKER + ';background:rgba(240,160,90,.22);border-radius:2px;pointer-events:none;display:none;box-shadow:0 0 0 1px rgba(255,255,255,.55) inset,0 0 0 1px rgba(0,0,0,.25),0 0 12px rgba(240,160,90,.45);transition:none}',
  '.dsa-frame[data-locked="1"]{border-style:solid;background:rgba(240,160,90,.3)}',
      '.dsa-frame i{position:absolute;width:6px;height:6px;background:' + MARKER + ';border:1px solid #fff;border-radius:1px}',
      '.dsa-frame i:nth-child(1){left:-4px;top:-4px}.dsa-frame i:nth-child(2){right:-4px;top:-4px}',
      '.dsa-frame i:nth-child(3){left:-4px;bottom:-4px}.dsa-frame i:nth-child(4){right:-4px;bottom:-4px}',
      '.dsa-readout{position:absolute;pointer-events:none;background:rgba(17,17,17,.92);color:#f5f5f5;padding:3px 6px;border-radius:4px;font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:none}',
      '.dsa-pin{position:absolute;pointer-events:auto;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50% 50% 50% 2px;border:none;background:' + MARKER + ';color:#fff;font:600 11px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;padding:0}',
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
    if (testId) return '[data-testid="' + testId + '"]'
    // A class that resolves to exactly one element is far more readable than a
    // positional chain, and survives unrelated markup changes. Try the element's
    // own classes, then its nearest ancestors, before falling back.
    var byClass = uniqueClassSelector(el, 0)
    if (byClass) return byClass
    // Prefer a short positional path anchored at the nearest ancestor that can
    // be named on its own, so the chain stays meaningful instead of growing to
    // the document root.
    var parts = []
    var node = el
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var tag = node.tagName.toLowerCase()
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift('#' + node.id)
        break
      }
      var anchor = uniqueClassSelector(node, 1)
      if (anchor) {
        parts.unshift(anchor)
        break
      }
      var parent = node.parentElement
      if (!parent) {
        parts.unshift(tag)
        break
      }
      var sameTag = Array.prototype.filter.call(parent.children, function (child) {
        return child.tagName === node.tagName
      })
      var index = sameTag.indexOf(node) + 1
      parts.unshift(sameTag.length > 1 ? tag + ':nth-of-type(' + index + ')' : tag)
      node = parent
      if (parts.length > 6) break
    }
    return parts.join(' > ')
  }

  /**
   * A `.class` selector for the element or one of its ancestors, when it matches
   * exactly one element.
   *
   * `skip` walks that many ancestors up first, which lets the chain builder try
   * to anchor on a parent while the element itself is tried first.
   */
  function uniqueClassSelector(el, skip) {
    var node = el
    for (var up = 0; up < skip && node; up += 1) node = node.parentElement
    for (var depth = 0; depth < 3 && node && node.nodeType === 1; depth += 1) {
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
      node = node.parentElement
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

  function storeKey() {
    return STORE_PREFIX + session + ':' + pagePath
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
  var card = null

  function mount() {
    styleEl.textContent = css()
    root.appendChild(styleEl)
    root.appendChild(pinLayer)
    root.appendChild(frame)
    root.appendChild(readout)
    // Mount on <body>, and wait for it when this script runs from <head>.
    //
    // The overlay is injected into <head>, so at parse time <body> does not
    // exist yet. Attaching to <html> instead put the layer in a containing
    // block the page can transform, which made the highlight drift and resize
    // as the page scrolled.
    attach()
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
    return el
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
    live.set(annotation.id, found)
    return found
  }

  /** Where a pin belongs right now, in viewport coordinates. */
  function pinAnchor(annotation) {
    var el = elementFor(annotation)
    if (!el || !el.isConnected || !el.getClientRects().length) return null
    var rect = el.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) return null
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
      return null
    }
    return {
      x: Math.max(bounds.left + 12, Math.min(bounds.right - 12, rect.left + rect.width / 2)),
      y: Math.max(12, Math.min(bounds.bottom - 12, rect.top)),
    }
  }

  function positionPins() {
    state.annotations.forEach(function (annotation, index) {
      var pin = pinLayer.children[index]
      if (!pin) return
      var anchor = pinAnchor(annotation)
      pin.hidden = !anchor
      if (anchor) {
        pin.style.left = anchor.x + 'px'
        pin.style.top = anchor.y + 'px'
      }
    })
    anchorCard()
  }

  function renderPins() {
    pinLayer.innerHTML = ''
    state.annotations.forEach(function (annotation, index) {
      var pin = document.createElement('button')
      pin.type = 'button'
      pin.className = 'dsa-pin'
      pin.textContent = String(index + 1)
      pin.title = annotation.note ? annotation.note : strings.mark
      pin.setAttribute('data-kind', annotation.note ? 'note' : 'mark')
      pin.setAttribute('data-open', state.drafting && state.drafting.id === annotation.id ? 'true' : 'false')
      var anchor = pinAnchor(annotation)
      pin.hidden = !anchor
      if (anchor) {
        pin.style.left = anchor.x + 'px'
        pin.style.top = anchor.y + 'px'
      }
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
        Object.assign({ id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), note: note, createdAt: Date.now() }, detail),
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
        // "Add to the composer" and "send" both mean the panel has taken the
        // payload, so the page-side list is cleared to match.
        if (data.clear) {
          state.annotations = []
          live.clear()
          save()
          setMode('idle')
          post('changed', { annotations: [] })
        }
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
      positionPins()
    })
  }

  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('popstate', function () {
    // A client-side route change leaves the document alive; re-resolve anchors
    // against the new DOM instead of trusting the old nodes.
    live.clear()
    setTimeout(function () {
      pagePath = location.pathname + location.search
      state.annotations = load()
      render()
      post('ready', { annotations: state.annotations, path: pagePath })
    }, 0)
  })
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && state.mode === 'marking') {
      event.preventDefault()
      setMode('idle')
    }
  })

  // ------------------------------------------------------------------- boot

  state.annotations = load()
  mount()
  post('ready', { annotations: state.annotations, path: pagePath, url: location.href })
})()
