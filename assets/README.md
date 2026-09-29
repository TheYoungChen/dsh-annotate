# 截图与录屏

根目录 `README.md` 引用的图片都放在这里。这篇记录**每张图是什么、怎么来的、怎么换**。

## 现状

四张截图 + 一段录屏，都是真图：

```
assets/hero.png              ← 主图：对话 + 侧边栏预览 + 标注气泡
assets/shot-detect.png       ← 发现本地服务：两个不同栈同时列出
assets/shot-accent.png       ← 标注配色：同一元素两种颜色的对比
assets/shot-attached.png     ← 发出后是附件：上下文注入 + 已附加胶囊消失
assets/demo.mp4              ← 十秒录屏（1.6 MB，已提交）
```

## 录屏：为什么是 mp4 不是 gif

同一段十秒的片段：

| 格式 | 体积 | 说明 |
|---|---|---|
| `.mp4` | **1.6 MB** | 有帧间压缩，1200×678 原画质 |
| `.gif` | **30 MB** | 逐帧存完整位图，256 色，还是糊的 |

差了将近二十倍，而且 GIF 那个更难看。原因是 GIF 格式本身没有帧间压缩 —— 它把每一帧
都当一张独立图片存，还各自带一份 256 色调色板。

所以 **`.gif` 被 `.gitignore` 排除，`.mp4` 提交进仓库**。1.6 MB 是 clone 能接受的代价，
换来的是：附件链接哪天失效、或者有人 fork 后离线看，视频都还在。

## 录屏怎么嵌入的

`README.md` 里放的是 GitHub 附件链接：

```markdown
https://github.com/user-attachments/assets/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

这个链接是**上传到 GitHub issue 评论框**得到的（不用真的提交那条 issue）：

1. 打开任意 issue 的评论框（自己仓库新建一个也行）
2. 把 `.mp4` 拖进输入框，等它上传完
3. GitHub 会自动插入链接，复制它
4. 粘到 README 里，那条 issue 不用提交

GitHub 会把它渲染成内嵌播放器。**那个 issue 建议留着别删** —— 虽然附件本身独立于
issue 存在，但保留它零成本，而视频挂掉是读者第一眼就看到的。

**仓库里的 `assets/demo.mp4` 是兜底。** README 在链接下面写了一句"看不了的话点这个"，
所以两个都要留。

## 四张截图分别要说明什么

| 文件名 | 说明什么 | 关键点 |
|---|---|---|
| `hero.png` | 整体形态 | 左侧对话、右侧预览；页面里一个元素带高亮框 + 编号针。**标两个元素，一个写批注、一个留空** —— 两种形态都要出现。 |
| `shot-detect.png` | 能认出本地在跑什么 | **同时列出 2~3 个不同栈**的服务，框架名要看得见。只列一个看不出识别能力。 |
| `shot-accent.png` | 配色可换且对比度达标 | 同一个元素**两种颜色左右拼图**。单张图表现不了"对比"，必须在编辑器里拼。 |
| `shot-attached.png` | 发出去的是附件 | 发送**之后**的状态：`# Web page elements` 那段展开、输入框上的胶囊已消失。这张最能区分于普通标注工具。 |

## 怎么重截

1. 启动 Web 端，打开右侧边栏的 **标注** 标签。
2. 预览里打开一个有真实内容的本地页面 —— 比空白起步页好看很多。
3. 点 **标记**，悬停到元素上，让高亮框和选择器读数同时可见，再点下去。

覆盖同名的 `.png` 即可，README 引用的就是 PNG，不需要改任何文字。

## 关于 `.svg` 源文件

`hero.png` 等早期是**占位示意图**（用 SVG 画好再渲染成 PNG），对应的 `.svg` 已经删掉了。
如果以后又新增占位图，记得在换成真截图后把 `.svg` 一并删掉，否则重跑渲染脚本会把真图
覆盖回示意图：

```bash
node scripts/render-hero.mjs            # 渲染本目录所有 .svg
node scripts/render-hero.mjs hero       # 只渲染某一个
```

## 另一个不该提交的图

`assets/.stack-marks-check.png` 是 `scripts/render-stack-marks.mjs` 生成的**技术栈 logo 对照表** ——
把 18 个 logo 按 64px 和真实的 14px 各排一遍，用来看哪个在列表里糊了。是开发时看的，
不是给人看的文档，已经写进 `.gitignore`。

```bash
node scripts/render-stack-marks.mjs     # 重新生成对照表
```
