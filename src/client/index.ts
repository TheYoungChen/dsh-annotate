/**
 * dsh-annotate client half: the pairing entry in DSH's Settings panel.
 *
 * Placement reasoning. The plugin needs one place in the DSH GUI to explain
 * itself and hand over the pairing token. Three candidates exist, and only one
 * of them is this plugin's to take:
 *
 * - A conversation card would put a persistent, mostly-unchanged setup step in
 *   the middle of the conversation, which is the one surface the design
 *   principles reserve for the facts being annotated.
 * - The right-hand sidebar is owned by another package's tab system; adding a
 *   tab there means registering into a third party's seat, which the project
 *   forbids outright.
 * - The Settings panel is a general extension point: DSH's own settings shell
 *   declares `settings.section` as an ordered list, and every package that
 *   owns a preference contributes one entry. This plugin owns its own entry
 *   under its own id, so it takes nothing that was somebody else's.
 *
 * The Settings panel also matches the lifecycle of the content: pairing is a
 * one-time configuration step, and nobody needs it on screen while annotating.
 *
 * The transport is this plugin's own (`pairing-route.ts`), registered on the
 * DSH web server by the host half; nothing here reads another plugin's
 * service, value, or UI container.
 *
 * @module
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the settings shell's SlotMap merge (`settings.section`) and
// the locale plugin's Context merge (`ctx.locale`). Cross-plugin collaboration
// crosses through services and slots, never through value imports.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PairingSection } from './PairingSection.tsx'
import { installClientComposerPort, type ClientContextLike } from './composer-port.ts'
import { startInjectionTransport } from './injection-transport.ts'
import { en, zh, NS, type AnnotateKey } from './locales.ts'

export type { AnnotateKey } from './locales.ts'
export type { PairingSectionProps } from './PairingSection.tsx'
export type { ClientComposerPort, ClientContextLike } from './composer-port.ts'
export { createClientComposerPort, installClientComposerPort } from './composer-port.ts'
export { applyInjection, startInjectionTransport } from './injection-transport.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The pairing section's copy. */
    annotate: AnnotateKey
  }
}

/**
 * The plugin's id on the client side.
 *
 * The loader writes this name onto the module it registers, and the host's
 * client-entry graph is keyed by it, so omitting it leaves the row unidentified:
 * the bundle loads, its factory runs, and nothing it contributes is ever
 * attributed to a plugin. Matches `name` in `src/index.ts`.
 */
export const name = 'dsh-annotate'

/**
 * Services required before this half mounts.
 *
 * `slots` is the composition registry and `locale` backs the section's copy.
 * Both are client-runtime services this plugin only consumes; it provides none
 * of its own, so no other package can end up depending on this one.
 *
 * `conversation` is declared because this half is also the only code in the
 * plugin that can reach a composer: the host cannot write a draft, so the
 * annotation blocks it accepts have to be typed in from here. Cordis reads a
 * key whose config is `undefined` as optional
 * (`Inject.resolve` → `{}[name] ?? null` → null → skipped), so a deployment that
 * composes this client half without the conversation packages still mounts: the
 * injection loop simply never starts, and the host keeps declining batches the
 * way it always did. The same is true of the runtime services this half reads by
 * name — a name that is NOT in this list resolves to `undefined` on the context
 * proxy, while a name that IS listed and missing would throw instead.
 */
export const inject = ['slots', 'locale', { conversation: undefined }]

/**
 * Client plugin body: register this plugin's dictionaries and its one Settings
 * entry, then start the injection loop.
 *
 * The registration is wrapped in `slots.inject` because the Settings shell —
 * which owns and declares `settings.section` — may activate after this plugin.
 * `inject` waits for the declaration to come onto the ledger instead of
 * requiring a startup order, and it removes the contribution again if the
 * shell is torn down; a bare `slots.register` into an undeclared slot throws.
 *
 * The injection loop starts before that registration and is not gated on it:
 * injecting must work whether or not the user ever opens Settings, and the loop
 * is the one part of this half that has to be running for annotations to land.
 *
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-annotate: dictionaries')

  startInjection(ctx)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    // The id is this plugin's own name, so the nav row can never collide with
    // a section another package contributes.
    id: 'dsh-annotate',
    // After the built-in General (0) and Plugins (15) sections, so this
    // plugin never pushes a first-party page down the nav.
    order: 40,
    // A thunk, so the nav label follows a live locale switch without this
    // plugin re-registering on every change.
    label: () => t('nav'),
    locale: NS,
  }, PairingSection))
}

/**
 * Install the composer port and start polling for injections.
 *
 * Both the port and the loop live under one `ctx.effect`, so a client reload
 * tears down the poller and the port together — a reloaded page can never leave
 * an older generation's loop draining the host mailbox.
 *
 * @param ctx - the browser plugin context.
 */
function startInjection(ctx: ClientContext): void {
  ctx.effect(() => {
    const installed = installClientComposerPort(ctx as unknown as ClientContextLike, (port) => {
      transport = startInjectionTransport({
        port,
        log: (message: string) => { ctx.logger?.info(message) },
      })
      ctx.logger?.info('[dsh-annotate] composer port installed; awaiting annotation blocks')
    })
    if (!installed) {
      // Not an error and not silent: with no conversation service this page has
      // no composer to write, so the host will keep parking batches in the log.
      ctx.logger?.info('[dsh-annotate] no conversation service on this client; composer injection is inactive')
    }
    return () => {
      transport?.stop()
      transport = undefined
    }
  }, 'dsh-annotate: composer injection')
}

/** The live injection loop, when one was started. */
let transport: ReturnType<typeof startInjectionTransport> | undefined
