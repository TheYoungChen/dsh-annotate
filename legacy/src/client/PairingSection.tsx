/**
 * The pairing section: what the user opens to connect the browser extension.
 *
 * It answers four questions in reading order, and nothing else — where the
 * extension connects, whether it currently is, what token to paste, and what
 * to do next. A settings column is a place people visit once and then leave,
 * so the section stays a short document rather than a dashboard.
 *
 * The token is the reason this component has state at all. It is fetched only
 * from the reveal control, held in component state (never a store, so it
 * cannot outlive the panel), and dropped as soon as the user hides it again.
 *
 * @module
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComposedProps, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import { PairingRequestError, fetchPairingStatus, fetchPairingToken } from './pairing-api.ts'
import type { AnnotateKey } from './locales.ts'
import type { PairingStatus } from './pairing-contract.ts'
import css from './PairingSection.module.css'

/** Registration-derived props this section consumes. */
export type PairingSectionProps = ComposedProps<
  'settings.section',
  string,
  never,
  undefined,
  object,
  never,
  'annotate'
>

/** How often the connection state is re-read while the panel is open. */
const POLL_INTERVAL_MS = 3_000

/** Look up a class name, tolerating a key the bundler did not emit. */
function cls(...names: readonly (string | undefined)[]): string {
  return names.filter((name): name is string => typeof name === 'string' && name !== '').join(' ')
}

/** Format one epoch-millisecond instant for display, or an empty string. */
function formatInstant(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return ''
  return new Date(value).toLocaleString()
}

/** Which of the three connection states the dot reflects. */
type ConnectionState = 'connected' | 'disconnected' | 'down'

/** Reduce the status object to the state the dot and label render. */
function connectionState(status: PairingStatus | null): ConnectionState {
  if (status === null || !status.listening) return 'down'
  return status.connected ? 'connected' : 'disconnected'
}

/**
 * The pairing section body.
 *
 * @param props - the composed slot props; only the localized `t` seat is read.
 * @returns the rendered section.
 */
export function PairingSection({ t }: PairingSectionProps): React.ReactNode {
  const [status, setStatus] = useState<PairingStatus | null>(null)
  const [statusError, setStatusError] = useState<'network' | 'forbidden' | 'unavailable' | 'malformed' | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [tokenError, setTokenError] = useState<'network' | 'forbidden' | 'unavailable' | 'malformed' | null>(null)
  const [copied, setCopied] = useState(false)
  const [revealing, setRevealing] = useState(false)

  // One controller for the status poll, aborted on unmount so a late response
  // cannot set state on a component the settings panel already tore down.
  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    const read = async (): Promise<void> => {
      try {
        const next = await fetchPairingStatus(controller.signal)
        if (cancelled) return
        setStatus(next)
        setStatusError(null)
      } catch (error: unknown) {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return
        setStatusError(error instanceof PairingRequestError ? error.code : 'network')
      }
    }

    void read()
    const timer = setInterval(() => { void read() }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
      controller.abort()
    }
  }, [])

  // A copy confirmation is a transient gesture acknowledgement, not a durable
  // fact: it clears itself so the label never claims a stale "Copied".
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => { setCopied(false) }, 2_000)
    return () => { clearTimeout(timer) }
  }, [copied])

  /** Whether the token is currently readable by the user. */
  const revealed = token !== null

  const toggleReveal = useCallback((): void => {
    if (revealed) {
      // Dropping the value on hide is the point of the mask: a token left in
      // state is a token left in a heap snapshot and in the React devtools.
      setToken(null)
      setTokenError(null)
      setCopied(false)
      return
    }
    setRevealing(true)
    void fetchPairingToken()
      .then((response) => { setToken(response.token); setTokenError(null) })
      .catch((error: unknown) => {
        setTokenError(error instanceof PairingRequestError ? error.code : 'network')
      })
      .finally(() => { setRevealing(false) })
  }, [revealed])

  const copy = useCallback((): void => {
    if (token === null) return
    void navigator.clipboard.writeText(token)
      .then(() => { setCopied(true) })
      // Clipboard access can be refused (an insecure context, a denied
      // permission); the field stays selectable so the user can copy by hand.
      .catch(() => { setCopied(false) })
  }, [token])

  const state = connectionState(status)
  const stateLabel = state === 'connected'
    ? t('status.connected')
    : state === 'disconnected' ? t('status.disconnected') : t('status.notListening')

  /** The revealed token, or the host's mask while hidden. */
  const displayToken = token
    ?? (status?.tokenMasked ?? (status?.tokenGenerated === false ? null : ''))

  const errorKey = (code: 'network' | 'forbidden' | 'unavailable' | 'malformed'): AnnotateKey =>
    `error.${code}` as AnnotateKey

  return (
    <div className={cls(css['section'])}>
      <p className={cls(css['intro'])}>{t('intro')}</p>

      <section className={cls(css['block'])}>
        <h3 className={cls(css['heading'])}>{t('status.heading')}</h3>
        <div className={cls(css['statusRow'])}>
          <span className={cls(css['dot'])} data-state={state} aria-hidden="true" />
          <span>{stateLabel}</span>
        </div>
        {status !== null && status.connected && status.connectedAt !== null && (
          <span className={cls(css['meta'])}>{t('status.connectedSince', { time: formatInstant(status.connectedAt) })}</span>
        )}
        {status !== null && status.connected && (
          <span className={cls(css['meta'])}>
            {t('status.extensionId')}: {status.extensionId ?? t('status.unknown')}
            {' · '}
            {t('status.protocol')}: v{status.protocolVersion ?? t('status.unknown')}
          </span>
        )}
        {statusError !== null && (
          <span className={cls(css['error'])} role="status">{t(errorKey(statusError))}</span>
        )}
      </section>

      <section className={cls(css['block'])}>
        <h3 className={cls(css['heading'])}>{t('pairing.heading')}</h3>
        <p className={cls(css['explainer'])}>{t('pairing.explainer')}</p>
        {displayToken === null ? (
          <span className={cls(css['meta'])}>{t('pairing.unavailable')}</span>
        ) : (
          <>
            <div className={cls(css['tokenRow'])}>
              {/* Rendered as a read-only input so the browser's own selection
               * and copy affordances work, including on the masked form. */}
              <input
                className={cls(css['token'])}
                data-revealed={revealed}
                type="text"
                readOnly
                value={displayToken}
                aria-label={t('pairing.heading')}
                onFocus={(event) => { event.currentTarget.select() }}
              />
              <button
                type="button"
                className={cls(css['button'])}
                onClick={toggleReveal}
                disabled={revealing || status?.tokenGenerated === false}
              >
                {revealed ? t('pairing.hide') : t('pairing.reveal')}
              </button>
              <button
                type="button"
                className={cls(css['button'])}
                onClick={copy}
                disabled={!revealed}
              >
                {copied ? t('pairing.copied') : t('pairing.copy')}
              </button>
            </div>
            {revealed && (
              <span className={cls(css['meta'])}>
                {t('pairing.issuedAt', { time: formatInstant(status?.tokenIssuedAt ?? null) })}
              </span>
            )}
            {tokenError !== null && (
              <span className={cls(css['error'])} role="status">
                {t(errorKey(tokenError))}
                {' '}
                <button type="button" className={cls(css['button'])} onClick={toggleReveal}>
                  {t('retry')}
                </button>
              </span>
            )}
          </>
        )}
      </section>

      <section className={cls(css['block'])}>
        <h3 className={cls(css['heading'])}>{t('bridge.heading')}</h3>
        <p className={cls(css['explainer'])}>{t('bridge.explainer')}</p>
        <span className={cls(css['address'])}>
          {status === null
            ? t('status.unknown')
            : t('bridge.address', { address: status.address, port: String(status.port) })}
        </span>
      </section>

      <section className={cls(css['block'])}>
        <h3 className={cls(css['heading'])}>{t('setup.heading')}</h3>
        <ol className={cls(css['steps'])}>
          <li>{t('setup.step1')}</li>
          <li>{t('setup.step2')}</li>
          <li>{t('setup.step3')}</li>
        </ol>
      </section>
    </div>
  )
}

/**
 * Phantom reference that keeps the slot key's type in this module's graph.
 *
 * The component infers its props from {@link PairingSectionProps}; this alias
 * makes a rename of the slot key a compile error here rather than a silently
 * mismatched `ComposedProps` argument.
 */
export type PairingSectionSlot = SlotMap['settings.section']
