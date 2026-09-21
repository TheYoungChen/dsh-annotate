/**
 * The three view states the panel can be in, and the rules that choose between
 * them.
 *
 * Derived from a {@link PanelSnapshot} by a pure function so the interesting
 * question — "what does the user see when the page went away mid-annotation?" —
 * is answerable in a test rather than by opening a browser.
 *
 * @module
 */

import type { PanelSnapshot } from './store.ts'

/**
 * What the panel is showing.
 *
 * `unavailable` is a first-class state rather than an error message tucked
 * inside `idle`: on a browser-internal page there is no content script, and no
 * amount of retrying changes that. The user needs to be told to move to a page
 * they *can* annotate, which is a different instruction from "nothing here yet".
 */
export type ViewState = 'unavailable' | 'idle' | 'picking' | 'annotating'

/**
 * Why the panel cannot reach a page.
 *
 * `null` is part of this type rather than a separate "unknown" member because
 * callers hold it as a rolling variable: it is set when a call fails and cleared
 * when one succeeds, and a third sentinel value would only have to be translated
 * back into "no reason" at every read.
 */
export type UnavailableReason = 'no-tab' | 'unsupported-url' | 'no-receiver' | null

/** Everything the renderer needs, in one immutable value. */
export interface PanelView {
  state: ViewState
  /** Set when {@link PanelView.state} is `unavailable`. */
  unavailableReason: UnavailableReason | null
  /** Whether the page was reached and reported itself. */
  pageUrl: string | null
  pageTitle: string | null
  /** True when there is a pending pick waiting for a comment. */
  hasPendingPick: boolean
  rowCount: number
  canSubmit: boolean
  submitting: boolean
  /** Message from the last submission, or `null`. */
  result: string | null
  /** Whether the result line should offer a retry. */
  retryable: boolean
}

/**
 * Choose the view state.
 *
 * The order of the branches is the whole logic:
 *
 * 1. An unreachable page outranks everything. Picking cannot start there, so
 *    showing a picking state would be showing a lie.
 * 2. A live picking session outranks a pending pick. The user can hover from a
 *    row and start picking again without having written anything, and the
 *    banner has to describe what the page is doing right now.
 * 3. A pending pick means the user is mid-sentence, which deserves the composer
 *    even when the list is empty.
 * 4. Otherwise the list is the interface, with the empty state inside it.
 *
 * @param snapshot - the store's current state.
 * @param available - whether the bound tab answered.
 * @param reason - why it did not, when it did not.
 * @returns the view state and the derived flags a render needs.
 */
export function deriveView(
  snapshot: PanelSnapshot,
  available: boolean,
  reason: UnavailableReason | null = null,
): PanelView {
  const state = chooseState(snapshot, available)
  return {
    state,
    unavailableReason: state === 'unavailable' ? reason : null,
    pageUrl: snapshot.page?.url ?? null,
    pageTitle: snapshot.page?.title ?? null,
    hasPendingPick: snapshot.currentElementId !== null && snapshot.currentFacts !== null,
    rowCount: snapshot.annotations.length,
    // A batch with nothing in it is not a batch. Submitting an empty list would
    // ask the bridge to render a page header for zero annotations.
    canSubmit: snapshot.annotations.length > 0 && !snapshot.submitting,
    submitting: snapshot.submitting,
    result: snapshot.lastResult,
    retryable: snapshot.retryable,
  }
}

/** Pick the state, given the snapshot and whether the page answered. */
function chooseState(snapshot: PanelSnapshot, available: boolean): ViewState {
  if (!available) return 'unavailable'
  if (snapshot.picking) return 'picking'
  if (snapshot.currentElementId !== null) return 'annotating'
  return 'idle'
}

/** The label for the primary button in each state. */
export function primaryActionLabel(state: ViewState): string {
  switch (state) {
    case 'picking':
      return 'Stop picking'
    case 'annotating':
      return 'Pick another element'
    case 'idle':
      return 'Start annotating'
    case 'unavailable':
      return 'Start annotating'
  }
}

/** The instruction shown while picking mode is armed. */
export const PICKING_HINT = 'Click an element on the page to select it. Press Esc there to leave picking mode.'

/** What the panel says when it cannot reach a page at all. */
export function unavailableMessage(reason: UnavailableReason | null): string {
  switch (reason) {
    case 'no-tab':
      return 'No active tab. Open a page, then reopen this panel.'
    case 'unsupported-url':
      return 'This page cannot be annotated. Open an http, https or local file page.'
    case 'no-receiver':
      return 'This tab is not reachable yet. Reload the page, then pick again.'
    default:
      return 'This page is not reachable.'
  }
}
