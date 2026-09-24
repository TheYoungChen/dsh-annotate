/**
 * The message contract between page content scripts and the service worker.
 *
 * This is a separate protocol from the one the bridge speaks, and it is kept in
 * its own module on purpose. The bridge protocol is a wire format between two
 * processes and carries versions, tokens and batches; this one only ever crosses
 * a browser-internal boundary, where the sender is already authenticated by the
 * extension platform. Merging the two would let a page-adjacent message be
 * mistaken for a bridge frame, which is the one confusion that could turn a
 * hostile page into a trusted peer.
 *
 * Everything arriving here is treated as untrusted. The sender is a content
 * script the extension owns, but the payload inside it was assembled from page
 * DOM, so each message is narrowed field by field before any of it is used.
 *
 * @module
 */

import { isAnnotationBatch, type AnnotationBatch } from '../../../src/protocol.ts'

/** Tag that marks every message in this protocol, so stray traffic is rejected. */
const WIRE_TAG = 'dsh-annotate'

/**
 * How the content script addresses a frame.
 *
 * The ids are integers the browser assigned, so they are always present; the URL
 * is optional metadata used to describe a frame the worker could not resolve.
 */
export interface FrameRef {
  /** The sender's frame id, as the browser assigned it. */
  readonly frameId: number
  /** The sender's document URL, when the content script reported one. */
  readonly url?: string | undefined
}

/**
 * A batch of annotations collected in one frame, on its way to the bridge.
 *
 * Sent per frame rather than per tab because a batch describes exactly one
 * document: `page.viewport` and every `facts.rect` are frame-local coordinates,
 * and merging two frames' facts into one batch would make the coordinates of one
 * document describe the other.
 */
export interface BatchMessage {
  readonly tag: typeof WIRE_TAG
  readonly kind: 'batch'
  /** Which tab this came from, as the content script observed it. */
  readonly tabId: number
  /** Which frame this came from. */
  readonly frame: FrameRef
  /** The batch, as received. Validated before use. */
  readonly batch: AnnotationBatch
}

/**
 * The user activated picking mode in this frame.
 *
 * Sent by the frame that actually armed, which is how the worker learns the mode
 * is live without having to broadcast a query to every frame first.
 */
export interface PickingStartedMessage {
  readonly tag: typeof WIRE_TAG
  readonly kind: 'picking-started'
  readonly tabId: number
  readonly frame: FrameRef
}

/** Picking mode ended in this frame, for any reason including a completed pick. */
export interface PickingEndedMessage {
  readonly tag: typeof WIRE_TAG
  readonly kind: 'picking-ended'
  readonly tabId: number
  readonly frame: FrameRef
  /** Why it ended, as the picker reported it. */
  readonly reason: string
}

/**
 * The worker asks a worker-managed value of the content script.
 *
 * A content script has no `chrome.storage` access worth relying on and cannot
 * see the extension's own settings, so anything the page-side code needs to know
 * about the extension's configuration has to be asked for.
 */
export interface StateQueryMessage {
  readonly tag: typeof WIRE_TAG
  readonly kind: 'state-query'
  readonly tabId: number
  readonly frame: FrameRef
}

/** A worker-to-content instruction to arm or disarm the picker. */
export interface PickCommandMessage {
  readonly tag: typeof WIRE_TAG
  readonly kind: 'pick-command'
  /** `start` arms the picker; `stop` disarms it. */
  readonly command: 'start' | 'stop'
  /**
   * Whether the picker should survive a pick.
   *
   * The user annotates several elements in one pass, so a single click must not
   * end the mode; the flag travels with the command because the content script
   * cannot know how many annotations the user intends.
   */
  readonly keepAlive: boolean
  /** Hint-strip text, so the page-side UI can be localised without a rebuild. */
  readonly hintText?: string | undefined
}

/** Everything a content script may send to the worker. */
export type ContentMessage =
  | BatchMessage
  | PickingStartedMessage
  | PickingEndedMessage
  | StateQueryMessage

/** Whether a value is a record, narrowed for field inspection. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Narrow a frame reference.
 *
 * A message with an unusable frame reference is dropped rather than repaired:
 * the frame id decides which tab slot the batch belongs to, and guessing it
 * would attach one page's annotations to another page's conversation.
 *
 * @param value - candidate frame reference.
 * @returns the reference, or `undefined`.
 */
function readFrameRef(value: unknown): FrameRef | undefined {
  if (!isRecord(value)) return undefined
  const frameId = value['frameId']
  if (typeof frameId !== 'number' || !Number.isInteger(frameId) || frameId < 0) return undefined
  const url = value['url']
  if (url !== undefined && typeof url !== 'string') return undefined
  return url === undefined ? { frameId } : { frameId, url }
}

/** Read a tab id, rejecting anything that is not a non-negative integer. */
function readTabId(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined
  return value
}

/**
 * Narrow one message from a content script.
 *
 * Returns `undefined` for anything this worker does not own, which is the normal
 * outcome for a message addressed to a different part of the extension — the
 * sender's channel stays open and another listener answers.
 *
 * @param value - the message as received.
 * @returns the narrowed message, or `undefined`.
 */
export function parseContentMessage(value: unknown): ContentMessage | undefined {
  if (!isRecord(value)) return undefined
  if (value['tag'] !== WIRE_TAG) return undefined

  const tabId = readTabId(value['tabId'])
  if (tabId === undefined) return undefined
  const frame = readFrameRef(value['frame'])
  if (frame === undefined) return undefined

  switch (value['kind']) {
    case 'batch':
      if (!isAnnotationBatch(value['batch'])) return undefined
      return { tag: WIRE_TAG, kind: 'batch', tabId, frame, batch: value['batch'] }
    case 'picking-started':
      return { tag: WIRE_TAG, kind: 'picking-started', tabId, frame }
    case 'picking-ended': {
      const reason = value['reason']
      if (typeof reason !== 'string') return undefined
      return { tag: WIRE_TAG, kind: 'picking-ended', tabId, frame, reason }
    }
    case 'state-query':
      return { tag: WIRE_TAG, kind: 'state-query', tabId, frame }
    default:
      return undefined
  }
}

/**
 * Build a pick command for a content script.
 *
 * The tag is included even though only the worker ever sends this shape: a
 * content script validates inbound messages with the same tag check it applies
 * to everything, and an untagged frame would be dropped on arrival.
 *
 * @param command - whether to arm or disarm.
 * @param options - `keepAlive` and an optional localised hint.
 * @returns the message to send.
 */
export function pickCommand(
  command: 'start' | 'stop',
  options: { keepAlive: boolean; hintText?: string | undefined },
): PickCommandMessage {
  const message: PickCommandMessage = {
    tag: WIRE_TAG,
    kind: 'pick-command',
    command,
    keepAlive: options.keepAlive,
  }
  // `exactOptionalPropertyTypes` distinguishes "absent" from "present and
  // undefined", and the content script reads absence to decide whether to keep
  // its own default hint, so the field is added rather than set to undefined.
  return options.hintText === undefined ? message : { ...message, hintText: options.hintText }
}

/**
 * Whether a value is the command shape a content script should act on.
 *
 * Exported for the content script's own entry point, so both sides of the
 * protocol agree on what a valid command is without duplicating the field list.
 *
 * @param value - candidate message.
 * @returns whether it is a usable pick command.
 */
export function isPickCommand(value: unknown): value is PickCommandMessage {
  if (!isRecord(value)) return false
  if (value['tag'] !== WIRE_TAG) return false
  if (value['kind'] !== 'pick-command') return false
  if (value['command'] !== 'start' && value['command'] !== 'stop') return false
  return typeof value['keepAlive'] === 'boolean'
}
