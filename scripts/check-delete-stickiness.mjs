/**
 * Deleting a mark must stay deleted.
 *
 * The reader's report: deleting an annotation from the card on the page did
 * nothing — the mark was still there afterwards. It was not a dead handler. The
 * page removed the mark and reported its new, empty list; the panel read that
 * empty report as a page that had lost its storage and handed the mark straight
 * back, so the page re-drew it.
 *
 * Only the LAST mark was affected, which is what made it look like an
 * intermittent dead button rather than a rule: deleting any earlier mark leaves
 * a non-empty list, and a non-empty list is adopted as-is.
 *
 * The decision is `batchFromPage`, which is pure, so it is asserted directly
 * rather than inferred from a rerender — the browser check cannot reach it,
 * because reaching it needs a real preview origin and a framed page.
 */
import { readFileSync } from 'node:fs'

const CLIENT = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** Walk braces rather than slice to a remembered end marker. */
function extractFunction(source, marker) {
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`declaration not found: ${marker}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after: ${marker}`)
}

// The shipped implementations, not copies: `usable` is lifted with it because the
// decision is defined in terms of it.
const usableSrc = extractFunction(CLIENT, 'function usable(list)')
const batchSrc = extractFunction(CLIENT, 'function batchFromPage(args)')
const batchFromPage = new Function(`${usableSrc}\n${batchSrc}\nreturn batchFromPage`)()

const HELD = [
  { id: 'a1', note: '第一个测试', selector: '.first' },
  { id: 'a2', note: '第二个测试', selector: '.second' },
]

console.log('=== the page reports an empty list after the last mark is deleted ===')
// This is the reported bug, stated as the decision it really is. The page is
// alive and answering an action; handing its marks back undoes that action.
{
  const outcome = batchFromPage({ type: 'changed', incoming: [], held: HELD })
  check(outcome.adopt.length === 0,
    'the empty list is believed, so the deleted mark stays deleted',
    `adopted ${outcome.adopt.length}`)
  check(outcome.restore === null,
    'and nothing is handed back to the page, which would re-draw it',
    JSON.stringify(outcome.restore && outcome.restore.length))
}

console.log('')
console.log('=== deleting one of several marks ===')
{
  const one = [HELD[1]]
  const outcome = batchFromPage({ type: 'changed', incoming: one, held: HELD })
  check(outcome.adopt.length === 1 && outcome.adopt[0].selector === '.second',
    'the surviving mark is what is listed',
    JSON.stringify(outcome.adopt.map((e) => e.selector)))
  check(outcome.restore === null, 'and nothing is handed back, so the deletion is not undone')
}

console.log('')
console.log('=== a page that comes up empty on boot is still filled in ===')
// The other half of the rule, and the reason the branch exists at all: a preview
// origin rebuilt under the reader loses localStorage, and its honest "I have
// nothing" must not wipe an attachment the composer is still counting.
{
  const outcome = batchFromPage({ type: 'ready', incoming: [], held: HELD })
  check(outcome.adopt.length === 2,
    'the host\'s marks are adopted rather than the panel going empty',
    `adopted ${outcome.adopt.length}`)
  check(outcome.restore !== null && outcome.restore.length === HELD.length && outcome.adopted === true,
    'and they are handed back to the page, flagged as having no page id yet',
    JSON.stringify({ restore: outcome.restore && outcome.restore.length, adopted: outcome.adopted }))
}

console.log('')
console.log('=== a page with marks of its own is authoritative ===')
// A page that reports marks is never overwritten by the mirror, even on boot:
// the page is the durable side, and the host's copy is only a stand-in for its
// silence.
{
  const own = [{ id: 'p1', note: 'from the page', selector: '.own' }]
  const outcome = batchFromPage({ type: 'ready', incoming: own, held: HELD })
  check(outcome.adopt.length === 1 && outcome.adopt[0].id === 'p1',
    'the page\'s own list wins',
    JSON.stringify(outcome.adopt.map((e) => e.id)))
  check(outcome.restore === null, 'and nothing is pushed back at it')
}

console.log('')
console.log('=== a genuinely empty panel stays empty ===')
{
  const outcome = batchFromPage({ type: 'ready', incoming: [], held: [] })
  check(outcome.adopt.length === 0 && outcome.restore === null,
    'with nothing held there is nothing to restore',
    JSON.stringify(outcome))
}

console.log('')
console.log('=== malformed entries do not count as marks ===')
// `usable` is the guard that keeps a `null` from reaching render and blanking the
// sidebar. It must also apply here, or a junk entry would read as "the page has
// marks" and suppress a legitimate restore.
{
  const outcome = batchFromPage({ type: 'ready', incoming: [null, 7], held: HELD })
  check(outcome.adopt.length === 2,
    'a page whose only entries are junk still counts as empty, so the batch is restored',
    `adopted ${outcome.adopt.length}`)
}

console.log('')
if (failures) {
  console.log(`${failures} failure(s)`)
  process.exit(1)
}
console.log('all checks passed')
