/**
 * Store behaviour.
 *
 * The store holds every rule that decides what a batch contains, so these are
 * the tests that matter most: what an empty comment means, what a re-pick does
 * to a pending annotation, and what survives being restored into a new panel.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { AnnotationStore, MAX_ANNOTATIONS, MemoryStateStorage } from '../extension/src/panel/store.ts'
import { annotation, facts, pageContext } from './helpers/fixtures.ts'

/** A store with a fixed clock, so ids and timestamps are deterministic. */
function storeWith(storage = new MemoryStateStorage(), tabId = 7): AnnotationStore {
  let tick = 1_700_000_000_000
  return new AnnotationStore(tabId, storage, () => { tick += 1000; return tick })
}

describe('AnnotationStore', () => {
  it('starts empty and reports so', () => {
    const store = storeWith()
    const snapshot = store.snapshot()
    assert.deepEqual(snapshot.annotations, [])
    assert.equal(snapshot.currentElementId, null)
    assert.equal(snapshot.currentFacts, null)
    assert.equal(snapshot.picking, false)
    assert.equal(snapshot.stale, false)
  })

  it('records a pick without committing it', () => {
    const store = storeWith()
    store.setPicked({ id: 'el-1', facts: facts() })
    const snapshot = store.snapshot()
    assert.equal(snapshot.currentElementId, 'el-1')
    assert.equal(snapshot.annotations.length, 0)
  })

  it('omits the comment key when the annotation is sent without one', () => {
    // Downstream consumers branch on the presence of the key, so an empty
    // comment has to be absent rather than present and blank.
    const store = storeWith()
    store.setPicked({ id: 'el-1', facts: facts() })
    const stored = store.commit('   ')
    assert.notEqual(stored, null)
    assert.equal(Object.hasOwn(stored ?? {}, 'comment'), false)
    assert.equal(store.snapshot().annotations.length, 1)
  })

  it('keeps a trimmed comment and clears the pending pick', () => {
    const store = storeWith()
    store.setPicked({ id: 'el-1', facts: facts() })
    const stored = store.commit('  make this disabled  ')
    assert.equal(stored?.comment, 'make this disabled')
    const snapshot = store.snapshot()
    assert.equal(snapshot.currentElementId, null)
    assert.equal(snapshot.currentFacts, null)
  })

  it('refuses to commit without a pending pick', () => {
    const store = storeWith()
    assert.equal(store.commit('orphan'), null)
    assert.equal(store.snapshot().annotations.length, 0)
  })

  it('replaces the pending pick when the same element is picked again', () => {
    const store = storeWith()
    store.setPicked({ id: 'el-1', facts: facts({ tag: 'button' }) })
    store.setPicked({ id: 'el-1', facts: facts({ tag: 'a' }) })
    assert.equal(store.snapshot().annotations.length, 0)
    assert.equal(store.snapshot().currentFacts?.tag, 'a')
  })

  it('stops at the batch ceiling', () => {
    const store = storeWith()
    for (let index = 0; index < MAX_ANNOTATIONS; index += 1) {
      store.setPicked({ id: `el-${index}`, facts: facts() })
      assert.notEqual(store.commit(`#${index}`), null)
    }
    store.setPicked({ id: 'el-overflow', facts: facts() })
    assert.equal(store.commit('one too many'), null)
    assert.equal(store.snapshot().annotations.length, MAX_ANNOTATIONS)
  })

  it('removes one annotation and leaves the rest', () => {
    const store = storeWith()
    store.setPicked({ id: 'el-1', facts: facts() })
    const first = store.commit('one')
    store.setPicked({ id: 'el-2', facts: facts() })
    const second = store.commit('two')
    assert.notEqual(first, null)
    assert.notEqual(second, null)

    assert.equal(store.remove(first?.id ?? ''), true)
    assert.deepEqual(store.snapshot().annotations.map((item) => item.comment), ['two'])
    assert.equal(store.remove('not-a-real-id'), false)
  })

  it('edits a comment in place and can clear it again', () => {
    const store = storeWith()
    store.setPicked({ id: 'el-1', facts: facts() })
    const stored = store.commit('first draft')
    const id = stored?.id ?? ''

    assert.equal(store.setComment(id, 'second draft'), true)
    assert.equal(store.snapshot().annotations[0]?.comment, 'second draft')
    assert.equal(store.setComment(id, '   '), true)
    assert.equal(Object.hasOwn(store.snapshot().annotations[0] ?? {}, 'comment'), false)
    assert.equal(store.setComment('missing', 'x'), false)
  })

  it('clears the batch', () => {
    const store = storeWith()
    store.setPicked({ id: 'el-1', facts: facts() })
    store.commit('one')
    store.clear()
    assert.equal(store.snapshot().annotations.length, 0)
  })

  it('notifies subscribers and stops after unsubscribe', () => {
    const store = storeWith()
    let notifications = 0
    const unsubscribe = store.subscribe(() => { notifications += 1 })
    store.setPicked({ id: 'el-1', facts: facts() })
    assert.equal(notifications, 1)
    unsubscribe()
    store.clearPicked()
    assert.equal(notifications, 1)
  })

  it('marks the page stale on a navigation and clears it on a fresh description', () => {
    const store = storeWith()
    store.setPage(pageContext())
    assert.equal(store.snapshot().stale, false)
    store.setStale(true)
    assert.equal(store.snapshot().stale, true)
    store.setPage(pageContext('https://example.test/other'))
    assert.equal(store.snapshot().stale, false)
  })

  it('restores what a previous panel left behind', async () => {
    const storage = new MemoryStateStorage()
    const first = storeWith(storage)
    first.setPage(pageContext())
    first.setPicked({ id: 'el-1', facts: facts() })
    first.commit('carry me over')
    await first.persist()

    const second = storeWith(storage)
    await second.restore()
    const snapshot = second.snapshot()
    assert.equal(snapshot.annotations.length, 1)
    assert.equal(snapshot.annotations[0]?.comment, 'carry me over')
    assert.equal(snapshot.page?.url, 'https://example.test/settings')
    // The pending pick is deliberately not restored: its element id belonged to
    // the document that owned it, and that document is gone.
    assert.equal(snapshot.currentElementId, null)
  })

  it('drops stored rows that do not satisfy the facts contract', async () => {
    const storage = new MemoryStateStorage()
    // Deliberately malformed, and deliberately typed as `unknown`: the point of
    // the test is a storage record no current build could have written, which is
    // exactly what an upgrade or another context of the extension can produce.
    // A well-typed fixture could not express the case at all.
    const broken: unknown = {
      annotations: [
        annotation({ id: 'good' }),
        { id: 'no-facts', pickedAt: 1 },
        { id: 'bad-facts', pickedAt: 1, facts: { tag: 'div' } },
        { pickedAt: 1, facts: facts() },
      ],
      page: { url: 'not-a-page', kind: 'tel', viewport: { width: 1, height: 1 } },
    }
    await storage.writeRaw(7, broken)

    const store = storeWith(storage)
    await store.restore()
    const snapshot = store.snapshot()
    assert.deepEqual(snapshot.annotations.map((item) => item.id), ['good'])
    assert.equal(snapshot.page, null)
  })

  it('reports no stored state as an empty list rather than failing', async () => {
    const store = storeWith()
    await store.restore()
    assert.deepEqual(store.snapshot().annotations, [])
  })

  it('persists nothing when there is nothing to persist', async () => {
    const storage = new MemoryStateStorage()
    const store = storeWith(storage)
    await store.persist()
    assert.equal(await storage.read(7), null)
  })
})
