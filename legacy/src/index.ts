/**
 * dsh-annotate host half: the DSH plugin entry point.
 *
 * Responsibilities, in order of importance:
 *
 * 1. Own one {@link BridgeServer} for the lifetime of the plugin fiber, so the
 *    browser extension always has exactly one loopback port to dial.
 * 2. Register the model-facing `annotate_status` tool, which is the only way the
 *    model can learn whether an extension is actually attached.
 *
 * The batch -> conversation pipeline (turning an {@link AnnotationBatch} into
 * text and injecting it into the composer) is a separate concern that lands in
 * the "conversation injection" workstream; this file wires the seam for it via
 * `onSubmit` and leaves the rendering itself to that module.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// Loaded for its module augmentation only: `@deepseek-ai/dsh-host-webserver`
// declares `Context.webServer`, and a declaration merge only applies when the
// declaring module is part of the program. Without this import the route
// registration below fails to typecheck even though the runtime service exists.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { BridgeServer, type BridgeLogger, type BridgeStatus } from './bridge.ts'
import { formatBatch, injectBatch, mergeIntoDraft, type ComposerPort } from './inject.ts'
import { DEFAULT_PORT, PROTOCOL_VERSION, type AnnotationBatch } from './protocol.ts'
import { createPairingRouteHandler } from './client/pairing-route.ts'
import { createInjectionRelay } from './client/injection-relay.ts'
import { ROUTE_PREFIX } from './client/pairing-contract.ts'

/** Plugin identity for `cordis.patch.yml` rows. Must match the row's `id`. */
export const name = 'dsh-annotate'

/**
 * Services required before mounting.
 *
 * Only `tools` is hard-required: the bridge is a plain Node socket server and
 * needs nothing from DSH. Later workstreams (conversation injection) will add
 * `sessions` here.
 */
export const inject = ['tools', 'webServer']

/** Plugin config, validated by the cordis Loader when a row supplies a value. */
export interface AnnotateConfig {
  /**
   * Loopback port for the bridge. Defaults to {@link DEFAULT_PORT}.
   *
   * Overridable because 43120 can be held by a stale DSH process during
   * development; the extension's `connect-src` allows any `ws://127.0.0.1:*`,
   * so a non-default port works without a manifest change.
   */
  port?: number
  /** Log bridge lifecycle events to the DSH logger. Defaults to true. */
  log?: boolean
}

/** Resolve config, filling defaults. */
function resolveConfig(config: AnnotateConfig | undefined): Required<AnnotateConfig> {
  return { port: config?.port ?? DEFAULT_PORT, log: config?.log ?? true }
}

/**
 * Build the `annotate_status` canonical output value from a bridge snapshot.
 *
 * Kept separate from the tool so the projection is testable without a bridge.
 *
 * @param status - the bridge's current state.
 * @param tokenGenerated - whether a bearer token exists for this instance.
 * @returns the canonical value the tool declares in its output schema.
 */
export function statusValue(status: BridgeStatus, tokenGenerated: boolean): {
  connected: boolean
  listening: boolean
  port: number
  address: string
  extensionId: string | null
  protocolVersion: number | null
  pendingSince: number | null
  lastPingMs: number | null
  batchesReceived: number
  batchesRejected: number
  tokenGenerated: boolean
} {
  return {
    connected: status.connected,
    listening: status.listening,
    port: status.port,
    address: status.address,
    extensionId: status.extensionId,
    protocolVersion: status.protocolVersion,
    pendingSince: status.connectedAt,
    lastPingMs: status.lastPingMs,
    batchesReceived: status.batchesReceived,
    batchesRejected: status.batchesRejected,
    // Never the token itself: the value is logged and sent to the model, and
    // possession of the token is the whole credential.
    tokenGenerated,
  }
}

/** Pure text projection of {@link statusValue} for the model. */
function renderStatus(value: ReturnType<typeof statusValue>): ContentBlock[] {
  const lines: string[] = []
  if (!value.listening) {
    lines.push(`The dsh-annotate bridge is NOT listening (port ${value.port} is unbound; the plugin may have failed to start).`)
  } else if (value.connected) {
    lines.push(`A browser extension IS connected to the dsh-annotate bridge.`)
    lines.push(`- extension id: ${value.extensionId ?? 'unknown'}`)
    lines.push(`- bridge: ws://${value.address}:${value.port} (protocol v${value.protocolVersion ?? PROTOCOL_VERSION})`)
    if (value.lastPingMs !== null) lines.push(`- last ping round-trip: ${value.lastPingMs}ms`)
  } else {
    lines.push(`No browser extension is connected to the dsh-annotate bridge.`)
    lines.push(`- bridge is listening on ws://${value.address}:${value.port}`)
    lines.push(`- the user must have the dsh-annotate extension installed and its service worker active`)
  }
  lines.push(`- batches received: ${value.batchesReceived} (rejected by validation: ${value.batchesRejected})`)
  lines.push(`- bearer token: ${value.tokenGenerated ? 'generated' : 'missing'}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Plugin body. Mounts the bridge and registers the status tool; both are torn
 * down through `ctx.effect` when the plugin unloads.
 *
 * @param ctx - host plugin context carrying the `tools` service.
 * @param config - deployment-provided port and logging options.
 */
export function apply(ctx: Context, config?: AnnotateConfig): void {
  const resolved = resolveConfig(config)

  /** Adapter so `BridgeServer` does not depend on the DSH logger shape. */
  const bridgeLogger: BridgeLogger = resolved.log
    ? {
        info: (message: string) => { ctx.logger?.info(message) },
        warn: (message: string) => { ctx.logger?.warn(message) },
        error: (message: string) => { ctx.logger?.error(message) },
      }
    : { info: () => {}, warn: () => {}, error: () => {} }

  /**
   * The composer seam, backed by this plugin's own host->client crossing.
   *
   * DSH has no host-side API for writing a composer draft: the draft belongs to
   * the browser client, whose only supported write is its own `setDraft(text)`,
   * while every host-side alternative *sends* (queueing a turn, steering a
   * running one), which this plugin must never do on the user's behalf. The
   * framework's host->client event channel is a fixed allowlist a plugin cannot
   * join, so the crossing is this plugin's own: the host parks the rendered
   * block on its own HTTP route (`client/pairing-route.ts`), and this plugin's
   * browser half claims it, calls `setDraft`, and acknowledges.
   *
   * The port below is the host END of that crossing, and it is honest about what
   * the host can see:
   *
   * - `isAvailable` is always false. The host genuinely cannot observe whether a
   *   composer is reachable, so claiming otherwise would make it report a
   *   delivery it never saw. A false here does not lose the batch — it routes
   *   `injectBatch` into the parked-log branch below, which renders the text and
   *   hands it to the relay.
   * - `readDraft` is undefined for the same reason: the host has no view of the
   *   user's in-progress text, and returning `''` would let it "merge" against a
   *   draft it invented.
   * - The merge happens on the browser side, against the real draft, through the
   *   same `mergeIntoDraft` the renderer already uses.
   *
   * When no browser half is running (a headless DSH, or the GUI simply never
   * opened) the relay still fills and the batch still resolves, so the extension
   * is never told its annotations were lost; the block waits in the mailbox and
   * is delivered if a page claims it in time.
   */
  const relay = createInjectionRelay({
    log: (message: string) => { ctx.logger?.info(message) },
  })
  const composerPort: ComposerPort | undefined = relay.port

  /**
   * Batch sink: render the batch, then offer it to the session's composer.
   *
   * Resolving is the honest outcome even when the batch could not be delivered,
   * for the reason above — the batch genuinely arrived and passed validation,
   * and the loss is ours to report in the log rather than the extension's to
   * retry.
   *
   * The two branches are the two halves of the crossing. `result.ok` only
   * happens when a port could actually see a composer, which the host-side port
   * never can; the second branch is therefore the normal path: the rendered text
   * is parked for the browser half, and the log line says so. The text is logged
   * either way, so the feature is diagnosable from a log alone.
   */
  const onSubmit = async (batch: AnnotationBatch): Promise<void> => {
    ctx.logger?.info(
      `[dsh-annotate] received batch ${batch.batchId}: ${batch.annotations.length} annotation(s) from ${batch.page.url}`,
    )

    const result = injectBatch(batch.sessionId, batch, composerPort)
    if (result.ok) {
      ctx.logger?.info(
        `[dsh-annotate] injected batch ${batch.batchId} into the composer for session ${result.sessionId}`,
      )
      return
    }

    // Park the block for the browser half. The session is required: a batch that
    // names no session cannot be routed to a composer, and guessing one would
    // put page facts into a conversation that has no context for them.
    if (batch.sessionId !== undefined && batch.sessionId !== '') {
      const text = formatBatch(batch)
      const merged = mergeIntoDraft('', text)
      composerPort?.setDraft(batch.sessionId, merged.text)
      ctx.logger?.info(
        `[dsh-annotate] batch ${batch.batchId} parked for the browser half (${result.reason}): ${result.detail}`,
      )
    } else {
      ctx.logger?.info(`[dsh-annotate] batch ${batch.batchId} was not injected (${result.reason}): ${result.detail}`)
    }

    if (resolved.log) ctx.logger?.info(`[dsh-annotate] rendered block:\n${formatBatch(batch)}`)
  }

  const bridge = new BridgeServer({
    port: resolved.port,
    onSubmit,
    logger: bridgeLogger,
  })

  // `ctx.effect` ties the bridge's lifetime to the plugin fiber: the disposer
  // runs on unload, on reload, and on process teardown, so the loopback port is
  // never left bound by a dead plugin generation.
  ctx.effect(() => {
    // `start()` rejects when the port is taken. A rejected start must not take
    // the whole DSH host down, so the failure is logged and the status tool
    // reports `listening: false` instead.
    void bridge.start().catch((error: unknown) => {
      ctx.logger?.error(
        `[dsh-annotate] bridge failed to bind ws://127.0.0.1:${resolved.port}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    return () => {
      void bridge.stop().catch(() => { /* teardown is best-effort by definition */ })
    }
  }, 'dsh-annotate: loopback bridge')

  /**
   * Pairing routes: how the user reads the bearer token to type into the
   * extension, how the settings section learns whether the extension is up, and
   * how this plugin's browser half collects the annotation blocks the host
   * parked for it.
   *
   * A prefix registration rather than an index injection, deliberately. The
   * index-injection channel inlines its value into `index.html`, which would
   * hand the token to anything that can load the page; a route is only readable
   * by a caller that already clears DSH's own browser-trust fence.
   *
   * The injection members are wired here rather than inside the handler because
   * the relay is the host's own state: the handler is the transport, the relay
   * is the mailbox, and keeping them separate is what lets the handler be tested
   * against a stub mailbox.
   */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: createPairingRouteHandler({
          status: () => bridge.status(),
          token: () => bridge.getToken(),
          takeInjections: () => relay.takePending(),
          acknowledgeInjections: (ids: readonly string[]) => relay.acknowledge(ids),
          log: (message: string) => { ctx.logger?.info(message) },
        }),
      }),
    'dsh-annotate: pairing routes',
  )

  /**
   * `annotate_status`: the model's only window onto bridge state.
   *
   * Read-only and side-effect-free, so it is safe to call at any point in a
   * conversation — it answers "can I ask the user to annotate right now?".
   */
  const statusTool = defineTool({
    name: 'annotate_status',
    description:
      'Check the dsh-annotate browser bridge: whether it is listening, which loopback port it owns, '
      + 'and whether the dsh-annotate browser extension is currently connected. '
      + 'Call this before asking the user to annotate a page element, and again if a previously '
      + 'connected extension may have gone away. This tool only reports state; it does not start or stop annotation.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'boolean', required: true, description: 'Whether an authenticated extension currently owns the bridge connection.' },
          listening: { type: 'boolean', required: true, description: 'Whether the loopback bridge socket is bound.' },
          port: { type: 'integer', required: true, description: 'Loopback port the bridge is configured to use.' },
          address: { type: 'string', required: true, description: 'Bind address. Always loopback.' },
          // JSON Schema unions are expressed as `oneOf`: the enforced subset
          // types `type` as a SINGLE string, so `type: ['string','null']`
          // (valid JSON Schema) is rejected at registration time.
          extensionId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true, description: 'The connected extension id, or null.' },
          protocolVersion: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true, description: 'Negotiated protocol version, or null.' },
          pendingSince: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true, description: 'Epoch ms when the current connection was established, or null.' },
          lastPingMs: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true, description: 'Round-trip latency of the last keepalive, or null.' },
          batchesReceived: { type: 'integer', required: true, description: 'Batches accepted since the bridge started.' },
          batchesRejected: { type: 'integer', required: true, description: 'Batches dropped by protocol validation since the bridge started.' },
          tokenGenerated: { type: 'boolean', required: true, description: 'Whether a bearer token exists. The token value itself is never returned.' },
        },
      },
      render: (_args: unknown, value: unknown) => renderStatus(value as ReturnType<typeof statusValue>),
    },
    execute: async () => statusValue(bridge.status(), bridge.getToken().length > 0),
  })

  ctx.tools.register(statusTool)
}
