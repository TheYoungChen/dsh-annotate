# 参与开发

欢迎提 issue 和 PR。这个文件说明**怎么在本机跑起来、改完怎么验证**。

## 这个插件怎么跑起来

它是一个 DSH 插件，分两半：

| 文件 | 跑在哪 | 职责 |
|---|---|---|
| `lib/index.js` | DSH 宿主进程 | 注册路由、探测端口、开预览代理、生成投递进对话的上下文 |
| `lib/overlay.js` | 被预览的页面里 | 元素拾取、高亮、编号针、把选区报回面板 |
| `client.js` | 侧边栏 | 面板 UI、标注列表、配色、发现菜单 |

`lib/overlay.js` 不是独立文件被请求的 —— 它会被**内联进预览 HTML**。

## 跑起来

```bash
# 1. 装到你的 DSH profile 里
#    在 DSH 的插件目录下指向这个仓库
git clone https://github.com/TheYoungChen/dsh-annotate.git
cd dsh-annotate

# 2. 语法检查（改完立刻跑，最省时间）
node --check client.js
node --check lib/index.js
node --check lib/overlay.js

# 3. 重启 DSH，打开右侧边栏的「标注」标签
```

改动生效需要**重启 DSH 进程**，除了 `client.js` —— 那个在开发模式下走 HMR。

## 改完必须验证

这个仓库的规矩是：**每个断言都要先在坏的代码上看到它失败**，否则不算数。

```bash
# 结构完整性：文件没被截断、括号配平、模块头还在
node scripts/check-structure.mjs

# 全部离线检查
node scripts/check-client.mjs
node scripts/check-overlay.mjs
node scripts/check-selector-target.mjs
node scripts/check-anchor-shape.mjs

# 变异检测：注入 36 个故障，每一个都必须被抓到
node scripts/check-preflight-power.mjs
```

**改完请跑 `check-preflight-power.mjs`。** 它才是真正证明测试有效的那个 ——
一堆全绿的测试可能什么都测不到，这个会把 bug 注进去看你抓不抓得到。

完整清单见 [README 的回归测试一节](README.md#回归测试)。

## 加一个新检查

新写的 `scripts/check-*.mjs` 应该：

1. **自己起环境**，不依赖外部正在跑的服务（除非名字里写明 `live-host`）
2. **失败时 `process.exit(1)`**，成功打印 `... PASSED`
3. **在 README 的命令清单里列出来** —— `check-readme.mjs` 会核对，漏了会失败

如果要断言一个新的 bug 类型，顺手在 `scripts/mutate.mjs` 加一个对应的变异，
再在 `check-preflight-power.mjs` 里加一条 case，证明检查真的抓得到。

## 代码风格

没有 lint 配置，靠约定：

- **不用分号**，单引号，2 空格缩进
- 注释解释**为什么**，不解释**是什么**。看着代码能读出来的东西不用写
- 一个函数做一件事，名字说清楚它做什么
- 中文注释可以，但代码标识符一律英文

## 提 PR 之前

- [ ] `node --check` 三个源文件都过
- [ ] 离线检查全绿
- [ ] `check-preflight-power.mjs` 36/36
- [ ] 改了导出/行为的话，README 和 CHANGELOG 一起更新
- [ ] 版本号按 `0.x.Y`：**功能改动进 Y 之外的位**，小修补进 Y

## 版本号规则

```
0.2.2
│ │ └─ 小修补 / 文案 / 测试
│ └─── 功能改动
└───── 大改版
```

## 许可

贡献的代码按 [MIT](LICENSE) 发布。
