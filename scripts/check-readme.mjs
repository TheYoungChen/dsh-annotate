/**
 * Every image and link the README points at must exist.
 *
 * The README previously advertised `tests-12 passing` after the suite had grown to 29,
 * and referenced `assets/hero.png` before it was rendered — which GitHub shows as a
 * broken image. Both are the same class of mistake: prose that has drifted away from
 * the repository. A reader cannot tell the difference between a stale claim and a lie,
 * so the claims are checked rather than trusted.
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const readme = readFileSync(`${root}README.md`, 'utf8')

const failures = []
const ok = (condition, label, detail) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures.push(label)
}

console.log('\n=== every referenced image exists ===')
{
  const srcs = [...readme.matchAll(/<img\s+src="([^"]+)"/g)].map((one) => one[1])
  const md = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((one) => one[1])
  const all = [...new Set([...srcs, ...md])].filter((one) => !/^https?:/.test(one))
  ok(all.length > 0, 'the README references local images', `${all.length} found`)
  for (const ref of all) {
    ok(existsSync(`${root}${ref}`), `exists: ${ref}`)
  }
}

console.log('\n=== the two numeric claims in the README ===')
// Both numbers are DERIVED from the README's own list, and that list is checked
// against the scripts directory. Three different counts were possible here depending on
// what you count — files, listed commands, or offline-only commands — which is exactly
// why the number is computed rather than typed.
//
// The listed commands are the source of truth; the directory is checked to make sure
// nothing was added without being listed.
const derived = JSON.parse(
  execFileSync('node', ['-e', `
    const { readdirSync, readFileSync } = require('fs')
    const dir = ${JSON.stringify(`${root}scripts`)}
    const readme = readFileSync(${JSON.stringify(`${root}README.md`)}, 'utf8')

    // The commands the development section actually prints, minus the ones that need
    // a running instance or an external harness to mean anything.
    const NEEDS_HOST = ['check-preview-inline.mjs', 'check-live-host.mjs', 'check-reload.mjs', 'check-preflight-power.mjs']
    const listed = [...readme.matchAll(/^node (scripts\\/[\\w-]+\\.mjs)/gm)]
      .map((m) => m[1].replace('scripts/', ''))
    const offline = listed.filter((n) => !NEEDS_HOST.includes(n))
    const unique = [...new Set(offline)]

    // Anything in the directory that the README never mentions is either a helper or
    // an omission, and the difference matters.
    const onDisk = readdirSync(dir).filter((n) => /^check-.*\\.mjs$/.test(n))
    const unlisted = onDisk.filter((n) => !listed.includes(n) && !NEEDS_HOST.includes(n))

    const harness = readFileSync(dir + '/check-preflight-power.mjs', 'utf8')
    const faults = (harness.match(/mutate: '[a-z0-9-]+'/g) || []).length
      + (harness.match(/apply: \\(dir\\)/g) || []).length

    process.stdout.write(JSON.stringify({ offline: unique.length, faults, unlisted }))
  `]).toString()
)
console.log(`  offline checks listed: ${derived.offline}, injected faults: ${derived.faults}`)
if (derived.unlisted.length) console.log(`  never listed: ${derived.unlisted.join(', ')}`)

ok(derived.unlisted.length === 0, 'every offline check is listed in the README',
  derived.unlisted.join(', ') || 'all listed')

{
  const badge = readme.match(/badge\/tests-(\d+)%20passing/)
  ok(badge, 'the README carries a test-count badge')
  if (badge) {
    ok(Number(badge[1]) === derived.offline, 'the badge matches the listed offline checks',
      `badge says ${badge[1]}, list has ${derived.offline}`)
  }
  const listed = readme.match(/回归测试（(\d+) 项）/)?.[1]
  ok(listed && Number(listed) === derived.offline, 'and so does the development heading',
    `heading says ${listed}, list has ${derived.offline}`)
}

{
  const badge = readme.match(/badge\/mutation-(\d+)%2F(\d+)/)
  ok(badge, 'the README carries a mutation badge')
  if (badge) {
    ok(Number(badge[2]) === derived.faults, 'the badge denominator matches the harness',
      `badge says ${badge[2]}, harness has ${derived.faults}`)
    ok(Number(badge[1]) === Number(badge[2]), 'and it claims every fault is caught')
  }
  const listed = readme.match(/注入 (\d+) 个故障/)?.[1]
  ok(listed && Number(listed) === derived.faults, 'and the development section agrees',
    `text says ${listed}, harness has ${derived.faults}`)
}

console.log('\n=== the README names the differentiating features ===')
{
  // These are the three things that separate this from a generic "click and comment"
  // tool. They are the reason someone picks it, so the README has to say them out
  // loud rather than leaving them to be inferred from a screenshot.
  ok(/发现本地服务|本地服务发现/.test(readme), 'local service discovery is called out')
  ok(/标注配色|配色/.test(readme), 'the accent picker is called out')
  ok(/附件/.test(readme), 'delivery as an attachment is called out')
}

console.log('\n=== the community files GitHub surfaces as tabs ===')
{
  // GitHub shows these as tabs above the file list and links them from the new-issue
  // flow. They are only useful if they exist AND the README links to them — a file
  // nobody can reach is the same as no file.
  for (const file of ['CONTRIBUTING.md', 'SECURITY.md', 'LICENSE']) {
    ok(existsSync(`${root}${file}`), `${file} exists`)
  }
  for (const file of ['CONTRIBUTING.md', 'SECURITY.md', 'LICENSE']) {
    ok(readme.includes(file), `and the README links to ${file}`)
  }
  ok(existsSync(`${root}.github/ISSUE_TEMPLATE/bug_report.md`), 'there is a bug-report template')
  ok(existsSync(`${root}.github/ISSUE_TEMPLATE/config.yml`), 'and the issue chooser config')
}

console.log('\n=== the text a search result actually shows ===')
{
  // GitHub search shows the repository description, and only the beginning of it. The
  // README's first heading and first paragraph show on the repository page. All three
  // are the things that decide whether someone clicks, so none of them may start with
  // a hedge or bury the point.
  const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))
  const description = pkg.description || ''
  ok(description.length > 0, 'package.json carries a description')
  ok(description.length <= 350, 'and it fits a GitHub description field', `${description.length} chars`)

  // The first ~120 characters are what a search result truncates to. The opening verb
  // has to be about what the reader gets, not about the plugin's own name or history.
  const opening = description.slice(0, 120)
  ok(/^[A-Z]/.test(description), 'it opens with a capital, not a bullet or a dash')
  ok(!/^(A |An |The )/.test(description), 'and does not waste the first words on an article')
  ok(/click|annotate|element|preview/i.test(opening), 'the opening names the actual action', opening.slice(0, 60))

  ok(Array.isArray(pkg.keywords) && pkg.keywords.length >= 10, 'there are enough keywords to be found by',
    `${(pkg.keywords || []).length} keywords`)
  ok((pkg.keywords || []).includes('dsh-plugin'), 'and the DSH-specific ones are present')

  // The README's first line after the title is the strongest signal on the page.
  const firstHeading = readme.split('\n')[0]
  ok(/^# dsh-annotate$/.test(firstHeading), 'the README starts with the plugin name')
  const firstProse = readme.split('\n').find((line) => line.startsWith('### '))
  ok(Boolean(firstProse) && firstProse.length < 60, 'followed by a short, concrete tagline',
    firstProse || 'none found')
}

console.log('\n=== the demo video ===')
{
  // Two things can go wrong here and both are silent: the attachment link can rot, and
  // the in-repo fallback can be missing or gitignored. Neither shows up as a broken
  // image — the README just quietly loses its demo.
  const attachment = readme.match(/https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]{36}/)
  ok(attachment, 'the README embeds a GitHub attachment link',
    attachment ? attachment[0].slice(-12) : 'none found')

  ok(readme.includes('assets/demo.mp4'), 'and points at an in-repo fallback')

  if (existsSync(`${root}assets/demo.mp4`)) {
    const size = statSync(`${root}assets/demo.mp4`).size
    ok(size > 0, 'the fallback file exists and is not empty', `${(size / 1024 / 1024).toFixed(2)} MB`)
    // A video a clone has to carry should stay small. This is a judgment call written
    // down: past ~8 MB the fallback costs more than the problem it solves.
    ok(size < 8 * 1024 * 1024, 'and is small enough that committing it is reasonable',
      `${(size / 1024 / 1024).toFixed(2)} MB (limit 8 MB)`)
  } else {
    ok(false, 'the fallback file exists', 'assets/demo.mp4 is missing')
  }

  // The 30 MB GIF is what made this whole detour necessary. Keep it out.
  ok(!existsSync(`${root}assets/demo.gif`), 'the oversized GIF is not in the repository')
}

console.log('\n=== the facts a reader needs before installing ===')
{
  // A reader often never browses this README at all. They describe what they want, an AI
  // searches, finds this repository, and decides from the text whether it fits. So the
  // overview has to state the plain facts, including what the plugin is NOT for —
  // otherwise it gets recommended for the wrong job and the reader bounces.
  //
  // The section is located by CONTENT, not by heading. An earlier version keyed on the
  // heading text, which made the test fail the moment the heading was reworded — the
  // check was asserting a title, not the thing the title was supposed to introduce.
  const block = readme.split(/\n## /).find((s) => s.includes('dsh.profile.bundles')) || ''
  ok(block.length > 0, 'some section states the install facts')

  for (const fact of ['DeepSeek Harness', 'dsh.profile.bundles', 'Node', 'MIT']) {
    ok(block.includes(fact), `it states: ${fact}`)
  }
  // Both lists must exist. A section that only lists what it does gets matched against
  // requests it cannot serve.
  ok(/对口/.test(block), 'it says when this plugin IS the right answer')
  ok(/不对口/.test(block), 'and when it is NOT')
  ok(/安装/.test(block), 'the install path is stated')

  // The heading must read like a normal section of a normal README. "For the AI reader"
  // framing tells a human the text was written to game a search result, which costs more
  // trust than the keywords buy.
  const headings = readme.match(/^## .+$/gm) || []
  for (const bad of [/给 ?AI/, /摘要/, /关键词/, /SEO/]) {
    ok(!headings.some((h) => bad.test(h)), `no heading mentions ${bad.source}`)
  }
}

console.log('\n=== no decorative emoji ===')
{
  // Arrows are kept: they carry meaning in the flow diagram and in "click → hover →
  // select", and the keyboard glyphs (⌘⇧B) are literal keys. What is excluded is
  // decoration — a glyph stuck on the front of a heading to make it look lively. In a
  // technical README that reads as advertising, and costs more credibility than it buys.
  const lines = readme.split('\n')
  const decorative = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u
  const offenders = []
  lines.forEach((line, i) => {
    if (decorative.test(line)) offenders.push(`${i + 1}: ${line.trim().slice(0, 50)}`)
  })
  ok(offenders.length === 0, 'the README has no decorative emoji',
    offenders.length ? offenders.join(' | ') : 'none')
}

console.log('\n=== the "no browser extension" claim ===')
{
  // The nearest competitors in a search result ARE browser extensions, and a reader
  // choosing between them needs to know this one installs differently. It also has to
  // say what it cannot do — a reader who wants to annotate arbitrary tabs would
  // otherwise install it and only find out afterwards.
  const install = readme.split('## 安装')[1]?.split('\n## ')[0] || ''
  ok(/不需要装浏览器扩展/.test(install), 'the install section says no extension is needed')
  ok(/不是一个浏览器扩展/.test(install), 'and states what it is instead')

  // Being clear about which pages it can preview is the honest part of this section.
  // The earlier wording ("这个插件做不了") was wrong — the plugin does support remote
  // targets behind a config flag — so what is asserted now is that the section says
  // what the CURRENT default is rather than claiming a permanent limitation.
  ok(/allowRemote/.test(install), 'and states how remote pages are enabled')

  // The claim has to land before the install steps, not after the reader has already
  // started following them.
  const claimAt = readme.indexOf('不需要装浏览器扩展')
  const stepsAt = readme.indexOf('一键安装')
  ok(claimAt !== -1 && stepsAt !== -1 && claimAt < stepsAt,
    'the claim comes before the install steps')

  ok(/no-browser%20extension/.test(readme), 'and the badge states it too')
}

console.log(failures.length === 0
  ? '\nREADME CHECKS PASSED'
  : `\nREADME CHECKS FAILED — ${failures.length} problem(s)`)
process.exit(failures.length === 0 ? 0 : 1)
