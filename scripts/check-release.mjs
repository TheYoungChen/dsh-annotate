/**
 * 让 CHANGELOG 和 Release 正文不会各说各话。
 *
 * 为什么需要这条检查：更新日志这件事只有"两份都对"才有意义。Release 正文是
 * `docs/releases/v<version>.md`（由 .github/workflows/release.yml 在推标签时贴进
 * GitHub Release），CHANGELOG.md 是开发视角那份。任何一份忘了跟上版本号，
 * 发布出去的更新日志就是残缺的，而这**不会**有任何东西报错 —— Release 会照发，
 * 只是内容缺一块，或者干脆是上一个版本的。这类"发出去才发现"的错，
 * 只能在推送前由检查拦住。
 *
 * 断言三件事：
 *   1. package.json 的版本号在 CHANGELOG.md 里有对应小节；
 *   2. 同一版本在 docs/releases/ 下有正文文件；
 *   3. 那份正文开头声明的版本号确实是它自己的版本 ——
 *      复制上一版文件改名是新版本最常见的第一步，也最容易忘了改成新版号，
 *      于是 Release 页面上写着"v0.3.1"，正文第一行却还是"v0.3.0"。
 *
 * 只检查**当前**版本，不是检查全部历史：老版本缺正文是既成事实，
 * 把它算成失败会让这条检查从第一天起就是红的，然后被人忽略。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

let failures = 0
const check = (ok, what, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
console.log(`\n=== release notes cover ${version} ===`)

// 1. CHANGELOG 里有这一版。
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
const sections = changelog.split(/^## /m).slice(1)
const heading = sections.find((one) => one.startsWith(`${version}\n`) || one.startsWith(`${version} `))
check(Boolean(heading), `CHANGELOG.md has a "${version}" section`,
  `versions present: ${sections.map((one) => one.split('\n')[0]).slice(0, 4).join(', ')}`)

// 2. 有这一版的 Release 正文。
const notesPath = join(ROOT, 'docs', 'releases', `v${version}.md`)
check(existsSync(notesPath), `docs/releases/v${version}.md exists`,
  'the release workflow would fail on the tag')

// 3. 正文自己声明的版本号和它所在的文件名一致。
if (existsSync(notesPath)) {
  const notes = readFileSync(notesPath, 'utf8')
  const title = (notes.split('\n').find((line) => line.startsWith('# ')) || '').trim()
  check(title.includes(`v${version}`),
    `the notes file names v${version} in its title`,
    `title is ${JSON.stringify(title)} — a copied file usually still says the old version`)
}

// 4. 正文不能是空的壳子。一个只有标题的文件技术上"存在"，
//    贴到 Release 上却等于没有更新日志。
if (existsSync(notesPath)) {
  const body = readFileSync(notesPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#') && !line.startsWith('>'))
  check(body.length >= 10, 'the notes file actually describes the release',
    `${body.length} non-heading line(s)`)
}

console.log('')
if (failures) {
  console.log(`RELEASE NOTE CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('RELEASE NOTE CHECKS PASSED')
