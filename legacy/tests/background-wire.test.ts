/**
 * Unit tests for the content-script message contract and the batch enrichment
 * the worker applies to it.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { enrichBatch, type EnrichedFacts } from '../extension/src/background/enrich.ts'
import { resolveFramePath, NO_PARENT, type FrameNode } from '../extension/src/background/frames.ts'
import { isPickCommand, parseContentMessage, pickCommand } from '../extension/src/background/wire.ts'
import { PROTOCOL_VERSION, type AnnotationBatch, type ElementFacts } from '../src/protocol.ts'

/** Facts for one annotation, with the page-side depth under test control. */
function facts(frameDepth: number): ElementFacts {
  return {
    tag: 'button',
    selector: 'button.save',
    selectorMatches: 1,
    rect: { x: 1, y: 2, width: 3, height: 4 },
    inViewport: true,
    frameDepth,
  }
}

/** A batch carrying one annotation at the given page-side depth. */
function batchFixture(frameDepth = 1): AnnotationBatch {
  return {
    version: PROTOCOL_VERSION,
    batchId: 'b1',
    page: { url: 'https://example.com/', kind: 'https', viewport: { width: 800, height: 600 } },
    annotations: [{ id: 'a1', pickedAt: 1, facts: facts(frameDepth) }],
    submittedAt: 2,
  }
}

/** A message envelope with the tag and ids the worker requires. */
function envelope(kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { tag: 'dsh-annotate', kind, tabId: 3, frame: { frameId: 0 }, ...extra }
}

describe('parseContentMessage', () => {
  it('accepts a well-formed batch', () => {
    const message = parseContentMessage(envelope('batch', { batch: batchFixture() }))
    assert.equal(message?.kind, 'batch')
    assert.equal(message?.tabId, 3)
  })

  it('accepts the lifecycle messages', () => {
    assert.equal(parseContentMessage(envelope('picking-started'))?.kind, 'picking-started')
    assert.equal(parseContentMessage(envelope('picking-ended', { reason: 'escape' }))?.kind, 'picking-ended')
    assert.equal(parseContentMessage(envelope('state-query'))?.kind, 'state-query')
  })

  it('rejects a message with no tag, which belongs to another listener', () => {
    assert.equal(parseContentMessage({ kind: 'batch' }), undefined)
    assert.equal(parseContentMessage({ tag: 'something-else', kind: 'batch' }), undefined)
  })

  it('rejects a batch that fails protocol validation', () => {
    const invalid = { ...batchFixture(), version: 99 }
    assert.equal(parseContentMessage(envelope('batch', { batch: invalid })), undefined)
    assert.equal(parseContentMessage(envelope('batch', { batch: { nope: true } })), undefined)
  })

  it('rejects an unusable tab or frame id rather than guessing one', () => {
    assert.equal(parseContentMessage(envelope('state-query', { tabId: '3' })), undefined)
    assert.equal(parseContentMessage(envelope('state-query', { tabId: -1 })), undefined)
    assert.equal(parseContentMessage(envelope('state-query', { frame: { frameId: -5 } })), undefined)
    assert.equal(parseContentMessage(envelope('state-query', { frame: null })), undefined)
  })

  it('keeps an optional frame url only when it is a string', () => {
    const withUrl = parseContentMessage(envelope('state-query', { frame: { frameId: 2, url: 'https://a.example' } }))
    assert.equal(withUrl?.frame.url, 'https://a.example')
    const badUrl = parseContentMessage(envelope('state-query', { frame: { frameId: 2, url: 7 } }))
    assert.equal(badUrl, undefined)
  })

  it('requires a reason on picking-ended', () => {
    assert.equal(parseContentMessage(envelope('picking-ended')), undefined)
  })

  it('ignores a non-object payload', () => {
    assert.equal(parseContentMessage(null), undefined)
    assert.equal(parseContentMessage('batch'), undefined)
    assert.equal(parseContentMessage(42), undefined)
  })
})

describe('pickCommand', () => {
  it('builds an arm command that survives a pick', () => {
    const command = pickCommand('start', { keepAlive: true })
    assert.deepEqual(command, { tag: 'dsh-annotate', kind: 'pick-command', command: 'start', keepAlive: true })
  })

  it('omits the hint when none is supplied', () => {
    assert.equal('hintText' in pickCommand('stop', { keepAlive: false }), false)
  })

  it('carries a hint when one is supplied', () => {
    const command = pickCommand('start', { keepAlive: true, hintText: 'pick it' })
    assert.equal(command.hintText, 'pick it')
  })

  it('round-trips through its own guard', () => {
    assert.equal(isPickCommand(pickCommand('start', { keepAlive: true })), true)
  })

  it('rejects a malformed command', () => {
    assert.equal(isPickCommand({ tag: 'dsh-annotate', kind: 'pick-command', command: 'explode', keepAlive: true }), false)
    assert.equal(isPickCommand({ tag: 'dsh-annotate', kind: 'pick-command', command: 'start' }), false)
    assert.equal(isPickCommand({ kind: 'pick-command', command: 'start', keepAlive: true }), false)
    assert.equal(isPickCommand(null), false)
  })
})

describe('enrichBatch', () => {
  const tree: FrameNode[] = [
    { frameId: 0, parentFrameId: NO_PARENT, url: 'https://example.com/' },
    { frameId: 4, parentFrameId: 0, url: 'https://widget.example.net/' },
  ]

  it('replaces the page-side depth with the resolved one', () => {
    const path = resolveFramePath(tree, 4)
    const enriched = enrichBatch(batchFixture(1), path)
    assert.equal(enriched.annotations[0]?.facts.frameDepth, 1)
    assert.equal(enriched.annotations[0]?.facts.frameId, 4)
  })

  it('preserves the page-side estimate instead of discarding it', () => {
    // A cross-origin chain the content script could not see past: it reported 1,
    // the real depth is also 1, but the estimate is what a reader compares against.
    const path = resolveFramePath(tree, 4)
    const enriched = enrichBatch(batchFixture(1), path)
    assert.equal(enriched.annotations[0]?.facts.reportedFrameDepth, 1)
  })

  it('corrects a page-side estimate that was too low', () => {
    // The content script saw a cross-origin boundary and stopped at 1; the real
    // depth from the browser's tree is 2.
    const deep: FrameNode[] = [
      { frameId: 0, parentFrameId: NO_PARENT },
      { frameId: 4, parentFrameId: 0 },
      { frameId: 9, parentFrameId: 4 },
    ]
    const enriched = enrichBatch(batchFixture(1), resolveFramePath(deep, 9))
    assert.equal(enriched.annotations[0]?.facts.frameDepth, 2)
  })

  it('adds a readable frame path', () => {
    const enriched = enrichBatch(batchFixture(), resolveFramePath(tree, 4))
    assert.equal(enriched.annotations[0]?.facts.framePath, 'top:example.com > widget.example.net')
  })

  it('does not modify the batch it was given', () => {
    const original = batchFixture(5)
    enrichBatch(original, resolveFramePath(tree, 4))
    assert.equal(original.annotations[0]?.facts.frameDepth, 5)
    assert.equal('framePath' in original.annotations[0]!.facts, false)
  })

  it('keeps every other field untouched', () => {
    const original = batchFixture()
    const enriched = enrichBatch(original, resolveFramePath(tree, 4))
    assert.equal(enriched.batchId, original.batchId)
    assert.equal(enriched.page.url, original.page.url)
    assert.equal(enriched.annotations[0]?.id, 'a1')
    assert.equal(enriched.annotations[0]?.pickedAt, 1)
    assert.equal(enriched.annotations[0]?.facts.selector, 'button.save')
  })

  it('enriches every annotation in a multi-annotation batch', () => {
    const multi: AnnotationBatch = {
      ...batchFixture(),
      annotations: [
        { id: 'a1', pickedAt: 1, facts: facts(1) },
        { id: 'a2', pickedAt: 2, facts: facts(1) },
      ],
    }
    const enriched = enrichBatch(multi, resolveFramePath(tree, 4))
    assert.deepEqual(enriched.annotations.map((entry) => entry.facts.frameDepth), [1, 1])
    assert.deepEqual(enriched.annotations.map((entry) => entry.id), ['a1', 'a2'])
  })
})
