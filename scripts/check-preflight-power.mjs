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
    // The reported fault: pin numbers skipping because an unplaceable pin still
    // consumed its number.
    name: 'pins are numbered by list position',
    script: 'check-overlay.mjs',
    mutate: 'pins-number-by-list-index',
    expect: /gap in the middle does not leave a gap|gapless|no number is skipped/i,
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
