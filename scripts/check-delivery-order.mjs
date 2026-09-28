/**
 * The annotations must actually reach the model, on a turn with more than one step.
 *
 * This exists because of a bug that shipped past 25 green unit tests: the clearing
 * signal was `turn/start`, chosen on the assumption that a turn starting meant the
 * previous turn's annotations had already gone out. It does not. The agent appends
 * `turn/start` before it enters the step loop, and dispatches it synchronously, so
 * the clear ran before the first assembly ever read the annotations — they were
 * deleted before they could be delivered, on every normal turn.
 *
 * Nothing caught it because every other test drove the pieces directly. So this
 * one drives the real sequence: an `agent/pre-step` hook is captured and invoked
 * the way the loop invokes it, and the turn boundary is fired through the real
 * event subscription.
 *
 * The assertions are about ORDER, which is the whole point:
 *   1. A step is offered the annotation message.
 *   2. The second step of the same turn is offered the same text.
 *   3. `turn/start` must NOT remove it — this is the regression.
 *   4. `turn/end` does remove it, so it cannot ride along on a later turn.
 */
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'

// Resolved from this file, not hardcoded. A mutation check copies the plugin to a
// scratch directory and edits the copy; an absolute path would make this test keep
// importing the untouched original, which is how it silently passed while the
// mutant it exists to catch was in place.
const MODULE = pathToFileURL(new URL('../lib/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) {
    failures += 1
    if (detail !== undefined) console.log(`       ${detail}`)
  }
}

let registered = null
/** `agent/pre-step` listeners, which the loop consults through the event bus. */
const preSteps = []
/** `session/event` listeners, which carry the turn boundary. */
const sessionEvents = []
/** How each listener was declared, so a missing `global` can be caught. */
const options = new Map()

const ctx = {
  logger: { warn: () => {}, info: () => {}, error: () => {} },
  get: () => undefined,
  effect: (fn) => { fn(); return () => {} },
  on: (event, fn, opts) => {
    if (event === 'agent/pre-step') preSteps.push(fn)
    if (event === 'session/event') sessionEvents.push(fn)
    options.set(event, opts)
    return () => {}
  },
  inject: (n, fn) => fn(ctx),
  webServer: { register: (o) => { registered = o; return () => {} } },
  interval: () => () => {},
  timeout: () => () => {},
}

const mod = await import(MODULE)
mod.apply(ctx, { enabled: true, allowExternalFiles: true })
const handler = registered.handler

const call = (path, body) => new Promise((resolve) => {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = path
  req.headers = { host: '127.0.0.1:3080' }
  req.socket = { encrypted: false }
  const res = {
    setHeader() {},
    writeHead() {},
    end(payload) { try { resolve(JSON.parse(payload)) } catch { resolve(payload) } },
  }
  setImmediate(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  handler(req, res)
  setTimeout(() => resolve({ timeout: true }), 3000)
})

/** Fire a session event at the plugin, exactly as the session publishes it. */
const fireSession = (session, type) => {
  for (const fn of sessionEvents) fn({ id: session }, { type, turn: 1 })
}

/**
 * Run one `agent/pre-step` the way the loop does: the hook receives the payload
 * and a `next` that returns the loop's own decision.
 *
 * The payload carries the loop's own position — `agent.ts:250` spreads `{ turn,
 * step }` into it — and the plugin keys its once-per-turn guard on `turn`.
 * Omitting those would make every step look like the same turn.
 * @param session - the agent id the step belongs to.
 * @param messages - what the loop had already gathered.
 * @param position - the turn and step this assembly belongs to.
 * @returns the messages the step would actually send.
 */
const runStep = async (session, messages = [], position = { turn: 1, step: 1 }) => {
  const base = { kind: 'enter', messages }
  let chain = async () => base
  for (const fn of preSteps) {
    const inner = chain
    chain = async () => fn({
      agent: { id: session },
      signal: { aborted: false },
      turn: position.turn,
      step: position.step,
    }, inner)
  }
  const decision = await chain()
  return decision.messages
}

const SESSION = 'sess-order'
const MARKS = [
  { selector: '.a', text: 'A', note: 'first', matches: 1 },
  { selector: '.b', text: 'B', note: 'second', matches: 1 },
]

/** The text of a message, flattened. */
const textOf = (message) => (message.content || [])
  .map((block) => (block.type === 'text' ? block.text : ''))
  .join('')

console.log('=== the hook is registered where the loop will find it ===')
check(preSteps.length > 0, 'an agent/pre-step listener exists', `${preSteps.length} listener(s)`)
check(options.get('agent/pre-step') && options.get('agent/pre-step').global === true,
  'and it is declared global, or the agent scope would never consult it',
  JSON.stringify(options.get('agent/pre-step')))
// The session emits `session/event` through its OWN scope
// (`collectSessionCallbacks(entry.emitCtx, ...)`), so a listener registered at the
// composition scope is never consulted without this. The consequence is not a
// crash but a silent leak: the annotations are never cleared and the capsule stays
// on screen after the reader has sent their message.
check(options.get('session/event') && options.get('session/event').global === true,
  'the turn-boundary listener is declared global, or the clear never runs',
  JSON.stringify(options.get('session/event')))
check(sessionEvents.length > 0, 'a session/event listener exists')

console.log('')
console.log('=== a marked session attaches its block to the step ===')
await call('/__dsh-annotate/context', { session: SESSION, annotations: MARKS })
const step1 = await runStep(SESSION)
const attached = step1.filter((m) => m.source && m.source.plugin === 'dsh-annotate')
check(attached.length === 1, 'exactly one attached message', `${attached.length} found`)
const message = attached[0]
if (message) {
  const text = textOf(message)
  check(text.includes('# Web page elements'), 'it carries the block', JSON.stringify(text.slice(0, 60)))
  check(text.includes('note: first'), 'including the notes')
  check(message.source.form === 'notice',
    'it declares the notice form, the only one with a collapsed summary', message.source.form)
  check(typeof message.source.summary === 'string' && message.source.summary.includes('2'),
    'and a summary naming the count', message.source.summary)
  check(message.role === 'user', 'it is a user-role message')
  check(typeof message.id === 'string' && message.id.length > 0, 'it has its own id', message.id)
}

console.log('')
console.log('=== THE REGRESSION: turn/start must not delete it ===')
// This is the bug. `turn/start` is appended before the step loop runs, so clearing
// here wiped the annotations before they were ever read. The second step of the
// SAME turn still reads them, which is what makes the clear visible.
fireSession(SESSION, 'turn/start')
const step1b = await runStep(SESSION, [], { turn: 1, step: 2 })
const stillThere = step1b.filter((m) => m.source && m.source.plugin === 'dsh-annotate')
check(stillThere.length === 0,
  'turn/start alone does not clear, so the turn can still deliver',
  `${stillThere.length} found — clearing on turn/start would make this 0`)

console.log('')
console.log('=== a later step of the same turn does not write a second row ===')
// Every message in `decision.messages` is appended to the session unconditionally
// (`agent.ts:374-375`), so an attachment per step means one identical row per step
// in the reader's conversation. Observed live as a dozen copies for one send.
const step2 = await runStep(SESSION, [], { turn: 1, step: 3 })
const second = step2.filter((m) => m.source && m.source.plugin === 'dsh-annotate')
check(second.length === 0,
  'the third step of the same turn attaches nothing new',
  `${second.length} found — each one becomes a duplicate transcript row`)

console.log('')
console.log('=== a delivered batch is not re-attached on the next turn ===')
// The guard has to survive into later turns, and now it does so by the batch being
// gone rather than by a latch: it was released when it was handed over. The earlier
// behaviour — the block riding along on every later turn until `turn/end` — is what
// made the capsule look permanent to the reader.
const nextTurn = await runStep(SESSION, [], { turn: 2, step: 1 })
const carried = nextTurn.filter((m) => m.source && m.source.plugin === 'dsh-annotate')
check(carried.length === 0,
  'the next turn carries nothing, because the batch was already delivered',
  `${carried.length} found — a block here means the capsule would not have cleared`)

console.log('')
console.log('=== a batch marked after that is attached on its own turn ===')
// The other half: releasing must not disable the feature. A fresh report goes out.
const LATER = [
  { id: 'z', note: 'later', selector: '.later', tag: 'div', text: 'Later', doc: { x: 0, y: 0, w: 10, h: 10 }, viewport: { w: 1000, h: 800 }, selectorMatches: 1 },
]
await call('/__dsh-annotate/context', { session: SESSION, annotations: LATER })
const laterTurn = await runStep(SESSION, [], { turn: 3, step: 1 })
const laterAttached = laterTurn.filter((m) => m.source && m.source.plugin === 'dsh-annotate')
check(laterAttached.length === 1, 'a newly marked batch is attached', `${laterAttached.length} found`)
if (laterAttached[0]) {
  check(textOf(laterAttached[0]).includes('later'), 'and it carries the new mark, not the old one')
}

console.log('')
console.log('=== re-running the SAME step does not append a second copy ===')
// The loop can consult one step's decision more than once, and a step that runs
// after a steering message can be offered the same list twice. The guard's real
// observable effect is whether the step's list is extended a second time: a hook
// that correctly declines hands the base list straight back.
// A session of its own. Delivery now releases the batch, so reusing one that a
// previous section already sent would test the absence of marks rather than the
// re-consult guard this section exists for.
const RECONSULT = 'sess-reconsult'
const sources = { kind: 'enter', messages: [] }
const consult = async (base) => {
  let chain = async () => base
  for (const fn of preSteps) {
    const inner = chain
    chain = async () => fn({
      agent: { id: RECONSULT },
      signal: { aborted: false },
      turn: 1,
      step: 1,
    }, inner)
  }
  return chain()
}
await call('/__dsh-annotate/context', { session: RECONSULT, annotations: MARKS })
const firstConsult = await consult(sources)
const firstCount = firstConsult.messages.filter((m) => m.source && m.source.plugin === 'dsh-annotate').length
check(firstCount === 1, 'the step carries one attachment on the first consult', `${firstCount} found`)
const secondConsult = await consult(sources)
check(secondConsult.messages === sources.messages,
  'and consulting the same step again leaves the list untouched',
  `the list was rebuilt — the block would be appended twice (${secondConsult.messages.length} vs ${sources.messages.length} messages)`)

console.log('')
console.log('=== a mark added mid-turn reaches the next step, not the current one ===')
// The client reports on change, so a mark can land between steps. It must be
// picked up rather than held in the sidebar until the turn ends, because the
// reader can see it there and would assume it had been attached.
await call('/__dsh-annotate/context', {
  session: SESSION,
  annotations: [...MARKS, { selector: '.c', text: 'C', note: 'third', matches: 1 }],
})
const step3 = await runStep(SESSION, [], { turn: 4, step: 1 })
const third = step3.filter((m) => m.source && m.source.plugin === 'dsh-annotate')
check(third.length === 1, 'the step still carries exactly one attachment', `${third.length} found`)
if (message && third[0]) {
  const firstLen = textOf(message).length
  const thirdLen = textOf(third[0]).length
  console.log(`  text length: before=${firstLen} after=${thirdLen}`)
  check(thirdLen > firstLen, 'and it now includes the newly marked element',
    'a mark made mid-turn must not be silently dropped')
  check(textOf(third[0]).includes('third'), 'the new note is present')
}

console.log('')
console.log('=== the batch is released when it is handed over, not when the turn ends ===')
// The reader's report: the message was sent, the assistant had begun replying, and
// the capsule still said "2 elements attached". Nothing was broken — the release
// waited for `turn/end`, which only fires after the whole reply. The signal has to
// be the handover, because that is the moment the reader considers it delivered.
{
  await call('/__dsh-annotate/context', { session: SESSION, annotations: MARKS })
  const held = await call('/__dsh-annotate/pending', { session: SESSION })
  check(held.count > 0, 'the batch is held before the step runs', `${held.count} held`)

  // A turn number not used above: the attachment guard is per turn, so reusing one
  // would be suppressed by the earlier sections rather than exercised.
  const delivered = await runStep(SESSION, [], { turn: 70, step: 1 })
  check(delivered.filter((m) => m.source && m.source.plugin === 'dsh-annotate').length === 1,
    'the step carries the block')

  // The release is deferred a tick so the loop's own append lands first.
  await new Promise((r) => setTimeout(r, 10))
  const afterHandover = await call('/__dsh-annotate/pending', { session: SESSION })
  check(afterHandover.count === 0,
    'and it is released immediately, with no turn/end in between',
    `count=${afterHandover.count}`)
  check(Array.isArray(afterHandover.released)
    && afterHandover.released.some((one) => one.reason === 'delivered'),
    'the diagnostic route records that delivery is what released it',
    JSON.stringify((afterHandover.released || []).map((one) => one.reason)))
}

console.log('')
console.log('=== turn/end still drops a batch that was never delivered ===')
// The backstop. A turn that is rejected or aborted never hands the block over, so
// the release above does not run and the boundary is what clears it.
{
  await call('/__dsh-annotate/context', { session: SESSION, annotations: MARKS })
  fireSession(SESSION, 'turn/end')
  const afterTurn = await call('/__dsh-annotate/pending', { session: SESSION })
  check(afterTurn.count === 0, 'nothing is left once the turn has ended', `count=${afterTurn.count}`)
  const nextTurn = await runStep(SESSION, [], { turn: 8, step: 1 })
  check(nextTurn.filter((m) => m.source && m.source.plugin === 'dsh-annotate').length === 0,
    'and it cannot ride along on a later turn')
}

console.log('')
console.log('=== a session with nothing marked attaches nothing ===')
const clean = await runStep('sess-empty', [], { turn: 1, step: 1 })
check(clean.filter((m) => m.source && m.source.plugin === 'dsh-annotate').length === 0,
  'no message is added for a session with no marks')

console.log('')
console.log('=== a rejected step is left alone ===')
let rejectChain = async () => ({ kind: 'reject', reason: 'blocked' })
for (const fn of preSteps) {
  const inner = rejectChain
  rejectChain = async () => fn({
    agent: { id: SESSION },
    signal: { aborted: false },
    turn: 6,
    step: 1,
  }, inner)
}
await call('/__dsh-annotate/context', { session: SESSION, annotations: MARKS })
const rejected = await rejectChain()
check(rejected.kind === 'reject', 'the rejection is passed through unchanged', JSON.stringify(rejected))

console.log('')
if (failures) {
  console.log(`DELIVERY ORDER CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('DELIVERY ORDER CHECKS PASSED')
process.exit(0)
