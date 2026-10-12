/**
 * Apply one mutation to a copied tree, for the mutation check.
 *
 * A file rather than an inline `node -e`: PowerShell mangles the quotes in an
 * inline script badly enough that a mutation can silently fail to apply, and a
 * mutation that never happened looks exactly like a test that cannot catch it.
 *
 * Usage: node scripts/mutate.mjs <dir> <mutation-name>
 *        node scripts/mutate.mjs <dir> restore      (undo a hand-applied mutation)
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, name] = process.argv.slice(2)

/** Each mutation is a literal replacement plus the file it belongs to. */
const MUTATIONS = {
  'turn-start-clear': {
    // Clearing on turn/start, which fires BEFORE the step loop reads anything. The
    // release is no longer routed through the event handler, so the mutation has to
    // target the boundary branch directly: wiring that branch to `turn/start` means a
    // batch still held when the turn opens is dropped before anything reads it.
    file: 'lib/index.js',
    from: "      if (type !== 'turn/end') return\n",
    to: "      if (type !== 'turn/start') return\n",
  },
  'stale-report-accepted': {
    // Accepting the sidebar's re-upload of a batch the host just delivered. The
    // window is one poll interval, and letting it through is what made the capsule
    // reappear after a send.
    file: 'lib/index.js',
    from: '      if (list.length && stale && cleared.signature === signature) {\n',
    to: '      if (false) {\n',
  },
  'report-poisons-itself': {
    // Recording every ordinary report as if it had been cleared. This is the bug
    // that made a panel re-asserting an identical list destroy its own batch: the
    // first report armed the guard with its own signature, so the second — an
    // identical re-report of something the host was still HOLDING — was read as a
    // stale repeat of it and deleted with `ignored: 'already delivered'`, although
    // nothing had been delivered and the reader still had the marks on screen.
    //
    // Both halves are needed to express it: the write on the ordinary path AND a
    // stale check that does not ask whether anything was actually let go. Dropping
    // only the `!wasHolding` guard was not a fault at all — with nothing writing the
    // marker, the guard never fires on a held batch — which is why this ADDS the
    // write back rather than weakening the condition. The extra condition is
    // provably redundant the other way round (nothing but a real clear can precede
    // an identical held batch), so the shipped code does not carry it.
    file: 'lib/index.js',
    from: '      delivered.delete(session)\n      sendJson(res, 200, { ok: true, count: list.length })\n',
    to: '      delivered.delete(session)\n      if (list.length) clearedBatches.set(session, { signature, at: Date.now() })\n      sendJson(res, 200, { ok: true, count: list.length })\n',
  },
  'pending-hides-held-list': {
    // Reporting only a count and never the entries. A remounted sidebar then has
    // nothing to adopt, so it renders empty while the capsule goes on counting —
    // the inconsistency the reader reported after switching tabs.
    file: 'lib/index.js',
    from: '        annotations: Array.isArray(held) ? held : [],\n',
    to: '',
  },
  'duplicate-append': {
    // Removing the once-per-turn guard. The batch is released after the block goes
    // out, so a later step of the same turn finds nothing to append UNLESS a new mark
    // arrived in between — then it appends again, and one act of attaching writes a
    // second transcript row. This is the shape the guard still has to prevent.
    file: 'lib/index.js',
    from: '      if (attachedInTurn.get(session) === turn) return decision\n',
    to: '',
  },
  'release-keeps-no-turn-guard': {
    // Clearing the turn guard as part of the release. The release runs immediately
    // after the guard is set, so wiping it there re-opens the door to a second copy
    // within the same turn — the fault the guard exists to close.
    file: 'lib/index.js',
    from: "      if (!keepTurn) attachedInTurn.delete(id)\n",
    to: '      attachedInTurn.delete(id)\n',
  },
  'list-404-ports': {
    // Offering every port that answers, including one that 404s at every path. The
    // reader then clicks straight into a "not found" page.
    file: 'lib/index.js',
    from: '        if (!servable(result.status)) {\n          tryNext()\n          return\n        }\n',
    to: '',
  },
  'attach-once-ever': {
    // The mirror-image mistake: latching on presence rather than on the turn, so
    // only the first turn ever carries the annotations and every later one is
    // silently starved.
    file: 'lib/index.js',
    from: '      if (attachedInTurn.get(session) === turn) return decision\n',
    to: '      if (attachedInTurn.has(session)) return decision\n',
  },
  'session-listener-not-global': {
    // Dropping `{ global: true }` from the session subscription. The session emits
    // through its own scope, so the listener is never consulted and the annotations
    // are handed out forever — the capsule that never goes away.
    file: 'lib/index.js',
    from: "ctx.on('session/event', onEvent, { global: true })",
    to: "ctx.on('session/event', onEvent)",
  },
  'no-clear-signal': {
    // Not advancing the counter the sidebar watches. The host still clears its own
    // side, so the bug is invisible from the host: only the panel is left holding a
    // list that no longer exists, which is exactly the reported symptom.
    file: 'lib/index.js',
    from: '      clearEpoch.set(id, (clearEpoch.get(id) || 0) + 1)\n',
    to: '',
  },
  'accent-not-persisted': {
    // Writing the choice nowhere. The picker still works for the current page, so
    // the bug only shows on the next load — the setting silently reverts.
    file: 'client.js',
    from: "        localStorage.setItem(ACCENT_KEY, value)\n",
    to: '',
  },
  'accent-not-sent-to-page': {
    // Opening a page without telling it the colour. The shell's own UI follows the
    // variable, so the panel looks right while every mark in the page stays the
    // default — the half-configured state the reader would report as "no effect".
    file: 'client.js',
    from: '              body: JSON.stringify({ url: target, root, accent }),\n',
    to: '              body: JSON.stringify({ url: target, root }),\n',
  },
  'accent-unvalidated': {
    // Trusting the client's string. The value is interpolated into a stylesheet
    // inside the previewed page, so an unvalidated one is a style-injection
    // primitive rather than merely a wrong colour.
    file: 'lib/index.js',
    from: '            accent: normaliseAccent(body && body.accent),\n',
    to: '            accent: body && body.accent,\n',
  },
  'capsule-transparent-again': {
    // Back to a translucent surface. The transcript shows through the pill, which
    // is the fault the reader reported first.
    file: 'client.js',
    from: 'background-image:linear-gradient(var(--dsa-accent-soft),var(--dsa-accent-soft));background-color:var(--dsw-specific-menu,#fff);',
    to: 'background:var(--dsa-accent-soft);',
  },
  'capsule-colourless-again': {
    // The over-correction: opaque, but with the accent tint dropped, leaving a
    // plain white pill that blends into the transcript.
    file: 'client.js',
    from: 'background-image:linear-gradient(var(--dsa-accent-soft),var(--dsa-accent-soft));background-color:var(--dsw-specific-menu,#fff);',
    to: 'background-color:var(--dsw-specific-menu,#fff);',
  },
  'ink-lightness-derived-from-preset': {
    // Deriving the ink's lightness from the preset. Contrast then depends on which
    // preset was chosen, and 青竹 falls to 4.23:1 — under the AA floor.
    file: 'client.js',
    from: '--dsa-accent-ink:hsl(var(--dsa-h) calc(var(--dsa-s) * .9) 26%)',
    to: '--dsa-accent-ink:hsl(var(--dsa-h) calc(var(--dsa-s) * .9) var(--dsa-l))',
  },
  'accent-vars-out-of-scope': {
    // The bug that actually shipped: the variables defined on a class nothing
    // applies, so every var() the capsule reads resolves to nothing and the whole
    // declaration is dropped. The page shows a plain white pill and nothing errors.
    file: 'client.js',
    from: ':root{--dsa-h:32',
    to: '.dsa-root{--dsa-h:32',
  },
  'backtick-in-stylesheet': {
    // A backtick inside the stylesheet template literal terminates it early and
    // turns the remaining CSS into JavaScript. Written by accident three times.
    file: 'client.js',
    from: ' * Only the channels are written by JS;',
    to: ' * Only the channels are written by JS, see `--dsa-h`;',
  },
  'pins-numbered-across-pages': {
    // THE REPORTED FAULT, reduced to its single cause: the pin number is taken
    // from the whole session list instead of from the page it is drawn on.
    //
    // This was the shipped code, and it cannot be made to work: each tab is its
    // own origin and therefore its own storage, so a page loads only its own
    // marks and the session-wide number it computes is really a count of its own
    // list. Mark one element on page A and one on page B and the reader gets a
    // panel that says A:1, B:1 while this pin claims B:2 — the two surfaces
    // disagreeing about the same mark.
    //
    // Session-wide numbering also has no way to be right on the page: the number
    // would have to be pushed in from the panel before it could be drawn, and
    // until that message arrived the page's own count would contradict it.
    file: 'lib/overlay.js',
    from: '    var numbered = readingOrder(here.filter(function (one) {\n',
    to: '    var numbered = readingOrder(state.annotations.filter(function (one) {\n',
  },
  'pins-not-renumbered-on-scroll': {
    // Numbering recomputed only when the list changes. A mark that can no longer
    // be drawn keeps its number — that is deliberate — but a pin must still be
    // dropped and re-anchored when the viewport moves. This removes the re-render
    // from the viewport handler, so the pins stop following the page.
    //
    // Anchored on the re-render, not on the `renderFrame()` above it: an earlier
    // version of this mutation removed the hover frame instead, which left the
    // numbering intact and so did not express the fault it describes. It was also
    // never injected by a case, so nothing noticed.
    file: 'lib/overlay.js',
    from: '      renderPins()\n    })\n  }\n',
    to: '    })\n  }\n',
  },
  'pins-not-clickable': {
    // `.dsa-layer` sets `pointer-events:none`, and a descendant cannot opt back in
    // across an ancestor that said no — so the pins stopped receiving clicks.
    file: 'lib/overlay.js',
    from: "  pinLayer.className = 'dsa-pins'",
    to: '  // pinLayer keeps no class',
  },
  'list-under-the-conversation': {
    // Back to a locally-anchored absolute panel, which the shell's chat column
    // paints over because it is its own stacking context.
    file: 'client.js',
    from: '.dsa-count-body{position:fixed;z-index:2147483000;',
    to: '.dsa-count-body{position:absolute;z-index:20;',
  },
  'detect-has-two-entry-points': {
    // The duplicate control beside "Open" that the reader asked to have removed.
    file: 'client.js',
    from: "              // No detect button here.",
    to: "              h('button', { type: 'button', className: 'dsa-btn dsa-icon-btn', onClick: onDetect }, h(Icon, { name: 'radar' })),\n              // No detect button here.",
  },
  'batch-released-at-turn-end-only': {
    // The reported regression: the capsule stayed visible for the whole reply
    // because release waited for the turn boundary instead of the handover.
    file: 'lib/index.js',
    from: "      releaseBatch(session, 'delivered', true)\n",
    to: '',
  },
  'selector-names-an-ancestor': {
    // Returning an ancestor's class as if it were a complete selector. It resolves
    // uniquely — to the WRONG element — so two different annotations collapse onto
    // the same container and one of their numbers never appears.
    file: 'lib/overlay.js',
    from: '    var byClass = firstUniqueClass(el)\n    if (byClass) return byClass',
    to: '    var byClass = uniqueClassSelector(el, 0)\n    if (byClass) return byClass',
  },
  'shared-testid-accepted': {
    // Handing out a test hook shared by several nodes. Two annotations then carry the
    // same selector and resolve to the same element.
    file: 'lib/overlay.js',
    from: '        if (document.querySelectorAll(byTestId).length === 1) return byTestId',
    to: '        return byTestId',
  },
  'ambiguous-selector-guessed': {
    // Accepting the first match when a selector names several nodes, rather than
    // matching on the recorded text. One pin is drawn twice and another is lost.
    file: 'lib/overlay.js',
    from: '    if (candidates && candidates.length > 1) {',
    to: '    if (false) {',
  },
  'unplaced-annotations-silent': {
    // Dropping an unplaceable annotation without a word, which is what made the
    // reader's report read as a counting bug rather than a page that had moved.
    file: 'lib/overlay.js',
    from: `      post('unplaced', {
        count: unplaced.length,
        total: here.length,
        session: state.annotations.length,
        page: pagePath,
        items: unplaced,
      })`,
    to: '      void unplaced',
  },
  'popup-blind-to-page': {
    // The list numbered the session while the page numbered itself — the reported
    // fault, on the surface the reader actually reads the numbers on. Each page
    // loads only its own marks, so it can only ever count from 1; a list that
    // numbers straight through disagrees with every pin as soon as a second page
    // is marked, and the reader sees "element 2" meaning two different elements
    // depending on which surface they look at.
    //
    // Grouping is removed by flattening every entry onto one page, which is the
    // fault's shape rather than a shortcut: the list then produces exactly the one
    // run of 1..n it produced before the fix.
    file: 'client.js',
    from: '      const groups = pageGroups(usable(annotations))\n',
    to: "      const groups = pageGroups(usable(annotations).map((one) => Object.assign({}, one, { page: '' })))\n",
  },
  'report-in-arrival-order': {
    // The panel sends the list in the order the marks arrived instead of in the
    // order it lists them. The host numbers its headings by position in that
    // array, so the block the model receives calls an element 2 that the panel
    // row and the pin both call 1 — the reader says "element 2" meaning the row
    // in front of them, and the model edits a different element. This is the
    // third of the three surfaces that have to agree.
    file: 'client.js',
    from: '        const toReport = (list) => inReadingOrder(usable(list))\n',
    to: '        const toReport = (list) => usable(list)\n',
  },
  'page-always-nested': {
    // Nesting the elements under a page heading even when there is only one page.
    // The single-page case is the common one and is left flat so the block does not
    // grow a heading that only repeats what the reader already knows.
    file: 'lib/index.js',
    from: '      if (!multiPage) sections.push(...inner.map((one) => `## ${one}`))\n',
    to: '      if (false) sections.push(...inner.map((one) => `## ${one}`))\n',
  },
  'replace-state-unwrapped': {
    // Leaving `replaceState` alone while wrapping `pushState`. It fires no event
    // either, and it is what a router uses when it must not add a history entry —
    // a redirect, or normalising a URL — so a page that navigates only that way is
    // never noticed and the pins stay bound to the view the reader left.
    file: 'lib/overlay.js',
    from: ";['pushState', 'replaceState'].forEach(function (name) {",
    to: ";['pushState'].forEach(function (name) {",
  },
  'pins-numbered-by-creation-order': {
    // The pins were numbered in the order the marks were MADE while the panel
    // sorts by where the element sits on the page. Mark something, then mark
    // something above it, and pin `1` sits at the bottom of the page while row 1
    // of the list is the element at the top — the same number naming two
    // different elements depending on which surface the reader looks at.
    //
    // The sort is dropped from the NUMBERING list only; the drawing list keeps
    // its order. Replacing the whole `readingOrder(...)` call would leave the
    // filter's parentheses unbalanced — a syntax error, which the overlay's own
    // install guard catches before any pin is drawn, so the fault would be
    // "detected" by a crash rather than by the numbering assertion it is about.
    file: 'lib/overlay.js',
    from: '    var numbered = readingOrder(here.filter(function (one) {\n      // Mirrors the panel\'s own filter, so an entry it refuses to list does not\n      // shift the numbers of the ones it does.\n      return one !== null && typeof one === \'object\'\n    }))',
    to: '    var numbered = here.filter(function (one) {\n      // Mirrors the panel\'s own filter, so an entry it refuses to list does not\n      // shift the numbers of the ones it does.\n      return one !== null && typeof one === \'object\'\n    })',
  },
  'offscreen-counts-as-unlocatable': {
    // The reported bug: scrolling a mark out of view made the panel announce
    // "N 项标注无法定位到页面元素", and scrolling back made it go away. Both
    // outcomes are the ordinary consequence of scrolling, not a fault. `pinAnchor`
    // now returns the reason; collapsing `offscreen` back into `missing` is the
    // exact shape of the defect, and it trains the reader to ignore the warning
    // that really does mean their page changed.
    file: 'lib/overlay.js',
    from: "      return { anchor: null, reason: 'offscreen' }\n",
    to: "      return { anchor: null, reason: 'missing' }\n",
  },
  'openbar-stuck-expanded': {
    // Seeding the address bar's expanded flag from `preview`. On a remount the panel
    // reopens the page it remembered in an effect, so `preview` is null on the first
    // render: the bar stays expanded for the rest of the session and the compact chip
    // showing the current route never appears after a tab switch — which is the
    // control the reader asked for in the first place.
    //
    // The flag lives on the PANEL, not inside the bar, since the tab strip's "new page"
    // button has to open the bar and is a sibling. The mutation has to move with it.
    //
    // `true` rather than `!preview`: `preview` is derived further down and reading it
    // here would be a temporal-dead-zone crash, which proves nothing about the UI.
    // Seeding it open reproduces the reported defect exactly — the bar never collapses.
    file: 'client.js',
    from: '        const [composing, setComposing] = React.useState(false)\n',
    to: '        const [composing, setComposing] = React.useState(true)\n',
  },
  'chip-shows-port-only': {
    // The reader's original complaint, exactly: the chip showed the ephemeral
    // proxy origin and nothing else, so every page and every tab produced the same
    // string and it could not answer "where am I".
    file: 'client.js',
    from: '        return host + path + parsed.search + parsed.hash\n',
    to: '        return parsed.host\n',
  },
  'chip-truncates-from-the-right': {
    // Keeping the prefix and clipping the tail. Two views of one app share a host
    // and a path prefix and differ only in the suffix, so this shows the same
    // string for all of them — the complaint again, just expressed in CSS.
    file: 'client.js',
    from: '.dsa-loc-host{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;opacity:.8}',
    to: '.dsa-loc-host{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8}',
  },
  'address-bar-opens-blank': {
    // Dropping the seed, which is the reported bug: the chip expands an input bound
    // to `url`, and `url` is only ever written by typing. A page opened any other way
    // leaves it empty, so the control that shows you where you are opens blank.
    // Behavioural, not a crash: the input still renders and still works.
    file: 'client.js',
    from: '        if (preview) setUrl(preview.target || preview.url || \'\')\n',
    to: '',
  },
  'preview-key-drops-the-path': {
    // The reported "I cannot open a second page at all", on the HOST side, URL arm.
    // Keying the preview identity on `URL.origin` throws the path away, so two pages of
    // one app — localhost:5173/a and localhost:5173/b — resolve to the same preview.
    // `/open` for the second hands back the FIRST page's sid, the panel correctly reads
    // that as "already open" and switches to it, and the reader is stuck on one tab with
    // no second frame to show for it. This is the original expression, restored.
    file: 'lib/index.js',
    from: '            origin: target ? target.href : `file://${filePath}`,\n',
    to: '            origin: target ? target.origin : `file://${filePath}`,\n',
  },
  'file-preview-key-uses-the-directory': {
    // The same defect on the FILE arm, which is the one that was still live. A workspace
    // page keys on `file://${fileRoot}` — the FOLDER — so two pages saved side by side
    // share one reuse key, the second `/open` hands back the first one's sid, and the
    // panel switches instead of adding. Reported as "one tab, again", on file pages.
    file: 'lib/index.js',
    from: '            origin: target ? target.href : `file://${filePath}`,\n',
    to: '            origin: target ? target.href : `file://${fileRoot}`,\n',
  },
  'tab-strip-hidden-until-two': {
    // Rendering the strip only from two pages up, which was the shipped behaviour and
    // the reason the feature was unreachable: with one page open there was no "+" to
    // press, so the reader had no way to ask for a second page. The strip has to exist
    // at one page for the control that adds one to exist at all.
    file: 'client.js',
    from: '      if ((!tabs || tabs.length === 0) && !draft) return null\n',
    to: '      if (!tabs || tabs.length < 2) return null\n',
  },
  'tab-new-button-opens-no-blank-tab': {
    // The "+" empties the address bar and expands it but adds no tab, which is what
    // the reader reported: nothing appears in the strip, so "typing a new address" and
    // "editing the one I have" are the same picture. Everything else about the feature
    // still works — the page opens on Enter — so only the drawn blank tab is missing,
    // which is why it takes an assertion about the tab to see it.
    file: 'client.js',
    from: '              setComposing(true)\n              // And a tab to type it in. Without this the only feedback was an empty\n              // address bar, which is the same thing the reader sees when editing the\n              // page they already have — so they could not tell the two apart.\n              setDraft(true)\n',
    to: '              setComposing(true)\n',
  },
  'tab-new-button-does-nothing': {
    // The "+" renders and takes clicks but never opens the bar, so pressing it looks
    // like a control that does nothing — the same dead end, one layer in. The state is
    // the panel's, so the mutation drops the flag rather than the seed.
    file: 'client.js',
    from: '              setUrl(\'\')\n              setComposing(true)\n',
    to: '              setUrl(\'\')\n',
  },
  'reused-preview-opened-twice': {
    // Falling through instead of returning when the host hands back a sid that is
    // already open. The host REUSES a preview for a target it already has, so this
    // adds a second tab for one page: two iframes on one preview, and that page's
    // marks split between two owners — one of them silently never drawn.
    // Behavioural: the extra tab renders, it is just the same page twice.
    file: 'client.js',
    from: "              if (data.sid !== activeSidRef.current) setActiveSid(data.sid)\n"
      + "              // NOT `setMode('idle')`. The mode belongs to the panel now, and a\n"
      + '              // reloaded page coming back must be told what it is — clearing it here\n'
      + "              // would turn the reader's 选取 off as a side effect of a refresh.\n"
      + "              postToPage({ type: 'mode', mode: modeRef.current }, data.sid)\n"
      + '              return\n',
    to: "              if (data.sid !== activeSidRef.current) setActiveSid(data.sid)\n"
      + "              postToPage({ type: 'mode', mode: modeRef.current }, data.sid)\n",
  },
  'closed-page-marks-dropped': {
    // Not parking a closed page's marks before dropping the tab, which is the
    // reading the reader rejected: closing a page is not a decision to discard what
    // was written on it. Behavioural — every other assertion still passes, the marks
    // simply stop being counted and stop being sent.
    file: 'client.js',
    from: '            closedMarks.current.set(sid, { marks, target: tab.target || tab.url })\n',
    to: '',
  },
  'tabs-state-not-written-through': {
    // Publishing the tab list to React state only, without writing it through the
    // ref that the handlers read. Opening a page spans several awaits, and state
    // only changes on the next render, so two pages opened in one tick both read
    // the same stale list and the second drops the first: the reader asks for a
    // second page and gets one. Offline source checks all passed on this.
    file: 'client.js',
    from: '          const list = typeof next === \'function\' ? next(tabsRef.current) : next\n'
      + '          tabsRef.current = list\n'
      + '          setTabsState(list)\n',
    to: '          setTabsState(next)\n',
  },
  'bucket-keyed-by-route': {
    // Filing the marks by the route they were made on, which is the "one URL =
    // one page" reading the reader rejected. Switching views then empties the
    // list, because the new route's bucket is a different key.
    file: 'lib/overlay.js',
    from: '    return STORE_PREFIX + session\n',
    to: "    return STORE_PREFIX + session + ':' + pagePath\n",
  },
  'attachment-scoped-to-route': {
    // Navigating narrows the ATTACHED list to what is on screen, rather than
    // narrowing only what is drawn. The list, the count and the composer capsule
    // all lose the marks made on other views.
    file: 'lib/overlay.js',
    from: `      live.clear()
      render()`,
    to: `      live.clear()
      if (moved) state.annotations = annotationsOn(pagePath)
      render()`,
  },
  'unplaced-counts-other-routes': {
    // Reconciling an unplaceable count against the whole session rather than the
    // route. One mark on another page is then reported as "N of M have no number
    // — the page moved under them", which is a false alarm about the reader's
    // page when they are simply looking at a different one.
    file: 'lib/overlay.js',
    from: '        total: here.length,\n',
    to: '        total: state.annotations.length,\n',
  },
  'path-ends-at-ancestor': {
    // Building the positional path by returning an ancestor as the WHOLE selector.
    // This is the reader's exact report: a `<b>` inside `.l2` recorded as `.l2`, which
    // resolves uniquely to the container. Two annotations on different children then
    // land on one node and a number is never drawn.
    file: 'lib/overlay.js',
    from: "      if (anchor) {\n        segments.unshift(anchor)\n        break\n      }",
    to: "      if (anchor) {\n        return anchor\n      }",
  },
  'chip-reads-a-line-short': {
    // Reading a `key: value` line with a lazy match that stops at the first space.
    // Every selector containing a space — which is every descendant combinator, the
    // most common positional selector the overlay produces — is then truncated to
    // its first segment, so the chip shows a selector that resolves to a different
    // element than the one the reader marked.
    file: 'client.js',
    from: "        if (!fields) continue\n        const field = /^([a-z]+):[ \\t]?(.*)$/.exec(line)\n",
    to: "        if (!fields) continue\n        const field = /^([a-z]+):[ \\t]?(\\S*)$/.exec(line)\n",
  },
  'chip-matches-reader-text': {
    // Dropping the plugin-identity guard and keeping only "some plugin sent this".
    // The Definition then claims every plugin-sourced user message in the session
    // — other plugins' context rows included — and paints a chip under messages
    // that carry no annotations at all.
    file: 'client.js',
    from: "          && event.data.source.kind === 'plugin'\n          && event.data.source.plugin === KIND\n",
    to: "          && event.data.source.kind !== 'user'\n",
  },
  'chip-located-in-turn': {
    // Locating the chip in a turn instead of leaving it unresolved. Compact mode
    // then folds it into the collapsed process block — the chip disappears behind
    // "process" for exactly the messages that carry annotations — and the host's
    // own process disclosure changes, because a non-independent node now sits
    // inside the fold window.
    file: 'client.js',
    from: "          location: { kind: 'unresolved' },\n",
    to: "          location: { kind: 'turn', turn: 1 },\n",
  },
  'chip-before-reader-bubble': {
    // Anchoring a full seq AFTER the delivery message rather than half a seq before
    // it. The chip then sorts below the context row instead of hanging directly
    // under the reader's own bubble, which is the placement that was asked for.
    file: 'client.js',
    from: "            anchorSeq: state.seq - 0.5,\n",
    to: "            anchorSeq: state.seq + 1.5,\n",
  },
  'chip-registers-ahead-of-its-seat': {
    // Registering the Definition before the renderer seat. A Definition whose kind
    // has no occupant is not left blank by the shell: it renders the JSON fallback
    // in the reader's transcript, so this turns the chip into a visible dump.
    file: 'client.js',
    from: "      contribute('conversation.chat.node', CHIP_KIND, AnnotationChip, undefined, { key: CHIP_KIND, order: 12 })\n",
    to: "      // seat removed\n",
  },
  'chip-registration-throws': {
    // Letting the registry's duplicate-kind throw escape `apply`. The registry
    // refuses a kind it already holds by throwing, and activation is shared with
    // the sidebar, the tab and the capsule — so this is the restart-into-an-error
    // failure mode.
    file: 'client.js',
    from: "          try {\n            scope.effect(() => registerChipDefinition(scope.uiConversation))\n          } catch (error) {\n",
    to: "          if (true) {\n            scope.effect(() => registerChipDefinition(scope.uiConversation))\n          } else {\n            const error = null\n",
  },
  'chip-samples-the-service-too-early': {
    // THE BUG THAT SHIPPED. Reading the service once during `apply` and branching
    // on the sample, instead of waiting for it. `uiConversation` comes from another
    // row and rows apply concurrently, so the sample is `undefined` whenever that
    // row is merely slower — the registration is then skipped for good, silently.
    //
    // The reader saw the sidebar tab and the composer capsule work and no chip
    // anywhere, with nothing in the console marked as an error. This mutation is why
    // that check exists: the whole suite, and the source-level assertions that
    // merely looked for `registerChipDefinition`, passed while the chip was dead.
    file: 'client.js',
    from: "        ctx.inject(['uiConversation'], (scope) => {\n",
    to: "        ctx.effect(() => {\n          const scope = Object.assign({}, ctx, { uiConversation: ctx.get('uiConversation') })\n          if (!scope.uiConversation) return\n",
  },
  'chip-capsule-renders-the-block': {
    // Putting the block heading into the composer capsule, which is the regression
    // that made the reader see the model-facing text as their own draft.
    file: 'client.js',
    from: "    function AnnotationCapsule(props) {\n",
    to: "    function AnnotationCapsule(props) {\n      const leaked = '# Web page elements'\n      void leaked\n",
  },
  'edit-leaves-the-list-on-top': {
    // Opening a mark for editing without putting the dialog away. The reader's report:
    // pressing ✎ opened the card on the page but left this dialog covering it, so the
    // card and the list were both on screen and the card was the one being written in.
    file: 'client.js',
    from: "      const openForEdit = (id, event) => {\n        const details = event && event.currentTarget && event.currentTarget.closest('details')\n        if (details) details.open = false\n        onEdit(id, 'edit')\n      }\n",
    to: "      const openForEdit = (id, event) => {\n        void event\n        onEdit(id, 'edit')\n      }\n",
  },
  'clear-all-scrolls-out-of-reach': {
    // Putting the whole dialog back to one scrolling column, which is the shipped
    // bug: the action bar sat under the last row, so a long list pushed 全部清除
    // below the fold. The button was present and working the entire time — it was
    // only reachable after a scroll the reader had no reason to make, which is what
    // made it read as missing. Asserted at the CSS level, because the difference is
    // which element scrolls and jsdom has no layout.
    file: 'client.js',
    from: ".dsa-count-body{position:fixed;z-index:2147483000;top:50%;left:50%;transform:translate(-50%,-50%);width:min(360px,calc(100vw - 32px));max-height:min(70vh,520px);overflow:hidden;display:flex;flex-direction:column;",
    to: ".dsa-count-body{position:fixed;z-index:2147483000;top:50%;left:50%;transform:translate(-50%,-50%);width:min(360px,calc(100vw - 32px));max-height:min(70vh,520px);overflow:auto;",
  },
  'page-itself-counts-as-a-target': {
    // Treating the document element as an element worth annotating. `elementFromPoint`
    // returns `<html>` wherever the page has no content under the cursor, so the frame
    // outlines the entire document and the readout names it — which the reader reported
    // as the whole page looking selected when they moved the pointer off the sidebar to
    // type. Nobody annotates the document element, so the reading is never useful.
    file: 'lib/overlay.js',
    from: "    if (!el || el === root || root.contains(el)) return null\n    // Empty space resolves to the document itself; see `isPageItself`.\n    if (isPageItself(el)) return null\n",
    to: "    if (!el || el === root || root.contains(el)) return null\n",
  },
  'hover-survives-leaving-the-preview': {
    // Dropping the `mouseleave` handler. No `mousemove` follows the pointer out of the
    // frame, so the last hovered element stays framed and named after the pointer has
    // gone — the same "the page still looks selected while I type" complaint, reached
    // without the document element being involved at all.
    file: 'lib/overlay.js',
    from: "  capture.addEventListener('mouseleave', function () {\n    if (state.mode !== 'marking' || card) return\n    if (state.hover === null) return\n    state.hover = null\n    renderFrame()\n  })\n",
    to: "",
  },
  'an-empty-report-resurrects-the-batch': {
    // Restoring on `changed` as well as `ready`. `changed` is the page answering an
    // action the reader just took, and the one action that empties the list is deleting
    // the last mark — so this hands the deleted mark straight back and the page re-draws
    // it. Reported as a dead 删除 button, because only the last mark was affected.
    file: 'client.js',
    from: "      if (args.type === 'ready' && !incoming.length && held.length) {",
    to: "      if (!incoming.length && held.length) {",
  },
  'capsule-late-answer-wins': {
    // Letting a late answer overwrite a newer one. `setInterval` fires on a clock and
    // `fetch` does not answer on one, so the poll after a send and a straggler from
    // before it can both be in flight, and the stale one can land last — writing the
    // pre-send count back over the cleared one. The reader sees the capsule stay up
    // after a message that already went out, and the sidebar and the capsule then
    // disagree about a number the host has already changed.
    file: 'client.js',
    from: "            if (ticket !== latestPoll.current) return\n",
    to: "            if (false) return\n",
  },
  'chip-counts-what-it-cannot-show': {
    // Counting the raw entries while listing only the renderable ones. The chip
    // then reads `×3` above a list of two, which is the one failure the reader
    // cannot detect by looking — the number and the list both look plausible.
    file: 'client.js',
    from: "      const items = raw.filter((item) => (\n        item && typeof item === 'object' && Boolean(item.selector || item.note || item.text)\n      ))\n",
    to: "      const items = raw.filter(() => true)\n",
  },
  'release-leaves-the-mirror-stale': {
    // Reported from a real session: a mark could be deleted and it came straight
    // back, and after a send the sidebar kept its list while the capsule kept its
    // count.
    //
    // `hostHeld` is the panel's copy of what the host holds, and the restore path
    // reads it as evidence that a batch is still attached. Emptying the list while
    // the mirror still describes the batch means the purge sent to the page is
    // answered with an empty report, that report is read as "the preview was
    // rebuilt", and every released mark is handed straight back to the page — which
    // re-reports them, so the host is given the batch again and goes on counting it.
    //
    // Removing the one line reproduces the shipped fault exactly; the rest of the
    // function is untouched, so this is faithful rather than a synthetic break.
    file: 'client.js',
    from: "        const releaseFromHost = () => {\n          setAnnotations([])\n          reported.current = JSON.stringify([])\n          // The host has let go of the batch, so the mirror of what it holds has\n          // to go with it.\n          //\n          // This line is the whole fix for a mark that would not stay deleted. The\n          // mirror was left holding the batch that had just been released, so the\n          // purge sent to the page below emptied it, the page reported itself\n          // empty, and that empty report met a `hostHeld` that still described the\n          // marks — which is precisely the condition the restore path is written\n          // to react to. It put every released mark back on the page, the page\n          // re-reported them, and the host was handed the same batch again. The\n          // reader deleted a mark and watched it come back, and the composer went\n          // on counting marks the turn had already carried.\n          hostHeld.current = []\n",
    to: "        const releaseFromHost = () => {\n          setAnnotations([])\n          reported.current = JSON.stringify([])\n",
  },
  'purge-only-reaches-the-page-on-screen': {
    // Reported from a real session: after sending, the composer capsule kept its
    // count and the sidebar kept its list, while the page had no marks left. The
    // purge was sent with NO sid, and that form aims at `activeSidRef.current` alone,
    // so every page in a background tab kept its marks. The panel's list is the
    // FLATTENED UNION of all of them, so the next report from a background page
    // rebuilt the batch that had just been released and handed it back to the host.
    //
    // Faithful rather than synthetic: this restores the exact shipped expression. The
    // sweep still runs and still purges — it just reaches one page, which is what the
    // reader's two-tab session did.
    file: 'client.js',
    from: "        const purgeEveryPage = () => {\n          for (const tab of tabsRef.current) postToPage({ type: 'purge' }, tab.sid)\n        }\n",
    to: "        const purgeEveryPage = () => {\n          postToPage({ type: 'purge' })\n        }\n",
  },
  'clear-forgets-the-pages-but-not-the-mirror': {
    // The other half of the same bug, and the one a reader is more likely to see:
    // the pages are emptied but the panel's per-page mirror is not. The mirror is what
    // the list is re-derived FROM, so the next `ready` or `changed` from any page puts
    // the released marks straight back — the reader removes the last mark and watches
    // the list refill.
    file: 'client.js',
    from: "        const forgetAllMarks = () => {\n          tabMarks.current.clear()\n          closedMarks.current.clear()\n        }\n",
    to: "        const forgetAllMarks = () => {\n          void tabMarks\n        }\n",
  },
  'address-bar-is-a-row-of-its-own-below-the-tabs': {
    // The arrangement the reader rejected, drawn to scale in their screenshot: they
    // circled the empty slab beside the toolbar buttons and wrote "此处已为空". The bar
    // was a sibling row BELOW the tab strip, so the two read as one unit — while the
    // toolbar kept a hole where the address belonged.
    //
    // Faithful rather than synthetic: this is the shipped structure, restored verbatim,
    // spacer and all. Nothing throws and every control still works; only the nesting
    // differs, which is why it takes a structural or rendered assertion to see it.
    file: 'client.js',
    from: "            h(OpenBar, {\n              onOpen: openTarget,\n",
    to: "            h('span', { className: 'dsa-spacer' }),\n            h(OpenBar, {\n              onOpen: openTarget,\n",
  },
  'purge-empties-the-store-but-not-the-page': {
    // Reported from a real session: "胶囊和顶上的那个'附加到下一次对话'都是正常清除的，
    // 但是页面内的那个气泡没有清除". Emptying the store and saving it is invisible — the
    // numbered bubbles are drawn by `renderPins()`, which runs only from `render()`. So
    // every surface the panel owns goes blank while the page keeps its numbered pins,
    // which is the worst version of the bug: the reader is told the marks are gone and
    // can still see them, and pressing a pin opens a card for a mark that no longer
    // exists. Behavioural rather than structural: nothing throws.
    file: 'lib/overlay.js',
    from: "        state.annotations = []\n        live.clear()\n        save()\n        render()\n        post('changed', { annotations: [] })\n",
    to: "        state.annotations = []\n        live.clear()\n        save()\n        post('changed', { annotations: [] })\n",
  },
  'marking-mode-is-private-to-one-page': {
    // Marking on the per-page record, which is how it shipped: turn 选取 on, switch tab,
    // and the button reads off again while the first page is still capturing clicks.
    // The reader's report: "不同的标签页之前并不是共享'选取'状态的 每个页面都是独立的".
    // Restores the exact per-tab write and the active-page-only send.
    file: 'client.js',
    from: "        const setPageMode = (next) => {\n"
      + "          const value = next === 'marking' ? 'marking' : 'idle'\n"
      + '          modeRef.current = value\n'
      + '          setModeState(value)\n'
      + "          for (const tab of tabsRef.current) postToPage({ type: 'mode', mode: value }, tab.sid)\n"
      + '        }\n',
    to: "        const setPageMode = (next) => {\n"
      + "          const value = next === 'marking' ? 'marking' : 'idle'\n"
      + '          modeRef.current = value\n'
      + '          setModeState(value)\n'
      + "          postToPage({ type: 'mode', mode: value })\n"
      + '        }\n',
  },
  'epoch-forgotten-across-a-remount': {
    // Taking the epoch just observed as the baseline every time, which is what a
    // ref inside the capsule does. The dock is remounted whenever the composer is,
    // so a clear that happened while it was away is never announced: the panel
    // keeps a list the host has already let go of, and its next report uploads
    // those marks straight back.
    file: 'client.js',
    from: "            const seen = hostEpoch.has(sessionId) ? hostEpoch.get(sessionId) : null\n",
    to: "            const seen = null\n",
  },
  'chip-aligns-to-the-column-not-the-bubble': {
    // Aligning the chip to the left edge of its own flow row. That row is a sibling
    // of the reader's row, so its left edge is the COLUMN's left edge — while the
    // bubble is content-sized and right-aligned inside its row, so its left edge
    // moves with the text. Reported from a real session with a screenshot: the chip
    // rendered at the far side of the transcript, nowhere near its message.
    file: 'client.js',
    from: ".dsa-chip-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px}",
    to: ".dsa-chip-row{display:flex;flex-direction:column;align-items:flex-start;gap:6px}",
  },
  'chip-indent-forgets-the-bubble-width': {
    // Indenting by the bubble's width instead of by the column minus the bubble's.
    // The two differ by exactly the bubble's width, so the chip lands short of the
    // bubble's left edge by that much — a small bubble puts it almost at the column
    // edge, which is the mis-placement the reader reported, just arrived at by
    // arithmetic rather than by a CSS keyword. Invisible without layout, which is why
    // the arithmetic is a pure function with its own assertions.
    file: 'client.js',
    from: "      const offset = Math.round(rowWidth - bubbleWidth)\n",
    to: "      const offset = Math.round(bubbleWidth)\n",
  },
  'chip-indent-emits-padding-without-the-alignment': {
    // Emitting the offset inline but leaving the row end-aligned. A left padding on a
    // full-width row whose items are aligned to the end only narrows the content box;
    // the chip does not move at all. This is the trap in the whole placement: the DOM
    // looks right, the number is right, and the chip is still on the wrong side.
    file: 'client.js',
    from: "        className: 'dsa-chip-row dsa-chip-row--indent',\n",
    to: "        className: 'dsa-chip-row',\n",
  },
  'chip-measures-the-wrong-sibling': {
    // Looking for the message as the row's own sibling instead of as a sibling of the
    // seat the shell wraps it in. The row has NO sibling — the occupant is rendered
    // INSIDE that wrapper — so this finds nothing on every real message and the chip
    // silently takes its fallback, which is the worst kind of failure here: the
    // fallback looks deliberate, so the placement simply never happens and nothing
    // errors. Caught by re-reading the shell's own seat component after the fix had
    // already been written and reviewed.
    file: 'client.js',
    from: "      return row.closest('[data-chat-anchor-key]') || row\n",
    to: "      return row\n",
  },
  'capsule-forgets-what-it-holds': {
    // Keeping the count and throwing the entries away, which is exactly the state
    // this shipped in: the pill answered "3 attached" and nothing else, so the reader
    // could not see which three before sending them. The host had been returning the
    // entries all along — the poll simply discarded them.
    //
    // Quiet by construction: the pill still renders and still counts correctly, and
    // the open panel shows its "nothing to show" note rather than an error.
    file: 'client.js',
    from: "            if (Array.isArray(data.annotations)) {\n              setItems(data.annotations)\n              setFailed(false)\n            }\n",
    to: "",
  },
  'capsule-list-only-ever-grows': {
    // Letting the open list keep whatever it already had when the new answer is
    // shorter — a plausible "don't flicker the list while it is being read" guard.
    // It is wrong here because the count and the list come from the SAME answer, so
    // the pill then counts one batch while the rows below it describe another. The
    // reader cannot detect that by looking: each half is individually plausible, and
    // the stale rows are marks that really were attached a moment ago.
    file: 'client.js',
    from: "              setItems(data.annotations)\n              setFailed(false)\n",
    to: "              setItems((prev) => (prev && prev.length > data.annotations.length ? prev : data.annotations))\n              setFailed(false)\n",
  },
  'preview-frame-is-cross-site': {
    // Naming the preview server `localhost` while the harness answers on
    // `127.0.0.1`. Those are different SITES, so a browser refuses the app's own
    // `SameSite=Lax` session cookie inside the frame: the login POST is delivered,
    // the 302 comes back, and the redirect arrives anonymous. Nothing looks broken
    // from the host's side — this is a browser rule, so every server-side check
    // passes and the reader simply stays logged out.
    //
    // The inverse of the usual failure: writing `'localhost'` here looks like
    // pinning a safe loopback name, and it is, which is why it survived. The value
    // that matters is not "loopback" but "the same site as the parent".
    file: 'lib/index.js',
    from: "  return host === '127.0.0.1' || host === 'localhost' ? host : 'localhost'",
    to: "  return 'localhost'",
  },
}

const mutation = MUTATIONS[name]

/**
 * Put every source file back the way it was.
 *
 * Checked BEFORE the lookup, because `restore` is not a mutation and the lookup
 * would reject it as an unknown name.
 *
 * The harness normally holds the original in memory and rewrites it in a `finally`,
 * which is fine for one run. It is not fine when a mutation is applied by hand to
 * look at something: the process that knew the original has exited, and the injected
 * fault is now simply the code. That happened — two mutations stayed in
 * `lib/index.js` after a manual `node scripts/mutate.mjs . <name>`, and the next
 * harness run reported "did not match anything" because the anchor it wanted had
 * already been consumed.
 *
 * Keeping the original on disk beside the file means `restore` always works, from
 * any state, without needing to know which mutations were applied.
 */
if (name === 'restore') {
  let restored = 0
  for (const file of new Set(Object.values(MUTATIONS).map((one) => one.file))) {
    const path = join(dir, file)
    const backup = `${path}.mutation-backup`
    if (!existsSync(backup)) continue
    writeFileSync(path, readFileSync(backup, 'utf8'))
    rmSync(backup)
    console.log(`restored ${file}`)
    restored += 1
  }
  console.log(restored === 0 ? 'nothing to restore' : `restored ${restored} file(s) from backup`)
  process.exit(0)
}

if (!mutation) {
  console.error(`unknown mutation: ${name}`)
  process.exit(2)
}

const path = join(dir, mutation.file)
const before = readFileSync(path, 'utf8')
if (!before.includes(mutation.from)) {
  console.error(`mutation "${name}" did not match anything in ${mutation.file}`)
  console.error(`if a previous run was interrupted, run: node scripts/mutate.mjs . restore`)
  process.exit(2)
}
const after = before.replace(mutation.from, mutation.to)
if (after === before) {
  console.error(`mutation "${name}" produced no change`)
  process.exit(2)
}
// Only written if absent, so applying a second mutation on top of the first does not
// overwrite the pristine original with already-mutated text.
const backup = `${path}.mutation-backup`
if (!existsSync(backup)) writeFileSync(backup, before)
writeFileSync(path, after)
console.log(`applied ${name} to ${mutation.file}`)
