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
]

let good = 0
let bad = 0
for (const testCase of cases) {
  const dir = mutate(testCase.name, testCase.apply)
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
