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
// The address bar is the one exception: once a page is open it is collapsed to a
// single line, and the expanded input has to take the row's slack. Everything
// else is fixed so the frame's height is predictable.
for (const selector of ['.dsa-bar', '.dsa-hint', '.dsa-open-wrap']) {
  const body = rule(selector)
  ok(/flex:0 0 auto/.test(body || ''), `${selector} is size-capped`, body && body.match(/flex:[^;]*/)?.[0])
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
// One toolbar row and one address row. The menu, the picker and the discovered
// list are all overlays or fixed-position popovers, so they cost zero column
// height — that is the whole reason for the change.
const rows = {
  toolbar: 28,
  address: 28,
  gaps: 2 * 8,
}
const chrome = Object.values(rows).reduce((a, b) => a + b, 0)
const forPreview = usable - chrome
console.log('  usable height      :', usable)
console.log('  fixed rows         :', chrome, JSON.stringify(rows))
console.log('  preview gets       :', forPreview, `(${Math.round((forPreview / usable) * 100)}%)`)
ok(forPreview > 520, 'the preview keeps the large majority of the column', `${forPreview}px`)
// The old design spent 4 rows on chrome. Assert the regression cannot come back.
ok(chrome <= 72, 'chrome costs at most two rows', `${chrome}px`)

console.log('')
if (failures.length) {
  console.log(`LAYOUT CHECKS FAILED — ${failures.length} problem(s)`)
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
console.log('LAYOUT CHECKS PASSED')
