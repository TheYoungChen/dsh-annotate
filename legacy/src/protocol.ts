/**
 * The annotation data model shared by the extension, the bridge and the plugin.
 *
 * This module is the contract every other part of dsh-annotate codes against, so
 * it is deliberately dependency-free: the service worker, the page content
 * script and the Node-side bridge all import the same file and none of them may
 * add an import that only one runtime can resolve.
 *
 * The shape follows two rules learned from comparable tools:
 *
 * 1. Facts are bounded. An element contributes a fixed, small set of fields, and
 *    text is truncated. A page must never be able to turn one click into an
 *    unbounded payload.
 * 2. Facts are data, never instructions. Everything a page contributes arrives
 *    under {@link ElementFacts}, and consumers must treat it as untrusted input.
 *
 * @module
 */

/** Protocol version. Bump when a change would break an older counterpart. */
export const PROTOCOL_VERSION = 1 as const

/** Default loopback port. 43119 is taken by a comparable plugin; ours is 43120. */
export const DEFAULT_PORT = 43120

/** Longest visible-text excerpt kept for one element. */
export const MAX_TEXT_LENGTH = 120

/** Most characters kept for a user's own comment. */
export const MAX_COMMENT_LENGTH = 4000

/** Most elements one batch may carry. */
export const MAX_ELEMENTS_PER_BATCH = 50

/** CSS properties worth reporting. A whitelist keeps the payload predictable. */
export const REPORTED_STYLE_PROPERTIES = [
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'border',
  'border-radius',
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'line-height',
  'opacity',
  'overflow',
  'z-index',
  'flex-direction',
  'justify-content',
  'align-items',
  'gap',
  'grid-template-columns',
  'visibility',
  'cursor',
] as const

/** Where an annotation came from, so the reader can weigh it correctly. */
export type PageKind = 'http' | 'https' | 'file'

/** An element's box in viewport coordinates. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** One step in a framework's component chain, outermost first. */
export interface ComponentLink {
  /** Component name as the framework reports it, or `Anonymous`. */
  name: string
  /** Source file when the framework exposes one and it is not minified. */
  file?: string
}

/**
 * Everything captured about one picked element.
 *
 * Every field is optional except the ones a reader needs to locate the element:
 * a consumer that receives only `tag` and `selector` must still cope.
 */
export interface ElementFacts {
  /** Lowercase tag name. */
  tag: string
  /** CSS selector that resolves to this element, with a match count. */
  selector: string
  /** How many elements that selector matches. `1` means it is unambiguous. */
  selectorMatches: number
  /** Absolute XPath, as a fallback when the selector is fragile. */
  xpath?: string
  /** Position and size at capture time, in viewport coordinates. */
  rect: Rect
  /** Whether the element was inside the viewport when picked. */
  inViewport: boolean
  /** ARIA role, computed the same way assistive technology computes it. */
  role?: string
  /** Accessible name, when one can be derived. */
  name?: string
  /** Visible text, truncated to {@link MAX_TEXT_LENGTH}. */
  text?: string
  /** Current value for form controls. Never captured for sensitive fields. */
  value?: string
  /** Whether a form control is disabled. */
  disabled?: boolean
  /** Checked state for checkboxes and radios. */
  checked?: boolean
  /** Selected attributes worth reporting, filtered against a safe list. */
  attributes?: Record<string, string>
  /** Reporting CSS properties, resolved values only. */
  styles?: Record<string, string>
  /** Framework component chain, outermost first. */
  components?: ComponentLink[]
  /** How deep the element sits in its frame tree. `0` is the top document. */
  frameDepth: number
  /** Selected ancestor chain, outermost first, as `tag.class` strings. */
  ancestors?: string[]
}

/** One annotation: an element plus whatever the user said about it. */
export interface Annotation {
  /** Stable id, unique within a batch. */
  id: string
  facts: ElementFacts
  /** The user's comment. Absent when they sent the element without one. */
  comment?: string
  /** When the element was picked, as an epoch millisecond value. */
  pickedAt: number
}

/** Where a batch was collected, so the reader knows which page it describes. */
export interface PageContext {
  /** Full page URL at capture time. */
  url: string
  /** Page title, truncated. */
  title?: string
  /** Which family of address this was, so `file://` is never mistaken for a site. */
  kind: PageKind
  /** Viewport size at capture time. */
  viewport: { width: number; height: number }
  /** Device pixel ratio, so a reader can reconcile coordinates with a screenshot. */
  devicePixelRatio?: number
}

/** A batch of annotations, sent as one unit. */
export interface AnnotationBatch {
  version: typeof PROTOCOL_VERSION
  /** Batch id, so a retry can be recognised as the same submission. */
  batchId: string
  /** DSH session this batch belongs to. Set by the plugin, not the extension. */
  sessionId?: string
  page: PageContext
  annotations: Annotation[]
  /** When the batch was submitted, as an epoch millisecond value. */
  submittedAt: number
}

// ---------------------------------------------------------------------------
// Bridge messages
// ---------------------------------------------------------------------------

/** Messages the extension sends to the bridge. */
export type ExtensionMessage =
  | { type: 'hello'; version: typeof PROTOCOL_VERSION; token: string; extensionId: string }
  | { type: 'submit'; batch: AnnotationBatch }
  | { type: 'ping' }
  | { type: 'page-picked'; tabId: number; url: string; title: string }

/** Messages the bridge sends to the extension. */
export type BridgeMessage =
  | { type: 'welcome'; version: typeof PROTOCOL_VERSION; sessionId: string | null }
  | { type: 'rejected'; reason: 'token' | 'version' | 'rate-limit' }
  | { type: 'pong' }
  | { type: 'start-picking'; tabId?: number }
  | { type: 'stop-picking' }
  | { type: 'submit-ack'; batchId: string; ok: boolean; message?: string }
  | { type: 'settings'; allowOnline: boolean }

/** Either direction, for a relay that does not need to care which is which. */
export type BridgeEnvelope = ExtensionMessage | BridgeMessage

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Whether a value is a non-null object, narrowed for guard use. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Whether a value is a usable batch.
 *
 * The bridge runs this on everything arriving from a page-adjacent runtime, so it
 * checks shape rather than trust: a batch that fails here is dropped rather than
 * partially processed.
 */
export function isAnnotationBatch(value: unknown): value is AnnotationBatch {
  if (!isRecord(value)) return false
  if (value.version !== PROTOCOL_VERSION) return false
  if (typeof value.batchId !== 'string' || value.batchId.length === 0) return false
  if (typeof value.submittedAt !== 'number') return false
  if (!isPageContext(value.page)) return false
  if (!Array.isArray(value.annotations)) return false
  if (value.annotations.length > MAX_ELEMENTS_PER_BATCH) return false
  return value.annotations.every(isAnnotation)
}

/** Whether a value carries the fields a reader needs to place a page. */
export function isPageContext(value: unknown): value is PageContext {
  if (!isRecord(value)) return false
  if (typeof value.url !== 'string' || value.url.length === 0) return false
  if (value.kind !== 'http' && value.kind !== 'https' && value.kind !== 'file') return false
  const viewport = value.viewport
  if (!isRecord(viewport)) return false
  if (typeof viewport.width !== 'number' || typeof viewport.height !== 'number') return false
  return true
}

/** Whether a value is a well-formed annotation carrying usable facts. */
export function isAnnotation(value: unknown): value is Annotation {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || value.id.length === 0) return false
  if (typeof value.pickedAt !== 'number') return false
  if (value.comment !== undefined && typeof value.comment !== 'string') return false
  return isElementFacts(value.facts)
}

/** Whether a value carries the minimum an element needs to be located. */
export function isElementFacts(value: unknown): value is ElementFacts {
  if (!isRecord(value)) return false
  if (typeof value.tag !== 'string' || value.tag.length === 0) return false
  if (typeof value.selector !== 'string') return false
  if (typeof value.selectorMatches !== 'number') return false
  if (typeof value.frameDepth !== 'number') return false
  const rect = value.rect
  if (!isRecord(rect)) return false
  return (
    typeof rect.x === 'number' &&
    typeof rect.y === 'number' &&
    typeof rect.width === 'number' &&
    typeof rect.height === 'number' &&
    typeof value.inViewport === 'boolean'
  )
}

/** Whether an address is one this extension may annotate. */
export function pageKindOf(url: string): PageKind | null {
  if (url.startsWith('https://')) return 'https'
  if (url.startsWith('http://')) return 'http'
  // Windows drive letters arrive as `file:///C:/...`, so a bare `file://` prefix
  // is the whole test here.
  if (url.startsWith('file://')) return 'file'
  return null
}

/** Whether an address is loopback, and so never needs the online-access gate. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}
