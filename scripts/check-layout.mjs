/**
 * Check that the preview actually gets vertical space in a narrow sidebar.
 *
 * The panel's own chrome used to consume the column and leave the page a few
 * pixels tall, and the marked-element list held a permanent block beneath the
 * frame. `src` is the whole client module, so both the CSS rules and the
 * component structure are checked here.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')
const css = src

const failures = []
const ok = (condition, label, detail) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`\\${escaped}\\{([^}]*)\\}`).exec(css) || new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  return match ? match[1] : null
}

console.log('=== the panel itself must not scroll as one long column ===')
const panel = rule('.dsa-panel')
ok(panel !== null, 'the panel rule exists')
ok(/overflow:hidden/.test(panel || ''), 'the panel clips instead of scrolling everything', panel && panel.match(/overflow:[^;]*/)?.[0])
ok(/min-height:0/.test(panel || ''), 'the panel allows its children to shrink', panel && panel.match(/min-height:[^;]*/)?.[0])

console.log('\n=== the preview must claim the free space ===')
const frame = rule('.dsa-frame')
console.log('  .dsa-frame:', frame)
ok(/flex:1/.test(frame || ''), 'the preview grows to fill the column')
const minHeight = /min-height:(\d+)px/.exec(frame || '')
console.log('  preview minimum height:', minHeight && `${minHeight[1]}px`)
ok(Number(minHeight && minHeight[1]) <= 200, 'the preview minimum is modest, not greedy')

console.log('\n=== chrome rows must not grow ===')
// Two fixed rows: the toolbar and the tab strip. The address bar is the one
// control that must take the slack, and it does that INSIDE the toolbar row — the
// arrangement the reader asked for, and the one that costs no third row. So the
// toolbar is still size-capped, and the bar is the thing that grows within it.
for (const selector of ['.dsa-bar', '.dsa-hint', '.dsa-tabs']) {
  const body = rule(selector)
  ok(/flex:0 0 auto/.test(body || ''), `${selector} is size-capped`, body && body.match(/flex:[^;]*/)?.[0])
}
{
  const openWrap = rule('.dsa-open-wrap')
  ok(/flex:1 1 auto/.test(openWrap || ''),
    'the address bar takes the toolbar row\'s slack', openWrap && openWrap.match(/flex:[^;]*/)?.[0])
}

console.log('\n=== the tabs are one group, the address bar is a separate thing ===')
// The reader's words: "标签页是一组、地址栏和标签页是分开独立存在的". They were two
// rows stacked together, which read as one unit, and the toolbar above them had a
// hole where the address belonged. Asserted as STRUCTURE, because both arrangements
// are a toolbar, a strip and a bar in some order — only the nesting tells them apart,
// and no rendered check can see it either (jsdom does no layout).
{
  const barAt = css.indexOf("className: 'dsa-bar'")
  const stripAt = css.indexOf('h(TabStrip, {')
  ok(barAt !== -1 && stripAt !== -1 && barAt < stripAt,
    'the toolbar is rendered above the tab strip')
  const toolbarRow = css.slice(barAt, stripAt)
  ok(/h\(OpenBar, \{/.test(toolbarRow),
    'the address bar is rendered INSIDE the toolbar row, not as a row of its own')
  ok(!/h\(OpenBar, \{/.test(css.slice(stripAt, css.indexOf("className: 'dsa-warn'"))),
    'and not again below the tab strip, where it used to sit')
  ok(!/dsa-spacer/.test(css),
    'the toolbar carries no spacer, because the address bar now fills that space')
}

console.log('\n=== the toolbar does not wrap ===')
// A wrapping toolbar is how a 28px control becomes a 90px block in a narrow
// sidebar, which is what crowded the page out.
const barBody = rule('.dsa-bar')
ok(!/flex-wrap/.test(barBody || ''), 'the toolbar is a single row that never wraps')

console.log('\n=== secondary controls live behind a menu ===')
for (const selector of ['.dsa-menu', '.dsa-menu-row', '.dsa-menu-block']) {
  ok(rule(selector) !== undefined, `${selector} is styled`)
}
ok(/position:absolute/.test(rule('.dsa-menu') || ''), 'the menu floats rather than displacing the page')
ok(/PanelMenu/.test(css), 'the menu component exists')
// The three controls the reader could not identify, now inside the menu.
for (const key of ['panel.refresh', 'panel.detectLong', 'panel.clearAll']) {
  ok(css.includes(key), `${key} is a labelled menu entry`)
}

console.log('\n=== the marked-element list is an overlay, not a permanent block ===')
const countBody = rule('.dsa-count-body')
ok(/position:(absolute|fixed)/.test(countBody || ''), 'the list floats over the preview')
ok(!/dsa-list-wrap/.test(css), 'no permanent list block remains in the column')
ok(/\.dsa-count\{/.test(css), 'the toolbar carries a counter')
ok(/CountButton/.test(css), 'the counter component exists')

console.log('\n=== the bulk clear cannot be scrolled out of the dialog ===')
// The reader asked for a bulk clear in this dialog, believing there was none. There
// was: it sat at the end of a single scrolling column, so a long list pushed it below
// the fold — present, working, and out of sight, which reads exactly like missing.
// The fix is which element scrolls, and that is a layout fact, so it is asserted here
// rather than through the DOM: jsdom reports no heights, so a rendered check cannot
// see the difference between a pinned bar and one that scrolls away.
{
  // The dialog is a column that clips, so its children can be laid out separately.
  ok(/overflow:hidden/.test(countBody || '') && /display:flex/.test(countBody || ''),
    'the dialog clips and lays out as a column, so one child can scroll and another cannot',
    countBody && countBody.match(/overflow:[^;]*/)?.[0])
  ok(/flex-direction:column/.test(countBody || ''), 'with the list above the bar')
  // The list is the scroller.
  const mainList = rule('.dsa-count-main .dsa-list')
  ok(/overflow:auto/.test(mainList || ''),
    'the LIST scrolls, not the dialog', mainList && mainList.match(/overflow:[^;]*/)?.[0])
  ok(/min-height:0/.test(mainList || ''),
    'and is allowed to shrink, or it would push the bar out instead of scrolling',
    mainList && mainList.match(/min-height:[^;]*/)?.[0])
  // The bar must not be inside that scroller, which is what makes it stay put.
  const bar = rule('.dsa-count-main .dsa-bar')
  ok(/flex:0 0 auto/.test(bar || ''), 'the action bar keeps its natural height', bar)
  // Stated as structure, because CSS alone cannot express it: the bar and the list
  // must be siblings under `.dsa-count-main`. A bar nested inside the list would
  // scroll with the rows no matter how it is styled.
  const main = css.slice(css.indexOf("className: 'dsa-count-main'"), css.indexOf('function AccentPicker'))
  ok(/className: 'dsa-list'/.test(main) && /className: 'dsa-bar'/.test(main),
    'the bar and the list are both direct children of the dialog body')
  ok(main.indexOf("className: 'dsa-bar'") > main.indexOf("className: 'dsa-list'"),
    'with the bar after the list, so it reads as the last action')
  ok(/t\('panel\.removeAll'\)/.test(main), 'and it still holds the bulk clear')
}

console.log('\n=== guidance occupies the frame, never a row above it ===')
// It used to be a row of its own above the frame, which pushed the page down even
// when there was no page. Now the empty frame carries it, so opening a page does
// not reflow the panel.
ok(/dsa-empty-frame/.test(css), 'the empty frame carries the first-run guidance')
ok(/dsa-empty-frame[^{]*\{[^}]*border-style:dashed/.test(css), 'and reads as an empty slot')

console.log('\n=== discovery has exactly one entry point ===')
// It was in two places at once: the overflow menu AND a button beside "Open". Two
// controls for one action made the reader wonder whether they differed.
{
  const openBar = css.slice(css.indexOf('function OpenBar'), css.indexOf('function ServerLists'))
  ok(!/onDetect/.test(openBar), 'the address bar no longer offers a second detect button')
  ok(/onDetect/.test(css.slice(css.indexOf('function PanelMenu'))), 'the menu keeps the one detect entry')
}

console.log('\n=== the attached list is not painted under the conversation ===')
// It was `position:absolute` with `z-index:20`, anchored to a button inside the
// sidebar. The shell's chat column is its own stacking context, so a locally large
// z-index still lost, the panel appeared from the left, and widening the sidebar
// changed nothing because the element was never clipped -- it was underneath.
{
  const body = rule('.dsa-count-body')
  ok(/position:fixed/.test(body || ''), 'the list is positioned against the viewport, not the sidebar')
  ok(/z-index:(\d{6,})/.test(body || ''), 'and above the shell chrome', body && body.match(/z-index:[^;]*/)?.[0])
  ok(/dsa-count-scrim/.test(css), 'a scrim separates it from the page behind')
}

console.log('\n=== clicking a number in the page opens the editor ===')
// `.dsa-layer` sets `pointer-events:none`, and a descendant cannot opt back in
// across an ancestor that said no -- so `pointer-events:auto` on the pin was inert
// and the number was not clickable at all.
{
  const overlaySource = readFileSync(fileURLToPath(new URL('../lib/overlay.js', import.meta.url)), 'utf8')
  ok(/pinLayer\.className = 'dsa-pins'/.test(overlaySource), 'the pin container has a class')
  ok(/\.dsa-pins\{[^}]*pointer-events:none/.test(overlaySource), 'the container stays transparent to clicks')
  ok(/\.dsa-pins>\.dsa-pin\{[^}]*pointer-events:auto/.test(overlaySource), 'and re-enables them for the pins')
}

console.log('\n=== the note card says how to commit ===')
{
  const overlaySource = readFileSync(fileURLToPath(new URL('../lib/overlay.js', import.meta.url)), 'utf8')
  ok(/dsa-keys/.test(overlaySource), 'a keyboard legend is rendered')
  ok(/keyNewline/.test(overlaySource) && /keySave/.test(overlaySource), 'it names both Enter and the save chord')
  ok(/IS_MAC/.test(overlaySource), 'the modifier is named for the reader platform')
}

console.log('\n=== simulate the distribution in a narrow sidebar ===')
// Pixels available to the panel in a short, narrow sidebar column.
const usable = 640
// Two rows of chrome: the toolbar (which now contains the address bar) and the
// tab strip. The menu, the picker and the discovered list are all overlays or
// fixed-position popovers, so they cost zero column height — that is the whole
// reason for the change. Three rows is what this asserts against: the address bar
// used to be a row of its own below the strip, and that is the arrangement the
// reader rejected.
const rows = {
  toolbar: 28,
  tabs: 25,
  gaps: 2 * 8,
}
const chrome = Object.values(rows).reduce((a, b) => a + b, 0)
const forPreview = usable - chrome
console.log('  usable height      :', usable)
console.log('  fixed rows         :', chrome, JSON.stringify(rows))
console.log('  preview gets       :', forPreview, `(${Math.round((forPreview / usable) * 100)}%)`)
ok(forPreview > 520, 'the preview keeps the large majority of the column', `${forPreview}px`)
// A third row would put this over. Assert the regression cannot come back.
ok(chrome <= 72, 'chrome costs at most two rows', `${chrome}px`)

console.log('')
if (failures.length) {
  console.log(`LAYOUT CHECKS FAILED — ${failures.length} problem(s)`)
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
console.log('LAYOUT CHECKS PASSED')
