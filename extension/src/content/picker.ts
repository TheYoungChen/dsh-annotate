/**
 * Element picking mode: hover to highlight, click to lock an element.
 *
 * The picker is armed and disarmed by the content-script entry point, never by
 * listening on its own. A page has no way to know when the user wants to
 * annotate, and an always-on listener would swallow every click on every page
 * the extension is injected into.
 *
 * Two constraints drive the whole design. The page must not be touched: the
 * highlight lives in a closed overlay of our own, because writing to a target's
 * inline `style` would mutate the very DOM we are asking the user to report on,
 * and the damage would outlive the pick (a page that reads its own computed
 * styles would keep seeing our outline until the user reloaded). And the page
 * must not observe the pick: a click that reaches the page's own handlers can
 * navigate, submit a form or open a menu before the annotation is even built,
 * so the pick is intercepted in the capture phase.
 *
 * @module
 */

import type { Rect } from '../../../src/protocol.ts'

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

/** Marks our host so a later instance can find and remove a stale overlay. */
export const OVERLAY_HOST_ID = '__dsh_annotate_picker_overlay__'

/** Highlight box styling. Kept here so the whole visual language is in one place. */
const HIGHLIGHT_STYLE = [
  'position: fixed',
  'pointer-events: none',
  'box-sizing: border-box',
  'border: 2px solid #4f8ef7',
  'background: rgba(79, 142, 247, 0.14)',
  'border-radius: 2px',
  'z-index: 2147483647',
  'transition: none',
  'will-change: transform',
].join('; ')

/** Label styling. The tag name is the cheapest way to tell the user what they hit. */
const LABEL_STYLE = [
  'position: fixed',
  'pointer-events: none',
  'box-sizing: border-box',
  'font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  'color: #ffffff',
  'background: #4f8ef7',
  'padding: 1px 5px',
  'border-radius: 2px',
  'max-width: 60vw',
  'white-space: nowrap',
  'overflow: hidden',
  'text-overflow: ellipsis',
  'z-index: 2147483647',
  'transition: none',
].join('; ')

/** Hint strip styling: tells the user how to leave, which is otherwise invisible. */
const HINT_STYLE = [
  'position: fixed',
  'left: 50%',
  'bottom: 16px',
  'transform: translateX(-50%)',
  'pointer-events: none',
  'box-sizing: border-box',
  'font: 12px/1.5 system-ui, -apple-system, Segoe UI, sans-serif',
  'color: #ffffff',
  'background: rgba(17, 20, 26, 0.92)',
  'padding: 6px 12px',
  'border-radius: 6px',
  'box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3)',
  'white-space: nowrap',
  'z-index: 2147483647',
  'transition: none',
].join('; ')

/**
 * The highlight layer, isolated in a shadow root.
 *
 * A plain injected element would inherit page CSS — `* { box-sizing: content-box }`
 * or a global `border` would deform the box the user is trying to believe in,
 * and a page rule targeting `div` would style our host. A shadow root stops
 * both directions of leakage without touching the page's own stylesheets.
 */
class Overlay {
  private readonly host: HTMLDivElement
  private readonly shadow: ShadowRoot
  private readonly highlight: HTMLDivElement
  private readonly label: HTMLDivElement
  private readonly hint: HTMLDivElement

  constructor(hintText: string) {
    this.host = document.createElement('div')
    this.host.id = OVERLAY_HOST_ID
    // The host itself must never affect layout: positioned fixed so it is out of
    // flow, zero-sized so it cannot shift content, and transparent to pointers
    // so the page keeps receiving mousemove underneath our boxes.
    this.host.setAttribute(
      'style',
      'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; pointer-events: none;',
    )
    this.shadow = this.host.attachShadow({ mode: 'open' })

    this.highlight = document.createElement('div')
    this.highlight.setAttribute('style', HIGHLIGHT_STYLE)
    this.highlight.hidden = true

    this.label = document.createElement('div')
    this.label.setAttribute('style', LABEL_STYLE)
    this.label.hidden = true

    this.hint = document.createElement('div')
    this.hint.setAttribute('style', HINT_STYLE)
    this.hint.textContent = hintText

    this.shadow.append(this.highlight, this.label, this.hint)
    document.documentElement.append(this.host)
  }

  /** Draw the boxes for one element, given a fresh viewport-space rect. */
  render(target: Element, box: DOMRect): void {
    this.highlight.hidden = false
    this.highlight.style.left = `${box.left}px`
    this.highlight.style.top = `${box.top}px`
    this.highlight.style.width = `${box.width}px`
    this.highlight.style.height = `${box.height}px`

    this.label.hidden = false
    this.label.textContent = this.describe(target)
    // Below the box when there is room, above it otherwise: a label drawn off
    // the top of the viewport is the one failure mode that matters on a page
    // whose first element starts at y = 0.
    const labelTop = box.top >= 22 ? box.top - 20 : box.bottom + 2
    this.label.style.left = `${Math.max(0, box.left)}px`
    this.label.style.top = `${labelTop}px`
  }

  /** Hide the boxes without tearing down the layer, for pointer-out and exits. */
  hide(): void {
    this.highlight.hidden = true
    this.label.hidden = true
  }

  /** Remove the layer and everything inside it from the page. */
  dispose(): void {
    this.host.remove()
  }

  /**
   * A short label for the highlighted element.
   *
   * Only identity is shown, never content: the preview must not become a second
   * path for a page's secrets to reach the screen recorder or the user's eyes.
   */
  private describe(target: Element): string {
    const tag = target.tagName.toLowerCase()
    const id = target.id === '' ? '' : `#${target.id}`
    return `${tag}${id}`
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Why picking stopped, so the caller can tell a deliberate exit from a pick. */
export type PickerExitReason = 'escape' | 'disabled' | 'picked'

/** What the user hovered or selected. Facts are built by the caller, not here. */
export interface PickerEvent {
  /** The element under the pointer. */
  element: Element
  /** Registry id for {@link PickerEvent.element}; stable while it is connected. */
  id: string
  /** Its viewport-space box at the moment of the event. */
  rect: Rect
  /** Whether the element was inside the viewport when the event fired. */
  inViewport: boolean
}

/** Callbacks the content-script entry point wires into the picker. */
export interface PickerHandlers {
  /** Fired when the highlighted element changes, including on Tab cycling. */
  onHover?: (event: PickerEvent) => void
  /** Fired on click. Picking stops immediately unless `keepAlive` is set. */
  onPick: (event: PickerEvent) => void
  /** Fired when the mode ends for any reason, including after `onPick`. */
  onExit?: (reason: PickerExitReason) => void
}

/** Options accepted by {@link startPicking}. */
export interface PickerOptions extends PickerHandlers {
  /**
   * Keep the mode armed after a pick.
   *
   * The comment panel (D line) needs the picker to survive a click so the user
   * can annotate several elements in one pass; the default is one shot because
   * a user who clicked once expects control back.
   */
  keepAlive?: boolean
  /** Text of the always-visible hint strip. Overridden to localise. */
  hintText?: string
}

/** A running picking session. */
export interface PickerSession {
  /** The element currently highlighted, or null when the pointer is off-page. */
  readonly current: Element | null
  /** Whether the session is still listening. */
  readonly active: boolean
  /** End the session. Safe to call twice, and safe to call from a handler. */
  stop: (reason?: PickerExitReason) => void
  /**
   * Flash the highlight over an already-picked element.
   *
   * The picker's own overlay is gone once picking stops, so a caller that wants
   * to point at an element later — hovering a row in the annotation list — needs
   * a way back in. This draws the same box without arming the pick handlers, so
   * the page stays interactive while the marker is shown.
   *
   * @param id - a registry id from {@link PickerEvent.id}.
   * @returns true when the element was found and marked.
   */
  flash: (id: string) => boolean
  /**
   * Bring an already-picked element into view.
   *
   * @param id - a registry id from {@link PickerEvent.id}.
   * @returns true when the element was found and scrolled to.
   */
  scrollTo: (id: string) => boolean
}

/** The default hint. Kept short because it competes with the page for attention. */
const DEFAULT_HINT = 'Click to pick · Tab cycles nested elements · Esc to exit'

/** How long a marker drawn for an already-picked element stays on screen. */
const MARKER_LINGER_MS = 1200

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convert a live DOMRect into the protocol's viewport-space rect. */
function toRect(box: DOMRect): Rect {
  return { x: box.left, y: box.top, width: box.width, height: box.height }
}

/**
 * Whether a rect has any area inside the current viewport.
 *
 * A zero-area element (a collapsed container, a hidden `<template>` child) is
 * reported as out of view rather than as a point in the top-left corner, which
 * is what a naive `left < innerWidth` test would claim.
 */
function isInViewport(box: DOMRect): boolean {
  if (box.width <= 0 || box.height <= 0) return false
  return box.right > 0 && box.bottom > 0 && box.left < window.innerWidth && box.top < window.innerHeight
}

/**
 * Resolve a point to the element underneath, descending into open shadow roots.
 *
 * `elementFromPoint` stops at the shadow host, so a component library built on
 * shadow DOM (or our own overlay, which is why the host is `pointer-events: none`)
 * would otherwise be unpickable or always picked.
 */
function deepElementFromPoint(x: number, y: number): Element | null {
  let hit = document.elementFromPoint(x, y)
  while (hit?.shadowRoot != null) {
    const inner = hit.shadowRoot.elementFromPoint(x, y)
    if (inner === null || inner === hit) break
    hit = inner
  }
  return hit
}

/**
 * Walk up from the pointer target to the ancestor currently under the cursor.
 *
 * Cycling needs the stack of elements that all contain the point, not the DOM
 * ancestry of the innermost hit: in a page where a wrapper is `pointer-events:
 * none` the two differ, and the user is pointing at the visual stack.
 */
function elementsAtPoint(x: number, y: number): Element[] {
  const stack: Element[] = []
  const seen = new Set<Element>()
  let node = deepElementFromPoint(x, y)
  while (node !== null && node !== document.documentElement) {
    if (seen.has(node)) break
    seen.add(node)
    const box = node.getBoundingClientRect()
    if (isInViewport(box)) stack.push(node)
    node = node.parentElement
  }
  // The root element is a legitimate target on an empty page, but it is not
  // useful in the cycle: every other entry already contains the same point.
  return stack
}

// ---------------------------------------------------------------------------
// Element registry
// ---------------------------------------------------------------------------

/**
 * Ids handed to picked elements.
 *
 * The facts a pick produces are plain data, so the caller that later wants to
 * re-highlight an annotated element has nothing to reach for. This registry is
 * that missing handle.
 *
 * Two properties matter. The map is weak, so an element removed by the page
 * (a re-rendered list, a routed-away view) does not keep its DOM subtree alive
 * for the lifetime of the tab — an annotation is a long-lived object and a
 * strong map would turn every pick into a leak. And nothing is ever written to
 * the element itself: stamping an attribute would be visible to the page's own
 * `MutationObserver`s and could change framework behaviour, which is precisely
 * the kind of damage an annotation tool must not cause.
 */
export class ElementRegistry {
  private readonly ids = new WeakMap<Element, string>()
  /**
   * Reverse lookup. A weak map cannot be searched by value, so this stays
   * strong and is pruned as it is read: an element the page detached fails its
   * own `isConnected` check and is dropped then, which bounds the map by what
   * the page currently holds rather than by how many picks were made.
   */
  private readonly byId = new Map<string, Element>()
  private nextId = 1

  /**
   * The id for an element, minting one on first sight.
   *
   * Stable per element for the lifetime of the frame, so re-picking the same
   * element yields the same id and a caller can deduplicate on it.
   */
  idFor(element: Element): string {
    const existing = this.ids.get(element)
    if (existing !== undefined) return existing
    const id = `el-${this.nextId}`
    this.nextId += 1
    this.ids.set(element, id)
    this.byId.set(id, element)
    return id
  }

  /** Resolve an id back to its element, or null when it is gone. */
  elementFor(id: string): Element | null {
    const element = this.byId.get(id)
    if (element === undefined) return null
    if (!element.isConnected) {
      this.byId.delete(id)
      return null
    }
    return element
  }

  /** How many ids are currently resolvable. Used by callers to bound work. */
  get size(): number {
    return this.byId.size
  }
}

/** Registry shared by every session in this frame. */
export const elementRegistry = new ElementRegistry()

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Arm picking mode on this frame.
 *
 * The returned session is the only way to stop: the picker installs no
 * listener that could outlive its caller, so a content script that forgets to
 * call `stop` leaks nothing beyond the frame's own lifetime.
 *
 * @param options - handlers plus behavioural flags.
 * @returns a handle for the running session.
 */
export function startPicking(options: PickerOptions): PickerSession {
  const { onHover, onPick, onExit, keepAlive = false, hintText = DEFAULT_HINT } = options
  const overlay = new Overlay(hintText)

  let current: Element | null = null
  let active = true
  /** Last pointer position, so Tab can re-derive the stack without a new event. */
  let pointerX = -1
  let pointerY = -1
  /** Index into the element stack at the pointer, for Tab cycling. */
  let cycleIndex = 0
  /** Coalesces mousemove into one hit-test per frame. */
  let frame = 0
  /** Set while a pick is being delivered, so exit handlers cannot re-enter. */
  let stopped = false

  const eventFor = (target: Element): PickerEvent => {
    const box = target.getBoundingClientRect()
    return { element: target, id: elementRegistry.idFor(target), rect: toRect(box), inViewport: isInViewport(box) }
  }

  const highlight = (target: Element | null): void => {
    if (target === null || !target.isConnected) {
      current = null
      overlay.hide()
      return
    }
    if (target !== current) {
      current = target
      onHover?.(eventFor(target))
    }
    // Re-render even for an unchanged target: the element may have moved under
    // a fixed pointer because the page scrolled or animated.
    overlay.render(target, target.getBoundingClientRect())
  }

  const stop = (reason: PickerExitReason = 'disabled'): void => {
    if (!active) return
    active = false
    overlay.dispose()
    if (frame !== 0) {
      cancelAnimationFrame(frame)
      frame = 0
    }
    current = null
    document.removeEventListener('mousemove', onMouseMove, true)
    document.removeEventListener('mousedown', onMouseDown, true)
    document.removeEventListener('mouseup', onMouseUp, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('dblclick', onSuppressedMouseEvent, true)
    document.removeEventListener('contextmenu', onSuppressedMouseEvent, true)
    document.removeEventListener('auxclick', onSuppressedMouseEvent, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('keyup', onKeyUp, true)
    window.removeEventListener('scroll', onViewportChange, true)
    window.removeEventListener('resize', onViewportChange, true)
    // The marker is deliberately not cleared here: a marker is drawn by a
    // caller that asked for it and outlives the session, while the highlight is
    // ours and must go. `disarmPicking` clears it when the mode is torn down.
    if (!stopped) onExit?.(reason)
  }

  // -- addressing already-picked elements ---------------------------------

  const flash = (id: string): boolean => flashElement(id)

  const scrollTo = (id: string): boolean => {
    const element = elementRegistry.elementFor(id)
    if (element === null) return false
    // `block: 'center'` keeps the element clear of sticky headers, which is the
    // usual reason a scrolled-to element lands under a toolbar and looks lost.
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    return true
  }

  // -- pointer ------------------------------------------------------------

  const onMouseMove = (event: MouseEvent): void => {
    pointerX = event.clientX
    pointerY = event.clientY
    // A pointer move restarts the cycle: the old index described the stack at
    // the previous position and would select an unrelated element.
    cycleIndex = 0
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (!active) return
      highlight(deepElementFromPoint(pointerX, pointerY))
    })
  }

  /**
   * Block the page's own pointer handling.
   *
   * Capture phase plus `stopPropagation` is what keeps a pick from also being a
   * click on the page: without it, picking a link navigates away and picking a
   * button submits, and the user never gets to describe what they picked.
   */
  const swallow = (event: Event): void => {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
  }

  const onMouseDown = (event: MouseEvent): void => {
    swallow(event)
    if (event.button !== 0) return
    // Resolve from the event rather than from the last frame: a click can arrive
    // before the next animation frame on a fast press.
    pointerX = event.clientX
    pointerY = event.clientY
    cycleIndex = 0
    const target = deepElementFromPoint(pointerX, pointerY)
    // Re-render so the locked element matches the click, not the last hover.
    highlight(target)
  }

  const onMouseUp = (event: MouseEvent): void => {
    swallow(event)
  }

  const onClick = (event: MouseEvent): void => {
    swallow(event)
    if (event.button !== 0 || !active) return
    const target = deepElementFromPoint(event.clientX, event.clientY)
    if (target === null) return
    const delivered = eventFor(target)
    // Stop before notifying: the handler for the pick may open the comment
    // panel, and the panel must not be covered by a highlight layer that is
    // still tracking the pointer.
    if (!keepAlive) {
      stopped = true
      stop('picked')
      stopped = false
    }
    onPick(delivered)
  }

  /**
   * Swallow the mouse events that pair with a click.
   *
   * A right-click during picking means "cancel", but the page's context menu
   * would open on top of the overlay; the mode ends instead so the user is not
   * left in a state where the expected action is unavailable.
   */
  const onSuppressedMouseEvent = (event: MouseEvent): void => {
    swallow(event)
    if (event.type === 'contextmenu') stop('escape')
  }

  // -- keyboard -----------------------------------------------------------

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      swallow(event)
      stop('escape')
      return
    }
    if (event.key === 'Tab') {
      // Tab would otherwise move the browser's focus through the page, firing
      // the page's own focus/blur handlers while the user is only cycling.
      swallow(event)
      cycle(event.shiftKey ? -1 : 1)
      return
    }
    // Everything else is swallowed so page hotkeys (search, palette, shortcuts)
    // cannot fire while the user is aiming at an element.
    swallow(event)
  }

  const onKeyUp = (event: KeyboardEvent): void => {
    swallow(event)
  }

  const cycle = (delta: number): void => {
    if (pointerX < 0 || pointerY < 0) return
    const stack = elementsAtPoint(pointerX, pointerY)
    if (stack.length === 0) return
    cycleIndex = (cycleIndex + delta + stack.length) % stack.length
    const target = stack[cycleIndex]
    if (target === undefined) return
    // Force the hover callback: cycling is a deliberate change of target even
    // when it lands back on the element that was already highlighted.
    current = null
    highlight(target)
  }

  // -- viewport -----------------------------------------------------------

  /**
   * Follow scrolling and resizing.
   *
   * A captured `scroll` listener sees scrolling inside nested scroll containers
   * as well as the document, which is where an annotation session usually
   * happens. The overlay is `position: fixed`, so the browser would keep it
   * still while the element moved away; re-reading the rect is what makes the
   * box track the element. This is cheap because it does no hit-testing, only a
   * `getBoundingClientRect` on an element already known.
   */
  const onViewportChange = (): void => {
    if (!active) return
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (!active) return
      // A scrolled element can land outside the viewport; hiding is friendlier
      // than clamping to an edge and claiming the element is still there.
      if (current !== null && current.isConnected) {
        const box = current.getBoundingClientRect()
        if (isInViewport(box)) overlay.render(current, box)
        else overlay.hide()
      }
    })
  }

  document.addEventListener('mousemove', onMouseMove, true)
  document.addEventListener('mousedown', onMouseDown, true)
  document.addEventListener('mouseup', onMouseUp, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('dblclick', onSuppressedMouseEvent, true)
  document.addEventListener('contextmenu', onSuppressedMouseEvent, true)
  document.addEventListener('auxclick', onSuppressedMouseEvent, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange, true)

  return {
    get current() { return current },
    get active() { return active },
    stop,
    flash,
    scrollTo,
  }
}

/**
 * Remove an overlay left behind by a previous content-script instance.
 *
 * The entry point re-runs on extension reload and on `executeScript` recovery;
 * the old instance's listeners die with its context, but the element it
 * appended to `documentElement` does not, and two stacked highlight layers is a
 * visible bug that survives a page reload.
 *
 * @returns true when a stale overlay was found and removed.
 */
export function clearStaleOverlay(): boolean {
  const stale = document.getElementById(OVERLAY_HOST_ID)
  if (stale === null) return false
  stale.remove()
  return true
}

/** Global slot used to hand a session to a replaced content script. */
const SESSION_SLOT = '__dshAnnotatePickerSession__'

type PickerGlobal = typeof globalThis & {
  [SESSION_SLOT]?: PickerSession
}

/**
 * Arm picking, replacing any session this frame still has running.
 *
 * The content-script entry point calls this rather than {@link startPicking} so
 * a duplicated arm command (a retried `start-picking`, two panels, a reloaded
 * worker) cannot leave two sessions fighting over the same click. It also
 * clears an overlay orphaned by an earlier instance.
 *
 * @param options - handlers plus behavioural flags.
 * @returns the new session.
 */
export function armPicking(options: PickerOptions): PickerSession {
  disarmPicking('disabled')
  clearStaleOverlay()
  const session = startPicking(options)
  ;(globalThis as PickerGlobal)[SESSION_SLOT] = session
  return session
}

/**
 * Stop the session running on this frame, if any.
 *
 * @param reason - why picking stopped; forwarded to the session's `onExit`.
 * @returns true when a session was actually stopped.
 */
export function disarmPicking(reason: PickerExitReason = 'disabled'): boolean {
  const global = globalThis as PickerGlobal
  const session = global[SESSION_SLOT]
  if (session === undefined) return false
  delete global[SESSION_SLOT]
  session.stop(reason)
  return true
}

/**
 * Draw the highlight marker over an already-picked element.
 *
 * A free function so the annotation panel can point at an element without
 * holding a session: the panel outlives any one picking run, and re-arming the
 * picker just to show a box would swallow the user's clicks again.
 *
 * @param id - a registry id previously handed out through a pick event.
 * @returns true when the element was found and marked.
 */
export function flashElement(id: string): boolean {
  const element = elementRegistry.elementFor(id)
  if (element === null) return false
  const box = element.getBoundingClientRect()
  if (!isInViewport(box)) element.scrollIntoView({ block: 'center', inline: 'nearest' })
  const overlay = new Overlay('')
  overlay.render(element, element.getBoundingClientRect())
  // Self-removing: a marker is a momentary signal, and a timer keeps the caller
  // from having to remember to clear it when the pointer leaves a list row.
  window.setTimeout(() => { overlay.dispose() }, MARKER_LINGER_MS)
  return true
}

/**
 * Whether this frame is currently in picking mode.
 *
 * The entry point answers `stop-picking` for every frame of a tab, so it needs
 * a way to tell "I was picking" from "I was idle" without keeping its own copy
 * of the state that could drift from the picker's.
 *
 * @returns true when a live session is armed on this frame.
 */
export function isPicking(): boolean {
  return (globalThis as PickerGlobal)[SESSION_SLOT]?.active === true
}
