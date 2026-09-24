# dsh-annotate

> **在 DSH 侧边栏里直接标注正在跑的页面 —— 点一下元素，说一句要改什么，交给对话。**
>
> 不用截图、不用复制选择器、不用手打"就是那个卡片，右边那个"。

<p align="center">
  <em>打开本地页面 → 点「标记」→ 悬停高亮 → 点选 → 写或不写 → 发给对话</em>
</p>

---

## 为什么需要它

让 AI 改界面，最贵的一步从来不是改，是**说清楚改哪儿**。

你现在的做法大概是：截个图 → 圈一下 → 再打字描述"就是登录按钮下面那个灰色的"。
AI 还是得猜。猜错了，你再来一轮。

**dsh-annotate 把这一步变成两次点击**：点元素，得到一份精确的定位信息，直接进对话。
AI 拿到的是 `button.primary` 和它的真实文本，不是一个模糊的描述。

## 亮点

| | |
|---|---|
| 🖱️ **两下点击完成一次标注** | 悬停高亮 + 实时显示选择器，点一下即完成 |
| ✍️ **标注 / 批注，两种粒度** | 想只说"看这里"就留空；想说要改什么就写一句 |
| 🎯 **精确到元素** | 生成唯一 CSS 选择器（优先语义化 class，而不是一长串 `nth-child`） |
| 📦 **一次发送多条** | 按页面从上到下的顺序编号，和页面里的标记针一一对应 |
| 🔒 **同源代理，不裸嵌** | cookie / localStorage 与 harness 隔离，跨站读取返回 403 |
| 🧪 **13 项自动化测试** | 从激活链到 payload 体积，都有回归覆盖 |

## 两种标注方式

这是它和"点一下写句评论"的工具最大的区别 —— **不写也是有效的意见**：

| | 怎么做 | 发出去的样子 |
|---|---|---|
| **标注** | 点元素，**输入框留空**，保存 | `#1 [标注] .lb-hero` —— 只说"看这里" |
| **批注** | 点元素，**写一句说明**，保存 | `#2 [批注] .lb-band` + `note: 这个卡片太宽，改成 320px` |

**留空不是取消。** 点一下某个元素本身就是一条完整的意见，空评论会被原样保留为一条「标注」。
输入框上方的徽章随打字实时切换「标注 / 批注」，保存前你就能看到它会是哪一种。

## 安装

### 方式一：作为 bundle（推荐）

包内自带 `cordis.patch.yml`，靠 `dsh.bundle.patch` 自注册。

把包加进 Web profile 的 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-annotate"]
    }
  }
}
```

### 方式二：手动插入

在 Web profile 的 `cordis.patch.yml` 里插一条：

```yaml
- insert:
    - id: dsh-annotate
      name: 'dsh-annotate'
      config:
        enabled: true
        allowRemote: false
        allowExternalFiles: true
```

**改完必须重启 Web 端**，而且要在一个独立的终端里做 —— agent 就跑在 DSH 里面，
在会话里杀进程等于自杀：

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
cd <你的 deepseek-harness 目录>
pnpm dsh web --port 3000
```

> ⚠️ **只写 `cordis.patch.yml` 不生效。** 插件的**客户端半边**必须经 profile 的
> `dsh.profile.bundles` 激活；只写在 patch 里，宿主半边会加载、客户端半边会被静默跳过，
> 表现为**侧边栏根本没有这个页签**。

## 使用

1. 侧边栏开「标注」页签，或按 `⌘⇧B`
2. 上方选一个本地服务（自动探测端口 + 识别技术栈），或直接填地址；工作区里的 `.html` 也能直接开
3. 点「标记」→ 在预览里悬停，高亮框会显示选择器
4. 点一下元素 → 卡片弹在元素**下方**
5. 想写就写，不想写就直接保存
6. 列表按**页面从上到下**排好序，编号和页面里的标记针一一对应
7. 「加入输入框」把这段追加到草稿后面，并**留一行提示让你补需求**
   （`我想改的地方：`）；「发送」则直接发，不动草稿

`⌘/Ctrl+点击` 元素 = 写完立刻发送。

## 发出去的载荷

```
🎯 界面标注 · http://localhost:5173/ · 1440×900 (2)

#1 [批注] .lb-hero
   text: ¥126.84
   at: 57,166 155×44
   note: 这个数字太小，改成主色

#2 [标注] .lb-band
   text: 214,502
   at: 448,169 101×39
```

**刻意保持精简。** 选择器只出现一次（就在标题行），坐标用 `at: x,y w×h` 的紧凑写法，
`matches: n` 只在选择器是位置链、可能歧义时才输出。

实测同一组标注：**602 字符 → 192 字符，减少 68%**，且可读性更好。

### 选择器生成策略

按优先级取第一个能**唯一命中**的：

1. `#id`（且全文档唯一）
2. `[data-testid="..."]`
3. **唯一的 class** ← 最常用，如 `.lb-hero`
4. 位置链 `div:nth-of-type(2) > ...`（最多 6 层，弃用兜底）

优先 class 而不是位置链，是因为位置链对人没有信息量、且页面一改就失效。

## 它怎么工作

```
DSH 宿主
  └─ lib/index.js       起同源代理 + 注入 + HTTP API
        ↓ 代理
     目标应用
  lib/shim.js      改写 fetch/XHR/WebSocket，让子请求也走代理
  lib/overlay.js   帧内：拾取、标记针、评论卡片、页内存储
        ↕ postMessage
  client.js        侧边栏：编号列表、排序、载荷构建、会话发送
```

三个关键点：

1. **同源代理** —— 不直接嵌目标页。插件在 harness 源上起一个小代理转发过去，侧边栏嵌的是**代理**。
   同源，所以注入的拾取器能读 DOM；而目标应用的 cookie / localStorage 和 harness 隔开。
2. **剥掉六个阻止嵌入的响应头** —— `x-frame-options`、`content-security-policy`（含 report-only）、
   `cross-origin-opener-policy`、`cross-origin-embedder-policy`、`cross-origin-resource-policy`。
   任何一个在，页面就是白屏。
3. **标记针跟着元素走** —— 每次滚动/缩放都用实时的 `getBoundingClientRect()` 重新定位，不存坐标。
   元素被滚动出容器或裁掉时，针直接隐藏，不会飘到别的组件上。

## 安全边界

- **只允许 loopback 目标**。`allowRemote` 关着时，任何非 `localhost` / `127.0.0.1` / `::1` 的地址一律 403 ——
  这个代理不会变成通往内网或云元数据地址的跳板。
- **静态文件默认读不出工作区**。路径先 `realpath` 再和根目录比对，符号链接指向外面也会被拒；
  `.` 开头的路径段直接 403。需要在工作区外预览时，显式打开 `allowExternalFiles`。
- **预览不能被别的站点读**。带 `Sec-Fetch-Site: cross-site` 的请求会被拒。
- **cookie 按目标分区**。回程 `set-cookie` 会加上目标前缀并改写路径，两个预览之间不会串味。

## 已知会坏的情况

这些是这类方案共同的硬限制，不是 bug：

- 走 OAuth 跳转的登录流程
- 严格 CSP 的站点（`frame-ancestors` 被剥了，但页面内联脚本仍可能被 CSP 挡）
- Service Worker 驱动的离线应用
- Shadow DOM 内部、Canvas 绘制的内容
- 跨域子 iframe 里的元素
- **在线网站**：一期只支持本地目标（loopback + 工作区页面）。
  在线网站需要额外的 SSRF 加固，是二期。

## 开发

```bash
# 回归测试
node scripts/preflight-activation.mjs   # 激活链（真实 composeEntries）
node scripts/preflight-shapes.mjs       # 注册形状对 56 个真实 slot key 校验
node scripts/preflight-profile.mjs      # profile bundles 激活
node scripts/check-preflight-power.mjs  # 突变测试：注入 10 种故障，全部须被检出
node scripts/check-boot.mjs             # overlay 挂载（head/body 两种注入位置）
node scripts/check-overlay.mjs          # 标记 / 批注 / 空标注保留 / 卡片停靠
node scripts/check-client.mjs           # 客户端接线
node scripts/check-client-dom.mjs       # 真实 DOM 渲染
node scripts/check-layout.mjs           # 空间分配
node scripts/check-filepreview.mjs      # 文件预览入口 URL
node scripts/check-stacks.mjs           # 技术栈指纹（9 种，含"认不出就不猜"）
node scripts/check-selectors.mjs        # 选择器在真实页面上唯一
node scripts/check-payload.mjs          # 载荷体积与字段

# 冒烟 / 诊断
node scripts/smoke-host.mjs
node scripts/smoke-proxy.mjs
```

`check-preflight-power.mjs` 会**故意注入故障**来验证测试本身有效 ——
因为一套永远绿的测试等于没有测试。

## License

MIT
