/**
 * dsh-annotate — sidebar half.
 *
 * This is the panel that lives in the harness right sidebar. It has one job
 * that matters: turn a list of picked elements into text an agent can act on.
 *
 * The framing that shapes everything here is the difference between the two
 * kinds of entry, which is also what the payload header spells out:
 *
 *   #1 [标注] button.primary     — a location. Nothing was asked for.
 *   #2 [批注] div.pricing-card   — a location, plus what should change.
 *
 * Both are complete. An entry with no note is not an unfinished one, so the
 * list renders them as equals, numbered in reading order down the page, and
 * the payload keeps the distinction visible rather than flattening it.
 *
 * The panel is a React component registered into two sidebar slots, talking to
 * the framed preview over postMessage.
 */

window.__ModuleLoader__.load({
  id: 'dsh-annotate',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const KIND = 'dsh-annotate'
    const TAB_ID = 'dsh-annotate-tab'
    const OVERLAY_CHANNEL = 'dsh-annotate-overlay'
    const PANEL_CHANNEL = 'dsh-annotate-panel'
    const API = '/__dsh-annotate'

    // ------------------------------------------------------------------ i18n

    const CATALOG = {
      en: {
        'tab.title': 'Annotate',
        'tab.description': 'Pick elements in a running app and send what you found.',
        'panel.title': 'Annotate',
        'panel.mark': 'Mark',
        'panel.marking': 'Pick an element…',
        'panel.stop': 'Done',
        'panel.empty': 'Nothing annotated yet. Press “Mark”, then click an element in the preview.',
      'panel.emptyShort': 'Nothing annotated yet — press “Mark”, then click an element.',
      'panel.listTitle': 'Marked',
        'panel.kindMark': 'mark',
        'panel.kindNote': 'note',
        'panel.edit': 'Edit',
        'panel.remove': 'Remove',
        'panel.removeAll': 'Clear all',
        'panel.attach': 'Add to composer',
        'panel.send': 'Send annotations',
        'panel.sendHint': 'Send only these annotations, keeping your draft',
        'panel.open': 'Open a page',
        'panel.detecting': 'Looking for local servers…',
        'panel.noServers': 'No local server found. Start one, or open a page from the workspace.',
        'panel.pages': 'Workspace pages',
      'panel.discovered': 'Detected servers & pages',
        'panel.urlPlaceholder': 'http://localhost:5173 or a workspace .html file',
        'panel.go': 'Open',
        'panel.frameHint': 'If the page stays blank, the app may refuse to be framed.',
        'panel.reload': 'Reload',
        'panel.attached': 'Added to the composer.',
      'panel.askLine': 'What I want changed: ',
        'panel.sent': 'Annotations sent.',
        'panel.noComposer': 'Select a conversation with a composer first.',
        'panel.attachFailed': 'Could not add to the composer. The annotations are kept.',
        'panel.sendUnsupported': 'This build cannot send directly; use “Add to composer”.',
        'panel.notLocal': 'Only localhost targets are supported in this release.',
        'panel.ready': 'Ready',
        'panel.missing': 'That element is gone from the page.',
      },
      zh: {
        'tab.title': '标注',
        'tab.description': '在运行中的应用里点选元素，把发现的东西发出去。',
        'panel.title': '标注',
        'panel.mark': '标记',
        'panel.marking': '点选一个元素…',
        'panel.stop': '完成',
        'panel.empty': '还没有标注。点「标记」，然后在预览里点一个元素。',
      'panel.emptyShort': '还没有标注 —— 点「标记」，再点页面上一个元素。',
      'panel.listTitle': '已标注',
        'panel.kindMark': '标注',
        'panel.kindNote': '批注',
        'panel.edit': '编辑',
        'panel.remove': '删除',
        'panel.removeAll': '全部清除',
        'panel.attach': '加入输入框',
        'panel.send': '发送标注',
        'panel.sendHint': '只发送这些标注，保留你的草稿',
        'panel.open': '打开页面',
        'panel.detecting': '正在查找本地服务…',
        'panel.noServers': '没有找到本地服务。先启动一个，或从工作区打开页面。',
        'panel.pages': '工作区页面',
      'panel.discovered': '检测到的服务与页面',
        'panel.urlPlaceholder': 'http://localhost:5173 或工作区的 .html 文件',
        'panel.go': '打开',
        'panel.frameHint': '如果页面一直空白，可能是该应用拒绝被嵌入。',
        'panel.reload': '重新加载',
        'panel.attached': '已加入输入框。',
      'panel.askLine': '我想改的地方：（在这一行后面写你的要求）',
        'panel.sent': '标注已发送。',
        'panel.noComposer': '请先选择一个带输入框的会话。',
        'panel.attachFailed': '无法加入输入框，标注已保留。',
        'panel.sendUnsupported': '当前版本无法直接发送，请用「加入输入框」。',
        'panel.notLocal': '当前版本只支持 localhost 目标。',
        'panel.ready': '就绪',
        'panel.missing': '该元素已从页面上消失。',
      },
    }

    function detectLang() {
      try {
        const value = document.documentElement.lang || navigator.language || 'en'
        return String(value).toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch (error) {
        void error
        return 'en'
      }
    }

    let lang = detectLang()
    const t = (key, vars) => {
      const table = CATALOG[lang] || CATALOG.en
      let text = table[key] || CATALOG.en[key] || key
      if (vars) {
        for (const name of Object.keys(vars)) text = text.split(`{${name}}`).join(String(vars[name]))
      }
      return text
    }

    // ----------------------------------------------------------------- styles

    const CSS = `
/* Type scale and controls follow the harness shell: a system stack at 13px for
   body copy, 12px for controls, and one accent that matches the overlay marker
   so the panel and the page read as the same tool. */
.dsa-panel{display:flex;flex-direction:column;gap:10px;padding:10px;font:13px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:inherit;height:100%;box-sizing:border-box;overflow:hidden;min-height:0;-webkit-font-smoothing:antialiased}
.dsa-bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;flex:0 0 auto}
.dsa-btn{font:500 12px/1 inherit;padding:0 12px;height:28px;display:inline-flex;align-items:center;gap:5px;border-radius:7px;border:1px solid rgba(128,128,128,.32);background:transparent;color:inherit;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease;white-space:nowrap}
.dsa-btn:hover:not(:disabled){background:rgba(128,128,128,.14);border-color:rgba(128,128,128,.5)}
.dsa-btn:active:not(:disabled){transform:translateY(.5px)}
.dsa-btn:focus-visible{outline:2px solid #f0a05a;outline-offset:1px}
.dsa-btn[data-primary]{background:#f0a05a;border-color:#f0a05a;color:#fff;font-weight:600;box-shadow:0 1px 2px rgba(240,160,90,.35)}
.dsa-btn[data-primary]:hover:not(:disabled){background:#eda055;border-color:#eda055;filter:none}
.dsa-btn:disabled{opacity:.45;cursor:not-allowed}
.dsa-btn[data-on]{background:rgba(240,160,90,.18);border-color:#f0a05a;color:inherit}
.dsa-btn:disabled{opacity:.5;cursor:default}
.dsa-open{display:flex;gap:6px;flex:0 0 auto}
.dsa-open input{flex:1;min-width:0;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;height:28px;box-sizing:border-box;padding:0 9px;border-radius:7px;border:1px solid rgba(128,128,128,.32);background:transparent;color:inherit}
.dsa-open input:focus{outline:2px solid #f0a05a;outline-offset:-1px;border-color:transparent}
/* The preview is the point of this panel, so it takes the space. Everything
   else is capped: the sidebar is narrow, and a full-height stack of picker and
   list rows used to leave the page itself a few pixels tall. */
.dsa-frame{position:relative;flex:1 1 auto;min-height:180px;border-radius:8px;overflow:hidden;border:1px solid rgba(128,128,128,.3);background:#fff}
.dsa-frame iframe{width:100%;height:100%;border:0;display:block}
.dsa-hint{font-size:11px;opacity:.62;margin:0;flex:0 0 auto}
/* The picker and the list collapse instead of pushing the preview out of view. */
.dsa-collapse{flex:0 0 auto}
.dsa-collapse>summary{cursor:pointer;font-size:12px;opacity:.75;padding:2px 0;list-style:none;display:flex;align-items:center;gap:6px}
.dsa-collapse>summary::-webkit-details-marker{display:none}
.dsa-collapse>summary::before{content:'▸';font-size:10px;transition:transform .12s}
.dsa-collapse[open]>summary::before{transform:rotate(90deg)}
.dsa-collapse>summary:hover{opacity:1}
.dsa-collapse-body{padding-top:6px;max-height:40vh;overflow:auto}
/* Marked elements live behind a counter in the toolbar, not in a panel that
   steals the page's height. The expanded list overlays the preview, so opening
   it never resizes the frame. */
.dsa-count{position:relative;flex:0 0 auto}
.dsa-count>summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:6px;font:500 12px/1 inherit;height:28px;box-sizing:border-box;padding:0 10px;border-radius:7px;border:1px solid rgba(128,128,128,.32);transition:background .12s ease,border-color .12s ease}
.dsa-count>summary::-webkit-details-marker{display:none}
.dsa-count>summary:hover{background:rgba(128,128,128,.14)}
.dsa-count>summary:focus-visible{outline:2px solid #f0a05a;outline-offset:1px}
.dsa-count[open]>summary{background:rgba(240,160,90,.18);border-color:#f0a05a}
.dsa-count-badge{background:#f0a05a;color:#fff;font-weight:600;font-size:11px;border-radius:9px;min-width:18px;height:18px;display:flex;align-items:center;justify-content:center;padding:0 5px}
.dsa-count-body{position:absolute;right:0;top:calc(100% + 6px);z-index:20;width:min(340px,86vw);max-height:52vh;overflow:auto;background:#fff;border:1px solid rgba(128,128,128,.35);border-radius:8px;padding:8px;box-shadow:0 10px 30px rgba(0,0,0,.28)}
.dsa-layer[data-dark] .dsa-count-body{background:#1e1e1e}
.dsa-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.dsa-item{display:flex;gap:8px;padding:7px 8px;border-radius:7px;border:1px solid rgba(128,128,128,.28);align-items:flex-start;cursor:default}
.dsa-item:hover{border-color:#f0a05a}
.dsa-num{flex:0 0 20px;height:20px;border-radius:50% 50% 50% 2px;background:#f0a05a;color:#fff;font:600 11px/20px system-ui,sans-serif;text-align:center}
.dsa-num[data-kind="mark"]{background:#7f8c9b}
.dsa-body{flex:1;min-width:0}
.dsa-line{display:flex;gap:6px;align-items:baseline}
.dsa-kind{font-size:10px;font-weight:600;padding:1px 5px;border-radius:3px;background:#f0a05a;color:#fff;flex:0 0 auto}
.dsa-kind[data-kind="mark"]{background:#7f8c9b}
.dsa-sel{font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.72;word-break:break-all;margin:0}
.dsa-note{margin:3px 0 0;white-space:pre-wrap;word-break:break-word}
.dsa-note[data-empty]{opacity:.5;font-style:italic}
.dsa-item-actions{display:flex;flex-direction:column;gap:3px}
.dsa-mini{font:12px/1 inherit;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;border:1px solid transparent;background:transparent;color:inherit;cursor:pointer;opacity:.62;transition:background .12s ease,opacity .12s ease}
.dsa-mini:hover{background:rgba(128,128,128,.16);opacity:1}
.dsa-mini:focus-visible{outline:2px solid #f0a05a;outline-offset:1px;opacity:1}
.dsa-toast{font-size:12px;padding:7px 10px;border-radius:7px;background:rgba(128,128,128,.16);flex:0 0 auto}
.dsa-servers{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.dsa-server{display:flex;gap:6px;align-items:center;font-size:12px}
.dsa-server button{flex:1;min-width:0;text-align:left;font:12px/1.4 inherit;padding:5px 8px;border-radius:6px;border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit;cursor:pointer;display:flex;gap:6px;align-items:center}
.dsa-server button:hover{background:rgba(128,128,128,.12)}
.dsa-server-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-tag{flex:0 0 auto;font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(128,128,128,.16);opacity:.85}
.dsa-server button:hover{border-color:#f0a05a}
.dsa-server code{font:11px/1 ui-monospace,monospace;opacity:.6;flex:0 0 auto}
.dsa-empty{opacity:.6;padding:14px 4px;text-align:center;font-size:12px}
`

    let stylesInjected = false
    function injectStyles() {
      if (stylesInjected || typeof document === 'undefined') return
      stylesInjected = true
      const tag = document.createElement('style')
      tag.setAttribute('data-dsh-annotate', '')
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ------------------------------------------------------- composer bridge

    /**
     * The sidebar tab slot hands a component only session identity and
     * projection — no composer access. The draft lives behind the
     * `conversation.input.dock` slot, whose owner passes the input actions down.
     *
     * So a tiny invisible component rides in that dock and publishes what it
     * was given into this module-level box; the tab reads the box when the user
     * asks to send. Keyed by session id, because a dock is mounted per session
     * and the sidebar may be showing a different one.
     */
    const composerBridge = new Map()

    function ComposerBridge(props) {
      const sessionId = props.sessionId
      const draft = props.useInput ? props.useInput((state) => state.draft) : undefined
      const actions = props.inputActions
      React.useEffect(() => {
        if (!sessionId) return undefined
        composerBridge.set(sessionId, {
          getDraft: () => String(draft || ''),
          setDraft: actions && actions.setDraft ? (value) => actions.setDraft(value) : null,
        })
        return () => {
          composerBridge.delete(sessionId)
        }
      }, [sessionId, draft, actions])
      return null
    }

    // ------------------------------------------------------------ the payload

    /**
     * Reading order down the page, then insertion order as a tiebreaker.
     *
     * Document coordinates rather than viewport ones: the list must not reshuffle
     * just because the user scrolled the preview.
     */
    function inReadingOrder(list) {
      return list
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => {
          const ay = a.entry.doc ? a.entry.doc.y : 0
          const by = b.entry.doc ? b.entry.doc.y : 0
          if (ay !== by) return ay - by
          const ax = a.entry.doc ? a.entry.doc.x : 0
          const bx = b.entry.doc ? b.entry.doc.x : 0
          if (ax !== bx) return ax - bx
          return a.index - b.index
        })
        .map((one) => one.entry)
    }

    /**
     * Render the annotations as one block for the conversation.
     *
     * Deliberately terse. The selector is the part that matters — it identifies
     * the target — while geometry, tag, role and class lists add tokens without
     * telling the reader anything they cannot see from the selector and the
     * quoted text. `position` is kept because it disambiguates repeated markup,
     * and the note is kept because it carries the intent.
     */
    function renderPayload(annotations, meta) {
      const list = inReadingOrder(annotations)
      if (!list.length) return ''
      const head = `🎯 ${lang === 'zh' ? '界面标注' : 'UI annotations'} · ${meta.url || meta.page || ''} · ${meta.w}×${meta.h} (${list.length})`
      const blocks = list.map((entry, index) => {
        const note = String(entry.note || '').trim()
        const tag = `[${note ? t('panel.kindNote') : t('panel.kindMark')}]`
        const selector = entry.selector || entry.tag || ''
        // The selector appears once, on the header line. Repeating it under a
        // `selector:` label doubled the largest field in every block for no
        // extra information.
        const lines = [`#${index + 1} ${tag} ${selector}`]
        if (entry.text) lines.push(`   text: ${entry.text}`)
        if (entry.doc) lines.push(`   at: ${entry.doc.x},${entry.doc.y} ${entry.doc.w}×${entry.doc.h}`)
        // Collision count matters only when the selector is a positional chain,
        // which is exactly when it may be ambiguous.
        if (/nth-of-type/.test(selector) && typeof entry.selectorMatches === 'number') {
          lines.push(`   matches: ${entry.selectorMatches}`)
        }
        if (entry.testId) lines.push(`   testid: ${entry.testId}`)
        if (entry.ariaLabel) lines.push(`   aria-label: ${entry.ariaLabel}`)
        if (note) lines.push(`   note: ${note}`)
        return lines.join('\n')
      })
      return [head, '', blocks.join('\n\n')].join('\n')
    }

    // ------------------------------------------------------------------- views

    function NumberedList(props) {
      const { annotations, onEdit, onRemove, onRemoveAll, onAttach, onSend, canSend, busy } = props
      const ordered = inReadingOrder(annotations)
      if (!ordered.length) return h('p', { className: 'dsa-empty' }, t('panel.empty'))
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h(
          'ul',
          { className: 'dsa-list' },
          ordered.map((entry, index) =>
            h(
              'li',
              { key: entry.id, className: 'dsa-item', onMouseEnter: () => onEdit(entry.id, 'hover') },
              h('span', { className: 'dsa-num', 'data-kind': entry.note ? 'note' : 'mark' }, String(index + 1)),
              h(
                'div',
                { className: 'dsa-body' },
                h(
                  'div',
                  { className: 'dsa-line' },
                  h('span', { className: 'dsa-kind', 'data-kind': entry.note ? 'note' : 'mark' }, entry.note ? t('panel.kindNote') : t('panel.kindMark')),
                  h('span', { className: 'dsa-sel' }, entry.selector || entry.tag || ''),
                ),
                h(
                  'p',
                  { className: 'dsa-note', 'data-empty': entry.note ? undefined : 'true' },
                  entry.note ? entry.note : '—',
                ),
              ),
              h(
                'div',
                { className: 'dsa-item-actions' },
                h('button', { type: 'button', className: 'dsa-mini', onClick: () => onEdit(entry.id, 'edit'), title: t('panel.edit') }, '✎'),
                h('button', { type: 'button', className: 'dsa-mini', onClick: () => onRemove(entry.id), title: t('panel.remove') }, '✕'),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dsa-bar' },
          // Adding to the composer is the primary path. Sending straight away
          // closes the conversation before the user has said what they want
          // changed, which leaves a pile of DOM structure and no request.
          h('button', { type: 'button', className: 'dsa-btn', 'data-primary': true, onClick: onAttach, disabled: busy }, t('panel.attach')),
          h('button', { type: 'button', className: 'dsa-btn', onClick: onSend, disabled: busy || !canSend, title: t('panel.sendHint') }, t('panel.send')),
          h('button', { type: 'button', className: 'dsa-btn', onClick: onRemoveAll, disabled: busy }, t('panel.removeAll')),
        ),
      )
    }

    /**
     * Marks for the stacks the probe recognises.
     *
     * Inline SVG rather than image files: the bundle stays self-contained, and
     * each mark is a simple glyph in the stack's own colour, which reads at the
     * 14px this list uses far better than a detailed logo would.
     */
    const STACK_MARKS = {
      react: { color: '#61dafb', path: 'M12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm0-6c5 0 9 3.4 9 7.5s-4 7.5-9 7.5-9-3.4-9-7.5S7 4.5 12 4.5Z' },
      vue: { color: '#42b883', path: 'M2 4h4l6 10 6-10h4l-10 17L2 4Z' },
      svelte: { color: '#ff3e00', path: 'M14 3 6 7v5l8 4 4-2V9l-8-4 4-2Z' },
      angular: { color: '#dd0031', path: 'M12 2 2 6l2 12 8 4 8-4 2-12-10-4Zm0 4 5 11h-2l-1-3h-4l-1 3H9l5-11Z' },
      next: { color: '#111', path: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-3 6h2l6 8V8h2v9h-2l-6-8v8H9V8Z' },
      nuxt: { color: '#00dc82', path: 'M12 5l7 12H5l7-12Z' },
      node: { color: '#539e43', path: 'M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 4 5 3v6l-5 3-5-3V9l5-3Z' },
      python: { color: '#3776ab', path: 'M12 2c4 0 4 2 4 2v3h-4v1h6s3 0 3 4-3 4-3 4h-2v-3s0-3-3-3H8s-3 0-3-3 3-5 7-5Zm-1 2v2h2V4h-2Z' },
      java: { color: '#e76f00', path: 'M9 3c2 3-4 4-4 8s3 6 3 6-5-1-5-5 4-6 4-9h2Zm2 5c2 2-3 3-3 6s3 5 3 5-4-1-4-4 3-4 3-7h1Zm1 10c4 0 6 1 6 1s-2 2-6 2-6-2-6-2 2-1 6-1Z' },
      nginx: { color: '#009639', path: 'M12 2 3 7v10l9 5 9-5V7l-9-5Zm-3 5h2l4 6V7h2v10h-2l-4-6v6H9V7Z' },
      static: { color: '#8b8b8b', path: 'M4 4h16v16H4V4Zm2 2v12h12V6H6Z' },
    }

    function StackMark(props) {
      const mark = STACK_MARKS[props.id]
      if (!mark) return null
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          'aria-hidden': 'true',
          style: { flex: '0 0 auto', fill: mark.color },
        },
        h('path', { d: mark.path }),
      )
    }

    /**
     * The marked-element counter.
     *
     * A count in the toolbar, expanding to the full list on demand, keeps the
     * preview at a usable height: the list overlays the frame instead of
     * occupying a permanent block beneath it.
     */
    function CountButton(props) {
      const { annotations, onEdit, onRemove, onRemoveAll, onAttach, onSend, canSend, busy } = props
      return h(
        'details',
        { className: 'dsa-count' },
        h(
          'summary',
          { title: t('panel.listTitle') },
          h('span', { className: 'dsa-count-badge' }, String(annotations.length)),
          h('span', null, t('panel.listTitle')),
        ),
        h('div', { className: 'dsa-count-body' }, h(NumberedList, { annotations, onEdit, onRemove, onRemoveAll, onAttach, onSend, canSend, busy })),
      )
    }

    function OpenBar(props) {
      const { servers, pages, onOpen, onDetect, detecting, url, setUrl, collapsed } = props
      const discovered = (servers && servers.length) || (pages && pages.length)
      const lists = h(
        'div',
        { className: collapsed ? 'dsa-collapse-body' : undefined },
        detecting ? h('p', { className: 'dsa-hint' }, t('panel.detecting')) : null,
        servers && servers.length
          ? h(
              'ul',
              { className: 'dsa-servers' },
              servers.slice(0, 12).map((server) =>
                h(
                  'li',
                  { key: server.origin, className: 'dsa-server' },
                  server.stack ? h(StackMark, { id: server.stack.id }) : null,
                  h(
                    'button',
                    { type: 'button', onClick: () => onOpen(server.origin), title: server.title || server.origin },
                    h('span', { className: 'dsa-server-name' }, server.title || server.stack?.label || 'localhost'),
                    server.stack ? h('span', { className: 'dsa-tag' }, server.stack.label) : null,
                  ),
                  h('code', null, `:${server.port}`),
                ),
              ),
            )
          : null,
        pages && pages.length
          ? h(
              'div',
              null,
              h('p', { className: 'dsa-hint' }, t('panel.pages')),
              h(
                'ul',
                { className: 'dsa-servers' },
                pages.slice(0, 6).map((page) =>
                  h('li', { key: page.path, className: 'dsa-server' }, h('button', { type: 'button', onClick: () => onOpen(page.path) }, page.label)),
                ),
              ),
            )
          : null,
      )

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px', flex: '0 0 auto' } },
        h(
          'div',
          { className: 'dsa-open' },
          h('input', {
            value: url,
            placeholder: t('panel.urlPlaceholder'),
            onChange: (event) => setUrl(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') onOpen(url)
            },
          }),
          h('button', { type: 'button', className: 'dsa-btn', onClick: () => onOpen(url) }, t('panel.go')),
          h('button', { type: 'button', className: 'dsa-btn', onClick: onDetect, disabled: detecting }, detecting ? '…' : '↻'),
        ),
        // Once a page is open the discovery lists stop being the main event, so
        // they fold away. Opening one keeps the preview from being pushed down
        // to a sliver in a narrow sidebar, and the lists come back on a click.
        collapsed && discovered
          ? h('details', { className: 'dsa-collapse' }, h('summary', null, t('panel.discovered')), lists)
          : lists,
      )
    }

    // ------------------------------------------------------------------ apply

    function apply(ctx) {
      // Report what the context actually offers. A missing service used to be a
      // silent `return`, which made a mis-declared `inject` look like a plugin
      // that simply did nothing — the hardest kind of failure to diagnose from
      // the outside.
      const slots = ctx.get('slots')
      const sidebarRightTabs = ctx.get('sidebarRightTabs')
      const sidebarRight = ctx.get('sidebarRight')
      const sessions = ctx.get('sessions')

      console.info(
        '[dsh-annotate] activating; services:',
        JSON.stringify({
          slots: slots !== undefined,
          sidebarRightTabs: sidebarRightTabs !== undefined,
          sidebarRight: sidebarRight !== undefined,
          sessions: sessions !== undefined,
        }),
      )

      if (slots === undefined) {
        console.error(
          '[dsh-annotate] the slot service is missing, so no UI can be contributed. ' +
            'Check that package.json declares dsh.client.inject with @deepseek-ai/dsh-client-ui-slots.',
        )
        return
      }
      ctx.effect(() => injectStyles())

      /** state/model helpers shared with the host module lives per tab instance */

      const AnnotateTab = (props) => {
        const [annotations, setAnnotations] = React.useState([])
        const [mode, setMode] = React.useState('idle')
        const [servers, setServers] = React.useState([])
        const [pages, setPages] = React.useState([])
        const [detecting, setDetecting] = React.useState(false)
        const [url, setUrl] = React.useState('')
        const [preview, setPreview] = React.useState(null)
        const [toast, setToast] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const frameRef = React.useRef(null)
        const nonce = React.useRef(0)

        /**
         * The workspace root comes from the shell's workspace snapshot, matched
         * to this tab by session. `useWorkspaces` is not part of the sidebar
         * tab slot's kit, so read it off the global seat when the shell
         * provides one and fall back to detection without a root.
         */
        const useWorkspaces = props.useWorkspaces || (typeof window !== 'undefined' && window.__DSH_USE_WORKSPACES__)
        const workspaceItems = useWorkspaces ? useWorkspaces((snapshot) => snapshot.items) : undefined
        const root = React.useMemo(() => {
          const list = Array.isArray(workspaceItems) ? workspaceItems : []
          if (!list.length) return ''
          const mine = list.find((item) => item && Array.isArray(item.sessionIds) && item.sessionIds.indexOf(props.sessionId) !== -1)
          return (mine && mine.path) || (list[0] && list[0].path) || ''
        }, [workspaceItems, props.sessionId])

        const flash = (message) => {
          setToast(message)
          window.setTimeout(() => setToast(''), 2600)
        }

        const postToPage = (payload) => {
          const win = frameRef.current && frameRef.current.contentWindow
          if (!win) return
          win.postMessage(Object.assign({ source: PANEL_CHANNEL }, payload), preview ? preview.origin : '*')
        }

        const onDetect = React.useCallback(async () => {
          if (!root) return
          setDetecting(true)
          try {
            const res = await fetch(`${API}/detect`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ root }),
            })
            const data = await res.json()
            setServers(data.servers || [])
            setPages(data.pages || [])
          } catch (error) {
            void error
          } finally {
            setDetecting(false)
          }
        }, [root])

        React.useEffect(() => {
          void onDetect()
        }, [onDetect])

        // The framed page reports what it has; the panel never reaches into it.
        React.useEffect(() => {
          const onMessage = (event) => {
            const data = event.data
            if (!data || data.source !== OVERLAY_CHANNEL) return
            if (!preview || event.origin !== preview.origin) return
            if (data.type === 'ready' || data.type === 'changed') {
              setAnnotations(data.annotations || [])
            } else if (data.type === 'mode') {
              setMode(data.mode || 'idle')
            } else if (data.type === 'send') {
              void ship(data.annotations || [], false)
            } else if (data.type === 'missing') {
              flash(t('panel.missing'))
            }
          }
          window.addEventListener('message', onMessage)
          return () => window.removeEventListener('message', onMessage)
        })

        const openTarget = async (target) => {
          if (!target) return
          setBusy(true)
          try {
            const res = await fetch(`${API}/open`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ url: target, root }),
            })
            const data = await res.json()
            if (!data.ok) {
              flash(data.code === 'notLocal' ? t('panel.notLocal') : data.error || 'failed')
              return
            }
            nonce.current += 1
            setAnnotations([])
            setPreview({ origin: data.origin, url: data.url, sid: data.sid, nonce: nonce.current })
            setMode('idle')
          } catch (error) {
            flash(String((error && error.message) || error))
          } finally {
            setBusy(false)
          }
        }

        const setPageMode = (next) => {
          setMode(next)
          postToPage({ type: 'mode', mode: next })
        }

        const onEdit = (id, how) => {
          if (how === 'hover') postToPage({ type: 'focus', id })
          else postToPage({ type: 'edit', id })
        }

        const onRemove = (id) => {
          setAnnotations((list) => {
            const next = list.filter((entry) => entry.id !== id)
            syncPage(next)
            return next
          })
        }

        const onRemoveAll = () => {
          setAnnotations([])
          postToPage({ type: 'key', clear: true })
        }

        /** The page is the source of truth for its own store; mirror bulk edits. */
        const syncPage = (next) => {
          void next
        }

        const payloadFor = (list) => {
          const first = list[0] || {}
          return renderPayload(list, {
            url: preview ? preview.url : '',
            page: first.page || '',
            w: first.viewport ? first.viewport.w : window.innerWidth,
            h: first.viewport ? first.viewport.h : window.innerHeight,
          })
        }

        /**
         * Hand the block over.
         *
         * "Add to composer" writes into the draft the shell gave this slot, so
         * whatever the user already typed is preserved and the block is
         * appended below it. "Send" goes through the session's public prompt
         * path instead, which leaves the draft alone.
         */
        const ship = async (list, onlySend) => {
          const source = list && list.length ? list : annotations
          if (!source.length) return
          const block = payloadFor(source)
          setBusy(true)
          try {
            if (!onlySend) {
              const bridge = composerBridge.get(props.sessionId)
              const writer = bridge && bridge.setDraft
              if (!writer) {
                flash(t('panel.noComposer'))
                return
              }
              const current = bridge.getDraft()
              // A trailing prompt line is left under the block: the annotations
              // say *what* was picked, and the user still has to say what should
              // change. Without it the message reads as a finished request.
              const ask = t('panel.askLine')
              const body = block + '\n\n' + ask
              const next = current.includes(block) ? current : (current ? current.trimEnd() + '\n\n' : '') + body
              writer(next)
              flash(t('panel.attached'))
              setAnnotations([])
              postToPage({ type: 'key', clear: true })
              return
            }

            const scope = sessions && typeof sessions.scope === 'function' ? sessions.scope(props.sessionId) : null
            const session = scope && sessions.sessionOf ? sessions.sessionOf(scope) : null
            if (!session || !session.prompt) {
              flash(t('panel.sendUnsupported'))
              return
            }
            const submission = session.beginSubmission ? session.beginSubmission({ mode: 'queue', text: block, attachments: [] }) : null
            let result
            try {
              result = await session.prompt([{ type: 'text', text: block }], 'queue', undefined, submission && submission.requestId)
            } catch (error) {
              if (submission && submission.abandon) submission.abandon()
              throw error
            }
            if (!result || !result.ok || !result.value || !result.value.accepted) {
              if (submission && submission.abandon) submission.abandon()
              throw new Error((result && result.error && result.error.message) || 'not accepted')
            }
            flash(t('panel.sent'))
            setAnnotations([])
            postToPage({ type: 'key', clear: true })
          } catch (error) {
            // The annotations stay put on failure, so nothing is lost.
            flash(onlySend ? String((error && error.message) || error) : t('panel.attachFailed'))
          } finally {
            setBusy(false)
          }
        }

        const canSend = Boolean(sessions && typeof sessions.scope === 'function')

        return h(
          'div',
          { className: 'dsa-panel' },
          h(
            'div',
            { className: 'dsa-bar' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsa-btn',
                'data-on': mode === 'marking' ? 'true' : undefined,
                onClick: () => setPageMode(mode === 'marking' ? 'idle' : 'marking'),
                disabled: !preview,
              },
              mode === 'marking' ? t('panel.stop') : t('panel.mark'),
            ),
            preview ? h('button', { type: 'button', className: 'dsa-btn', onClick: () => setPreview({ ...preview, nonce: ++nonce.current }) }, t('panel.reload')) : null,
            h('span', { style: { flex: 1 } }),
            // The count rides the toolbar and expands over the preview, so the
            // frame keeps its height whether the list is open or closed. With
            // nothing marked yet the slot carries the first-run guidance
            // instead, so a new user is not left staring at an empty panel.
            annotations.length
              ? h(CountButton, {
                  annotations,
                  onEdit,
                  onRemove,
                  onRemoveAll,
                  onAttach: () => void ship(annotations, false),
                  onSend: () => void ship(annotations, true),
                  canSend,
                  busy,
                })
              : h('span', { className: 'dsa-hint' }, t('panel.emptyShort')),
            preview ? h('code', { className: 'dsa-hint' }, new URL(preview.url).host) : null,
          ),

          h(OpenBar, { servers, pages, onOpen: openTarget, onDetect, detecting, url, setUrl, collapsed: Boolean(preview) }),

          preview
            ? h(
                'div',
                { className: 'dsa-frame' },
                h('iframe', {
                  key: preview.nonce,
                  ref: frameRef,
                  src: preview.url,
                  title: 'preview',
                  sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals',
                }),
              )
            : null,
          // The framing caveat is only worth saying before a page is open.
          preview ? null : h('p', { className: 'dsa-hint' }, t('panel.frameHint')),

          toast ? h('div', { className: 'dsa-toast' }, toast) : null,
        )
      }

      const openAnnotate = () => {
        try {
          if (sidebarRight && typeof sidebarRight.openTab === 'function') sidebarRight.openTab(KIND)
        } catch (error) {
          console.warn('dsh-annotate: could not open the sidebar tab', error)
        }
      }

      if (sidebarRightTabs && typeof sidebarRightTabs.register === 'function') {
        ctx.effect(() =>
          sidebarRightTabs.register({
            id: TAB_ID,
            kind: KIND,
            // This is a page type opened by kind, so it recognises no address
            // globs; `patterns` is deliberately absent.
            priority: 'extension',
            title: () => t('tab.title'),
            guide: [
              {
                order: 40,
                title: () => t('tab.title'),
                description: () => t('tab.description'),
              },
            ],
          }),
        )
      } else {
        console.warn('dsh-annotate: sidebarRightTabs is unavailable; the tab cannot register')
      }

      const contribute = (key, id, component, label, extra) => {
        try {
          slots.inject(key, () => slots.register(Object.assign({ name: key, id, label, order: 12 }, extra), component))
        } catch (error) {
          console.warn(`dsh-annotate: slot ${key} unavailable`, error)
        }
      }
      contribute('sidebar.right.pane.tab', TAB_ID, AnnotateTab, undefined, { key: TAB_ID })
      // Rides in the composer dock purely to learn where the draft is.
      contribute('conversation.input.dock', 'annotate-bridge', ComposerBridge)

      const onKeyDown = (event) => {
        if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return
        if (String(event.key).toLowerCase() !== 'b') return
        event.preventDefault()
        openAnnotate()
      }
      window.addEventListener('keydown', onKeyDown)
      ctx.effect(() => () => window.removeEventListener('keydown', onKeyDown))
    }

    exports.apply = apply
    return module.exports
  },
})
