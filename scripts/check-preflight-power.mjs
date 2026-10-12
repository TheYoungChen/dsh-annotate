/**
 * Mutation check: does the preflight actually detect real breakage?
 *
 * A test that passes no matter what is worthless. This copies the plugin to a
 * scratch directory, introduces one fault at a time, and confirms the
 * corresponding preflight check fails. The live plugin is never touched.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOURCE = 'E:/StudyFile/AI-Workspace/dsh_workspace/plugins/dsh-annotate'
const PROFILE_PATCH = 'C:/Users/a3025/.dsh/profiles/web/cordis.patch.yml'
const scratch = mkdtempSync(join(tmpdir(), 'dsh-anno-mutate-'))
console.log('scratch copy:', scratch)

/** Run one of the preflight scripts inside a mutated copy. */
function runPreflight(dir, script) {
  try {
    const out = execFileSync(process.execPath, [join(dir, 'scripts', script)], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // The profile patch is outside the copied tree, so it is passed in rather
      // than discovered; the scratch copy has no profile of its own.
      env: { ...process.env, DSH_ANNOTATE_PATCH: PROFILE_PATCH },
    })
    return { passed: /PASSED/.test(out) && !/FAILED/.test(out), out }
  } catch (error) {
    return { passed: false, out: `${error.stdout || ''}${error.stderr || ''}` }
  }
}

/** Fresh copy with a mutation applied. */
function mutate(label, apply) {
  const dir = join(scratch, label.replace(/[^a-z0-9]+/gi, '-'))
  cpSync(SOURCE, dir, { recursive: true, filter: (src) => !src.includes('node_modules') })
  apply(dir)
  return dir
}

const cases = [
  {
    name: 'client bundle missing',
    script: 'preflight-activation.mjs',
    apply: (dir) => rmSync(join(dir, 'client.js')),
    expect: /client/i,
  },
  {
    name: 'platform not web',
    script: 'preflight-activation.mjs',
    apply: (dir) => {
      const p = join(dir, 'package.json')
      const pkg = JSON.parse(readFileSync(p, 'utf8'))
      pkg.dsh.client.platform = 'desktop'
      writeFileSync(p, JSON.stringify(pkg, null, 2))
    },
    expect: /platform/i,
  },
  {
    name: 'no ./client export',
    script: 'preflight-activation.mjs',
    apply: (dir) => {
      const p = join(dir, 'package.json')
      const pkg = JSON.parse(readFileSync(p, 'utf8'))
      delete pkg.exports['./client']
      writeFileSync(p, JSON.stringify(pkg, null, 2))
    },
    expect: /export/i,
  },
  {
    name: 'client API base drifts from host route',
    script: 'preflight-activation.mjs',
    apply: (dir) => {
      const p = join(dir, 'client.js')
      writeFileSync(p, readFileSync(p, 'utf8').replace("const API = '/__dsh-annotate'", "const API = '/__dsh-annotate-typo'"))
    },
    expect: /match|API base/i,
  },
  {
    name: 'client calls an action the host lacks',
    script: 'preflight-activation.mjs',
    apply: (dir) => {
      const p = join(dir, 'client.js')
      writeFileSync(p, readFileSync(p, 'utf8').replace('fetch(`${API}/detect`', 'fetch(`${API}/missing`'))
    },
    expect: /implements/i,
  },
  {
    name: 'client bundle has a syntax error',
    script: 'preflight-activation.mjs',
    apply: (dir) => {
      const p = join(dir, 'client.js')
      writeFileSync(p, `${readFileSync(p, 'utf8')}\nfunction ( { broken`)
    },
    expect: /parse/i,
  },
  {
    name: 'host entry imports nothing',
    script: 'preflight-activation.mjs',
    apply: (dir) => {
      const p = join(dir, 'lib', 'index.js')
      writeFileSync(p, 'export const name = "broken"\n')
    },
    expect: /apply/i,
  },
  {
    name: 'an injected client service does not exist',
    script: 'preflight-activation.mjs',
    apply: (dir) => {
      const p = join(dir, 'package.json')
      const pkg = JSON.parse(readFileSync(p, 'utf8'))
      pkg.dsh.client.inject = ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-not-a-real-service']
      writeFileSync(p, JSON.stringify(pkg, null, 2))
    },
    expect: /inject target exists/i,
  },
  {
    name: 'unknown slot key',
    script: 'preflight-shapes.mjs',
    apply: (dir) => {
      const p = join(dir, 'client.js')
      writeFileSync(p, readFileSync(p, 'utf8').replace("contribute('conversation.input.dock'", "contribute('conversation.not.a.real.slot'"))
    },
    expect: /slot/i,
  },
  {
    name: 'tab seat registered under the wrong key',
    script: 'preflight-shapes.mjs',
    apply: (dir) => {
      const p = join(dir, 'client.js')
      writeFileSync(p, readFileSync(p, 'utf8').replace("'sidebar.right.pane.tab', TAB_ID", "'sidebar.right.pane.tab', 'some-other-id'"))
    },
    expect: /TAB_ID|definition id/i,
  },
  {
    // The bug this whole suite missed once: clearing on `turn/start`, which the
    // agent appends BEFORE the step loop runs, so the annotations were deleted
    // before any assembly could read them. Nothing caught it because every test
    // drove the pieces directly instead of replaying the real ordering.
    name: 'annotations cleared before they are read',
    script: 'check-repeat-guard.mjs',
    mutate: 'turn-start-clear',
    expect: /survive turn\/start|turn\/start/i,
  },
  {
    // Appending without checking whether this turn already carries the block puts
    // one identical transcript row per step into the reader's conversation. Seen
    // live as a dozen copies for a single act of attaching.
    name: 'attachment appended once per step',
    script: 'check-repeat-guard.mjs',
    mutate: 'duplicate-append',
    expect: /renders nothing|second step|later step/i,
  },
  {
    // The mirror-image mistake: latching on presence rather than on the turn, so
    // only the first turn ever carries the annotations and every later one is
    // silently starved.
    name: 'attachment never repeated on a later turn',
    script: 'check-delivery-order.mjs',
    mutate: 'attach-once-ever',
    expect: /NEW turn|next turn/i,
  },
  {
    // The session emits `session/event` through its own scope, so a listener
    // without `{ global: true }` is never consulted. The host then holds the
    // annotations forever — the capsule that would not clear after sending.
    name: 'turn boundary never observed',
    script: 'check-delivery-order.mjs',
    mutate: 'session-listener-not-global',
    expect: /turn\/end|ended|nothing is attached/i,
  },
  {
    // The host clears but does not say so. The sidebar is left listing marks that
    // are no longer attached, and its next report uploads them again — the same
    // stuck capsule, reached from the other side.
    name: 'clear is not announced to the sidebar',
    script: 'check-repeat-guard.mjs',
    mutate: 'no-clear-signal',
    expect: /epoch|advance/i,
  },
  {
    // Accepting the sidebar's re-upload of a batch that has just gone out. The
    // window is one poll interval wide, and letting it through is exactly the
    // capsule that came back after sending.
    name: 'stale re-report resurrects a delivered batch',
    script: 'check-repeat-guard.mjs',
    mutate: 'stale-report-accepted',
    expect: /re-reporting|restore|capsule/i,
  },
  {
    // The mirror-image fault, and the one that actually shipped: treating a
    // re-report of a batch the host is still HOLDING as if it had been cleared.
    // The panel destroys its own attachment just by re-announcing it, which it
    // does on every route change and every remount.
    name: 'a re-report of a held batch destroys it',
    script: 'check-repeat-guard.mjs',
    mutate: 'report-poisons-itself',
    expect: /identical re-report|still there|stale/i,
  },
  {
    // Answering the poll with a count and no entries. A remounted sidebar has
    // nothing to adopt, so it renders empty while the capsule goes on counting.
    name: 'the poll hides the held entries',
    script: 'check-repeat-guard.mjs',
    mutate: 'pending-hides-held-list',
    expect: /entries themselves|both of them|hand/i,
  },
  {
    // Listing a port that 404s at every path. The reader sees a service in the
    // list and lands on "not found" when they open it.
    name: 'a port with nothing to open is offered',
    script: 'check-stacks.mjs',
    mutate: 'list-404-ports',
    expect: /nothing to open|NOT offered/i,
  },
  {
    // The mark colour reverting on the next load. The picker works for the current
    // session, so only a reload reveals it.
    name: 'the accent is not persisted',
    script: 'check-accent.mjs',
    mutate: 'accent-not-persisted',
    expect: /survives a reload|stored/i,
  },
  {
    // The shell follows the variable but every mark in the page stays default.
    name: 'the accent never reaches the page',
    script: 'check-accent.mjs',
    mutate: 'accent-not-sent-to-page',
    expect: /open request sends the accent|CURRENT value/i,
  },
  {
    // The client's string reaching the stylesheet unchecked.
    name: 'the accent is not validated',
    script: 'check-accent.mjs',
    mutate: 'accent-unvalidated',
    expect: /validates the accent|normaliseAccent/i,
  },
  {
    // The first fault the reader reported: the transcript showing through the pill.
    name: 'the capsule goes translucent again',
    script: 'check-accent.mjs',
    mutate: 'capsule-transparent-again',
    expect: /opaque theme surface|nothing shows through/i,
  },
  {
    // The over-correction I actually shipped: opaque but colourless.
    name: 'the capsule loses its colour',
    script: 'check-accent.mjs',
    mutate: 'capsule-colourless-again',
    expect: /not a plain white pill|accent is layered/i,
  },
  {
    // Contrast silently varying with the chosen preset.
    name: 'the ink lightness follows the preset',
    script: 'check-accent.mjs',
    mutate: 'ink-lightness-derived-from-preset',
    expect: /ink lightness is fixed|does not vary/i,
  },
  {
    // The bug that actually shipped: variables defined where the capsule cannot
    // see them, so the colour silently disappears.
    name: 'the accent variables are out of scope',
    script: 'check-accent.mjs',
    mutate: 'accent-vars-out-of-scope',
    expect: /defined on :root|do not resolve|wrapper/i,
  },
  {
    // A backtick in the stylesheet prose, which breaks the bundle outright.
    name: 'a backtick breaks the stylesheet literal',
    script: 'check-accent.mjs',
    mutate: 'backtick-in-stylesheet',
    expect: /terminates|stray backtick|SyntaxError/i,
  },
  {
    // THE REPORTED FAULT: two pages, one mark each, and both pins read 1 while the
    // panel read 1 and 2. Numbering across the session cannot be reconciled with a
    // page, which only ever sees its own marks, so the two surfaces must group and
    // number per page instead.
    name: 'pins number across pages instead of within one',
    script: 'check-overlay.mjs',
    mutate: 'pins-numbered-across-pages',
    expect: /own page's row number|same number/i,
  },
  {
    // The pins lost every click: the layer disables pointer events and a descendant
    // cannot opt back in across an ancestor that said no.
    name: 'the pins stop being clickable',
    script: 'check-layout.mjs',
    mutate: 'pins-not-clickable',
    expect: /pin container has a class|re-enables them/i,
  },
  {
    // The attached list painted under the conversation instead of over it.
    name: 'the attached list goes back under the chat',
    script: 'check-layout.mjs',
    mutate: 'list-under-the-conversation',
    expect: /positioned against the viewport|above the shell chrome/i,
  },
  {
    // A second detect control beside "Open".
    name: 'discovery has two entry points again',
    script: 'check-layout.mjs',
    mutate: 'detect-has-two-entry-points',
    expect: /no longer offers a second detect button/i,
  },
  {
    // The reported regression: the capsule stayed for the whole reply because the
    // release waited for the turn boundary.
    name: 'the batch waits for turn/end instead of delivery',
    script: 'check-delivery-order.mjs',
    mutate: 'batch-released-at-turn-end-only',
    expect: /released immediately|no turn\/end in between/i,
  },
  {
    // The reported regression: "页面上不会显示编号了，但是标注的计数还是在增加的."
    // A selector naming an ancestor resolves uniquely — to the wrong element — so two
    // annotations land on one container and a number is never drawn.
    name: 'the selector names an ancestor instead of the element',
    script: 'check-selector-target.mjs',
    mutate: 'selector-names-an-ancestor',
    expect: /lands on the element|resolve back to|different selectors/i,
  },
  {
    name: 'a shared data-testid is handed out as a selector',
    script: 'check-duplicate-nodes.mjs',
    mutate: 'shared-testid-accepted',
    expect: /shared testid is refused|is unique/i,
  },
  {
    name: 'an ambiguous selector is guessed at instead of matched',
    script: 'check-duplicate-nodes.mjs',
    mutate: 'ambiguous-selector-guessed',
    expect: /second to the second|different places|refused/i,
  },
  {
    name: 'an unplaceable annotation is dropped silently',
    script: 'check-selector-target.mjs',
    mutate: 'unplaced-annotations-silent',
    expect: /announced, not dropped|reported to the panel/i,
  },
  {
    // The reader's exact report, reproduced: a `<b>` inside `.l2` recorded as `.l2`.
    name: 'the path ends at an ancestor instead of the element',
    script: 'check-anchor-shape.mjs',
    mutate: 'path-ends-at-ancestor',
    expect: /resolves to the bold itself|does not resolve to \.l2/i,
  },
  {
    // The model the reader explicitly rejected: one URL, one page. Filing by
    // route means a menu click inside a single-page app empties their list.
    name: 'marks are filed by route, so navigating loses them',
    script: 'check-route-key.mjs',
    mutate: 'bucket-keyed-by-route',
    expect: /session bucket|landed in the session/i,
  },
  {
    // The subtler half: the bucket is right, but navigating narrows what is
    // ATTACHED rather than only what is drawn — so the capsule loses marks too.
    name: 'navigation drops the attachment instead of the pins',
    script: 'check-route-key.mjs',
    mutate: 'attachment-scoped-to-route',
    expect: /STILL attached|keeps the attachment/i,
  },
  {
    // Reconciling the unplaceable count against the whole session, which reports
    // a reader's other pages as "the page moved under them".
    name: 'marks on other pages are counted as unplaceable',
    script: 'check-selector-target.mjs',
    mutate: 'unplaced-counts-other-routes',
    expect: /total for this route|reconciled/i,
  },
  {
    // Repeating the route on every element. Harmless-looking, but it spends tokens
    // on every single message to say what the address bar already shows.
    name: 'the route is named even when there is only one',
    script: 'check-block.mjs',
    mutate: 'page-always-nested',
    expect: /single-route list carries no page line|no page line|numbers its own elements from 1/i,
  },
  {
    // THE REPORTED FAULT, on the list the reader reads the numbers from: the panel
    // numbered the whole session while each page could only number itself.
    name: 'the popup numbers across pages instead of within each page',
    script: 'check-count-popup.mjs',
    mutate: 'popup-blind-to-page',
    expect: /heading per page|restart within each page|run through the session/i,
  },
  {
    // The third surface: the block the model receives is numbered by the order the
    // panel sends, so sending arrival order makes `## Element 2` name an element
    // the reader sees as 1. The reader and the model then act on different things.
    name: 'the block is numbered in arrival order, not the panel order',
    script: 'check-report-map.mjs',
    mutate: 'report-in-arrival-order',
    expect: /ordered by the panel|reported first|renumbering its neighbours/i,
  },
  {
    // Pins numbered in creation order while the panel lists by page position:
    // pin `1` and row `1` end up being different elements.
    name: 'pins are numbered in creation order, not the panel order',
    script: 'check-overlay.mjs',
    mutate: 'pins-numbered-by-creation-order',
    expect: /names the element row .* lists|panel row number/i,
  },
  {
    // The reported bug: scrolling a mark out of view raised "cannot locate this
    // mark on the page", and scrolling back cleared it.
    name: 'scrolling out of view is reported as unlocatable',
    script: 'check-overlay.mjs',
    mutate: 'offscreen-counts-as-unlocatable',
    expect: /scrolling an element out of view|out of view raises no warning/i,
  },
  {
    // Seeding the address bar's expanded state from `preview`, which on a remount
    // is null on the first render — so the compact chip never comes back after a
    // tab switch and the reader cannot see which route they are on.
    name: 'the address bar stays expanded after a remount',
    script: 'check-sidebar-crash.mjs',
    mutate: 'openbar-stuck-expanded',
    expect: /chip shows the route|never appeared|expanded/i,
  },
  {
    // The reader's original complaint: the chip showed only the proxy's port.
    name: 'the address chip shows the port and not the route',
    script: 'check-address-chip.mjs',
    mutate: 'chip-shows-port-only',
    expect: /not the proxy port|whole route|two hash routes/i,
  },
  {
    // Wrapping `pushState` but not `replaceState`, which also fires no event.
    name: 'replaceState navigates without being noticed',
    script: 'check-route-key.mjs',
    mutate: 'replace-state-unwrapped',
    expect: /replaceState was noticed|replaceState/i,
  },
  {
    // Clearing the turn guard as part of the release, which re-opens the door to a
    // second copy within the same turn — the fault that guard exists to close.
    // Defined in `mutate.mjs` since early on but never injected by a case here, so
    // the badge counted it while nothing proved it was caught.
    name: 'the release clears its own turn guard',
    script: 'check-repeat-guard.mjs',
    mutate: 'release-keeps-no-turn-guard',
    expect: /turn|guard|twice|duplicate/i,
  },
  {
    // Dropping the re-render from the viewport change. The pin for an element that
    // can no longer be anchored then stays on the page, pointing at whatever now
    // occupies its old coordinates.
    name: 'a viewport change does not re-render the pins',
    script: 'check-overlay.mjs',
    mutate: 'pins-not-renumbered-on-scroll',
    expect: /not merely renumbered|detached element/i,
  },
  {
    // Clipping the tail instead of the head, which reinstates the same complaint
    // in CSS: every view of an app shows an identical prefix.
    name: 'the address chip truncates the route away',
    script: 'check-address-chip.mjs',
    mutate: 'chip-truncates-from-the-right',
    expect: /truncated from the left|ellipsis/i,
  },
  {
    // The real accident: a splice script matched the wrong closing brace and replaced
    // the first ~600 lines of `client.js`. The file still parsed, still had every
    // component, and still contained the strings the other checks look for — twelve
    // of fourteen tests went on passing. This is the case that must never be silent.
    name: 'the client bundle loses its head',
    script: 'check-structure.mjs',
    apply: (dir) => {
      const p = join(dir, 'client.js')
      const lines = readFileSync(p, 'utf8').split('\n')
      writeFileSync(p, [
        '    const STACK_MARKS = {',
        "      react: { color: '#61dafb', path: 'M12' },",
        '    }',
        '',
        ...lines.slice(616),
      ].join('\n'))
    },
    expect: /truncated|file header|module wrapper|braces balance/i,
  },
  {
    // The gate that keeps the preview proxy from becoming a way to reach anything the
    // host can reach. Opening it up is a security regression, not a behaviour change.
    name: 'every preview target is allowed',
    script: 'check-target-gate.mjs',
    apply: (dir) => {
      const p = join(dir, 'lib', 'index.js')
      const src = readFileSync(p, 'utf8')
      writeFileSync(p, src.replace('if (allowRemote) return true', 'if (true) return true'))
    },
    expect: /refused by default|reachable by default/i,
  },
  {
    // The README once claimed the plugin could not annotate online sites, while
    // `allowRemote` would in fact happily fetch any host. Documentation drifting away
    // from a security control is its own class of bug — nobody notices, because
    // nothing connects the sentence to the function.
    name: 'the README denies a feature that exists',
    script: 'check-target-gate.mjs',
    apply: (dir) => {
      const p = join(dir, 'README.md')
      const src = readFileSync(p, 'utf8')
      writeFileSync(p, src.replace('计划在后续版本开放', '这个插件做不了，因为它跑在 DSH 里面'))
    },
    expect: /cannot annotate online sites|做不了/i,
  },
  {
    // Reading a field value with a lazy match that stops at the first space. Every
    // descendant combinator — the commonest positional selector the overlay emits —
    // is then truncated to its first segment, so the chip names an element the
    // reader never marked. Silent: the chip still renders, just wrongly.
    name: 'the chip truncates a selector at its first space',
    script: 'check-chip.mjs',
    mutate: 'chip-reads-a-line-short',
    expect: /selector survives|round trip|positional selector/i,
  },
  {
    // Claiming every plugin-sourced message instead of only this plugin's own
    // delivery. The Definition then paints a chip under other plugins' context
    // rows, which carry no annotations at all.
    name: 'the chip claims other plugins\' messages',
    script: 'check-chip.mjs',
    mutate: 'chip-matches-reader-text',
    expect: /another plugin's message does not|plugin/i,
  },
  {
    // Locating the chip inside a Turn rather than leaving it unresolved. Compact
    // mode — on by default — then folds it into the collapsed process block, so the
    // chip vanishes behind "process" for exactly the messages that carry marks, and
    // the host's own process disclosure changes with it.
    name: 'the chip is placed inside the turn, where compact mode folds it away',
    script: 'check-chip.mjs',
    mutate: 'chip-located-in-turn',
    expect: /unresolved|fold/i,
  },
  {
    // Anchoring after the delivery message instead of half a seq before it, which
    // drops the chip below the context row rather than under the reader's bubble —
    // the placement that was actually asked for.
    name: 'the chip sorts below the context row instead of under the bubble',
    script: 'check-chip.mjs',
    mutate: 'chip-before-reader-bubble',
    expect: /just after the reader|anchorSeq|bubble/i,
  },
  {
    // Registering the Definition without its renderer seat. The shell does not leave
    // an unoccupied kind blank — it renders its own JSON fallback — so the chip
    // becomes a visible data dump in the reader's transcript.
    name: 'the chip has no renderer for its node kind',
    script: 'check-chip.mjs',
    mutate: 'chip-registers-ahead-of-its-seat',
    expect: /seat|renderer/i,
  },
  {
    // Letting the registry's duplicate-kind throw escape `apply`. Activation is
    // shared with the sidebar, the tab and the capsule, so this is the failure mode
    // the reader knows best: restart DSH, get an error, and the whole plugin is gone.
    name: 'the chip registration throws and takes activation down',
    script: 'check-chip.mjs',
    mutate: 'chip-registration-throws',
    expect: /wrapped in a try|degrades/i,
  },
  {
    // The block heading reappearing inside the composer capsule. That is the original
    // regression — the reader seeing model-facing text as their own draft.
    name: 'the composer capsule renders the model-facing block',
    script: 'check-context.mjs',
    mutate: 'chip-capsule-renders-the-block',
    expect: /capsule never renders|capsule/i,
  },
  {
    // THE BUG THE READER HIT, pinned as a case. Reading `uiConversation` once during
    // `apply` and branching on that sample, rather than waiting for it. The service
    // is provided by another row and rows apply concurrently, so the sample is
    // `undefined` whenever that row is merely slower: the chip never registers and
    // nothing is logged as an error. The tab and the capsule keep working, so it
    // reads as a missing feature instead of a race.
    //
    // Worth its own case precisely because the rest of the suite passed while this
    // was live — the assertions looked for `registerChipDefinition` appearing in
    // `apply`, which it did, right up until the branch that reached it was skipped.
    name: 'the chip samples the conversation service before it exists',
    script: 'check-chip.mjs',
    mutate: 'chip-samples-the-service-too-early',
    expect: /not sampled|waited for|race/i,
  },
  {
    // Letting a late answer overwrite a newer one. The capsule polls on a clock and
    // `fetch` does not answer on one, so the poll after a send and a straggler from
    // before it can both be in flight and the stale one can land last — writing the
    // pre-send count back over the cleared one. The reader reported exactly this:
    // the capsule staying up after a message had already gone out.
    name: 'a slow poll answer overwrites a newer one',
    script: 'check-capsule.mjs',
    mutate: 'capsule-late-answer-wins',
    expect: /older answer is dropped|dropped rather than/i,
  },
  {
    // Counting the raw entries while listing only the renderable ones, so the chip
    // reads `×3` above a list of two. Found by the DOM check on its first run, and
    // worth a case of its own: it is invisible to every source-level assertion,
    // because the number and the list are each individually well formed.
    name: 'the chip counts marks it cannot show',
    script: 'check-chip-dom.mjs',
    mutate: 'chip-counts-what-it-cannot-show',
    expect: /draws nothing|nothing at all/i,
  },
  {
    // Reported from a real session: a mark could be deleted and it came straight
    // back, and after a send the sidebar kept its list while the capsule kept its
    // count. Emptying the panel's list without emptying its mirror of what the
    // host holds makes the purge look like a rebuilt preview, so the restore path
    // hands every released mark back to the page and the host is given the batch
    // again.
    name: 'a released batch is resurrected from a stale mirror',
    script: 'check-chip.mjs',
    mutate: 'release-leaves-the-mirror-stale',
    expect: /empties the host mirror|mirror/i,
  },
  {
    // Taking the epoch just observed as the baseline every time, which is what a
    // ref inside the capsule does. The dock is remounted whenever the composer is,
    // so a clear that happened while it was away is never announced and the panel
    // uploads marks the host has already let go of.
    name: 'a clear is missed because the epoch was forgotten',
    script: 'check-chip.mjs',
    mutate: 'epoch-forgotten-across-a-remount',
    expect: /read back rather than started fresh|outside the component|epoch/i,
  },
  {
    // Aligning the chip to the left edge of its own flow row, which is the column's
    // edge rather than the bubble's. Reported from a real session with a
    // screenshot: the chip rendered at the far side of the transcript.
    name: 'the chip aligns to the column instead of the bubble',
    script: 'check-chip-dom.mjs',
    mutate: 'chip-aligns-to-the-column-not-the-bubble',
    expect: /aligns to the right edge|under the bubble|left edge/i,
  },
  {
    // Indenting by the bubble's width instead of by the column minus the bubble's.
    // The two differ by exactly the bubble's width, so the chip lands short of the
    // bubble's left edge — the same mis-placement the reader reported, reached by
    // arithmetic rather than by a CSS keyword. Needs layout to see at all, so it is
    // only reachable because the arithmetic was split into a pure function.
    name: 'the chip indent forgets to subtract the bubble',
    script: 'check-chip.mjs',
    mutate: 'chip-indent-forgets-the-bubble-width',
    expect: /indented by the difference|difference/i,
  },
  {
    // Emitting the offset inline while leaving the row end-aligned, so the padding
    // only narrows the content box and the chip never moves. The DOM looks right and
    // the number is right; the chip is still on the wrong side.
    name: 'the chip indent moves nothing because the mode is missing',
    script: 'check-chip.mjs',
    mutate: 'chip-indent-emits-padding-without-the-alignment',
    expect: /indent mode|switches the row/i,
  },
  {
    // Measuring the message as the row's own sibling, when the occupant is rendered
    // INSIDE the wrapper the shell puts around each transcript node — so the row has
    // no sibling at all and the placement silently never happens. Silent is the point:
    // the fallback it degrades to looks deliberate.
    name: 'the chip measures the wrong element for its anchor',
    script: 'check-chip-dom.mjs',
    mutate: 'chip-measures-the-wrong-sibling',
    expect: /seat is found from the row|anchor|shell's own hook/i,
  },
  {
    // Keeping the count and dropping the entries. The shipped state: the pill said
    // "3 attached" and the reader could not see which three, even though the host had
    // been answering with them all along.
    name: 'the capsule forgets what it is counting',
    script: 'check-capsule.mjs',
    mutate: 'capsule-forgets-what-it-holds',
    expect: /note is shown once opened|every mark is listed|selector/i,
  },
  {
    // Keeping a longer list when the answer gets shorter, so the pill counts one batch
    // while the rows under it describe another. Undetectable by looking: both halves
    // are plausible and the stale rows were genuinely attached a moment ago.
    name: 'the capsule list outlives the batch it describes',
    script: 'check-capsule.mjs',
    mutate: 'capsule-list-only-ever-grows',
    expect: /open list, from the same answer|no longer holds|surviving mark/i,
  },
  {
    // Reported from a real session: the 删除 button on the card did nothing. It was
    // not a dead handler — the page removed the mark and said so, and the panel read
    // that empty answer as a page that had lost its storage and handed the mark
    // straight back. Only the LAST mark was affected, which is what made it look
    // intermittent rather than like a rule.
    name: 'an empty report resurrects the mark just deleted',
    script: 'check-delete-stickiness.mjs',
    mutate: 'an-empty-report-resurrects-the-batch',
    expect: /empty list is believed|stays deleted|handed back/i,
  },
  {
    // Treating the document element as something to annotate. `elementFromPoint`
    // returns `<html>` wherever the page has no content under the cursor, so the
    // frame outlines the whole document — which the reader reported as the entire
    // page looking selected when they moved the pointer off the sidebar to type.
    name: 'the page itself counts as an element to mark',
    script: 'check-overlay.mjs',
    mutate: 'page-itself-counts-as-a-target',
    expect: /document element frames nothing|empty space|body counts/i,
  },
  {
    // Leaving the highlight behind when the pointer leaves the preview. No
    // `mousemove` follows it out, so without an explicit `mouseleave` the last
    // element stays framed and named while the reader is typing in the composer.
    name: 'the highlight survives the pointer leaving the page',
    script: 'check-overlay.mjs',
    mutate: 'hover-survives-leaving-the-preview',
    expect: /leaving the preview drops the highlight|readout goes with it/i,
  },
  {
    // Opening a mark for editing without dismissing the dialog, so the card opens
    // underneath a list that is still on screen. Reported with a screenshot: the
    // reader pressed ✎ and the card was there, but so was everything else.
    name: 'editing a mark leaves the list on top of it',
    script: 'check-count-popup.mjs',
    mutate: 'edit-leaves-the-list-on-top',
    expect: /closes the dialog|not covered/i,
  },
  {
    // Putting the dialog back to one scrolling column, so a long list pushes the bulk
    // clear below the fold. The reader asked for a bulk clear believing there was
    // none — there was, and this is why they could not find it. Caught at the CSS
    // level: jsdom has no layout, so only the rule says which element scrolls.
    name: 'the bulk clear scrolls out of the dialog',
    script: 'check-layout.mjs',
    mutate: 'clear-all-scrolls-out-of-reach',
    expect: /clips and lays out as a column|list above the bar|LIST scrolls/i,
  },
  {
    // Naming the preview server `localhost` while the harness answers on 127.0.0.1.
    // Those are different SITES, so a browser refuses the app's own `SameSite=Lax`
    // session cookie inside the frame: the login POST is delivered, the 302 comes
    // back, and the redirect arrives anonymous. Every server-side check still passes,
    // because the rule being broken is the browser's — which is why it survived.
    name: 'the preview frame is cross-site with the harness',
    script: 'check-preview-login.mjs',
    mutate: 'preview-frame-is-cross-site',
    expect: /same-site|127\.0\.0\.1|share one preview/i,
  },
  {
    // Clicking the address chip with a page already open. The input is bound to
    // `url`, which only typing ever writes — so a page opened by discovery, by the
    // page list, or by the remount that reopens the remembered page left it at `''`
    // and the control that shows you where you are opened BLANK. The mutation drops
    // the seed; the input still renders and still works, so only an assertion that
    // reads its value can see it.
    name: 'the address bar opens blank instead of the current address',
    script: 'check-sidebar-crash.mjs',
    mutate: 'address-bar-opens-blank',
    expect: /seeded with the address|left blank|value was ""/i,
  },
  {
    // The host REUSES a preview for a target it already has and answers with the sid
    // it already had. Falling through that branch instead of returning adds a SECOND
    // tab for one page: two iframes on one preview, and that page's marks split
    // between two owners. Nothing crashes and the extra tab looks plausible, which is
    // why only an assertion about the branch's own shape catches it.
    name: 'a page the host already has open is opened a second time',
    script: 'check-tabs.mjs',
    mutate: 'reused-preview-opened-twice',
    expect: /reuse branch returns|opened twice|second entry/i,
  },
  {
    // Closing a page is not a decision to discard what was written on it. The
    // mutation stops parking the marks before the tab goes, so everything the reader
    // wrote on that page quietly stops being counted and stops being sent — the tab
    // closes cleanly and the loss is only visible in the numbers.
    name: 'closing a page silently drops the marks made on it',
    script: 'check-tabs.mjs',
    mutate: 'closed-page-marks-dropped',
    expect: /parked rather than dropped|closed page/i,
  },
  {
    // The one that got through: every source-level assertion about tabs passed while
    // the feature was broken. `tabs` state only changes on the next render, so two
    // pages opened in one tick both read the same stale list and the second silently
    // dropped the first. Only rendering the panel and counting the tabs sees it.
    name: 'two pages opened in one tick collapse into one',
    script: 'check-tabs-dom.mjs',
    mutate: 'tabs-state-not-written-through',
    expect: /both remembered pages come back as tabs|2 tab\(s\)|come back as tabs/i,
  },
  {
    // The reader's report after the tab strip shipped: "there is only one address bar,
    // I have no way to open a second page at all". The host keyed preview identity on
    // `URL.origin`, which drops the path, so two pages of one app were one preview and
    // the second request handed back the first one's sid. The panel then did the right
    // thing with the wrong input and showed one tab. Nothing throws, nothing looks
    // broken — only a check that drives the caller's own expression sees it.
    name: 'two pages of one app collapse into one preview',
    script: 'check-preview-reuse.mjs',
    mutate: 'preview-key-drops-the-path',
    expect: /SAME app does not reuse|full href/i,
  },
  {
    // The other half of the same report, and the reason the reader could not even try:
    // the strip only drew from two pages up, so with one page open there was no "+" to
    // press. The feature was unreachable by construction until the strip rendered at
    // one page, which only a render check can see.
    name: 'the strip that opens a second page is hidden until there is one',
    script: 'check-tabs-dom.mjs',
    mutate: 'tab-strip-hidden-until-two',
    expect: /strip renders with a single page|strip is present from the start|new page.*reachable/i,
  },
  {
    // The "+" is present and clickable but never opens the address bar, so the control
    // the reader just found does nothing when they press it. Present in the DOM either
    // way, so only an assertion about the bar appearing behind it catches this.
    name: 'the new-page button does not open the address bar',
    script: 'check-tabs-dom.mjs',
    mutate: 'tab-new-button-does-nothing',
    expect: /opens an address bar|address bar/i,
  },
  {
    // The "+" that adds no tab, which is the reader's own report: pressing it emptied
    // the address bar and nothing appeared in the strip, so a new page and an edit of
    // the current one were the same picture. The page still opens on Enter, so only an
    // assertion about the drawn tab catches it.
    name: 'the new-page button opens no blank tab',
    script: 'check-tabs.mjs',
    mutate: 'tab-new-button-opens-no-blank-tab',
    expect: /draft|blank tab|new-page button sets/i,
  },
  {
    // The same report, arriving a second time on the other kind of address. This is the
    // case that was still live when the reader said "still only one tab": the URL arm had
    // been fixed to the full href, but the FILE arm still keyed on `file://${fileRoot}` —
    // the folder, not the page. Two workspace pages saved side by side shared one preview,
    // so the second open returned the first one's sid and the panel switched to it. Green
    // on every source check, and green in jsdom, because neither one opens a real file.
    name: 'two workspace pages in one directory collapse into one preview',
    script: 'check-preview-reuse.mjs',
    mutate: 'file-preview-key-uses-the-directory',
    expect: /SAME directory does not reuse|keys on the FILE/i,
  },
  {
    // Reported after a send with two pages open: "发送出去后胶囊又没有正确的消失，侧边标注栏
    // 里的也没有正确处理". The purge was sent with no sid, and that form aims at the page on
    // screen alone — so the background tab kept its marks, and since the list is the
    // flattened union of every page, its next report rebuilt the batch that had just been
    // released. Only a check that both clears and then re-derives the list sees it, because
    // a single-page session is indistinguishable from a correct one.
    name: 'clearing the marks only reaches the page on screen',
    script: 'check-chip.mjs',
    mutate: 'purge-only-reaches-the-page-on-screen',
    expect: /sweeps every open page|sid-less purge|background/i,
  },
  {
    // The same fault's other half, and the one that bites hardest with one page open:
    // the pages are emptied but the panel's per-page mirror is not, so the mirror wins by
    // arriving second and puts every released mark back. The reader deletes the last mark
    // and watches the list refill.
    name: 'the per-page mirror survives a clear and resurrects the batch',
    script: 'check-chip.mjs',
    mutate: 'clear-forgets-the-pages-but-not-the-mirror',
    expect: /per-page mirror is emptied|re-derives|mirror/i,
  },
  {
    // The layout the reader rejected, drawn to scale in their screenshot: they circled the
    // empty slab beside the toolbar buttons and wrote "此处已为空". The address bar was a
    // sibling row BELOW the tab strip, so the tabs and the address read as one unit while
    // the toolbar kept a hole. Every control still works in the old arrangement, and the
    // strip and the bar are both present either way — only the NESTING differs, so it takes
    // a structural or a rendered assertion to see it. Both are in the case.
    name: 'the address bar goes back to being a row of its own under the tabs',
    script: 'check-tabs-dom.mjs',
    mutate: 'address-bar-is-a-row-of-its-own-below-the-tabs',
    expect: /contained by the toolbar|siblings, in different rows|spacer/i,
  },
  {
    // Reported from a real session: "胶囊和顶上的那个'附加到下一次对话'都是正常清除的，
    // 但是页面内的那个气泡没有清除". The clear emptied the page's store and saved it, and both
    // surfaces the PANEL owns went blank — but the numbered bubbles are drawn by
    // `renderPins()`, which runs only from `render()`. The reader was therefore told the
    // marks were gone while still looking at them, and a pin opened a card for a mark
    // that no longer existed. Nothing throws, which is why it takes an assertion about
    // this case's own body rather than about how the code behaves elsewhere.
    name: 'clearing the marks empties the store but leaves the bubbles on the page',
    script: 'check-interaction.mjs',
    mutate: 'purge-empties-the-store-but-not-the-page',
    expect: /redraws the page|bubbles outlive/i,
  },
  {
    // The reader's other report this round: "不同的标签页之前并不是共享'选取'状态的
    // 每个页面都是独立的". Marking lived on the per-page record and was sent to the active
    // page alone, so turning it on and switching tab showed it off again while the first
    // page was still capturing clicks — a control that looks one way and behaves another.
    name: 'marking mode belongs to one page instead of the whole panel',
    script: 'check-tabs.mjs',
    mutate: 'marking-mode-is-private-to-one-page',
    expect: /broadcast to EVERY open page/i,
  },
]

let good = 0
let bad = 0
for (const testCase of cases) {
  const dir = mutate(testCase.name, (target) => {
    if (testCase.mutate !== undefined) {
      // Applied by a script rather than an inline replacement: PowerShell mangles
      // the quoting in `node -e` badly enough that a mutation can silently fail to
      // apply, and a mutation that never happened looks exactly like a test that
      // cannot catch it.
      const out = execFileSync(process.execPath, [join(SOURCE, 'scripts', 'mutate.mjs'), target, testCase.mutate], {
        encoding: 'utf8',
      })
      if (!/applied/.test(out)) throw new Error(`mutation did not apply: ${out}`)
    } else {
      testCase.apply(target)
    }
  })
  const result = runPreflight(dir, testCase.script)
  const detected = !result.passed
  if (detected) {
    const matched = testCase.expect.test(result.out)
    console.log(`  ok   detected "${testCase.name}"${matched ? '' : ' (but not by the expected check)'}`)
    good += 1
  } else {
    console.log(`  MISS "${testCase.name}" was NOT detected — the preflight has a blind spot`)
    bad += 1
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\ndetected ${good}/${cases.length} injected faults`)
if (bad) {
  console.log('The preflight is weaker than it claims; do not treat a pass as proof.')
  process.exit(1)
}
console.log('MUTATION CHECK PASSED — every injected fault was caught')
