/**
 * Panel rendering and interaction, driven through a real DOM.
 *
 * A DOM implementation is resolved at run time (see `helpers/jsdom.ts`); when
 * none is available these tests are skipped rather than failed, because the
 * panel's correctness does not depend on which DOM package a machine happens to
 * have. Nothing here loads a browser extension, launches a browser, or touches a
 * real page: the panel's own modules are ordinary ES modules and everything they
 * reach for is behind an interface the tests implement.
 */

import { strict as assert } from 'node:assert'
import { after, before, beforeEach, describe, it } from 'node:test'

import { createController, type PanelController, type PanelElements } from '../extension/src/panel/controller.ts'
import { createFactTable, createRow, type RowHandle } from '../extension/src/panel/row.ts'
import { AnnotationStore, MemoryStateStorage } from '../extension/src/panel/store.ts'
import { annotation, facts, FakePageSource } from './helpers/fixtures.ts'
import { installDomGlobals, loadJsdom, type Jsdom } from './helpers/jsdom.ts'

/** The panel's markup, mirroring the shipped document. */
const PANEL_MARKUP = `
<main id="panel" class="panel" data-state="idle">
  <header class="head"><h1 class="title">Annotate</h1><p id="count-line" class="count"></p></header>
  <p id="page-line" class="page-line" hidden></p>
  <section id="picking-banner" class="banner" hidden><span class="banner-dot"></span><span id="picking-hint"></span></section>
  <div class="primary-row">
    <button id="primary-action" type="button" aria-pressed="false">Start annotating</button>
  </div>
  <section id="composer" class="composer" hidden>
    <p id="composer-target" class="composer-target"></p>
    <textarea id="composer-input"></textarea>
    <div class="composer-actions">
      <button id="save-comment" type="button">Save comment</button>
      <button id="send-without-comment" type="button">Send without comment</button>
    </div>
  </section>
  <section class="list-section">
    <p id="empty-state" class="empty">No elements yet.</p>
    <ul id="annotation-list" class="list"></ul>
  </section>
  <footer class="foot">
    <div class="foot-actions">
      <button id="submit-batch" type="button" disabled>Send batch to DSH</button>
      <button id="clear-batch" type="button" disabled>Clear all</button>
    </div>
    <p id="status-line" class="status"></p>
    <button id="retry-submit" type="button" hidden>Retry sending</button>
  </footer>
</main>
`

const dom: Jsdom | null = await loadJsdom()

/** The DOM, asserted present inside a test body. */
function windowOf(): Window & typeof globalThis {
  assert.notEqual(dom, null, 'no DOM implementation available')
  return (dom as Jsdom).window
}

/** The document, asserted present. */
function doc(): Document {
  return windowOf().document
}

if (dom !== null) {
  installDomGlobals(dom)
  dom.window.document.body.innerHTML = PANEL_MARKUP
}

/** Look up a shell element, failing loudly when the markup drifts. */
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = doc().getElementById(id)
  assert.notEqual(found, null, `missing #${id}`)
  return found as T
}

/** Collect the shell the controller expects. */
function shell(): PanelElements {
  return {
    root: el('panel'),
    banner: el('picking-banner'),
    bannerText: el('picking-hint'),
    pageLine: el('page-line'),
    primaryButton: el<HTMLButtonElement>('primary-action'),
    composer: el('composer'),
    composerTarget: el('composer-target'),
    composerInput: el<HTMLTextAreaElement>('composer-input'),
    sendWithoutComment: el<HTMLButtonElement>('send-without-comment'),
    saveComment: el<HTMLButtonElement>('save-comment'),
    list: el('annotation-list'),
    emptyState: el('empty-state'),
    countLine: el('count-line'),
    submitButton: el<HTMLButtonElement>('submit-batch'),
    clearButton: el('clear-batch'),
    statusLine: el('status-line'),
    retryButton: el('retry-submit'),
  }
}

/** A store with a fixed clock. */
function newStore(): AnnotationStore {
  let tick = 1_700_000_000_000
  return new AnnotationStore(3, new MemoryStateStorage(), () => { tick += 1000; return tick })
}

/** An array-like of nodes, as a plain array. */
function toArray(nodes: ArrayLike<HTMLElement>): HTMLElement[] {
  return Array.from(nodes)
}

/**
 * A required descendant.
 *
 * The tests assert against markup this file builds, so a missing node is a bug
 * in the test rather than a case to handle — failing here names it, instead of
 * turning every later assertion into a null check.
 */
function need<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector(selector)
  assert.notEqual(found, null, `missing ${selector}`)
  return found as T
}

/** Click an element the way a user would. */
function click(element: HTMLElement): void {
  const win = windowOf()
  element.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
}

/** Type a key into a field. */
function press(element: HTMLElement, key: string, shift = false): void {
  const win = windowOf()
  element.dispatchEvent(new win.KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true }))
}

/** Hover a row, which is what asks the page to mark the element. */
function hover(element: HTMLElement): void {
  const win = windowOf()
  element.dispatchEvent(new win.MouseEvent('mouseenter', { bubbles: false }))
}

/** Let the microtask queue drain, which is when the panel redraws. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/** Rows currently in the list. */
function rows(): HTMLElement[] {
  return toArray(el('annotation-list').querySelectorAll('.row'))
}

/** The first row's header button, which is what expands a row. */
function firstHead(): HTMLElement {
  const head = rows()[0]?.querySelector('.row-head')
  assert.notEqual(head, undefined, 'no row head to click')
  return head as HTMLElement
}

/** Start a controller over a fresh shell. */
function booted(page = new FakePageSource(), store = newStore()): {
  controller: PanelController
  elements: PanelElements
  page: FakePageSource
  store: AnnotationStore
} {
  const elements = shell()
  const controller = createController({ elements, store, page })
  controller.start()
  return { controller, elements, page, store }
}

describe('panel shell rendering', { skip: dom === null }, () => {
  beforeEach(() => { doc().body.innerHTML = PANEL_MARKUP })

  it('starts in the empty state with both batch actions disabled', async () => {
    const { elements } = booted()
    await settle()
    assert.equal(elements.root.dataset['state'], 'idle')
    assert.equal(elements.emptyState.hidden, false)
    assert.equal(elements.composer.hidden, true)
    assert.equal(elements.banner.hidden, true)
    assert.equal(elements.submitButton.disabled, true)
    assert.equal(elements.clearButton.disabled, true)
  })

  it('names the page once the content script answers', async () => {
    const { elements } = booted()
    await settle()
    assert.equal(elements.pageLine.hidden, false)
    assert.match(elements.pageLine.textContent ?? '', /example\.test/)
    assert.match(elements.pageLine.textContent ?? '', /Settings/)
  })

  it('says the page is unreachable when nothing answers', async () => {
    const page = new FakePageSource()
    page.description = null
    const { elements } = booted(page)
    await settle()
    assert.equal(elements.root.dataset['state'], 'unavailable')
    assert.match(elements.statusLine.textContent ?? '', /reload the page/i)
    assert.equal(elements.primaryButton.disabled, true)
  })

  it('refuses a page address the extension may not annotate', async () => {
    const page = new FakePageSource()
    page.description = { url: 'chrome://settings', title: 'Settings', frameKind: 'top' }
    const { elements } = booted(page)
    await settle()
    assert.equal(elements.root.dataset['state'], 'unavailable')
    assert.match(elements.statusLine.textContent ?? '', /http, https or local file/i)
  })
})

describe('picking mode', { skip: dom === null }, () => {
  beforeEach(() => { doc().body.innerHTML = PANEL_MARKUP })

  it('asks the page to start and shows the instruction', async () => {
    const { elements, page } = booted()
    await settle()
    click(elements.primaryButton)
    await settle()
    assert.ok(page.calls.includes('startPicking'))
    assert.equal(elements.banner.hidden, false)
    assert.match(elements.bannerText.textContent ?? '', /Esc/)
    assert.equal(elements.primaryButton.getAttribute('aria-pressed'), 'true')
  })

  it('stops picking when the same button is pressed again', async () => {
    const { elements, page } = booted()
    await settle()
    click(elements.primaryButton)
    await settle()
    click(elements.primaryButton)
    await settle()
    assert.ok(page.calls.includes('stopPicking'))
    assert.equal(elements.banner.hidden, true)
  })

  it('reports the page as unreachable when picking cannot be armed', async () => {
    const page = new FakePageSource()
    page.startResult = false
    const { elements } = booted(page)
    await settle()
    click(elements.primaryButton)
    await settle()
    assert.equal(elements.root.dataset['state'], 'unavailable')
  })
})

describe('committing an annotation', { skip: dom === null }, () => {
  beforeEach(() => { doc().body.innerHTML = PANEL_MARKUP })

  it('shows the pending pick and saves a comment on Enter', async () => {
    const { elements, controller } = booted()
    await settle()
    controller.acceptPick('el-1', facts({ tag: 'button', selector: 'button.primary' }))
    await settle()
    assert.equal(elements.composer.hidden, false)
    assert.match(elements.composerTarget.textContent ?? '', /button\.primary/)

    elements.composerInput.value = 'make this disabled'
    press(elements.composerInput, 'Enter')
    await settle()
    assert.equal(elements.composer.hidden, true)
    assert.equal(rows().length, 1)
    assert.equal(elements.emptyState.hidden, true)
    assert.equal(elements.submitButton.disabled, false)
  })

  it('keeps a newline on Shift+Enter instead of committing', async () => {
    const { elements, controller } = booted()
    await settle()
    controller.acceptPick('el-1', facts())
    await settle()
    elements.composerInput.value = 'first line'
    press(elements.composerInput, 'Enter', true)
    await settle()
    assert.equal(rows().length, 0)
    assert.equal(elements.composer.hidden, false)
  })

  it('sends the element alone when the user asks for that', async () => {
    const { elements, controller, store } = booted()
    await settle()
    controller.acceptPick('el-1', facts())
    await settle()
    click(elements.sendWithoutComment)
    await settle()
    assert.equal(rows().length, 1)
    assert.equal(elements.composer.hidden, true)
    assert.equal(Object.hasOwn(store.getAnnotations()[0] ?? {}, 'comment'), false)
  })

  it('comes back out of picking mode once an annotation is committed', async () => {
    const { elements, page, controller } = booted()
    await settle()
    click(elements.primaryButton)
    await settle()
    controller.acceptPick('el-1', facts())
    await settle()
    click(elements.sendWithoutComment)
    await settle()
    assert.equal(elements.banner.hidden, true)
    assert.ok(page.calls.includes('stopPicking'))
  })
})

describe('the annotation list', { skip: dom === null }, () => {
  beforeEach(() => { doc().body.innerHTML = PANEL_MARKUP })

  it('renders one row per annotation, with a summary', async () => {
    const { elements, controller } = booted()
    await settle()
    for (const [index, tag] of ['button', 'a', 'div'].entries()) {
      controller.acceptPick(`el-${index}`, facts({ tag, selector: `${tag}.x`, text: `text ${index}` }))
      await settle()
      click(elements.sendWithoutComment)
      await settle()
    }
    const list = rows()
    assert.equal(list.length, 3)
    assert.deepEqual(list.map((row) => row.querySelector('.row-tag')?.textContent), ['button', 'a', 'div'])
    assert.equal(elements.countLine.textContent, '3 annotations')
  })

  it('asks the page to mark the element when a row is hovered', async () => {
    const { elements, controller, page } = booted()
    await settle()
    controller.acceptPick('el-7', facts({ tag: 'img', selector: 'img.hero' }))
    await settle()
    click(elements.sendWithoutComment)
    await settle()

    const row = rows()[0]
    assert.notEqual(row, undefined)
    hover(row as HTMLElement)
    await settle()
    // The registry id is the only handle the page understands; the panel never
    // sends a selector back over the channel.
    assert.deepEqual(page.flashed, ['el-7'])
  })

  it('opens a fact table on click and asks the page whether the element is alive', async () => {
    const { elements, controller, page } = booted()
    page.alive = new Set(['el-9'])
    await settle()
    controller.acceptPick('el-9', facts({ tag: 'input', selector: '#email', role: 'textbox', name: 'Email' }))
    await settle()
    click(elements.sendWithoutComment)
    await settle()

    const head = rows()[0]?.querySelector('.row-head')
    assert.notEqual(head, undefined)
    click(head as HTMLElement)
    await settle()

    const table = elements.list.querySelector('.facts')
    assert.notEqual(table, null)
    const labels = toArray(table?.querySelectorAll('dt') as ArrayLike<HTMLElement>).map((node) => node.textContent)
    assert.ok(labels.includes('selector'))
    assert.ok(labels.includes('role'))
    assert.deepEqual(page.probed, [['el-9']])
    assert.match(table?.textContent ?? '', /still on the page/)
    assert.match(table?.textContent ?? '', /yes/)
  })

  it('says so when the element is gone from the page', async () => {
    const { elements, controller } = booted()
    await settle()
    controller.acceptPick('el-gone', facts())
    await settle()
    click(elements.sendWithoutComment)
    await settle()
    click(rows()[0]?.querySelector('.row-head') as HTMLElement)
    await settle()
    assert.match(elements.list.querySelector('.facts')?.textContent ?? '', /no — the element was removed/)
  })

  it('edits a comment and keeps the row in place', async () => {
    const { elements, controller, store } = booted()
    await settle()
    controller.acceptPick('el-1', facts())
    await settle()
    click(elements.sendWithoutComment)
    await settle()
    click(rows()[0]?.querySelector('.row-head') as HTMLElement)
    await settle()

    const field = need<HTMLTextAreaElement>(elements.list, '.row-comment')
    field.value = 'edited later'
    field.dispatchEvent(new (windowOf().Event)('change', { bubbles: true }))
    await settle()
    assert.equal(store.getAnnotations()[0]?.comment, 'edited later')
    assert.equal(rows().length, 1)
  })

  it('deletes one row without touching the others', async () => {
    const { elements, controller, store } = booted()
    await settle()
    controller.acceptPick('el-1', facts({ tag: 'button' }))
    await settle()
    click(elements.sendWithoutComment)
    await settle()
    controller.acceptPick('el-2', facts({ tag: 'a' }))
    await settle()
    click(elements.sendWithoutComment)
    await settle()

    click(rows()[0]?.querySelector('.row-head') as HTMLElement)
    await settle()
    click(elements.list.querySelector('.row-actions .button') as HTMLElement)
    await settle()
    assert.equal(store.getAnnotations().length, 1)
    assert.equal(rows().length, 1)
  })

  it('clears the whole batch', async () => {
    const { elements, controller } = booted()
    await settle()
    controller.acceptPick('el-1', facts())
    await settle()
    click(elements.sendWithoutComment)
    await settle()
    click(elements.clearButton)
    await settle()
    assert.equal(rows().length, 0)
    assert.equal(elements.emptyState.hidden, false)
    assert.equal(elements.clearButton.disabled, true)
  })
})

describe('submitting', { skip: dom === null }, () => {
  beforeEach(() => { doc().body.innerHTML = PANEL_MARKUP })

  it('sends the batch through the page channel and reports success', async () => {
    const { elements, controller, page } = booted()
    await settle()
    controller.acceptPick('el-1', facts())
    await settle()
    elements.composerInput.value = 'fix this'
    click(elements.saveComment)
    await settle()
    click(elements.submitButton)
    await settle()
    assert.ok(page.calls.includes('submit'))
    assert.match(elements.statusLine.textContent ?? '', /Sent to DeepSeek Harness/)
    assert.equal(elements.retryButton.hidden, true)
  })

  it('offers a retry when the bridge was offline', async () => {
    const page = new FakePageSource()
    page.submitResult = { ok: false, kind: 'rejected', reason: 'offline', detail: 'connection refused' }
    const { elements, controller } = booted(page)
    await settle()
    controller.acceptPick('el-1', facts())
    await settle()
    click(elements.sendWithoutComment)
    await settle()
    click(elements.submitButton)
    await settle()
    assert.match(elements.statusLine.textContent ?? '', /not reachable/i)
    assert.equal(elements.retryButton.hidden, false)
    assert.equal(elements.statusLine.classList.contains('is-error'), true)
  })

  it('does not offer a retry for a payload the bridge refused', async () => {
    const page = new FakePageSource()
    page.submitResult = { ok: false, kind: 'rejected', reason: 'invalid', detail: 'bad batch' }
    const { elements, controller } = booted(page)
    await settle()
    controller.acceptPick('el-1', facts())
    await settle()
    click(elements.sendWithoutComment)
    await settle()
    click(elements.submitButton)
    await settle()
    assert.equal(elements.retryButton.hidden, true)
  })
})

describe('page changes', { skip: dom === null }, () => {
  beforeEach(() => { doc().body.innerHTML = PANEL_MARKUP })

  it('marks the list as stale and drops the pending pick on a navigation', async () => {
    const { elements, controller, store } = booted()
    await settle()
    controller.acceptPick('el-1', facts())
    await settle()
    click(elements.sendWithoutComment)
    await settle()
    controller.acceptPick('el-2', facts())
    await settle()

    store.setStale(true)
    store.clearPicked()
    await settle()
    assert.equal(elements.pageLine.classList.contains('is-stale'), true)
    assert.equal(elements.composer.hidden, true)
    // The rows are the user's own work and survive the page they described.
    assert.equal(rows().length, 1)
  })
})

describe('createRow', { skip: dom === null }, () => {
  beforeEach(() => { doc().body.innerHTML = PANEL_MARKUP })

  /** A row with recording handlers, attached to the document. */
  function rowWith(): { handle: RowHandle; events: string[] } {
    const events: string[] = []
    const handle = createRow(annotation({ id: 'row-1', comment: 'hello' }), {
      onHover: (_id, entered) => { events.push(entered ? 'hover' : 'unhover') },
      onToggle: (_id, expanded) => { events.push(expanded ? 'open' : 'close') },
      onCommentChange: (_id, comment) => { events.push(`comment:${comment}`) },
      onRemove: () => { events.push('remove') },
    })
    doc().body.append(handle.element as unknown as HTMLElement)
    return { handle, events }
  }

  it('starts collapsed with the stored comment in the field', () => {
    const { handle } = rowWith()
    assert.equal(handle.isExpanded(), false)
    const field = need<HTMLTextAreaElement>(handle.element, '.row-comment')
    assert.equal(field.value, 'hello')
    assert.equal((handle.element.querySelector('.row-detail') as unknown as HTMLElement).hidden, true)
  })

  it('reports the toggle to its owner', () => {
    const { handle, events } = rowWith()
    const head = handle.element.querySelector('.row-head') as unknown as HTMLElement
    click(head)
    assert.deepEqual(events, ['open'])
    assert.equal(handle.isExpanded(), true)
    assert.equal(head.getAttribute('aria-expanded'), 'true')
  })

  it('updates in place rather than rebuilding, so focus survives', () => {
    const { handle } = rowWith()
    const field = need<HTMLTextAreaElement>(handle.element, '.row-comment')
    field.focus()
    handle.update(annotation({ id: 'row-1', comment: 'changed', facts: facts({ tag: 'a' }) }), null)
    assert.equal(doc().body.querySelectorAll('.row').length, 1)
    assert.equal(field.value, 'changed')
    assert.equal(handle.element.querySelector('.row-tag')?.textContent, 'a')
    assert.equal(doc().activeElement, field)
  })

  it('adopts an external comment rather than fighting the user', () => {
    const { handle } = rowWith()
    const field = need<HTMLTextAreaElement>(handle.element, '.row-comment')
    // The store is authoritative; a field showing something else is corrected.
    field.value = 'typed but not saved'
    handle.update(annotation({ id: 'row-1', comment: 'hello' }), null)
    assert.equal(field.value, 'hello')
  })

  it('renders page-authored text as text, never as markup', () => {
    const { handle } = rowWith()
    handle.update(annotation({ facts: facts({ text: '<img src=x onerror=alert(1)>', tag: 'div' }) }), null)
    const excerpt = handle.element.querySelector('.row-excerpt')
    assert.equal(excerpt?.querySelector('img'), null)
    assert.match(excerpt?.textContent ?? '', /<img src=x onerror=alert\(1\)>/)
  })

  it('builds a fact table with only the fields the element has', () => {
    const table = createFactTable(facts({ tag: 'input', role: 'textbox' }), null)
    const labels = toArray(table.querySelectorAll('dt') as unknown as ArrayLike<HTMLElement>).map((node) => node.textContent)
    assert.ok(labels.includes('selector'))
    assert.ok(labels.includes('role'))
    assert.equal(labels.includes('value'), false)
    assert.equal(labels.includes('still on the page'), false)
  })
})
