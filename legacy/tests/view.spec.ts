/**
 * View derivation and row summarisation.
 *
 * These are the rules that decide what the user is looking at, so they are
 * tested as pure functions: no document, no message channel, no timing.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { AnnotationStore, MemoryStateStorage } from '../extension/src/panel/store.ts'
import { formatSize, formatTime, pageLabel, summariseElement } from '../extension/src/panel/summary.ts'
import { deriveView, primaryActionLabel, unavailableMessage } from '../extension/src/panel/view.ts'
import { facts } from './helpers/fixtures.ts'

/** A store with nothing in it. */
function emptyStore(): AnnotationStore {
  let tick = 1
  return new AnnotationStore(1, new MemoryStateStorage(), () => { tick += 1; return tick })
}

describe('deriveView', () => {
  it('reports unavailable ahead of every other state', () => {
    // A page that cannot be reached cannot be picked either, so a picking state
    // here would be telling the user something untrue about their page.
    const store = emptyStore()
    store.setPicked({ id: 'el-1', facts: facts() })
    const view = deriveView(store.snapshot(), false, 'no-receiver')
    assert.equal(view.state, 'unavailable')
    assert.equal(view.unavailableReason, 'no-receiver')
  })

  it('reports picking ahead of a pending pick', () => {
    const store = emptyStore()
    store.setPicked({ id: 'el-1', facts: facts() })
    store.setPicking(true)
    assert.equal(deriveView(store.snapshot(), true).state, 'picking')
  })

  it('reports annotating for a pending pick', () => {
    const store = emptyStore()
    store.setPicked({ id: 'el-1', facts: facts() })
    const view = deriveView(store.snapshot(), true)
    assert.equal(view.state, 'annotating')
    assert.equal(view.hasPendingPick, true)
  })

  it('reports idle with nothing pending', () => {
    const view = deriveView(emptyStore().snapshot(), true)
    assert.equal(view.state, 'idle')
    assert.equal(view.hasPendingPick, false)
  })

  it('refuses to submit an empty batch', () => {
    const store = emptyStore()
    assert.equal(deriveView(store.snapshot(), true).canSubmit, false)
    store.setPicked({ id: 'el-1', facts: facts() })
    store.commit('one')
    assert.equal(deriveView(store.snapshot(), true).canSubmit, true)
  })

  it('refuses a second submission while one is in flight', () => {
    const store = emptyStore()
    store.setPicked({ id: 'el-1', facts: facts() })
    store.commit('one')
    store.beginSubmit()
    const view = deriveView(store.snapshot(), true)
    assert.equal(view.submitting, true)
    assert.equal(view.canSubmit, false)
  })

  it('labels the primary action for each state', () => {
    assert.equal(primaryActionLabel('idle'), 'Start annotating')
    assert.equal(primaryActionLabel('picking'), 'Stop picking')
    assert.equal(primaryActionLabel('annotating'), 'Pick another element')
  })

  it('explains each unavailable reason differently', () => {
    const messages = new Set([
      unavailableMessage('no-tab'),
      unavailableMessage('unsupported-url'),
      unavailableMessage('no-receiver'),
      unavailableMessage(null),
    ])
    assert.equal(messages.size, 4)
  })
})

describe('summariseElement', () => {
  it('reports the tag, the selector and an excerpt', () => {
    const summary = summariseElement(facts({ tag: 'a', selector: '#save', text: '  Save   changes  ' }))
    assert.equal(summary.tag, 'a')
    assert.equal(summary.locator, '#save')
    assert.equal(summary.text, 'Save changes')
    assert.equal(summary.locatorIsFragile, false)
  })

  it('marks a selector that does not resolve to exactly one element', () => {
    assert.equal(summariseElement(facts({ selectorMatches: 7 })).locatorIsFragile, true)
    assert.equal(summariseElement(facts({ selector: '' })).locatorIsFragile, true)
  })

  it('substitutes a placeholder for a missing selector and tag', () => {
    const summary = summariseElement(facts({ tag: '', selector: '' }))
    assert.equal(summary.tag, 'unknown')
    assert.equal(summary.locator, '(no selector)')
  })

  it('collapses whitespace so one row stays one line', () => {
    const summary = summariseElement(facts({ text: 'line one\n\nline two\t\tline three' }))
    assert.equal(summary.text, 'line one line two line three')
  })

  it('treats blank text as no text', () => {
    assert.equal(summariseElement(facts({ text: '   \n  ' })).text, null)
    assert.equal(summariseElement(facts()).text, null)
  })

  it('shortens a long selector without splitting a code point', () => {
    const summary = summariseElement(facts({ selector: `div.${'é'.repeat(80)}` }))
    assert.ok([...summary.locator].length <= 48)
    assert.ok(summary.locator.endsWith('…'))
    assert.equal(summary.locator.includes('\uFFFD'), false)
  })

  it('keeps a short selector intact', () => {
    const selector = 'section > ul > li:nth-of-type(3)'
    assert.equal(summariseElement(facts({ selector })).locator, selector)
  })
})

describe('pageLabel', () => {
  it('uses the hostname for a web page', () => {
    assert.equal(pageLabel('https://example.test/a/b'), 'example.test')
  })

  it('uses the file name for a local file', () => {
    assert.equal(pageLabel('file:///C:/work/mockup.html'), 'mockup.html')
  })

  it('has no label without a URL', () => {
    assert.equal(pageLabel(null), null)
    assert.equal(pageLabel(''), null)
  })

  it('falls back to the raw value for something that is not a URL', () => {
    assert.equal(pageLabel('not a url'), 'not a url')
  })
})

describe('formatSize', () => {
  it('reports a rounded box', () => {
    assert.equal(formatSize(facts({ rect: { x: 0, y: 0, width: 95.6, height: 32.2 } })), '96 × 32')
  })

  it('has nothing to say about a zero-area box', () => {
    assert.equal(formatSize(facts({ rect: { x: 0, y: 0, width: 0, height: 12 } })), null)
  })
})

describe('formatTime', () => {
  it('formats an instant', () => {
    assert.notEqual(formatTime(1_700_000_000_000, 'en-US'), '')
  })

  it('returns nothing for an unrepresentable instant', () => {
    assert.equal(formatTime(Number.NaN), '')
  })
})
