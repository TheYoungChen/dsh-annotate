/**
 * Copy for the annotate pairing section.
 *
 * Every product-visible string lives here: the DSH client requires that a
 * component render only localized text, so a missing key is a compile error
 * rather than an English string leaking into a Chinese UI.
 *
 * The two dictionaries are deliberately written independently rather than
 * translated word-for-word — the Chinese copy is the one most users of this
 * plugin will read, and it reads as native instructions instead of a
 * transliteration.
 *
 * @module
 */

/** Dictionary namespace owned by this plugin's client half. */
export const NS = 'annotate'

/** English copy. */
export const en = {
  'nav': 'Browser annotation',
  'title': 'Browser annotation',
  'intro':
    'Annotate any element on a page and send its DOM facts and your comment into the conversation. '
    + 'A browser extension collects; this DSH instance receives.',

  'status.heading': 'Extension connection',
  'status.connected': 'Connected',
  'status.disconnected': 'Not connected',
  'status.notListening': 'Bridge not listening',
  'status.connectedSince': 'Connected since {time}',
  'status.extensionId': 'Extension id',
  'status.protocol': 'Protocol',
  'status.unknown': 'Unknown',

  'pairing.heading': 'Pairing token',
  'pairing.explainer':
    'Paste this token into the extension to pair it with this DSH instance. '
    + 'Anyone who has it can send annotations here, so treat it like a password.',
  'pairing.reveal': 'Reveal',
  'pairing.hide': 'Hide',
  'pairing.copy': 'Copy',
  'pairing.copied': 'Copied',
  'pairing.copyFailed': 'Copy failed — select the token and copy it manually',
  'pairing.issuedAt': 'Issued {time}',
  'pairing.unavailable': 'No token is available for this instance.',

  'bridge.heading': 'Bridge address',
  'bridge.explainer':
    'The extension dials this loopback address. It is already the default, so you only need it '
    + 'if this instance was started on a different port.',
  'bridge.address': '{address}:{port}',

  'setup.heading': 'Setup',
  'setup.step1': 'Install the dsh-annotate browser extension (load the unpacked folder from this plugin).',
  'setup.step2': 'Open the extension and paste the token above.',
  'setup.step3': 'Open the page you want to annotate and pick an element.',

  'error.forbidden': 'This page is not allowed to read the pairing token.',
  'error.network': 'Could not reach the bridge status route.',
  'error.unavailable': 'The bridge has not issued a token yet.',
  'error.malformed': 'The bridge answered an unexpected response.',
  'retry': 'Retry',
  'refresh': 'Refresh',
} as const

/** Dictionary key union, derived from the English dictionary. */
export type AnnotateKey = keyof typeof en

/** Chinese copy. */
export const zh: Record<AnnotateKey, string> = {
  'nav': '网页标注',
  'title': '网页标注',
  'intro':
    '在网页上标注任意元素，把它的 DOM 事实和你的评论送进对话。'
    + '扩展负责采集，这个 DSH 实例负责接收。',

  'status.heading': '扩展连接',
  'status.connected': '已连接',
  'status.disconnected': '未连接',
  'status.notListening': '桥未监听',
  'status.connectedSince': '连接于 {time}',
  'status.extensionId': '扩展 ID',
  'status.protocol': '协议版本',
  'status.unknown': '未知',

  'pairing.heading': '配对令牌',
  'pairing.explainer':
    '把这个令牌填进扩展，即可与当前 DSH 实例配对。'
    + '拿到它的人就能把标注送到这里，请像对待密码一样对待它。',
  'pairing.reveal': '显示',
  'pairing.hide': '隐藏',
  'pairing.copy': '复制',
  'pairing.copied': '已复制',
  'pairing.copyFailed': '复制失败，请手动选中令牌复制',
  'pairing.issuedAt': '签发于 {time}',
  'pairing.unavailable': '本实例暂无可用令牌。',

  'bridge.heading': '桥接地址',
  'bridge.explainer':
    '扩展会连接这个回环地址。扩展里已默认填好，只有本实例换了端口时才需要改。',
  'bridge.address': '{address}:{port}',

  'setup.heading': '下一步',
  'setup.step1': '安装 dsh-annotate 浏览器扩展（从本插件目录加载已解压的文件夹）。',
  'setup.step2': '打开扩展，把上面的令牌粘贴进去。',
  'setup.step3': '打开要标注的网页，用扩展选中一个元素。',

  'error.forbidden': '当前页面无权读取配对令牌。',
  'error.network': '无法访问桥状态接口。',
  'error.unavailable': '桥尚未签发令牌。',
  'error.malformed': '桥返回了预期之外的响应。',
  'retry': '重试',
  'refresh': '刷新',
}
