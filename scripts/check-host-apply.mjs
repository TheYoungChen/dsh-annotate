/**
 * Run the host half's apply() against a stand-in cordis context.
 *
 * The unit tests so far read the source. This one executes it: apply() is where
 * a plugin crashes a host, and a crash there takes the whole DSH start with it.
 * Everything the plugin touches is recorded, so an invented API call shows up as
 * a missing member rather than a silent no-op.
 */

const MODULE = new URL('../lib/index.js', import.meta.url).href

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  if (!ok) {
    failures += 1
    if (detail !== undefined) console.log(`       ${detail}`)
  }
}

/** Records every call so the test can assert what apply() actually did. */
function makeContext() {
  const calls = { effect: [], inject: [], on: [], register: [], context: [], get: [] }
  const disposers = []
  const ctx = {
    calls,
    logger: { warn: (m) => calls.warn = (calls.warn || []).concat(m), info: () => {}, error: () => {} },
    get(name) {
      calls.get.push(name)
      if (name === 'systemPrompt') return ctx._systemPrompt
      return undefined
    },
    _systemPrompt: {
      context(options) {
        calls.context.push(options)
        const d = () => { disposers.push('context') }
        return d
      },
    },
    effect(fn) {
      calls.effect.push(fn)
      // The real host runs the body and keeps the returned disposer.
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return () => {}
    },
    on(event, fn, options) {
      // `options` matters: the pre-step hook must be declared global or the agent
      // scope never consults it, and the annotations silently never attach.
      calls.on.push({ event, fn, options })
      // cordis returns a disposer here; the plugin must use it.
      return () => { disposers.push(`off:${event}`) }
    },
    inject(names, fn) {
      calls.inject.push(names)
      return fn(ctx)
    },
    webServer: {
      register(options) {
        calls.register.push(options)
        return () => {}
      },
    },
    // The `timer` service is mixed into the context, so these live on ctx
    // itself. `ctx.interval(callback, delay)` is the form used here.
    interval(callback, delay) {
      calls.interval = (calls.interval || []).concat({ delay })
      return () => {}
    },
    timeout(callback, delay) {
      calls.timeout = (calls.timeout || []).concat({ delay })
      return () => {}
    },
  }
  ctx._disposers = disposers
  return ctx
}

const mod = await import(MODULE)
const ctx = makeContext()

console.log('=== apply() runs without throwing ===')
let threw = null
try {
  mod.apply(ctx, { enabled: true, allowExternalFiles: true, idleMs: 300000 })
} catch (error) {
  threw = error
}
check(threw === null, 'apply() completed', threw && `${threw.message}\n${threw.stack}`)

if (threw) {
  console.log('\nHOST APPLY FAILED — this would take DSH down')
  process.exit(1)
}

console.log('\n=== it registered what it should ===')
const registered = ctx.calls.register.map((r) => r.path)
check(registered.includes('/__dsh-annotate'), 'registers the HTTP route', registered.join(', '))

console.log('\n=== the attachment hook ===')
// The annotations travel as their own message rather than a prompt context
// contribution. That is what lets the row carry this plugin's name and a
// collapsed summary — a `systemPrompt.context()` contribution is funnelled under
// the prompt package's label, and the snapshot form is hardcoded to no summary.
check(ctx.calls.context.length === 0,
  'no prompt context contribution is registered', String(ctx.calls.context.length))
const hooks = ctx.calls.on.filter((one) => one.event === 'agent/pre-step')
check(hooks.length === 1, 'exactly one pre-step hook is registered', String(hooks.length))
if (hooks[0]) {
  check(hooks[0].options && hooks[0].options.global === true,
    'and it is declared global, or the agent scope never consults it',
    JSON.stringify(hooks[0].options))
  check(typeof hooks[0].fn === 'function', 'the hook is callable')
}

console.log('\n=== the hook survives every payload shape ===')
// The payload is built by the loop, but a malformed or partial one must not throw
// here: a throw inside the step waterfall would break the turn, not just this
// plugin.
if (hooks[0]) {
  const shapes = [
    ['undefined payload', undefined],
    ['empty payload', {}],
    ['null agent', { agent: null }],
    ['agent without id', { agent: {} }],
    ['agent with id', { agent: { id: 'some-session' } }],
    ['numeric id', { agent: { id: 42 } }],
    ['null id', { agent: { id: null } }],
    ['aborted signal', { agent: { id: 's' }, signal: { aborted: true } }],
  ]
  for (const [label, payload] of shapes) {
    let bad = null
    let out
    try {
      out = await hooks[0].fn(payload, async () => ({ kind: 'enter', messages: [] }))
    } catch (error) {
      bad = error
    }
    check(bad === null && out && Array.isArray(out.messages),
      `passes the decision through for: ${label}`,
      bad ? bad.message : JSON.stringify(out))
  }
  // A rejection is the loop's own verdict and must survive untouched.
  const rejected = await hooks[0].fn({ agent: { id: 's' } }, async () => ({ kind: 'reject', reason: 'blocked' }))
  check(rejected.kind === 'reject', 'a rejected step stays rejected', JSON.stringify(rejected))
  // An unmarked session adds nothing at all.
  const clean = await hooks[0].fn({ agent: { id: 'never-seen' } }, async () => ({ kind: 'enter', messages: [] }))
  check(clean.messages.length === 0, 'an unknown session gets no message', String(clean.messages.length))
}

console.log('\n=== a host without the prompt service still works ===')
// The preview has to keep working on a host that offers no prompt service at all,
// which is now trivially true: nothing is resolved from it.
const bare = makeContext()
bare._systemPrompt = undefined
let bareThrew = null
try {
  mod.apply(bare, {})
} catch (error) {
  bareThrew = error
}
check(bareThrew === null, 'apply() tolerates a missing prompt service', bareThrew && bareThrew.message)
check(bare.calls.register.some((r) => r.path === '/__dsh-annotate'), 'the route still registers without it')

console.log('\n=== teardown releases everything ===')
// Run the disposers the host would run on unload.
const teardown = ctx._disposers.filter((d) => typeof d === 'function')
let teardownThrew = null
try {
  for (const d of teardown) d()
} catch (error) {
  teardownThrew = error
}
check(teardownThrew === null, 'disposers run cleanly', teardownThrew && teardownThrew.message)
check(teardown.length > 0, 'something is actually registered for teardown', String(teardown.length))

console.log('\n=== no invented context API ===')
// Only members the stand-in actually provides may be touched. An undefined call
// would have thrown above; this records which ones were reached.
//
// `ctx.get` is no longer consulted: the attachment travels the event bus instead
// of resolving a prompt service, so a host without one needs no special case.
check(!ctx.calls.get.includes('systemPrompt'),
  'it does not resolve a prompt service', ctx.calls.get.join(', ') || '(none)')
check(!ctx.calls.effect.some((f) => f === undefined), 'no undefined effect bodies')
check(ctx.calls.on.length === 2, 'subscribes to exactly two events', String(ctx.calls.on.length))
check(ctx.calls.on.some((one) => one.event === 'session/event'), 'one is session/event')
check(ctx.calls.on.some((one) => one.event === 'agent/pre-step'), 'the other is agent/pre-step')

console.log('')
if (failures) {
  console.log(`HOST APPLY CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('HOST APPLY CHECKS PASSED')
