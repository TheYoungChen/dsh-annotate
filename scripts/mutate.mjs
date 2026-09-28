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
  'pins-number-by-list-index': {
    // The reported fault, reduced to its single cause: the label came from the
    // annotation's position in the list instead of from a counter of the pins that
    // were actually drawn. Placement is untouched, so this isolates numbering —
    // an unplaceable pin is skipped by the guard but has already consumed its
    // number, which is what produced 1, then 3.
    file: 'lib/overlay.js',
    from: '      shown += 1\n      var pin = document.createElement(\'button\')\n      pin.type = \'button\'\n      pin.className = \'dsa-pin\'\n      pin.textContent = String(shown)',
    to: '      var pin = document.createElement(\'button\')\n      pin.type = \'button\'\n      pin.className = \'dsa-pin\'\n      pin.textContent = String(state.annotations.indexOf(annotation) + 1)',
  },
  'pins-not-renumbered-on-scroll': {
    // Numbering recomputed only when the list changes. Scrolling can strand a pin,
    // which then leaves a gap in the labels until something else re-renders.
    file: 'lib/overlay.js',
    from: '      frameQueued = false\n      renderFrame()',
    to: '      frameQueued = false\n      void renderFrame',
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
    from: "      post('unplaced', { count: unplaced.length, total: state.annotations.length, items: unplaced })",
    to: '      void unplaced',
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
