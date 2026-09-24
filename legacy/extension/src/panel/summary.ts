/**
 * Turning element facts into the one line a list row shows.
 *
 * A row has room for a tag, a locator and a fragment of text, and the panel
 * shows up to fifty of them in a 320px column. Everything here is therefore
 * about choosing what to drop: which locator is worth the width, how much text
 * survives, and how to hint that the full facts are one click away.
 *
 * @module
 */

import type { ElementFacts } from '../../../src/protocol.ts'
import { SUMMARY_TEXT_LENGTH } from './store.ts'

/** The three parts of a row summary. */
export interface ElementSummary {
  /** The tag name, e.g. `button`, as its own field so the UI can style it. */
  tag: string
  /** The best locator this element has, already trimmed for width. */
  locator: string
  /** A short excerpt of the element's text, or `null` when it has none. */
  text: string | null
  /** True when {@link locator} is a generated path rather than an authored one. */
  locatorIsFragile: boolean
}

/** Longest locator kept for a row, in characters. */
const LOCATOR_LENGTH = 48

/**
 * Summarise one element for a list row.
 *
 * The locator comes from the facts' own selector, which the page already
 * verified against the live document; the panel only shortens it for display and
 * never re-parses it, because it has no document to check a selector against.
 *
 * Fragility is reported rather than hidden. A selector built from an id or a
 * test handle survives a re-render and is worth showing with confidence; a
 * structural `nth-of-type` path is true only right now, and the user is the one
 * who needs to know that before they describe a change to a model that will act
 * on it.
 *
 * @param facts - the facts captured for one element.
 * @returns the row summary.
 */
export function summariseElement(facts: ElementFacts): ElementSummary {
  const selector = facts.selector.trim()
  const locator = selector === '' ? '(no selector)' : truncate(selector, LOCATOR_LENGTH)
  return {
    tag: facts.tag === '' ? 'unknown' : facts.tag,
    locator,
    text: excerpt(facts.text),
    locatorIsFragile: selector === '' || facts.selectorMatches !== 1,
  }
}

/**
 * A one-line excerpt of an element's text.
 *
 * Newlines are collapsed rather than preserved: a `<pre>` or a wrapped paragraph
 * would otherwise turn one row into a block and push the rest of the list off
 * the screen, which costs the user the one thing the list is for.
 *
 * @param text - the element's text, if it had any.
 * @returns the excerpt, or `null` when there is nothing to show.
 */
function excerpt(text: string | undefined): string | null {
  if (text === undefined) return null
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return null
  return truncate(collapsed, SUMMARY_TEXT_LENGTH)
}

/**
 * Shorten a string for display, marking the cut.
 *
 * Counted in code points rather than UTF-16 units so an emoji or a CJK glyph at
 * the boundary is not split into a replacement character.
 *
 * @param text - the full string.
 * @param max - the longest result allowed, including the ellipsis.
 * @returns the shortened string.
 */
function truncate(text: string, max: number): string {
  const points = [...text]
  if (points.length <= max) return text
  return `${points.slice(0, Math.max(1, max - 1)).join('')}…`
}

/**
 * A short label for the page a batch came from.
 *
 * @param url - the page's address.
 * @returns the hostname, or the URL itself when it is not a parsable address
 *   (a `file://` path is, but a page may report anything).
 */
export function pageLabel(url: string | null): string | null {
  if (url === null || url === '') return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') {
      const segments = parsed.pathname.split('/').filter((segment) => segment !== '')
      return segments[segments.length - 1] ?? 'local file'
    }
    return parsed.hostname
  } catch {
    return url
  }
}

/**
 * Format an epoch millisecond value as a wall-clock time.
 *
 * Rendered in the user's own locale: the timestamp tells them when they wrote a
 * row, and a fixed format would be a small daily irritant in a tool they keep
 * open. A value the clock cannot represent degrades to an empty string rather
 * than to `Invalid Date` on screen.
 *
 * @param epochMs - milliseconds since the epoch.
 * @param locale - locale tag; empty uses the environment default.
 * @returns the formatted time, or the empty string when it cannot be formatted.
 */
export function formatTime(epochMs: number, locale = ''): string {
  const date = new Date(epochMs)
  if (Number.isNaN(date.getTime())) return ''
  try {
    return new Intl.DateTimeFormat(locale === '' ? undefined : locale, {
      hour: '2-digit',
      minute: '2-digit',
    }).format(date)
  } catch {
    return ''
  }
}

/**
 * A human label for the size of an element's box.
 *
 * @param facts - the facts to measure.
 * @returns e.g. `96 × 32`, or `null` when the box has no area.
 */
export function formatSize(facts: ElementFacts): string | null {
  const width = Math.round(facts.rect.width)
  const height = Math.round(facts.rect.height)
  if (width <= 0 || height <= 0) return null
  return `${width} × ${height}`
}
