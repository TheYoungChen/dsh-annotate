/**
 * 当前版本的更新日志必须能直接给外面的人看。
 *
 * 为什么需要这条检查：`CHANGELOG.md` 里当前版本那一节会被
 * `.github/workflows/release.yml` 原样贴进 GitHub Release，所以它就是发布说明本身。
 * 但它同时又是一个仓库里的开发文件，很容易顺手写进只有维护者关心、或者只有本机才看得懂
 * 的内容 —— 内部检查脚本的名字、"我在写注释时……"这类过程叙述、以及"读者报告说……"
 * 这种把用户当成第三方的口吻。这些东西在 Release 页面上会显得莫名其妙：
 * 那里站的读者不认识这个仓库的内部结构，也不需要知道改动是怎么被发现的。
 *
 * 这类措辞**不会**让任何测试失败：它读起来通顺，只是读者错位。
 * 所以只能明确断言它不出现。
 *
 * 只检查**当前**版本那一节。历史小节是既成事实，把它们一起算成失败
 * 会让这条检查从第一天起就是红的，然后被人忽略。
 */
import { readFileSync } from 'node:fs'
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
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')

// 当前版本那一节，从它的标题到下一个 `## ` 之前。
const sections = changelog.split(/^## /m).slice(1)
const section = sections.find((one) => one.startsWith(`${version}\n`) || one.startsWith(`${version} `))

console.log(`\n=== the ${version} section is fit to publish ===`)
check(Boolean(section), `CHANGELOG.md has a "${version}" section`,
  `versions present: ${sections.map((one) => one.split('\n')[0]).slice(0, 4).join(', ')}`)

if (section) {
  const body = section.split('\n').slice(1).join('\n')

  // 内部工具的痕迹。这些字符串出现在 Release 页面上，读者无从理解 ——
  // 它们指向的文件在他的克隆里根本不存在，或者他根本不关心。
  const internal = [
    ['脚本文件名', /\bcheck-[a-z-]+\.mjs/],
    ['源码路径', /\bscripts\//],
    ['变异测试', /变异|mutate\.mjs/],
    ['断言', /断言/],
    ['内部小节', /^### 测试工具$/m],
  ]
  for (const [label, pattern] of internal) {
    const hit = body.match(pattern)
    check(!hit, `no ${label} in the release notes`,
      hit ? `found ${JSON.stringify(hit[0])}` : '')
  }

  // 把读者当成第三方的口吻，以及只有维护者才知道的"我"。
  // 读者就是正在读 Release 的那个人，不需要被这样转述。
  const voices = [
    ['"读者报告"式转述', /读者/],
    ['第一人称过程叙述', /我在写|我自己引入|我引入|我的实现|我们当时/],
    ['对维护者说话', /不要互相手抄|本文件记录|内部文档/],
  ]
  for (const [label, pattern] of voices) {
    const hit = body.match(pattern)
    check(!hit, `no ${label}`,
      hit ? `found ${JSON.stringify(hit[0])} — the reader is the user, not a third party` : '')
  }

  // 空壳子：技术上"有这一节"，贴出去却等于没有更新日志。
  const prose = body.split('\n').filter((line) => line.trim() && !line.startsWith('#'))
  check(prose.length >= 10, 'the section actually describes the release',
    `${prose.length} line(s) of prose`)

  // 一节全是"修复"没有"新增"是可疑的：这一版多半有用户能看到的新东西没说。
  check(/###\s/.test(body), 'the section is divided into headings')
}

console.log('')
if (failures) {
  console.log(`RELEASE NOTE CHECKS FAILED — ${failures} problem(s)`)
  process.exit(1)
}
console.log('RELEASE NOTE CHECKS PASSED')
