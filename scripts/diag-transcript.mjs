/**
 * Determine whether the annotation snapshot became a real message in the
 * transcript, or only ever appeared inside tool output.
 *
 * The previous probe found 74 records mentioning the block but the newest was a
 * `tool/call`, which would mean the text was quoted back by a tool rather than
 * delivered as context. That distinction decides whether the reader is missing a
 * rendering or missing a delivery, so it is worth pinning down exactly.
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const path = 'C:/Users/a3025/.dsh/sessions/--E-StudyFile-AI-Workspace-dsh_workspace--/session-42765efb-db0a-4f58-8d4e-49cd7c7c11c2/session.v3.jsonl.zstd'
const buf = readFileSync(path)

const offsets = []
for (let i = 0; i + 4 <= buf.length; i += 1) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i)
}
let text = ''
for (let i = 0; i < offsets.length; i += 1) {
  const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
  try {
    text += zstdDecompressSync(buf.subarray(offsets[i], end)).toString('utf8')
  } catch {
    /* skip a bad frame */
  }
}

const lines = text.split('\n').filter((l) => l.trim())

/** Parse every record once, keeping the ones that parsed. */
const records = []
for (const line of lines) {
  try {
    records.push(JSON.parse(line))
  } catch {
    /* a truncated tail line is expected */
  }
}
console.log(`parsed ${records.length} record(s) of ${lines.length}`)

/** Does this record's own payload mention the block? */
const mentions = (record) => JSON.stringify(record).includes('Web page elements')

console.log('')
console.log('=== which record types quote the block ===')
const byType = new Map()
for (const record of records) {
  if (!mentions(record)) continue
  const type = record.type || '(untyped)'
  byType.set(type, (byType.get(type) || 0) + 1)
}
for (const [type, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${type}`)
}

console.log('')
console.log('=== records that are a user message sourced from a plugin ===')
const pluginMessages = records.filter((r) => {
  if (r.type !== 'user/message') return false
  const source = r.data && r.data.source
  return source && source.kind === 'plugin'
})
console.log(`  ${pluginMessages.length} plugin-sourced user message(s)`)
for (const m of pluginMessages.slice(-6)) {
  const source = m.data.source
  const content = m.data.content
  const body = Array.isArray(content)
    ? content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('')
    : String(content)
  console.log(`  seq=${m.seq} plugin=${source.plugin} form=${source.form} sections=${Array.isArray(source.sections) ? source.sections.length : 0}`)
  console.log(`    head: ${body.slice(0, 90).replace(/\n/g, ' | ')}`)
}

console.log('')
console.log('=== the assistant request that followed the newest plugin message ===')
// The request/header records carry the assembled prompt; its presence there proves
// the context reached the model rather than only the UI.
const newest = pluginMessages[pluginMessages.length - 1]
if (newest) {
  console.log(`  newest plugin message at seq ${newest.seq}`)
  const after = records.filter((r) => typeof r.seq === 'number' && r.seq > newest.seq).slice(0, 6)
  for (const r of after) {
    console.log(`    seq=${r.seq} type=${r.type}`)
  }
} else {
  console.log('  none found — the plugin context never became a user message')
}
