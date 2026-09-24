# dsh-annotate

<div align="center">

**在 DSH 侧边栏里标注正在跑的页面 —— 点一下元素，说一句要改什么，直接发进对话。**

Codex / ZCode 同款的元素拾取体验，搬进 DeepSeek Harness。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4d6bfe.svg)](https://github.com/TheYoungChen/dsh-annotate)
[![tests](https://img.shields.io/badge/tests-12%20passing-brightgreen.svg)](scripts)

<img src="assets/hero.png" alt="dsh-annotate：左侧对话，右侧侧边栏预览里两个元素带高亮框，下方列出对应标注" width="100%">

</div>

---

## 它解决什么

让 AI 改界面，最麻烦的一步不是改，是**说清楚改哪儿**。

截图圈一下，再打字"就是那个卡片，右边那个灰色的"——AI 还是得猜。
猜错了，再来一轮。

这个插件把这一步变成**两次点击**：点元素，精确定位信息直接进对话。
AI 拿到的是 `.lb-hero` 和它的真实文本，不是一句模糊描述。

<!-- TODO(截图): 换成真实截图与录屏。当前 assets/hero.png 是按真实交互画的示意图，
     真实截图请覆盖同名文件即可，无需改 README。
     录屏放 assets/demo.gif（点「标记」→ 悬停 → 点选 → 写批注 → 加入输入框，10 秒内）。 -->

## 功能

- **两下点击完成标注** —— 悬停高亮并实时显示选择器，点一下即完成
- **标注 / 批注两种粒度** —— 只想说"看这里"就留空；要说明改什么就写一句
- **精确到元素** —— 生成唯一 CSS 选择器，优先语义化 class，而不是一长串 `nth-child`
- **一次发送多条** —— 按页面从上到下排序，编号与页面里的标记针一一对应
- **技术栈识别** —— 自动探测本地端口并识别框架（Vite / Next / React / Vue 等）
- **同源代理** —— 不裸嵌目标页，cookie 与 localStorage 按预览隔离

## 两种标注方式

这是它和"点一下写句评论"的工具最大的区别 —— **不写也是有效的意见**：

| | 怎么做 | 结果 |
|---|---|---|
| **标注** | 点元素，输入框**留空**，保存 | 记录"就是这个元素"，不带意见 |
| **批注** | 点元素，**写一句说明**，保存 | 记录元素 + 你的修改要求 |

**留空不是取消。** 点一下某个元素本身就是一条完整的意见，空评论会被原样保留为一条「标注」。
输入框上方的徽章随打字实时切换「标注 / 批注」，保存前就能看到它会变成哪一种。

## 安装

插件自带 `cordis.patch.yml`，通过 `dsh.bundle.patch` 自注册。

**把包加进 Web profile 的 `dsh.profile.bundles`：**

```json
{
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-annotate"]
    }
  }
}
```

**或者手动插入** Web profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-annotate
      name: 'dsh-annotate'
      config:
        enabled: true
        allowRemote: false
        allowExternalFiles: true
```

**然后重启 Web 端** —— 必须在一个独立的终端里做，因为 agent 就跑在 DSH 里面，
在会话里杀进程等于自杀：

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
cd <你的 deepseek-harness 目录>
pnpm dsh web --port 3000
```

> **只写 `cordis.patch.yml` 不生效。** 插件的客户端半边必须经 profile 的
> `dsh.profile.bundles` 激活。只写在 patch 里，宿主半边会加载、客户端半边被静默跳过，
> 表现为**侧边栏根本没有这个页签**。

## 使用

1. 侧边栏开「标注」页签，或按 `⌘⇧B`
2. 上方选一个本地服务（自动探测端口与技术栈），或直接填地址；工作区里的 `.html` 也能直接开
3. 点「标记」→ 在预览里悬停，高亮框显示选择器
4. 点一下元素 → 卡片弹在元素**下方**
5. 想写就写，不想写直接保存
6. 列表按**页面从上到下**排序，编号与页面里的标记针一一对应
7. 「加入输入框」把这份标注追加到草稿后面，并留一行 `我想改的地方：` 提示你补需求；
   「发送」则直接发出，不动草稿

`⌘/Ctrl+点击` 元素 = 写完立刻发送。

## 设计取舍

**选择器优先语义化 class。** 按优先级取第一个能唯一命中的：`#id` → `[data-testid]` →
唯一的 class → 位置链（最多 6 层，兜底）。位置链对人没有信息量，页面一改就失效；
`.lb-hero` 一眼就知道改哪儿。

**载荷刻意保持精简。** 选择器只出现一次，坐标用紧凑写法，`matches: n` 只在可能歧义时输出。
在同一组真实标注上实测：**602 字符 → 192 字符，减少 68%**，可读性反而更好。

**「加入输入框」是主操作，直接发送是次操作。** 直接发送会跳过"说明要改什么"这一步。

## 工作原理

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
   元素被滚出容器或裁掉时，针直接隐藏，不会飘到别的组件上。

## 安全边界

- **只允许 loopback 目标**。`allowRemote` 关着时，任何非 `localhost` / `127.0.0.1` / `::1` 的地址一律 403 ——
  这个代理不会变成通往内网或云元数据地址的跳板。
- **静态文件默认读不出工作区**。路径先 `realpath` 再和根目录比对，符号链接指向外面也会被拒；
  `.` 开头的路径段直接 403。需要预览工作区外的文件时，显式打开 `allowExternalFiles`。
- **预览不能被别的站点读**。带 `Sec-Fetch-Site: cross-site` 的请求会被拒。
- **cookie 按目标分区**。回程 `set-cookie` 会加目标前缀并改写路径，两个预览之间不会串味。

## 已知限制

这些是这类方案共同的硬限制，不是 bug：

- 走 OAuth 跳转的登录流程
- 严格 CSP 的站点（`frame-ancestors` 被剥了，但页面内联脚本仍可能被 CSP 挡）
- Service Worker 驱动的离线应用
- Shadow DOM 内部、Canvas 绘制的内容
- 跨域子 iframe 里的元素
- **在线网站**：当前只支持本地目标（loopback + 工作区页面）。
  在线网站需要额外的 SSRF 加固，尚未实现。

## 开发

```bash
# 回归测试（12 项）
node scripts/preflight-activation.mjs   # 激活链（真实 composeEntries）
node scripts/preflight-shapes.mjs       # 注册形状对真实 slot key 校验
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

## 文档

- `docs/design-principles.md` —— 设计原则
- `docs/reference-element-facts.ts` —— 元素信息采集参考实现（ARIA role 映射等），
  当前版本未启用，保留供将来扩展

## License

MIT
