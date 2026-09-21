/**
 * The browser APIs this panel uses, narrowed to the parts it actually calls.
 *
 * `@types/chrome` is not a dependency of this project — it is a large definition
 * set that exists to serve extensions that use hundreds of APIs — and the
 * ambient `chrome` binding that TypeScript does have comes from the DOM library,
 * where it is only partially declared and, on some compiler versions, declares
 * `chrome.runtime.onMessage` as a bare function rather than an event with
 * `addListener`.
 *
 * Rather than cast the global away at each use site, the surface is declared
 * once here and read through a single accessor. That keeps the awkward part in
 * one file, and it means every call site is checked against a shape this project
 * owns rather than against whatever the ambient types happen to say today.
 *
 * @module
 */

/** One `chrome.runtime.onMessage` listener. */
export type RuntimeMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined

/** The extension runtime surface the panel uses. */
export interface RuntimeApi {
  id?: string
  onMessage: {
    addListener(listener: RuntimeMessageListener): void
    removeListener(listener: RuntimeMessageListener): void
  }
  sendMessage(message: unknown): Promise<unknown>
}

/** The tab surface the panel uses. */
export interface TabsApi {
  query(query: { active: boolean; windowId?: number }): Promise<Array<{ id?: number; url?: string }>>
}

/** The window surface the panel uses. */
export interface WindowsApi {
  getCurrent(): Promise<{ id?: number }>
}

/** The session-storage surface the store uses. */
export interface SessionStorageApi {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(key: string): Promise<void>
}

/** Everything the panel reads off the extension's own globals. */
export interface ExtensionApi {
  runtime: RuntimeApi
  tabs: TabsApi
  windows: WindowsApi
  storage: { session: SessionStorageApi }
}

/** Whether a value behaves like the runtime surface. */
function isRuntimeApi(value: unknown): value is RuntimeApi {
  if (typeof value !== 'object' || value === null) return false
  const runtime = value as { onMessage?: unknown; sendMessage?: unknown }
  const onMessage = runtime.onMessage
  if (typeof onMessage !== 'object' || onMessage === null) return false
  const event = onMessage as { addListener?: unknown; removeListener?: unknown }
  return typeof event.addListener === 'function' && typeof event.removeListener === 'function'
    && typeof runtime.sendMessage === 'function'
}

/**
 * The extension APIs, or `null` outside an extension document.
 *
 * Returning `null` rather than throwing is what lets the panel modules run in a
 * plain document, which is how their rendering is tested and how a developer can
 * open the markup directly to work on the stylesheet.
 *
 * @returns the API surface when it is present and complete enough to use.
 */
export function extensionApi(): ExtensionApi | null {
  const global = globalThis as { chrome?: unknown }
  const chrome = global.chrome
  if (typeof chrome !== 'object' || chrome === null) return null
  const candidate = chrome as Partial<ExtensionApi>
  if (!isRuntimeApi(candidate.runtime)) return null
  if (typeof candidate.tabs?.query !== 'function') return null
  if (typeof candidate.windows?.getCurrent !== 'function') return null
  if (typeof candidate.storage?.session?.get !== 'function') return null
  if (typeof candidate.storage.session.set !== 'function') return null
  if (typeof candidate.storage.session.remove !== 'function') return null
  return candidate as ExtensionApi
}
