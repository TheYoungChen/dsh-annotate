/**
 * Unit tests for the service worker's frame-path resolution.
 *
 * These run under `node --test` with no browser and no extension host: the
 * module under test takes its frame tree as an argument, so every case here is a
 * plain data question rather than a platform one.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAX_FRAME_DEPTH,
  NO_PARENT,
  isFrameId,
  resolveFramePath,
  toFrameNodes,
  type FrameNode,
} from '../extension/src/background/frames.ts'

/** Build a frame node with the top-level default filled in. */
function node(frameId: number, parentFrameId: number = NO_PARENT, url?: string): FrameNode {
  return url === undefined ? { frameId, parentFrameId } : { frameId, parentFrameId, url }
}

describe('isFrameId', () => {
  it('accepts zero and positive integers', () => {
    assert.equal(isFrameId(0), true)
    assert.equal(isFrameId(7), true)
  })

  it('rejects sentinels, fractions and non-numbers', () => {
    assert.equal(isFrameId(NO_PARENT), false)
    assert.equal(isFrameId(1.5), false)
    assert.equal(isFrameId('3'), false)
    assert.equal(isFrameId(null), false)
    assert.equal(isFrameId(Number.NaN), false)
  })
})

describe('toFrameNodes', () => {
  it('returns an empty list when the tab is gone', () => {
    assert.deepEqual(toFrameNodes(undefined), [])
  })

  it('treats a missing parent pointer as a top-level document', () => {
    const nodes = toFrameNodes([{ frameId: 4, parentFrameId: undefined as unknown as number }])
    assert.deepEqual(nodes, [{ frameId: 4, parentFrameId: NO_PARENT, url: undefined }])
  })

  it('skips entries with an unusable frame id instead of failing the batch', () => {
    const nodes = toFrameNodes([node(0), { frameId: -2, parentFrameId: 0 }])
    assert.deepEqual(nodes.map((entry) => entry.frameId), [0])
  })
})

describe('resolveFramePath', () => {
  const tree: FrameNode[] = [
    node(0, NO_PARENT, 'https://example.com/page'),
    node(3, 0, 'https://widget.example.net/embed'),
    node(7, 3, 'about:blank'),
  ]

  it('reports a top-level document as depth 0', () => {
    const path = resolveFramePath(tree, 0)
    assert.equal(path.depth, 0)
    assert.equal(path.isTop, true)
    assert.equal(path.complete, true)
    assert.deepEqual(path.chain, [0])
  })

  it('counts ancestors rather than frames seen', () => {
    assert.equal(resolveFramePath(tree, 3).depth, 1)
    assert.equal(resolveFramePath(tree, 7).depth, 2)
  })

  it('reports the chain outermost first', () => {
    assert.deepEqual(resolveFramePath(tree, 7).chain, [0, 3, 7])
  })

  it('labels a chain with hosts, marking the top-level segment', () => {
    assert.equal(resolveFramePath(tree, 7).label, 'top:example.com > widget.example.net > about:blank')
  })

  it('marks a frame the tree does not contain as incomplete', () => {
    const path = resolveFramePath(tree, 99)
    assert.equal(path.complete, false)
    assert.equal(path.depth, 1)
    assert.deepEqual(path.chain, [99])
  })

  it('marks a chain whose ancestor is missing as incomplete', () => {
    const orphan = [node(0, NO_PARENT, 'https://example.com'), node(5, 42, 'https://a.example')]
    const path = resolveFramePath(orphan, 5)
    assert.equal(path.complete, false)
    // Frame 5's parent (42) is unknown, so 5 sits at least one level down.
    assert.equal(path.depth, 2)
  })

  it('stops at a cycle instead of looping forever', () => {
    const cyclic = [node(0, NO_PARENT, 'https://example.com'), node(1, 2), node(2, 1)]
    const path = resolveFramePath(cyclic, 1)
    assert.equal(path.complete, false)
    assert.ok(path.depth <= MAX_FRAME_DEPTH)
    assert.ok(path.chain.length <= MAX_FRAME_DEPTH + 1)
  })

  it('treats a frame that is its own parent as a top-level document', () => {
    const selfParent = [node(0, 0, 'https://example.com')]
    assert.equal(resolveFramePath(selfParent, 0).isTop, true)
  })

  it('never returns an empty label', () => {
    assert.equal(resolveFramePath([], 12).label, '#12')
  })

  it('caps a pathologically deep chain', () => {
    const deep: FrameNode[] = [node(0, NO_PARENT, 'https://example.com')]
    for (let id = 1; id <= MAX_FRAME_DEPTH + 8; id += 1) deep.push(node(id, id - 1))
    const path = resolveFramePath(deep, MAX_FRAME_DEPTH + 8)
    assert.ok(path.chain.length <= 16)
    assert.ok(path.depth <= MAX_FRAME_DEPTH)
  })

  it('keeps the innermost frame as the last chain entry when truncating', () => {
    const deep: FrameNode[] = [node(0, NO_PARENT, 'https://example.com')]
    for (let id = 1; id <= 24; id += 1) deep.push(node(id, id - 1))
    const path = resolveFramePath(deep, 24)
    assert.equal(path.chain.at(-1), 24)
  })

  it('resolves against the tree it is given rather than a cached one', () => {
    const first = resolveFramePath(tree, 7)
    const second = resolveFramePath([node(0, NO_PARENT, 'https://other.example')], 7)
    assert.equal(first.depth, 2)
    assert.equal(second.complete, false)
  })
})
