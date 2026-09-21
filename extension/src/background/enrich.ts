/**
 * Turning a page-side batch into the batch the bridge receives.
 *
 * The one thing that has to happen here is the frame depth. A content script
 * cannot compute it: its view of its ancestors stops at the first cross-origin
 * boundary, which is the normal case for an embedded widget, so the value it
 * sends is a lower bound rather than a depth. The service worker is the only
 * context holding the browser's own frame tree, so it replaces the estimate
 * before the batch goes anywhere.
 *
 * The estimate is kept rather than overwritten. Two numbers that disagree are
 * evidence — of a frame tree read that raced a navigation, or of a page-side
 * depth function that has drifted — and evidence that has been overwritten is
 * gone. Keeping it also costs one small field.
 *
 * This module is separate from the worker entry point so that it can be tested
 * without a browser: `index.ts` registers platform listeners at module load, and
 * importing it outside a service worker throws before any test can run.
 *
 * @module
 */

import type { AnnotationBatch, ElementFacts } from '../../../src/protocol.ts'
import type { FramePath } from './frames.ts'

/**
 * Facts as they leave the worker: the protocol's fields, plus the frame
 * provenance the worker is uniquely able to supply.
 *
 * Declared as an extension of {@link ElementFacts} rather than by editing the
 * protocol, because the protocol is shared with the DSH side and a field only
 * the browser extension can produce does not belong in it.
 */
export interface EnrichedFacts extends ElementFacts {
  /** Stable frame id within the tab. Absent on a batch the worker did not touch. */
  frameId?: number
  /** Readable ancestry, outermost first, e.g. `top:example.com > widget.example.net`. */
  framePath?: string
  /** The depth the content script estimated, kept for comparison. */
  reportedFrameDepth?: number
}

/** A batch carrying the worker's frame provenance. */
export interface EnrichedBatch extends Omit<AnnotationBatch, 'annotations'> {
  annotations: Array<{
    id: string
    facts: EnrichedFacts
    comment?: string
    pickedAt: number
  }>
}

/**
 * Stamp every annotation in a batch with the resolved frame path.
 *
 * @param batch - the batch as received from a content script.
 * @param path - the resolved path of the frame that sent it.
 * @returns a new batch. The input is not modified, so a caller that logs what it
 *   received still sees what actually arrived.
 */
export function enrichBatch(batch: AnnotationBatch, path: FramePath): EnrichedBatch {
  return {
    ...batch,
    annotations: batch.annotations.map((annotation) => ({
      ...annotation,
      facts: {
        ...annotation.facts,
        // The authoritative value, which the page-side code cannot compute
        // across an origin boundary and must not be trusted to self-report.
        frameDepth: path.depth,
        frameId: path.frameId,
        framePath: path.label,
        reportedFrameDepth: annotation.facts.frameDepth,
      },
    })),
  }
}
