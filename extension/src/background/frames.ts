/**
 * Frame identity: where a message came from, and how deep that frame really is.
 *
 * A content script runs once per frame and knows almost nothing about its own
 * position. It can see `window.parent` but not the frame ids the browser uses,
 * and walking ancestors through `window.parent` stops at the first cross-origin
 * boundary — which is the common case, because an embedded widget is normally
 * served from somewhere else. The value a content script can compute on its own
 * is therefore a lower bound (`0` for a top document, `1` for anything it cannot
 * see past) rather than a depth.
 *
 * The extension's service worker is the only context with the authoritative
 * answer, because `webNavigation` exposes the browser's real frame tree,
 * including frames in other processes. This module turns that tree into the two
 * things the rest of the extension needs: a depth, and a readable path.
 *
 * The tree is keyed by a parent pointer rather than by depth, so every lookup
 * walks the chain upwards with an explicit bound. A page cannot choose its own
 * frame ids, but a hostile tree must still not be able to turn a lookup into an
 * unbounded loop, and the walk is written so that assumption is not load-bearing.
 *
 * @module
 */

/**
 * `parentFrameId` value the browser uses for a document that has no parent.
 *
 * Declared here rather than read from an API constant because there is no API
 * constant for it: it is part of the frame tree's shape.
 */
export const NO_PARENT = -1

/**
 * Upper bound on an ancestry walk.
 *
 * Real pages nest a handful of levels; the ceiling exists so that a malformed
 * tree — a cycle, or a parent that never terminates — degrades into a truncated
 * answer instead of a hung service worker.
 */
export const MAX_FRAME_DEPTH = 32

/** Most path steps kept, so one annotation cannot carry an unbounded label. */
const MAX_PATH_SEGMENTS = 16

/** Most characters kept per path segment, so a long query string cannot bloat it. */
const MAX_SEGMENT_LENGTH = 60

/** One frame, reduced to the two pointers a path is made of. */
export interface FrameNode {
  /** The frame's id within its tab. */
  readonly frameId: number
  /** Its parent's id, or {@link NO_PARENT}. */
  readonly parentFrameId: number
  /** Its document URL when the browser reports one. */
  readonly url?: string | undefined
}

/**
 * A frame resolved against its tab's tree.
 *
 * The two depth fields are deliberately separate. A page can claim any
 * `frameDepth` it likes in the payload it sends, so the value the worker derived
 * itself is kept apart from the value that arrived, and a reader can tell that
 * the second is untrusted.
 */
export interface FramePath {
  /** Frame id this path was resolved for. */
  readonly frameId: number
  /** Parent frame id, or {@link NO_PARENT} for a top-level document. */
  readonly parentFrameId: number
  /**
   * Authoritative depth: `0` for a top-level document, one more than the parent
   * for anything nested.
   */
  readonly depth: number
  /** True when this frame is the tab's top-level document. */
  readonly isTop: boolean
  /**
   * Ancestor frame ids, outermost first, ending with this frame.
   *
   * Ends here rather than starting here because a consumer rendering
   * "top > inner > innermost" wants the outermost first, and reversing a list at
   * every call site is how the two ends get mixed up.
   */
  readonly chain: readonly number[]
  /** Readable form of {@link chain}, e.g. `top > #3 > #7`. */
  readonly label: string
  /**
   * False when the tree the path was resolved against did not contain this frame
   * or any of its ancestors, which means the answer is a lower bound.
   *
   * This happens routinely rather than exceptionally: a frame can navigate
   * between the message being sent and the tree being read. Reporting it lets a
   * consumer distinguish "depth 1" from "at least depth 1, tree unavailable".
   */
  readonly complete: boolean
}

/**
 * Whether a value is a frame id the browser could have issued.
 *
 * Frame ids are non-negative; {@link NO_PARENT} and any other negative value is
 * a sentinel. Message payloads arrive from a page-adjacent runtime, so the check
 * runs before the value reaches a lookup.
 *
 * @param value - candidate frame id.
 * @returns whether the value is a plausible frame id.
 */
export function isFrameId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Reduce whatever `webNavigation` returned to the nodes this module uses.
 *
 * The API's own type says each entry has both pointers, but the worker is the
 * only place that can check, and a drop here is cheaper than a wrong depth
 * downstream. Entries that fail the check are skipped rather than fatal: a
 * partial tree still yields correct depths for everything it does contain.
 *
 * @param frames - raw result, possibly `undefined` when the tab has gone.
 * @returns the usable nodes, in the order given.
 */
export function toFrameNodes(frames: readonly FrameNode[] | undefined): FrameNode[] {
  if (frames === undefined) return []
  const nodes: FrameNode[] = []
  for (const frame of frames) {
    if (!isFrameId(frame.frameId)) continue
    // A frame whose parent pointer is missing is treated as a top-level
    // document: that is what NO_PARENT means, and inventing a parent would put
    // the frame at a depth nobody can justify.
    const parentFrameId = isFrameId(frame.parentFrameId) ? frame.parentFrameId : NO_PARENT
    nodes.push({ frameId: frame.frameId, parentFrameId, url: frame.url })
  }
  return nodes
}

/**
 * Index a frame list by frame id, keeping the first entry for a duplicate id.
 *
 * @param nodes - nodes from {@link toFrameNodes}.
 * @returns a lookup keyed by frame id.
 */
function indexByFrameId(nodes: readonly FrameNode[]): Map<number, FrameNode> {
  const byId = new Map<number, FrameNode>()
  for (const node of nodes) {
    if (!byId.has(node.frameId)) byId.set(node.frameId, node)
  }
  return byId
}

/**
 * Build a short readable label for one frame in the chain.
 *
 * The URL is only ever used for a path segment, never for the annotation's page
 * context — that comes from the content script, which can read the real
 * `location`. A frame the browser did not describe gets a positional marker
 * instead, so the label stays unambiguous without inventing content.
 *
 * @param node - the frame to describe, when the tree contained it.
 * @param frameId - the frame id, used when no node was found.
 * @returns a segment such as `top`, `example.com/embed`, or `#7`.
 */
function describeSegment(node: FrameNode | undefined, frameId: number): string {
  if (node === undefined) return `#${frameId}`
  const raw = node.url ?? ''
  if (raw === '') return node.parentFrameId === NO_PARENT ? 'top' : `#${frameId}`
  const host = hostOf(raw)
  const prefix = node.parentFrameId === NO_PARENT ? 'top:' : ''
  const text = host ?? raw
  return `${prefix}${clip(text)}`
}

/**
 * The host of a URL, or `undefined` when it is not a URL this project handles.
 *
 * `about:blank`, `data:` and `blob:` frames are real and common (an injected
 * iframe starts blank), and they have no host worth showing, so they fall
 * through to the raw string.
 *
 * @param url - the frame's URL.
 * @returns the host, or `undefined`.
 */
function hostOf(url: string): string | undefined {
  try {
    const host = new URL(url).host
    return host === '' ? undefined : host
  } catch {
    return undefined
  }
}

/**
 * Truncate a path segment to the module's bound.
 *
 * @param text - the segment text.
 * @returns the text, clipped with an ellipsis when it was too long.
 */
function clip(text: string): string {
  return text.length <= MAX_SEGMENT_LENGTH ? text : `${text.slice(0, MAX_SEGMENT_LENGTH - 1)}…`
}

/**
 * Resolve one frame against its tab's frame tree.
 *
 * The walk goes upwards from the frame, so it costs one map lookup per ancestor
 * and never touches frames that are not on the path. A frame id that is not in
 * the tree is still resolved: the caller gets `complete: false` and a depth
 * derived from whatever part of the chain was visible, because refusing to answer
 * would turn a routine race into a missing field.
 *
 * @param nodes - the tab's frames, from {@link toFrameNodes}.
 * @param frameId - the frame to resolve.
 * @returns the frame's path. Never throws.
 */
export function resolveFramePath(nodes: readonly FrameNode[], frameId: number): FramePath {
  const byId = indexByFrameId(nodes)

  const reversed: number[] = []
  const seen = new Set<number>()
  let cursor: number = frameId
  let complete = true
  let parentOfFrame = NO_PARENT
  /**
   * Whether the walk actually reached a document with no parent.
   *
   * Tracked during the walk rather than inferred from the resulting chain,
   * because the chain is truncated at {@link MAX_PATH_SEGMENTS} and a truncated
   * chain's first entry is not necessarily the top document. Inferring `isTop`
   * from the chain would report a frame 40 levels down as top-level. It is also
   * NOT the same as "has no parent pointer": a frame whose entry is missing from
   * the tree has no known parent either, and calling that top-level would claim
   * the frame is the page itself.
   */
  let reachedTop = false
  /**
   * How many ancestors the walk confirmed, i.e. the frame's depth.
   *
   * Counted directly for the same reason: `chain.length` is a truncated view,
   * and the reported depth has to be the real one.
   */
  let depth = 0

  for (let step = 0; step <= MAX_FRAME_DEPTH; step += 1) {
    // A frame id appearing twice means the tree is cyclic. The worker must
    // answer rather than spin, so the loop stops and the answer is marked
    // incomplete instead of silently wrong.
    if (seen.has(cursor)) {
      complete = false
      break
    }
    seen.add(cursor)
    reversed.push(cursor)

    const node = byId.get(cursor)
    if (node === undefined) {
      // The chain ends at a frame the browser did not describe, so anything
      // above it is unknown. That includes this frame's own parentage, which is
      // why the walk counts one more level: an undescribed ancestor exists, or
      // the frame would have been in the tree.
      complete = false
      depth += 1
      break
    }
    if (step === 0) parentOfFrame = node.parentFrameId
    // A top-level document, or a self-referential parent that would otherwise
    // loop. Both mean "the walk ends here", and neither has a real ancestor.
    if (node.parentFrameId === NO_PARENT || node.parentFrameId === cursor) {
      reachedTop = true
      break
    }

    depth += 1
    cursor = node.parentFrameId
    if (step === MAX_FRAME_DEPTH) {
      // Ran out of budget with ancestors still to visit.
      complete = false
      depth += 1
    }
  }

  const isTop = reachedTop && depth === 0
  // `reversed` is innermost-first because the walk climbs; a path reads
  // outermost-first, so it is reversed once here rather than at every consumer.
  const full = reversed.slice().reverse()
  const chain = full.length > MAX_PATH_SEGMENTS ? full.slice(full.length - MAX_PATH_SEGMENTS) : full

  const label = chain.map((id) => describeSegment(byId.get(id), id)).join(' > ')

  return {
    frameId,
    parentFrameId: parentOfFrame,
    // An undescribed frame still has an ancestor, so its depth is never 0.
    depth: isTop ? 0 : Math.min(Math.max(depth, 1), MAX_FRAME_DEPTH),
    isTop,
    chain,
    label: label === '' ? `#${frameId}` : label,
    complete,
  }
}
