/**
 * The composer port: how a batch that the HOST accepted reaches the BROWSER's
 * composer.
 *
 * ## Why this file is the crossing
 *
 * A batch arrives over the loopback bridge, which lives in the Node host; the
 * composer draft lives in the page. The host has no way to write a draft at
 * all — every host-side write path *sends* a turn — so the two halves have to
 * meet somewhere. They meet on this plugin's own HTTP routes (see
 * `pairing-route.ts`), which the host already serves and this page can already
 * read. The host parks the rendered text there; the page collects it, writes it
 * into the composer through the client's own `setDraft`, and only then
 * acknowledges. Nothing is lost if the page is not open: the text simply stays
 * parked until it is.
 *
 * ## Why the shape below is written out instead of imported
 *
 * The client's session-conversation service is declared in a client package
 * that this plugin deliberately does not depend on: the package is an optional
 * peer, and a build must still typecheck where it is absent. The port therefore
 * mirrors the *structure* it calls, at its true (narrow) width — a resolved
 * session scope, a per-session input facade, `setDraft` and the published draft
 * state — and reaches the service by name at runtime. The mirror is intentionally
 * import-free: it is a seam, and a seam that cannot be loaded without the thing
 * it seams is not a seam.
 *
 * ## The three verbs, and the one that is missing
 *
 * {@link ClientComposerPort} has exactly `isAvailable`, `readDraft` and
 * `setDraft`. There is deliberately no member that posts the draft and no such
 * call anywhere in this module, so no implementation reachable through this port
 * can put a message on the user's behalf. Filling the box and pressing Enter are
 * separate user gestures, and the cheapest way to keep them separate in practice
 * is to keep them separate in the type. `tests/client-injection.test.ts` locks
 * that member list and additionally sweeps this module for any Enter-shaped call.
 *
 * @module
 */

/**
 * Published input state of one session's composer, as this plugin reads it.
 *
 * Only the draft is mirrored: it is the one field the merge needs, and mirroring
 * fewer fields is one fewer shape that can drift out from under us.
 */
export interface ClientInputState {
  /** The composer's current draft, empty when nothing has been typed. */
  readonly draft: string
}

/**
 * Read face over the published input state.
 *
 * `getSnapshot` is the whole of it. The host-side injection path reads the draft
 * exactly once per batch, so subscribing would buy nothing and would leave a
 * listener alive behind a port whose lifetime the host controls.
 */
export interface ClientInputStateStore {
  /** @returns the current input state. */
  getSnapshot(): ClientInputState
}

/** The per-session input facade, as this plugin uses it. */
export interface ClientSessionInput {
  /** Replace the whole draft. Fills the composer; it does not post it. */
  setDraft(text: string): void
  /** Published input state for this session. */
  readonly state: ClientInputStateStore
}

/** Session-addressed access to the per-session input facade. */
export interface ClientInputResolver {
  /**
   * Resolve the facade for one session-scope context.
   * @param actx - a context tagged with the owning session.
   * @returns that session's input facade.
   */
  for(actx: object): ClientSessionInput
}

/** A client context tagged with one session identity. */
export interface ResolvedSessionScope {
  /** The session this scope belongs to. */
  readonly sessionId: string
  /** The tagged context the facade resolver expects. */
  readonly ctx: object
}

/**
 * The client-side sessions service, as this plugin uses it.
 *
 * `scope(id)` is deliberately the id-addressed read: an incoming batch names a
 * session, and the draft must land in *that* session even when the user is
 * looking at another one. Ids the client does not know resolve to `undefined`
 * and are treated as "not reachable yet" rather than as an error.
 */
export interface ClientSessionsFace {
  /**
   * @param id - the session identity.
   * @returns its scope, or undefined when this client does not know the session.
   */
  scope(id: string): ResolvedSessionScope | undefined
}

/** The client conversation service, resolved structurally by name at runtime. */
export interface ClientConversationFace {
  /** Session-addressed composer access. */
  readonly input: ClientInputResolver
}

/**
 * A client context, narrowed to the two reads this module performs.
 *
 * Written as its own interface rather than taking the framework's context type
 * so this module stays loadable (and testable) without a Cordis runtime. Both
 * members stay optional because a caller that has only the service lookups
 * (a unit test, a settings section) is still a legitimate caller for building
 * the port — only *installing* it needs a fiber.
 */
export interface ClientContextLike {
  /** Resolve an optional service by name. */
  get(name: string): unknown
  /** Run a callback whose returned disposer is tied to the caller's lifetime. */
  effect?(callback: () => () => void, label?: string): unknown
  /** Drop a registration made through {@link on} or {@link effect}. */
  off?(name: string, listener: (...args: never[]) => unknown): void
  /** Subscribe to a client event. */
  on?(name: string, listener: (...args: never[]) => unknown): () => void
}

/** Whether an unknown value carries the two reads {@link ClientConversationFace} promises. */
function isConversationFace(value: unknown): value is ClientConversationFace {
  if (typeof value !== 'object' || value === null) return false
  const input = (value as { input?: unknown }).input
  if (typeof input !== 'object' || input === null) return false
  return typeof (input as { for?: unknown }).for === 'function'
}

/** Whether an unknown value carries the one read {@link ClientSessionsFace} promises. */
function isSessionsFace(value: unknown): value is ClientSessionsFace {
  return typeof value === 'object' && value !== null
    && typeof (value as { scope?: unknown }).scope === 'function'
}

/**
 * The two lookups an implementation needs, captured once at install time.
 *
 * Capturing the faces rather than the context matters: a service is looked up
 * by name, and a context that is torn down and rebuilt must not leave this port
 * holding a stale service. The faces themselves are the stable things.
 *
 * @param ctx - any client context.
 * @returns the resolved faces, or undefined when the client half is not composed.
 */
function resolveFaces(ctx: ClientContextLike): {
  conversation: ClientConversationFace
  sessions: ClientSessionsFace
} | undefined {
  // The client conversation service is an OPTIONAL dependency: a deployment can
  // compose this plugin's client half without the conversation packages. The
  // lookup is by name and its result is validated, so "not composed" is an
  // ordinary outcome rather than an exception in the middle of a batch.
  const conversation = ctx.get('conversation')
  if (!isConversationFace(conversation)) return undefined
  const sessions = ctx.get('sessions')
  if (!isSessionsFace(sessions)) return undefined
  return { conversation, sessions }
}

/**
 * The port this plugin installs once its client half is live.
 *
 * Every method answers a *question* rather than taking an action that could be
 * mistaken for a send, and each one fails closed: an unresolvable session is
 * reported as unavailable, never as an empty draft, so the host can never be
 * told "the composer is empty" about a conversation this page cannot see.
 */
export interface ClientComposerPort {
  /** @param sessionId - the session the batch is addressed to. @returns whether its composer is reachable. */
  isAvailable(sessionId: string): boolean
  /** @param sessionId - the session to read. @returns the current draft, or undefined when unreachable. */
  readDraft(sessionId: string): string | undefined
  /** @param sessionId - the session whose composer to fill. @param text - the complete next draft. */
  setDraft(sessionId: string, text: string): void
}

/**
 * Build a port over the live client services.
 *
 * The returned object is a plain record whose only enumerable members are the
 * three verbs above — that is not incidental. The host half and the tests both
 * assert on that member list, so the port cannot quietly grow a fourth verb
 * (a send) without the assertion failing first.
 *
 * @param ctx - the client context.
 * @returns a port, or undefined when the client half of the conversation stack is absent.
 */
export function createClientComposerPort(ctx: ClientContextLike): ClientComposerPort | undefined {
  const faces = resolveFaces(ctx)
  if (faces === undefined) return undefined

  /**
   * The facade for one session, or undefined when it cannot be reached.
   *
   * Two failure modes are collapsed on purpose. An unknown session id and a
   * facade that throws while resolving are both "this page cannot write that
   * composer", and the host's correct response to either is the same: report
   * the batch as undelivered in the log rather than tell the extension its
   * annotations were lost and have it retry forever.
   */
  const facadeFor = (sessionId: string): ClientSessionInput | undefined => {
    try {
      const scope = faces.sessions.scope(sessionId)
      if (scope === undefined) return undefined
      return faces.conversation.input.for(scope.ctx)
    } catch {
      return undefined
    }
  }

  return {
    isAvailable(sessionId: string): boolean {
      return facadeFor(sessionId) !== undefined
    },

    readDraft(sessionId: string): string | undefined {
      const facade = facadeFor(sessionId)
      if (facade === undefined) return undefined
      try {
        return facade.state.getSnapshot().draft
      } catch {
        return undefined
      }
    },

    setDraft(sessionId: string, text: string): void {
      // A write that cannot find its composer is dropped rather than throwing.
      // By the time the host asks for this write it has already decided the
      // batch was delivered, so throwing here would turn a transport hiccup
      // into a bridge-level failure and put the extension back into its retry
      // loop with the same batch.
      facadeFor(sessionId)?.setDraft(text)
    },
  }
}

/**
 * Install the composer port for the lifetime of the plugin fiber.
 *
 * The port is installed through `ctx.effect`, so it is removed on unload and on
 * reload: a torn-down client half can never leave anything holding a port into
 * a dead page. When the context has no fiber (a unit test, or a caller holding
 * only the service lookups) the install still happens — the port holds nothing
 * that outlives the page — but there is no disposer to return.
 *
 * @param ctx - the client context.
 * @param install - receives the port; called at most once, synchronously.
 * @returns whether a port was installed (false when the conversation stack is absent).
 */
export function installClientComposerPort(
  ctx: ClientContextLike,
  install: (port: ClientComposerPort) => void,
): boolean {
  const port = createClientComposerPort(ctx)
  if (port === undefined) return false
  const effect = ctx.effect
  if (effect === undefined) {
    install(port)
    return true
  }
  effect.call(ctx, () => {
    install(port)
    return () => { /* the port holds no resource beyond its service lookups */ }
  }, 'dsh-annotate: composer port')
  return true
}
