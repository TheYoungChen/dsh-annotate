/**
 * Several pages open at once, and the marks stay with the page they were made on.
 *
 * The panel used to hold one page: a single `preview` in state, a single iframe, a
 * single address bar. Asking for a second page replaced the first. Two things were
 * wrong with that, and both are asserted here.
 *
 *   1. The reader could not compare two pages, or keep a reference open while
 *      working on another. The panel is for reading a running app and writing about
 *      it, and that means more than one screen of it.
 *
 *   2. Mark identity was the ROUTE, not the page. `annotationsOn` matches on
 *      `location.pathname + search + hash`, so two tabs sitting on the same route
 *      would each draw the other's pins — the same number appearing twice, on two
 *      different documents, pointing at two different things. That is not a display
 *      wart: the number is how the reader refers to a mark in the message they send,
 *      so a duplicated number makes their own text ambiguous.
 *
 * What must hold, in the order the reader would hit it:
 *
 *   - asking for a second page ADDS a page, rather than replacing the first;
 *   - the page already on screen is not reopened as a duplicate when the host
 *     hands back the sid it already had;
 *   - every open page stays mounted, so switching back is not a reload;
 *   - marks are filed per page, so one page's list cannot contain another's;
 *   - closing a page KEEPS its marks, keeps its last known match count, and labels
 *     them as coming from a closed page rather than claiming they are located;
 *   - the open set survives a remount, so a sidebar tab switch does not close pages;
 *   - the heartbeat names every open page, so a background page is not reaped.
 *
 * Run: node scripts/check-tabs.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const CLIENT = readFileSync(`${root}client.js`, 'utf8')
const HOST = readFileSync(`${root}lib/index.js`, 'utf8')

let failures = 0
const check = (pass, label, detail) => {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures += 1
}
const has = (re, label, detail) => check(re.test(CLIENT), label, detail)

/**
 * The text of one brace-balanced block, starting at a marker.
 *
 * Needed because the assertions here are about what a block does NOT do, and a
 * "does not contain X within N characters" window is not that: the next statement
 * is a long way off, so the window either misses the fault or swallows unrelated
 * code. Matching the block's real extent is the only honest version.
 * @param src - the file text.
 * @param marker - the literal the block starts at, ending in `{`.
 * @returns the block including its braces, or '' when the marker is absent.
 */
const block = (src, marker) => {
  const start = src.indexOf(marker)
  if (start === -1) return ''
  let depth = 0
  for (let i = start + marker.length - 1; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return ''
}

console.log('=== a second page is added, not swapped in ===')

// State is a list plus an active sid. A single `preview` object is the shape that
// made a second page replace the first.
check(!/const \[preview, setPreview\] = React\.useState/.test(CLIENT),
  'the single-preview state is gone')
has(/const \[tabs, setTabsState\] = React\.useState\(\[\]\)/, 'the open pages are a list')
// The list is written through a ref, not only into state: opening a page spans
// several awaits and state changes on the next render, so a state-only update loses
// the first of two pages opened in one tick. `check-tabs-dom.mjs` renders that case;
// this pins the mechanism that makes it work.
has(/tabsRef\.current = list/, 'and every change is committed to the ref synchronously')
has(/const \[activeSid, setActiveSid\] = React\.useState\(''\)/, 'and one of them is active')
has(/const preview = tabs\.find\(\(tab\) => tab\.sid === activeSid\) \|\| null/,
  'the page on screen is derived from the list, not stored twice')

// Per-page marks are the fix for the duplicated-number fault.
has(/const tabMarks = React\.useRef\(new Map\(\)\)/, 'marks are filed per page')
has(/const closedMarks = React\.useRef\(new Map\(\)\)/, 'and marks from closed pages are kept')

console.log('\n=== asking for a page that is already open does not duplicate it ===')
// The host answers `/open` with the sid it already had for that target. Treating
// that as a new page would put two iframes on one preview and split its marks
// between two owners.
has(/const known = tabsRef\.current\.find\(\(tab\) => tab\.sid === data\.sid\)/,
  'a reused sid is recognised')
const knownBlock = block(CLIENT, 'if (known) {')
check(knownBlock.includes('setActiveSid(data.sid)'),
  'and brings that page to the front instead of adding a second entry')
// The reuse branch must RETURN. Without it the code falls through to the add path
// at the bottom of the same function, so the host's "same target, same sid" answer
// becomes a second tab for one page: two iframes on one preview, and that page's
// marks split between two owners — one of them silently never drawn.
//
// Testing for `return` rather than for an absent `setTabs`: the add call sits
// OUTSIDE this block, so an "is setTabs absent" test is true either way and cannot
// fail. That version of this assertion passed against the mutation.
check(knownBlock !== '' && /\breturn\b/.test(knownBlock),
  'the reuse branch returns, so it cannot fall through and open the page twice')

console.log('\n=== every open page stays mounted ===')
// Unmounting a hidden page would destroy its document: scroll position, typed-but-
// unsaved state, sessionStorage. Switching back would be a reload.
has(/tabs\.map\(\(tab\) => h\('iframe', \{/, 'one iframe per open page')
has(/hidden: tab\.sid !== activeSid/, 'the ones behind are hidden, not unmounted')
has(/frameRefs\.current\.set\(tab\.sid, node\)/, 'each frame is reachable by its page id')
// A `display:block` on the iframe outranks the user agent's `[hidden]` rule, so
// without an explicit rule a hidden page would still be laid out on top.
has(/\.dsa-frame iframe\[hidden\]\{display:none\}/,
  'and the hidden attribute actually hides it')

console.log('\n=== closing a page keeps what was written on it ===')
// The reader closed a page, not their opinion of it. The marks stay in the batch
// and in the list — but they are NOT claimed as located, because only the
// originating document could resolve their selectors.
has(/const closeTab = async \(sid\) => \{/, 'closing a page is its own action')
has(/closedMarks\.current\.set\(sid, \{ marks, target: tab\.target \|\| tab\.url \}\)/,
  'its marks are parked rather than dropped')
has(/out\.push\(\.\.\.list\.map\(\(entry\) => Object\.assign\(\{\}, entry, \{\n\s+closed: true,/,
  'and are flagged as coming from a closed page')
has(/closed: entry\.closed === true \? true : undefined,/,
  'the flag crosses to the model, so a stale count is not read as a fact')
// A closed page's pins cannot be redrawn, so the tab must go even though its marks stay.
has(/const nextActive = activeSidRef\.current === sid/, 'another page takes over on close')
check(!/window\.confirm|confirm\(/.test(CLIENT),
  'closing is not confirmed — it destroys nothing, so there is nothing to guard')

console.log('\n=== the open set survives a sidebar tab switch ===')
// The panel body unmounts when the reader visits another sidebar tab. Without a
// remembered set they came back to a blank box; without the ACTIVE page being
// remembered, they came back to whichever page happened to open last.
has(/function rememberOpen\(sessionKey, targets, active\)/, 'the open set is remembered')
has(/JSON\.stringify\(\{ targets: list, active: active \|\| '' \}\)/, 'as a list plus the active one')
has(/const remembered = readOpen\(sessionKey\)/, 'and is restored on mount')
has(/for \(const target of remembered\.targets\)/, 'every remembered page is reopened')
has(/if \(remembered\.active\) \{/, 'with the page the reader was on brought back to the front')

console.log('\n=== a background page is not reaped ===')
// The host closes a preview whose `touched` is stale, and `touched` only advances
// when the PREVIEW receives a request. A background tab issues none, so without a
// heartbeat it would be closed under the reader and switching back would show
// "connection refused" for a page they never closed.
has(/fetch\(`\$\{API\}\/touch`/, 'the panel names its open pages')
check(/case 'touch':/.test(HOST), 'and the host has a route for it')
check(!/case 'touch':[\s\S]{0,600}?preview\.targetOrigin/.test(HOST),
  'which does not forward a request into the framed application')

// The heartbeat must not be re-armed by a re-render. `openTarget` is rebuilt every
// render, so an effect that depended on it fired a request per keystroke in the
// address bar, and left an interval holding the event loop open.
has(/\}, \[tabs\.length\]\)/, 'the heartbeat is keyed on the page count alone')
has(/openTargetRef\.current = openTarget/, 'and reaches the current openTarget by ref')

console.log('\n=== the address bar follows the page on screen ===')
has(/const startEditing = \(\) => \{/, 'clicking the chip seeds the field with the current address')
has(/if \(preview\) setUrl\(preview\.target \|\| preview\.url \|\| ''\)/, 'from the active page')
has(/const pageUrl = preview \? preview\.pageUrl \|\| '' : ''/, 'and the bar tracks that page\'s own route')
has(/patchTab\(tab\.sid, \{ pageUrl: data\.url \}\)/, 'updated by the page that reports it')

console.log('\n=== the limit is stated, not silent ===')
// The reader chose 4 for performance. Each page is a whole document with its own
// timers, so the iframe count is the real cost. At the limit the oldest page goes —
// and it keeps its marks like any other close, so nothing written is lost.
has(/const TAB_LIMIT = 4/, 'four pages at a time')
has(/if \(next\.length >= TAB_LIMIT && next\.length\) \{/, 'opening a fifth retires the oldest')
has(/flash\(t\('panel\.tabEvicted'\)\.replace\('\{n\}', String\(TAB_LIMIT\)\)\)/,
  'and the reader is told, rather than left to notice a tab missing')
has(/'panel\.tabEvicted': 'Closed the oldest page/, 'in English')
has(/'panel\.tabEvicted': '已关掉最早打开的页面/, 'and in Chinese')

console.log('\n=== there is a way to ask for another page ===')
// The gap that made the feature unusable, and that every other assertion here sailed
// past: multi-tab was implemented end to end and there was still no control to open a
// SECOND page. The strip only rendered from two pages up, so at one page — the state
// the reader is always in when they want a second one — the button that adds a page did
// not exist. Asserting the strip's shape says nothing about whether it is reachable;
// these do.
has(/if \(\(!tabs \|\| tabs\.length === 0\) && !draft\) return null/,
  'the strip renders from the very first page, not from the second — and for a draft, which has no page yet')
has(/className: 'dsa-tab-new'/, 'and it carries a control for opening another page')
// The blank tab itself. The reader's report: "+" emptied the address bar and nothing
// else happened, so "typing a new address" and "editing this one" looked identical.
// The fix is a tab they can SEE, which is what makes it a draft rather than a mode.
has(/const \[draft, setDraft\] = React\.useState\(false\)/,
  'a new page is a draft with its own state, so it can be drawn before it has an address')
has(/className: 'dsa-tab dsa-tab-draft'/, 'and it is drawn as a tab of its own')
has(/setDraft\(true\)/, 'which the new-page button sets')
has(/draft,\n\s+onDraftCancel:/, 'and which the strip is given, with a way to discard it')
// It must be the SELECTED tab, and the page below must lose that look at the same
// time — two tabs wearing the selected state is worse than none.
has(/'data-on': !draft && tab\.sid === activeSid \? 'true' : undefined/,
  'the real tabs give up the selected look while the draft is open')
has(/className: 'dsa-tab dsa-tab-draft',\n\s+'data-on': 'true'/, 'which the draft takes instead')
// The button opens the address bar, and the flag that expands it is the PANEL's: it was
// private to the bar, which is a sibling, so the button could not have reached it.
has(/const \[composing, setComposing\] = React\.useState\(false\)/,
  'the address bar is expanded by panel state, so a sibling can open it')
has(/const expanded = composing \|\| !preview/, 'and the bar switches on that flag')
has(/setComposing\(true\)/, 'which the new-page button sets')
has(/composing,\n\s+setComposing,/, 'and which the bar is given')
// Discarding it has to reach the draft too, or Escape would leave a blank tab behind
// with its text gone, which reads as a page that failed to open.
has(/if \(draft\) onDraftCancel\(\)/, 'Escape discards the draft rather than only its text')

console.log('\n=== the strip is drawn like a browser draws one ===')
// The reader: the tabs looked bad and did not read as tabs. These are the three
// properties that make a strip read as tabs, asserted against the stylesheet rather
// than trusted, because jsdom does no layout and every other check here is blind to
// this: a tab with no border and no selected state passes all of them.
{
  const css = CLIENT.slice(CLIENT.indexOf("const CSS = "), CLIENT.indexOf('`', CLIENT.indexOf("const CSS = ") + 13))
  const rule = (selector) => {
    const at = css.indexOf(`${selector}{`)
    return at === -1 ? '' : css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
  }
  const tab = rule('.dsa-tab')
  const on = rule('.dsa-tab[data-on]')
  const strip = rule('.dsa-tabs')
  check(/border:1px solid/.test(tab), 'every tab carries a real border', tab.slice(0, 60))
  check(/border-radius:8px 8px 0 0/.test(tab), 'and is rounded on top, the way a tab is')
  // Equal widths are the reader's explicit request. Basis 0 is what does it: the free
  // space is divided evenly, so the tabs share the sidebar instead of sizing to their
  // labels — and a long address cannot push its neighbours narrower.
  check(/flex:1 1 0/.test(tab), 'and takes an equal share of the strip', tab.slice(0, 60))
  check(/align-items:flex-end/.test(strip) && /border-bottom:1px solid/.test(strip),
    'the strip has a baseline for the tabs to stand on')
  // The selected state has to survive a palette change, so it is carried by more than
  // one property: the accent bar, the fill, and the dimming of everything else.
  check(/var\(--dsa-accent\)/.test(on), 'the selected tab is marked with the accent colour', on.slice(0, 60))
  check(/background:var\(--dsa-chrome\)/.test(on), 'and is filled rather than outlined')
  check(/\.dsa-tab:not\(\[data-on\]\)\{opacity:/.test(css),
    'while the tabs that are not selected are dimmed as a whole')
  // A draft must not be mistakable for a loaded tab whose label is merely hidden.
  check(/\.dsa-tab-draft\{border-style:dashed/.test(css), 'and a blank tab is dashed, not solid')
}
// THE ONE THAT MATTERS MOST. This stylesheet is a template literal, so a single stray
// backtick closes it early and turns the rest of the CSS into JavaScript — which is not
// a broken plugin but a broken BUNDLE: every client module is served from one combo URL,
// so an unparsable file here takes the whole sidebar down with it. That happened. The
// count is asserted rather than assumed.
{
  const open = CLIENT.indexOf('const CSS = ')
  const close = CLIENT.indexOf('\n`', open)
  const body = CLIENT.slice(open, close)
  const ticks = (body.match(/`/g) || []).length
  check(ticks === 1 && close !== -1,
    'the stylesheet template literal is never closed early',
    `${ticks} backtick(s) inside it — expected exactly the one that opens it`)
}

console.log('\n=== the address bar belongs to the toolbar, the tabs are their own row ===')
// The reader: "标签页是一组、地址栏和标签页是分开独立存在的". The bar used to be a
// sibling row stacked directly under the strip, so the two read as one unit and the
// toolbar above them kept a hole where the address should have been. Nesting is the
// only thing that separates the two arrangements, so it is what is asserted.
{
  const barAt = CLIENT.indexOf("className: 'dsa-bar'")
  const stripAt = CLIENT.indexOf('h(TabStrip, {')
  check(barAt !== -1 && stripAt !== -1 && barAt < stripAt,
    'the toolbar is rendered above the tab strip')
  check(/h\(OpenBar, \{/.test(CLIENT.slice(barAt, stripAt)),
    'the address bar is rendered inside the toolbar row')
  check(!/h\(OpenBar, \{/.test(CLIENT.slice(stripAt, CLIENT.indexOf("className: 'dsa-warn'"))),
    'not as a row of its own below the tab strip')
  check(!/dsa-spacer/.test(CLIENT), 'and the toolbar carries no spacer for it to hide behind')
}

console.log('\n=== marking is the panel\'s mode, not each page\'s ===')
// The reader: "不同的标签页之前并不是共享'选取'状态的 每个页面都是独立的 我觉得可以考虑
// 做成一致的". Marking lived on the per-page record, so turning 选取 on then switching tab
// showed it off again while the first page was still capturing clicks. The reader's
// reading is the right one: the tabs differ in content, not in kind — every one of them
// is a page to annotate — so the mode is one panel-wide fact.
{
  has(/const \[mode, setModeState\] = React\.useState\('idle'\)/,
    'marking mode is panel state, once, not a field on a page record')
  check(!/tab\.mode|preview\.mode/.test(CLIENT),
    'and nothing still reads a per-page mode')
  has(/for \(const tab of tabsRef\.current\) postToPage\(\{ type: 'mode', mode: value \}, tab\.sid\)/,
    'turning it on or off is broadcast to EVERY open page')
  has(/const reported = data\.mode === 'marking' \? 'marking' : 'idle'\n\s+if \(reported !== modeRef\.current\) setPageMode\(reported\)/,
    'and a page that leaves marking on its own is adopted once, not echoed forever')
  has(/if \(data\.type === 'ready'\) \{\n\s+postToPage\(\{ type: 'mode', mode: modeRef\.current \}, tab\.sid\)/,
    'a page that boots into a marking panel is told the mode it is in')
}

console.log('')
if (failures) {
  console.log(`TAB CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('TAB CHECKS PASSED')
process.exit(0)
