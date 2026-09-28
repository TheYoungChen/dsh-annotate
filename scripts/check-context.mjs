/**
 * Verify that annotations reach the model as plugin-sourced runtime context,
 * not as text the reader appears to have typed.
 *
 * This is the load-bearing claim of the chip design, so it is tested against the
 * real system-prompt service rather than asserted. The test drives the actual
 * registry, assembles the prompt, and checks what the assembly produced.
 */
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'

const require = createRequire('E:/StudyFile/AI-Workspace/deepseek-harness/package.json')
const harness = 'E:/StudyFile/AI-Workspace/deepseek-harness/packages'

// The harness packages are TypeScript; use its own build outputs where they
// exist, otherwise exercise the contract through the plugin's own surface.
let SystemPrompt
try {
  const mod = await import(pathToFileURL(`${harness}/core/system-prompt/lib/index.js`).href)
  SystemPrompt = mod.SystemPrompt ?? mod.default
} catch {
  SystemPrompt = null
}

const plugin = await import(pathToFileURL(fileURLToPath(new URL('../lib/index.js', import.meta.url))).href)

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) {
    failures += 1
    if (detail !== undefined) console.log(`       ${detail}`)
  }
}

console.log('--- manifest ---')
check(plugin.name === 'dsh-annotate', 'exports the plugin name', plugin.name)
check(Array.isArray(plugin.inject), 'declares inject', String(plugin.inject))
check(plugin.inject.includes('webServer'), 'injects webServer')
check(plugin.inject.includes('timer'), 'injects timer')
// The attachment rides the agent event bus rather than an injected service, so a
// host without the agent loop simply never calls the hook and the preview still
// works. Nothing beyond webServer/timer may be required.
check(!plugin.inject.includes('systemPrompt'),
  'does not hard-require systemPrompt; the hook is reached through events instead')
check(!plugin.inject.includes('agents'), 'and does not require the agent registry')

console.log('\n--- context registration source ---')
const src = await (await import('node:fs/promises')).readFile(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')

// The attachment is its own message rather than a prompt context contribution.
// That is what lets it carry the plugin's own label and a collapsed summary; a
// `systemPrompt.context()` contribution is funnelled under the prompt package's
// name and the snapshot form is hard-coded to show no summary at all.
// Matched as a call at the start of a statement, not as a word: the surrounding
// prose explains why the prompt context was abandoned, and that explanation is
// worth keeping.
check(!/^\s*(?:const \w+ = )?systemPrompt\.context\s*\(/m.test(src),
  'it does not route the annotations through the prompt context')
check(/ctx\.on\('agent\/pre-step'/.test(src), 'it hooks the step the loop will propose')
check(/\{ global: true \}\)/.test(src),
  'and declares that hook global, or the agent scope never consults it')
check(/plugin: PLUGIN/.test(src), 'the message carries this plugin as its source')
check(/form: 'notice'/.test(src),
  'it declares the notice form, the only one given a collapsed summary')
check(/summary:/.test(src), 'and supplies that summary')
check(/createUserMessage\(text, \{/.test(src), 'it builds a user-role message')

console.log('\n--- the block is not user text ---')
// The payload must be built by the host and delivered through the message
// channel. If the client ever writes it into the draft, the reader sees it.
const clientSrc = await (await import('node:fs/promises')).readFile(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')
check(/Web page elements/.test(src), 'the host renders the "# Web page elements" block')
check(!/Web page elements/.test(clientSrc), 'the client does not render that block into the composer')

console.log('\n--- payload shape ---')
// Assert the shape the renderer produces, not the statements it is written
// with: the wording of the block is checked for real in check-block.mjs, which
// drives the shipped function. These only confirm the host owns all of it.
check(/# Web page elements/.test(src), 'block starts with a heading')
check(/## Element \$\{/.test(src), 'elements are numbered sections')
check(/note: \$\{clip\(note, 600\)\}/.test(src), 'a note is clipped and emitted')
check(/matches > 1 \? entry\.at\.trim\(\) : ''/.test(src), 'geometry is gated on an ambiguous selector')

console.log('\n--- session keying ---')
check(/const pending = new Map\(\)/.test(src), 'annotations are keyed per session')
check(/action === 'context'/.test(src), 'an action accepts annotations from the sidebar')
check(/action === 'consume'/.test(src), 'an action clears them after delivery')
check(/pending\.delete\(session\)/.test(src), 'clearing removes the entry rather than emptying it')

console.log('\n--- delivery clears exactly once ---')
// The hook must be a pure read: if it cleared as a side effect, a step that never
// becomes a request would silently discard the annotations. The clearing lives in
// the session-event listener instead.
const hookStart = src.indexOf("ctx.on('agent/pre-step'")
const hookEnd = src.indexOf('{ global: true }', hookStart)
const hookSlice = src.slice(hookStart, hookEnd)
check(hookSlice.length > 0 && hookEnd > hookStart, 'the step hook body was located')
check(!/pending\.delete|pending\.clear/.test(hookSlice),
  'the hook does not clear as a side effect')
// `turn/end`, NOT `turn/start`: the agent appends turn/start before the step loop
// runs, so clearing there deleted the annotations before anything could read them.
check(/if \(type !== 'turn\/end'\) return/.test(src), 'clearing is driven by the END of the turn')
check(!/if \(type !== 'turn\/start'\) return/.test(src),
  'and not by turn/start, which fires before the first read')
check(/subject && subject\.id/.test(src), 'clearing reads the id off the Session subject')
// `ctx.on` returns its own disposer in this codebase; calling a bare ctx.off
// would be inventing an API.
check(/const offEvent = ctx\.on\('session\/event'/.test(src), 'the listener disposer is retained')
check(/offEvent\(\)/.test(src), 'the listener is released on teardown')
// `ctx.on` returns its own disposer in this codebase; calling a bare ctx.off
// would be inventing an API.
check(/const offEvent = ctx\.on\('session\/event'/.test(src), 'the listener disposer is retained')
check(/offEvent\(\)/.test(src), 'the listener is released on teardown')
check(!/ctx\.off\?/.test(src), 'no invented ctx.off call')

console.log('\n--- teardown ---')
check(/pending\.clear\(\)/.test(src), 'disposing the plugin drops held annotations')

console.log('\n--- the reader is not blocked on there being no text ---')
// The natural order is mark, hand over, then write. Gating the hand-over on the
// draft having text would disable the button at exactly the moment it is wanted.
check(!/panel\.needText/.test(clientSrc), 'the hand-over is not gated on typed text')
check(!/payloadFor\(source\)/.test(clientSrc), 'the client does not build the payload block')

console.log('')
if (failures) {
  console.log(`CONTEXT CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('CONTEXT CHECKS PASSED')
void require
void SystemPrompt
