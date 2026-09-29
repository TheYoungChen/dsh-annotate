/**
 * The preview target gate must behave the way the README says it does.
 *
 * The README makes three promises about what the proxy will and will not fetch:
 * loopback is always allowed, remote hosts need `allowRemote`, and credentials in the
 * URL are never allowed. Those are security claims, and a security claim that drifts
 * away from the code is worse than no claim — so they are asserted here against the
 * real function rather than described in prose.
 *
 * This exists because the README once said "在线网站做不了" while `allowRemote` had in
 * fact been implemented and would happily fetch any host. Nobody noticed, because
 * nothing connected the sentence to the function.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = readFileSync(`${root}lib/index.js`, 'utf8')

let failures = 0
const ok = (pass, label, detail) => {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures += 1
}

// Pull the real function out of the source so this cannot test a re-implementation
// that happens to agree with the README while the shipped code does not.
const match = source.match(/function isLocalTarget\(url, allowRemote\) \{[\s\S]*?\n\}/)
if (!match) {
  console.log('FAIL could not find isLocalTarget in lib/index.js')
  process.exit(1)
}
const isLocalTarget = new Function(`return ${match[0]}`)()

const allows = (url, allowRemote) => {
  try {
    return isLocalTarget(new URL(url), allowRemote)
  } catch {
    return false
  }
}

console.log('\n=== loopback is always allowed ===')
for (const url of ['http://localhost:3000/', 'http://127.0.0.1:8080/a', 'http://[::1]:5173/']) {
  ok(allows(url, false), `allowed with allowRemote off: ${url}`)
}

console.log('\n=== a remote host needs allowRemote ===')
for (const url of ['http://example.com/', 'https://github.com/x', 'http://93.184.216.34/']) {
  ok(!allows(url, false), `refused by default: ${url}`)
  ok(allows(url, true), `and allowed once allowRemote is on: ${url}`)
}

console.log('\n=== credentials in the URL are never allowed ===')
// Not even with allowRemote on. A URL like this would make the proxy send whatever
// the user embedded, and there is no use case for a preview target that carries a
// password in its address.
for (const url of ['http://user:pw@example.com/', 'http://user:pw@localhost:3000/']) {
  ok(!allows(url, true), `refused even with allowRemote on: ${url}`)
}

console.log('\n=== non-http schemes are never allowed ===')
for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'data:text/html,<b>x</b>']) {
  ok(!allows(url, true), `refused: ${url}`)
}

console.log('\n=== the SSRF gap the README admits to ===')
{
  // This is the reason `allowRemote` ships off by default, and the README says so.
  // If this ever stops being true, the README's explanation is wrong and must change —
  // so the gap is asserted rather than assumed.
  ok(allows('http://169.254.169.254/latest/meta-data/', true),
    'cloud metadata is still reachable when allowRemote is on (documented gap)')
  ok(allows('http://192.168.1.1/', true),
    'and so is the private range (documented gap)')
  ok(!allows('http://169.254.169.254/', false),
    'but neither is reachable by default')
}

console.log('\n=== the README agrees with the code ===')
{
  const readme = readFileSync(`${root}README.md`, 'utf8')
  ok(/allowRemote/.test(readme), 'the README mentions allowRemote')
  ok(/计划在后续版本|尚未实现|SSRF/.test(readme),
    'and does not claim remote sites already work by default')
  ok(/169\.254\.169\.254|云元数据/.test(readme),
    'and names the SSRF concern rather than hiding it')
  // The old, wrong claim must not come back.
  ok(!/这个插件做不了/.test(readme),
    'and does not say the plugin cannot annotate online sites')
}

console.log('')
if (failures) {
  console.log(`TARGET-GATE CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('TARGET-GATE CHECKS PASSED')
