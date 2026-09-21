/**
 * A DOM for the panel's tests.
 *
 * The panel is an extension page, so its rendering needs a real document. Rather
 * than take a dependency on a DOM implementation — the project ships with zero
 * runtime dependencies and the test suite is no place to start — the
 * implementation is resolved at run time from wherever it can be found, and the
 * tests that need a document are skipped when it is nowhere.
 *
 * The search order is deliberate: a project-local install wins, so a contributor
 * who adds one gets exactly the version their lockfile pins; failing that, a DOM
 * is borrowed from a checkout further up the tree. `JSDOM_HOME` points at any
 * other. A machine with none of the three still type-checks, and still runs
 * every test that does not need a document.
 *
 * @module
 */

/**
 * A live DOM, typed against the standard library's own DOM types.
 *
 * The panel's modules are written against `lib.dom`, and a test that ran them
 * against a hand-written structural shim would stop noticing the moment the real
 * types moved. Borrowing the real ones keeps the tests honest about what the
 * panel actually receives.
 */
export interface Jsdom {
  window: Window & typeof globalThis
}

/**
 * Modules that may export a DOM constructor, in preference order.
 *
 * A bare specifier resolves against this package's own `node_modules`. The
 * relative entry below it is a sibling checkout that carries one, which is how a
 * contributor working inside a larger repository gets a document without adding
 * a dependency to this package.
 */
const CANDIDATE_MODULES: readonly string[] = [
  'jsdom',
  ...(process.env['JSDOM_HOME'] === undefined ? [] : [process.env['JSDOM_HOME']]),
  '../../../../../deepseek-harness/node_modules/jsdom/lib/api.js',
]

/**
 * Load a DOM implementation.
 *
 * @returns a DOM factory, or `null` when no implementation is installed.
 */
export async function loadJsdom(): Promise<Jsdom | null> {
  for (const specifier of CANDIDATE_MODULES) {
    try {
      const module: unknown = await import(specifier)
      const dom = createDom(module)
      if (dom !== null) return dom
    } catch {
      // Absence is the expected case for every candidate but one.
    }
  }
  return null
}

/**
 * The address the test document is served from.
 *
 * A DOM with no address reports `about:blank`, and the content script correctly
 * refuses to build a batch for a document the protocol cannot describe — so a
 * document at `about:blank` would fail those tests for the right reason and tell
 * us nothing about picking. An ordinary `https:` address is also the closer
 * stand-in for the page a real content script runs in.
 */
export const TEST_PAGE_URL = 'https://example.com/settings'

/**
 * Build a DOM from a loaded module namespace.
 *
 * A DOM package may export its constructor directly, under `JSDOM`, or as the
 * module's default; all three are accepted so the resolution above does not have
 * to know which packaging convention it landed on.
 *
 * @param module - the imported namespace.
 * @returns a live DOM, or `null` when the module carries no usable constructor.
 */
function createDom(module: unknown): Jsdom | null {
  const record = module as { JSDOM?: unknown; default?: unknown }
  for (const candidate of [record.JSDOM, record.default, module]) {
    if (typeof candidate !== 'function') continue
    try {
      const instance = new (candidate as new (html: string, options?: unknown) => Jsdom)(
        '<!doctype html><html><body></body></html>',
        { pretendToBeVisual: true, url: TEST_PAGE_URL },
      )
      if (instance.window !== undefined) return instance
    } catch {
      // Not a constructor that produces a DOM; keep looking.
    }
  }
  return null
}

/**
 * Install a DOM's globals for the modules under test.
 *
 * The panel reaches for `window`, `document` and the event constructors as
 * globals, exactly as it does in a browser. Assigning them is what makes the
 * rendering tests exercise the real implementation rather than a mock of it.
 *
 * @param dom - the DOM to install.
 */
export function installDomGlobals(dom: Jsdom): void {
  const global = globalThis as unknown as Record<string, unknown>
  global['window'] = dom.window
  global['document'] = dom.window.document
  global['Node'] = dom.window.Node
  global['Event'] = dom.window.Event
  global['MouseEvent'] = dom.window.MouseEvent
  global['KeyboardEvent'] = dom.window.KeyboardEvent
  global['HTMLElement'] = dom.window.HTMLElement
}
