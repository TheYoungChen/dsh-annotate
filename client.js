/**
 * dsh-annotate — sidebar half.
 *
 * This is the panel that lives in the harness right sidebar. It has one job
 * that matters: turn a list of picked elements into text an agent can act on.
 *
 * The framing that shapes everything here is the difference between the two
 * kinds of entry, which is also what the payload header spells out:
 *
 *   #1 [标注] button.primary     — a location. Nothing was asked for.
 *   #2 [批注] div.pricing-card   — a location, plus what should change.
 *
 * Both are complete. An entry with no note is not an unfinished one, so the
 * list renders them as equals, numbered in reading order down the page, and
 * the payload keeps the distinction visible rather than flattening it.
 *
 * The panel is a React component registered into two sidebar slots, talking to
 * the framed preview over postMessage.
 */

window.__ModuleLoader__.load({
  id: 'dsh-annotate',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const KIND = 'dsh-annotate'
    const TAB_ID = 'dsh-annotate-tab'
    // The second business Definition's kind, and the keyed renderer seat it
    // dispatches to. Both names are the same string on purpose: the chat seat
    // routes by `node.kind`, so one name keeps the two halves from drifting.
    const CHIP_KIND = 'dsh-annotate-chip'
    const OVERLAY_CHANNEL = 'dsh-annotate-overlay'
    const PANEL_CHANNEL = 'dsh-annotate-panel'
    const API = '/__dsh-annotate'

    // ------------------------------------------------------------------ i18n

    const CATALOG = {
      en: {
        'tab.title': 'Annotate',
        'tab.description': 'Select elements in a running app and attach them to your next message.',
        'panel.title': 'Annotate',
        'panel.mark': 'Select',
        'panel.marking': 'Selecting…',
        'panel.markHint': 'Click elements in the page to mark them. A note is optional.',
        'panel.stop': 'Stop',
        'panel.stopHint': 'Stop selecting and return the page to normal clicking',
        'panel.empty': 'No annotations yet. Choose Select, then click an element in the preview.',
        'panel.emptyShort': 'No annotations yet — choose Select, then click an element.',
        'panel.listTitle': 'Attached to your next message',
        'panel.listShort': 'Marked',
        'panel.listUnit': 'element(s) attached',
        'panel.pageUnknown': 'Page not recorded',
        'panel.close': 'Close',
        'panel.tabClose': 'Close this page',
        'panel.tabNew': 'Open another page',
        'panel.tabDraft': 'New tab',
        'panel.tabDraftHint': 'Type an address and press Enter',
        'panel.tabDraftCancel': 'Discard this new tab',
        'panel.tabLimit': 'Opening another closes the oldest — {n} at a time is the limit',
        'panel.tabEvicted': 'Closed the oldest page — {n} at a time is the limit',
        'panel.fromClosed': 'page closed',
        'panel.kindMark': 'mark',
        'panel.kindNote': 'note',
        'panel.edit': 'Edit',
        'panel.remove': 'Remove',
        'panel.removeAll': 'Clear all',
        'composer.capsuleLabel': 'Annotations',
        'composer.capsuleUnit': 'attached',
        'composer.capsuleHint': 'Sent as context alongside your next message. Not inserted into the text you type. Open to list them.',
        'composer.capsuleExpand': 'Show what this batch carries',
        'composer.capsuleCollapse': 'Collapse',
        'composer.capsuleLoading': 'Reading…',
        'composer.capsuleEmpty': 'This batch has no detail to show yet.',
        'composer.capsuleFailed': 'Could not read the detail. The annotations themselves are still attached.',
        'chip.label': 'Annotations',
        'chip.unit': 'in this message',
        'chip.hint': 'Page elements attached to this message as context. Open to list them.',
        'chip.page': 'page',
        'chip.empty': 'This message carries no annotations.',
        'panel.cleared': 'All annotations cleared.',
        'panel.clearFailed': 'Could not clear the annotations. They are unchanged.',
        'panel.open': 'Open a page',
        'panel.detecting': 'Searching for local servers…',
        'panel.noServers': 'No local server found. Start one, or open a page from the workspace.',
        'panel.pages': 'Workspace pages',
        'panel.serviceHtml': 'Web page',
        'panel.serviceJson': 'JSON API',
        'panel.serviceText': 'Plain text',
        'panel.serviceUnknown': 'Unnamed service',
        'panel.discovered': 'Detected servers and pages',
        'panel.menu': 'More',
        'panel.refresh': 'Refresh the page',
        'panel.detectLong': 'Find local servers and pages',
        'panel.clearAll': 'Clear all marks',
        'panel.cancel': 'Cancel',
        'panel.urlPlaceholder': 'http://localhost:3000, or a file path',
        'panel.accent': 'Mark colour',
        'panel.accentHint': 'Applies to marks, pins and this panel',
        'panel.urlPlaceholder': 'http://localhost:5173 or a workspace .html file',
        'panel.go': 'Open',
        'panel.frameHint': 'If the page stays blank, the app may refuse to be embedded.',
        'panel.reload': 'Reload',
        'panel.notLocal': 'Only localhost targets are supported in this release.',
        'panel.ready': 'Ready',
        'panel.missing': 'That element is no longer on the page.',
        'panel.unplacedSome': '{n} of {total} marks have no number — the page moved under them.',
        'panel.unplacedAll': '{n} mark(s) could not be placed on the page.',
      },
      zh: {
        'tab.title': '标注',
        'tab.description': '在运行中的应用里选取元素，附加到下一条消息。',
        'panel.title': '标注',
        'panel.mark': '选取',
        'panel.marking': '选取中…',
        'panel.markHint': '点击页面元素即可标注，备注可选填。',
        'panel.stop': '停止',
        'panel.stopHint': '退出选取，页面恢复正常点击',
        'panel.empty': '暂无标注。点击「选取」，然后在预览中点选一个元素。',
        'panel.emptyShort': '暂无标注 —— 点击「选取」，再点选页面上的一个元素。',
        'panel.listTitle': '已附加到下一条消息',
        'panel.listShort': '已标注',
        'panel.listUnit': '项已附加',
        'panel.pageUnknown': '未记录页面',
        'panel.close': '关闭',
        'panel.tabClose': '关闭这个页面',
        'panel.tabNew': '再开一个页面',
        'panel.tabDraft': '新标签页',
        'panel.tabDraftHint': '输入地址后按回车',
        'panel.tabDraftCancel': '放弃这个新标签页',
        'panel.tabLimit': '再开一个会关掉最早的 —— 同时最多 {n} 个',
        'panel.tabEvicted': '已关掉最早打开的页面 —— 同时最多 {n} 个',
        'panel.fromClosed': '页面已关闭',
        'panel.kindMark': '标注',
        'panel.kindNote': '批注',
        'panel.edit': '编辑',
        'panel.remove': '移除',
        'panel.removeAll': '全部清除',
        'composer.capsuleLabel': '标注',
        'composer.capsuleUnit': '项已附加',
        'composer.capsuleHint': '作为上下文随下一条消息发送，不会插入到你输入的文字中。展开可查看明细。',
        'composer.capsuleExpand': '展开查看这批标注',
        'composer.capsuleCollapse': '收起',
        'composer.capsuleLoading': '正在读取…',
        'composer.capsuleEmpty': '这批标注还没有明细可显示。',
        'composer.capsuleFailed': '读取明细失败，标注本身仍在。',
        'chip.label': '批注',
        'chip.unit': '条随本条消息发出',
        'chip.hint': '本条消息附带的页面元素上下文，展开可查看明细。',
        'chip.page': '页面',
        'chip.empty': '本条消息没有附带批注。',
        'panel.cleared': '已清除全部标注。',
        'panel.clearFailed': '清除失败，标注保持不变。',
        'panel.open': '打开页面',
        'panel.detecting': '正在查找本地服务…',
        'panel.noServers': '未找到本地服务。请先启动一个，或从工作区打开页面。',
        'panel.pages': '工作区页面',
        'panel.serviceHtml': '网页',
        'panel.serviceJson': 'JSON 接口',
        'panel.serviceText': '纯文本',
        'panel.serviceUnknown': '未命名服务',
        'panel.discovered': '检测到的服务与页面',
        'panel.menu': '更多',
        'panel.refresh': '刷新页面',
        'panel.detectLong': '查找本地服务与页面',
        'panel.clearAll': '清除全部标注',
        'panel.cancel': '取消',
        'panel.accent': '标注颜色',
        'panel.accentHint': '同时作用于标注框、标记点和本面板',
        'panel.urlPlaceholder': 'http://localhost:5173 或工作区中的 .html 文件',
        'panel.go': '打开',
        'panel.frameHint': '若页面持续空白，可能是该应用拒绝被嵌入。',
        'panel.reload': '重新加载',
        'panel.notLocal': '当前版本仅支持 localhost 目标。',
        'panel.ready': '就绪',
        'panel.missing': '该元素已不在页面上。',
        'panel.unplacedSome': '{total} 项里有 {n} 项没有编号——页面结构变了。',
        'panel.unplacedAll': '{n} 项标注无法定位到页面元素。',
      },
    }

    function detectLang() {
      try {
        const value = document.documentElement.lang || navigator.language || 'en'
        return String(value).toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch (error) {
        void error
        return 'en'
      }
    }

    let lang = detectLang()
    const t = (key, vars) => {
      const table = CATALOG[lang] || CATALOG.en
      let text = table[key] || CATALOG.en[key] || key
      if (vars) {
        for (const name of Object.keys(vars)) text = text.split(`{${name}}`).join(String(vars[name]))
      }
      return text
    }

    // ----------------------------------------------------------------- styles

    const CSS = `
/* Type scale and controls follow the harness shell: a system stack at 13px for
   body copy, 12px for controls, and one accent that matches the overlay marker
   so the panel and the page read as the same tool. */
/* ------------------------------------------------------------- surfaces
   Two neutral layers, so the toolbar reads as chrome and the page reads as
   content. The shell already names these, and matching it means the panel does
   not fight the surrounding UI for the reader's attention. */
.dsa-panel{--dsa-surface:var(--dsw-alias-bg-layer-1,transparent);--dsa-chrome:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.06));--dsa-hair:var(--dsw-alias-border-l2-darkmode-thin,rgba(128,128,128,.28));--dsa-hover:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));display:flex;flex-direction:column;gap:8px;padding:8px;font:13px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:inherit;height:100%;box-sizing:border-box;overflow:hidden;min-height:0;-webkit-font-smoothing:antialiased}
/* The toolbar is one row that never wraps. It used to wrap, and a wrapped
   toolbar is how a 28px control turns into a 90px block on a narrow sidebar. */
.dsa-bar{display:flex;gap:4px;align-items:center;flex:0 0 auto;min-width:0}
.dsa-btn{font:500 12px/1 inherit;padding:0 10px;height:28px;display:inline-flex;align-items:center;gap:5px;border-radius:7px;border:1px solid var(--dsa-hair);background:transparent;color:inherit;cursor:pointer;transition:background .15s cubic-bezier(.22,1,.36,1),border-color .15s cubic-bezier(.22,1,.36,1);white-space:nowrap;flex:0 0 auto}
.dsa-btn:hover:not(:disabled){background:var(--dsa-hover);border-color:rgba(128,128,128,.5)}
.dsa-btn:active:not(:disabled){background:rgba(128,128,128,.2)}
.dsa-btn:focus-visible{outline:2px solid var(--dsa-accent);outline-offset:1px}
.dsa-btn:disabled{opacity:.4;cursor:not-allowed}
/* The one filled control in the panel: the action the reader came to take. */
.dsa-btn[data-primary]{background:var(--dsa-accent);border-color:var(--dsa-accent);color:#fff;font-weight:600}
.dsa-btn[data-primary]:hover:not(:disabled){filter:brightness(1.06);background:var(--dsa-accent);border-color:var(--dsa-accent)}
.dsa-btn[data-primary]:disabled{filter:grayscale(.6)}
.dsa-btn[data-on]{background:var(--dsa-accent-soft);border-color:var(--dsa-accent);color:var(--dsa-accent-ink)}
.dsa-icon-btn{width:28px;padding:0;justify-content:center}
.dsa-btn svg{flex:0 0 auto}
/* The address bar is the only text input on the toolbar, so it takes the slack. */
.dsa-open{display:flex;gap:4px;flex:1 1 auto;min-width:0}
.dsa-open input{flex:1 1 auto;min-width:0;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;height:28px;box-sizing:border-box;padding:0 9px;border-radius:7px;border:1px solid var(--dsa-hair);background:var(--dsa-chrome);color:inherit;transition:border-color .15s cubic-bezier(.22,1,.36,1)}
.dsa-open input::placeholder{color:inherit;opacity:.45}
.dsa-open input:focus{outline:2px solid var(--dsa-accent);outline-offset:-1px;border-color:transparent;background:transparent}
/* The address bar lives IN the toolbar, between the marking controls and the page
   actions, where it takes the slab of width a toolbar otherwise leaves empty.
   It used to be a row of its own directly under the tab strip, which made the two
   read as one unit: the reader asked for the tabs and the address to be separate
   things, one group plus one bar. It is separate now — a different row entirely.
   It stays the row's slack-taker (the one exception to the size-capped rows below),
   because an address that truncates is still readable while an address bar that
   cannot grow is not. */
.dsa-open-wrap{display:flex;gap:4px;align-items:center;flex:1 1 auto;min-width:0}
.dsa-loc{display:inline-flex;align-items:center;gap:5px;height:28px;max-width:100%;min-width:0;padding:0 8px;border-radius:7px;border:1px solid transparent;background:var(--dsa-chrome);color:inherit;cursor:pointer;font:12px/1 inherit;flex:1 1 auto;transition:background .15s cubic-bezier(.22,1,.36,1),border-color .15s cubic-bezier(.22,1,.36,1)}
.dsa-loc:hover{background:var(--dsa-hover);border-color:var(--dsa-hair)}
.dsa-loc:focus-visible{outline:2px solid var(--dsa-accent);outline-offset:1px}
/* Truncated from the left, because the route is at the END of the address and
   the route is what identifies the page: two views of one app share a host and
   a path prefix and differ only in their tail. Clipping the right would leave
   "http://10.0.0.7:81/guicomm/#/..." for every page in the app — the same
   string the reader complained about, just longer.
   The rtl direction is what makes the ellipsis land on the left; it reorders the
   glyphs of mixed-direction text, so the address is wrapped in an LTR isolate
   below to keep the characters themselves in reading order. */
.dsa-loc-host{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;opacity:.8}
/* ------------------------------------------------------------ the menu */
.dsa-menu-wrap{position:relative;flex:0 0 auto}
.dsa-menu{position:absolute;right:0;top:calc(100% + 5px);z-index:30;min-width:224px;max-width:min(300px,88vw);background:var(--dsw-specific-menu,#fff);border:1px solid var(--dsa-hair);border-radius:10px;padding:4px;box-shadow:0 10px 28px rgba(0,0,0,.2),0 2px 6px rgba(0,0,0,.1);animation:dsa-pop .13s cubic-bezier(.22,1,.36,1)}
@keyframes dsa-pop{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
.dsa-menu-row{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:7px 8px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:12px/1.3 inherit;text-align:left;transition:background .12s cubic-bezier(.22,1,.36,1)}
.dsa-menu-row:hover:not(:disabled){background:var(--dsa-hover)}
.dsa-menu-row:focus-visible{outline:2px solid var(--dsa-accent);outline-offset:-2px}
.dsa-menu-row:disabled{opacity:.5;cursor:default}
.dsa-menu-row svg{opacity:.7;flex:0 0 auto}
.dsa-menu-sep{height:1px;margin:4px 6px;background:var(--dsa-hair)}
.dsa-menu-block{padding:6px 8px 8px}
.dsa-menu-label{display:block;font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;opacity:.5;margin-bottom:6px}
/* The discovered list is the one thing here that needs room, so it is the one
   thing that scrolls rather than pushing the menu past the viewport. */
.dsa-menu-scroll{max-height:38vh;overflow:auto;margin:0 -4px}
.dsa-spin{animation:dsa-rotate .9s linear infinite}
@keyframes dsa-rotate{to{transform:rotate(360deg)}}
/* The preview is the point of this panel, so it takes the space. Everything
   else is capped: the sidebar is narrow, and a full-height stack of picker and
   list rows used to leave the page itself a few pixels tall. */
.dsa-frame{position:relative;flex:1 1 auto;min-height:120px;border-radius:8px;overflow:hidden;border:1px solid var(--dsa-hair);background:var(--dsa-surface)}
.dsa-frame iframe{width:100%;height:100%;border:0;display:block}
/* Every open page stays mounted, and the ones behind are hidden. This rule is load
   bearing rather than cosmetic: the display:block above outranks the user agent's
   own [hidden]{display:none}, so without it a hidden page would still be laid out
   on top of the visible one and the reader would see the wrong document. */
.dsa-frame iframe[hidden]{display:none}
/* The tab strip, drawn the way a browser draws one: a baseline the tabs stand on,
   every tab the same width, and the selected tab visibly joined to the page below.
   The three things the reader asked for are the three rules here — a real border on
   every tab, an unmistakable selected state, and equal widths.
   Equal width is flex:1 1 0 on the tab: a basis of 0 means the free space is
   split evenly, so the tabs divide the sidebar instead of sizing to their labels. */
.dsa-tabs{display:flex;align-items:flex-end;gap:3px;flex:0 0 auto;margin:0;padding:0;border-bottom:1px solid var(--dsa-hair)}
.dsa-tab{position:relative;display:flex;align-items:center;gap:2px;flex:1 1 0;min-width:0;height:25px;box-sizing:border-box;border:1px solid var(--dsa-hair);border-bottom:0;border-radius:8px 8px 0 0;background:transparent;color:inherit;margin-bottom:-1px;transition:background .15s cubic-bezier(.22,1,.36,1),opacity .15s cubic-bezier(.22,1,.36,1)}
/* Unselected tabs are dimmed as a whole rather than by label colour alone, so the
   contrast with the selected one survives whatever the shell's palette is. */
.dsa-tab:not([data-on]){opacity:.72}
.dsa-tab:not([data-on]):hover{opacity:1;background:var(--dsa-hover)}
/* The selected tab is the one joined to the page below: it carries the chrome
   colour, gives up its bottom border to the baseline, and gets an accent bar along
   its top edge — legible at a glance in both light and dark palettes. */
.dsa-tab[data-on]{background:var(--dsa-chrome);box-shadow:inset 0 2px 0 0 var(--dsa-accent)}
.dsa-tab-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;background:none;border:0;color:inherit;font:inherit;font-size:11px;padding:0 2px 0 8px;cursor:pointer}
.dsa-tab[data-on] .dsa-tab-name{font-weight:600}
.dsa-tab-x{flex:0 0 auto;display:flex;align-items:center;justify-content:center;background:none;border:0;color:inherit;opacity:.55;padding:3px 5px;margin-right:2px;cursor:pointer;border-radius:5px}
.dsa-tab-x:hover{opacity:1;background:var(--dsa-hair)}
/* A tab with no address yet. Dashed, so an empty tab cannot be mistaken for a
   loaded one whose label happens to be hidden. */
.dsa-tab-draft{border-style:dashed;cursor:default}
.dsa-tab-draft .dsa-tab-name{opacity:.7;font-style:italic;cursor:default}
.dsa-tab-new{flex:0 0 auto;display:flex;align-items:center;justify-content:center;align-self:flex-end;width:25px;height:25px;box-sizing:border-box;background:none;border:1px solid transparent;color:inherit;opacity:.65;padding:0;margin-bottom:-1px;cursor:pointer;border-radius:8px 8px 0 0}
.dsa-tab-new:hover{opacity:1;background:var(--dsa-hover);border-color:var(--dsa-hair)}
.dsa-hint{font-size:11px;opacity:.6;margin:0;flex:0 0 auto}
.dsa-hint[data-center]{text-align:center;padding:10px 4px}
/* The empty frame keeps the preview's footprint so the panel does not reflow the
   moment a page opens: the reader learns the layout once. */
.dsa-empty-frame{display:flex;align-items:center;justify-content:center;background:transparent;border-style:dashed}
.dsa-empty-frame .dsa-hint{max-width:34ch;line-height:1.6}
/* Says out loud that the count and the numbers disagree.
   It used to disagree silently: the toolbar counted the list, the page drew what it
   could place, and a missing number looked like a bug in the counting rather than a
   page that had moved. Amber rather than the reader's accent, because this is a
   condition to notice, not a state they chose. */
.dsa-warn{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;font-size:11px;line-height:1.4;color:#8a5a00;background:rgba(240,170,40,.14);border:1px solid rgba(240,170,40,.4)}
.dsa-warn svg{flex:none;opacity:.85}
.dsa-warn span{min-width:0}
/* The accent swatches, shown inside the menu. */
.dsa-swatches{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
/* Marked elements live behind a counter in the toolbar, not in a panel that
   steals the page's height. The expanded list overlays the preview, so opening
   it never resizes the frame. */
.dsa-count{position:relative;flex:0 0 auto}
.dsa-count>summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:6px;font:500 12px/1 inherit;height:28px;box-sizing:border-box;padding:0 9px;border-radius:7px;border:1px solid var(--dsa-hair);transition:background .15s cubic-bezier(.22,1,.36,1),border-color .15s cubic-bezier(.22,1,.36,1)}
.dsa-count>summary::-webkit-details-marker{display:none}
.dsa-count>summary:hover{background:var(--dsa-hover)}
.dsa-count>summary:focus-visible{outline:2px solid var(--dsa-accent);outline-offset:1px}
.dsa-count[open]>summary{background:var(--dsa-accent-soft);border-color:var(--dsa-accent)}
.dsa-count-badge{background:var(--dsa-accent);color:#fff;font-weight:600;font-size:11px;font-variant-numeric:tabular-nums;border-radius:9px;min-width:18px;height:18px;display:flex;align-items:center;justify-content:center;padding:0 5px}
/* The list opens from the toolbar and must stay inside the sidebar column.
 *
 * It used to be 'right:0' with 'z-index:20', which anchored it to the button and
 * then let the conversation behind it paint over the top: the sidebar panel is
 * inside the shell's own stacking context, so a z-index that wins locally still
 * loses to the chat column, and widening the sidebar changed nothing because the
 * element was never being clipped by width in the first place — it was simply
 * underneath.
 *
 * 'position:fixed' with an explicit inset puts it above every sibling in the
 * document regardless of the ancestors' stacking contexts, and centring it in the
 * viewport means it can no longer be half-covered by an adjacent column. The
 * trade-off is that it no longer tracks the button, which is fine: it is a
 * deliberate, dismissable surface rather than a menu. */
.dsa-count-body{position:fixed;z-index:2147483000;top:50%;left:50%;transform:translate(-50%,-50%);width:min(360px,calc(100vw - 32px));max-height:min(70vh,520px);overflow:hidden;display:flex;flex-direction:column;background:var(--dsw-specific-menu,#fff);color:inherit;border:1px solid var(--dsa-hair);border-radius:12px;padding:10px;box-shadow:0 18px 48px rgba(0,0,0,.3),0 3px 10px rgba(0,0,0,.16)}
/* The list scrolls; the action bar does not.
   The body used to be one scrolling column, so 全部清除 sat under the last row
   and a long list pushed it below the fold — present, but only after a scroll
   the reader had no reason to make, which is why it read as missing. Pinning it
   costs the list a few pixels of height and makes the destructive action
   findable at any list length. */
.dsa-count-main{display:flex;flex-direction:column;gap:8px;min-height:0;flex:1 1 auto}
.dsa-count-main .dsa-list{overflow:auto;min-height:0;flex:0 1 auto}
.dsa-count-main .dsa-bar{flex:0 0 auto;border-top:1px solid var(--dsa-hair);padding-top:8px}
/* Full width, because it is the only control in this bar and a half-width
   destructive button next to empty space reads as secondary. */
.dsa-count-main .dsa-bar .dsa-btn{flex:1 1 auto;justify-content:center}
/* A backdrop, so the surface reads as modal and a click anywhere dismisses it.
   Without it a fixed panel over a live page is ambiguous: the reader cannot tell
   whether a click will go to the panel or to the page behind. */
.dsa-count-scrim{position:fixed;inset:0;z-index:2147482999;background:rgba(0,0,0,.32);animation:dsa-fade .14s cubic-bezier(.22,1,.36,1)}
@keyframes dsa-fade{from{opacity:0}to{opacity:1}}
.dsa-count-head{display:flex;align-items:center;gap:8px;margin:0 0 8px}
.dsa-count-title{font-size:12px;font-weight:600;margin:0;flex:1 1 auto}
.dsa-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.dsa-item{display:flex;gap:8px;padding:7px 8px;border-radius:7px;border:1px solid rgba(128,128,128,.28);align-items:flex-start;cursor:default}
.dsa-item:hover{border-color:var(--dsa-accent,#f0a05a)}
.dsa-num{flex:0 0 20px;height:20px;border-radius:50% 50% 50% 2px;background:var(--dsa-accent,#f0a05a);color:#fff;font:600 11px/20px system-ui,sans-serif;text-align:center}
.dsa-num[data-kind="mark"]{background:#7f8c9b}
.dsa-body{flex:1;min-width:0}
.dsa-line{display:flex;gap:6px;align-items:baseline}
.dsa-kind{font-size:10px;font-weight:600;padding:1px 5px;border-radius:3px;background:var(--dsa-accent,#f0a05a);color:#fff;flex:0 0 auto}
.dsa-kind[data-kind="mark"]{background:#7f8c9b}
.dsa-sel{font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.72;word-break:break-all;margin:0}
.dsa-note{margin:3px 0 0;white-space:pre-wrap;word-break:break-word}
.dsa-note[data-empty]{opacity:.5;font-style:italic}
/* The page heading inside the list. It is the boundary the numbers restart at, so
   it has to read as a heading rather than as a caption: the previous version was a
   10px dim line under each row, and the reader's words were "it is there but not
   obvious enough". Sticky, so a long group keeps saying which page it belongs to
   while it is being scrolled. */
.dsa-group{position:sticky;top:0;z-index:1;display:flex;align-items:baseline;gap:6px;padding:5px 8px 4px;margin:2px 0 0;background-color:var(--dsw-specific-menu,#fff);border-bottom:1px solid rgba(128,128,128,.28)}
.dsa-group:first-child{margin-top:0}
.dsa-group-page{font:600 11px/1.3 system-ui,sans-serif;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;word-break:break-all}
.dsa-group-count{font:600 10px/1.3 system-ui,sans-serif;font-variant-numeric:tabular-nums;color:#fff;background:var(--dsa-accent,#f0a05a);border-radius:8px;padding:1px 6px;flex:0 0 auto}
.dsa-item-actions{display:flex;flex-direction:column;gap:3px}
.dsa-mini{font:12px/1 inherit;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;border:1px solid transparent;background:transparent;color:inherit;cursor:pointer;opacity:.62;transition:background .12s ease,opacity .12s ease}
.dsa-mini:hover{background:rgba(128,128,128,.16);opacity:1}
.dsa-mini:focus-visible{outline:2px solid var(--dsa-accent,#f0a05a);outline-offset:1px;opacity:1}
/* ------------------------------------------------------------------ accent
   One custom property drives every accent surface, so the reader's chosen colour
   reaches the capsule, the panel, the marks and the pins together instead of
   being re-specified (and missed) in each rule.

   Stored as HSL channels rather than a finished colour so the same value feeds
   the opaque fill, the soft tint and the border ring at once; changing the hue
   keeps all three in step. The --dsa-* custom properties are written to the
   document element by JS, so the capsule (composer dock) and the panel (right
   sidebar) share one accent even though they are contributed to different slots. */
/* The accent, derived once on the document root.
 *
 * These MUST be on the root selector and not on a plugin-local wrapper. They were
 * on a '.dsa-root' class that nothing ever applies, so 'var(--dsa-accent-soft)'
 * resolved to nothing in every rule that used it. A single invalid 'var()' makes
 * the WHOLE declaration invalid at computed-value time, so the capsule silently
 * fell back to its plain 'background-color' and a default border: an opaque white
 * pill, which is exactly what the reader saw. Nothing errors; the colour just is
 * not there.
 *
 * ':root' also puts them in scope for both halves of the plugin, which live in
 * different DOM branches — the capsule in the composer dock and the panel in the
 * right sidebar — and that is the reason they need to be shared at all.
 *
 * Only the channels are written by JS; the derived colours are computed here so
 * one value feeds the fill, the tint and the ring together. */
:root{--dsa-h:32;--dsa-s:88%;--dsa-l:65%;--dsa-accent:hsl(var(--dsa-h) var(--dsa-s) var(--dsa-l));--dsa-accent-soft:hsl(var(--dsa-h) var(--dsa-s) var(--dsa-l) / .22);--dsa-accent-line:hsl(var(--dsa-h) var(--dsa-s) var(--dsa-l) / .55);--dsa-accent-ink:hsl(var(--dsa-h) calc(var(--dsa-s) * .9) 26%)}
/* The ink's lightness is FIXED while the preset's is not.
   Deriving it from the preset made the readable range depend on which preset was
   chosen: 青竹 at 45% lightness produced 4.23:1 against its own tint, under the
   4.5:1 AA floor, while 紫藤 managed 9.45:1. Immovable lightness with only the hue
   and saturation carried over puts every preset between 5.8:1 and 11.2:1, so the
   contrast no longer varies with the reader's choice.
   Dark mode inverts the same way: the surface darkens, so the ink lightens. */
.dsa-capsule[data-dark="true"]{--dsa-accent-ink:hsl(var(--dsa-h) calc(var(--dsa-s) * .8) 80%)}
/* A swatch row for the accent setting. */
.dsa-swatches{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.dsa-swatch{width:20px;height:20px;border-radius:50%;border:1px solid rgba(128,128,128,.35);cursor:pointer;padding:0;background:none;position:relative}
.dsa-swatch i{position:absolute;inset:2px;border-radius:50%;display:block}
.dsa-swatch[data-on="true"]{border-color:currentColor;box-shadow:0 0 0 1px currentColor}
.dsa-swatch:focus-visible{outline:2px solid var(--dsa-accent,#f0a05a);outline-offset:2px}
.dsa-accent-row{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:2px 0}
.dsa-toast{font-size:12px;padding:7px 10px;border-radius:7px;background:rgba(128,128,128,.16);flex:0 0 auto}
/* The capsule floats over the transcript, so its surface must be OPAQUE — but
   opaque must not mean colourless.

   Two faults in a row, in opposite directions. It began as a 13% tint over
   whatever was behind it, so the transcript showed through the pill. That was
   fixed by swapping in the shell's neutral elevated surface, which solved the
   see-through but left a plain white pill indistinguishable from the messages
   around it — it stopped looking like an annotation at all.

   The surface is now the theme's opaque layer with the accent laid over it as a
   gradient. A gradient rather than a flat translucent accent: the tint has to sit
   ON an opaque base, and blending the two would need a colour function that not
   every supported browser has. Layering keeps the base doing the covering and
   the accent doing the tinting, so the pill stays readable and stays coloured in
   both themes without my guessing a hex for each. */
.dsa-capsule-host{display:flex;flex-direction:column;align-items:center;gap:6px;flex:none;width:100%;min-width:0}
/* The pill centres itself in the strip; once open, the detail hangs under it. The
   host owns the centring now that there is a second element to place, which is why
   the alignment is here and not on the pill. */
.dsa-capsule{align-self:center;flex:none;display:inline-flex;align-items:center;gap:6px;max-width:min(100%,420px);padding:3px 10px 3px 8px;border-radius:999px;background-image:linear-gradient(var(--dsa-accent-soft),var(--dsa-accent-soft));background-color:var(--dsw-specific-menu,#fff);border:1px solid var(--dsa-accent-line);box-shadow:0 1px 3px rgba(0,0,0,.08);font-family:inherit;font-size:11px;line-height:1.5;color:inherit;box-sizing:border-box;cursor:pointer}
.dsa-capsule:hover{border-color:var(--dsa-accent)}
.dsa-capsule:focus-visible{outline:2px solid var(--dsa-accent);outline-offset:2px}
.dsa-capsule-caret{opacity:.6;font-size:9px;line-height:1}
/* The open detail, on the shell's opaque raised surface rather than a bare list:
   the strip sits directly above the composer, so anything unpainted there lets the
   input card show through and the rows stop reading as one panel. */
.dsa-capsule-host--open .dsa-capsule-list{margin-top:2px}
/* Deliberately two classes rather than one. The rows themselves are the SHARED
   dsa-chip-list (the chip under a sent message renders the identical list), and
   that rule comes later in this sheet — so a single-class override here would lose
   on source order and silently keep the chip's flat left-border treatment. The
   extra class states the dependency instead of relying on where the rule sits. */
.dsa-capsule-host .dsa-capsule-list{width:100%;max-width:min(100%,560px);box-sizing:border-box;margin:0;padding:9px 12px 10px 10px;border:1px solid var(--dsa-accent-line);border-radius:12px;background-color:var(--dsw-specific-menu,#fff);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.dsa-capsule-note{font-size:11px;opacity:.72;padding:0 2px}
.dsa-capsule-dot{width:6px;height:6px;border-radius:50%;background:var(--dsa-accent);flex:0 0 auto}
/* The label carries the accent itself, so the pill reads as annotated even when
   the tint is subtle. Kept as a separate rule from the dot: the dot shows the
   colour, the text has to stay legible, and those want different treatments. */
.dsa-capsule-label{color:var(--dsa-accent-ink);white-space:nowrap;font-weight:500}
.dsa-capsule-count{font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsa-accent-ink)}
.dsa-capsule-unit{opacity:.72;white-space:nowrap}
/* The transcript chip: what a sent message carried, shown in the conversation
   under that message.

   It lands under the bubble's LEFT edge, which is where the reader pointed — and
   that edge takes measuring rather than a CSS keyword. The chip is a flow row of
   its own, a sibling of the reader's row, so its left edge is the COLUMN's left
   edge and NOT the bubble's: the bubble is content-sized and right-aligned inside
   its row, so its left edge moves with the text while the row's does not.
   Left-aligning without measuring is what parked the chip at the far side of the
   transcript, nowhere near the message it describes.

   The bubble's RIGHT edge, however, IS the row's (align-items: flex-end), so its
   width is the one measurement that yields its left edge, and the component sets
   that offset inline (see chipIndent). These rules are the default and the
   fallback: with no measurement the row right-aligns, which reads as "under the
   bubble" and never as "across the transcript".

   It reuses the capsule's accent vocabulary on purpose: the same mark appears
   in the composer before sending and here after, and one colour is what ties
   the two halves of that story together. The surface repeats the capsule's
   trick — the theme's opaque menu layer with the accent laid over it as a
   gradient — so it stays readable in both themes without a hand-picked hex. */
.dsa-chip-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
/* The measured placement: the chip sits a fixed distance in from the row's left
   edge, which IS the column's, so it lands under the bubble's left edge. */
.dsa-chip-row--indent{align-items:flex-start}
.dsa-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px 3px 8px;border-radius:999px;background-image:linear-gradient(var(--dsa-accent-soft),var(--dsa-accent-soft));background-color:var(--dsw-specific-menu,#fff);border:1px solid var(--dsa-accent-line);box-shadow:0 1px 3px rgba(0,0,0,.08);font-family:inherit;font-size:11px;line-height:1.5;color:inherit;box-sizing:border-box;cursor:pointer;user-select:none}
.dsa-chip:hover{border-color:var(--dsa-accent)}
.dsa-chip:focus-visible{outline:2px solid var(--dsa-accent);outline-offset:2px}
/* Same inversion as the capsule, and for the same reason: the surface darkens,
   so the ink has to lighten, while the hue stays the reader's choice. */
.dsa-chip[data-dark="true"]{--dsa-accent-ink:hsl(var(--dsa-h) calc(var(--dsa-s) * .8) 80%)}
.dsa-chip-dot{width:6px;height:6px;border-radius:50%;background:var(--dsa-accent);flex:0 0 auto}
.dsa-chip-label{color:var(--dsa-accent-ink);font-weight:500;white-space:nowrap}
.dsa-chip-count{font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsa-accent-ink)}
.dsa-chip-caret{opacity:.6;font-size:9px;line-height:1}
.dsa-chip-list{margin:0;padding:0 0 0 10px;list-style:none;display:flex;flex-direction:column;gap:7px;border-left:2px solid var(--dsa-accent-line);max-width:min(100%,560px)}
.dsa-chip-item{display:flex;gap:7px;font-size:12px;line-height:1.55;align-items:baseline}
.dsa-chip-num{flex:0 0 auto;font-size:10px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsa-accent-ink);min-width:14px}
.dsa-chip-body{min-width:0;display:flex;flex-direction:column;gap:1px}
/* The selector is the one field the reader may want to copy, so it keeps the
   code face and the sharper ink; the note is prose and stays at full opacity,
   while the element's own text is evidence and is clamped to two lines. */
.dsa-chip-sel{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:11px;opacity:.9;word-break:break-all}
.dsa-chip-note{opacity:.85;white-space:pre-wrap;word-break:break-word}
.dsa-chip-text{opacity:.6;font-size:11px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dsa-chip-page{font-size:10px;opacity:.55;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);word-break:break-all}
.dsa-servers{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.dsa-server{display:flex;gap:6px;align-items:center;font-size:12px}
.dsa-server button{flex:1;min-width:0;text-align:left;font:12px/1.4 inherit;padding:5px 8px;border-radius:6px;border:1px solid rgba(128,128,128,.3);background:transparent;color:inherit;cursor:pointer;display:flex;gap:6px;align-items:center}
.dsa-server button:hover{background:rgba(128,128,128,.12)}
.dsa-server-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-tag{flex:0 0 auto;font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(128,128,128,.16);opacity:.85}
.dsa-server button:hover{border-color:var(--dsa-accent,#f0a05a)}
.dsa-server code{font:11px/1 ui-monospace,monospace;opacity:.6;flex:0 0 auto}
/* The entry path, for a service that does not answer at the root. */
.dsa-path{font:11px/1 ui-monospace,monospace;opacity:.5;flex:0 0 auto;max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsa-empty{opacity:.6;padding:14px 4px;text-align:center;font-size:12px}
`

    let stylesInjected = false
    function injectStyles() {
      if (stylesInjected || typeof document === 'undefined') return
      stylesInjected = true
      const tag = document.createElement('style')
      tag.setAttribute('data-dsh-annotate', '')
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ------------------------------------------------------- composer bridge

    /**
     * The sidebar tab slot hands a component only session identity and
     * projection — no composer access. The draft lives behind the
     * `conversation.composer.dock` slot, whose owner passes the input actions down.
     *
     * So a tiny component rides in that dock. It publishes the composer's own
     * draft access into this module-level box, which the tab reads when the user
     * asks to attach — and it shows the capsule, so the composer itself says what
     * is waiting to go out. Without that the only evidence was a toast in the
     * sidebar, which cannot be told apart from a report that never arrived.
     *
     * Keyed by session id, because a dock is mounted per session and the sidebar
     * may be showing a different one.
     */
    const composerBridge = new Map()

    /**
     * A reset channel from the dock to the sidebar, keyed by session.
     *
     * The host drops the annotations when the turn that carried them ends, and the
     * sidebar is never told. That left the two sides disagreeing: the host had
     * nothing, the panel still listed every mark, and any re-report — a remount, a
     * re-render whose effect re-runs — uploaded the same list again straight after
     * the host had cleared it. The capsule watches the host, so it is the half that
     * knows, and it uses this to tell the panel to let go.
     */
    const panelReset = new Map()

    /**
     * The last clear-epoch each session was seen at.
     *
     * Module-level rather than a ref inside the capsule, because the capsule is
     * remounted whenever the composer is: a fresh ref would take the current
     * epoch as its baseline and the clear that happened while it was away would
     * never be announced. The panel would keep a list the host had already let go
     * of — the same disagreement the reset channel exists to end — and its next
     * report would upload those marks straight back.
     */
    const hostEpoch = new Map()

    /**
     * One annotation, rendered as one row.
     *
     * Shared by the two places a reader can ask "what does this batch actually
     * carry" — the composer capsule before sending, and the chip under a message
     * after. They show the same thing because they ARE the same thing: the marks
     * still held, and the marks that went out with a turn. Two renderers would drift
     * into disagreeing about a field or its order, and that disagreement would be
     * invisible until a reader compared the two surfaces.
     *
     * The number is the mark's row WITHIN ITS PAGE, which is the number the sidebar
     * prints and the number the pin on that page wears. It is deliberately not the
     * row in this batch: with marks on two pages a batch-wide 1..n cannot match
     * either page, because each page only ever sees its own marks and counts from 1.
     * Rows are grouped by page for the same reason the panel groups them, so the two
     * surfaces list the same marks in the same order.
     *
     * @param items - already filtered; an entry with no field at all is omitted.
     * @param extraClass - layout modifier for the container, or '' for the plain one.
     */
    function annotationDetail(items, extraClass) {
      const numbered = []
      pageGroups(Array.isArray(items) ? items : []).forEach((group) => {
        group.items.forEach((item, index) => numbered.push({ item, number: index + 1 }))
      })
      return React.createElement(
        'ul',
        { className: extraClass ? `dsa-chip-list ${extraClass}` : 'dsa-chip-list' },
        numbered.map(({ item, number }, index) => React.createElement(
          'li',
          { className: 'dsa-chip-item', key: `i${index}` },
          React.createElement('span', { className: 'dsa-chip-num' }, String(number)),
          React.createElement(
            'div',
            { className: 'dsa-chip-body' },
            // Selector first: it is the field that identifies the element, and the
            // one a reader is most likely to copy.
            item.selector && React.createElement('code', { className: 'dsa-chip-sel' }, item.selector),
            // Then the note, which is the only part the reader wrote and therefore
            // the part they are actually looking for.
            item.note && React.createElement('span', { className: 'dsa-chip-note' }, item.note),
            // The element's own text is evidence, not a request, so it stays quiet.
            item.text && React.createElement('span', { className: 'dsa-chip-text' }, item.text),
            item.page && React.createElement('span', { className: 'dsa-chip-page' }, `${t('chip.page')}: ${item.page}`),
          ),
        )),
      )
    }

    /**
     * The attachment indicator, rendered in the dock ABOVE the composer card.
     *
     * `conversation.input.dock` is the slot the DSH shell documents as "full-width
     * entries above the composer card" (ConversationRoot.tsx:350, confirmed by
     * `.composerStack` being `flex-direction: column`), and it is where the shipped
     * todo and queue docks live. This earlier used `conversation.composer.dock`,
     * which renders *below* the card — hence the indicator appearing under the
     * composer rather than above it.
     *
     * The count is read from the host rather than pushed by the sidebar. The
     * sidebar can be closed, remounted, or showing another session, and a pushed
     * number would then be stale or absent while the annotations were still very
     * much pending. The host is the single source of truth, so the indicator asks
     * it directly and appears as soon as anything is marked — no click required.
     */
    function AnnotationCapsule(props) {
      // The dock passes `{ session, input }`; other hosts may pass only identity.
      const zone = props.zone || props
      const sessionId = props.sessionId
        || (zone.session && zone.session.id)
        || (props.injected && props.injected.sessionId)
      const useInput = props.useInput || (props.injected && props.injected.useInput)
      const inputActions = props.inputActions || (props.injected && props.injected.inputActions)
      const draft = useInput ? useInput((state) => state.draft) : undefined
      const [count, setCount] = React.useState(0)
      // The entries themselves, kept only while the reader has it open.
      //
      // The poll below already asks the host what it holds, and the host already
      // answers with the entries — it was throwing that answer away and keeping the
      // count. So opening this costs no request at all. They are not cached across
      // renders: closing drops them, because a stale list under a pill that has
      // since been re-counted would be the one thing worse than no list.
      const [items, setItems] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [failed, setFailed] = React.useState(false)

      // The sidebar has no composer access of its own, so it reaches the draft
      // through this handle. Keyed by session because a dock mounts per session.
      React.useEffect(() => {
        if (!sessionId) return undefined
        composerBridge.set(sessionId, {
          getDraft: () => String(draft || ''),
          setDraft: inputActions && inputActions.setDraft ? (value) => inputActions.setDraft(value) : null,
        })
        return () => {
          composerBridge.delete(sessionId)
        }
      }, [sessionId, draft, inputActions])

      // Polling rather than an event: the count is owned by the host and changes
      // for reasons this component is never told about — a turn consuming them, a
      // second tab marking something, the sidebar clearing them. A short interval
      // keeps the indicator honest without the plugin having to broadcast.
      //
      // The epoch is watched alongside the count for the opposite reason. When the
      // turn that carried the annotations ends, the host lets them go and the
      // sidebar is not told; the panel would go on listing marks the host no longer
      // has, and the next re-report would upload them straight back. The epoch is
      // how the panel hears about it.
      // Which poll's answer still matters.
      //
      // `setInterval` fires on a clock and `fetch` does not answer on one, so two
      // polls can be in flight at once and the OLDER answer can land last. That is
      // not a cosmetic race: the poll right after a send asks "how many are still
      // held", the host says 0 because the turn consumed them, and a straggler from
      // a second earlier then writes the pre-send count straight back. The reader
      // sees the capsule stay up after a message that already went out, and the
      // sidebar and the capsule disagree about a number the host has already
      // changed. Both were reported.
      //
      // So every response is stamped and only the newest one is allowed to write.
      // Dropping a stale answer is always right: a fresher one is already on its way
      // on the same 1s clock.
      const latestPoll = React.useRef(0)
      React.useEffect(() => {
        if (!sessionId) return undefined
        let live = true
        const read = async () => {
          const ticket = latestPoll.current + 1
          latestPoll.current = ticket
          try {
            const res = await fetch(`${API}/pending`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ session: sessionId }),
            })
            const data = await res.json()
            if (!live || !data || data.ok !== true) return
            // A newer poll has already reported, so this answer describes a state
            // the component has moved past. Writing it would be a regression.
            if (ticket !== latestPoll.current) return
            if (typeof data.count === 'number') {
              setCount((previous) => (previous === data.count ? previous : data.count))
            }
            // Kept in step with the count from the same answer, so an open list can
            // never describe a batch other than the one the pill is counting. A
            // reader cannot tell a stale list from a correct one by looking, which
            // makes this the field where being wrong is least detectable.
            if (Array.isArray(data.annotations)) {
              setItems(data.annotations)
              setFailed(false)
            }
            if (typeof data.epoch !== 'number') return
            const seen = hostEpoch.has(sessionId) ? hostEpoch.get(sessionId) : null
            hostEpoch.set(sessionId, data.epoch)
            // The first reading only establishes a baseline: acting on it would
            // purge the panel every time the dock remounts.
            if (seen !== null && data.epoch !== seen) {
              const reset = panelReset.get(sessionId)
              if (reset) reset()
            }
          } catch (error) {
            // Reported rather than swallowed: an open list that silently never
            // fills reads as "this batch is empty", which is a claim about the
            // reader's annotations and would be false.
            void error
            if (live) setFailed(true)
          }
        }
        void read()
        const timer = setInterval(read, 1000)
        return () => {
          live = false
          // Bumping past every ticket in flight, so an answer that arrives after
          // unmount cannot write into a dead component's state.
          latestPoll.current += 1
          clearInterval(timer)
        }
      }, [sessionId])

      if (!count) return null
      // The same filter the chip uses, so the two surfaces cannot count different
      // things: a malformed entry is dropped rather than counted and then not shown.
      const rows = (Array.isArray(items) ? items : []).filter((item) => (
        item && typeof item === 'object' && Boolean(item.selector || item.note || item.text)
      ))
      const caret = React.createElement(
        'span',
        { className: 'dsa-capsule-caret', 'aria-hidden': 'true' },
        open ? '▾' : '▸',
      )
      // A real button, not a div with a click handler: the pill is the only control
      // for its own detail, so it has to be reachable and operable from the keyboard
      // and it has to report its expanded state.
      const pill = React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsa-capsule',
          title: t('composer.capsuleHint'),
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': open ? t('composer.capsuleCollapse') : t('composer.capsuleExpand'),
          onClick: () => setOpen((value) => !value),
          // The accent's ink has to invert with the theme, and the dock renders in
          // whichever theme the shell is in. Read from the DOM rather than from a
          // media query so it follows the shell's own switch, which is not always
          // the OS setting.
          'data-dark': darkMode() ? 'true' : 'false',
        },
        React.createElement('span', { className: 'dsa-capsule-dot' }),
        React.createElement('span', { className: 'dsa-capsule-label' }, t('composer.capsuleLabel')),
        React.createElement('span', { className: 'dsa-capsule-count' }, String(count)),
        React.createElement('span', { className: 'dsa-capsule-unit' }, t('composer.capsuleUnit')),
        caret,
      )
      if (!open) return React.createElement('div', { className: 'dsa-capsule-host' }, pill)
      // The detail sits under the pill, inside the same dock entry, so it is part of
      // the strip above the composer rather than floating over the transcript.
      let detail
      if (failed) detail = React.createElement('div', { className: 'dsa-capsule-note' }, t('composer.capsuleFailed'))
      else if (!items) detail = React.createElement('div', { className: 'dsa-capsule-note' }, t('composer.capsuleLoading'))
      else if (!rows.length) detail = React.createElement('div', { className: 'dsa-capsule-note' }, t('composer.capsuleEmpty'))
      else detail = annotationDetail(rows, 'dsa-capsule-list')
      return React.createElement(
        'div',
        { className: 'dsa-capsule-host dsa-capsule-host--open' },
        pill,
        detail,
      )
    }

    // ------------------------------------------------- the transcript chip

    /**
     * Read the annotation block back out of the message that carried it.
     *
     * The chip needs the same facts the reader saw when they marked them, and
     * the only durable copy is the block the host appended for the model. So it
     * is parsed back rather than fetched: the transcript already holds it, which
     * means the chip needs no endpoint, no extra request, and no second source of
     * truth that could disagree with what the model was actually given.
     *
     * Two shapes are read, and both have to be, because a transcript outlives the
     * writer that produced it: a message sent before the block was grouped still
     * has the old one sitting in the conversation.
     *
     * - One page: `## Element N`, then `key: value` lines. No page is named.
     * - Several: `## <page>` per group, `### Element N` under it, and the element
     *   numbers restart per group.
     *
     * Every value is single-line by construction: the host clips each one through
     * `clip()`, which collapses whitespace before writing. So a line-oriented parse
     * is exact here rather than a simplification, and no continuation handling is
     * owed.
     *
     * `at` is deliberately not read. The host emits it only for a positional
     * selector that matched more than once, and it is geometry for the model to
     * disambiguate with — it means nothing next to a selector the reader is
     * already looking at.
     * @param content - the delivery message's content blocks.
     * @returns one entry per usable mark, in the order the host wrote them.
     */
    function parseAnnotationBlock(content) {
      const text = Array.isArray(content)
        ? content.map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('')
        : (typeof content === 'string' ? content : '')
      if (!text.includes('# Web page elements')) return []
      const items = []
      // The page a section belongs to. `page:` used to be a field of its own; it is
      // a heading now, so the field is only still read for blocks written before
      // that changed.
      let page = ''
      let fields = null
      const flush = () => {
        if (!fields) return
        const item = {
          selector: String(fields.selector || '').trim(),
          note: String(fields.note || '').trim(),
          text: String(fields.text || '').trim(),
          page: String(fields.page || page).trim(),
        }
        // The host gives a heading only to an element with a body, so a heading
        // carrying nothing readable is not one of ours.
        if (item.selector || item.note || item.text) items.push(item)
        fields = null
      }
      // Only the level-2 and level-3 headings are section starts. The block's own
      // top-level title is level 1 and is deliberately not matched here.
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        const heading = /^#{2,3}[ \t]+(.+)$/.exec(line)
        if (heading) {
          const title = heading[1].trim()
          flush()
          if (/^Element \d+$/.test(title)) fields = {}
          else page = title
          continue
        }
        if (!fields) continue
        const field = /^([a-z]+):[ \t]?(.*)$/.exec(line)
        if (field && field[2] !== '') fields[field[1]] = field[2]
      }
      flush()
      return items
    }

    /**
     * The element that holds the message this chip hangs under, or null.
     *
     * NOT `row.previousElementSibling`, which is the obvious guess and is always
     * null here. The shell wraps every transcript node in its own seat element
     * (`ChatNodeSeat` renders a div carrying `data-chat-anchor-key`), and the slot
     * occupant — this chip — is rendered INSIDE that div. So the chip's row has no
     * sibling at all, and the message is a sibling of the chip's own SEAT.
     *
     * Reaching for the seat rather than counting parents keeps this working if the
     * shell ever nests the occupant one level deeper: `closest` finds the nearest
     * ancestor that is a transcript node, whatever the depth.
     *
     * The attribute is the shell's own documented hook — `ChatNodeSeat` sets
     * `data-chat-anchor-key` on the element it wraps each node in — so this does not
     * depend on a hashed class name. With no such ancestor (a test harness, or a
     * different shell) it falls back to the row itself, whose sibling is then the
     * right thing to look at anyway.
     */
    function chipSeat(row) {
      if (!row || typeof row.closest !== 'function') return row || null
      return row.closest('[data-chat-anchor-key]') || row
    }

    /**
     * How far in from its row's left edge the chip has to sit to land under the
     * bubble's left edge.
     *
     * The arithmetic is only this simple because the row spans the whole column:
     * the reader's row is end-aligned, so the bubble's RIGHT edge is the column's
     * right edge, and therefore
     *
     *     bubbleLeft = columnRight - bubbleWidth = columnLeft + columnWidth - bubbleWidth
     *
     * so the indent from the row's left edge is `columnWidth - bubbleWidth` exactly.
     * That identity is also why the chip row carries no width cap of its own: a cap
     * would make the row's left edge, rather than the column's, the origin of the
     * offset, and the number would be silently wrong by however much was trimmed.
     *
     * `null` means "keep the stylesheet's right alignment": no measurement
     * (no layout engine, or a row that is not laid out yet), a message whose bubble
     * could not be found, or a bubble that already fills the column — in which case
     * the two alignments are the same thing anyway.
     *
     * Pulled out as a pure function on purpose. Every environment that runs the
     * checks has no layout engine — jsdom reports a zero rect for everything — so an
     * inline computation could only ever be exercised as `null`. As a function the
     * arithmetic is asserted directly, which is the part that can actually be wrong.
     */
    function chipIndent(rowWidth, bubbleWidth) {
      if (!(rowWidth > 0) || !(bubbleWidth > 0)) return null
      if (bubbleWidth >= rowWidth) return null
      const offset = Math.round(rowWidth - bubbleWidth)
      // A single pixel is not worth an inline style; it is indistinguishable from
      // the fallback and would only make the DOM noisier.
      return offset > 1 ? offset : null
    }

    /**
     * The row's props for a measured indent, or none when there is no measurement.
     *
     * Two things have to change together, which is why this is not a padding value
     * alone. While the row's items are aligned to the end, a left padding only
     * narrows the content box and the chip stays where it was — the padding has to
     * come WITH the alignment flip to move the chip inward at all. The alignment is
     * a mode and lives in the stylesheet; only the measured number is inline.
     */
    function rowProps(indent) {
      if (indent === null || indent === undefined) return { className: 'dsa-chip-row' }
      return {
        className: 'dsa-chip-row dsa-chip-row--indent',
        style: { paddingLeft: `${indent}px` },
      }
    }

    /**
     * What one sent message carried, shown under that message in the transcript.
     *
     * Placement is the whole design. It hangs off the reader's own bubble rather
     * than the context row, because that row is collapsed to a summary line and
     * the reader looking for "which of my messages carried annotations" is
     * looking at their message, not at a row labelled with a package name.
     *
     * It is aligned under the bubble's LEFT edge — where the reader pointed — and
     * reaches that edge by measuring, not by CSS.
     *
     * The chip is a sibling of the reader's row, so its own left edge is the
     * COLUMN's left edge, while the bubble is content-sized and sits at the end of
     * its row, so its left edge moves with the length of the text. Aligning left
     * without measuring is what parked the chip across the transcript, away from
     * the message it describes; that was reported from a real session.
     *
     * The bubble's RIGHT edge, by contrast, IS the row's (`align-items: flex-end`),
     * so its width is the one measurement that yields its left edge. The chip
     * carries that offset inline. Until there is a measurement — no layout engine,
     * or a row not yet laid out — the stylesheet's right alignment stands, which
     * degrades to "under the bubble" rather than "across the transcript".
     *
     * Collapsed by default and opened on a click. The marks are reference
     * material — usually one glance is all that is wanted, and a permanently
     * expanded list would push the reader's next message down the page for every
     * message that ever had a mark on it.
     */
    function AnnotationChip(props) {
      const data = props.node && props.node.data
      const raw = data && Array.isArray(data.items) ? data.items : []
      // Filtered once, up front, so the count and the list cannot disagree. A
      // malformed entry is dropped rather than counted: `×3` above a list of two
      // is worse than either showing two or showing nothing, because it is the one
      // outcome the reader cannot detect.
      const items = raw.filter((item) => (
        item && typeof item === 'object' && Boolean(item.selector || item.note || item.text)
      ))
      const [open, setOpen] = React.useState(false)
      // Under the bubble's own left edge, which is where the reader pointed.
      //
      // The offset is `chipIndent`, kept pure so its arithmetic is testable in an
      // environment with no layout at all — jsdom reports a zero rect for every
      // element, so an inline computation could only ever be exercised as `null`
      // there. The measurement below is the untestable half; it is deliberately
      // dumb, and depends on the bubble being the widest box that shares the row's
      // right edge.
      const [indent, setIndent] = React.useState(null)
      const rowRef = React.useRef(null)
      React.useLayoutEffect(() => {
        const row = rowRef.current
        if (!row) return undefined
        const measure = () => {
          // The SEAT, not the row: the chip renders inside the element the shell
          // wraps each transcript node in, so the row has no sibling to look at.
          const seat = chipSeat(row)
          const previous = seat ? seat.previousElementSibling : null
          if (!previous) return setIndent(null)
          const rowBox = row.getBoundingClientRect()
          if (!(rowBox.width > 0)) return setIndent(null)
          // The bubble is the widest box in the message above which still ends where
          // that row does: the reader's row is full width and end-aligned, so the
          // bubble shares its right edge, while the time/copy/fork row is both
          // narrower and further left. Matching on that edge rather than on a class
          // name matters — the shell's class names are hashed and private, so a
          // name-based lookup would not fail loudly on the next release, it would
          // quietly mis-place the chip.
          //
          // The row the bubble is measured against is the PREVIOUS seat's box, so
          // both edges come from the same coordinate space and no ancestor's padding
          // has to be reasoned about.
          const previousBox = previous.getBoundingClientRect()
          let widest = 0
          for (const element of previous.querySelectorAll('*')) {
            const box = element.getBoundingClientRect()
            if (!(box.width > 0)) continue
            if (Math.abs(box.right - previousBox.right) > 1) continue
            if (box.width > widest) widest = box.width
          }
          return setIndent(chipIndent(rowBox.width, widest))
        }
        measure()
        // Reflow moves the bubble's left edge, so the offset is stale until the
        // window is measured again. A resize is the cheap signal for that; getting
        // it slightly wrong leaves the chip at the wrong indent, never invisible.
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [open, items.length])
      // Nothing to say costs nothing: an empty flow row is display:none in the
      // shell's own stylesheet, so it takes no gap and no height.
      if (!items.length) return null
      const dark = darkMode() ? 'true' : 'false'
      const chip = React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsa-chip',
          'data-dark': dark,
          title: t('chip.hint'),
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((value) => !value),
        },
        React.createElement('span', { className: 'dsa-chip-dot' }),
        React.createElement('span', { className: 'dsa-chip-label' }, t('chip.label')),
        React.createElement('span', { className: 'dsa-chip-count' }, `×${items.length}`),
        React.createElement('span', { className: 'dsa-chip-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
      )
      if (!open) return React.createElement('div', Object.assign({ ref: rowRef }, rowProps(indent)), chip)
      // The same rows the composer capsule shows, from the shared renderer: the same
      // marks are being described before and after sending, so they must not be
      // described differently.
      const list = annotationDetail(items, '')
      return React.createElement('div', Object.assign({ ref: rowRef }, rowProps(indent)), chip, list)
    }

    /**
     * Register the chip as a second Conversation Definition.
     *
     * The annotations already arrive as their own transcript message, so the
     * chip is a view of an event that exists — not a new source of data. Matching
     * that one message and giving it a second view is what the Definition
     * registry exists for, and it needs no DOM decoration and no host change.
     *
     * Two details are load-bearing:
     *
     * - Only the host's own delivery message matches. The reader's message shares
     *   the type but is sourced `user`, and pairing the chip with it would put the
     *   annotations under a message that may carry none.
     * - The node is located `unresolved` and anchored half a seq before the
     *   delivery. An unresolved node is outside every Turn, which is what keeps
     *   it out of compact mode's process folding: that machinery only ever
     *   considers turn-located nodes, so a chip can neither be folded into a
     *   collapsed process block nor silently change whether that block offers its
     *   disclosure. The half-seq offset is the shell's own idiom for a synthetic
     *   neighbour (`CHAT_SYNTHETIC_SEQ_OFFSETS`), placing the chip after the
     *   reader's bubble (seq - 1) and before the context row (seq).
     * @param uiConversation - the injected conversation service.
     * @returns the registry's own disposer.
     */
    function registerChipDefinition(uiConversation) {
      return uiConversation.events.register({
        kind: CHIP_KIND,
        target: 'chat',
        match: (event) => (
          event.type === 'user/message'
          && event.surfaceOp === 'append'
          && event.data.source.kind === 'plugin'
          && event.data.source.plugin === KIND
        )
          ? { id: String(event.data.id), role: 'start' }
          : null,
        start: (context, match) => ({
          seq: match.event.seq,
          items: parseAnnotationBlock(match.event.data.content),
        }),
        update: (context) => context.state,
        buildViewNode: (context) => {
          const state = context.state
          if (!state || !state.items.length) return null
          return {
            key: context.key,
            kind: CHIP_KIND,
            id: context.id,
            target: 'chat',
            anchorSeq: state.seq - 0.5,
            location: { kind: 'unresolved' },
            visibility: 'visible',
            data: { seq: state.seq, items: state.items },
          }
        },
      })
    }

    // ------------------------------------------------------------ the payload

    /**
     * Marks grouped by the page they were taken on, in reading order within each.
     *
     * The page is the unit the reader thinks in, and it is also the only unit the
     * numbers can be made to agree on. A selector means nothing without the screen
     * it was read off, and document coordinates are measured in their own document
     * — so comparing two pages' `y` compares two different rulers. That is not a
     * detail. A reader who marks one page and then another watched the second mark
     * take the LOWER number whenever its element happened to sit higher in its own
     * page, so the list read backwards against the order the marks were made.
     * Groups are ordered by when each page was first marked instead, and only
     * inside a group do `y` and `x` mean anything.
     *
     * The second job of this shape is the numbering. Each tab is its own origin and
     * therefore its own storage, so a page only ever sees its own marks and can only
     * count from 1. Numbering per page is what lets the pin on the page, the row in
     * the panel and the batch handed to the model wear the SAME number. A
     * session-wide number would have to be pushed into every page before it could be
     * shown there, and until it arrived the page's own count would disagree with it.
     *
     * Written self-contained on purpose: the checks lift this function out of the
     * source on its own, so it must not reach for a helper defined beside it.
     *
     * @param list - marks to group.
     * @returns `[{ page, items }]`, groups and items both in display order.
     */
    function pageGroups(list) {
      /**
       * One mark's position in its own document, along one axis. Document
       * coordinates rather than viewport ones: the list must not reshuffle just
       * because the reader scrolled. An unmeasurable value reads as 0, so such an
       * entry still appears, at the top of its own page, rather than throwing.
       */
      const docAxis = (entry, axis) => {
        const doc = entry && entry.doc
        const value = doc && doc[axis]
        return typeof value === 'number' && Number.isFinite(value) ? value : 0
      }
      const groups = new Map()
      ;(Array.isArray(list) ? list : []).forEach((entry, index) => {
        const page = entry && typeof entry.page === 'string' ? entry.page.trim() : ''
        let group = groups.get(page)
        if (!group) {
          group = { page, items: [], first: Infinity, at: index }
          groups.set(page, group)
        }
        // When this page was first marked. A mark that does not say keeps the group
        // it is in from claiming a time it does not have.
        const made = entry && typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
          ? entry.createdAt
          : Infinity
        if (made < group.first) group.first = made
        group.items.push({ entry, index })
      })
      const ordered = Array.from(groups.values())
      // The pages keep the order the reader met them in, so a mark made later is
      // never listed above one made earlier merely because of where it sits.
      ordered.sort((a, b) => (a.first !== b.first ? a.first - b.first : a.at - b.at))
      ordered.forEach((group) => {
        group.items = group.items
          .sort((a, b) => {
            const ay = docAxis(a.entry, 'y')
            const by = docAxis(b.entry, 'y')
            if (ay !== by) return ay - by
            const ax = docAxis(a.entry, 'x')
            const bx = docAxis(b.entry, 'x')
            if (ax !== bx) return ax - bx
            // Ties keep the order they were made in, so the list does not reshuffle
            // between renders when two marks share a position.
            return a.index - b.index
          })
          .map((one) => one.entry)
      })
      return ordered
    }

    /**
     * Every mark in display order: the pages in the order they were first marked,
     * and each page's marks read down that page.
     *
     * A flat view of `pageGroups`, for the callers that need the sequence rather
     * than the grouping — chiefly the report handed to the host, which numbers its
     * `## Element n` headings by position in that array.
     */
    function inReadingOrder(list) {
      return pageGroups(list).reduce((all, group) => all.concat(group.items), [])
    }

    // The block handed to the model is rendered by the host half, not here. The
    // sidebar only reports which elements were picked; the host decides how to
    // phrase them and delivers them as runtime context, which is what keeps the
    // reader's own message free of the block entirely.

    // ------------------------------------------------------------------- views

    /**
     * Drop entries that are not usable objects.
     *
     * Annotations arrive over postMessage from the framed page, and the list is
     * rendered before any effect runs, so a `null` reaching this component used
     * to throw during render and blank the whole sidebar. Filtering once here
     * keeps every downstream read safe.
     * @param list - annotations as received.
     * @returns only the object-shaped entries.
     */
    function usable(list) {
      return (Array.isArray(list) ? list : []).filter((entry) => entry !== null && typeof entry === 'object')
    }

    /**
     * What the panel adopts when the page reports its marks.
     *
     * Split out of the message handler because this decision is a whole bug
     * surface on its own: getting it wrong either wipes the reader's marks or
     * resurrects the ones they just deleted, and both are invisible to anything
     * that only reads the markup.
     *
     * A page that comes up empty while the host is holding marks has either been
     * rebuilt on a fresh preview origin or lost its storage. The host's copy is
     * handed back so the pins return with it, instead of the page's silence
     * wiping an attachment the reader can still see counted in the composer.
     * Nothing is invented: these are the marks the reader made, returned to the
     * side that draws them.
     *
     * That reasoning only holds for `ready`, which is the page announcing itself.
     * `changed` is the page answering an action the reader just took, and the one
     * action that empties the list is deleting the last mark. Restoring there put
     * the mark straight back: the reader pressed 删除 on the card, the page
     * removed it and said so, and this was read as a page that had lost its
     * storage. Deleting the last annotation therefore looked like a dead button
     * while deleting any earlier one worked — only the empty list triggered it.
     * A page that is alive and speaking is authoritative about its own marks;
     * `ready` remains the one case where its silence needs filling in.
     *
     * @param args.type - the page's message type.
     * @param args.incoming - the marks the page reports.
     * @param args.held - the panel's mirror of what the host holds.
     * @returns the list to show (`adopt`) plus the list to hand back to the page.
     *   `restore` is `null` when there is nothing to hand back, and `adopted` says
     *   whether `adopt` came from the host rather than from the page — those marks
     *   carry no page id yet and have to be given one before the panel can list
     *   them.
     */
    function batchFromPage(args) {
      const incoming = usable(args.incoming)
      const held = usable(args.held)
      if (args.type === 'ready' && !incoming.length && held.length) {
        return { adopt: held, restore: held, adopted: true }
      }
      return { adopt: incoming, restore: null, adopted: false }
    }

    function NumberedList(props) {
      const { annotations, onEdit, onRemove, onRemoveAll, busy } = props
      const groups = pageGroups(usable(annotations))
      if (!groups.length) return h('p', { className: 'dsa-empty' }, t('panel.empty'))
      // Grouped by page, and numbered within the group.
      //
      // The reader's report: two pages, each with one mark, and both pins read 1
      // while this list read 1 and 2. The list was numbering the session while the
      // pages could only number themselves — each tab is its own origin, so its
      // storage holds its own marks and any count it makes starts at 1. Making the
      // list agree meant numbering per page here too.
      //
      // The page is worth a heading rather than a dim line under each row, which is
      // what this used to be: the reader said the page was there but "not obvious
      // enough", and with the numbers now restarting per page the boundary has to
      // be visible or the list looks like it renumbered itself by mistake. With one
      // page the heading would only repeat what the address bar already shows, so
      // it stays away — and so does the wrapper, leaving that case byte-identical.
      const showPage = groups.length > 1
      const pageLabel = (page) => (page ? page : t('panel.pageUnknown'))
      /**
       * Open one mark for editing, and put the popup away as it opens.
       *
       * The reader's report: pressing ✎ opened the mark's card on the page but
       * left this dialog sitting on top of it, so the card and the list were
       * both on screen and the card was the one being written in. The action is
       * "go to this mark", and the surface that sends you there has no reason to
       * stay. Closing is done through the enclosing `<details>` — the same route
       * the close button takes — so there is no second piece of open/closed state
       * to keep in step with the element's own.
       */
      const openForEdit = (id, event) => {
        const details = event && event.currentTarget && event.currentTarget.closest('details')
        if (details) details.open = false
        onEdit(id, 'edit')
      }
      /**
       * One mark, numbered by its place in its own page's group.
       *
       * The index is the group's, not the list's: that is the whole point of the
       * grouping, and it is the number the pin on that page wears.
       */
      const row = (entry, index) => h(
        'li',
        { key: entry.id, className: 'dsa-item', onMouseEnter: () => onEdit(entry.id, 'hover') },
        h('span', { className: 'dsa-num', 'data-kind': entry.note ? 'note' : 'mark' }, String(index + 1)),
        h(
          'div',
          { className: 'dsa-body' },
          h(
            'div',
            { className: 'dsa-line' },
            h('span', { className: 'dsa-kind', 'data-kind': entry.note ? 'note' : 'mark' }, entry.note ? t('panel.kindNote') : t('panel.kindMark')),
            h('span', { className: 'dsa-sel' }, entry.selector || entry.tag || ''),
          ),
          h(
            'p',
            { className: 'dsa-note', 'data-empty': entry.note ? undefined : 'true' },
            entry.note ? entry.note : '—',
          ),
        ),
        h(
          'div',
          { className: 'dsa-item-actions' },
          h('button', { type: 'button', className: 'dsa-mini', onClick: (event) => openForEdit(entry.id, event), title: t('panel.edit') }, '✎'),
          h('button', { type: 'button', className: 'dsa-mini', onClick: () => onRemove(entry.id), title: t('panel.remove') }, '✕'),
        ),
      )
      // One list, with the headings as rows inside it, so the `ul` stays the single
      // scroller the dialog was built around — a scroll box per group would put the
      // bulk clear below a nested scroll area and out of reach again.
      const rows = []
      groups.forEach((group, groupIndex) => {
        if (showPage) {
          rows.push(h(
            'li',
            { className: 'dsa-group', key: `g${groupIndex}` },
            h('span', { className: 'dsa-group-page', title: group.page || undefined }, pageLabel(group.page)),
            h('span', { className: 'dsa-group-count' }, String(group.items.length)),
          ))
        }
        group.items.forEach((entry, index) => rows.push(row(entry, index)))
      })
      return h(
        'div',
        { className: 'dsa-count-main' },
        h('ul', { className: 'dsa-list' }, rows),
        h(
          'div',
          { className: 'dsa-bar' },
          // No "attach" button. Marks are written to the host the moment they are
          // made, so they are already riding along with whatever gets sent next;
          // a button that merely confirmed what had happened was the reader's
          // least favourite part of this panel. Only the destructive action
          // remains, because clearing is the one thing that is not automatic.
          h('button', { type: 'button', className: 'dsa-btn', onClick: onRemoveAll, disabled: busy }, t('panel.removeAll')),
        ),
      )
    }

    /**
     * Marks for every stack the probe can report.
     *
     * Inline SVG rather than image files, so the bundle stays self-contained and
     * nothing is fetched from a CDN at render time.
     *
     * The geometry is the real logo path from simple-icons rather than an
     * approximation. The first version drew simplified shapes by hand — a React mark
     * that was a circle with a dot, a Vue mark that was a plain triangle — and at the
     * 14px this list uses, an approximation is indistinguishable from the generic
     * globe it replaced, which defeats the point of having a mark at all.
     *
     * `stroke: true` marks the two logos that are line art and must not be filled.
     */
    const STACK_MARKS = {
      // React — line art, so it is stroked rather than filled
      react: { color: '#61dafb', stroke: true, path: 'M12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm0-6c5 0 9 3.4 9 7.5s-4 7.5-9 7.5-9-3.4-9-7.5S7 4.5 12 4.5Z' },
      vue: { color: '#41b883', path: 'M24 1.61h-9.94L12 5.16L9.94 1.61H0l12 20.78ZM12 14.08L5.16 2.23h4.43L12 6.41l2.41-4.18h4.43Z' },
      svelte: { color: '#ff3e00', path: 'M10.354 21.125a4.44 4.44 0 0 1-4.765-1.767a4.1 4.1 0 0 1-.703-3.107a4 4 0 0 1 .134-.522l.105-.321l.287.21a7.2 7.2 0 0 0 2.186 1.092l.208.063l-.02.208a1.25 1.25 0 0 0 .226.83a1.34 1.34 0 0 0 1.435.533a1.2 1.2 0 0 0 .343-.15l5.59-3.562a1.16 1.16 0 0 0 .524-.778a1.24 1.24 0 0 0-.211-.937a1.34 1.34 0 0 0-1.435-.533a1.2 1.2 0 0 0-.343.15l-2.133 1.36a4 4 0 0 1-1.135.499a4.44 4.44 0 0 1-4.765-1.766a4.1 4.1 0 0 1-.702-3.108a3.86 3.86 0 0 1 1.742-2.582l5.589-3.563a4 4 0 0 1 1.135-.499a4.44 4.44 0 0 1 4.765 1.767a4.1 4.1 0 0 1 .703 3.107a4 4 0 0 1-.134.522l-.105.321l-.286-.21a7.2 7.2 0 0 0-2.187-1.093l-.208-.063l.02-.207a1.25 1.25 0 0 0-.226-.831a1.34 1.34 0 0 0-1.435-.532a1.2 1.2 0 0 0-.343.15L8.62 9.368a1.16 1.16 0 0 0-.524.778a1.24 1.24 0 0 0 .211.937a1.34 1.34 0 0 0 1.435.533a1.2 1.2 0 0 0 .344-.151l2.132-1.36a4 4 0 0 1 1.135-.498a4.44 4.44 0 0 1 4.765 1.766a4.1 4.1 0 0 1 .702 3.108a3.86 3.86 0 0 1-1.742 2.583l-5.589 3.562a4 4 0 0 1-1.135.499m10.358-17.95C18.484-.015 14.082-.96 10.9 1.068L5.31 4.63a6.4 6.4 0 0 0-2.896 4.295a6.75 6.75 0 0 0 .666 4.336a6.4 6.4 0 0 0-.96 2.396a6.83 6.83 0 0 0 1.168 5.167c2.229 3.19 6.63 4.135 9.812 2.108l5.59-3.562a6.4 6.4 0 0 0 2.896-4.295a6.76 6.76 0 0 0-.665-4.336a6.4 6.4 0 0 0 .958-2.396a6.83 6.83 0 0 0-1.167-5.168' },
      angular: { color: '#dd0031', path: 'M16.712 17.711H7.288l-1.204 2.916L12 24l5.916-3.373zM14.692 0l7.832 16.855l.814-12.856zM9.308 0L.662 3.999l.814 12.856zm-.405 13.93h6.198L12 6.396z' },
      next: { color: '#8b93a7', path: 'M18.665 21.978A11.94 11.94 0 0 1 12 24C5.377 24 0 18.623 0 12S5.377 0 12 0s12 5.377 12 12c0 3.583-1.574 6.801-4.067 9.001L9.219 7.2H7.2v9.596h1.615V9.251zm-3.332-8.533l1.6 2.061V7.2h-1.6z' },
      nuxt: { color: '#00dc82', path: 'M13.464 19.83h8.922c.283 0 .562-.073.807-.21a1.6 1.6 0 0 0 .591-.574a1.53 1.53 0 0 0 .216-.783a1.53 1.53 0 0 0-.217-.782L17.792 7.414a1.6 1.6 0 0 0-.591-.573a1.65 1.65 0 0 0-.807-.21c-.283 0-.562.073-.807.21a1.6 1.6 0 0 0-.59.573L13.463 9.99L10.47 4.953a1.6 1.6 0 0 0-.591-.573a1.65 1.65 0 0 0-.807-.21c-.284 0-.562.073-.807.21a1.6 1.6 0 0 0-.591.573L.216 17.481a1.53 1.53 0 0 0-.217.782c0 .275.074.545.216.783a1.6 1.6 0 0 0 .59.574c.246.137.525.21.808.21h5.6c2.22 0 3.856-.946 4.982-2.79l2.733-4.593l1.464-2.457l4.395 7.382h-5.859Zm-6.341-2.46l-3.908-.002l5.858-9.842l2.923 4.921l-1.957 3.29c-.748 1.196-1.597 1.632-2.916 1.632' },
      node: { color: '#539e43', path: 'M11.998 24c-.321 0-.641-.084-.922-.247L8.14 22.016c-.438-.245-.224-.332-.08-.383c.585-.203.703-.25 1.328-.604c.065-.037.151-.023.218.017l2.256 1.339a.29.29 0 0 0 .272 0l8.795-5.076a.28.28 0 0 0 .134-.238V6.921a.28.28 0 0 0-.137-.242l-8.791-5.072a.28.28 0 0 0-.271 0L3.075 6.68a.28.28 0 0 0-.139.241v10.15a.27.27 0 0 0 .139.235l2.409 1.392c1.307.654 2.108-.116 2.108-.89V7.787c0-.142.114-.253.256-.253h1.115c.139 0 .255.112.255.253v10.021c0 1.745-.95 2.745-2.604 2.745c-.508 0-.909 0-2.026-.551L2.28 18.675a1.86 1.86 0 0 1-.922-1.604V6.921c0-.659.353-1.275.922-1.603L11.075.236a1.93 1.93 0 0 1 1.848 0l8.794 5.082c.57.329.924.944.924 1.603v10.15a1.86 1.86 0 0 1-.924 1.604l-8.794 5.078c-.28.163-.599.247-.925.247m7.101-10.007c0-1.9-1.284-2.406-3.987-2.763c-2.731-.361-3.009-.548-3.009-1.187c0-.528.235-1.233 2.258-1.233c1.807 0 2.473.389 2.747 1.607a.254.254 0 0 0 .247.199h1.141a.26.26 0 0 0 .186-.081a.26.26 0 0 0 .067-.196c-.177-2.098-1.571-3.076-4.388-3.076c-2.508 0-4.004 1.058-4.004 2.833c0 1.925 1.488 2.457 3.895 2.695c2.88.282 3.103.703 3.103 1.269c0 .983-.789 1.402-2.642 1.402c-2.327 0-2.839-.584-3.011-1.742a.255.255 0 0 0-.253-.215h-1.137a.25.25 0 0 0-.254.253c0 1.482.806 3.248 4.655 3.248c2.788.001 4.386-1.096 4.386-3.013' },
      python: { color: '#3776ab', path: 'm14.25.18l.9.2l.73.26l.59.3l.45.32l.34.34l.25.34l.16.33l.1.3l.04.26l.02.2l-.01.13V8.5l-.05.63l-.13.55l-.21.46l-.26.38l-.3.31l-.33.25l-.35.19l-.35.14l-.33.1l-.3.07l-.26.04l-.21.02H8.77l-.69.05l-.59.14l-.5.22l-.41.27l-.33.32l-.27.35l-.2.36l-.15.37l-.1.35l-.07.32l-.04.27l-.02.21v3.06H3.17l-.21-.03l-.28-.07l-.32-.12l-.35-.18l-.36-.26l-.36-.36l-.35-.46l-.32-.59l-.28-.73l-.21-.88l-.14-1.05l-.05-1.23l.06-1.22l.16-1.04l.24-.87l.32-.71l.36-.57l.4-.44l.42-.33l.42-.24l.4-.16l.36-.1l.32-.05l.24-.01h.16l.06.01h8.16v-.83H6.18l-.01-2.75l-.02-.37l.05-.34l.11-.31l.17-.28l.25-.26l.31-.23l.38-.2l.44-.18l.51-.15l.58-.12l.64-.1l.71-.06l.77-.04l.84-.02l1.27.05zm-6.3 1.98l-.23.33l-.08.41l.08.41l.23.34l.33.22l.41.09l.41-.09l.33-.22l.23-.34l.08-.41l-.08-.41l-.23-.33l-.33-.22l-.41-.09l-.41.09zm13.09 3.95l.28.06l.32.12l.35.18l.36.27l.36.35l.35.47l.32.59l.28.73l.21.88l.14 1.04l.05 1.23l-.06 1.23l-.16 1.04l-.24.86l-.32.71l-.36.57l-.4.45l-.42.33l-.42.24l-.4.16l-.36.09l-.32.05l-.24.02l-.16-.01h-8.22v.82h5.84l.01 2.76l.02.36l-.05.34l-.11.31l-.17.29l-.25.25l-.31.24l-.38.2l-.44.17l-.51.15l-.58.13l-.64.09l-.71.07l-.77.04l-.84.01l-1.27-.04l-1.07-.14l-.9-.2l-.73-.25l-.59-.3l-.45-.33l-.34-.34l-.25-.34l-.16-.33l-.1-.3l-.04-.25l-.02-.2l.01-.13v-5.34l.05-.64l.13-.54l.21-.46l.26-.38l.3-.32l.33-.24l.35-.2l.35-.14l.33-.1l.3-.06l.26-.04l.21-.02l.13-.01h5.84l.69-.05l.59-.14l.5-.21l.41-.28l.33-.32l.27-.35l.2-.36l.15-.36l.1-.35l.07-.32l.04-.28l.02-.21V6.07h2.09l.14.01zm-6.47 14.25l-.23.33l-.08.41l.08.41l.23.33l.33.23l.41.08l.41-.08l.33-.23l.23-.33l.08-.41l-.08-.41l-.23-.33l-.33-.23l-.41-.08l-.41.08z' },
      django: { color: '#44b78b', path: 'M11.146 0h3.924v18.166c-2.013.382-3.491.535-5.096.535c-4.791 0-7.288-2.166-7.288-6.32c0-4.002 2.65-6.6 6.753-6.6c.637 0 1.121.05 1.707.203zm0 9.143a3.9 3.9 0 0 0-1.325-.204c-1.988 0-3.134 1.223-3.134 3.365c0 2.09 1.096 3.236 3.109 3.236c.433 0 .79-.025 1.35-.102V9.142zM21.314 6.06v9.098c0 3.134-.229 4.638-.917 5.937c-.637 1.249-1.478 2.039-3.211 2.905l-3.644-1.733c1.733-.815 2.574-1.53 3.109-2.625c.561-1.121.739-2.421.739-5.835V6.059zM17.39.021h3.924v4.026H17.39z' },
      flask: { color: '#3babc3', path: 'M10.773 2.878c-.013 1.434.322 4.624.445 5.734l-8.558 3.83c-.56-.959-.98-2.304-1.237-3.38l-.06.027c-.205.09-.406.053-.494-.088l-.011-.018l-.82-1.506c-.058-.105-.05-.252.024-.392a.78.78 0 0 1 .358-.331l9.824-4.207c.146-.064.299-.063.4.004c.106.062.127.128.13.327m.68 7c.523 1.97.675 2.412.832 2.818l-7.263 3.7a19.4 19.4 0 0 1-1.81-2.83zm12.432 8.786h.003c.283.402-.047.657-.153.698l-.947.37c.037.125.035.319-.217.414l-.736.287c-.229.09-.398-.059-.42-.2l-.025-.125c-4.427 1.784-7.94 1.685-10.696.647c-1.981-.745-3.576-1.983-4.846-3.379l6.948-3.54c.721 1.431 1.586 2.454 2.509 3.178c2.086 1.638 4.415 1.712 5.793 1.563l-.047-.233c-.015-.077.007-.135.086-.165l.734-.288a.3.3 0 0 1 .342.086l.748-.288a.31.31 0 0 1 .341.086z' },
      fastapi: { color: '#05998b', path: 'M12 .039c-6.627 0-12 5.354-12 11.96c-.001 6.606 5.372 11.963 12 11.962S24.001 18.605 24 12S18.627.039 12 .039m-.829 5.415h7.55l-7.58 5.329h5.182L5.28 18.543l5.891-13.088' },
      express: { color: '#8b93a7', path: 'M12.262 16.666h1.146l6.975-9.325H19.22zm9.778 1.441v.004l-4.334-5.706l-.557.74l4.873 6.682H.945V4.173h9.505l5.026 6.7l.574-.772l-4.374-5.928h.003l-.719-.945H0v17.544h24zM10.917 8.705a3.8 3.8 0 0 0-1.292-1.183q-.796-.45-1.916-.45c-.746 0-1.37.14-1.906.424a3.76 3.76 0 0 0-1.31 1.12a4.9 4.9 0 0 0-.75 1.581a7.17 7.17 0 0 0 0 3.696c.148.567.402 1.101.75 1.573a3.5 3.5 0 0 0 1.31 1.066q.803.39 1.906.389q1.77 0 2.739-.868q.966-.867 1.328-2.457h-1.139q-.271 1.084-.977 1.734q-.704.651-1.952.65q-.812 0-1.392-.342a3.1 3.1 0 0 1-.957-.869a3.5 3.5 0 0 1-.551-1.182a5 5 0 0 1-.17-1.133a9 9 0 0 0-.015-.286a4.5 4.5 0 0 1 .015-.829c.047-.418.147-.83.296-1.223A3.7 3.7 0 0 1 5.54 9.05a2.9 2.9 0 0 1 .922-.742q.541-.28 1.246-.28c.47 0 .869.093 1.23.28q.541.281.922.742q.379.461.587 1.057t.225 1.246H5.625l.004.957h6.182a7.3 7.3 0 0 0-.18-1.924a4.9 4.9 0 0 0-.715-1.68' },
      java: { color: '#e76f00', path: 'M11.915 0L11.7.215C9.515 2.4 7.47 6.39 6.046 10.483c-1.064 1.024-3.633 2.81-3.711 3.551c-.093.87 1.746 2.611 1.55 3.235c-.198.625-1.304 1.408-1.014 1.939c.1.188.823.011 1.277-.491a13.4 13.4 0 0 0-.017 2.14c.076.906.27 1.668.643 2.232c.372.563.956.911 1.667.911c.397 0 .727-.114 1.024-.264c.298-.149.571-.33.91-.5c.68-.34 1.634-.666 3.53-.604c1.903.062 2.872.39 3.559.704s1.15.664 1.925.664c.767 0 1.395-.336 1.807-.9c.412-.563.631-1.33.72-2.24c.06-.623.055-1.32 0-2.066c.454.45 1.117.604 1.213.424c.29-.53-.816-1.314-1.013-1.937c-.198-.624 1.642-2.366 1.549-3.236c-.08-.748-2.707-2.568-3.748-3.586C16.428 6.374 14.308 2.394 12.13.215zm.175 6.038a2.95 2.95 0 0 1 2.943 2.942a2.95 2.95 0 0 1-2.943 2.943A2.95 2.95 0 0 1 9.148 8.98a2.95 2.95 0 0 1 2.942-2.942M8.685 7.983a3.5 3.5 0 0 0-.145.997c0 1.951 1.6 3.55 3.55 3.55s3.55-1.598 3.55-3.55q-.002-.495-.132-.951q.502.143.915.336a43 43 0 0 1 2.042 5.829c.678 2.545 1.01 4.92.846 6.607c-.082.844-.29 1.51-.606 1.94c-.315.431-.713.651-1.315.651c-.593 0-.932-.27-1.673-.61c-.741-.338-1.825-.694-3.792-.758c-1.974-.064-3.073.293-3.821.669c-.375.188-.659.373-.911.5s-.466.2-.752.2c-.53 0-.876-.209-1.16-.64c-.285-.43-.474-1.101-.545-1.948c-.141-1.693.176-4.069.823-6.614a43 43 0 0 1 1.934-5.783c.348-.167.749-.31 1.192-.425m-3.382 4.362a.2.2 0 0 1 .13.031c-.166.56-.323 1.116-.463 1.665a34 34 0 0 0-.547 2.555a4 4 0 0 0-.2-.39c-.58-1.012-.914-1.642-1.16-2.08c.315-.24 1.679-1.755 2.24-1.781m13.394.01c.562.027 1.926 1.543 2.24 1.783c-.246.438-.58 1.068-1.16 2.08a4 4 0 0 0-.163.309a32 32 0 0 0-.562-2.49a41 41 0 0 0-.482-1.652a.2.2 0 0 1 .127-.03' },
      go: { color: '#00add8', path: 'M1.811 10.231c-.047 0-.058-.023-.035-.059l.246-.315c.023-.035.081-.058.128-.058h4.172c.046 0 .058.035.035.07l-.199.303c-.023.036-.082.07-.117.07zM.047 11.306c-.047 0-.059-.023-.035-.058l.245-.316c.023-.035.082-.058.129-.058h5.328c.047 0 .07.035.058.07l-.093.28c-.012.047-.058.07-.105.07zm2.828 1.075c-.047 0-.059-.035-.035-.07l.163-.292c.023-.035.07-.07.117-.07h2.337c.047 0 .07.035.07.082l-.023.28c0 .047-.047.082-.082.082zm12.129-2.36c-.736.187-1.239.327-1.963.514c-.176.046-.187.058-.34-.117c-.174-.199-.303-.327-.548-.444c-.737-.362-1.45-.257-2.115.175c-.795.514-1.204 1.274-1.192 2.22c.011.935.654 1.706 1.577 1.835c.795.105 1.46-.175 1.987-.77c.105-.13.198-.27.315-.434H10.47c-.245 0-.304-.152-.222-.35c.152-.362.432-.97.596-1.274a.32.32 0 0 1 .292-.187h4.253c-.023.316-.023.631-.07.947a5 5 0 0 1-.958 2.29c-.841 1.11-1.94 1.8-3.33 1.986c-1.145.152-2.209-.07-3.143-.77c-.865-.655-1.356-1.52-1.484-2.595c-.152-1.274.222-2.419.993-3.424c.83-1.086 1.928-1.776 3.272-2.02c1.098-.2 2.15-.07 3.096.571c.62.41 1.063.97 1.356 1.648c.07.105.023.164-.117.2m3.868 6.461c-1.064-.024-2.034-.328-2.852-1.029a3.67 3.67 0 0 1-1.262-2.255c-.21-1.32.152-2.489.947-3.529c.853-1.122 1.881-1.706 3.272-1.95c1.192-.21 2.314-.095 3.33.595c.923.63 1.496 1.484 1.648 2.605c.198 1.578-.257 2.863-1.344 3.962c-.771.783-1.718 1.273-2.805 1.495c-.315.06-.63.07-.934.106m2.78-4.72c-.011-.153-.011-.27-.034-.387c-.21-1.157-1.274-1.81-2.384-1.554c-1.087.245-1.788.935-2.045 2.033c-.21.912.234 1.835 1.075 2.21c.643.28 1.285.244 1.905-.07c.923-.48 1.425-1.228 1.484-2.233z' },
      nginx: { color: '#009639', path: 'M12 0L1.605 6v12L12 24l10.395-6V6zm6 16.59c0 .705-.646 1.29-1.529 1.29c-.631 0-1.351-.255-1.801-.81l-6-7.141v6.66c0 .721-.57 1.29-1.274 1.29H7.32c-.721 0-1.29-.6-1.29-1.29V7.41c0-.705.63-1.29 1.5-1.29c.646 0 1.38.255 1.83.81l5.97 7.141V7.41c0-.721.6-1.29 1.29-1.29h.075c.72 0 1.29.6 1.29 1.29v9.18z' },
      // New API — not in simple-icons; a router glyph in the project's blue
      newapi: { color: '#5b8def', path: 'M12 1.8a10.2 10.2 0 1 0 0 20.4 10.2 10.2 0 0 0 0-20.4Zm1.1 4.4v6.3l4.4 2.6-1.1 1.9-4.4-2.6-4.4 2.6-1.1-1.9 4.4-2.6V6.2h2.2Zm-1.1-2.2a8 8 0 1 1 0 16 8 8 0 0 1 0-16Z' },
      // DSH — not in simple-icons; the harness's blue dot in a ring
      dsh: { color: '#4d6bfe', path: 'M12 1.8a10.2 10.2 0 1 0 0 20.4 10.2 10.2 0 0 0 0-20.4Zm0 3.4c1.6 2 3.4 4.6 3.4 6.8 0 1.9-1.5 3.4-3.4 3.4s-3.4-1.5-3.4-3.4c0-2.2 1.8-4.8 3.4-6.8Zm-4.6 12c1.2.9 2.9 1.4 4.6 1.4s3.4-.5 4.6-1.4l1.3 1.7c-1.7 1.3-3.8 2-5.9 2s-4.2-.7-5.9-2l1.3-1.7Z' },
      // A workspace file with no server behind it
      static: { color: '#8b8b8b', path: 'M3.6 3.6h16.8v16.8H3.6V3.6Zm2.1 2.1v12.6h12.6V5.7H5.7Z' },
    }

    function StackMark(props) {
      const mark = STACK_MARKS[props.id]
      if (!mark) return null
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          'aria-hidden': 'true',
          style: mark.stroke
            // Line-art logos are drawn with strokes. Filling them instead paints the
            // orbits into one solid blob rather than three rings.
            ? { flex: '0 0 auto', fill: 'none', stroke: mark.color, strokeWidth: 1.4, strokeLinejoin: 'round' }
            : { flex: '0 0 auto', fill: mark.color },
        },
        h('path', { d: mark.path }),
      )
    }

    /**
     * What to call a probed service.
     *
     * The page title is the best answer and the stack label is the next best, but
     * plenty of real services have neither — an API answering JSON at `/health`, or
     * a page whose title is set by script. Those used to render as a bare
     * "localhost", which is the one label that tells a reader nothing: every
     * unidentified port looked identical. Falling back to what the service is
     * actually serving gives each row something to be recognised by.
     * @param server - one row from the sweep.
     * @returns the name to show.
     */
    function serverLabel(server) {
      if (server.title) return server.title
      if (server.stack && server.stack.label) return server.stack.label
      const type = String(server.type || '')
      if (type.includes('json')) return t('panel.serviceJson')
      if (type.includes('html')) return t('panel.serviceHtml')
      if (type.includes('text')) return t('panel.serviceText')
      if (type) return type
      return t('panel.serviceUnknown')
    }

    /**
     * Where the open preview currently is, for the collapsed address bar.
     *
     * The whole point of the control is that the reader can tell which page they
     * are looking at, and for a hash-routed app the page is entirely in the part
     * this used to drop. `http://host/guicomm/#/home` and
     * `http://host/guicomm/#/guicom/command` are different screens with the same
     * host and path, so the chip showed the same string for both and could not
     * answer the only question asked of it.
     *
     * The search string is kept for the same reason: a view is often selected by
     * query rather than by path. `new URL` throws on the workspace-file form the
     * panel also accepts, so a failed parse falls back to the raw string rather
     * than blanking the control.
     * @param url - the preview URL.
     * @returns the address worth showing, or the URL unchanged when not absolute.
     */
    function previewAddress(url, target) {
      try {
        const parsed = new URL(url)
        const path = parsed.pathname === '/' && !parsed.hash && !parsed.search ? '' : parsed.pathname
        // The preview is served from an ephemeral loopback port, so the origin in
        // `url` is a number the reader never chose and cannot use. The address
        // they opened is what locates the page, and the path/search/hash below
        // are the frame's own — the proxy keeps the app's paths, so the two
        // halves compose into the address they would see in a browser.
        let host = parsed.host
        try {
          const opened = new URL(String(target || ''))
          if (opened.protocol === 'http:' || opened.protocol === 'https:') host = opened.host
        } catch (error) {
          void error
        }
        return host + path + parsed.search + parsed.hash
      } catch (error) {
        void error
        return String(url || '')
      }
    }

    /**
     * The marked-element counter.
     *
     * A count in the toolbar, expanding to the full list on demand, keeps the
     * preview at a usable height: the list overlays the frame instead of
     * occupying a permanent block beneath it.
     */
    function CountButton(props) {
      const { annotations, onEdit, onRemove, onRemoveAll, busy } = props
      return h(
        'details',
        { className: 'dsa-count' },
        h(
          'summary',
          { title: t('panel.listTitle') },
          // The badge counts what the list actually shows, so a dropped entry
          // cannot leave the header claiming more than the body lists.
          h('span', { className: 'dsa-count-badge' }, String(usable(annotations).length)),
          // The short label on screen, the full sentence in the tooltip. The reader's
          // report: the long phrasing sat in the toolbar on every message and read as
          // intrusive. The badge already says how many, so the words only have to say
          // what they are.
          h('span', null, t('panel.listShort')),
        ),
        // The scrim is inside the `<details>`, so it is rendered only while the list
        // is open and unmounts with it. Native `<details>` already closes on a click
        // outside the summary, so this only has to catch the click visually — no
        // state to keep in step with the element's own.
        h('div', { className: 'dsa-count-scrim', 'aria-hidden': 'true' }),
        h(
          'div',
          { className: 'dsa-count-body', role: 'dialog', 'aria-label': t('panel.listTitle') },
          h(
            'div',
            { className: 'dsa-count-head' },
            h('p', { className: 'dsa-count-title' }, `${usable(annotations).length} ${t('panel.listUnit')}`),
            // Escape closes it, which the reader expects of a surface this size and
            // which a native `<details>` does not provide on its own.
            h(
              'button',
              {
                type: 'button',
                className: 'dsa-btn dsa-icon-btn',
                onClick: (event) => {
                  const details = event.currentTarget.closest('details')
                  if (details) details.open = false
                },
                title: t('panel.close'),
                'aria-label': t('panel.close'),
              },
              h(Icon, { name: 'close' }),
            ),
          ),
          h(NumberedList, { annotations, onEdit, onRemove, onRemoveAll, busy }),
        ),
      )
    }

    /**
     * The accent picker.
     *
     * Presets rather than a colour input: the accent is used as a 6px dot, a 2px
     * ring drawn over arbitrary page content, and a filled pin behind white text.
     * All three have to stay legible, and a freely picked hue can fail any of them
     * on a background the reader has not seen yet.
     * @param props - the current accent and its setter.
     * @returns the swatch row.
     */
    function AccentPicker(props) {
      const { accent, onChange } = props
      return h(
        'div',
        { className: 'dsa-swatches', role: 'radiogroup', 'aria-label': t('panel.accent') },
        ACCENTS.map((one) =>
          h(
            'button',
            {
              key: one.id,
              type: 'button',
              className: 'dsa-swatch',
              role: 'radio',
              'aria-checked': accent === one.value,
              'aria-label': one.label,
              title: one.label,
              'data-on': accent === one.value ? 'true' : 'false',
              onClick: () => onChange(one.value),
            },
            h('i', { style: { background: `hsl(${one.value})` } }),
          ),
        ),
      )
    }

    /**
     * The panel's overflow menu.
     *
     * These controls used to sit open on the toolbar: a server list that expanded
     * in place, a "detect" button whose purpose was not readable without pressing
     * it, and a reload button. Between them they took most of the panel and left
     * the previewed page in what was left — the reader's complaint was that the
     * page, not the toolbar, is what the sidebar is for.
     *
     * A menu keeps them reachable without keeping them visible. The address bar and
     * the mark button stay on the toolbar because they are used on every visit; the
     * rest is opened deliberately.
     * @param props - the panel's secondary actions.
     * @returns the menu button and its popover.
     */
    function PanelMenu(props) {
      const { servers, pages, onOpen, onDetect, detecting, onClearAll, count, accent, onAccent } = props
      const [open, setOpen] = React.useState(false)
      const ref = React.useRef(null)

      // Closed on any click outside or Escape: a menu that stays open while the
      // reader works in the page behind it is worse than no menu.
      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (ref.current && !ref.current.contains(event.target)) setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      return h(
        'div',
        { className: 'dsa-menu-wrap', ref },
        h(
          'button',
          {
            type: 'button',
            className: 'dsa-btn dsa-icon-btn',
            'data-on': open ? 'true' : undefined,
            'aria-expanded': open,
            'aria-label': t('panel.menu'),
            title: t('panel.menu'),
            onClick: () => setOpen((value) => !value),
          },
          h(Icon, { name: 'menu' }),
        ),
        open
          ? h(
              'div',
              { className: 'dsa-menu', role: 'menu' },
              // Detect deliberately does NOT close the menu: the results land in this
              // same menu, so closing it would hide the thing the reader just asked
              // for and force them to re-open it. It stays open and fills in.
              h(MenuRow, { icon: 'radar', label: detecting ? t('panel.detecting') : t('panel.detectLong'), disabled: detecting, onClick: () => { onDetect() } }),
              count
                ? h(MenuRow, { icon: 'eraser', label: t('panel.clearAll'), onClick: () => { setOpen(false); onClearAll() } })
                : null,
              h('div', { className: 'dsa-menu-sep' }),
              h(
                'div',
                { className: 'dsa-menu-block' },
                h('span', { className: 'dsa-menu-label' }, t('panel.accent')),
                h(AccentPicker, { accent, onChange: onAccent }),
              ),
              // The discovered list is the one item that needs room, so it is the
              // one item that gets a scrollable section rather than more rows.
              (servers && servers.length) || (pages && pages.length)
                ? h(
                    'div',
                    { className: 'dsa-menu-block' },
                    h('span', { className: 'dsa-menu-label' }, t('panel.discovered')),
                    h('div', { className: 'dsa-menu-scroll' }, h(ServerLists, { servers, pages, onOpen: (target) => { setOpen(false); onOpen(target) } })),
                  )
                : null,
            )
          : null,
      )
    }

    /**
     * The panel's icon set.
     *
     * Inline stroked paths on a 16px grid rather than an emoji or a font: emoji
     * render differently on every platform and cannot inherit `currentColor`, and
     * the panel sits inside someone else's shell, so a webfont would be a network
     * dependency in a sidebar. One stroke width and one grid keeps them looking
     * like a set rather than six unrelated glyphs.
     * @param props - the icon name and an optional pixel size.
     * @returns the svg element.
     */
    function Icon(props) {
      const { name, size } = props
      const px = size || 14
      const common = {
        width: px,
        height: px,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }
      switch (name) {
        case 'menu':
          return h('svg', common, h('circle', { cx: 8, cy: 3, r: 1.15, fill: 'currentColor', stroke: 'none' }), h('circle', { cx: 8, cy: 8, r: 1.15, fill: 'currentColor', stroke: 'none' }), h('circle', { cx: 8, cy: 13, r: 1.15, fill: 'currentColor', stroke: 'none' }))
        case 'refresh':
          return h('svg', common, h('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9' }), h('path', { d: 'M13.6 2.4v3.2h-3.2' }))
        case 'radar':
          // Scanning: a frame being swept, not a magnifier. A magnifier reads as
          // "search what I typed", which is what the address bar beside it does, so
          // the two controls looked like the same action.
          return h(
            'svg',
            common,
            h('path', { d: 'M2.2 5.4V3.4a1.2 1.2 0 0 1 1.2-1.2h2' }),
            h('path', { d: 'M10.6 2.2h2a1.2 1.2 0 0 1 1.2 1.2v2' }),
            h('path', { d: 'M13.8 10.6v2a1.2 1.2 0 0 1-1.2 1.2h-2' }),
            h('path', { d: 'M5.4 13.8h-2a1.2 1.2 0 0 1-1.2-1.2v-2' }),
            h('path', { d: 'M2.2 8h11.6', strokeDasharray: '2 2.2' }),
          )
        case 'mark':
          // A corner bracket over a dot: "pick this element". Distinct from the
          // scan icon's four corners because the dot is what is being chosen.
          return h(
            'svg',
            common,
            h('path', { d: 'M2.2 5.4V3.4a1.2 1.2 0 0 1 1.2-1.2h2' }),
            h('path', { d: 'M10.6 2.2h2a1.2 1.2 0 0 1 1.2 1.2v2' }),
            h('path', { d: 'M13.8 10.6v2a1.2 1.2 0 0 1-1.2 1.2h-2' }),
            h('path', { d: 'M5.4 13.8h-2a1.2 1.2 0 0 1-1.2-1.2v-2' }),
            h('circle', { cx: 8, cy: 8, r: 2.1, fill: 'currentColor', stroke: 'none' }),
          )
        case 'eraser':
          return h('svg', common, h('path', { d: 'M6.4 13.2H13' }), h('path', { d: 'M9.3 2.9 3 9.2a1.4 1.4 0 0 0 0 2l1.8 1.8h2.6l5.6-5.6a1.4 1.4 0 0 0 0-2l-1.7-1.7a1.4 1.4 0 0 0-2 0Z' }))
        case 'globe':
          return h('svg', common, h('circle', { cx: 8, cy: 8, r: 5.6 }), h('path', { d: 'M2.6 8h10.8' }), h('path', { d: 'M8 2.4c1.5 1.6 2.2 3.5 2.2 5.6S9.5 12 8 13.6C6.5 12 5.8 10.1 5.8 8S6.5 4 8 2.4Z' }))
        case 'edit':
          return h('svg', common, h('path', { d: 'M11.2 2.9a1.3 1.3 0 0 1 1.9 1.9l-6.9 6.9-2.5.6.6-2.5 6.9-6.9Z' }))
        case 'go':
          return h('svg', common, h('path', { d: 'M3 8h9' }), h('path', { d: 'M8.4 4.2 12.2 8l-3.8 3.8' }))
        case 'close':
          return h('svg', common, h('path', { d: 'M4 4l8 8' }), h('path', { d: 'M12 4l-8 8' }))
        case 'plus':
          return h('svg', common, h('path', { d: 'M8 3.4v9.2' }), h('path', { d: 'M3.4 8h9.2' }))
        case 'file':
          return h('svg', common, h('path', { d: 'M9 1.9H4.9a1.2 1.2 0 0 0-1.2 1.2v9.8a1.2 1.2 0 0 0 1.2 1.2h6.2a1.2 1.2 0 0 0 1.2-1.2V5.1L9 1.9Z' }), h('path', { d: 'M8.9 2v3.2h3.3' }))
        case 'spinner':
          return h('svg', { ...common, className: 'dsa-spin' }, h('path', { d: 'M8 1.8a6.2 6.2 0 1 1-6.2 6.2', opacity: .9 }))
        default:
          return null
      }
    }

    /** One row in the panel menu. */
    function MenuRow(props) {
      const { icon, label, onClick, disabled } = props
      return h(
        'button',
        { type: 'button', className: 'dsa-menu-row', role: 'menuitem', onClick, disabled },
        h(Icon, { name: icon }),
        h('span', null, label),
      )
    }

    /**
     * The server picker and the manual address bar.
     *
     * @param props - discovered servers, workspace pages, and the open action.
     * @returns the open bar.
     */
    function OpenBar(props) {
      const { onOpen, url, setUrl, preview, menu, pageUrl, composing, setComposing, draft, onDraftCancel } = props
      // `composing` means "the reader asked to type a new address", nothing else.
      //
      // It used to be seeded from `preview`, which conflated that with "there is
      // no page yet". The two are not the same: on a remount the panel reopens the
      // page it remembered in an effect, so `preview` is null on the FIRST render
      // and arrives a tick later. Seeding it from `preview` left the bar editing
      // for the rest of the session, and the address display that shows the current
      // route — the whole point of the control — never appeared after a tab switch.
      //
      // It is the PARENT's state, not this component's, because the tab strip's
      // "new page" button has to open this bar too, and that button is a sibling.
      // Keeping it here made the one control that adds a page unable to reach the
      // one control that names a page: the reader had a tab strip they could not
      // add to, which is what they reported.
      //
      // What this flag does NOT mean any more is "collapsed". The bar is now a
      // full-width row-level field inside the toolbar — see `.dsa-open-wrap` — so
      // this only chooses between showing the page's address and taking a new one.
      // It used to shrink the whole control to a content-width chip, which is what
      // left the toolbar row with a hole beside it.
      const expanded = composing || !preview

      /**
       * Open the bar for editing, seeded with the address that is currently open.
       *
       * Without this, clicking the address chip expanded an input bound to `url`,
       * which is only ever written by TYPING. A page opened any other way — from
       * discovery, from the page list, or by the remount that reopens the remembered
       * page after a tab switch — left `url` at `''`, so the control that exists to
       * show you where you are opened BLANK.
       *
       * The seed is `target || url` because that is exactly what `/open` takes back:
       * the reader's own input for a loopback address, the file's url for a workspace
       * page. Seeding with the display address instead would put a value in the box
       * that cannot be submitted as-is (a workspace file has no host to type).
       */
      const startEditing = () => {
        if (preview) setUrl(preview.target || preview.url || '')
        // Editing THIS page's address, so any blank tab is abandoned: the reader has
        // changed their mind about opening a new one, and leaving it up would make
        // Enter ambiguous between "go here" and "add a tab".
        if (draft) onDraftCancel()
        setComposing(true)
      }
      return h(
        'div',
        { className: 'dsa-open-wrap' },
        expanded
          ? h(
              'div',
              { className: 'dsa-open' },
              h('input', {
                value: url,
                placeholder: t('panel.urlPlaceholder'),
                autoFocus: Boolean(preview),
                onChange: (event) => setUrl(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    onOpen(url)
                    setComposing(false)
                  }
                  // Escape means "forget this", and for a draft that is the blank tab
                  // itself rather than only the text: leaving the tab behind with the
                  // text gone would read as a page that failed to open.
                  if (event.key === 'Escape') {
                    if (draft) onDraftCancel()
                    else if (preview) setComposing(false)
                  }
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsa-btn',
                  'data-primary': 'true',
                  disabled: !url,
                  onClick: () => {
                    onOpen(url)
                    setComposing(false)
                  },
                },
                h(Icon, { name: 'go' }),
                t('panel.go'),
              ),
              // No detect button here. Discovery lives in the overflow menu, and a
              // second entry point beside "Open" made the reader wonder whether the
              // two did different things. Cancel stays, because it belongs to the
              // address bar being edited rather than to the page.
              preview || draft
                ? h('button', { type: 'button', className: 'dsa-btn dsa-icon-btn', title: t('panel.cancel'), 'aria-label': t('panel.cancel'), onClick: () => (draft ? onDraftCancel() : setComposing(false)) }, h(Icon, { name: 'close' }))
                : null,
            )
          : h(
              'button',
              {
                type: 'button',
                className: 'dsa-loc',
                // The tooltip carries the same address the label does, unstripped
                // by the bar's width. The label truncates from the left to keep
                // the route visible, so hovering is how the reader gets the whole
                // thing — including the part the narrow sidebar cut off.
                title: previewAddress(pageUrl || preview.url, preview.target),
                onClick: startEditing,
              },
              h(Icon, { name: 'globe' }),
              // Falls back to the preview's own URL until the page has reported:
              // the frame has to load before the overlay can say where it is, and
              // an empty chip in that window would look like a failure.
              //
              // `bdi` isolates the address from the bar's right-to-left clipping
              // direction. Without it the neutral characters in an address — the
              // `#` and `/` of a hash route — take the container's direction and
              // the tail renders out of order, so `#/guicom/command` would show
              // its separators on the wrong side.
              h('span', { className: 'dsa-loc-host' }, h('bdi', null, previewAddress(pageUrl || preview.url, preview.target))),
              h(Icon, { name: 'edit', size: 12 }),
            ),
        menu,
      )
    }

    /**
     * The strip of open pages, above the address bar.
     *
     * Browser-shaped on purpose: several pages open at once, one on screen, each with
     * its own address.
     *
     * It renders whenever a page is open — including when there is only ONE — because
     * it carries the "new page" button, and that button was the missing entry point:
     * the first version drew the strip only from two pages up, so with one page open
     * there was no way to ask for a second and the feature was unreachable.
     *
     * @param props - the open pages, the active one, and the five actions.
     * @returns the strip, or null when no page is open at all.
     */
    function TabStrip(props) {
      const { tabs, activeSid, onSelect, onClose, onNew, limit, draft, onDraftCancel } = props
      // A draft counts as something to draw. The reader's report: pressing "+" only
      // emptied the address bar, so there was nothing to see and no way to tell
      // "typing a new address" from "editing this one". A new page has to appear as a
      // new TAB, which is the only place the reader is looking for it.
      if ((!tabs || tabs.length === 0) && !draft) return null
      // The button stays usable at the limit, and says what will happen. Disabling it
      // would contradict the address bar, which reaches the SAME open path and there
      // evicts the oldest page — so the reader would be told "close one first" by one
      // control while another quietly closed one for them. One rule, stated.
      const full = tabs.length >= limit
      return h(
        'div',
        { className: 'dsa-tabs', role: 'tablist' },
        // The tab rows are drawn even for a single page, as a browser does. Hiding the
        // row you are on would make the strip jump the moment a second page arrives,
        // and with the "new page" button now living here the strip is present anyway,
        // so there is no height left to save by suppressing it.
        tabs.map((tab) => h(
          'div',
          {
            key: tab.sid,
            className: 'dsa-tab',
            // While a draft is open the blank tab is the selected one, exactly as a
            // browser selects the new tab you just opened. The page below stays put —
            // this panel keeps showing it rather than blanking the frame — so exactly
            // one tab may carry the selected look, or the reader sees two.
            'data-on': !draft && tab.sid === activeSid ? 'true' : undefined,
            role: 'tab',
            'aria-selected': !draft && tab.sid === activeSid ? 'true' : undefined,
          },
          h(
            'button',
            {
              type: 'button',
              className: 'dsa-tab-name',
              // The full address, since the label truncates: two pages of one app can
              // differ only in a route the narrow strip cuts off.
              title: previewAddress(tab.pageUrl || tab.url, tab.target),
              onClick: () => onSelect(tab.sid),
            },
            h('bdi', null, previewAddress(tab.pageUrl || tab.url, tab.target)),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsa-tab-x',
              title: t('panel.tabClose'),
              'aria-label': t('panel.tabClose'),
              onClick: (event) => {
                event.stopPropagation()
                onClose(tab.sid)
              },
            },
            h(Icon, { name: 'close', size: 12 }),
          ),
        )),
        // The blank tab. It is not a page — it has no sid, no iframe and no marks —
        // so it cannot reuse a real tab's element and is drawn dashed instead. It
        // exists to be SEEN: it is the answer to "did that open a new page or am I
        // editing the one I have".
        draft
          ? h(
              'div',
              {
                className: 'dsa-tab dsa-tab-draft',
                'data-on': 'true',
                role: 'tab',
                'aria-selected': 'true',
              },
              h('span', { className: 'dsa-tab-name', title: t('panel.tabDraftHint') }, t('panel.tabDraft')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsa-tab-x',
                  title: t('panel.tabDraftCancel'),
                  'aria-label': t('panel.tabDraftCancel'),
                  onClick: (event) => {
                    event.stopPropagation()
                    onDraftCancel()
                  },
                },
                h(Icon, { name: 'close', size: 12 }),
              ),
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            className: 'dsa-tab-new',
            title: (full ? t('panel.tabLimit') : t('panel.tabNew')).replace('{n}', String(limit)),
            'aria-label': (full ? t('panel.tabLimit') : t('panel.tabNew')).replace('{n}', String(limit)),
            onClick: onNew,
          },
          h(Icon, { name: 'plus', size: 12 }),
        ),
      )
    }

    /**
     * The discovered services and workspace pages.
     *
     * @param props - the lists and the open action.
     * @returns the lists.
     */
    function ServerLists(props) {
      const { servers, pages, onOpen } = props
      return h(
        'div',
        null,
        servers && servers.length
          ? h(
              'ul',
              { className: 'dsa-servers' },
              servers.slice(0, 12).map((server) =>
                h(
                  'li',
                  { key: server.origin, className: 'dsa-server' },
                  server.stack ? h(StackMark, { id: server.stack.id }) : h(Icon, { name: 'globe' }),
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => onOpen(server.origin + (server.path && server.path !== '/' ? server.path : '')),
                      title: server.title || `${server.origin}${server.path || '/'}`,
                    },
                    h('span', { className: 'dsa-server-name' }, serverLabel(server)),
                    server.stack ? h('span', { className: 'dsa-tag' }, server.stack.label) : null,
                  ),
                  server.path && server.path !== '/'
                    ? h('code', { className: 'dsa-path' }, server.path)
                    : null,
                  h('code', null, `:${server.port}`),
                ),
              ),
            )
          : null,
        pages && pages.length
          ? h(
              'div',
              null,
              h('p', { className: 'dsa-menu-label' }, t('panel.pages')),
              h(
                'ul',
                { className: 'dsa-servers' },
                pages.slice(0, 12).map((page) =>
                  h(
                    'li',
                    { key: page.path, className: 'dsa-server' },
                    h(Icon, { name: 'file' }),
                    h('button', { type: 'button', onClick: () => onOpen(page.path) }, h('span', { className: 'dsa-server-name' }, page.label)),
                  ),
                ),
              ),
            )
          : null,
      )
    }

    /**
     * The accent presets, as HSL channels.
     *
     * Deliberately a short list of presets rather than a free colour picker: the
     * accent has to stay legible as a 6px dot, a 2px ring drawn over arbitrary
     * page content, and a filled pin with white text. A picked hue can be any of
     * those things badly, and the reader has no way to know until a mark lands on
     * a background that fights it. These are the ones that survive all three.
     *
     * At module scope rather than inside `apply`, because the picker component is
     * defined out here and would otherwise close over nothing.
     */
    const ACCENTS = [
      { id: 'amber', label: '琥珀', value: '32 88% 65%' },
      { id: 'blue', label: '靛蓝', value: '215 90% 62%' },
      { id: 'green', label: '青竹', value: '152 62% 45%' },
      { id: 'violet', label: '紫藤', value: '268 72% 68%' },
      { id: 'rose', label: '蔷薇', value: '342 82% 65%' },
      { id: 'slate', label: '石墨', value: '215 16% 55%' },
    ]
    const DEFAULT_ACCENT = ACCENTS[0].value
    const ACCENT_KEY = 'dsh-annotate:accent'

    /**
     * The page each session had open, so a remounted panel can reopen it.
     *
     * The sidebar unmounts a tab body when the reader switches tabs, and the panel
     * comes back with empty state — including which page it was showing. The
     * preview itself survives that (the host keeps it for its idle window), but
     * without remembering the target the panel could only offer the reader a blank
     * "open a page" box, and the marks on that page went with it. Remembering one
     * string brings the frame, the page's own marks and the login session behind
     * them back together.
     *
     * Per session, because two conversations may be looking at two different pages.
     * @param sessionKey - the session the panel belongs to.
     * @returns the stored target, or an empty string.
     */
    function readOpen(sessionKey) {
      if (!sessionKey) return { targets: [], active: '' }
      try {
        const raw = localStorage.getItem(`dsh-annotate:open:${sessionKey}`)
        if (!raw) return { targets: [], active: '' }
        // The value used to be a bare target string. Upgrading in place rather than
        // versioning the key: a reader who had one page open gets exactly that page
        // back, and there is no second key to keep in step.
        //
        // The leading character is tested by CODE rather than against a brace
        // literal. `check-structure.mjs` guards these files with a raw brace count, so
        // an unpaired brace inside a string reads to it as a mangled splice — and that
        // blunt tripwire is worth more than this expression being prettier.
        if (raw.charCodeAt(0) !== 0x7b) return { targets: [raw], active: raw }
        const parsed = JSON.parse(raw)
        const targets = Array.isArray(parsed && parsed.targets)
          ? parsed.targets.filter((one) => typeof one === 'string' && one)
          : []
        const active = typeof (parsed && parsed.active) === 'string' ? parsed.active : ''
        return { targets, active: targets.indexOf(active) === -1 ? (targets[0] || '') : active }
      } catch (error) {
        void error
        return { targets: [], active: '' }
      }
    }

    /**
     * Remember the open tabs, so a remount brings the whole set back.
     *
     * A LIST now rather than one target: the panel can have several pages open, and
     * remembering only the active one would silently close the rest every time the
     * sidebar unmounted — which is every tab switch. `active` is stored so the
     * reader returns to the page they were looking at, not to the first one.
     * @param sessionKey - the session the tabs belong to.
     * @param targets - every open page, in strip order.
     * @param active - the target that was on screen.
     */
    function rememberOpen(sessionKey, targets, active) {
      if (!sessionKey) return
      try {
        const list = (Array.isArray(targets) ? targets : []).filter((one) => typeof one === 'string' && one)
        if (!list.length) localStorage.removeItem(`dsh-annotate:open:${sessionKey}`)
        else localStorage.setItem(`dsh-annotate:open:${sessionKey}`, JSON.stringify({ targets: list, active: active || '' }))
      } catch (error) {
        void error
      }
    }

    /**
     * The accent in force, readable outside React.
     *
     * The overlay config is assembled in helpers that are not re-created on every
     * accent change, so they read this rather than closing over a stale value.
     */
    let currentAccent = DEFAULT_ACCENT

    /**
     * Apply the accent and remember it.
     *
     * Written to the document element rather than to each plugin surface: the
     * capsule lives in the composer dock, the panel in the right sidebar, and the
     * preview overlay in a cross-origin iframe that reads it from its own config.
     * One custom property on the root reaches the first two together.
     * @param value - HSL channels.
     */
    function applyAccent(value) {
      currentAccent = value
      try {
        localStorage.setItem(ACCENT_KEY, value)
      } catch (error) {
        void error
      }
      const root = document.documentElement
      if (root && root.style) {
        const parts = String(value).split(' ')
        root.style.setProperty('--dsa-h', String(parts[0]))
        root.style.setProperty('--dsa-s', String(parts[1]))
        root.style.setProperty('--dsa-l', String(parts[2]))
      }
    }

    /**
     * Read the stored accent.
     *
     * A value that is not one of the presets is discarded rather than trusted: the
     * list is the contract, and an older build could have written something the
     * current one cannot render.
     * @returns the stored channels, or the default.
     */
    function readAccent() {
      try {
        const stored = localStorage.getItem(ACCENT_KEY)
        return ACCENTS.some((one) => one.value === stored) ? stored : DEFAULT_ACCENT
      } catch (error) {
        void error
        return DEFAULT_ACCENT
      }
    }

    /**
     * Whether the shell is currently rendering in its dark palette.
     *
     * Read from the attribute the theme service maintains on `<body>`
     * (`boot-theme.ts` toggles `data-ds-dark-theme`), not from
     * `prefers-color-scheme`: the shell has its own light/dark/system preference,
     * so the OS setting and the rendered theme disagree whenever the reader has
     * overridden it.
     * @returns true when the dark palette is active.
     */
    function darkMode() {
      try {
        const body = document.body
        if (body && typeof body.hasAttribute === 'function' && body.hasAttribute('data-ds-dark-theme')) return true
        // Fall back to the computed surface when the attribute is absent — an older
        // or differently-themed shell — rather than assuming light.
        const scheme = document.documentElement && document.documentElement.style
        if (scheme && scheme.colorScheme === 'dark') return true
        return false
      } catch (error) {
        void error
        return false
      }
    }

    function apply(ctx, config) {
      // Report what the context actually offers. A missing service used to be a
      // silent `return`, which made a mis-declared `inject` look like a plugin
      // that simply did nothing — the hardest kind of failure to diagnose from
      // the outside.
      const slots = ctx.get('slots')
      const sidebarRightTabs = ctx.get('sidebarRightTabs')
      const sidebarRight = ctx.get('sidebarRight')
      const sessions = ctx.get('sessions')
      // `uiConversation` is deliberately NOT sampled here. It is provided by
      // another row, and rows apply concurrently, so a sample taken now reads
      // `undefined` for a service that is merely still starting — see the chip
      // registration at the end of `apply`, which waits for it instead.

      console.info(
        '[dsh-annotate] activating; services:',
        JSON.stringify({
          slots: slots !== undefined,
          sidebarRightTabs: sidebarRightTabs !== undefined,
          sidebarRight: sidebarRight !== undefined,
          sessions: sessions !== undefined,
        }),
      )

      if (slots === undefined) {
        console.error(
          '[dsh-annotate] the slot service is missing, so no UI can be contributed. ' +
            'Check that package.json declares dsh.client.inject with @deepseek-ai/dsh-client-ui-slots.',
        )
        return
      }
      ctx.effect(() => injectStyles())
      // Restore the reader's accent as soon as the plugin loads, not when the tab is
      // first opened: the capsule lives in the composer and must already wear the
      // right colour on its very first render.
      ctx.effect(() => {
        applyAccent(readAccent())
      })

      /** state/model helpers shared with the host module lives per tab instance */

      const AnnotateTab = (props) => {
        const [annotations, setAnnotations] = React.useState([])
        const [servers, setServers] = React.useState([])
        const [pages, setPages] = React.useState([])
        const [detecting, setDetecting] = React.useState(false)
        const [url, setUrl] = React.useState('')
        /**
         * Whether the address bar is expanded to take a new address.
         *
         * Held here rather than inside the bar because the tab strip's "new page"
         * button opens it, and that button is a sibling: with the state private to the
         * bar, `+` could not reach it.
         */
        const [composing, setComposing] = React.useState(false)
        /**
         * Whether the address being typed is for a page that does not exist yet.
         *
         * `composing` alone cannot say this, and that ambiguity is what the reader
         * reported: it is set both by clicking the address chip to edit the CURRENT
         * page and by pressing "+", so the two look identical — an open, empty text
         * field — and the reader could not tell whether Enter would navigate this tab
         * or add one. This flag is the difference, and it is what draws the blank tab.
         *
         * Cleared when the page opens, and when the draft is discarded. Never true
         * while a preview is being edited in place.
         */
        const [draft, setDraft] = React.useState(false)
        /**
         * The same flag, readable from a continuation.
         *
         * `settleDraft` runs after an `await`, by which time the render that closed
         * over `draft` is long gone and its value is the one from before the request.
         * The ref is written on every render so the helper sees what is true now.
         */
        const draftRef = React.useRef(false)
        draftRef.current = draft
        /**
         * The open pages, and which one is on screen.
         *
         * This was a single `preview`, because the panel allowed one page. The pages
         * themselves were never the limit — the host has always held a Map of previews
         * and never closes one to make room for another — so what follows is almost
         * entirely about giving the panel more than one slot and keeping the marks
         * attributed to the slot they came from.
         *
         * Each entry is a preview record plus the per-page state that used to be
         * panel-wide: its route, its marking mode, and its reload nonce.
         */
        const [tabs, setTabsState] = React.useState([])
        const [activeSid, setActiveSid] = React.useState('')
        const [toast, setToast] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [accent, setAccent] = React.useState(readAccent)
        // Marking is the PANEL's mode, not each page's.
        //
        // It used to live on the per-page record, which made toggling
        // 选取 an act on whichever page happened to be on screen: the reader turns
        // marking on, switches tab, and the button is off again while the first page
        // is still capturing clicks. The reader's own reading of a tab strip is the
        // right one — the tabs differ in CONTENT, but every one of them is a page to
        // annotate — so the mode is one fact about the panel and it is broadcast to
        // every open page, which is also what makes the button's own state honest.
        const [mode, setModeState] = React.useState('idle')
        // Read synchronously by the message handler, which must compare a page's
        // report against the mode in force NOW rather than against a stale render.
        const modeRef = React.useRef('idle')
        const [unplaced, setUnplaced] = React.useState({ count: 0, total: 0, items: [] })
        // One ref per open page, so a message can be aimed at the page it belongs to
        // rather than at whatever happens to be on screen.
        const frameRefs = React.useRef(new Map())
        const nonce = React.useRef(0)
        const reopened = React.useRef(false)

        /** The page on screen. Everything that used to read `preview` reads this. */
        const preview = tabs.find((tab) => tab.sid === activeSid) || null
        const pageUrl = preview ? preview.pageUrl || '' : ''

        /**
         * The preview record the reopen path compares against.
         *
         * A ref rather than the rendered value because an async continuation can
         * outlive the render that started it, and it has to compare against the page
         * that is open NOW.
         */
        const previewRef = React.useRef(null)
        previewRef.current = preview
        currentAccent = accent

        /** Replace one page's record, leaving the others alone. */
        const patchTab = (sid, patch) => setTabs((list) => list.map((tab) => (
          tab.sid === sid ? Object.assign({}, tab, patch) : tab
        )))
        const setPageUrl = (value) => setTabs((list) => list.map((tab) => (
          tab.sid === activeSid ? Object.assign({}, tab, { pageUrl: value }) : tab
        )))

        /**
         * The open pages, written through a ref so the handlers see the truth
         * immediately.
         *
         * `useState` alone is not enough. Opening pages is a sequence of awaits —
         * `/open`, then the tab list — and `tabs` only changes on the next render, so
         * two pages opened in the same tick both read the SAME stale list and the
         * second one's `setTabs([...stale, record])` silently dropped the first. The
         * reader asked for a second page and got one page.
         *
         * `tabsRef.current` is therefore the authority: every mutation writes it
         * synchronously and then mirrors it into state for rendering. Reading
         * `tabsRef.current` is always current, from any continuation.
         */
        const tabsRef = React.useRef([])
        const setTabs = (next) => {
          const list = typeof next === 'function' ? next(tabsRef.current) : next
          tabsRef.current = list
          setTabsState(list)
        }
        // A render is the only other writer: it publishes the committed state back,
        // which keeps the two in step if React ever batches a change behind us.
        tabsRef.current = tabs
        const activeSidRef = React.useRef('')
        activeSidRef.current = activeSid

        /**
         * Which page each mark came from, and the marks of pages since closed.
         *
         * Without this the panel cannot tell marks apart when two pages are open.
         * Several tabs can legitimately sit on the SAME route — the same app opened
         * twice, or two services both serving `/` — and then `page` alone identifies
         * nothing: the first page's pins would be drawn on the second, because both
         * the route and the selector match.
         *
         * The host still holds ONE batch per session, because the reader's mental
         * model is one message carrying everything they pointed at across the pages
         * they had open. So the per-page lists are kept apart here and flattened into
         * that one batch.
         */
        const tabMarks = React.useRef(new Map())
        /**
         * Marks from pages the reader has closed.
         *
         * Kept rather than dropped: closing a tab is navigation, not a decision to
         * discard what was written on that page. They stay in the batch and in the
         * list, labelled with the page they came from.
         *
         * They are NOT claimed as located. A selector can only be resolved by the
         * document it was taken from, and that document is gone — so the entry keeps
         * the match count observed while the page was still open and is marked as
         * coming from a closed page, rather than asserting a position nobody can
         * check any more. The model is told the truth instead of being handed a
         * selector that may or may not still resolve.
         */
        const closedMarks = React.useRef(new Map())

        /** Flatten every page's marks into the one batch the host holds. */
        const flattenMarks = () => {
          const out = []
          for (const tab of tabsRef.current) {
            const list = tabMarks.current.get(tab.sid)
            if (Array.isArray(list)) out.push(...list)
          }
          for (const [sid, record] of closedMarks.current) {
            const list = record && Array.isArray(record.marks) ? record.marks : []
            out.push(...list.map((entry) => Object.assign({}, entry, {
              closed: true,
              fromTab: (record && record.target) || '',
            })))
          }
          return out
        }
        // Read by `closeTab` and `openTarget`, both of which are declared before the
        // list is written back and must not close over a stale one.
        const flattenMarksRef = React.useRef(flattenMarks)
        flattenMarksRef.current = flattenMarks

        // `openTarget` is rebuilt on every render, so an effect that depended on it
        // would re-run on every render. The heartbeat reaches it through this ref,
        // which keeps the effect keyed on the tab count alone while still calling the
        // current closure.
        const openTargetRef = React.useRef(null)

        /** How many pages may be open at once. */
        const TAB_LIMIT = 4

        /**
         * The workspace root comes from the shell's workspace snapshot, matched
         * to this tab by session. `useWorkspaces` is not part of the sidebar
         * tab slot's kit, so read it off the global seat when the shell
         * provides one and fall back to detection without a root.
         */
        const useWorkspaces = props.useWorkspaces || (typeof window !== 'undefined' && window.__DSH_USE_WORKSPACES__)
        const workspaceItems = useWorkspaces ? useWorkspaces((snapshot) => snapshot.items) : undefined
        const root = React.useMemo(() => {
          const list = Array.isArray(workspaceItems) ? workspaceItems : []
          if (!list.length) return ''
          const mine = list.find((item) => item && Array.isArray(item.sessionIds) && item.sessionIds.indexOf(props.sessionId) !== -1)
          return (mine && mine.path) || (list[0] && list[0].path) || ''
        }, [workspaceItems, props.sessionId])

        /**
         * Mirror the annotations to the host, which is what turns them into
         * runtime context for the next turn.
         *
         * This runs on every change rather than at submit time: the host holds
         * the block, so a submission that the sidebar never sees still carries
         * the annotations. Failures are swallowed on purpose — a preview that
         * cannot reach its own host should still be usable for marking, and the
         * host simply contributes nothing when it has nothing.
         */
        const sessionKey = props.sessionId || ''

        /**
         * The last payload the host was told about.
         *
         * Guarded against the initial empty state: reporting on every render of
         * `annotations` was wrong in a way that mattered — before a preview is
         * open the state is empty, so the first render posted an empty list and
         * cleared whatever the host held.
         */
        const reported = React.useRef(null)

        /**
         * What the host is known to be holding right now.
         *
         * The host is the side that decides what rides along with the next message,
         * and the composer capsule reads it directly — so the panel has to be able
         * to agree with it. Kept as a ref rather than compared through state
         * because it is consulted from an event handler that has no fresh render.
         *
         * It exists because a page can legitimately report an empty list while the
         * host holds marks: the preview is reaped after an idle window and the next
         * open builds a fresh origin whose storage is empty, but the marks the
         * reader attached are still attached. Taking that empty report at face value
         * would clear the attachment the reader can see counted in the capsule.
         */
        const hostHeld = React.useRef([])

        /**
         * Reduce received annotations to the fields the host renders.
         *
         * The entries arrive over postMessage from a framed page, so nothing
         * about their shape is guaranteed. A throw here used to unmount the tab
         * and blank the sidebar, so a malformed entry is dropped rather than
         * dereferenced.
         *
         * Ordered the way the panel lists them, because the host numbers its
         * `## Element n` headings by position in this array: sending the list in
         * arrival order made the block call an element 2 that the panel and its
         * pin both called 1. The reader says "element 2" and means the row they
         * are looking at, so all three surfaces have to agree — including across
         * navigation, which is why the number is a mark's place in the session
         * list rather than a count of what a given page can draw.
         * @param list - annotations as received.
         * @returns the fields worth sending, in reading order.
         */
        const toReport = (list) => inReadingOrder(usable(list))
          .map((entry) => ({
            selector: typeof entry.selector === 'string' ? entry.selector : '',
            text: typeof entry.text === 'string' ? entry.text : '',
            note: typeof entry.note === 'string' ? entry.note : '',
            at: entry.doc && typeof entry.doc === 'object'
              ? `${entry.doc.x},${entry.doc.y} ${entry.doc.w}×${entry.doc.h}`
              : (typeof entry.at === 'string' ? entry.at : ''),
            matches: typeof entry.selectorMatches === 'number' ? entry.selectorMatches : 1,
            // The view the mark was made on. The list spans the whole browsing
            // session — the reader navigates and keeps marking — so the host needs
            // this to tell two screens of one app apart when it renders the block.
            page: typeof entry.page === 'string' ? entry.page : '',
            // A mark whose page has been closed still rides along to the model, but it
            // is flagged rather than passed off as located: `matches` is the count seen
            // while that page was still open, and only the originating document could
            // resolve the selector again. Saying so is what stops the model reading a
            // stale count as a fact about the page it is being asked to edit.
            closed: entry.closed === true ? true : undefined,
            fromTab: entry.closed === true && typeof entry.fromTab === 'string' ? entry.fromTab : undefined,
          }))

        /**
         * Send a batch to the host and confirm it took them.
         *
         * The host holds annotations per session and clears them after a turn
         * consumes them, so this is the only way the panel can know what the
         * composer indicator will show.
         *
         * An empty list is a legitimate payload — it is how the reader's "clear
         * all" reaches the host — so it is sent rather than short-circuited.
         * @param list - annotations to hand over; empty to clear.
         * @returns the count the host reports holding, or null on failure.
         */
        const reportAnnotations = async (list) => {
          if (!sessionKey) return null
          const payload = toReport(list)
          try {
            const res = await fetch(`${API}/context`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ session: sessionKey, annotations: payload }),
            })
            const data = await res.json()
            if (!data || data.ok !== true) return null
            // Record the signature of what was just sent.
            //
            // The list is mirrored rather than cleared on send, so the panel's
            // next state normally matches this signature and the effect below
            // stays quiet. Recording it is what keeps a single report from
            // bouncing back as a second one; recording anything else would make
            // the panel's own state change look like fresh news from the page.
            reported.current = JSON.stringify(payload)
            return typeof data.count === 'number' ? data.count : payload.length
          } catch (error) {
            void error
            return null
          }
        }

        // Only a change the panel itself observed is worth reporting.
        React.useEffect(() => {
          if (!sessionKey) return
          const payload = toReport(annotations)
          const signature = JSON.stringify(payload)
          if (reported.current === null && payload.length === 0) {
            reported.current = signature
            return
          }
          if (reported.current === signature) return
          reported.current = signature
          // What the host is about to hold. Kept in step at the moment of the
          // report rather than guessed at later, because the restore path treats a
          // non-empty mirror as evidence that these marks are still attached.
          hostHeld.current = payload
          let cancelled = false
          const timer = setTimeout(() => {
            fetch(`${API}/context`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ session: sessionKey, annotations: payload }),
            }).catch((error) => {
              if (!cancelled) void error
            })
          }, 120)
          return () => {
            cancelled = true
            clearTimeout(timer)
          }
        }, [annotations, sessionKey])

        /**
         * Ask the host what it is holding, and adopt it when the panel has nothing.
         *
         * This is the other half of the mount guard above. That guard stops a fresh
         * panel from reporting an empty list and wiping the host; on its own it left
         * the panel showing nothing while the composer capsule went on counting the
         * marks the host still held — the reader's "侧边栏里的所有标注都已经消失了"
         * next to a capsule that disagreed. Reporting silently was only half the
         * story: a remounted panel also has to *listen*.
         *
         * A page that reports its own marks is still authoritative — this only fills
         * the gap while there is no page, or none that remembers.
         */
        React.useEffect(() => {
          if (!sessionKey) return undefined
          let cancelled = false
          const adopt = async () => {
            try {
              const res = await fetch(`${API}/pending`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ session: sessionKey }),
              })
              const data = await res.json()
              if (cancelled || !data || data.ok !== true) return
              const held = Array.isArray(data.annotations) ? data.annotations : []
              hostHeld.current = held
              if (!held.length) return
              // Ids are invented here because the entries crossed as a report, not as
              // page state: the panel lists and removes by id, and the page's own
              // report replaces these with its real ids the moment it arrives.
              const adopted = held.map((entry, index) => Object.assign({}, entry, {
                id: `h${index}-${String(entry.selector || '')}`,
              }))
              // Recorded as already reported, and recorded BEFORE the state change is
              // handed to React: the host is holding exactly this, so re-uploading it
              // would be a no-op round trip, and the reporting effect must not mistake
              // the adoption for news from the page.
              reported.current = JSON.stringify(toReport(adopted))
              setAnnotations((current) => (usable(current).length ? current : adopted))
            } catch (error) {
              void error
            }
          }
          void adopt()
          return () => {
            cancelled = true
          }
        }, [sessionKey])


        const flash = (message) => {
          setToast(message)
          window.setTimeout(() => setToast(''), 2600)
        }

        /**
         * Send a message to one page, or to the page on screen when none is named.
         *
         * Aimed per tab rather than at "the frame": with several open, a message meant
         * for the page the reader is editing must not land on a different one, and a
         * message meant for a background page (a keep/purge after a delete) has to
         * reach it even though it is not the active one.
         */
        const postToPage = (payload, sid) => {
          const target = sid || activeSidRef.current
          const frame = frameRefs.current.get(target)
          const win = frame && frame.contentWindow
          if (!win) return
          const tab = tabsRef.current.find((one) => one.sid === target)
          win.postMessage(Object.assign({ source: PANEL_CHANNEL }, payload), tab ? tab.origin : '*')
        }

        /**
         * Empty EVERY open page, not just the one on screen.
         *
         * `postToPage` without a sid aims at the active page, which was right while
         * there was only ever one. With a tab strip it silently stopped meaning
         * "clear the marks": the background pages kept theirs, and because the list
         * is the FLATTENED union of every page's marks, the next report from any
         * page rebuilt the list out of the pages that had never been emptied. The
         * reader cleared the annotations, watched the list refill, and the composer
         * went on counting a batch the turn had already carried. Three call sites
         * had this shape — release-after-send, the count popup's bulk clear, and
         * "clear all" — so the sweep lives here rather than being repeated.
         */
        const purgeEveryPage = () => {
          for (const tab of tabsRef.current) postToPage({ type: 'purge' }, tab.sid)
        }

        /**
         * Forget what every page was holding.
         *
         * Purging the pages is only half of it: this panel's own per-page mirror is
         * what the list is flattened from, so leaving it populated means the next
         * `ready` or `changed` from any page re-derives the very marks that were
         * just released. The two sides have to be emptied together or the mirror
         * wins by arriving second.
         */
        const forgetAllMarks = () => {
          tabMarks.current.clear()
          closedMarks.current.clear()
        }

        const onDetect = React.useCallback(async () => {
          if (!root) return
          setDetecting(true)
          try {
            const res = await fetch(`${API}/detect`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ root }),
            })
            const data = await res.json()
            setServers(data.servers || [])
            setPages(data.pages || [])
          } catch (error) {
            void error
          } finally {
            setDetecting(false)
          }
        }, [root])

        React.useEffect(() => {
          void onDetect()
        }, [onDetect])

        // The framed page reports what it has; the panel never reaches into it.
        //
        // The list is mirrored rather than owned. Marks are persisted by the page
        // per session and page path, so navigating away and back must not look
        // like the marks were discarded — the page is the durable side and this
        // is its view.
        React.useEffect(() => {
          const onMessage = (event) => {
            const data = event.data
            if (!data || data.source !== OVERLAY_CHANNEL) return
            // Which page is speaking. Matched by origin rather than assumed to be the
            // active one: several pages report on boot, and each one's marks belong to
            // its own tab. Accepting a message from an origin the panel does not have
            // open is what would let an unrelated frame inject marks.
            const tab = tabsRef.current.find((one) => one.origin === event.origin)
            if (!tab) return
            const mine = tab.sid === activeSidRef.current
            if (data.type === 'ready' || data.type === 'changed') {
              // `ready` is the page announcing that it exists and is listening. That
              // is the first moment it can be told the panel's marking mode, and it
              // is exactly what a page booting into a marking panel needs: the reader
              // turned 选取 on, then opened or reloaded a page, and the new document
              // starts idle. `changed` is not a boot, so it is left alone.
              if (data.type === 'ready') {
                postToPage({ type: 'mode', mode: modeRef.current }, tab.sid)
              }
              // Which list wins, and whether the page is handed its marks back, is
              // decided by `batchFromPage` — see its comment for why an empty
              // `changed` must NOT be treated as a page that lost its storage.
              const outcome = batchFromPage({
                type: data.type,
                incoming: data.annotations,
                held: hostHeld.current,
              })
              if (outcome.restore) {
                postToPage({ type: 'restore', annotations: outcome.restore }, tab.sid)
              }
              // Ids are invented for marks that crossed as a report rather than as
              // page state: the panel lists and removes by id, and the page's own
              // report replaces these with its real ids the moment it arrives.
              const adopted = outcome.adopted
                ? outcome.adopt.map((entry, index) => Object.assign({}, entry, {
                  id: `h${index}-${String(entry.selector || '')}`,
                }))
                : outcome.adopt
              // Filed under the page that reported them, so the list can be rebuilt
              // from every open page rather than only the one on screen. Two pages can
              // share a route and a selector, so the tab is part of a mark's identity.
              tabMarks.current.set(tab.sid, adopted)
              if (mine) setAnnotations(flattenMarksRef.current())
              // The page reports its own address on boot and after every route
              // change, which is what keeps the address bar honest while the
              // reader navigates inside the frame.
              if (typeof data.url === 'string' && data.url) patchTab(tab.sid, { pageUrl: data.url })
            } else if (data.type === 'mode') {
              // A page can leave marking on its own — Escape is handled inside the
              // frame — and that is a panel-wide fact now, so it is adopted rather
              // than filed against the page that reported it.
              //
              // Compared before acting, which is what stops a loop: `setPageMode`
              // broadcasts, every page echoes its new mode back, and without this
              // guard each echo would broadcast again forever. After the first
              // adoption the reported mode matches and the echo is inert.
              const reported = data.mode === 'marking' ? 'marking' : 'idle'
              if (reported !== modeRef.current) setPageMode(reported)
            } else if (data.type === 'missing') {
              flash(t('panel.missing'))
            } else if (data.type === 'unplaced') {
              // The page could not draw a pin for some of the annotations. Saying so
              // is what turns "the count went up and no number appeared" from a
              // mystery into a fact the reader can act on.
              //
              // Reported only by the page on screen: a background page's unplaced
              // marks are not what the reader is looking at, and warning about them
              // would send them hunting for a mark on the wrong document.
              if (mine) {
                setUnplaced({
                  count: Number(data.count) || 0,
                  total: Number(data.total) || 0,
                  items: Array.isArray(data.items) ? data.items : [],
                })
              }
            }
          }
          window.addEventListener('message', onMessage)
          return () => window.removeEventListener('message', onMessage)
        })

        const openTarget = async (target, options) => {
          if (!target) return
          setBusy(true)
          // The draft became a page, so the blank tab goes — whether the host built a
          // new preview or was already holding this one. Done on the way out rather
          // than at each success site so a failure leaves the draft standing for the
          // reader to correct the address in.
          //
          // Guarded on `draft`, and that guard is load-bearing rather than tidy: this
          // function is also reached by the reopen effect and by the discovery lists,
          // where there is no draft and the address bar's state is none of its
          // business. Clearing `composing` unconditionally meant any open at all
          // collapsed an address the reader was part-way through editing — and it hid
          // a real regression, because it wiped the seeded state a check was measuring.
          const settleDraft = () => {
            if (!draftRef.current) return
            setDraft(false)
            setComposing(false)
          }
          try {
            const res = await fetch(`${API}/open`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ url: target, root, accent }),
            })
            const data = await res.json()
            if (!data.ok) {
              flash(data.code === 'notLocal' ? t('panel.notLocal') : data.error || 'failed')
              return
            }
            // Past this point the page is real, so the blank tab has served its
            // purpose and goes. Done here rather than at each success site so a
            // FAILED open leaves the draft standing with the address still in it,
            // which is where the reader needs it to fix a typo.
            settleDraft()
            nonce.current += 1
            // The host REUSES a preview for a target that is already open and answers
            // with the sid it already had. That is the same page, so it must not be
            // added a second time: a second entry would draw a second iframe on one
            // preview and split that page's marks between two owners.
            const known = tabsRef.current.find((tab) => tab.sid === data.sid)
            if (known) {
              patchTab(data.sid, { nonce: nonce.current, url: data.url, target })
              // Bringing an existing page to the front is not the reader discarding
              // anything, so the list is left exactly as it is. Nothing here clears
              // marks: a refresh and the remount after a tab switch both land in this
              // branch, and blanking the list would make the mirror effect report an
              // empty batch — the host would drop it, advance its epoch, and the dock
              // would purge the page, destroying the marks this exists to keep.
              if (data.sid !== activeSidRef.current) setActiveSid(data.sid)
              // NOT `setMode('idle')`. The mode belongs to the panel now, and a
              // reloaded page coming back must be told what it is — clearing it here
              // would turn the reader's 选取 off as a side effect of a refresh.
              postToPage({ type: 'mode', mode: modeRef.current }, data.sid)
              return
            }
            // A page whose tab was closed and is now reopened takes its marks back.
            // They were never discarded, and re-opening the same address is the reader
            // returning to them rather than starting over.
            const parked = closedMarks.current.get(data.sid)
            if (parked) {
              closedMarks.current.delete(data.sid)
              if (Array.isArray(parked.marks) && parked.marks.length) {
                tabMarks.current.set(data.sid, parked.marks.map((entry) => Object.assign({}, entry, { closed: false })))
              }
            }
            const record = {
              origin: data.origin,
              url: data.url,
              sid: data.sid,
              nonce: nonce.current,
              target,
              pageUrl: '',
            }
            // At the limit the oldest page goes, and the reader is told rather than
            // left to notice a tab missing. Its marks are parked like any other closed
            // page, so nothing the reader wrote is lost by opening one more.
            let next = tabsRef.current
            if (next.length >= TAB_LIMIT && next.length) {
              const oldest = next[0]
              const marks = tabMarks.current.get(oldest.sid)
              if (Array.isArray(marks) && marks.length) {
                closedMarks.current.set(oldest.sid, { marks, target: oldest.target || oldest.url })
              }
              tabMarks.current.delete(oldest.sid)
              next = next.slice(1)
              try {
                await fetch(`${API}/close`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ sid: oldest.sid }),
                })
              } catch (error) {
                void error
              }
              flash(t('panel.tabEvicted').replace('{n}', String(TAB_LIMIT)))
            }
            setTabs([...next, record])
            setActiveSid(data.sid)
            // The mode is asserted when the page says it is ready, not here: the
            // iframe has only just been recorded, so there is no `contentWindow` to
            // post to yet and a message sent now would be dropped in silence.
            // Remembered so a remount — a tab switch, a reload — reopens the whole set
            // rather than a blank box. Written here rather than in an effect so the
            // stored targets are the ones that actually opened.
            rememberOpen(sessionKey, [...next, record].map((tab) => tab.target || tab.url), target)
          } catch (error) {
            flash(String((error && error.message) || error))
          } finally {
            setBusy(false)
          }
        }

        // The current `openTarget`, published for the effects that must call it without
        // depending on its identity. Assigned here because this is where it is defined.
        openTargetRef.current = openTarget

        /**
         * Close one page, keeping every mark that was made on it.
         *
         * Not a destructive action, so it is not confirmed: the marks stay in the
         * batch and in the list. Only the page and its pins go away, which is why
         * closing a tab needs no "are you sure" — there is nothing to be sure about.
         *
         * The marks are labelled as coming from a closed page rather than claimed as
         * located, because the only document that could resolve their selectors is
         * the one being closed.
         */
        const closeTab = async (sid) => {
          const tab = tabsRef.current.find((one) => one.sid === sid)
          if (!tab) return
          const marks = tabMarks.current.get(sid)
          if (Array.isArray(marks) && marks.length) {
            closedMarks.current.set(sid, { marks, target: tab.target || tab.url })
          }
          tabMarks.current.delete(sid)
          const rest = tabsRef.current.filter((one) => one.sid !== sid)
          setTabs(rest)
          // The neighbour takes over, so the panel is never left without a page while
          // tabs remain — and the reader lands next to where they were.
          const nextActive = activeSidRef.current === sid
            ? (rest.length ? rest[rest.length - 1] : null)
            : rest.find((one) => one.sid === activeSidRef.current) || null
          if (nextActive && nextActive.sid !== activeSidRef.current) setActiveSid(nextActive.sid)
          if (!nextActive) setActiveSid('')
          rememberOpen(sessionKey, rest.map((one) => one.target || one.url), nextActive ? (nextActive.target || nextActive.url) : '')
          // The host's proxy is released too. Its 5-minute idle sweep would get it
          // eventually, but leaving it holds a port and a socket for a page the reader
          // has finished with.
          try {
            await fetch(`${API}/close`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sid }),
            })
          } catch (error) {
            void error
          }
          setAnnotations(flattenMarksRef.current())
        }

        /**
         * Reopen the page this session was last showing.
         *
         * The tab body is unmounted whenever the reader switches tabs, and it comes
         * back with empty state, so without this the panel reopened on a blank box
         * and the reader had to find their page again — which is exactly the
         * "完全没有记忆" they reported. The host keeps the preview itself for its
         * idle window, so asking for the same target normally reuses the existing
         * one: same origin, same storage, same login, same marks.
         *
         * Every remembered page is reopened, not just the active one: the reader left
         * several tabs open, and bringing back one of them would silently close the
         * rest on every sidebar tab switch.
         *
         * Declared after `openTarget` so the ref it calls is already published. It is
         * keyed on the session alone: `openTarget` is rebuilt every render, and
         * depending on it would re-run this effect (harmlessly, behind the `reopened`
         * guard, but for no reason) on every keystroke.
         */
        React.useEffect(() => {
          if (reopened.current || !sessionKey) return
          const remembered = readOpen(sessionKey)
          if (!remembered.targets.length) return
          reopened.current = true
          // `keepMarks`, because this reopens pages the reader never left.
          //
          // On a remount there is no `tabs` state to compare against — the whole
          // component was unmounted — so the "same target" test cannot fire here. And
          // the list may already have been adopted from the host a moment ago, by the
          // effect above, precisely because the marks outlived the panel. Clearing it
          // would report an empty list, the host would drop the batch and advance its
          // epoch, and the dock would purge the page: a tab switch would destroy the
          // attachment it was supposed to preserve.
          void (async () => {
            for (const target of remembered.targets) {
              await openTargetRef.current(target, { keepMarks: true })
            }
            // The page the reader was looking at comes back to the front. Done after
            // the loop because `openTarget` activates whatever it opens, so the last
            // one opened would otherwise win for no reason the reader chose.
            if (remembered.active) {
              const match = tabsRef.current.find((tab) => (tab.target || tab.url) === remembered.active)
              if (match) setActiveSid(match.sid)
            }
          })()
        }, [sessionKey])

        /**
         * Switch marking on or off for the WHOLE panel.
         *
         * Written through `modeRef` first so the message handler and the Escape
         * listener see the new value without waiting for a render, and broadcast to
         * every open page rather than to the one on screen: a page that is not
         * looking at the button still has to know whether a click on it means
         * "annotate this" or "press this control".
         */
        const setPageMode = (next) => {
          const value = next === 'marking' ? 'marking' : 'idle'
          modeRef.current = value
          setModeState(value)
          for (const tab of tabsRef.current) postToPage({ type: 'mode', mode: value }, tab.sid)
        }

        /**
         * Change the mark colour.
         *
         * Three surfaces have to agree, and they are reached three different ways:
         * the CSS variable covers the shell's own UI, the host has to be told so a
         * preview opened later carries it, and the open page gets a message so the
         * reader does not have to reload and lose what they have marked.
         */
        const changeAccent = (value) => {
          setAccent(value)
          applyAccent(value)
          postToPage({ type: 'accent', accent: value })
        }

        const onEdit = (id, how) => {
          if (how === 'hover') postToPage({ type: 'focus', id })
          else postToPage({ type: 'edit', id })
        }

        const onRemove = (id) => {
          // Computed from the rendered list rather than inside a state updater.
          // React may invoke an updater more than once, and this posts a message
          // and rewrites the host mirror — side effects belong outside it.
          const next = annotations.filter((entry) => entry.id !== id)
          // The page draws the pins, so a mark removed here has to be removed
          // there too. Without this the panel's list and the page's store simply
          // disagreed, and the page won: its next `changed` report mirrored the
          // mark straight back, so a delete looked like it had been undone by
          // itself.
          //
          // The whole remaining list is handed over rather than the one id,
          // because the two sides label the same mark differently: the panel
          // lists by the id the page gave it, while an adopted entry carries an
          // id invented here for a report that crossed without one. Matching on
          // identity — selector, note, route — is the only comparison both sides
          // can make, and the page already does exactly that when it merges.
          const payload = toReport(next)
          hostHeld.current = payload
          postToPage({ type: 'keep', annotations: payload })
          setAnnotations(next)
        }

        const onRemoveAll = () => {
          setAnnotations([])
          // The mirror empties with the list. Purging the page while still
          // claiming to hold a batch is the exact condition the restore path
          // reacts to, and it would hand every mark straight back.
          hostHeld.current = []
          // Every page and the per-page mirror, for the same reason: the list is
          // their union, so a page left un-purged refills it on its next report.
          forgetAllMarks()
          // `purge`, not `key`: `key` only leaves marking mode, so using it here
          // left the page's own list intact and the next marking session mirrored
          // it back — which looked like the reader's earlier marks being replaced.
          purgeEveryPage()
        }

        /**
         * Let go of the list because the host already has.
         *
         * The host drops the annotations when the turn that carried them ends. The
         * panel is not told, so it would go on showing marks that are no longer
         * attached, and its next report would upload them again. The dock notices
         * the host's clear and calls this; the page is purged too, so the two sides
         * agree about what is marked.
         */
        const releaseFromHost = () => {
          setAnnotations([])
          reported.current = JSON.stringify([])
          // The host has let go of the batch, so the mirror of what it holds has
          // to go with it.
          //
          // This line is the whole fix for a mark that would not stay deleted. The
          // mirror was left holding the batch that had just been released, so the
          // purge sent to the page below emptied it, the page reported itself
          // empty, and that empty report met a `hostHeld` that still described the
          // marks — which is precisely the condition the restore path is written
          // to react to. It put every released mark back on the page, the page
          // re-reported them, and the host was handed the same batch again. The
          // reader deleted a mark and watched it come back, and the composer went
          // on counting marks the turn had already carried.
          hostHeld.current = []
          // EVERY page, and this panel's own per-page mirror with them. Aiming at
          // the active page alone left the background tabs holding their marks, and
          // the list is their flattened union — so the batch came straight back.
          forgetAllMarks()
          purgeEveryPage()
        }

        /**
         * Hand the annotations over.
         *
         * The host already holds them as runtime context, so neither action
         * writes anything into the draft: the reader's message stays entirely
         * their own text and the block arrives as a plugin-sourced snapshot
         * beside it. "Add to composer" therefore just marks the annotations as
         * taken and leaves the caret where the user was typing.
         *
         * An empty draft would produce a turn with no user text at all, which is
         * why the composer path nudges instead of silently doing nothing.
         */
        /**
         * Discard every mark.
         *
         * The only explicit action left in this panel. Marks reach the host as
         * they are made, so clearing has to reach the host too — otherwise the
         * composer would keep advertising annotations the reader had thrown away.
         */
        const clearAll = async () => {
          setBusy(true)
          try {
            await reportAnnotations([])
            setAnnotations([])
            hostHeld.current = []
            // "Clear all" means all of them, on whichever pages they were made —
            // not only on the page that happens to be on screen.
            forgetAllMarks()
            // `purge`, not `key`: the page holds the durable record and only this
            // explicit act should empty it.
            purgeEveryPage()
            flash(t('panel.cleared'))
          } catch (error) {
            void error
            flash(t('panel.clearFailed'))
          } finally {
            setBusy(false)
          }
        }

        /**
         * Answer the dock when it reports the host has cleared.
         *
         * Registered per session so a dock mounted for one conversation cannot
         * reset a panel showing another.
         */
        React.useEffect(() => {
          if (!sessionKey) return undefined
          panelReset.set(sessionKey, releaseFromHost)
          return () => {
            if (panelReset.get(sessionKey) === releaseFromHost) panelReset.delete(sessionKey)
          }
        }, [sessionKey, annotations])

        // Whether the marks have somewhere to go. A reader with no composer, or
        // with an empty box, has nothing for them to ride along with — handing
        // them over would leave context pointing at a message that never exists.
        // Escape leaves marking from wherever the pointer is.
        //
        // The page's own handler only fires while the frame holds focus, and
        // clicking "mark" in this panel leaves focus here — so the key did nothing
        // in exactly the situation the reader reaches for it. This listens at the
        // panel level and tells the page to stand down.
        React.useEffect(() => {
          if (mode !== 'marking') return undefined
          const onKey = (event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            setPageMode('idle')
          }
          window.addEventListener('keydown', onKey, true)
          return () => window.removeEventListener('keydown', onKey, true)
        }, [mode, setPageMode])

        // Two rows at most, and the second only exists before a page is open.
        // Everything that is not used on every visit lives behind the menu, so the
        // frame gets the height instead of the chrome.
        /**
         * Reload the preview by re-opening it, rather than re-pointing the iframe.
         *
         * Bumping a nonce on the existing URL only re-mounts the iframe. That works for
         * a workspace file, which is read from disk each time — but a loopback page is
         * served through an ephemeral proxy that the host closes once the preview goes
         * idle. Re-mounting then navigates to a dead port and the reader gets
         * "localhost 拒绝连接" instead of a refreshed page.
         *
         * Going back through `/open` reuses a live proxy and builds a fresh one when the
         * old is gone, so reload means the same thing either way.
         */
        const reloadPreview = async () => {
          const current = preview
          if (!current) return
          const target = current.target || current.url
          if (target) {
            await openTarget(target)
            return
          }
          patchTab(current.sid, { nonce: ++nonce.current })
        }

        /**
         * Keep every open page's preview alive.
         *
         * The host closes a preview whose `touched` is stale, and `touched` only
         * advances when the PREVIEW receives a request. With one page that was enough:
         * it was always on screen and every reload counted. With several open it is
         * not — a background tab issues no requests at all, so it would be reaped
         * mid-session and switching back to it would show "connection refused" for a
         * page the reader never closed.
         *
         * The host is told which sids are on screen rather than the frame being poked,
         * so this does not push traffic into the framed application. Well inside the
         * 5-minute idle window, so a missed beat is not fatal.
         *
         * Keyed on the tab COUNT, not on `openTarget`: that function is rebuilt on every
         * render, so depending on it re-ran this effect — and fired a beat — on every
         * render, which is a request per keystroke in the address bar. The reopen path
         * is reached through a ref for the same reason.
         */
        React.useEffect(() => {
          if (!tabs.length) return undefined
          let live = true
          const beat = async () => {
            const sids = tabsRef.current.map((tab) => tab.sid)
            if (!sids.length) return
            try {
              const res = await fetch(`${API}/touch`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sids }),
              })
              const data = await res.json()
              if (!live || !data || data.ok !== true) return
              // A preview the host no longer has cannot be revived by asking again, and
              // silently keeping the tab would leave the reader clicking a dead page.
              const gone = Array.isArray(data.missing) ? data.missing : []
              if (!gone.length) return
              for (const sid of gone) {
                const tab = tabsRef.current.find((one) => one.sid === sid)
                const target = tab && (tab.target || tab.url)
                // Only a page that CAN be reopened is reopened. A workspace file has a
                // url to ask for again; nothing else here does.
                if (target) await openTargetRef.current(target, { keepMarks: true })
              }
            } catch (error) {
              void error
            }
          }
          void beat()
          const timer = setInterval(beat, 60_000)
          return () => {
            live = false
            clearInterval(timer)
          }
        }, [tabs.length])

        const menu = h(PanelMenu, {
          servers,
          pages,
          onOpen: openTarget,
          onDetect,
          detecting,
          onClearAll: () => void clearAll(),
          count: annotations.length,
          accent,
          onAccent: changeAccent,
        })

        return h(
          'div',
          { className: 'dsa-panel' },
          h(
            'div',
            { className: 'dsa-bar' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsa-btn',
                'data-on': mode === 'marking' ? 'true' : undefined,
                onClick: () => setPageMode(mode === 'marking' ? 'idle' : 'marking'),
                disabled: !preview,
                title: mode === 'marking' ? t('panel.stopHint') : t('panel.markHint'),
              },
              h(Icon, { name: mode === 'marking' ? 'stop' : 'mark' }),
              mode === 'marking' ? t('panel.stop') : t('panel.mark'),
            ),
            // The count rides the toolbar and expands over the preview, so the
            // frame keeps its height whether the list is open or closed.
            annotations.length
              ? h(CountButton, {
                  annotations,
                  onEdit,
                  onRemove,
                  onRemoveAll: () => void clearAll(),
                  busy,
                })
              : null,
            // The address bar sits HERE, in the toolbar row, between the marking
            // controls and the page actions — it is the row's slack-taker, so the
            // toolbar no longer carries a spacer and a hole beside it.
            //
            // It used to be a sibling row below the tab strip, which made the two
            // read as one unit and left this row half empty. The reader asked for
            // the tabs and the address to be separate things: the tabs are a group,
            // the address is its own bar. This is that, and it is the arrangement
            // that costs no extra row, so the frame keeps its height.
            h(OpenBar, {
              onOpen: openTarget,
              onDetect,
              detecting,
              url,
              setUrl,
              preview,
              pageUrl,
              composing,
              setComposing,
              draft,
              onDraftCancel: () => {
                setDraft(false)
                setUrl('')
              },
            }),
            // Refresh sits beside the overflow menu rather than inside it.
            //
            // It is the one action a reader reaches for repeatedly while a page is
            // open, and burying a frequent action behind a click makes it feel
            // unavailable. An icon button costs the toolbar almost no width, and it
            // only appears when there is a page to refresh.
            preview
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsa-btn dsa-icon-btn',
                    onClick: () => void reloadPreview(),
                    title: t('panel.refresh'),
                    'aria-label': t('panel.refresh'),
                  },
                  h(Icon, { name: 'refresh' }),
                )
              : null,
            menu,
          ),

          // The tab strip is a row of its OWN, below the toolbar and above the page.
          // It is one group and the address bar is not part of it.
          h(TabStrip, {
            tabs,
            activeSid,
            onSelect: setActiveSid,
            onClose: (sid) => void closeTab(sid),
            limit: TAB_LIMIT,
            // Empty the box and open it. The address that is open now belongs to the
            // page on screen; typing a new one is asking for a DIFFERENT page, so
            // seeding it with the current address would invite an accidental reload
            // of the same one. It is also what makes the difference between "go to
            // this address again" and "open one more page" visible.
            onNew: () => {
              setUrl('')
              setComposing(true)
              // And a tab to type it in. Without this the only feedback was an empty
              // address bar, which is the same thing the reader sees when editing the
              // page they already have — so they could not tell the two apart.
              setDraft(true)
            },
            draft,
            onDraftCancel: () => {
              setDraft(false)
              setComposing(false)
              setUrl('')
            },
          }),

          // Shown only when the page could not place every pin. It sits between the
          // toolbar and the frame because that is where the discrepancy is: the
          // toolbar says how many are attached, the frame is where they should be
          // visible, and this is the sentence that reconciles the two.
          preview && unplaced.count > 0
            ? h(
                'div',
                { className: 'dsa-warn', role: 'status' },
                h(Icon, { name: 'radar' }),
                h(
                  'span',
                  null,
                  unplaced.count === unplaced.total
                    ? t('panel.unplacedAll').replace('{n}', String(unplaced.count))
                    : t('panel.unplacedSome')
                      .replace('{n}', String(unplaced.count))
                      .replace('{total}', String(unplaced.total)),
                ),
              )
            : null,

          // Every open page stays MOUNTED, with the ones behind hidden rather than
          // unmounted. Unmounting a background page would destroy its document, and
          // coming back to it would be a reload — losing the reader's scroll position,
          // any typed-but-unsaved state in the page, and its `sessionStorage`. The
          // cost is one live document per open tab, which is what the tab limit is for.
          //
          // Only the active one is shown; the rest are `display:none`. A hidden iframe
          // is still a loaded document and keeps its own timers, so it will not be
          // reaped by the host's idle sweep only because the heartbeat below says so.
          tabs.length
            ? h(
                'div',
                { className: 'dsa-frame' },
                tabs.map((tab) => h('iframe', {
                  key: `${tab.sid}:${tab.nonce}`,
                  ref: (node) => {
                    if (node) frameRefs.current.set(tab.sid, node)
                    else frameRefs.current.delete(tab.sid)
                  },
                  src: tab.url,
                  title: tab.target || tab.url,
                  // Only the visible page is in the accessibility tree and reachable by
                  // keyboard; a hidden one is marked as such rather than left ambiguous.
                  hidden: tab.sid !== activeSid,
                  sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals',
                })),
              )
            : h(
                'div',
                { className: 'dsa-frame dsa-empty-frame' },
                h(
                  'div',
                  { className: 'dsa-hint', 'data-center': 'true' },
                  h('p', { style: { margin: '0 0 4px' } }, t('panel.frameHint')),
                  h('p', { style: { margin: 0 } }, t('panel.noServers')),
                ),
              ),

          toast ? h('div', { className: 'dsa-toast' }, toast) : null,
        )
      }

      const openAnnotate = () => {
        try {
          if (sidebarRight && typeof sidebarRight.openTab === 'function') sidebarRight.openTab(KIND)
        } catch (error) {
          console.warn('dsh-annotate: could not open the sidebar tab', error)
        }
      }

      if (sidebarRightTabs && typeof sidebarRightTabs.register === 'function') {
        ctx.effect(() =>
          sidebarRightTabs.register({
            id: TAB_ID,
            kind: KIND,
            // This is a page type opened by kind, so it recognises no address
            // globs; `patterns` is deliberately absent.
            priority: 'extension',
            title: () => t('tab.title'),
            guide: [
              {
                order: 40,
                title: () => t('tab.title'),
                description: () => t('tab.description'),
              },
            ],
          }),
        )
      } else {
        console.warn('dsh-annotate: sidebarRightTabs is unavailable; the tab cannot register')
      }

      const contribute = (key, id, component, label, extra) => {
        try {
          slots.inject(key, () => slots.register(Object.assign({ name: key, id, label, order: 12 }, extra), component))
        } catch (error) {
          console.warn(`dsh-annotate: slot ${key} unavailable`, error)
        }
      }
      contribute('sidebar.right.pane.tab', TAB_ID, AnnotateTab, undefined, { key: TAB_ID })
      // Two different docks, and only one of them moves with the composer.
      //
      // `conversation.composer.dock` is rendered by InputBar itself, so it tracks
      // the input box wherever the input box goes. `conversation.input.dock` is
      // rendered by ConversationRoot against the scrollport instead, which is why
      // the capsule stayed put when the sidebar collapsed: it was anchored to the
      // conversation, not to the composer.
      contribute('conversation.input.dock', 'annotate-capsule', AnnotationCapsule, undefined, { key: 'annotate-capsule', order: 5 })

      // The transcript chip, in two registrations that must stay in step: the
      // renderer seat decides how a chip looks, and the Definition decides which
      // events get one.
      //
      // The seat is registered even when the service is missing, and the
      // Definition only with the service. That order is deliberate: a Definition
      // whose kind has no occupant in the keyed seat is not left blank by the
      // shell — it renders its own fallback, a JSON dump of the node data, in the
      // reader's transcript. So the seat goes in first and the Definition second,
      // and a missing `uiConversation` costs the chip and nothing else.
      contribute('conversation.chat.node', CHIP_KIND, AnnotationChip, undefined, { key: CHIP_KIND, order: 12 })

      // Wait for `uiConversation` rather than sampling it.
      //
      // This is the whole reason the chip was invisible while the tab and the
      // capsule worked. `uiConversation` is provided by another row, and rows
      // apply concurrently, so reading `ctx.get('uiConversation')` during this
      // callback returns `undefined` whenever that row happens to be slower —
      // not because the service is absent but because it has not started yet.
      // The old code branched on exactly that sample, skipped the registration,
      // and emitted one `console.warn` nobody reads. Nothing rendered, and
      // nothing failed, which is why it looked like a missing feature rather
      // than a race.
      //
      // `ctx.inject` is the framework's own answer: the callback runs once the
      // service is actually active, however late that is. It costs no boot
      // safety — a dependency that never arrives at all leaves this entry's fiber
      // ACTIVE, so the shell's own "did every entry activate" audit still passes
      // and the plugin degrades to tab-plus-capsule.
      try {
        ctx.inject(['uiConversation'], (scope) => {
          // Wrapped because the registry refuses a kind it already holds, and it
          // refuses by throwing. A reload that re-runs `apply` on a live registry
          // would otherwise take the whole sidebar down with it — the failure mode
          // worth more than the chip.
          try {
            scope.effect(() => registerChipDefinition(scope.uiConversation))
          } catch (error) {
            console.warn(
              'dsh-annotate: the transcript chip could not register; annotations still attach as context',
              error,
            )
          }
        })
      } catch (error) {
        console.warn('dsh-annotate: the transcript chip could not be wired to the conversation service', error)
      }

      const onKeyDown = (event) => {
        if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return
        if (String(event.key).toLowerCase() !== 'b') return
        event.preventDefault()
        openAnnotate()
      }
      window.addEventListener('keydown', onKeyDown)
      ctx.effect(() => () => window.removeEventListener('keydown', onKeyDown))
    }

    exports.apply = apply
    // Exposed so a test can drive the dock/tab handshake without a full shell.
    exports.__composerBridge = composerBridge
    // Exposed for the offline checks: the reset channel is the seam where the dock
    // and the sidebar agree, and it cannot be exercised through the DOM.
    exports.__panelReset = panelReset
    // Exposed for the offline checks: the block parser is the seam between what the
    // host writes and what the chip shows, and it is pure, so it is testable
    // without a shell. Re-parsing the host's own output is the only way to notice
    // the two sides drifting apart.
    exports.__parseAnnotationBlock = parseAnnotationBlock
    // Exposed for the offline checks: the placement arithmetic is the one part of
    // the chip that a browser test cannot reach either — jsdom has no layout, so
    // every measurement there is `null` and the offset would go unexercised. The
    // function is pure, so asserting it directly is the only way to cover the
    // number the reader actually sees.
    exports.__chipIndent = chipIndent
    exports.__rowProps = rowProps
    // Exposed because getting it wrong is silent: the row has no sibling at all, so
    // a wrong anchor yields "unmeasured" and the stylesheet's fallback, which looks
    // deliberate. Asserted against a real seat wrapper in the DOM check.
    exports.__chipSeat = chipSeat
    // Exposed for the offline checks: this decides whether a page's report is
    // adopted or handed back, and both ways of getting it wrong are silent — the
    // reader either loses their marks or watches a deleted one return. Pure, so it
    // is asserted directly rather than inferred from a rerender.
    exports.__batchFromPage = batchFromPage
    return module.exports
  },
})
