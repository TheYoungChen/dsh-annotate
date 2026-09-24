/**
 * DOM facts for one picked element: the model's entire view of what the user
 * pointed at.
 *
 * Unlike a page snapshot, which summarises a whole document, this module
 * describes exactly one `Element` so the model can reason about (and later
 * re-locate) the thing the user annotated. Three constraints shape every helper
 * below:
 *
 * 1. **Bounded output.** A page is hostile input. Text is truncated, ancestors
 *    are capped, and attributes and styles are filtered against whitelists, so a
 *    click can never turn into an unbounded payload. Every cap is a named
 *    constant rather than a literal buried in a loop.
 * 2. **Read-only.** Nothing here writes to the page. No attributes are stamped,
 *    no classes are added, no nodes are created. Pages watch their own DOM with
 *    `MutationObserver` and a stray attribute is enough to change a page's
 *    behaviour, so a locator has to be derived from what is already there.
 * 3. **A failure is local.** Page DOM is frequently malformed and frameworks
 *    install hostile getters on their own nodes. Each field is extracted inside
 *    its own guard, so one unreadable property degrades that field to
 *    `undefined` instead of losing the whole annotation. The fields a reader
 *    most needs in order to place the element — `tag`, `selector`, `rect` — are
 *    computed first and cannot be knocked out by a later failure.
 *
 * The privacy boundary lives in {@link module:'./privacy.ts'}; this module never
 * reads a form value without consulting it first.
 *
 * @module
 */

import type { ComponentLink, ElementFacts, Rect } from '../../../src/protocol.ts'
import { MAX_TEXT_LENGTH, REPORTED_STYLE_PROPERTIES } from '../../../src/protocol.ts'
import { isSensitiveField, maskValue } from './privacy.ts'

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Most attributes reported for one element. */
const MAX_ATTRIBUTES = 20

/** Longest value kept for one reported attribute, in characters. */
const MAX_ATTRIBUTE_VALUE_LENGTH = 200

/** Most ancestors reported, counted outward from the element's parent. */
const MAX_ANCESTORS = 5

/** Longest accessible name kept, in characters. */
const MAX_NAME_LENGTH = 80

/** Longest form value kept, in characters. */
const MAX_VALUE_LENGTH = 200

/** Most component links reported. Browser extensions never see production
 * source maps, so a deep React tree would otherwise dominate the payload. */
const MAX_COMPONENTS = 12

/** Longest component name kept, in characters. */
const MAX_COMPONENT_NAME_LENGTH = 60

/** Longest class name allowed into an ancestor label or a `tag.class` selector.
 * Framework-generated hashes blow past this and are not stable anyway. */
const MAX_CLASS_NAME_LENGTH = 24

/** Longest `tag.class` selector this module will build and trust. Beyond this
 * the structural path is shorter and no less stable. */
const MAX_CLASS_SELECTOR_LENGTH = 48

/** Longest id accepted as a selector anchor, in characters. */
const MAX_ID_LENGTH = 30

/** Guard on a numeric z-index, so a page cannot smuggle a huge number through
 * as `1e21` and produce a value no reader can compare. */
const MAX_Z_INDEX = 2_147_483_647

/** Upper bound on any ancestry walk, independent of the reported caps. Keeps a
 * pathological tree from turning a click into a long loop. */
const MAX_ANCESTRY_HOPS = 60

/** Most nodes visited while looking for the ids an element references. Scoped
 * lookups run per id, and `getElementById` is unavailable inside a shadow root. */
const MAX_ID_LOOKUP_NODES = 2000

/** Reported style properties, precomputed: the whitelist is fixed at build
 * time, so rebuilding it per element would be pure waste. */
const STYLE_PROPERTIES: readonly string[] = REPORTED_STYLE_PROPERTIES

/** Attributes a reader can act on. Anything absent from this list is
 * deliberately not reported: a full attribute dump leaks inline event handlers,
 * framework bookkeeping and page state that no consumer needs. */
const REPORTED_ATTRIBUTES: readonly string[] = [
  'id',
  'class',
  'data-testid',
  'data-test-id',
  'data-test',
  'data-cy',
  'data-qa',
  'name',
  'type',
  'role',
  'title',
  'alt',
  'placeholder',
  'href',
  'src',
  'target',
  'rel',
  'width',
  'height',
  'colspan',
  'rowspan',
  'lang',
  'dir',
  'tabindex',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-expanded',
  'aria-hidden',
  'aria-disabled',
  'aria-checked',
  'aria-selected',
  'aria-pressed',
  'aria-current',
  'aria-haspopup',
  'aria-controls',
  'aria-owns',
  'aria-live',
  'aria-modal',
  'aria-required',
  'aria-invalid',
  'aria-valuenow',
  'aria-valuemin',
  'aria-valuemax',
]

/** Attributes that name an element for a test harness, in preference order. */
const TEST_ID_ATTRIBUTES: readonly string[] = ['data-testid', 'data-test-id', 'data-cy', 'data-qa', 'data-test']

/** Implicit ARIA roles for tags whose role does not depend on attributes. */
const IMPLICIT_ROLES: Readonly<Record<string, string>> = {
  article: 'article',
  blockquote: 'blockquote',
  caption: 'caption',
  code: 'code',
  datalist: 'listbox',
  dd: 'definition',
  del: 'deletion',
  details: 'group',
  dfn: 'term',
  dialog: 'dialog',
  dt: 'term',
  em: 'emphasis',
  fieldset: 'group',
  figure: 'figure',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  hr: 'separator',
  html: 'document',
  iframe: 'iframe',
  ins: 'insertion',
  li: 'listitem',
  main: 'main',
  mark: 'mark',
  math: 'math',
  menu: 'list',
  meter: 'meter',
  nav: 'navigation',
  ol: 'list',
  optgroup: 'group',
  option: 'option',
  output: 'status',
  p: 'paragraph',
  progress: 'progressbar',
  strong: 'strong',
  sub: 'subscript',
  sup: 'superscript',
  table: 'table',
  tbody: 'rowgroup',
  td: 'cell',
  textarea: 'textbox',
  tfoot: 'rowgroup',
  thead: 'rowgroup',
  time: 'time',
  tr: 'row',
  ul: 'list',
}

/** Roles whose names the ARIA in HTML spec withholds unless the element is
 * focusable, hidden, or a heading. */
const NAME_FORBIDDEN_ROLES: ReadonlySet<string> = new Set(['presentation', 'none', 'generic'])

/** Role tokens valid in a `role` attribute that are not the implicit role of a
 * common tag, so the tag table cannot be used to validate them. */
const EXTRA_ROLE_TOKENS: ReadonlySet<string> = new Set([
  'alert', 'alertdialog', 'application', 'banner', 'cell', 'columnheader', 'complementary',
  'contentinfo', 'feed', 'form', 'generic', 'grid', 'gridcell', 'heading', 'img', 'link',
  'listbox', 'log', 'marquee', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'navigation', 'none', 'note', 'presentation', 'radiogroup', 'region', 'rowgroup', 'rowheader',
  'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'switch',
  'tab', 'tablist', 'tabpanel', 'term', 'textbox', 'timer', 'toolbar', 'tooltip', 'tree',
  'treegrid', 'treeitem',
])

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Whether a value is a non-null object, narrowed for guard use. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Whether a value is callable, without reaching for `any` or the ban-prone
 * `Function` type. */
function isCallable(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
}

/**
 * Whether a value is an instance of a global constructor, without assuming the
 * constructor exists.
 *
 * `value instanceof SomeGlobal` is not safe here for two independent reasons.
 * A page can delete or replace a global, which turns the expression into a
 * `TypeError` instead of a `false`; and an element from another realm is never
 * an instance of this realm's constructor even when it is exactly the right kind
 * of node. Both cases have to answer `false` rather than throw, because a thrown
 * error inside a field extractor silently drops that field.
 *
 * @param value - the value to test.
 * @param constructor - the global constructor, which may be missing entirely.
 * @returns `true` only when the constructor exists and `instanceof` succeeds.
 */
function isInstanceOf(value: unknown, constructor: unknown): boolean {
  if (typeof constructor !== 'function') return false
  try {
    return value instanceof (constructor as new (...args: never[]) => unknown)
  } catch {
    return false
  }
}

/**
 * Whether a value is an element.
 *
 * Duck-typing is the primary test rather than a fallback. `instanceof` alone is
 * not enough: an element living in another realm fails the check while still
 * being a perfectly good element, and that is not a corner case for this module,
 * because anything handed over from the page's world or from a frame with its
 * own globals arrives as a foreign `Element`. Duck-typing the members this
 * module actually calls keeps the test honest without weakening it into "any
 * object".
 */
function isElementLike(value: unknown): value is Element {
  if (!isRecord(value)) return false
  if (value['nodeType'] !== 1) return false
  return typeof value['nodeName'] === 'string' && isCallable(value['getAttribute'])
}

/** Whether a value is a shadow root, identified by shape rather than by brand. */
function isShadowRootLike(value: unknown): boolean {
  if (isInstanceOf(value, typeof ShadowRoot === 'undefined' ? undefined : ShadowRoot)) return true
  if (!isRecord(value)) return false
  // A shadow root has a host element and a queryable root node type (11).
  return value['nodeType'] === 11 && isElementLike(value['host'])
}

/** Whether a value is a document, identified by shape rather than by brand. */
function isDocumentLike(value: unknown): boolean {
  if (isRecord(value) && value['nodeType'] === 9) return true
  return typeof Document !== 'undefined' && value instanceof Document
}

/** A property of an arbitrary object, read as `unknown` and without throwing. */
function readProperty(target: object, key: string): unknown {
  try {
    return (target as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Field-level guards
// ---------------------------------------------------------------------------

/**
 * Run an extractor and fall back when the page defeats it.
 *
 * Wrapping each field individually is the whole reason a malformed page cannot
 * cost the user their annotation: only the failing field degrades, and the
 * fields that failed simply do not appear in the output.
 */
function attempt<T>(produce: () => T): T | undefined {
  try {
    return produce()
  } catch {
    return undefined
  }
}

/** Drop empty results instead of shipping a meaningless blank value. */
function present(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/** Drop empty collections rather than shipping `{}` or `[]`. */
function presentMap(value: Record<string, string> | undefined): Record<string, string> | undefined {
  return value === undefined || Object.keys(value).length === 0 ? undefined : value
}

/** Drop an empty list rather than shipping `[]`. */
function presentList<T>(value: T[] | undefined): T[] | undefined {
  return value === undefined || value.length === 0 ? undefined : value
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Extract everything an `ElementFacts` carries about one element.
 *
 * The function is a pure read: it never mutates the page, never forces layout it
 * did not ask for, and never throws. A field whose extraction fails is simply
 * absent, so a consumer receiving only `tag` and `selector` still has a usable
 * fact set.
 *
 * @param element - the element the user picked. Anything else yields the
 *   smallest valid fact set rather than an exception, because the picker UI must
 *   keep working on pages with exotic DOM.
 * @returns the bounded, privacy-filtered facts for that element.
 */
export function extractElementFacts(element: Element): ElementFacts {
  // Built up front so the return value always satisfies the contract, even when
  // the caller hands us something that is not an element at all.
  const facts: ElementFacts = {
    tag: '',
    selector: '',
    selectorMatches: 0,
    rect: { x: 0, y: 0, width: 0, height: 0 },
    inViewport: false,
    frameDepth: frameDepth(),
  }
  if (!isElementLike(element)) return facts

  // Ordered by value to a reader: what makes the element findable is filled in
  // before anything a hostile page could make throw.
  facts.rect = attempt(() => elementRect(element)) ?? facts.rect
  facts.tag = attempt(() => element.tagName.toLowerCase()) ?? ''
  facts.inViewport = attempt(() => inViewport(element)) === true

  const locator = attempt(() => buildSelector(element))
  facts.selector = locator?.selector ?? ''
  facts.selectorMatches = locator?.matches ?? 0
  facts.xpath = present(attempt(() => buildXPath(element)))
  facts.role = present(attempt(() => computeRole(element)))
  facts.name = present(attempt(() => truncate(accessibleName(element), MAX_NAME_LENGTH)))
  facts.text = present(attempt(() => truncate(visibleText(element), MAX_TEXT_LENGTH)))
  facts.attributes = presentMap(attempt(() => collectAttributes(element)))
  facts.styles = presentMap(attempt(() => collectStyles(element)))
  facts.ancestors = presentList(attempt(() => collectAncestors(element)))
  facts.components = presentList(attempt(() => collectComponents(element)))

  // Form state goes last and through the privacy gate. Nothing above may be the
  // reason a secret is or is not read.
  const form = attempt(() => collectFormState(element))
  if (form !== undefined) {
    facts.value = form.value
    facts.disabled = form.disabled
    facts.checked = form.checked
  }
  return facts
}

// ---------------------------------------------------------------------------
// Geometry and frame position
// ---------------------------------------------------------------------------

/** The element's viewport box, rounded to whole pixels: sub-pixel precision is
 * noise for a reader reconciling coordinates with a screenshot. */
function elementRect(el: Element): Rect {
  const rect = el.getBoundingClientRect()
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

/** Whether any part of the element is currently on screen. */
function inViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  const width = window.innerWidth || document.documentElement.clientWidth
  const height = window.innerHeight || document.documentElement.clientHeight
  const right = Number.isFinite(rect.right) ? rect.right : rect.left + rect.width
  const bottom = Number.isFinite(rect.bottom) ? rect.bottom : rect.top + rect.height
  return rect.left < width && right > 0 && rect.top < height && bottom > 0
}

/**
 * How deep the element sits in its frame tree, where `0` is the top document.
 *
 * A same-origin ancestor is countable, because reading `parent.document` is
 * allowed and cheap; a cross-origin ancestor throws and the walk stops, so the
 * answer is a lower bound rather than a guess. A content script cannot see its
 * own frame ids, so the authoritative depth comes from the extension's frame
 * routing; this value exists so a fact set is still self-describing when it is
 * read on its own.
 *
 * @returns the frame depth, at least `0`.
 */
export function frameDepth(): number {
  const measured = attempt(() => {
    if (window.top === window) return 0
    let depth = 1
    let current: Window = window
    while (current.parent !== current && depth < MAX_ANCESTORS + 1) {
      current = current.parent
      // Reading `document` across an origin boundary throws, which is exactly
      // where the count has to stop.
      if (current.document !== undefined && current === window.top) return depth
      depth += 1
    }
    return depth
  })
  return typeof measured === 'number' && measured >= 0 ? measured : 0
}

// ---------------------------------------------------------------------------
// Identity: role and accessible name
// ---------------------------------------------------------------------------

/**
 * The element's role as assistive technology computes it: an author-declared
 * `role` wins, then the implicit role for the tag (and for `<input type>`).
 */
function computeRole(el: Element): string {
  const declared = el.getAttribute('role')
  if (declared !== null) {
    const first = declared.trim().split(/\s+/)[0] ?? ''
    // AT ignores a role token it does not know, so an unknown token must fall
    // through to the implicit role rather than be reported as fact.
    if (first !== '' && isKnownRoleToken(first)) return first
  }

  const tag = el.tagName.toLowerCase()
  switch (tag) {
    case 'a':
    case 'area':
      return el.hasAttribute('href') ? 'link' : 'generic'
    case 'input':
      return roleOfInput(el)
    case 'img':
      return el.getAttribute('alt') === '' ? 'presentation' : 'img'
    case 'select':
      return el.hasAttribute('multiple') || numericAttribute(el, 'size') > 1 ? 'listbox' : 'combobox'
    case 'th':
      return (el.getAttribute('scope') ?? '').toLowerCase() === 'row' ? 'rowheader' : 'columnheader'
    case 'header':
      return isTopLevelLandmark(el) ? 'banner' : 'generic'
    case 'footer':
      return isTopLevelLandmark(el) ? 'contentinfo' : 'generic'
    case 'aside':
      return isTopLevelLandmark(el) ? 'complementary' : 'generic'
    case 'form':
      return el.hasAttribute('name') ? 'form' : 'generic'
    case 'section':
      return hasNameSource(el) ? 'region' : 'generic'
    case 'li':
      return hasListParent(el) ? 'listitem' : 'generic'
    case 'summary':
      return isDetailsSummary(el) ? 'button' : 'generic'
    case 'button':
      return 'button'
    default:
      return IMPLICIT_ROLES[tag] ?? 'generic'
  }
}

/** Whether a role token is one the platform knows about. */
function isKnownRoleToken(token: string): boolean {
  return token in IMPLICIT_ROLES || EXTRA_ROLE_TOKENS.has(token)
}

/** Implicit role of an `<input>`, which depends on its type. */
function roleOfInput(el: Element): string {
  const type = (el.getAttribute('type') ?? 'text').toLowerCase()
  switch (type) {
    case 'checkbox':
    case 'radio':
      return type
    case 'search':
      return 'searchbox'
    case 'range':
      return 'slider'
    case 'number':
      return 'spinbutton'
    case 'button':
    case 'submit':
    case 'reset':
    case 'image':
    case 'file':
      return 'button'
    case 'hidden':
      return 'presentation'
    // Date, time and colour inputs have no dedicated ARIA role; `textbox` is the
    // closest thing a reader can act on.
    default:
      return 'textbox'
  }
}

/** A numeric attribute, or `0` when absent or unparsable. */
function numericAttribute(el: Element, name: string): number {
  const raw = el.getAttribute(name)
  if (raw === null) return 0
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Whether a landmark sits directly under `<body>`, which is what promotes a
 * `header`/`footer`/`aside` from generic to a landmark role. */
function isTopLevelLandmark(el: Element): boolean {
  const parent = el.parentElement
  if (parent === null) return true
  const tag = parent.tagName.toLowerCase()
  return tag === 'body' || tag === 'html'
}

/** Whether an element has any cheap accessible-name source at all. */
function hasNameSource(el: Element): boolean {
  return (el.getAttribute('aria-label') ?? '').trim() !== ''
    || (el.getAttribute('aria-labelledby') ?? '').trim() !== ''
    || (el.getAttribute('title') ?? '').trim() !== ''
}

/** Whether an `<li>` belongs to a list, which is what gives it the role. */
function hasListParent(el: Element): boolean {
  const parent = el.parentElement
  if (parent === null) return false
  const tag = parent.tagName.toLowerCase()
  return tag === 'ul' || tag === 'ol' || tag === 'menu'
}

/** Whether a `<summary>` is the first summary of a `<details>`. */
function isDetailsSummary(el: Element): boolean {
  const parent = el.parentElement
  return parent !== null && parent.tagName.toLowerCase() === 'details'
}

/**
 * The accessible name, following the ARIA precedence chain: `aria-labelledby`,
 * then `aria-label`, then the native sources (label, alt, caption, legend, the
 * element's own text, `value` for button-like inputs, `placeholder`).
 *
 * The order matters more than it looks. `aria-labelledby` must beat
 * `aria-label`, and an input's current value must never be promoted to a name:
 * for a password field that would smuggle the secret into `name`, a field the
 * privacy gate in {@link collectFormState} does not cover.
 *
 * @param el - the element to name.
 * @returns the name, already trimmed; the caller applies the length bound.
 */
function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy !== null) {
    const parts: string[] = []
    for (const id of labelledBy.trim().split(/\s+/).slice(0, MAX_ANCESTORS)) {
      if (id === '') continue
      const referenced = referencedElement(el, id)
      const text = referenced === null ? '' : cleanText(elementText(referenced))
      if (text !== '') parts.push(text)
    }
    if (parts.length > 0) return cleanText(parts.join(' '))
  }

  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel !== null && ariaLabel.trim() !== '') return cleanText(ariaLabel)

  const tag = el.tagName.toLowerCase()
  const type = (el.getAttribute('type') ?? '').toLowerCase()

  switch (tag) {
    case 'input':
      if (type === 'image') {
        const alt = el.getAttribute('alt')
        if (alt !== null && alt.trim() !== '') return cleanText(alt)
      }
      return nameOfInput(el, type)
    case 'select':
    case 'textarea': {
      const fromLabel = nameFromLabel(el)
      if (fromLabel !== '') return fromLabel
      const placeholder = el.getAttribute('placeholder')
      if (placeholder !== null && placeholder.trim() !== '') return cleanText(placeholder)
      return titleOf(el)
    }
    case 'img':
    case 'area': {
      const alt = el.getAttribute('alt')
      if (alt !== null && alt.trim() !== '') return cleanText(alt)
      return titleOf(el)
    }
    case 'table':
      return nameFromCaption(el, 'caption')
    case 'fieldset':
      return nameFromCaption(el, 'legend')
    case 'figure':
      return nameFromCaption(el, 'figcaption')
    case 'iframe': {
      // An iframe exposes its `title` as its name; reading into the frame would
      // cross an origin boundary the picker has no business crossing.
      const title = el.getAttribute('title')
      return title === null ? '' : cleanText(title)
    }
    default:
      return nameFromContents(el, tag)
  }
}

/** Name of an `<input>`, from its type's native source. */
function nameOfInput(el: Element, type: string): string {
  const fromLabel = nameFromLabel(el)
  if (fromLabel !== '') return fromLabel

  if (type === 'button' || type === 'submit' || type === 'reset') {
    const value = stringProperty(el, 'value')
    if (value !== '') return cleanText(value)
    // A submit control with no value still announces a browser-supplied label.
    if (type === 'submit') return 'Submit'
    if (type === 'reset') return 'Reset'
  }
  const placeholder = el.getAttribute('placeholder')
  if (placeholder !== null && placeholder.trim() !== '') return cleanText(placeholder)
  return titleOf(el)
}

/** Text of the first child matching `selector`, rendered as a name. */
function nameFromCaption(el: Element, selector: string): string {
  const caption = el.querySelector(selector)
  if (caption !== null) {
    const text = cleanText(elementText(caption))
    if (text !== '') return text
  }
  return titleOf(el)
}

/** Name derived from the element's own contents, with the decoration rules. */
function nameFromContents(el: Element, tag: string): string {
  const role = computeRole(el)
  const hidden = el.getAttribute('aria-hidden') === 'true'
  const heading = /^h[1-6]$/.test(tag)
  if (!hidden && !heading && NAME_FORBIDDEN_ROLES.has(role)) return ''
  return cleanText(elementText(el))
}

/** A `title` attribute, cleaned, or the empty string. */
function titleOf(el: Element): string {
  const title = el.getAttribute('title')
  return title === null ? '' : cleanText(title)
}

/** Name contributed by an associated `<label>`, either `for=` or wrapping. */
function nameFromLabel(el: Element): string {
  const id = el.getAttribute('id')
  if (id !== null && id !== '') {
    for (const label of labelsFor(el, id)) {
      const text = cleanText(elementText(label))
      if (text !== '') return text
    }
  }
  const wrapping = el.closest('label')
  return wrapping === null ? '' : cleanText(elementText(wrapping))
}

/**
 * Labels whose `for` points at `id`.
 *
 * The lookup is scoped to the element's own tree root rather than the document,
 * because inside a shadow root `document.querySelector` cannot see the label
 * that actually labels the field.
 */
function labelsFor(el: Element, id: string): Element[] {
  try {
    return [...rootOf(el).querySelectorAll('label')].filter((label) => label.getAttribute('for') === id)
  } catch {
    return []
  }
}

/** The element an id refers to, resolved within the element's own root first. */
function referencedElement(el: Element, id: string): Element | null {
  const root = rootOf(el)
  const scoped = getElementByIdWithin(root, id)
  if (scoped !== null) return scoped
  return root === el.ownerDocument ? null : el.ownerDocument.getElementById(id)
}

/**
 * `getElementById` for any root.
 *
 * `ShadowRoot` has no `getElementById`, so the id scan is a querySelectorAll
 * walk capped by {@link MAX_ID_LOOKUP_NODES}: an `aria-labelledby` pointing at a
 * missing id would otherwise scan a large shadow tree on every pick.
 */
function getElementByIdWithin(root: Document | ShadowRoot, id: string): Element | null {
  if (isDocumentLike(root)) {
    try {
      return (root as Document).getElementById(id)
    } catch {
      return null
    }
  }
  try {
    let visited = 0
    for (const candidate of root.querySelectorAll('[id]')) {
      visited += 1
      if (visited > MAX_ID_LOOKUP_NODES) return null
      if (candidate.getAttribute('id') === id) return candidate
    }
  } catch {
    return null
  }
  return null
}

/**
 * The root an element's ids resolve against: its shadow root when it lives in
 * one, otherwise the document.
 */
function rootOf(el: Element): Document | ShadowRoot {
  try {
    const root = el.getRootNode()
    if (isShadowRootLike(root)) return root as ShadowRoot
    if (isDocumentLike(root)) return root as Document
  } catch {
    // A detached or exotic root still answers `querySelectorAll`, and treating
    // it as a shadow root is the safer assumption for a scoped lookup.
  }
  return el.ownerDocument ?? (document as unknown as Document)
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * An element's text.
 *
 * `innerText` is preferred because it reflects rendered layout: scripts, hidden
 * panels and `<template>` content are excluded by the browser rather than by a
 * heuristic of ours. It is only consulted when the runtime actually exposes one,
 * because a non-string `innerText` must not be allowed to masquerade as a
 * usable value. `textContent` is the fallback for roots without layout.
 */
function elementText(el: Element): string {
  const inner: unknown = readProperty(el, 'innerText')
  if (typeof inner === 'string') return collapseWhitespace(inner)
  try {
    return collapseWhitespace(el.textContent ?? '')
  } catch {
    return ''
  }
}

/** Collapse whitespace and trim, matching how AT normalises names. */
function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Collapse whitespace, keeping the text otherwise as written. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Keep the first `max` characters, marking the cut. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** A string property of an element, read without throwing. */
function stringProperty(el: Element, key: string): string {
  const value = readProperty(el, key)
  return typeof value === 'string' ? value : ''
}

/** A boolean property of an element, read without throwing. */
function booleanProperty(el: Element, key: string): boolean | undefined {
  const value = readProperty(el, key)
  return typeof value === 'boolean' ? value : undefined
}

/**
 * The element's visible text.
 *
 * A picked `<body>` would otherwise report the whole page, so the caller
 * truncates to {@link MAX_TEXT_LENGTH}; the cap is applied here as well so the
 * cost of flattening text is bounded even before truncation.
 */
function visibleText(el: Element): string {
  return elementText(el).slice(0, MAX_TEXT_LENGTH * 4)
}

// ---------------------------------------------------------------------------
// Form state (privacy-gated)
// ---------------------------------------------------------------------------

/** The subset of form state that survives the privacy gate. */
interface FormState {
  value?: string
  disabled?: boolean
  checked?: boolean
}

/**
 * Value, disabled and checked state for form controls.
 *
 * The privacy gate runs before the value is read at all, not after: a masked
 * value is produced from {@link maskValue} without ever touching the real one,
 * so a password cannot reach this module's output even through a later refactor
 * that forgets to trim a string. The type is taken from the attribute rather
 * than the property so this function and {@link isSensitiveField} can never
 * disagree about what a field is.
 */
function collectFormState(el: Element): FormState {
  const state: FormState = {}
  const tag = el.tagName.toLowerCase()

  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    if (isSensitiveField(el)) {
      state.value = maskValue(stringProperty(el, 'value'))
      state.disabled = readDisabled(el)
      if (tag === 'input') state.checked = readCheckedIfCheckable(el)
      return state
    }

    if (tag === 'select') {
      const text = selectedOptionText(el)
      state.value = text === '' ? undefined : truncate(text, MAX_VALUE_LENGTH)
    } else {
      const raw = stringProperty(el, 'value')
      state.value = raw === '' ? undefined : truncate(raw, MAX_VALUE_LENGTH)
    }
    state.disabled = readDisabled(el)
    if (tag === 'input') state.checked = readCheckedIfCheckable(el)
    return state
  }

  if (tag === 'option') {
    state.disabled = readDisabled(el)
    const selected = booleanProperty(el, 'selected')
    if (selected !== undefined) state.checked = selected
    return state
  }

  if (tag === 'button' || tag === 'fieldset' || tag === 'optgroup') {
    state.disabled = readDisabled(el)
    return state
  }

  // Non-native controls carry their state in ARIA; that is the whole point of
  // the attributes, so they are reported even on a plain `<div>`.
  const ariaDisabled = el.getAttribute('aria-disabled')
  if (ariaDisabled === 'true') state.disabled = true
  const ariaChecked = el.getAttribute('aria-checked')
  if (ariaChecked === 'true' || ariaChecked === 'false') state.checked = ariaChecked === 'true'
  return state
}

/** `disabled` for any element that supports it, or `undefined`. */
function readDisabled(el: Element): boolean | undefined {
  try {
    if (el.hasAttribute('disabled')) return true
  } catch {
    // Fall through to the property, which some custom elements mirror.
  }
  const value = booleanProperty(el, 'disabled')
  return value === true ? true : undefined
}

/** Checked state, but only for controls where "checked" means something. */
function readCheckedIfCheckable(el: Element): boolean | undefined {
  const type = (el.getAttribute('type') ?? 'text').toLowerCase()
  if (type !== 'checkbox' && type !== 'radio') return undefined
  return booleanProperty(el, 'checked')
}

/**
 * Text of the selected options, which is what a reader wants for a `<select>`:
 * the raw `value` is frequently an opaque id.
 */
function selectedOptionText(el: Element): string {
  const options: unknown = readProperty(el, 'selectedOptions')
  if (options === null || typeof options !== 'object') return stringProperty(el, 'value')
  const parts: string[] = []
  try {
    for (const option of [...(options as Iterable<HTMLOptionElement>)].slice(0, MAX_ANCESTORS)) {
      parts.push(cleanText(option.textContent ?? ''))
    }
  } catch {
    return stringProperty(el, 'value')
  }
  return cleanText(parts.join(', '))
}

// ---------------------------------------------------------------------------
// Attributes and styles
// ---------------------------------------------------------------------------

/**
 * Whitelisted attributes, in the order {@link REPORTED_ATTRIBUTES} declares
 * them, so the payload is stable across captures and easy to diff.
 *
 * Long values are truncated: a `class` on a compiled page, or a `src` carrying a
 * data URL, can each run to kilobytes.
 */
function collectAttributes(el: Element): Record<string, string> {
  const attributes: Record<string, string> = {}
  let count = 0
  for (const name of REPORTED_ATTRIBUTES) {
    if (count >= MAX_ATTRIBUTES) break
    let value: string | null = null
    try {
      value = el.getAttribute(name)
    } catch {
      continue
    }
    if (value === null) continue
    const trimmed = truncate(value, MAX_ATTRIBUTE_VALUE_LENGTH)
    if (trimmed === '') continue
    attributes[name] = trimmed
    count += 1
  }
  return attributes
}

/**
 * Resolved values for the whitelisted style properties.
 *
 * Only the properties in {@link REPORTED_STYLE_PROPERTIES} are read, which keeps
 * the payload predictable and stops a page from turning one click into a full
 * `CSSStyleDeclaration` dump. Keyword values such as `auto` and percentages are
 * reported verbatim rather than resolved, because resolving them would force
 * layout on an element the user has already moved past.
 *
 * @param el - the element to style.
 * @returns the reported properties that have a value, or an empty map.
 */
function collectStyles(el: Element): Record<string, string> {
  const view = el.ownerDocument?.defaultView ?? window
  const computed = view.getComputedStyle(el)
  const styles: Record<string, string> = {}
  for (const property of STYLE_PROPERTIES) {
    let value = ''
    try {
      value = computed.getPropertyValue(property)
    } catch {
      continue
    }
    if (value === '') continue
    styles[property] = normalizeStyleValue(property, value)
  }
  return styles
}

/** Round values browsers report inconsistently, so two captures of the same
 * element compare equal. */
function normalizeStyleValue(property: string, value: string): string {
  const trimmed = value.trim()
  if (property === 'width' || property === 'height') {
    // A detached element reports `auto` here, and a sub-pixel measurement adds
    // noise without adding information.
    const pixels = /^(-?\d+(?:\.\d+)?)px$/.exec(trimmed)
    if (pixels !== null && pixels[1] !== undefined) return `${Math.round(Number(pixels[1]))}px`
    return trimmed
  }
  if (property === 'z-index') {
    const parsed = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(parsed)) return trimmed
    return String(Math.max(-MAX_Z_INDEX, Math.min(MAX_Z_INDEX, parsed)))
  }
  return trimmed
}

// ---------------------------------------------------------------------------
// Ancestors
// ---------------------------------------------------------------------------

/**
 * The ancestor chain as `tag.class` strings, nearest parent first.
 *
 * The chain is capped because an element deep in a virtualised list can sit
 * thirty levels down, and a reader gains nothing from level twenty. Only the
 * first safe class name is kept: a utility-class page produces a label longer
 * than the rest of the payload and no more informative.
 *
 * @param el - the element to describe.
 * @returns up to {@link MAX_ANCESTORS} labels, nearest parent first.
 */
function collectAncestors(el: Element): string[] {
  const ancestors: string[] = []
  let node = parentOf(el)
  let hops = 0
  while (node !== null && ancestors.length < MAX_ANCESTORS && hops < MAX_ANCESTRY_HOPS) {
    hops += 1
    const tag = safeTagOf(node)
    const className = headingClassOf(node)
    ancestors.push(className === '' ? tag : `${tag}.${className}`)
    node = parentOf(node)
  }
  return ancestors
}

/**
 * The parent element, crossing out of a shadow root at the boundary.
 *
 * `parentElement` is `null` for a shadow root's direct child, so without this
 * hop the ancestry of any web-component-hosted element would stop one level in
 * and report an empty chain.
 */
function parentOf(el: Element): Element | null {
  if (el.parentElement !== null && el.parentElement !== undefined) return el.parentElement
  try {
    const root = el.getRootNode()
    if (!isShadowRootLike(root)) return null
    const host = (root as ShadowRoot).host
    return isElementLike(host) ? host : null
  } catch {
    return null
  }
}

/** Lowercase tag name, or the empty string when even that is unreadable. */
function safeTagOf(el: Element): string {
  try {
    return el.tagName.toLowerCase()
  } catch {
    return 'unknown'
  }
}

/** The first class name worth reporting for an element, or the empty string. */
function headingClassOf(el: Element): string {
  const tokens = safeClassTokens(el)
  return tokens[0] ?? ''
}

/** Class tokens that can appear in a selector without escaping, capped at two
 * because more than that stops identifying anything. */
function safeClassTokens(el: Element): string[] {
  let raw: string | null = null
  try {
    raw = el.getAttribute('class')
  } catch {
    return []
  }
  if (raw === null) return []
  const tokens: string[] = []
  for (const name of raw.split(/\s+/)) {
    if (name === '' || name.length > MAX_CLASS_NAME_LENGTH) continue
    if (!isSafeClassToken(name)) continue
    tokens.push(name)
    if (tokens.length === 2) break
  }
  return tokens
}

/** Whether a class token can appear in a selector without escaping. */
function isSafeClassToken(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)
}

// ---------------------------------------------------------------------------
// Framework components
// ---------------------------------------------------------------------------

/**
 * The framework component chain, outermost first.
 *
 * React and Vue keep their trees on the DOM node itself under private,
 * version-specific keys. The keys are found with `for…in` — which walks the
 * prototype chain and, unlike `Object.keys`, still sees properties installed
 * with `enumerable: false`. React does exactly that on some builds, and an
 * enumeration-based walk returns nothing there while looking perfectly correct
 * on a development build.
 *
 * @param el - the picked element.
 * @returns the component chain, or an empty list when no framework is detected.
 */
function collectComponents(el: Element): ComponentLink[] {
  const react = collectReactComponents(el)
  if (react.length > 0) return react
  return collectVueComponents(el)
}

/** React fiber trees, reached through a `__reactFiber$<random>` own key. */
function collectReactComponents(el: Element): ComponentLink[] {
  const fiber = nearestFiber(el)
  if (fiber === null) return []

  const links: ComponentLink[] = []
  const seen = new Set<unknown>()
  let node: Record<string, unknown> | null = fiber
  let hops = 0
  // The fiber chain is walked innermost-first — `return` points at the parent —
  // and reversed at the end to match the protocol's outermost-first order.
  while (node !== null && hops < MAX_ANCESTRY_HOPS) {
    hops += 1
    if (seen.has(node)) break
    seen.add(node)

    const type = node['type']
    if (isRecord(type) || isCallable(type)) {
      const name = reactComponentName(type)
      if (name !== null) {
        const link: ComponentLink = { name }
        const file = reactDebugFile(node)
        if (file !== undefined) link.file = file
        links.push(link)
      }
    }
    const parent: unknown = node['return']
    node = isRecord(parent) ? parent : null
  }
  return links.slice(-MAX_COMPONENTS).reverse()
}

/** The fiber attached to an element, or to its nearest ancestor that has one. */
function nearestFiber(el: Element): Record<string, unknown> | null {
  let node: Element | null = el
  let hops = 0
  while (node !== null && hops < MAX_ANCESTRY_HOPS) {
    hops += 1
    const key = fiberKeyOf(node)
    if (key !== null) {
      const fiber = readProperty(node, key)
      if (isRecord(fiber)) return fiber
    }
    node = parentOf(node)
  }
  return null
}

/**
 * The `__reactFiber$…` key on a node, if React installed one.
 *
 * The keys are found from `Object.getOwnPropertyNames` rather than by
 * enumerating the object. React installs these properties with
 * `enumerable: false`, so a `for…in` loop — or `Object.keys` — sees none of
 * them and the component chain silently comes back empty, which is the worst
 * possible failure mode: the feature looks implemented and returns nothing.
 *
 * @param node - the element to inspect.
 * @returns the property name, or `null` when the element carries no fiber.
 */
function fiberKeyOf(node: Element): string | null {
  let names: string[]
  try {
    names = Object.getOwnPropertyNames(node)
  } catch {
    return null
  }
  for (const key of names) {
    if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return key
  }
  return null
}

/**
 * A React element type's display name, or `null` for a level worth skipping.
 *
 * Host components (`'div'`) describe markup rather than the author's component
 * structure, and a reader already has `tag` and `ancestors` for those, so they
 * are dropped instead of inflating the chain.
 */
function reactComponentName(type: Record<string, unknown> | ((...args: never[]) => unknown)): string | null {
  const displayName = isCallable(type) ? readProperty(type, 'displayName') : type['displayName']
  if (typeof displayName === 'string' && displayName !== '') return truncate(displayName, MAX_COMPONENT_NAME_LENGTH)

  if (isCallable(type)) {
    const name = readProperty(type, 'name')
    if (typeof name === 'string' && name !== '') return truncate(name, MAX_COMPONENT_NAME_LENGTH)
    // Minified bundles erase the function name, and an anonymous arrow component
    // still tells the reader where in the tree they are.
    return 'Anonymous'
  }

  // `memo`, `forwardRef` and `lazy` wrappers carry the real name one level in.
  const inner = type['type'] ?? type['render']
  if (isRecord(inner) || isCallable(inner)) return reactComponentName(inner)
  return null
}

/**
 * The source file React recorded for a fiber.
 *
 * Production builds strip `_debugSource` or minify it past usefulness, which is
 * the normal case for the pages users annotate, so this is a bonus field rather
 * than something the chain depends on.
 */
function reactDebugFile(fiber: Record<string, unknown>): string | undefined {
  const source = fiber['_debugSource']
  if (!isRecord(source)) return undefined
  const file = source['fileName']
  if (typeof file !== 'string' || file === '' || looksBundled(file)) return undefined
  return file
}

/** Vue 3 component instances, walked through `__vueParentComponent`. */
function collectVueComponents(el: Element): ComponentLink[] {
  const start = nearestVueInstance(el)
  if (start === null) return []

  const links: ComponentLink[] = []
  const seen = new Set<unknown>()
  let node: Record<string, unknown> | null = start
  let hops = 0
  while (node !== null && hops < MAX_ANCESTRY_HOPS) {
    hops += 1
    if (seen.has(node)) break
    seen.add(node)

    const name = vueComponentName(node)
    if (name !== null) {
      const link: ComponentLink = { name }
      const file = vueSourceFile(node)
      if (file !== undefined) link.file = file
      links.push(link)
    }
    const parent: unknown = node['parent']
    node = isRecord(parent) ? parent : null
  }
  // `parent` walks outward, so the collection is already innermost-first and
  // only needs reversing for the protocol's outermost-first order.
  return links.slice(-MAX_COMPONENTS).reverse()
}

/**
 * The Vue component instance owning an element.
 *
 * Vue 3 attaches `__vueParentComponent` to the DOM node it rendered. When the
 * picked node does not carry the key — a plain host node, or one Vue did not
 * create — the walk continues outward so a picked `<span>` still reports the
 * component that rendered it.
 */
function nearestVueInstance(el: Element): Record<string, unknown> | null {
  let node: Element | null = el
  let hops = 0
  while (node !== null && hops < MAX_ANCESTRY_HOPS) {
    hops += 1
    const instance = readProperty(node, '__vueParentComponent')
    if (isRecord(instance)) return instance
    node = parentOf(node)
  }
  return null
}

/** A Vue component's display name, falling back through its definition. */
function vueComponentName(instance: Record<string, unknown>): string | null {
  const type = instance['type']
  if (!isRecord(type)) return null
  const explicit = type['name'] ?? type['__name']
  if (typeof explicit === 'string' && explicit !== '') return truncate(explicit, MAX_COMPONENT_NAME_LENGTH)
  const file = type['__file']
  if (typeof file === 'string' && file !== '') return truncate(basenameOf(file), MAX_COMPONENT_NAME_LENGTH)
  return null
}

/** The source file a Vue component was compiled from, when still readable. */
function vueSourceFile(instance: Record<string, unknown>): string | undefined {
  const type = instance['type']
  if (!isRecord(type)) return undefined
  const file = type['__file']
  if (typeof file !== 'string' || file === '' || looksBundled(file)) return undefined
  return file
}

/**
 * Whether a file path looks like bundled production output.
 *
 * A path is only useful when it names the file an author wrote; a chunk hash
 * tells a reader nothing they can open.
 */
function looksBundled(file: string): boolean {
  if (/\.min\.(js|mjs|cjs)$/.test(file)) return true
  return /[._-][A-Za-z0-9_-]{10,}\.(js|mjs|cjs|tsx?)$/.test(file) && /\d/.test(file)
}

/** The last path segment of a file path, without its extension. */
function basenameOf(file: string): string {
  let name = file
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  if (slash >= 0) name = name.slice(slash + 1)
  name = name.replace(/\.(vue|tsx?|jsx?)$/, '')
  return name === '' ? file : name
}

// ---------------------------------------------------------------------------
// Locators: CSS selector and XPath
// ---------------------------------------------------------------------------

/** The best selector this module could build, with its live match count. */
interface SelectorResult {
  selector: string
  matches: number
}

/**
 * Build a CSS selector for an element, preferring the cheapest stable handle.
 *
 * Order of preference, and why:
 *
 * 1. **`id`** — unique by contract and stable across renders. Only a
 *    syntactically safe id qualifies; React's `:r1:` is rejected because it is
 *    reassigned on the next render, and a selector built on it would point at a
 *    different element while looking perfectly valid.
 * 2. **`data-testid` / `data-test-id` / `data-cy` / `data-qa`** — authored as a
 *    test handle, so they are stable by intent rather than by accident.
 * 3. **`tag.class`** when that combination is unique — human-readable, and for
 *    authored markup usually stable.
 * 4. **A rooted structural path** — always resolves, but breaks on the next
 *    re-render. It is the fallback rather than the default because a selector
 *    that lies is worse than one that is verbose.
 *
 * Whatever is chosen is verified against the element's own root and reported
 * with its match count, so a reader can tell an unambiguous selector from one
 * that happens to be unique only right now.
 *
 * @param el - the element to locate.
 * @returns the selector text and how many elements it currently matches.
 */
function buildSelector(el: Element): SelectorResult {
  const root = rootOf(el)
  const scope = shadowScopeOf(el, root)

  const id = el.getAttribute('id')
  if (id !== null && isSafeIdToken(id)) {
    const unique = verified(root, `${scope}#${escapeIdentifier(id)}`, el)
    if (unique !== null) return unique
  }

  for (const attribute of TEST_ID_ATTRIBUTES) {
    const value = el.getAttribute(attribute)
    if (value === null || value === '') continue
    const unique = verified(root, `${scope}${safeTagOf(el)}[${attribute}="${escapeAttributeValue(value)}"]`, el)
    if (unique !== null) return unique
  }

  const tokens = safeClassTokens(el)
  const classCandidate = `${safeTagOf(el)}${tokens.map((name) => `.${escapeIdentifier(name)}`).join('')}`
  if (tokens.length > 0 && classCandidate.length <= MAX_CLASS_SELECTOR_LENGTH) {
    const unique = verified(root, `${scope}${classCandidate}`, el)
    if (unique !== null) return unique
  }

  return structuralSelector(el, scope, root)
}

/** A candidate selector, but only if it resolves to exactly this element. */
function verified(root: Document | ShadowRoot, selector: string, el: Element): SelectorResult | null {
  return matchesOnly(root, selector, el) ? { selector, matches: 1 } : null
}

/**
 * The structural fallback: a rooted `nth-of-type` path, with its live match
 * count.
 *
 * This is deliberately a separate step rather than a final line inside
 * {@link buildSelector}. Each candidate above is tested by running it, and
 * running a selector can throw — an id the page mutated between the read and
 * the query, a class the page set to something unparsable. When that throw
 * escaped `buildSelector`, the whole function unwound and the fallback never
 * ran, so a page with a hostile id produced an empty selector instead of the
 * verbose one that would have worked. Keeping the fallback outside the candidate
 * chain means no earlier failure can take it down with it.
 */
function structuralSelector(el: Element, scope: string, root: Document | ShadowRoot): SelectorResult {
  const path = `${scope}${structuralPath(el)}`
  return { selector: path, matches: countMatches(root, path) }
}

/**
 * Prefix naming the shadow hosts an element sits behind.
 *
 * A shadow root is closed to `document.querySelector` from the outside, so the
 * only honest CSS description of a shadow-hosted element starts at the nearest
 * host with an id. The `>>>` marker is not standard CSS — a consumer has to
 * interpret it — but it is unambiguous, and reporting it beats silently
 * returning a selector that resolves to nothing.
 *
 * @returns the prefix, or the empty string for a light-DOM element.
 */
function shadowScopeOf(el: Element, root: Document | ShadowRoot): string {
  if (!isShadowRootLike(root)) return ''
  const host = (root as ShadowRoot).host
  return isElementLike(host) ? shadowHostPrefix(host) : ''
}

/** The host chain prefix, outermost host first. */
function shadowHostPrefix(host: Element | null): string {
  if (host === null) return ''
  const id = host.getAttribute('id')
  const local = id !== null && isSafeIdToken(id)
    ? `#${escapeIdentifier(id)}`
    : `${safeTagOf(host)}${safeClassTokens(host).map((name) => `.${escapeIdentifier(name)}`).join('')}`
  return `${shadowHostPrefix(parentOf(host))}${local} >>> `
}

/**
 * A structural `nth-of-type` path from the nearest stable anchor to the element.
 *
 * The walk stops as soon as it reaches an ancestor with an id, because an id
 * pins the position absolutely: continuing past it would only add path segments
 * that make the selector more fragile without making it more precise.
 */
function structuralPath(el: Element): string {
  const segments: string[] = []
  let node: Element | null = el
  let hops = 0
  while (node !== null && hops < MAX_ANCESTRY_HOPS) {
    hops += 1
    const parent = parentOf(node)
    // The element's own segment is emitted first, and only then is the anchor
    // considered. Checking the anchor first would end the walk on the element's
    // own parent — producing `#host` for a `<span>` inside `#host`, a selector
    // that resolves to the wrong element while looking perfectly valid.
    segments.unshift(segmentFor(node, parent))
    if (parent === null) break
    if (parent.tagName.toLowerCase() === 'html') {
      segments.unshift('html')
      break
    }
    const anchor = parent.getAttribute('id')
    if (anchor !== null && isSafeIdToken(anchor)) {
      // An id pins the position absolutely, so walking further would only add
      // path segments that make the selector more fragile.
      segments.unshift(`#${escapeIdentifier(anchor)}`)
      break
    }
    node = parent
  }
  return segments.join(' > ')
}

/** One `tag` or `tag:nth-of-type(n)` segment. */
function segmentFor(el: Element, parent: Element | null): string {
  const tag = safeTagOf(el)
  if (parent === null) return tag
  const siblings = sameTagSiblings(el, parent)
  if (siblings.length <= 1) return tag
  const position = siblings.indexOf(el)
  if (position < 0) return tag
  return `${tag}:nth-of-type(${position + 1})`
}

/** Siblings sharing the element's tag name, in document order. */
function sameTagSiblings(el: Element, parent: Element): Element[] {
  try {
    const tag = el.tagName.toLowerCase()
    return [...parent.children].filter((child) => child.tagName.toLowerCase() === tag)
  } catch {
    return [el]
  }
}

/**
 * An absolute XPath to the element.
 *
 * XPath is the fallback locator: it depends on no ids or classes, so it is the
 * one locator that still works on markup an author deliberately made anonymous.
 *
 * @param el - the element to locate.
 * @returns the XPath, relative to the element's tree root.
 */
function buildXPath(el: Element): string {
  const segments: string[] = []
  let node: Element | null = el
  let hops = 0
  while (node !== null && hops < MAX_ANCESTRY_HOPS) {
    hops += 1
    const parent = parentOf(node)
    const tag = safeTagOf(node)
    if (parent === null) {
      segments.unshift(tag)
      break
    }
    const siblings = sameTagSiblings(node, parent)
    const position = siblings.indexOf(node)
    segments.unshift(position < 0 ? tag : `${tag}[${position + 1}]`)
    if (parent.tagName.toLowerCase() === 'html') {
      segments.unshift('html')
      break
    }
    node = parent
  }
  return segments.join('/')
}

/** How many elements a selector matches, capped by refusing to evaluate the
 * non-standard shadow scope marker. */
function countMatches(root: Document | ShadowRoot, selector: string): number {
  if (selector === '' || selector.includes('>>>')) return 0
  try {
    return root.querySelectorAll(selector).length
  } catch {
    return 0
  }
}

/** Whether a selector resolves to exactly this element and nothing else. */
function matchesOnly(root: Document | ShadowRoot, selector: string, el: Element): boolean {
  if (selector.includes('>>>')) return false
  try {
    const found = root.querySelectorAll(selector)
    return found.length === 1 && found[0] === el
  } catch {
    return false
  }
}

/** Whether an id is safe to embed in a selector and likely to stay stable. */
function isSafeIdToken(id: string): boolean {
  if (id === '' || id.length > MAX_ID_LENGTH) return false
  // React's `:r0:` and CSS-in-JS `_hash` prefixes are reassigned on the next
  // render, so a selector built on one is a locator that will lie later.
  if (/^[:_]/.test(id)) return false
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(id)
}

/** Escape an identifier for use after `#`, after `.`, or as a tag name. */
function escapeIdentifier(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[^A-Za-z0-9_-]/g, (ch) => `\\${ch}`)
}

/** Escape a value for use inside a double-quoted attribute selector. */
function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
