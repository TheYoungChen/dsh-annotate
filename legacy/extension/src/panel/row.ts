/**
 * One annotation as a DOM row.
 *
 * Built with `document.createElement` and `textContent` only — never with
 * markup strings. Most of what a row renders is text a page authored, and the
 * panel renders it inside an extension-origin document where the extension's own
 * APIs are reachable. A page that could get markup parsed here would be running
 * script in that document, so no value from the page ever reaches an HTML
 * parser: it reaches a text node, where it can only ever be text.
 *
 * @module
 */

import type { Annotation, ElementFacts } from '../../../src/protocol.ts'
import { formatSize, formatTime, summariseElement } from './summary.ts'

/** Callbacks a row needs from the panel that owns it. */
export interface RowHandlers {
  /** The pointer or focus entered or left the row, for marking it on the page. */
  onHover(annotationId: string, entered: boolean): void
  /** The row was expanded or collapsed. */
  onToggle(annotationId: string, expanded: boolean): void
  /** The user changed the comment on an existing annotation. */
  onCommentChange(annotationId: string, comment: string): void
  /** The user removed the annotation. */
  onRemove(annotationId: string): void
}

/** A cursor returned by {@link createRow}. */
export interface RowHandle {
  /** The row element to place in the list. */
  readonly element: HTMLLIElement
  /** The annotation currently rendered. */
  readonly annotationId: string
  /** Re-render in place, keeping focus and the expanded/collapsed choice. */
  update(annotation: Annotation, alive: boolean | null): void
  /** Whether the row is currently expanded. */
  isExpanded(): boolean
  /** Replace the facts panel; called when the page reports liveness. */
  setFacts(container: HTMLElement | null): void
}

/**
 * Build a row for one annotation.
 *
 * @param annotation - the annotation to render.
 * @param handlers - callbacks into the panel.
 * @returns a handle whose `update` re-renders without rebuilding, so an edit
 *   does not steal the caret out of the comment field the user is typing in.
 */
export function createRow(annotation: Annotation, handlers: RowHandlers): RowHandle {
  const item = document.createElement('li')
  item.className = 'row'
  item.dataset['annotationId'] = annotation.id

  const head = document.createElement('button')
  head.type = 'button'
  head.className = 'row-head'
  head.setAttribute('aria-expanded', 'false')

  const caret = document.createElement('span')
  caret.className = 'row-caret'
  caret.setAttribute('aria-hidden', 'true')
  caret.textContent = '▸'

  const identity = document.createElement('span')
  identity.className = 'row-identity'

  const tag = document.createElement('span')
  tag.className = 'row-tag'

  const locator = document.createElement('span')
  locator.className = 'row-locator'

  identity.append(tag, locator)

  const detail = document.createElement('div')
  detail.className = 'row-detail'
  detail.hidden = true

  const excerptLine = document.createElement('p')
  excerptLine.className = 'row-excerpt'

  const meta = document.createElement('p')
  meta.className = 'row-meta'

  const commentLabel = document.createElement('label')
  commentLabel.className = 'row-comment-label'
  commentLabel.textContent = 'Comment'

  const comment = document.createElement('textarea')
  comment.className = 'row-comment'
  comment.rows = 2
  comment.spellcheck = false
  comment.placeholder = 'What should change here? Enter saves a line, Shift+Enter adds one.'

  const actions = document.createElement('div')
  actions.className = 'row-actions'

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'button button-quiet'
  remove.textContent = 'Delete'

  actions.append(remove)
  detail.append(excerptLine, meta, commentLabel, comment, actions)

  head.append(caret, identity)
  item.append(head, detail)

  /** Host for the fact table, filled only while the row is open. */
  let factHost: HTMLElement | null = null
  let expanded = false
  let current = annotation

  /** Apply the expanded flag to the nodes that depend on it. */
  const setExpanded = (value: boolean): void => {
    expanded = value
    detail.hidden = !value
    head.setAttribute('aria-expanded', value ? 'true' : 'false')
    caret.textContent = value ? '▾' : '▸'
  }

  /** Push everything that depends on the annotation into the existing nodes. */
  const render = (next: Annotation, alive: boolean | null): void => {
    current = next
    const summary = summariseElement(next.facts)
    tag.textContent = summary.tag
    locator.textContent = summary.locator
    locator.title = next.facts.selector
    locator.classList.toggle('is-fragile', summary.locatorIsFragile)

    excerptLine.textContent = summary.text === null ? 'No text content.' : `“${summary.text}”`
    excerptLine.classList.toggle('is-empty', summary.text === null)

    meta.textContent = describeRow(next, alive)

    // Only touched when the value actually differs: assigning unconditionally
    // would move the caret to the end of the field on every keystroke that
    // round-trips through the store.
    const storedComment = next.comment ?? ''
    if (comment.value !== storedComment) comment.value = storedComment

    // The label has to point at a unique field; the annotation id is unique
    // within the batch, so deriving the field id from it is enough.
    const fieldId = `comment-${next.id}`
    comment.id = fieldId
    commentLabel.htmlFor = fieldId
    setExpanded(expanded)
  }

  head.addEventListener('click', () => {
    setExpanded(!expanded)
    if (factHost !== null) factHost.hidden = !expanded
    handlers.onToggle(current.id, expanded)
  })

  item.addEventListener('mouseenter', () => { handlers.onHover(current.id, true) })
  item.addEventListener('mouseleave', () => { handlers.onHover(current.id, false) })
  // Keyboard users get the same affordance as the pointer: focus on a row is the
  // only way they can point at the element it describes.
  item.addEventListener('focusin', () => { handlers.onHover(current.id, true) })
  item.addEventListener('focusout', (event) => {
    const next = event.relatedTarget
    if (next instanceof Node && item.contains(next)) return
    handlers.onHover(current.id, false)
  })

  comment.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    // Enter saves and leaves the field; Shift+Enter keeps the newline the user
    // is deliberately adding.
    event.preventDefault()
    handlers.onCommentChange(current.id, comment.value)
    comment.blur()
  })
  comment.addEventListener('change', () => { handlers.onCommentChange(current.id, comment.value) })

  remove.addEventListener('click', () => { handlers.onRemove(current.id) })

  render(annotation, null)

  return {
    element: item,
    get annotationId() { return current.id },
    update: render,
    isExpanded: () => expanded,
    setFacts(container: HTMLElement | null): void {
      if (factHost !== null) factHost.remove()
      factHost = container
      if (factHost === null) return
      factHost.hidden = !expanded
      detail.append(factHost)
    },
  }
}

/**
 * The one metadata line under a row.
 *
 * @param annotation - the annotation being described.
 * @param alive - whether the page still holds the element; `null` when unknown.
 * @returns a `·`-joined summary.
 */
function describeRow(annotation: Annotation, alive: boolean | null): string {
  const facts = annotation.facts
  const parts: string[] = []
  const size = formatSize(facts)
  if (size !== null) parts.push(size)
  parts.push(facts.inViewport ? 'in view' : 'off screen')
  if (facts.selectorMatches !== 1) parts.push(`${facts.selectorMatches} matches`)
  if (alive === false) parts.push('element is gone')
  const time = formatTime(annotation.pickedAt)
  if (time !== '') parts.push(time)
  return parts.join(' · ')
}

/**
 * Build the fact table shown under an expanded row.
 *
 * Only fields that are present are rendered. A row labelled "value" with an
 * empty cell would suggest the element has an empty value, which is a different
 * fact from "this element has no value at all".
 *
 * @param facts - the element's facts.
 * @param alive - whether the page still holds the element; `null` when unknown.
 * @returns a definition list of the facts worth showing.
 */
export function createFactTable(facts: ElementFacts, alive: boolean | null): HTMLDListElement {
  const list = document.createElement('dl')
  list.className = 'facts'

  const matches = `${facts.selectorMatches} match${facts.selectorMatches === 1 ? '' : 'es'}`
  const pairs: Array<[string, string | undefined]> = [
    ['selector', facts.selector === '' ? undefined : `${facts.selector} — ${matches}`],
    ['xpath', facts.xpath],
    ['role', facts.role],
    ['name', facts.name],
    ['text', facts.text],
    ['value', facts.value],
    ['state', describeState(facts)],
    ['attributes', describeMap(facts.attributes)],
    ['components', facts.components === undefined ? undefined : facts.components.map((link) => link.name).join(' › ')],
    ['ancestors', facts.ancestors === undefined ? undefined : facts.ancestors.join(' ‹ ')],
    ['styles', describeMap(facts.styles)],
    ['frame', facts.frameDepth === 0 ? 'top document' : `frame depth ${facts.frameDepth}`],
    ['still on the page', alive === null ? undefined : alive ? 'yes' : 'no — the element was removed or replaced'],
  ]

  for (const [label, value] of pairs) {
    if (value === undefined || value === '') continue
    const term = document.createElement('dt')
    term.textContent = label
    const description = document.createElement('dd')
    description.textContent = value
    list.append(term, description)
  }
  return list
}

/** Render the disabled/checked part of a fact set, when it has one. */
function describeState(facts: ElementFacts): string | undefined {
  const parts: string[] = []
  if (facts.disabled === true) parts.push('disabled')
  if (facts.checked !== undefined) parts.push(facts.checked ? 'checked' : 'unchecked')
  return parts.length === 0 ? undefined : parts.join(', ')
}

/** Render a string map as `key: value` lines, or `undefined` when empty. */
function describeMap(map: Record<string, string> | undefined): string | undefined {
  if (map === undefined) return undefined
  const entries = Object.entries(map)
  if (entries.length === 0) return undefined
  return entries.map(([key, value]) => `${key}: ${value}`).join('\n')
}
