/**
 * The transcript chip: what a sent message carried, read back under that message.
 *
 * The chip shows the annotations a message carried. Its data comes from the block
 * the host already appended — there is no second copy, no endpoint, and no store
 * to drift. That is the whole design, and it makes one property load-bearing:
 * the client's reader must understand exactly what the host's writer emits.
 *
 * So this file drives BOTH real implementations and round-trips between them. A
 * hand-written fixture would be a copy of the format, and a copy passes while the
 * shipped pair disagree — which is the failure that would actually reach the
 * reader, since the chip would silently show nothing or the wrong fields.
 *
 * It also checks the two placement decisions that cannot be seen by reading the
 * component: the node is located `unresolved` (which is what keeps it out of
 * compact mode's process folding) and it is anchored just after the reader's own
 * bubble.
 *
 * The Definition is DRIVEN here, not pattern-matched. A first version matched the
 * source text of its matcher, and an injected fault was measured against it and
 * survived: the mutated text still contained the string being looked for. So
 * `match`, `start` and `buildViewNode` are called for real, and a mutation has to
 * change what they DO to be caught.
 */
import { readFileSync } from 'node:fs'

const HOST = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const CLIENT = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let failures = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/**
 * Lift one braced declaration out of a module by walking its braces.
 *
 * Slicing to a remembered end marker breaks on every edit, and a broken slice
 * reports a missing function rather than a real regression. Brace walking
 * survives refactors; the regex literals in both functions here are brace-free,
 * so the walk is exact.
 */
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

// --- the host's real writer, driven exactly as the host drives it -------------
const clipSrc = extractFunction(HOST, 'const clip = (value, max) =>')
const renderSrc = extractFunction(HOST, 'const renderAnnotations = (sessionId')
const buildHost = new Function('pending', 'delivered', `${clipSrc}\n${renderSrc}\nreturn renderAnnotations`)

// --- the client's real reader -------------------------------------------------
const parseSrc = extractFunction(CLIENT, 'function parseAnnotationBlock(content)')
const parseAnnotationBlock = new Function(`${parseSrc}\nreturn parseAnnotationBlock`)()

// --- the client's real placement arithmetic -----------------------------------
// Lifted from the source rather than reimplemented: a copy would keep passing while
// the shipped version drifted, which is the whole failure mode these checks exist to
// catch. The layout half of the placement cannot be tested here at all — jsdom has
// no layout engine, so every rect is zero — and that is precisely why the arithmetic
// was split out into a pure function.
const indentSrc = extractFunction(CLIENT, 'function chipIndent(rowWidth, bubbleWidth)')
const chipIndent = new Function(`${indentSrc}\nreturn chipIndent`)()
const rowPropsSrc = extractFunction(CLIENT, 'function rowProps(indent)')
const rowProps = new Function(`${rowPropsSrc}\nreturn rowProps`)()

console.log('=== the host writes, the client reads, the same marks come back ===')
const ENTRIES = [
  { selector: '.g-recharge', text: 'Recharge', note: '汇率太小，改成 20px', matches: 1, at: '679,276 50×16' },
  { selector: 'body > div:nth-of-type(2) > div:nth-of-type(5)', text: '复制邀请码', note: '', matches: 3, at: '612,1005 118×33' },
]
const block = buildHost(new Map([['s', ENTRIES]]), new Map())('s')
const parsed = parseAnnotationBlock([{ type: 'text', text: block }])

check(parsed.length === ENTRIES.length, 'one chip entry per mark', `${parsed.length} of ${ENTRIES.length}`)
check(parsed[0]?.selector === ENTRIES[0].selector, 'the selector survives the round trip', parsed[0]?.selector)
check(parsed[0]?.note === ENTRIES[0].note, 'the note survives, CJK included', parsed[0]?.note)
check(parsed[0]?.text === ENTRIES[0].text, 'the element text survives', parsed[0]?.text)
check(parsed[1]?.note === '', 'a mark written without a note reads back as empty, not as "undefined"', JSON.stringify(parsed[1]?.note))
check(parsed[1]?.selector === ENTRIES[1].selector, 'a positional selector survives intact', parsed[1]?.selector)

console.log('\n=== the fields the chip deliberately does not show ===')
// `at` is geometry the host emits only for an ambiguous positional selector. It
// means nothing beside a selector the reader is already looking at, so the chip
// does not carry it — and must not leak it into a visible field.
check(!JSON.stringify(parsed).includes('679,276'), 'geometry is not carried into the chip')
check(parsed.every((item) => !('at' in item)), 'and no entry exposes an "at" field')

console.log('\n=== the page is shown only when the marks span pages ===')
// The host emits `page:` only once the list covers more than one route, because
// otherwise it repeats what the reader already knows and costs tokens. The chip
// must agree, or it would show a page label for a single-page list.
const onePage = buildHost(
  new Map([['s', [{ selector: '.a', text: 'A', note: '', page: 'http://x/one', matches: 1 }]]]),
  new Map(),
)('s')
check(!/^page:/m.test(onePage), 'a single-page list carries no page line')
check(parseAnnotationBlock([{ type: 'text', text: onePage }])[0]?.page === '',
  'and the chip shows no page for it')
const twoPages = buildHost(
  new Map([['s', [
    { selector: '.a', text: 'A', note: '', page: 'http://x/one', matches: 1 },
    { selector: '.b', text: 'B', note: '', page: 'http://x/two', matches: 1 },
  ]]]),
  new Map(),
)('s')
const multi = parseAnnotationBlock([{ type: 'text', text: twoPages }])
check(multi[0]?.page === 'http://x/one' && multi[1]?.page === 'http://x/two',
  'a multi-page list names each page', JSON.stringify(multi.map((m) => m.page)))

console.log('\n=== it degrades instead of showing a wrong message ===')
// The chip's reader is handed every user/message in the transcript, including the
// reader\'s own text. Anything that is not this block must yield nothing, so a
// mis-registration cannot paint a chip onto an unrelated message.
check(parseAnnotationBlock([{ type: 'text', text: 'just a question about the layout' }]).length === 0,
  'ordinary reader text yields no chip entries')
check(parseAnnotationBlock([]).length === 0, 'an empty message yields nothing')
check(parseAnnotationBlock(null).length === 0, 'a null message yields nothing')
check(parseAnnotationBlock('').length === 0, 'an empty string yields nothing')
check(parseAnnotationBlock([{ type: 'image', url: 'x.png' }]).length === 0, 'a non-text block yields nothing')
// A block with the heading but no sections is the shape an all-empty report
// produces; it must not invent an entry from the heading alone.
check(parseAnnotationBlock([{ type: 'text', text: '# Web page elements\n\n' }]).length === 0,
  'a heading with no sections yields no entries')

console.log('\n=== the chip is registered as a second Conversation Definition ===')
// The seat and the Definition must agree on one kind name: the shell routes a
// node to its renderer by `node.kind`, so two names would leave the Definition
// with no occupant — and the shell renders its own JSON fallback there.
check(/const CHIP_KIND = 'dsh-annotate-chip'/.test(CLIENT), 'the chip kind is declared once')
check(new RegExp(`contribute\\('conversation\\.chat\\.node', CHIP_KIND`).test(CLIENT),
  'a renderer is seated on the chat node slot under that kind')

// Drive the REAL Definition rather than matching its source text. A textual
// assertion here was measured against an injected fault and survived it — the
// mutated matcher still contained the substring being looked for — which is
// exactly the blind spot this file exists to avoid. Calling `match` on synthetic
// events is true of the shipped function or it is not true at all.
const registerSrc = extractFunction(CLIENT, 'function registerChipDefinition(uiConversation)')
const CHIP_KIND = 'dsh-annotate-chip'
const buildRegister = new Function('CHIP_KIND', 'KIND', 'parseAnnotationBlock',
  `${registerSrc}\nreturn registerChipDefinition`)
let definition = null
const disposer = buildRegister(CHIP_KIND, 'dsh-annotate', parseAnnotationBlock)({
  events: { register: (def) => { definition = def; return () => {} } },
})
check(definition !== null, 'it registers through the conversation registry')
check(typeof disposer === 'function', 'and keeps the registry\'s disposer')

check(definition?.kind === CHIP_KIND, 'the Definition declares the seat\'s kind', definition?.kind)
check(definition?.target === 'chat', 'with the chat target, so it rides the transcript', definition?.target)

/** One synthetic session event, shaped as the host emits it. */
const event = (over) => ({
  type: 'user/message',
  seq: 100,
  surfaceOp: 'append',
  data: {
    id: 'annotate-1',
    source: { kind: 'plugin', plugin: 'dsh-annotate', form: 'notice' },
    content: [{ type: 'text', text: block }],
    ...over.data,
  },
  ...over,
})

console.log('\n=== only the host\'s own delivery message is matched ===')
// The reader's message and the delivery share a type. Matching on the type alone
// would put a chip under the reader's own message — the one message that may
// carry nothing at all.
check(definition.match(event({})) !== null, 'the delivery message matches')
check(definition.match(event({ data: { source: { kind: 'user' } } })) === null,
  'the reader\'s own message does not')
check(definition.match(event({ data: { source: { kind: 'plugin', plugin: 'someone-else' } } })) === null,
  'another plugin\'s message does not')
check(definition.match(event({ type: 'assistant/message' })) === null, 'an assistant message does not')
// `surfaceOp` lives on the event, not inside `data`. Reading it from the wrong
// place yields undefined and matches nothing, silently — so both directions are
// pinned: a non-append event must be refused, and the append one above must pass.
check(definition.match(event({ surfaceOp: 'replace' })) === null, 'a non-append event does not')
const noSurface = event({})
delete noSurface.surfaceOp
check(definition.match(noSurface) === null, 'nor does an event with no surface op')

const matched = definition.match(event({}))
check(matched?.role === 'start', 'matched as a start, keyed on the message id', matched?.role)
check(matched?.id === 'annotate-1', 'and keyed on the delivery message id', matched?.id)

console.log('\n=== placement: out of the process fold, just under the reader\'s bubble ===')
// Compact mode folds non-independent nodes that sit between a turn\'s process
// start and its answer. An unresolved node is outside every Turn, which is what
// makes the chip immune — it can neither be folded away nor change whether the
// host offers its own disclosure. This cannot be recovered later by styling, so
// it is asserted on the node the Definition actually builds.
const state = definition.start({ key: 'k', id: 'annotate-1' }, { event: event({}), role: 'start', location: { kind: 'unresolved' } }, null)
const node = definition.buildViewNode({ key: 'k', kind: CHIP_KIND, id: 'annotate-1', state, matches: [], current: null })
check(node?.location?.kind === 'unresolved',
  'the node is located unresolved, so the fold never sees it', JSON.stringify(node?.location))
// The delivery is written one seq after the reader\'s message, so half a seq down
// puts the chip after that bubble (seq-1) and before the context row (seq).
check(node?.anchorSeq === event({}).seq - 0.5,
  'and anchored just after the reader\'s own bubble', String(node?.anchorSeq))
check(node?.visibility === 'visible', 'it is visible by default', node?.visibility)
check(node?.target === 'chat' && node?.kind === CHIP_KIND, 'and routes back to its own seat')

console.log('\n=== a message with no marks builds no chip ===')
// The chip must not appear under a delivery that carried nothing: `buildViewNode`
// returning a node there would draw an empty chip on an unrelated message.
const emptyState = definition.start(
  { key: 'k', id: 'x' },
  { event: event({ data: { content: [{ type: 'text', text: 'not ours' }] } }), role: 'start', location: { kind: 'unresolved' } },
  null,
)
check(definition.buildViewNode({ key: 'k', kind: CHIP_KIND, id: 'x', state: emptyState, matches: [], current: null }) === null,
  'a message that is not the block yields no node at all')

console.log('\n=== the service is waited for, never sampled ===')
// Two separate failures live here and they need opposite assertions.
//
// The registry throws on a kind it already holds, and `apply` can re-run on a
// live registry. That throw must not escape: the sidebar, the tab and the
// composer capsule all share this activation, so an escaping throw takes the
// whole plugin down and the reader restarts DSH into an error.
//
// And the service must be WAITED for rather than read once. `uiConversation` is
// provided by another row and rows apply concurrently, so sampling it during
// `apply` reads `undefined` whenever that row is merely still starting. The
// shipped code branched on exactly that sample and skipped the registration for
// good — the chip was invisible while the tab and capsule worked, with nothing
// logged as an error. So `ctx.inject` is not a style preference here; it is the
// difference between a chip and no chip.
const applyBody = CLIENT.slice(CLIENT.indexOf('exports.apply'), CLIENT.indexOf('exports.apply') + 40)
const actStart = CLIENT.indexOf('function apply(')
const actEnd = CLIENT.indexOf('function AnnotateTab', actStart)
const activation = CLIENT.slice(actStart, actEnd)
// The bug, stated as a check: no eager sample of the service may gate the chip.
// A bare `ctx.get('uiConversation')` assigned to a variable is how the race got
// in, so its presence is the fault — not its absence.
check(!/=\s*ctx\.get\('uiConversation'\)/.test(activation),
  'the service is not sampled during apply, which is the race that hid the chip')
check(/ctx\.inject\(\['uiConversation'\]/.test(activation),
  'it is waited for, so a later provider still gets a chip')
// The try/catch has to be the one IMMEDIATELY around the registration. A looser
// window is worse than useless here: the whole `ctx.inject` call sits inside a `try`
// of its own, so a generous match finds that outer one and reports the inner guard
// as present even after it has been removed — which is exactly the blind spot this
// pair of assertions had when it was first written.
check(/try \{\s*\n\s*scope\.effect\(\(\) => registerChipDefinition\(scope\.uiConversation\)\)\s*\n\s*\} catch \(error\) \{/.test(activation),
  'the registration is wrapped in its own try')
check(/\} catch \(error\) \{\s*\n\s*console\.warn\([\s\S]{0,200}transcript chip could not register/.test(activation),
  'and degrades with a warning')
// The seat is registered unconditionally and the Definition only with the
// service, in that order: a Definition without an occupant renders the shell's
// JSON fallback in the reader's transcript, which is worse than no chip.
const seatAt = activation.indexOf("contribute('conversation.chat.node'")
const defAt = activation.indexOf('registerChipDefinition(scope.uiConversation)')
check(seatAt !== -1 && defAt !== -1 && seatAt < defAt,
  'the renderer seat is registered before the Definition that needs it')

console.log('\n=== the count and the list are the same list ===')
// The DOM check caught this on its first run: the chip counted raw entries while
// listing only the renderable ones, so `×3` could sit above two rows. Asserted
// here as well because it is invisible to every other source-level check — the
// number and the list are each individually well formed.
const chipStart = CLIENT.indexOf('function AnnotationChip(props)')
const chipBody = CLIENT.slice(chipStart, CLIENT.indexOf('\n    /**', chipStart))
check(/const items = raw\.filter\(/.test(chipBody),
  'the entries are filtered once, into the list the count reads')
check(!/\$\{raw\.length\}|\$\{data\.items\.length\}/.test(chipBody),
  'and the count never comes from the unfiltered array')

console.log('\n=== the placement arithmetic puts the chip under the bubble ===')
// The reader pointed at the bubble's LEFT edge, so the offset from the row's left
// edge has to be the bubble's own width subtracted from the row's — that is the
// identity `bubbleLeft = rowLeft + rowWidth - bubbleWidth`, which holds because the
// row is full width and the bubble is right-aligned inside it.
//
// Checked as arithmetic rather than through the DOM because no environment available
// here has a layout engine: jsdom reports a zero rect for every element, so the
// component would take its fallback on every run and a wrong number would never be
// seen. This is the number the reader actually sees.
const columnW = 748
check(chipIndent(columnW, 400) === 348,
  'a bubble narrower than the column is indented by the difference', String(chipIndent(columnW, 400)))
check(chipIndent(columnW, 100) === 648,
  'and a short bubble pushes the chip much further in than a long one',
  String(chipIndent(columnW, 100)))
check(chipIndent(columnW, 100) > chipIndent(columnW, 400),
  'so a shorter bubble always sits further from the column edge, never closer')
// The edge cases are the ones that decide whether there is an inline style at all.
check(chipIndent(columnW, columnW) === null,
  'a bubble as wide as the column needs no offset, since both alignments coincide')
check(chipIndent(columnW, columnW + 50) === null,
  'and an over-wide measurement degrades instead of producing a negative indent',
  String(chipIndent(columnW, columnW + 50)))
check(chipIndent(0, 400) === null, 'an unmeasured row takes the fallback')
check(chipIndent(columnW, 0) === null, 'and so does a message with no measurable bubble')
check(chipIndent(columnW, 400.4) === 348, 'the offset is whole pixels, never a fraction')
// A one-pixel offset is not worth an inline style: it is indistinguishable from the
// fallback, and emitting it would only make the DOM noisier.
check(chipIndent(columnW, columnW - 1) === null, 'a sub-pixel-visible offset is not emitted')
check(chipIndent(columnW, columnW - 3) === 3, 'but a visible one is', String(chipIndent(columnW, columnW - 3)))

console.log('\n=== the indent mode and its offset are emitted together ===')
// Padding alone cannot move the chip: while the row's items stay end-aligned, a left
// padding only narrows the content box and the chip does not move at all. A version
// that emitted the padding but forgot the alignment flip would look right in the DOM
// and place the chip wrong on screen, so both halves are asserted on one value.
const placed = rowProps(348)
check(placed.className.includes('dsa-chip-row--indent'),
  'a measured indent switches the row into its indent mode', placed.className)
check(placed.style && placed.style.paddingLeft === '348px',
  'and carries the offset inline', JSON.stringify(placed.style))
const fallen = rowProps(null)
check(fallen.className === 'dsa-chip-row', 'no measurement leaves the mode alone', fallen.className)
check(!fallen.style, 'and emits no offset at all', JSON.stringify(fallen.style))
check(rowProps(undefined).className === 'dsa-chip-row',
  'an absent measurement is treated exactly like a null one')

console.log('\n=== every clear empties the host mirror with it ===')
// The bug this guards was reported from a real session: a mark could be deleted
// and it came straight back, and after a send the sidebar kept its list while the
// capsule kept its count.
//
// The mirror of what the host holds (`hostHeld`) is what the restore path reads to
// decide whether an empty page report means "the preview was rebuilt, hand the
// marks back" or "there is genuinely nothing". Emptying the list without emptying
// the mirror leaves it describing a batch that no longer exists, so the page's own
// empty report is read as a rebuild and every released mark is put back — the
// reader deletes one mark and watches it return, and the marks the turn already
// carried are re-reported so the capsule goes on counting them.
//
// Asserted per assignment site rather than as one blob: the fault is a MISSING
// line, so a check that only looks for the line somewhere would pass on a file
// where one of the four clear paths had lost it.
//
// There were four sites and the fourth is gone on purpose. Navigation used to
// discard the list, because one panel showed one page and moving to another meant
// the old page's marks were no longer reachable. With tabs, navigating opens a
// second page and the first one's marks stay reachable, so nothing is discarded on
// navigation — and the `openTarget` assertions below pin that down, since a
// reintroduced clear there is exactly the regression this check exists to catch.
const clears = [
  ['releaseFromHost', /const releaseFromHost = \(\) => \{\n(?:.*\n)*?          hostHeld\.current = \[\]/],
  ['onRemoveAll', /const onRemoveAll = \(\) => \{\n(?:.*\n)*?          hostHeld\.current = \[\]/],
  ['clearAll', /await reportAnnotations\(\[\]\)\n            setAnnotations\(\[\]\)\n            hostHeld\.current = \[\]/],
]
for (const [label, pattern] of clears) {
  check(pattern.test(CLIENT), `${label} empties the host mirror`)
}
check(/hostHeld\.current = payload/.test(CLIENT),
  'a normal report keeps the mirror in step, so the restore path has fresh evidence')
check(!/const syncPage = /.test(CLIENT),
  'and the no-op mirror that hid this is gone')

console.log('\n=== a clear reaches EVERY page, not just the one on screen ===')
// Reported after a send: the capsule went on counting and the sidebar went on
// listing, with no marks on the page. Emptying the panel's own list was not enough,
// because the list is the FLATTENED UNION of every open page's marks — `flattenMarks`
// walks all of them. The purge was sent with no sid, and that form aims at
// `activeSidRef.current` alone, so a page in a background tab kept its marks,
// re-reported them, and the batch the reader had just let go of came straight back.
//
// Asserted as the two halves that have to happen together. A sweep of the pages
// without the per-page mirror still loses, because the mirror is what the list is
// rebuilt FROM — the two sides race and the populated one wins.
check(/const purgeEveryPage = \(\) => \{\n\s+for \(const tab of tabsRef\.current\) postToPage\(\{ type: 'purge' \}, tab\.sid\)\n\s+\}/.test(CLIENT),
  'the panel sweeps every open page when it clears',
  'purgeEveryPage aims each purge at its own sid')
check(/\.get\(tab\.sid\)|tab\.sid\)/.test(CLIENT) && !/postToPage\(\{ type: 'purge' \}\)/.test(CLIENT),
  'and never falls back to the sid-less purge that missed the background pages',
  (CLIENT.match(/postToPage\(\{ type: 'purge' \}\)/g) || []).length + ' sid-less purge(s) left')
check(/const forgetAllMarks = \(\) => \{\n\s+tabMarks\.current\.clear\(\)\n\s+closedMarks\.current\.clear\(\)\n\s+\}/.test(CLIENT),
  'the per-page mirror is emptied with them, or it re-derives the marks that were released')
// The three paths that let go of the list. Asserted per site: the fault is a MISSING
// call, so a check that only looks for it somewhere would pass on a file where one of
// the three had lost it — and each was a separate reader-visible symptom.
for (const [label, marker] of [
  ['releaseFromHost', 'const releaseFromHost = () => {'],
  ['onRemoveAll', 'const onRemoveAll = () => {'],
  ['clearAll', 'const clearAll = async () => {'],
]) {
  const at = CLIENT.indexOf(marker)
  const body = CLIENT.slice(at, at + 2600)
  const next = body.indexOf('\n        const ', 30)
  const scope = next === -1 ? body : body.slice(0, next)
  check(/forgetAllMarks\(\)/.test(scope), `${label} forgets every page's marks`)
  check(/purgeEveryPage\(\)/.test(scope), `${label} purges every open page`)
}

console.log('\n=== the clear epoch is remembered across a remount ===')
// A ref inside the capsule would take the epoch it first sees as its baseline, so
// a clear that happened while the dock was unmounted would never be announced and
// the panel would keep a list the host had already let go of. The map lives at
// module level for exactly that reason.
check(/const hostEpoch = new Map\(\)/.test(CLIENT),
  'the last-seen epoch is held outside the component')
check(/hostEpoch\.has\(sessionId\)/.test(CLIENT) && /hostEpoch\.set\(sessionId, data\.epoch\)/.test(CLIENT),
  'and is read back rather than started fresh on every mount')
check(!/const epoch = React\.useRef\(null\)/.test(CLIENT),
  'the per-mount ref that lost it is gone')

console.log('')
if (failures) {
  console.log(`CHIP CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('CHIP CHECKS PASSED')
