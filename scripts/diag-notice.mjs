/**
 * Check whether the annotation attachment actually became a transcript message.
 *
 * The reader reports seeing nothing on their sent message. Two designs have been
 * tried: a `systemPrompt.context()` contribution, which lands as a `snapshot`
 * message stamped with the prompt package's name, and an `agent/pre-step`
 * append, which lands as a `notice` message stamped with this plugin's name.
 * This reads the durable record and reports what is actually there.
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

const records = []
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  try {
    records.push(JSON.parse(line))
  } catch {
    /* truncated tail */
  }
}
console.log(`parsed ${records.length} record(s)`)

/** Every plugin-sourced user message, with what identifies it. */
const pluginMessages = records.filter((r) => {
  if (r.type !== 'user/message') return false
  const source = r.data && r.data.source
  return source && source.kind === 'plugin'
})

console.log('')
console.log(`=== ${pluginMessages.length} plugin-sourced user message(s) ===`)
for (const m of pluginMessages) {
  const source = m.data.source
  const content = m.data.content
  const body = Array.isArray(content)
    ? content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('')
    : String(content)
  const carriesAnnotations = body.includes('Web page elements')
  console.log(`  seq=${m.seq} plugin=${JSON.stringify(source.plugin)} form=${JSON.stringify(source.form)} surfaceOp=${JSON.stringify(m.surfaceOp)}${carriesAnnotations ? '  <<< CARRIES ANNOTATIONS' : ''}`)
  if (source.summary !== undefined) console.log(`      summary=${JSON.stringify(source.summary)}`)
  console.log(`      head: ${body.slice(0, 80).replace(/\n/g, ' | ')}`)
}

console.log('')
console.log('=== does ANY message carry the annotation block? ===')
const carriers = records.filter((r) => {
  if (r.type !== 'user/message') return false
  const content = r.data && r.data.content
  if (!Array.isArray(content)) return false
  return content.some((b) => b.type === 'text' && String(b.text).includes('Web page elements'))
})
console.log(`  ${carriers.length} user message(s) carry it`)
for (const c of carriers.slice(-5)) {
  const source = c.data.source
  console.log(`  seq=${c.seq} kind=${source.kind} plugin=${JSON.stringify(source.plugin)} form=${JSON.stringify(source.form)}`)
}

console.log('')
console.log('=== the newest user messages (what the reader sent) ===')
const users = records.filter((r) => r.type === 'user/message')
for (const u of users.slice(-4)) {
  const source = u.data.source
  const content = u.data.content
  const body = Array.isArray(content)
    ? content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('')
    : String(content)
  console.log(`  seq=${u.seq} source=${source.kind}${source.plugin ? `/${source.plugin}` : ''} :: ${body.slice(0, 60).replace(/\n/g, ' ')}`)
}
