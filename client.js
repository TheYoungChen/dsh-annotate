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
        'panel.listUnit': 'element(s) attached',
        'panel.close': 'Close',
        'panel.kindMark': 'mark',
        'panel.kindNote': 'note',
        'panel.edit': 'Edit',
        'panel.remove': 'Remove',
        'panel.removeAll': 'Clear all',
        'composer.capsuleLabel': 'Annotations',
        'composer.capsuleUnit': 'attached',
        'composer.capsuleHint': 'Sent as context alongside your next message. Not inserted into the text you type.',
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
        'panel.listUnit': '项已附加',
        'panel.close': '关闭',
        'panel.kindMark': '标注',
        'panel.kindNote': '批注',
        'panel.edit': '编辑',
        'panel.remove': '移除',
        'panel.removeAll': '全部清除',
        'composer.capsuleLabel': '标注',
        'composer.capsuleUnit': '项已附加',
        'composer.capsuleHint': '作为上下文随下一条消息发送，不会插入到你输入的文字中。',
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
.dsa-spacer{flex:1 1 auto;min-width:0}
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
/* Once a page is open the address bar collapses to the host it is showing: a
   full-width input for a value the reader is not editing is just noise. */
.dsa-open-wrap{display:flex;gap:4px;align-items:center;flex:0 0 auto;min-width:0}
.dsa-loc{display:inline-flex;align-items:center;gap:5px;height:28px;max-width:100%;min-width:0;padding:0 8px;border-radius:7px;border:1px solid transparent;background:var(--dsa-chrome);color:inherit;cursor:pointer;font:12px/1 inherit;flex:1 1 auto;transition:background .15s cubic-bezier(.22,1,.36,1),border-color .15s cubic-bezier(.22,1,.36,1)}
.dsa-loc:hover{background:var(--dsa-hover);border-color:var(--dsa-hair)}
.dsa-loc:focus-visible{outline:2px solid var(--dsa-accent);outline-offset:1px}
/* Truncated from the left, because the END of a host is the part that varies:
   :3000 distinguishes two servers, localhost does not. */
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
.dsa-count-body{position:fixed;z-index:2147483000;top:50%;left:50%;transform:translate(-50%,-50%);width:min(360px,calc(100vw - 32px));max-height:min(70vh,520px);overflow:auto;background:var(--dsw-specific-menu,#fff);color:inherit;border:1px solid var(--dsa-hair);border-radius:12px;padding:10px;box-shadow:0 18px 48px rgba(0,0,0,.3),0 3px 10px rgba(0,0,0,.16)}
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
.dsa-capsule{align-self:center;flex:none;display:inline-flex;align-items:center;gap:6px;max-width:min(100%,420px);padding:3px 10px 3px 8px;border-radius:999px;background-image:linear-gradient(var(--dsa-accent-soft),var(--dsa-accent-soft));background-color:var(--dsw-specific-menu,#fff);border:1px solid var(--dsa-accent-line);box-shadow:0 1px 3px rgba(0,0,0,.08);font-size:11px;line-height:1.5;color:inherit;box-sizing:border-box;user-select:none}
.dsa-capsule-dot{width:6px;height:6px;border-radius:50%;background:var(--dsa-accent);flex:0 0 auto}
/* The label carries the accent itself, so the pill reads as annotated even when
   the tint is subtle. Kept as a separate rule from the dot: the dot shows the
   colour, the text has to stay legible, and those want different treatments. */
.dsa-capsule-label{color:var(--dsa-accent-ink);white-space:nowrap;font-weight:500}
.dsa-capsule-count{font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsa-accent-ink)}
.dsa-capsule-unit{opacity:.72;white-space:nowrap}
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
      const epoch = React.useRef(null)
      React.useEffect(() => {
        if (!sessionId) return undefined
        let live = true
        const read = async () => {
          try {
            const res = await fetch(`${API}/pending`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ session: sessionId }),
            })
            const data = await res.json()
            if (!live || !data || data.ok !== true) return
            if (typeof data.count === 'number') {
              setCount((previous) => (previous === data.count ? previous : data.count))
            }
            if (typeof data.epoch !== 'number') return
            const seen = epoch.current
            epoch.current = data.epoch
            // The first reading only establishes a baseline: acting on it would
            // purge the panel every time the dock remounts.
            if (seen !== null && data.epoch !== seen) {
              const reset = panelReset.get(sessionId)
              if (reset) reset()
            }
          } catch (error) {
            void error
          }
        }
        void read()
        const timer = setInterval(read, 1000)
        return () => {
          live = false
          clearInterval(timer)
        }
      }, [sessionId])

      if (!count) return null
      return React.createElement(
        'div',
        {
          className: 'dsa-capsule',
          title: t('composer.capsuleHint'),
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
      )
    }

    // ------------------------------------------------------------ the payload

    /**
     * Reading order down the page, then insertion order as a tiebreaker.
     *
     * Document coordinates rather than viewport ones: the list must not reshuffle
     * just because the user scrolled the preview. Entries without coordinates
     * sort first rather than throwing, so an entry the page could not measure
     * still appears.
     */
    function inReadingOrder(list) {
      const at = (entry, axis) => {
        const doc = entry && entry.doc
        const value = doc && doc[axis]
        return typeof value === 'number' && Number.isFinite(value) ? value : 0
      }
      return (Array.isArray(list) ? list : [])
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => {
          const ay = at(a.entry, 'y')
          const by = at(b.entry, 'y')
          if (ay !== by) return ay - by
          const ax = at(a.entry, 'x')
          const bx = at(b.entry, 'x')
          if (ax !== bx) return ax - bx
          return a.index - b.index
        })
        .map((one) => one.entry)
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

    function NumberedList(props) {
      const { annotations, onEdit, onRemove, onRemoveAll, busy } = props
      const ordered = inReadingOrder(usable(annotations))
      if (!ordered.length) return h('p', { className: 'dsa-empty' }, t('panel.empty'))
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h(
          'ul',
          { className: 'dsa-list' },
          ordered.map((entry, index) =>
            h(
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
                h('button', { type: 'button', className: 'dsa-mini', onClick: () => onEdit(entry.id, 'edit'), title: t('panel.edit') }, '✎'),
                h('button', { type: 'button', className: 'dsa-mini', onClick: () => onRemove(entry.id), title: t('panel.remove') }, '✕'),
              ),
            ),
          ),
        ),
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
     * Marks for the stacks the probe recognises.
     *
     * Inline SVG rather than image files: the bundle stays self-contained, and
     * each mark is a simple glyph in the stack's own colour, which reads at the
     * 14px this list uses far better than a detailed logo would.
     */
    const STACK_MARKS = {
      react: { color: '#61dafb', path: 'M12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm0-6c5 0 9 3.4 9 7.5s-4 7.5-9 7.5-9-3.4-9-7.5S7 4.5 12 4.5Z' },
      vue: { color: '#42b883', path: 'M2 4h4l6 10 6-10h4l-10 17L2 4Z' },
      svelte: { color: '#ff3e00', path: 'M14 3 6 7v5l8 4 4-2V9l-8-4 4-2Z' },
      angular: { color: '#dd0031', path: 'M12 2 2 6l2 12 8 4 8-4 2-12-10-4Zm0 4 5 11h-2l-1-3h-4l-1 3H9l5-11Z' },
      next: { color: '#111', path: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-3 6h2l6 8V8h2v9h-2l-6-8v8H9V8Z' },
      nuxt: { color: '#00dc82', path: 'M12 5l7 12H5l7-12Z' },
      node: { color: '#539e43', path: 'M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 4 5 3v6l-5 3-5-3V9l5-3Z' },
      python: { color: '#3776ab', path: 'M12 2c4 0 4 2 4 2v3h-4v1h6s3 0 3 4-3 4-3 4h-2v-3s0-3-3-3H8s-3 0-3-3 3-5 7-5Zm-1 2v2h2V4h-2Z' },
      java: { color: '#e76f00', path: 'M9 3c2 3-4 4-4 8s3 6 3 6-5-1-5-5 4-6 4-9h2Zm2 5c2 2-3 3-3 6s3 5 3 5-4-1-4-4 3-4 3-7h1Zm1 10c4 0 6 1 6 1s-2 2-6 2-6-2-6-2 2-1 6-1Z' },
      nginx: { color: '#009639', path: 'M12 2 3 7v10l9 5 9-5V7l-9-5Zm-3 5h2l4 6V7h2v10h-2l-4-6v6H9V7Z' },
      static: { color: '#8b8b8b', path: 'M4 4h16v16H4V4Zm2 2v12h12V6H6Z' },
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
          style: { flex: '0 0 auto', fill: mark.color },
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
     * The host of an open preview, for the collapsed address bar.
     *
     * `new URL` throws on the workspace-file form the panel also accepts, so a
     * failed parse falls back to the raw string rather than blanking the control.
     * @param url - the preview URL.
     * @returns the host, or the URL unchanged when it is not absolute.
     */
    function previewHost(url) {
      try {
        const parsed = new URL(url)
        return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname)
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
          h('span', null, t('panel.listTitle')),
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
      const { servers, pages, onOpen, onDetect, detecting, onReload, onReloadFrame, onClearAll, count, accent, onAccent, hasPreview } = props
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
              // Reload is a refresh, and is labelled as one: "reload" described an
              // action the reader had no reason to expect to differ from refreshing.
              hasPreview
                ? h(MenuRow, { icon: 'refresh', label: t('panel.refresh'), onClick: () => { setOpen(false); onReloadFrame() } })
                : null,
              h(MenuRow, { icon: 'radar', label: detecting ? t('panel.detecting') : t('panel.detectLong'), disabled: detecting, onClick: () => { setOpen(false); onDetect() } }),
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
      const { onOpen, url, setUrl, preview, menu } = props
      const [editing, setEditing] = React.useState(!preview)
      // Before a page is open the address bar IS the panel, so it stays out. Once a
      // page is open it collapses to a single line showing where you are, and the
      // reader expands it only to navigate elsewhere.
      const expanded = editing || !preview
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
                    setEditing(false)
                  }
                  if (event.key === 'Escape' && preview) setEditing(false)
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
                    setEditing(false)
                  },
                },
                h(Icon, { name: 'go' }),
                t('panel.go'),
              ),
              // No detect button here. Discovery lives in the overflow menu, and a
              // second entry point beside "Open" made the reader wonder whether the
              // two did different things. Cancel stays, because it belongs to the
              // address bar being edited rather than to the page.
              preview
                ? h('button', { type: 'button', className: 'dsa-btn dsa-icon-btn', title: t('panel.cancel'), 'aria-label': t('panel.cancel'), onClick: () => setEditing(false) }, h(Icon, { name: 'close' }))
                : null,
            )
          : h(
              'button',
              {
                type: 'button',
                className: 'dsa-loc',
                title: preview.url,
                onClick: () => setEditing(true),
              },
              h(Icon, { name: 'globe' }),
              h('span', { className: 'dsa-loc-host' }, previewHost(preview.url)),
              h(Icon, { name: 'edit', size: 12 }),
            ),
        menu,
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
        const [mode, setMode] = React.useState('idle')
        const [servers, setServers] = React.useState([])
        const [pages, setPages] = React.useState([])
        const [detecting, setDetecting] = React.useState(false)
        const [url, setUrl] = React.useState('')
        const [preview, setPreview] = React.useState(null)
        const [toast, setToast] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [accent, setAccent] = React.useState(readAccent)
        const [unplaced, setUnplaced] = React.useState({ count: 0, total: 0, items: [] })
        const frameRef = React.useRef(null)
        const nonce = React.useRef(0)
        // Kept in a ref as well so the preview-URL builder can read the current
        // accent without being rebuilt (and re-navigating the frame) on every
        // render that touches unrelated state.
        currentAccent = accent

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
         * Reduce received annotations to the fields the host renders.
         *
         * The entries arrive over postMessage from a framed page, so nothing
         * about their shape is guaranteed. A throw here used to unmount the tab
         * and blank the sidebar, so a malformed entry is dropped rather than
         * dereferenced.
         * @param list - annotations as received.
         * @returns the fields worth sending, in order.
         */
        const toReport = (list) => (Array.isArray(list) ? list : [])
          .filter((entry) => entry !== null && typeof entry === 'object')
          .map((entry) => ({
            selector: typeof entry.selector === 'string' ? entry.selector : '',
            text: typeof entry.text === 'string' ? entry.text : '',
            note: typeof entry.note === 'string' ? entry.note : '',
            at: entry.doc && typeof entry.doc === 'object'
              ? `${entry.doc.x},${entry.doc.y} ${entry.doc.w}×${entry.doc.h}`
              : '',
            matches: typeof entry.selectorMatches === 'number' ? entry.selectorMatches : 1,
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

        const flash = (message) => {
          setToast(message)
          window.setTimeout(() => setToast(''), 2600)
        }

        const postToPage = (payload) => {
          const win = frameRef.current && frameRef.current.contentWindow
          if (!win) return
          win.postMessage(Object.assign({ source: PANEL_CHANNEL }, payload), preview ? preview.origin : '*')
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
            if (!preview || event.origin !== preview.origin) return
            if (data.type === 'ready' || data.type === 'changed') {
              setAnnotations(data.annotations || [])
            } else if (data.type === 'mode') {
              setMode(data.mode || 'idle')
            } else if (data.type === 'missing') {
              flash(t('panel.missing'))
            } else if (data.type === 'unplaced') {
              // The page could not draw a pin for some of the annotations. Saying so
              // is what turns "the count went up and no number appeared" from a
              // mystery into a fact the reader can act on.
              setUnplaced({
                count: Number(data.count) || 0,
                total: Number(data.total) || 0,
                items: Array.isArray(data.items) ? data.items : [],
              })
            }
          }
          window.addEventListener('message', onMessage)
          return () => window.removeEventListener('message', onMessage)
        })

        const openTarget = async (target) => {
          if (!target) return
          setBusy(true)
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
            nonce.current += 1
            setAnnotations([])
            setPreview({ origin: data.origin, url: data.url, sid: data.sid, nonce: nonce.current })
            setMode('idle')
          } catch (error) {
            flash(String((error && error.message) || error))
          } finally {
            setBusy(false)
          }
        }

        const setPageMode = (next) => {
          setMode(next)
          postToPage({ type: 'mode', mode: next })
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
          setAnnotations((list) => {
            const next = list.filter((entry) => entry.id !== id)
            syncPage(next)
            return next
          })
        }

        const onRemoveAll = () => {
          setAnnotations([])
          // `purge`, not `key`: `key` only leaves marking mode, so using it here
          // left the page's own list intact and the next marking session mirrored
          // it back — which looked like the reader's earlier marks being replaced.
          postToPage({ type: 'purge' })
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
          postToPage({ type: 'purge' })
        }

        /** The page is the source of truth for its own store; mirror bulk edits. */
        const syncPage = (next) => {
          void next
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
            // `purge`, not `key`: the page holds the durable record and only this
            // explicit act should empty it.
            postToPage({ type: 'purge' })
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
        const menu = h(PanelMenu, {
          servers,
          pages,
          onOpen: openTarget,
          onDetect,
          detecting,
          onReloadFrame: () => setPreview((current) => (current ? { ...current, nonce: ++nonce.current } : current)),
          onClearAll: () => void clearAll(),
          count: annotations.length,
          accent,
          onAccent: changeAccent,
          hasPreview: Boolean(preview),
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
            h('span', { className: 'dsa-spacer' }),
            menu,
          ),

          h(OpenBar, { onOpen: openTarget, onDetect, detecting, url, setUrl, preview }),

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

          // Before a page is open there is nothing to preview, so the first-run
          // guidance takes the frame's place rather than sitting above an empty box.
          preview
            ? h(
                'div',
                { className: 'dsa-frame' },
                h('iframe', {
                  key: preview.nonce,
                  ref: frameRef,
                  src: preview.url,
                  title: 'preview',
                  sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals',
                }),
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
    return module.exports
  },
})
