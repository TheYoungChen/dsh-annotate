/**
 * Shared test doubles and fixtures.
 *
 * The panel is a browser extension page, so its tests have to supply the three
 * things that environment provides: a document, a message channel and an
 * extension API surface. Nothing here loads an extension or opens a browser —
 * the panel's own modules are plain ES modules, and everything they reach for is
 * behind an interface this file implements.
 */

import type { Annotation, ElementFacts, PageContext } from '../../src/protocol.ts'
import { PROTOCOL_VERSION } from '../../src/protocol.ts'
import type {
  ContentEvent,
  PageDescription,
  PageResponse,
  PanelCommand,
  PanelCommandResult,
} from '../../extension/src/panel/messages.ts'
import type { MessageTransport, PageSource } from '../../extension/src/panel/page-source.ts'

/** A facts object with every required field, plus any overrides. */
export function facts(overrides: Partial<ElementFacts> = {}): ElementFacts {
  return {
    tag: 'button',
    selector: 'button.primary',
    selectorMatches: 1,
    rect: { x: 10, y: 20, width: 96, height: 32 },
    inViewport: true,
    frameDepth: 0,
    ...overrides,
  }
}

/** An annotation with defaults, plus any overrides. */
export function annotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'a1',
    facts: facts(),
    pickedAt: 1_700_000_000_000,
    ...overrides,
  }
}

/** A page context for a URL. */
export function pageContext(url = 'https://example.test/settings', title = 'Settings'): PageContext {
  return {
    url,
    title,
    kind: url.startsWith('file://') ? 'file' : 'https',
    viewport: { width: 1280, height: 800 },
  }
}

/** What one recorded call to the transport was. */
export interface RecordedCommand {
  command: PanelCommand
}

/**
 * A message channel that answers from a script instead of from a browser.
 *
 * Answers are keyed by command type; a command with no scripted answer resolves
 * with `undefined`, which is exactly what a channel with no receiver does, so
 * the panel's "unreachable page" paths get exercised by default.
 */
export class FakeTransport implements MessageTransport {
  readonly sent: PanelCommand[] = []
  private readonly answers = new Map<string, unknown>()
  /** Set to make every send reject, as a torn-down receiver does. */
  rejectWith: Error | null = null
  /** Set to make every send hang, as a missing receiver does. */
  hang = false

  /** Script the answer for one command type. */
  answer(type: PanelCommand['type'], value: unknown): void {
    this.answers.set(type, value)
  }

  send(message: PanelCommand): Promise<unknown> {
    this.sent.push(message)
    if (this.rejectWith !== null) return Promise.reject(this.rejectWith)
    if (this.hang) return new Promise<unknown>(() => { /* never settles */ })
    return Promise.resolve(this.answers.get(message.type))
  }

  /** The page requests relayed through this transport, in order. */
  requests(): Array<Extract<PanelCommand, { type: 'annotate:page' }>['request']> {
    return this.sent
      .filter((command): command is Extract<PanelCommand, { type: 'annotate:page' }> => command.type === 'annotate:page')
      .map((command) => command.request)
  }
}

/** A page source with every method scripted, for controller tests. */
export class FakePageSource implements PageSource {
  readonly flashed: string[] = []
  readonly probed: string[][] = []
  readonly stopped: number = 0
  startResult = true
  description: PageDescription | null = { url: 'https://example.test/settings', title: 'Settings', frameKind: 'top' }
  alive = new Set<string>()
  submitResult: PanelCommandResult = { ok: true, kind: 'submitted' }
  /** Calls made, in order. */
  readonly calls: string[] = []

  async describePage(): Promise<PageDescription | null> {
    this.calls.push('describePage')
    return this.description
  }

  async startPicking(): Promise<boolean> {
    this.calls.push('startPicking')
    return this.startResult
  }

  async stopPicking(): Promise<void> {
    this.calls.push('stopPicking')
  }

  async flash(elementId: string): Promise<boolean> {
    this.calls.push(`flash:${elementId}`)
    this.flashed.push(elementId)
    return true
  }

  async probe(elementIds: string[]): Promise<Set<string>> {
    this.calls.push(`probe:${elementIds.join(',')}`)
    this.probed.push(elementIds)
    return new Set(elementIds.filter((id) => this.alive.has(id)))
  }

  async submit(): Promise<PanelCommandResult> {
    this.calls.push('submit')
    return this.submitResult
  }
}

/** A page response of the shape a content script would return. */
export function pageResponse(page: PageDescription): PageResponse {
  return { ok: true, kind: 'page', page }
}

/** A content-script event of the shape the panel listens for. */
export function contentEvent(event: ContentEvent): ContentEvent {
  return event
}

/** A batch of the shape the panel would submit. */
export function batchOf(annotations: Annotation[]): {
  version: typeof PROTOCOL_VERSION
  batchId: string
  page: PageContext
  annotations: Annotation[]
  submittedAt: number
} {
  return {
    version: PROTOCOL_VERSION,
    batchId: 'b1',
    page: pageContext(),
    annotations,
    submittedAt: 1,
  }
}
