/**
 * Tests for the content-script entry point and the build it feeds.
 *
 * The content script is the only code that runs inside a page the user did not
 * choose, and it cannot be exercised by launching a browser — this project
 * verifies with `tsc` and Node only. So the test stands in for the browser with
 * the smallest possible double: one `chrome.runtime` object that records what was
 * sent and lets a test drive what arrives, and one DOM.
 *
 * The DOM is real rather than a stub. The claim worth testing hardest here is
 * that the script never writes to the page, and a stubbed DOM would answer that
 * question about the stub. `MutationObserver` is what a page itself would use to
 * notice a write, so it is what observes the page here.
 *
 * Written as plain JavaScript inside a `.ts` file: Node strips the (absent)
 * annotations and runs it directly, so the suite needs no test toolchain.
 *
 * Run: `node --test tests/content-entry.test.ts`
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadJsdom, installDomGlobals } from './helpers/jsdom.ts'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Slot names the picker and the entry point install themselves under. */
const SESSION_SLOT = '__dshAnnotatePickerSession__'
const STATE_SLOT = '__dshAnnotateContentEntry__'
const OVERLAY_HOST_ID = '__dsh_annotate_picker_overlay__'

/** A DOM for the whole file, or `null` when none is installed. */
const dom = await loadJsdom()
const domAvailable = dom !== null
/**
 * The document every test runs against.
 *
 * One window for the whole file, cleared between tests. A DOM implementation
 * is not required to let a caller build a second document from the first, and
 * what these tests need from a "fresh page" is exactly what clearing the head
 * and the body produces.
 */
const page = dom === null ? null : dom.window

/**
 * The address of the document the helper provides.
 *
 * Read from the document rather than written as a literal: the address is a
 * property of the loaded DOM implementation, and the entry point reports what it
 * reads rather than what a test would prefer.
 */
const PAGE_URL = page === null ? '' : page.document.location.href

/** Global slots the harness installs and must remove between tests. */
const HARNESS_GLOBALS = ['window', 'document', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'HTMLElement', 'chrome']

/**
 * Build the recording double for `chrome`.
 *
 * A double rather than a library: the entry point uses two calls, and a fake
 * that records them makes the assertions about *what was sent* exact — which is
 * the whole contract with the worker.
 *
 * @returns the fake, with the sent messages and the registered listeners.
 */
function createChromeDouble() {
  const sent = []
  const listeners = []
  const sink = { rejects: false }

  const chrome = {
    runtime: {
      id: 'test-extension',
      sendMessage(message) {
        sent.push(message)
        // The real call resolves, and rejects when nothing is listening. Both
        // outcomes are produced on demand so the entry point's handling of each
        // can be observed.
        return sink.rejects ? Promise.reject(new Error('no receiver')) : Promise.resolve(undefined)
      },
      onMessage: {
        addListener(listener) {
          listeners.push(listener)
        },
      },
    },
  }

  return {
    chrome,
    sent,
    sink,
    /** Deliver a message to every registered listener, as the platform does. */
    deliver(message) {
      let response
      for (const listener of listeners) listener(message, { frameId: 0 }, (value) => { response = value })
      return response
    },
    /** How many listeners are registered, for the double-injection check. */
    get listenerCount() {
      return listeners.length
    },
  }
}

/** Install a fresh DOM and a fresh fake for one test. */
function installHarness() {
  if (page === null) return null
  // Each test clears the document it is given rather than building a second
  // one: the helper hands out a live window, and constructing another from it
  // is not part of the interface a DOM implementation is required to offer.
  // A cleared document is also the closer stand-in for a fresh page load.
  const window = page
  // The document's address is fixed by the DOM implementation this file loads,
  // and a document that cannot navigate keeps the entry point honest: it reads
  // `document.location.href` as a page would, whatever that address happens to
  // be. Tests assert against this value rather than against a literal.
  window.document.head.innerHTML = ''
  window.document.body.innerHTML = ''
  window.document.title = 'Example'

  const global = globalThis
  const previous = new Map()
  for (const name of HARNESS_GLOBALS) previous.set(name, global[name])
  global.window = window
  global.document = window.document
  global.Node = window.Node
  global.Event = window.Event
  global.MouseEvent = window.MouseEvent
  global.KeyboardEvent = window.KeyboardEvent
  global.HTMLElement = window.HTMLElement

  const fake = createChromeDouble()
  global.chrome = fake.chrome

  return {
    window,
    document: window.document,
    fake,
    restore() {
      for (const name of HARNESS_GLOBALS) {
        const before = previous.get(name)
        if (before === undefined) delete global[name]
        else global[name] = before
      }
      delete global[SESSION_SLOT]
      delete global[STATE_SLOT]
    },
  }
}

/**
 * Import the module under test so its bootstrap runs against the harness.
 *
 * The query string is what makes this possible: an ES module is evaluated once
 * per specifier, so a cache-busting suffix gives every test a fresh instance
 * with fresh module state — exactly what a fresh content-script injection is.
 *
 * @param {number} generation - the cache-busting value.
 * @returns the module namespace.
 */
async function loadEntry(generation) {
  return import(`../extension/src/content/index.ts?t=${generation}`)
}

/** Wait for the microtask queue to drain, so a send's rejection is handled. */
function settle() {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, 0) })
}

/**
 * Drive the armed picker through one complete pick.
 *
 * The picker resolves the element under the pointer with `elementFromPoint`,
 * which is a hit test against laid-out geometry — the one thing a document
 * without a layout engine cannot answer. So the environment supplies it: a
 * function returning the element the test is aiming at is exactly the input the
 * browser would supply, and everything after that point is the picker's real
 * code path, including the capture-phase click it intercepts.
 *
 * @param {object} harness - the installed harness.
 * @param {Element} target - the element to pick.
 * @param {{ x?: number, y?: number }} [at] - where the pointer is.
 * @returns the click event, after dispatching, so the caller can assert on it.
 */
function pickAt(harness, target, at = {}) {
  const { document, window } = harness
  const x = at.x ?? 8
  const y = at.y ?? 8
  // jsdom does not implement layout, so `elementFromPoint` is absent. Supplying
  // it with the element the test aims at is the whole of the environment's
  // contribution: everything after the hit test is the picker's own code.
  document.elementFromPoint = () => target
  // A click arrives at the innermost node, so the pick is dispatched on the
  // target itself and bubbles. The pointer position is what the picker reads
  // off the event, so `elementFromPoint` is only asked for the element.
  const event = new window.MouseEvent('click', { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

/**
 * Arm picking and perform one pick.
 *
 * The arm is issued through the message channel rather than by reaching for the
 * session: `picker.ts` keeps its session in a module-level slot, and the entry
 * point is loaded from the same specifier the test can import — but a second
 * import with a different query string is a second module instance with its own
 * slot, so the only honest vantage point is the message channel the worker uses.
 *
 * @param {object} harness - the installed harness.
 * @param {Element} target - the element to pick.
 * @returns the click event.
 */
function armAndPick(harness, target) {
  harness.fake.deliver({ tag: 'dsh-annotate', kind: 'pick-command', command: 'start', keepAlive: true })
  return pickAt(harness, target)
}

let generation = 0
/** Load the entry point against a fresh harness. @returns the harness and the module. */
async function boot() {
  const harness = installHarness()
  if (harness === null) return null
  generation += 1
  const module = await loadEntry(generation)
  await settle()
  return { harness, module }
}

// ---------------------------------------------------------------------------
// Tests that need no DOM
// ---------------------------------------------------------------------------

test('the content script is declared as a classic script by the manifest', () => {
  // The build emits an IIFE for `content.js` because the manifest's
  // `content_scripts` entry carries no `"type": "module"`. That decision is only
  // correct while the manifest keeps saying so; this test is what fails if the
  // manifest changes and the build does not.
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'extension/manifest.json'), 'utf8'))
  assert.equal(manifest.background.type, 'module', 'the service worker is declared as a module')
  assert.equal(manifest.content_scripts.length, 1)
  assert.equal(manifest.content_scripts[0].type, undefined, 'a content script is a classic script unless the manifest says otherwise')
  assert.deepEqual(manifest.content_scripts[0].js, ['content.js'])
})

test('every path the manifest names exists in the source tree', () => {
  // The build derives its sources from the manifest, so the failure this guards
  // against is a manifest that names a file nothing produces. It is checked
  // here rather than by running the build, because the build needs a bundler
  // and the mapping does not.
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'extension/manifest.json'), 'utf8'))
  const sourceFor = {
    'background.js': 'extension/src/background/index.ts',
    'content.js': 'extension/src/content/index.ts',
    'panel/index.html': 'extension/src/panel/index.html',
  }
  for (const declared of [manifest.background.service_worker, ...manifest.content_scripts[0].js, manifest.side_panel.default_path]) {
    const source = sourceFor[declared]
    assert.ok(source !== undefined, `no source mapping is documented for ${declared}`)
    assert.doesNotThrow(
      () => readFileSync(resolve(packageRoot, source), 'utf8'),
      `${declared} should be produced from ${source}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Tests that need a document
// ---------------------------------------------------------------------------

test('the entry point installs one listener and answers an unknown message with nothing', { skip: !domAvailable }, async () => {
  const booted = await boot()
  assert.ok(booted !== null)
  const { harness, module } = booted
  try {
    assert.equal(harness.fake.listenerCount, 1)
    assert.equal(harness.fake.deliver({ type: 'something-else' }), undefined)
    // A batch from another context must not be mistaken for a command.
    assert.equal(harness.fake.deliver({ tag: 'dsh-annotate', kind: 'batch' }), undefined)
    assert.equal(typeof module.bootstrapContentScript, 'function')
  } finally {
    harness.restore()
  }
})

test('a second injection is a harmless no-op', { skip: !domAvailable }, async () => {
  const booted = await boot()
  assert.ok(booted !== null)
  const { harness, module } = booted
  try {
    assert.equal(harness.fake.listenerCount, 1)
    assert.equal(module.bootstrapContentScript(), false, 'the second run reports that it installed nothing')
    assert.equal(harness.fake.listenerCount, 1, 'and registers no second listener')
  } finally {
    harness.restore()
  }
})

test('the entry point announces a state query on install', { skip: !domAvailable }, async () => {
  const booted = await boot()
  assert.ok(booted !== null)
  const { harness } = booted
  try {
    const query = harness.fake.sent[0]
    assert.equal(query.tag, 'dsh-annotate')
    assert.equal(query.kind, 'state-query')
    assert.equal(Number.isInteger(query.tabId), true)
    assert.equal(Number.isInteger(query.frame.frameId), true)
    // A content script cannot know its own tab or frame id, so it sends a
    // placeholder rather than a claim; see the entry point's own comment.
    assert.equal(query.tabId, -1)
    assert.equal(query.frame.frameId, -1)
    assert.equal(query.frame.url, PAGE_URL)
  } finally {
    harness.restore()
  }
})

test('a start command arms the picker, announces it, and a stop disarms it', { skip: !domAvailable }, async () => {
  const booted = await boot()
  assert.ok(booted !== null)
  const { harness } = booted
  const { document } = harness
  try {
    document.body.innerHTML = '<button id="go" type="button">Go</button>'
    const button = document.getElementById('go')

    assert.deepEqual(harness.fake.deliver({ tag: 'dsh-annotate', kind: 'pick-command', command: 'start', keepAlive: true }), { ok: true })
    const started = harness.fake.sent.filter((message) => message.kind === 'picking-started')
    assert.equal(started.length, 1)

    // A second start replaces the session rather than stacking a second one:
    // two live sessions would both swallow the same click. Two picks after two
    // starts is what makes that observable from outside the picker's own slot.
    harness.fake.deliver({ tag: 'dsh-annotate', kind: 'pick-command', command: 'start', keepAlive: true })
    assert.equal(harness.fake.sent.filter((message) => message.kind === 'picking-started').length, 2)
    pickAt(harness, button)
    await settle()
    assert.equal(
      harness.fake.sent.filter((message) => message.kind === 'batch').length,
      1,
      'one click is one pick, however many start commands arrived',
    )

    // Re-arming replaces the live session, and `armPicking` ends the previous one
    // on the way in — so the exit of session #1 is already announced here. That
    // announcement is the point: a replaced session must say so, or a panel
    // watching this frame would believe picking never stopped.
    const endedAfterRearm = harness.fake.sent.filter((message) => message.kind === 'picking-ended')
    assert.equal(endedAfterRearm.length, 1, 'the replaced session announces its exit')
    assert.equal(endedAfterRearm[0].reason, 'disabled', 'a replaced session exits as disabled')

    // A stop with a session live announces one more exit, so the count rises by
    // exactly one. It is checked as a delta rather than an absolute: the re-arm
    // above already contributed one, and an absolute here would be asserting
    // about the re-arm rather than about the stop.
    harness.fake.deliver({ tag: 'dsh-annotate', kind: 'pick-command', command: 'stop', keepAlive: false })
    assert.equal(
      harness.fake.sent.filter((message) => message.kind === 'picking-ended').length,
      endedAfterRearm.length + 1,
      'a stop on a live session announces exactly one more exit',
    )

    // A stop after a fresh arm ends that arm, and the exit is announced.
    harness.fake.deliver({ tag: 'dsh-annotate', kind: 'pick-command', command: 'start', keepAlive: true })
    harness.fake.deliver({ tag: 'dsh-annotate', kind: 'pick-command', command: 'stop', keepAlive: false })
    const ended = harness.fake.sent.filter((message) => message.kind === 'picking-ended')
    assert.equal(ended[ended.length - 1].reason, 'disabled')

    // And the frame is idle again: a click now reaches the page instead of being
    // swallowed as a pick. This is the assertion that gives "the mode ended" its
    // meaning — the batch count must be unchanged, because an unarmed frame
    // produces no batch at all.
    const batchesBefore = harness.fake.sent.filter((message) => message.kind === 'batch').length
    const click = pickAt(harness, button)
    await settle()
    assert.equal(click.defaultPrevented, false, 'the page receives clicks once the mode has ended')
    assert.equal(
      harness.fake.sent.filter((message) => message.kind === 'batch').length,
      batchesBefore,
      'a click on an unarmed frame is not a pick',
    )
  } finally {
    harness.restore()
  }
})

test('the picker keeps its own overlay host and nothing else is added to the page', { skip: !domAvailable }, async () => {
  const booted = await boot()
  assert.ok(booted !== null)
  const { harness } = booted
  const { document } = harness
  try {
    const before = [...document.documentElement.childNodes].map((node) => node.nodeName)

    harness.fake.deliver({ tag: 'dsh-annotate', kind: 'pick-command', command: 'start', keepAlive: true })

    const hosts = document.querySelectorAll(`#${OVERLAY_HOST_ID}`)
    assert.equal(hosts.length, 1, 'exactly one overlay host')
    const host = hosts[0]
    // Everything the overlay draws lives inside the host's shadow root, so the
    // page's own tree gains one zero-sized node and nothing else.
    assert.equal(host.shadowRoot !== null, true)
    assert.equal(host.shadowRoot.children.length, 3)
    assert.equal(document.body.childNodes.length, 0, 'the page body is untouched')

    harness.fake.deliver({ tag: 'dsh-annotate', kind: 'pick-command', command: 'stop', keepAlive: false })
    assert.equal(document.querySelectorAll(`#${OVERLAY_HOST_ID}`).length, 0, 'the host is removed again')
    assert.deepEqual([...document.documentElement.childNodes].map((node) => node.nodeName), before)
  } finally {
    harness.restore()
  }
})

test('no page node is ever mutated while picking, hovering, picking and flashing', { skip: !domAvailable }, async () => {
  const booted = await boot()
  assert.ok(booted !== null)
  const { harness, module } = booted
  const { document, window } = harness
  try {
    document.body.innerHTML = '<div id="card" class="card"><button id="go" type="button">Go</button></div>'
    const card = document.getElementById('card')
    const button = document.getElementById('go')

    // Snapshot everything a write could plausibly change, then watch for a
    // mutation the way a page's own code would.
    const record = (element) => ({
      attributes: [...element.attributes].map((attribute) => `${attribute.name}=${attribute.value}`).join(' '),
      html: element.innerHTML,
      style: element.getAttribute('style'),
    })
    /**
     * The document's markup with this extension's own overlay host removed.
     *
     * The overlay is mounted on `documentElement` rather than `body` so a page
     * that replaces its body cannot take the highlight with it — which means it
     * appears in `documentElement.innerHTML` even though it is not a write to
     * the page. Removing the host (and its subtree, which the markup includes)
     * leaves exactly the page, and that is what must be unchanged.
     *
     * @param {Document} doc - the document to serialise.
     * @returns the page's own markup.
     */
    const pageMarkup = (doc) => {
      const clone = doc.documentElement.cloneNode(true)
      const host = clone.querySelector(`#${OVERLAY_HOST_ID}`)
      if (host !== null) host.remove()
      return clone.innerHTML
    }

    const before = {
      card: record(card),
      button: record(button),
      body: document.body.childNodes.length,
      // Taken with the same helper the assertion uses, so the comparison is
      // between like and like: at this point no overlay exists yet, and
      // `pageMarkup` on a document without one is just the page's markup.
      html: pageMarkup(document),
    }

    const mutations = []
    const observer = new window.MutationObserver((records) => {
      for (const entry of records) {
        // The overlay is mounted on documentElement, not body, so it survives a
        // page that replaces its own body — which means a record for the overlay
        // is attributed to <html> and carries the host in `addedNodes` rather
        // than being targeted at it. Both shapes are the overlay's own work, so
        // both are excluded here; everything else is a write to the page.
        const isOverlayNode = (node) => node.nodeType === 1
          && (node.id === OVERLAY_HOST_ID
            || (typeof node.querySelector === 'function' && node.id === OVERLAY_HOST_ID))
        const target = entry.target
        const inOverlay = target.id === OVERLAY_HOST_ID
          || (typeof target.closest === 'function' && target.closest(`#${OVERLAY_HOST_ID}`) !== null)
        if (inOverlay) continue
        const touched = [...entry.addedNodes, ...entry.removedNodes]
        if (touched.length > 0 && touched.every(isOverlayNode)) continue
        mutations.push(entry.type)
      }
    })
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })

    // Hovering draws in the overlay; the click is swallowed in the capture
    // phase, which is what stops a pick from also being a click on the page.
    const click = armAndPick(harness, button)
    await settle()

    assert.equal(click.defaultPrevented, true, 'the page never sees the click')

    // The entry point's exported guard is exercised so the module is not only
    // loaded for its side effects.
    const batch = harness.fake.sent.find((message) => message.kind === 'batch')
    assert.ok(batch !== undefined, 'a pick produces a batch')
    assert.equal(module.isOwnWireMessage(batch), true, 'the batch is a message the worker would accept')

    // The marker drawn for an already-picked element lives in its own overlay.
    const panel = harness.fake.deliver({ type: 'annotate:flash', elementId: 'el-does-not-exist' })
    assert.deepEqual(panel, { ok: true, kind: 'flashed', found: false })

    await settle()
    observer.disconnect()

    assert.deepEqual(mutations, [], 'nothing outside the overlay host was mutated')
    assert.deepEqual(record(card), before.card, 'the ancestor element is byte-identical')
    assert.deepEqual(record(button), before.button, 'the picked element is byte-identical')
    assert.equal(document.body.childNodes.length, before.body, 'no node was added to the page body')
    // Compared with the overlay host removed, because the overlay is this
    // extension's own isolated UI — it is mounted on documentElement precisely
    // so it cannot be disturbed by the page, and its presence is the one
    // addition that is not a write to the page. Everything else must match
    // byte for byte, which is what makes "the page is never mutated" checkable
    // rather than merely asserted.
    assert.equal(
      pageMarkup(document),
      before.html,
      'the page is byte-identical once the overlay host is excluded',
    )
  } finally {
    harness.restore()
  }
})

test('a pick sends a batch and a relay, and the batch carries no DOM node', { skip: !domAvailable }, async () => {
  const booted = await boot()
  assert.ok(booted !== null)
  const { harness } = booted
  const { document } = harness
  try {
    document.body.innerHTML = '<button id="go" type="button">Go</button>'
    const button = document.getElementById('go')

    // A one-shot session first, ended by an explicit stop, so both
    // announcements are observed before the pick that produces the payloads.
    harness.fake.deliver({ tag: 'dsh-annotate', kind: 'pick-command', command: 'start', keepAlive: true })
    harness.fake.deliver({ tag: 'dsh-annotate', kind: 'pick-command', command: 'stop', keepAlive: false })
    await settle()

    const kinds = harness.fake.sent.map((message) => message.kind ?? message.type)
    assert.equal(kinds.includes('picking-started'), true)
    assert.equal(kinds.includes('picking-ended'), true)

    armAndPick(harness, button)
    await settle()

    const batch = harness.fake.sent.find((message) => message.kind === 'batch')
    assert.ok(batch !== undefined)
    assert.equal(batch.tag, 'dsh-annotate')
    assert.equal(batch.batch.version, 1)
    assert.equal(batch.batch.annotations.length, 1)
    assert.equal(batch.batch.page.url, PAGE_URL)
    // The kind is derived from the address, so a document the protocol cannot
    // classify is the case this asserts about rather than one it hides.
    assert.equal(batch.batch.page.kind, PAGE_URL.startsWith('file://') ? 'file' : 'https')
    assert.equal(Number.isInteger(batch.batch.page.viewport.width), true)
    const facts = batch.batch.annotations[0].facts
    assert.equal(facts.tag, 'button')
    assert.equal(typeof facts.selector, 'string')
    assert.equal(Number.isInteger(facts.frameDepth), true)

    const relay = harness.fake.sent.find((message) => message.type === 'annotate:picked')
    assert.ok(relay !== undefined, 'the pick is also relayed for the panel')
    assert.equal(typeof relay.elementId, 'string')
    assert.equal(relay.facts.tag, 'button')
    assert.equal(relay.page.url, PAGE_URL)

    // Nothing a DOM node could be smuggled in as: every value must be
    // structured-cloneable, which a live `Element` is not. `JSON.stringify`
    // would silently drop a node, so the check walks the payload instead.
    const walk = (value, path) => {
      if (value === null) return
      if (Array.isArray(value)) {
        value.forEach((entry, index) => { walk(entry, `${path}[${index}]`) })
        return
      }
      if (typeof value === 'object') {
        assert.equal(
          Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
          true,
          `${path} is a plain object, not a DOM node or a class instance`,
        )
        for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`)
      }
    }
    walk(batch, 'batch')
    walk(relay, 'relay')
  } finally {
    harness.restore()
  }
})

test('panel requests are answered in the shapes the panel validates', { skip: !domAvailable }, async () => {
  const booted = await boot()
  assert.ok(booted !== null)
  const { harness } = booted
  const { document } = harness
  try {
    const described = harness.fake.deliver({ type: 'annotate:describe-page' })
    assert.deepEqual(described, {
      ok: true,
      kind: 'page',
      page: { url: PAGE_URL, title: 'Example', frameKind: 'top' },
    })

    const probing = harness.fake.deliver({ type: 'annotate:probe', elementIds: ['el-1', 'el-2'] })
    assert.deepEqual(probing, { ok: true, kind: 'probe', alive: [] })

    const missing = harness.fake.deliver({ type: 'annotate:flash', elementId: 'el-missing' })
    assert.deepEqual(missing, { ok: true, kind: 'flashed', found: false })

    const started = harness.fake.deliver({ type: 'annotate:start-picking' })
    assert.deepEqual(started, { ok: true, kind: 'picking', active: true })

    const stopped = harness.fake.deliver({ type: 'annotate:stop-picking' })
    assert.deepEqual(stopped, { ok: true, kind: 'picking', active: false })

    // A malformed request earns nothing rather than a guessed answer.
    assert.equal(harness.fake.deliver({ type: 'annotate:flash' }), undefined)
    assert.deepEqual(harness.fake.deliver({ type: 'annotate:probe', elementIds: 'el-1' }), { ok: true, kind: 'probe', alive: [] })

    // Ids that do resolve are reported, which is the answer the panel's list
    // uses to decide whether a row still describes something on the page.
    document.body.innerHTML = '<button id="go" type="button">Go</button>'
    const button = document.getElementById('go')
    // The panel's own arm is one-shot, so its pick is the one that matters:
    // arming and picking through the panel's requests is the path the UI uses.
    assert.deepEqual(harness.fake.deliver({ type: 'annotate:start-picking' }), { ok: true, kind: 'picking', active: true })
    pickAt(harness, button)
    await settle()

    const relay = harness.fake.sent.find((message) => message.type === 'annotate:picked')
    assert.ok(relay !== undefined)
    const alive = harness.fake.deliver({ type: 'annotate:probe', elementIds: [relay.elementId] })
    assert.deepEqual(alive, { ok: true, kind: 'probe', alive: [relay.elementId] })
  } finally {
    harness.restore()
  }
})

test('a rejected send is swallowed rather than left as an unhandled rejection', { skip: !domAvailable }, async () => {
  const harness = installHarness()
  assert.ok(harness !== null)
  try {
    harness.fake.sink.rejects = true
    const failures = []
    const onRejection = (reason) => { failures.push(reason) }
    process.on('unhandledRejection', onRejection)
    generation += 1
    const module = await loadEntry(generation)
    harness.fake.deliver({ tag: 'dsh-annotate', kind: 'pick-command', command: 'start', keepAlive: true })
    harness.fake.deliver({ tag: 'dsh-annotate', kind: 'pick-command', command: 'stop', keepAlive: false })
    await settle()
    await settle()
    process.off('unhandledRejection', onRejection)
    assert.deepEqual(failures, [], 'a worker that is not listening is not an error the page should see')
    assert.equal(typeof module.bootstrapContentScript, 'function')
  } finally {
    harness.restore()
  }
})
