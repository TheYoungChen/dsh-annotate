/**
 * The annotation store: the panel's model of the batch being assembled.
 *
 * The store owns every state transition and the view only reads. That split is
 * what makes the interaction rules testable without a DOM: "sending an
 * annotation without a comment still records it", "clearing empties the list",
 * "a retry keeps the page identity captured at pick time" are all statements
 * about this file.
 *
 * **Why the store lives in the page.** An extension page is torn down whenever
 * the side panel closes, and a half-written annotation is the most expensive
 * thing in this interface to lose — the user has to find the element again on a
 * possibly-changed page. The store therefore persists itself into the bound
 * tab's session storage and offers to restore what it finds. Session storage is
 * the right scope rather than local storage: an annotation describes one tab, so
 * it must not follow the user into an unrelated tab, and it must not outlive the
 * browsing session in which it was written.
 *
 * @module
 */

import type { Annotation, ElementFacts, PageContext, PageKind, Rect } from '../../../src/protocol.ts'
import { PROTOCOL_VERSION, pageKindOf } from '../../../src/protocol.ts'
import { extensionApi } from './extension-api.ts'

/** How many annotations one batch may hold. Mirrors the protocol's own ceiling. */
export const MAX_ANNOTATIONS = 50

/** Most characters kept from a comment, matched to the protocol's bound. */
export const MAX_COMMENT_LENGTH = 4000

/** Longest text excerpt shown for one element in a list row. */
export const SUMMARY_TEXT_LENGTH = 64

/** What the panel knows when it is restored into a tab it did not start in. */
export interface RestoredState {
  annotations: Annotation[]
  page: PageContext | null
}

/** A snapshot of everything a render needs, taken once per change. */
export interface PanelSnapshot {
  /** Registry id of the element the picker most recently handed over. */
  currentElementId: string | null
  /** Facts for {@link currentElementId}, when the tab is still reporting them. */
  currentFacts: ElementFacts | null
  annotations: readonly Annotation[]
  page: PageContext | null
  picking: boolean
  /** Set while a submission is in flight, so the UI can block a double send. */
  submitting: boolean
  /** Operator-facing result of the last submission, or `null` before the first. */
  lastResult: string | null
  /** True when the last submission failed in a way a retry could fix. */
  retryable: boolean
  /**
   * Set when page facts are knowingly stale — a navigation happened or the page
   * stopped answering — so the UI can say so instead of presenting the last good
   * reading as current.
   */
  stale: boolean
}

/** The subset of `chrome.storage.session` this store uses. */
export interface StateStorage {
  read(tabId: number): Promise<RestoredState | null>
  write(tabId: number, state: RestoredState): Promise<void>
  /** Drop the record for a tab. Called once a tab has nothing left to restore. */
  clear(tabId: number): Promise<void>
}

/** A listener notified after every state change. */
export type StoreListener = (snapshot: PanelSnapshot) => void

/**
 * In-memory storage, used when session storage is unavailable.
 *
 * The panel has to work in a plain document too — that is how its rendering is
 * tested — and an unavailable storage API must degrade to "state is not
 * restored", never to a thrown error on startup.
 */
/**
 * A store of stored states.
 *
 * `MemoryStateStorage` is the panel's own fallback and is also what the tests
 * run against; {@link MemoryStateStorage.writeRaw} is the escape hatch for the
 * one case a well-typed fixture cannot express — a record written by a build
 * that no longer exists.
 */
export class MemoryStateStorage implements StateStorage {
  private readonly states = new Map<number, unknown>()

  read(tabId: number): Promise<RestoredState | null> {
    return Promise.resolve((this.states.get(tabId) ?? null) as RestoredState | null)
  }

  write(tabId: number, state: RestoredState): Promise<void> {
    this.states.set(tabId, state)
    return Promise.resolve()
  }

  clear(tabId: number): Promise<void> {
    this.states.delete(tabId)
    return Promise.resolve()
  }

  /**
   * Store an arbitrary value under a tab's key.
   *
   * Exists so a test can plant a record no current build would write — the case
   * the restore path has to survive. It is not used by the panel itself.
   *
   * @param tabId - the tab to plant the record for.
   * @param value - the value, of any shape.
   */
  writeRaw(tabId: number, value: unknown): Promise<void> {
    this.states.set(tabId, value)
    return Promise.resolve()
  }
}

/**
 * Session-scoped storage on the extension's own storage API.
 *
 * Writes are keyed by tab because a side panel is per-window over a per-tab
 * subject: two windows annotating two pages must not see each other's rows.
 *
 * @returns storage backed by `chrome.storage.session`, or {@link MemoryStateStorage}
 *   when the API is missing (a test document, a browser that does not expose it).
 */
export function sessionStateStorage(): StateStorage {
  const api = extensionApi()
  if (api === null) return new MemoryStateStorage()
  const session = api.storage.session
  return {
    async read(tabId: number): Promise<RestoredState | null> {
      try {
        const key = storageKey(tabId)
        const bag = await session.get(key)
        return parseRestored(bag[key])
      } catch {
        return null
      }
    },
    async write(tabId: number, state: RestoredState): Promise<void> {
      try {
        await session.set({ [storageKey(tabId)]: state })
      } catch {
        // A quota or permission failure must not break the annotation the user
        // is in the middle of writing; the in-memory copy is still authoritative.
      }
    },
    async clear(tabId: number): Promise<void> {
      try {
        await session.remove(storageKey(tabId))
      } catch {
        // Same reasoning as `write`: losing the cleanup is not worth an error.
      }
    },
  }
}

/** Storage key for one tab. Namespaced so a future key cannot collide with it. */
function storageKey(tabId: number): string {
  return `annotate.tab.${tabId}`
}

/**
 * Read a persisted value back without trusting it.
 *
 * Storage is shared with every other context of the extension and survives an
 * upgrade, so a value written by an older or a different build can be present.
 * Each annotation is checked against the protocol guard's minimum instead of
 * being cast: a half-shaped row would render as a blank line the user cannot
 * explain, and would then be sent to a model as though the user had written it.
 *
 * @param value - whatever was stored under the tab's key.
 * @returns the usable part of the stored state, or `null` when nothing is.
 */
function parseRestored(value: unknown): RestoredState | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as { annotations?: unknown; page?: unknown }
  const annotations = Array.isArray(record.annotations) ? record.annotations.filter(isStoredAnnotation).filter(hasRestorableFacts) : []
  const page = isStoredPage(record.page) ? record.page : null
  if (annotations.length === 0 && page === null) return null
  return { annotations, page }
}

/** Whether a stored annotation is usable by the list. */
function isStoredAnnotation(value: unknown): value is Annotation {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { id?: unknown; pickedAt?: unknown; facts?: unknown; comment?: unknown }
  if (typeof record.id !== 'string' || record.id === '') return false
  if (typeof record.pickedAt !== 'number') return false
  if (record.comment !== undefined && typeof record.comment !== 'string') return false
  return isStoredFacts(record.facts)
}

/**
 * Whether stored facts carry everything a list row and a submission need.
 *
 * The required fields are checked strictly and the optional ones only for the
 * type they must have when present. That asymmetry is deliberate: a row missing
 * `selector` cannot be rendered or acted on at all, whereas one missing `text`
 * is simply an element with no text, which is an ordinary thing to annotate.
 */
export function isStoredFacts(value: unknown): value is ElementFacts {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record['tag'] !== 'string' || record['tag'] === '') return false
  if (typeof record['selector'] !== 'string') return false
  if (typeof record['selectorMatches'] !== 'number') return false
  if (typeof record['frameDepth'] !== 'number') return false
  if (typeof record['inViewport'] !== 'boolean') return false
  if (!isStoredRect(record['rect'])) return false

  if (!optionalString(record['xpath'])) return false
  if (!optionalString(record['role'])) return false
  if (!optionalString(record['name'])) return false
  if (!optionalString(record['text'])) return false
  if (!optionalString(record['value'])) return false
  if (!optionalBoolean(record['disabled'])) return false
  if (!optionalBoolean(record['checked'])) return false
  if (!optionalStringMap(record['attributes'])) return false
  if (!optionalStringMap(record['styles'])) return false
  if (!optionalStringList(record['ancestors'])) return false
  return optionalComponents(record['components'])
}

/**
 * Whether a stored annotation's facts survive a full field-by-field check.
 *
 * The id is re-checked along with the facts rather than trusted from the read:
 * the list keys its rows on it, so a row without one would be rendered once per
 * change and deleted on every change after that.
 */
function hasRestorableFacts(value: Annotation): boolean {
  if (typeof value.id !== 'string' || value.id === '') return false
  if (typeof value.pickedAt !== 'number') return false
  return isStoredFacts(value.facts)
}

/** Whether a stored value carries an optional component chain. */
function optionalComponents(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  return value.every((link) => typeof link === 'object' && link !== null
    && typeof (link as { name?: unknown }).name === 'string')
}

/** Whether a stored value carries an optional string, present or absent. */
function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

/** Whether a stored value carries an optional number, present or absent. */
function optionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number'
}

/** Whether a stored value carries an optional boolean, present or absent. */
function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

/** Whether a stored value carries an optional list of strings. */
function optionalStringList(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
}

/** Whether a stored value carries an optional map of strings. */
function optionalStringMap(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== 'object' || value === null) return false
  return Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string')
}

/**
 * Whether a stored fact set is complete enough to submit.
 *
 * Kept as a named export because it is the check applied to every restored row:
 * a restored row goes straight into a batch, and a missing `selectorMatches`
 * would make the batch fail the bridge's own guard after the user had pressed
 * send, which is the worst possible moment to discover a corrupt restore.
 *
 * @param value - the stored facts.
 * @returns `true` when every required field is present and every optional one
 *   has the right type.
 */
export const isRestorableFacts = isStoredFacts

/** Whether a stored rect has four finite numbers. */
function isStoredRect(value: unknown): value is Rect {
  if (typeof value !== 'object' || value === null) return false
  const rect = value as Partial<Record<keyof Rect, unknown>>
  return typeof rect.x === 'number' && typeof rect.y === 'number'
    && typeof rect.width === 'number' && typeof rect.height === 'number'
}

/** Whether a stored value is a page context. */
function isStoredPage(value: unknown): value is PageContext {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<Record<keyof PageContext, unknown>>
  if (typeof record.url !== 'string' || record.url === '') return false
  if (record.kind !== 'http' && record.kind !== 'https' && record.kind !== 'file') return false
  const viewport = record.viewport
  if (typeof viewport !== 'object' || viewport === null) return false
  const size = viewport as { width?: unknown; height?: unknown }
  return typeof size.width === 'number' && typeof size.height === 'number'
}

/** Monotonic suffix for ids minted in this document. */
let idCounter = 0

/**
 * Mint an annotation id.
 *
 * Ids only have to be unique within a batch, and the batch is assembled in one
 * document, so a counter plus the pick time is enough. A random source would
 * work equally well but is not available identically in every test environment,
 * and this value is never a security decision.
 */
function nextAnnotationId(pickedAt: number): string {
  idCounter += 1
  return `a${pickedAt.toString(36)}-${idCounter.toString(36)}`
}

/** Fields a pick event must carry for the store to accept it. */
export interface PickedElement {
  /** Registry id handed out by the picker. */
  id: string
  /** Facts captured on the page at pick time. */
  facts: ElementFacts
}

/**
 * The panel's model.
 *
 * Every mutator returns the snapshot it produced, so a caller that needs to
 * render synchronously does not have to wait for the listener to fire.
 */
export class AnnotationStore {
  private readonly listeners = new Set<StoreListener>()
  private readonly storage: StateStorage
  private readonly tabId: number
  private readonly now: () => number

  private annotations: Annotation[] = []
  private page: PageContext | null = null
  private currentElementId: string | null = null
  private currentFacts: ElementFacts | null = null
  private picking = false
  private submitting = false
  private lastResult: string | null = null
  private retryable = false
  private stale = false

  /**
   * @param tabId - the tab these annotations belong to.
   * @param storage - persistence, injected so tests need no browser.
   * @param now - clock, injected so `pickedAt` is deterministic in tests.
   */
  constructor(tabId: number, storage: StateStorage = new MemoryStateStorage(), now: () => number = Date.now) {
    this.tabId = tabId
    this.storage = storage
    this.now = now
  }

  /** Subscribe to changes. @returns an unsubscribe function. */
  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The current state, as an immutable snapshot. */
  snapshot(): PanelSnapshot {
    return {
      currentElementId: this.currentElementId,
      currentFacts: this.currentFacts,
      annotations: [...this.annotations],
      page: this.page,
      picking: this.picking,
      submitting: this.submitting,
      lastResult: this.lastResult,
      retryable: this.retryable,
      stale: this.stale,
    }
  }

  /**
   * Restore whatever a previous panel run left for this tab.
   *
   * Everything read back is re-validated here as well as at the storage
   * boundary. The storage implementation is not the only thing that can hand
   * this method a value — a test, an older build, a future caller — and a row
   * that reached the list unchecked would be submitted to a model as though the
   * user had written it.
   */
  async restore(): Promise<void> {
    const restored = await this.storage.read(this.tabId)
    if (restored === null) return
    const usable = restored.annotations.filter(hasRestorableFacts).slice(0, MAX_ANNOTATIONS)
    // The page context goes through the same guard the storage read applies: a
    // `tel:` address or a missing viewport would make the batch fail the
    // bridge's own check long after the user could have done anything about it.
    const page = isStoredPage(restored.page) ? restored.page : null
    if (usable.length === 0 && page === null) return
    this.annotations = usable
    this.page = page
    this.emit()
  }

  /**
   * Record a pick. Re-picking the same element replaces the pending one.
   *
   * @param element - the registry id and the facts the page captured.
   * @param page - the page context captured with the pick, when it is known.
   *   The context matters at pick time rather than only at send time: the
   *   viewport in it describes where the pick's coordinates were measured, and a
   *   panel that only learned about the page later would report a viewport the
   *   element was never in.
   */
  setPicked(element: PickedElement, page?: PageContext): PanelSnapshot {
    this.currentElementId = element.id
    this.currentFacts = element.facts
    if (page !== undefined) {
      this.page = page
      this.stale = false
    }
    this.lastResult = null
    return this.emit()
  }

  /** Forget the pending pick, e.g. when the page changed under it. */
  clearPicked(): PanelSnapshot {
    this.currentElementId = null
    this.currentFacts = null
    return this.emit()
  }

  /**
   * Record where the batch was collected.
   *
   * Written once per page load and then left alone: the picker's own coordinates
   * are viewport-relative, so a page context that kept updating would claim
   * annotations were taken at a viewport they were not.
   */
  setPage(page: PageContext): PanelSnapshot {
    this.page = page
    this.stale = false
    return this.emit()
  }

  /** @returns the page context, or `null` before the page has answered. */
  getPage(): PageContext | null {
    return this.page
  }

  /** Record the picking mode the page reports. */
  setPicking(active: boolean): PanelSnapshot {
    if (this.picking === active) return this.snapshot()
    this.picking = active
    return this.emit()
  }

  /** @returns the pending element's registry id, or `null`. */
  getCurrentElementId(): string | null {
    return this.currentElementId
  }

  /** @returns the annotations, oldest first. */
  getAnnotations(): readonly Annotation[] {
    return this.annotations
  }

  /**
   * Commit the pending pick to the list.
   *
   * A blank comment is stored as an absent one rather than as `''`, so "the user
   * sent the element alone" stays distinguishable from "the user wrote nothing
   * and we recorded that they did" — the protocol treats an absent comment as a
   * fact, and a consumer can branch on it.
   *
   * @param comment - what the user typed; blank sends the element alone.
   * @returns the new annotation, or `null` when there is no pending pick or the
   *   batch is already at its ceiling.
   */
  commit(comment: string): Annotation | null {
    const facts = this.currentFacts
    const elementId = this.currentElementId
    if (facts === null || elementId === null) return null
    if (this.annotations.length >= MAX_ANNOTATIONS) return null

    const trimmed = comment.trim().slice(0, MAX_COMMENT_LENGTH)
    const annotation: Annotation = {
      id: nextAnnotationId(this.now()),
      facts,
      pickedAt: this.now(),
    }
    if (trimmed !== '') annotation.comment = trimmed
    this.annotations.push(annotation)

    this.currentElementId = null
    this.currentFacts = null
    // Committing ends the pass: the user has described what they picked, and
    // leaving the page armed would keep swallowing their clicks without telling
    // them why. Clearing it here rather than only in the caller keeps the two
    // pieces of state from ever disagreeing.
    this.picking = false
    this.lastResult = null
    this.retryable = false
    this.emit()
    return annotation
  }

  /**
   * Remove one annotation.
   *
   * @param id - the annotation's id.
   * @returns whether a row was removed.
   */
  remove(id: string): boolean {
    const before = this.annotations.length
    this.annotations = this.annotations.filter((annotation) => annotation.id !== id)
    if (this.annotations.length === before) return false
    this.emit()
    return true
  }

  /**
   * Replace a comment on an existing annotation.
   *
   * @param id - the annotation to edit.
   * @param comment - the new text; blank removes the comment.
   * @returns whether the annotation was found.
   */
  setComment(id: string, comment: string): boolean {
    const index = this.annotations.findIndex((annotation) => annotation.id === id)
    if (index === -1) return false
    const trimmed = comment.trim().slice(0, MAX_COMMENT_LENGTH)
    this.annotations = this.annotations.map((annotation, at) => {
      if (at !== index) return annotation
      const next: Annotation = { id: annotation.id, facts: annotation.facts, pickedAt: annotation.pickedAt }
      if (trimmed !== '') next.comment = trimmed
      return next
    })
    this.emit()
    return true
  }

  /** Drop every annotation. The panel keeps no undo stack: the batch is cheap
   * to rebuild and a confirmation step would cost more than the mistake. */
  clear(): PanelSnapshot {
    this.annotations = []
    this.lastResult = null
    this.retryable = false
    return this.emit()
  }

  /** Record that a submission has begun. */
  beginSubmit(): PanelSnapshot {
    this.submitting = true
    this.lastResult = null
    return this.emit()
  }

  /**
   * Record the outcome of a submission.
   *
   * @param message - what to show the user.
   * @param retryable - whether offering a retry makes sense. A rejection for a
   *   bad payload is not fixable by sending it again, and offering the button
   *   would train the user to press it.
   */
  finishSubmit(message: string, retryable: boolean): PanelSnapshot {
    this.submitting = false
    this.lastResult = message
    this.retryable = retryable
    return this.emit()
  }

  /** Forget the last submission result, e.g. once the user edits the list. */
  clearResult(): PanelSnapshot {
    if (this.lastResult === null && !this.retryable) return this.snapshot()
    this.lastResult = null
    this.retryable = false
    return this.emit()
  }

  /**
   * Mark the page facts as stale, or clear that marking.
   *
   * Set on a navigation and on a page that stopped answering. The rows stay —
   * they are the user's own work and are still worth sending — but the panel
   * must stop claiming they describe the page in front of the user, because a
   * model told "this is what the page looks like" would act on a reading that
   * has since been invalidated.
   *
   * @param stale - whether the recorded page facts can no longer be trusted.
   */
  setStale(stale: boolean): PanelSnapshot {
    if (this.stale === stale) return this.snapshot()
    this.stale = stale
    return this.emit()
  }

  /**
   * Persist the current state.
   *
   * An empty batch with no page is written as a removal rather than as an empty
   * record: the storage is shared per profile and a panel that only ever added
   * keys would accumulate one for every tab the user had ever opened.
   */
  async persist(): Promise<void> {
    if (this.annotations.length === 0 && this.page === null) {
      await this.storage.clear(this.tabId)
      return
    }
    await this.storage.write(this.tabId, { annotations: this.annotations, page: this.page })
  }

  /** Notify listeners and hand them the new snapshot. */
  private emit(): PanelSnapshot {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
    return snapshot
  }
}

/** The protocol version a batch built by this panel carries. */
export const BATCH_VERSION = PROTOCOL_VERSION

/**
 * Which family of address a URL belongs to.
 *
 * Re-exported through a local name so the panel does not have to import the
 * protocol module in three places to answer one question.
 *
 * @param url - the page's address.
 * @returns the kind, or `null` for an address this extension may not annotate.
 */
export function kindOfPage(url: string): PageKind | null {
  return pageKindOf(url)
}
