/**
 * Inspect the sections of the newest annotation snapshot in this session.
 *
 * The reader sees nothing on their sent message. A plugin-sourced snapshot should
 * render as a collapsed row labelled with the producing section name, so either
 * the message is absent, its `sections` is empty (which drops the row to an opaque
 * body), or the row exists and simply does not say enough. This reads the durable
 * record to tell those apart.
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

const snapshots = records.filter((r) => {
  if (r.type !== 'user/message') return false
  const source = r.data && r.data.source
  return source && source.kind === 'plugin' && source.form === 'snapshot'
})

console.log(`parsed ${records.length} record(s); ${snapshots.length} plugin snapshot(s)`)

console.log('')
console.log('=== every section name this session has seen ===')
const names = new Map()
for (const snapshot of snapshots) {
  const sections = snapshot.data.source.sections || []
  for (const section of sections) {
    const key = String(section && section.name)
    const entry = names.get(key) || { count: 0, chars: 0, sample: '' }
    entry.count += 1
    entry.chars = Math.max(entry.chars, String(section && section.text || '').length)
    if (String(section && section.text || '').includes('Web page elements')) {
      entry.sample = String(section.text).split('\n').slice(0, 3).join(' / ')
    }
    names.set(key, entry)
  }
}
for (const [name, info] of names) {
  console.log(`  ${JSON.stringify(name)}  x${info.count}  max ${info.chars} chars`)
  if (info.sample) console.log(`      sample: ${info.sample}`)
}

console.log('')
console.log('=== does any snapshot carry the annotation section? ===')
const carrier = snapshots.filter((s) => (s.data.source.sections || []).some(
  (section) => String(section && section.text || '').includes('Web page elements')))
console.log(`  ${carrier.length} snapshot(s) carry it`)
for (const s of carrier.slice(-3)) {
  const sections = s.data.source.sections || []
  console.log(`  seq=${s.seq} plugin=${s.data.source.plugin} sections=${sections.length}`)
  for (const section of sections) {
    const body = String(section && section.text || '')
    console.log(`    - name=${JSON.stringify(section && section.name)} chars=${body.length}`)
    if (body.includes('Web page elements')) {
      console.log('      >>> this is the annotation section')
    }
  }
}

console.log('')
console.log('=== what the collapsed row would be labelled with ===')
if (snapshots.length) {
  const newest = snapshots[snapshots.length - 1]
  console.log(`  provenance.label comes from source.plugin = ${JSON.stringify(newest.data.source.plugin)}`)
  console.log('  (the section name is NOT the label; it is what the body lists)')
}
