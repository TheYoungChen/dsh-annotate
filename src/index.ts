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
import { BridgeServer, type BridgeLogger, type BridgeStatus } from './bridge.ts'
import { DEFAULT_PORT, PROTOCOL_VERSION, type AnnotationBatch } from './protocol.ts'

/** Plugin identity for `cordis.patch.yml` rows. Must match the row's `id`. */
export const name = 'dsh-annotate'

/**
 * Services required before mounting.
 *
 * Only `tools` is hard-required: the bridge is a plain Node socket server and
 * needs nothing from DSH. Later workstreams (conversation injection) will add
 * `sessions` here.
 */
export const inject = ['tools']

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
   * Batch sink.
   *
   * TODO(conversation-injection): hand `batch` to the renderer that produces the
   * `🎯 界面标注` text block and injects it into the session composer without
   * sending it. Until that module exists, resolving is the honest behaviour:
   * the batch genuinely arrived and passed validation, and rejecting would make
   * the extension believe its delivery failed and retry.
   */
  const onSubmit = async (batch: AnnotationBatch): Promise<void> => {
    ctx.logger?.info(
      `[dsh-annotate] received batch ${batch.batchId}: ${batch.annotations.length} annotation(s) from ${batch.page.url}`,
    )
    // TODO(conversation-injection): await injectBatch(ctx, batch)
    await Promise.resolve()
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
