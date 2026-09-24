/**
 * Reproduce what `open` does with a file: URL, to find why a page that exists
 * on disk comes back as "page not found".
 */
import { realpathSync, statSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

const WORKSPACE = 'E:/StudyFile/AI-Workspace/dsh_workspace'
const CASES = [
  'file:///E:/StudyFile/AI-Workspace/dsh_workspace/docs/wallet-v3.html',
  'file:///E:/StudyFile/Notes/API_Zhongzhuan/%E4%B8%B4%E6%97%B6%E5%8E%9F%E5%9E%8B/console/wallet-v3.html',
]

const insideRoot = (target, root) => {
  const a = resolve(target).toLowerCase()
  const b = resolve(root).toLowerCase()
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

for (const raw of CASES) {
  console.log('---')
  console.log('input      :', raw)
  const pathname = new URL(raw).pathname
  console.log('pathname   :', pathname)
  const stripped = pathname.replace(/^\/([A-Za-z]:)/, '$1')
  console.log('stripped   :', stripped)
  let real = null
  try {
    real = realpathSync(decodeURIComponent(stripped))
    console.log('realpath   :', real)
  } catch (error) {
    console.log('realpath   : FAILED', error.code)
  }
  if (real) {
    console.log('is file    :', statSync(real).isFile())
    console.log('insideRoot :', insideRoot(real, WORKSPACE))
    console.log('dirname    :', dirname(real))
  }
}

// The page-root the preview serves from, and how a request maps onto it.
console.log('\n=== how a request maps onto the served file root ===')
const fileRoot = 'E:/StudyFile/AI-Workspace/dsh_workspace/docs'
const assetCases = ['/wallet-v3.html', '/', '/index.html', '/assets/app.js']
for (const pathname of assetCases) {
  let p = pathname
  if (p.endsWith('/')) p += 'index.html'
  const candidate = resolve(fileRoot, '.' + p)
  let ok = false
  try {
    ok = statSync(candidate).isFile()
  } catch {
    ok = false
  }
  console.log(`  ${pathname.padEnd(18)} -> ${candidate}  exists=${ok}`)
}
