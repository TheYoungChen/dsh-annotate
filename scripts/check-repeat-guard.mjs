/**
 * Verify the annotations read identically across a turn's assemblies, and stop
 * after the turn they went out with.
 *
 * Two separate faults have lived here, and the fix for one caused the other.
 *
 * 1. The block used to be dropped on the read *after* the one that rendered it.
 *    That was meant to stop it repeating, but the loop assembles before EVERY step
 *    of a turn, so any turn that called a tool assembled twice: the second read
 *    returned `''`, the message lost the annotations, and the reader could not see
 *    on their sent message that anything had been attached.
 *
 * 2. The first attempt at a fix cleared on `turn/start`. That is worse: the agent
 *    appends `turn/start` BEFORE it enters the step loop and dispatches it
 *    synchronously, so the clear ran before the first read and the annotations
 *    were deleted before they could ever be delivered.
 *
 * The contract asserted here is: the same message on every step of a turn, and
 * none after the turn ends.
 */
import { EventEmitter } from 'node:events'

const MODULE = new URL('../lib/index.js', import.meta.url).href

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) {
    failures += 1
    if (detail !== undefined) console.log(`       ${detail}`)
  }
}

let registered = null
/** `agent/pre-step` hooks, consulted the way the loop consults them. */
const preSteps = []
/** `session/event` listeners, which carry the turn boundary. */
const sessionEvents = []
const ctx = {
  logger: { warn: () => {}, info: () => {}, error: () => {} },
  get: () => undefined,
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  on: (event, fn) => {
    if (event === 'agent/pre-step') preSteps.push(fn)
    if (event === 'session/event') sessionEvents.push(fn)
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
check(preSteps.length > 0, 'the step hook is registered')

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

const fireSession = (session, type) => {
  for (const fn of sessionEvents) fn({ id: session }, { type, turn: 1 })
}

/**
 * Run one step the way the loop does, returning the attached text (or '').
 *
 * The payload carries the loop's own position — `agent.ts:250` spreads `{ turn,
 * step }` into it — and the plugin keys its once-per-turn guard on `turn`, so a
 * position has to be supplied here or every step would look like the same turn.
 */
let turnCounter = 0
const attachedAt = async (session, position) => {
  const at = position || { turn: ++turnCounter, step: 1 }
  let chain = async () => ({ kind: 'enter', messages: [] })
  for (const fn of preSteps) {
    const inner = chain
    chain = async () => fn({
      agent: { id: session },
      signal: { aborted: false },
      turn: at.turn,
      step: at.step,
    }, inner)
  }
  const decision = await chain()
  const mine = decision.messages.filter((m) => m.source && m.source.plugin === 'dsh-annotate')
  if (mine.length !== 1) return mine.length === 0 ? '' : `<<${mine.length} attached>>`
  return mine[0].content.map((b) => (b.type === 'text' ? b.text : '')).join('')
}

const SESSION = 'sess-repeat'
const MARKS = [
  { selector: '.a', text: 'A', note: 'first', matches: 1 },
  { selector: '.b', text: 'B', note: 'second', matches: 1 },
]

console.log('')
console.log('=== a fresh report renders on the next step ===')
await call('/__dsh-annotate/context', { session: SESSION, annotations: MARKS })
const first = await attachedAt(SESSION)
check(first.includes('Element 1') && first.includes('Element 2'), 'both elements render')
check(first.includes('note: first'), 'the note renders')

console.log('')
console.log('=== the block goes out once, and only once ===')
// This used to assert that every later step of the same turn read the SAME block,
// because the batch stayed held until `turn/end`. It is now released the moment it
// is handed over, which is what stops the capsule outliving the reader's message.
// The property that still has to hold is that the block goes out exactly once: a
// second read must not produce a second copy.
const second = await attachedAt(SESSION)
check(second === '', 'the second step renders nothing, the batch having gone out',
  JSON.stringify(second.slice(0, 50)))
const third = await attachedAt(SESSION)
check(third === '', 'and neither does the third')
console.log(`  block length across 3 steps: ${first.length}, ${second.length}, ${third.length}`)
check(first.length > 0, 'while the first step did carry it', `${first.length} chars`)

console.log('')
console.log('=== turn/start must NOT drop a batch that has not gone out yet ===')
// `turn/start` precedes the step loop, so a clear here wipes the annotations before
// anything reads them. A DISTINCT batch is reported, because re-sending the one just
// delivered is refused as stale by design — that guard is checked further down.
const BEFORE_TURN = [
  { selector: '.c', text: 'C', note: 'third', matches: 1 },
]
await call('/__dsh-annotate/context', { session: SESSION, annotations: BEFORE_TURN })
fireSession(SESSION, 'turn/start')
const heldAfterStart = await call('/__dsh-annotate/pending', { session: SESSION })
check(heldAfterStart.count > 0, 'a held batch survives turn/start',
  `${heldAfterStart.count} held — clearing here makes the whole feature a no-op`)

console.log('')
console.log('=== the turn ending drops them ===')
fireSession(SESSION, 'turn/end')
check(await attachedAt(SESSION) === '', 'nothing is attached on the next turn')
check(await attachedAt(SESSION) === '', 'and it stays gone')

console.log('')
console.log('=== inspecting the held value does not consume it ===')
const FRESH = 'sess-inspect'
await call('/__dsh-annotate/context', { session: FRESH, annotations: MARKS })
const peeked = await call('/__dsh-annotate/pending', { session: FRESH })
check(peeked.count === 2, 'the diagnostic reports two held', String(peeked.count))
check(typeof peeked.block === 'string' && peeked.block.includes('Element 1'),
  'and renders them for inspection')
check((await attachedAt(FRESH)).includes('Element 1'),
  'a real step still receives them afterwards')

console.log('')
console.log('=== a mark arriving mid-turn does not attach twice in that turn ===')
// This is what the once-per-turn guard is still for, now that delivery releases the
// batch. A batch that goes out is gone, so an ordinary second step finds nothing; the
// guard bites when a NEW mark lands between two steps of the SAME turn. Without it
// the step appends again, and one act of marking writes two transcript rows.
const MIDTURN = 'sess-midturn'
await call('/__dsh-annotate/context', { session: MIDTURN, annotations: MARKS })
const sameTurn = { turn: 99001, step: 1 }
const midFirst = await attachedAt(MIDTURN, sameTurn)
check(midFirst.includes('Element 1'), 'the first step of the turn carries the batch')
await call('/__dsh-annotate/context', {
  session: MIDTURN,
  annotations: [{ selector: '.d', text: 'D', note: 'fresh', matches: 1 }],
})
const midSecond = await attachedAt(MIDTURN, { turn: 99001, step: 2 })
check(midSecond === '',
  'and the next step of the SAME turn attaches nothing, new mark or not',
  JSON.stringify(midSecond.slice(0, 60)) || '(empty)')

console.log('')
console.log('=== a mark added on a later turn does reach the model ===')
// The mirror of the guard: it must track the turn number, not latch forever, or a
// mark made after the first exchange would never be sent at all.
const nextT = await attachedAt(MIDTURN, { turn: 99002, step: 1 })
check(nextT.includes('note: fresh'), 'the next turn carries the newly marked element',
  JSON.stringify(nextT.slice(0, 60)))

console.log('')
console.log('=== a mid-turn report is picked up rather than ignored ===')
// A mark added while a turn runs must not be stuck behind the text already
// rendered for that turn, or it would never reach the model.
const AGAIN = 'sess-again'
await call('/__dsh-annotate/context', { session: AGAIN, annotations: MARKS })
const once = await attachedAt(AGAIN)
check(once.includes('Element 1'), 'the first batch renders')
await call('/__dsh-annotate/context', {
  session: AGAIN,
  annotations: [{ selector: '.c', text: 'C', note: 'third', matches: 1 }],
})
const twice = await attachedAt(AGAIN)
check(twice.includes('note: third'), 'the second batch renders too', JSON.stringify(twice.slice(0, 60)))

console.log('')
console.log('=== the diagnostic read does not consume, and the turn still clears ===')
const CLEARED = 'sess-cleared'
await call('/__dsh-annotate/context', { session: CLEARED, annotations: MARKS })
await call('/__dsh-annotate/pending', { session: CLEARED })
check((await attachedAt(CLEARED)).includes('Element 1'), 'the block is still delivered after a peek')
fireSession(CLEARED, 'turn/end')
check(await attachedAt(CLEARED) === '', 'and the turn boundary clears it')
const after = await call('/__dsh-annotate/pending', { session: CLEARED })
check(after.count === 0, 'the diagnostic agrees it is empty', String(after.count))

console.log('')
console.log('=== the host tells the sidebar it has let go ===')
// The reader's symptom was a capsule that survived sending, and the mechanism is
// this counter. The sidebar mirrors its own list and is never told that the host
// dropped one, so it went on listing marks that were no longer attached and its
// next report uploaded them straight back. The dock polls this to find out.
const EPOCH = 'sess-epoch'
const at0 = await call('/__dsh-annotate/pending', { session: EPOCH })
check(at0.epoch === 0, 'a session that has never cleared reports epoch 0', String(at0.epoch))
await call('/__dsh-annotate/context', { session: EPOCH, annotations: MARKS })
const atHeld = await call('/__dsh-annotate/pending', { session: EPOCH })
check(atHeld.epoch === 0, 'holding annotations does not advance it', String(atHeld.epoch))
fireSession(EPOCH, 'turn/end')
const atClear = await call('/__dsh-annotate/pending', { session: EPOCH })
check(atClear.epoch === 1, 'the turn ending advances it', String(atClear.epoch))
check(atClear.count === 0, 'and the annotations are gone', String(atClear.count))
// A second turn must move it again, or a panel that missed the first change would
// never be told again.
//
// The batch must DIFFER from the one just cleared. Re-reporting the identical set
// inside the stale window is refused on purpose — that is the guard exercised further
// down — so repeating it here would test the refusal rather than the counter.
const SECOND_MARKS = [
  { id: 'c', note: 'third', selector: '.c', tag: 'div', text: 'C', doc: { x: 0, y: 0, w: 10, h: 10 }, viewport: { w: 1000, h: 800 }, selectorMatches: 1 },
]
await call('/__dsh-annotate/context', { session: EPOCH, annotations: SECOND_MARKS })
fireSession(EPOCH, 'turn/end')
const atSecond = await call('/__dsh-annotate/pending', { session: EPOCH })
check(atSecond.epoch === 2, 'a second turn advances it again', String(atSecond.epoch))
// Only the session concerned: one conversation clearing must not reset another.
const bystander = await call('/__dsh-annotate/pending', { session: CLEARED })
check(bystander.epoch === 1, 'another session keeps its own count', String(bystander.epoch))

console.log('')
console.log('=== a stale re-report does not resurrect a delivered batch ===')
// The reader's symptom: the capsule came back after sending. The host had cleared,
// but the sidebar learns that by polling, so for up to one interval it is still
// holding — and re-uploading — the batch that just went out. Accepting that repeat
// put the annotations straight back, and the attachment looked permanent.
const STALE = 'sess-stale'
await call('/__dsh-annotate/context', { session: STALE, annotations: MARKS })
check((await attachedAt(STALE)).includes('Element 1'), 'the batch is delivered')
fireSession(STALE, 'turn/end')
const afterClear = await call('/__dsh-annotate/pending', { session: STALE })
check(afterClear.count === 0, 'the host has cleared it', String(afterClear.count))
// The sidebar has not polled yet and re-asserts the same two elements.
const repeat = await call('/__dsh-annotate/context', { session: STALE, annotations: MARKS })
check(repeat.count === 0, 're-reporting the same batch does not restore it',
  `count=${repeat.count} — this is the capsule coming back`)
const settled = await call('/__dsh-annotate/pending', { session: STALE })
check(settled.count === 0, 'and it stays gone', String(settled.count))

console.log('')
console.log('=== a genuinely new batch is still accepted ===')
// The guard must not swallow a real request: a reader who marks something else
// straight afterwards is asking for it to go.
await call('/__dsh-annotate/context', {
  session: STALE,
  annotations: [{ selector: '.z', text: 'Z', note: 'new', matches: 1 }],
})
const fresh = await call('/__dsh-annotate/pending', { session: STALE })
check(fresh.count === 1, 'a different batch is stored', String(fresh.count))

console.log('')
console.log('=== an explicit empty report also counts as a clear ===')
const BLANK = 'sess-blank'
await call('/__dsh-annotate/context', { session: BLANK, annotations: MARKS })
const heldBlank = await call('/__dsh-annotate/pending', { session: BLANK })
check(heldBlank.epoch === 0, 'marking does not advance it', String(heldBlank.epoch))
await call('/__dsh-annotate/context', { session: BLANK, annotations: [] })
const blankAfter = await call('/__dsh-annotate/pending', { session: BLANK })
check(blankAfter.epoch === 1,
  'the panel reporting nothing advances it, so the two sides stay in step',
  String(blankAfter.epoch))

console.log('')
if (failures) {
  console.log(`REPEAT GUARD CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('REPEAT GUARD CHECKS PASSED')
process.exit(0)
