<div align="center">

# dsh-annotate

**点选任意网页元素 —— 本地或在线 —— 写下你的意见，连同 DOM 上下文一起发进对话。**

[English](README.en.md) · **简体中文**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js ^22.19](https://img.shields.io/badge/node-%5E22.19%20%7C%20%3E%3D24-339933.svg)](package.json)
[![DSH 0.1.5-rc.1+](https://img.shields.io/badge/DSH-0.1.5--rc.1%2B-4d6bfe.svg)](https://www.npmjs.com/package/@deepseek-ai/dsh)
[![awesome · DSH plugin](https://img.shields.io/badge/awesome%C2%B7DSH%20plugin-annotation-5B4CF0.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

<!-- TODO: 效果图待补（截图从测试套件自动生成，避免过期）
![dsh-annotate 演示](assets/hero.png)
-->

> 🚧 **开发中** —— 正在实现中，欢迎 star 关注进展。

</div>

---

## 为什么需要它

用文字描述 UI 问题，永远说不精确：

> "那个按钮……就是右上角那个，点了没反应……"

`dsh-annotate` 让你**直接点**。选中元素，写下意见，模型收到的是这个：

```text
🎯 界面标注 · https://example.com/settings · 视口 1440×900（2 条）
#1 button.primary
   语义: aria-label="保存修改" · data-testid=save
   组件链: SettingsPage > SettingsForm > SubmitButton
   选择器: #root > form > button.primary（命中 1 个元素）
   位置/尺寸: 96×32 @ (640, 512) · 视口 正中
   当前样式: display:inline-block; padding:8px 16px; border-radius:6px
   文本: 保存修改
   批注: 表单没有变化时，这个按钮应该禁用。

#2 div.toast.error
   选择器: div.toast.error（命中 1 个元素）
   文本: 保存失败
   批注: 这个提示 3 秒就消失了，来不及看清，改成手动关闭。
```

**不是截图，是结构化事实。** 模型能精确定位到那一行代码。

---

## 与同类插件的区别

| 能力 | dsh-annotate | ZCode 式 | Codex 式 |
|---|:---:|:---:|:---:|
| 元素标注（点选 + DOM 事实） | ✅ | ✅ | ✅ |
| **评论反馈**（选中 → 写意见） | ✅ | ❌ | ✅ |
| **在线站点标注** | ✅ | ✅ | ❌ |
| **本地 HTML 文件标注**（`file://`） | ✅ | ❌ | ❌ |
| 侧边栏内置浏览器 | ✅ | 独立窗口 | ❌ |
| 模型可读页面（AI/ARIA 树） | ✅ | ✅ | ❌ |
| 一键开关在线访问 | ✅ | ❌ | — |

**核心差异**：同类插件要么只能访问在线站点（读不到本地原型图），要么只能访问本地
（`localhost` / 回环地址）。`dsh-annotate` **两者都支持，包括直接打开的本地 HTML 文件**。

---

## 为什么必须是浏览器扩展

你可能会问：**为什么不能直接在侧边栏里放个 iframe？**

因为浏览器的**同源策略**——这是 Web 安全模型，不是实现细节：

| 方案 | 访问在线站点 | 读取页面 DOM |
|---|:---:|:---:|
| iframe 内嵌 | ❌ `X-Frame-Options` 拦截 | ❌ **跨源读不到 DOM** |
| 临时回环代理 | ❌ 只能代理本地 | ✅ 仅本地 |
| **浏览器扩展** | ✅ 任意站点 | ✅ **content script 运行在页面内** |

即使绕过 `X-Frame-Options`，**跨源 iframe 依然无法执行 `document.querySelector`**。

只有扩展的 content script 是**运行在目标页面内部**的——它能读 DOM、能高亮、能监听点击。
**这是唯一的合法路径。**

**好处**：你用自己已经登录的浏览器，**cookie、登录态、扩展全部保留**。

---

## 安装

### 第 1 步：安装插件

```sh
dsh plugin --profile web add dsh-annotate
```

或者把下面这段直接发给你的 DSH：

> 帮我安装 dsh-annotate 插件：执行 `dsh plugin --profile web add dsh-annotate`，
> 然后告诉我浏览器扩展该怎么加载。

### 第 2 步：加载浏览器扩展

插件安装完成后，扩展文件会位于 `~/.dsh/dsh-annotate/extension/`（Windows:
`C:\Users\<你>\.dsh\dsh-annotate\extension\`）。

1. 打开 `edge://extensions`（或 `chrome://extensions`）
2. 打开右上角 **开发者模式**
3. 点 **加载解压缩的扩展**，选择上面那个目录
4. 加载后，点工具栏的鲸鱼图标固定它

> **为什么扩展不能自动装？** 浏览器的安全限制——任何软件都不能静默安装扩展。
> 这一步只能手动，一次即可。

### 第 3 步：重启

```sh
# 重启 DSH，然后刷新页面
```

---

## 使用

按 `Ctrl+Shift+A`（macOS 为 `⌘+Shift+A`）打开标注模式。

```text
打开侧边栏浏览器 → 访问任意页面 → 点"标注" → 悬停高亮 → 点击选中
   → 写评论 → 发送
```

### 两种发送方式

| 方式 | 怎么用 | 场景 |
|---|---|---|
| **直接发送** | 选中后按 `Enter` | 只想让模型看看这个元素 |
| **评论后发送** | 选中 → 写意见 → 发送 | **告诉模型哪里不对、应该怎么改** |

两种都在，随你选。

### 快捷键

| 按键 | 操作 |
|---|---|
| `Ctrl/⌘ + Shift + A` | 开关标注模式 |
| `Esc` | 退出标注模式 |
| `Enter` | 保存批注并继续 |
| `Shift + Enter` | 批注内换行 |
| `Ctrl/⌘ + 点击` | 保存并发送整批 |
| `Tab` | 在重叠元素间切换 |

### 支持的页面类型

| 类型 | 支持 |
|---|---|
| `https://` 在线站点 | ✅ |
| `http://` 本地服务 | ✅ |
| **`file://` 本地 HTML 文件** | ✅ **（拖进浏览器打开的原型图）** |
| `about:blank` / 特殊协议 | ❌ 浏览器限制 |

---

## 一键开关在线访问

首次在**非本地地址**上使用标注时，会弹出一个开关：

> ⚠️ **允许 dsh-annotate 访问在线网站？**
> 开启后，插件可以在你浏览的任意网站上读取页面结构和你选中的元素。
> 数据只发送到你本机的 DSH（`127.0.0.1`），不会上传到任何服务器。
> 你可以随时在设置里关闭。

**默认关闭**。开启后对所有站点生效，关闭后立即停止。

---

## 模型会读到什么

每一条标注包含：

| 字段 | 说明 |
|---|---|
| **选择器** | CSS 选择器 + 命中数量 |
| **语义属性** | `aria-label`、`data-testid`、`role` 等 |
| **组件链** | React / Vue 组件路径（开发构建下可用） |
| **几何信息** | 位置、尺寸、是否在视口内 |
| **计算样式** | 关键 CSS 属性 |
| **可见文本** | 最多 120 字符 |
| **你的批注** | 你写的那句话 |

**不包含**：截图（除非你主动开启）、表单里的敏感值、密码字段。

---

## 安全

- **数据不出本机**。所有标注通过本地回环 WebSocket（`127.0.0.1`）发送给你的 DSH。
- **不修改页面**。content script 只读，不注入样式，不改动 DOM 结构。
- **不记录凭据**。密码框、信用卡字段等敏感输入**不会被采集**。
- **页面内容不可信**。模型收到的页面文本会被标记为数据，永不作为指令执行。
- **在线访问默认关闭**，需你显式开启。

---

## 配置

```yaml
- insert:
    name: dsh-annotate
    config:
      host: 127.0.0.1
      port: 43120
      allowedExtensionId: ""      # 可选，填了更安全
      requestTimeoutMs: 300000
      maxPayloadBytes: 16777216
      includeScreenshot: false    # 默认不截图
```

---

## 开发

```sh
npm ci
npm run build       # 构建插件与扩展
npm test            # 在真实浏览器中驱动 client / overlay
npm run check       # 类型检查 + lint
```

仓库结构：

```
dsh-annotate/
├── src/                 DSH 插件（host 半区）
│   ├── index.ts         插件入口
│   ├── bridge.ts        本地回环 WebSocket 桥
│   └── protocol.ts      标注数据结构
├── extension/           浏览器扩展（MV3）
│   ├── manifest.json
│   ├── content.js       元素拾取 + DOM 提取
│   └── background.js
├── assets/              README 图片
└── docs/                截图与说明
```

---

## 已知限制

- **仅实测 Chromium 内核**（Edge / Chrome）。Firefox 未验证。
- **React 组件链需要开发构建**。生产构建下组件名会被压缩。
- **Shadow DOM 内部**：支持开放 shadow root，闭合的读不到。
- **跨源 iframe 内部**：受浏览器限制，部分场景不可用。
- **Canvas 内部对象**：无法拾取（那是像素，不是 DOM）。

---

## 贡献

欢迎 issue 和 PR。特别欢迎：

- Firefox 兼容性验证
- Vue / Svelte / Angular 的组件链提取
- 更多语言界面

---

## 许可证

[MIT](LICENSE)

这是独立的社区插件，与 DeepSeek 官方没有隶属或背书关系。

---

<div align="center">

如果这个插件帮你省下了描述 UI 问题的时间，欢迎点个 ⭐
—— 它能让更多遇到同样问题的人搜到它。

</div>
