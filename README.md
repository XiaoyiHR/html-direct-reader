# HTML Direct Reader · `html-direct-reader`（HTML 直接预览）

> **English abstract (for reviewers):** Render in-vault `.html` directly inside Obsidian. Local CSS, images, fonts and scripts are inlined as data URIs to bypass the app://local cross-origin limit, so documents display exactly as authored. In-page search, zoom, outline, fullscreen, scroll restore, and in-vault .html/.md link interception with back/forward navigation. Desktop and mobile.

> 一句话（中文）：让 Obsidian 里点开 `.html` 就像在浏览器里打开一样——**库内的图片 / CSS / 字体 / 脚本全部正常显示**，不用切出去，也不用看代码视图。

> **上传须知**：本文件上传到仓库根目录时，请改名为 **`README.md`**（仓库根只能有一个 README）。首段英文摘要会被显示在商店 listing 顶部，方便英文审核者理解。

## 它能做什么

- **相对资源零配置全可用**：库内图片 / CSS / 字体 / 脚本自动内联成 data URI，文档原样显示；不用改路径、不用起服务器、不用把整站塞进一个文件。
- **默认不开脚本，交互却全保留**：缩放、页内查找、外链拦截、库内链接接管、目录大纲，在脚本开关关闭时也照常生效。
- **库内 HTML 能"站内导航"**：点库内 `.html` 在当前视图打开并记入历史、`.md` 开新标签页，工具栏可后退 / 前进，把一批库内 HTML 串成"可浏览的小站"。
- **移动端可用**：安卓实测通过（v1.8.0 起）。

## 安装

### 方式一：官方社区商店（推荐，最省心）

1. 打开 Obsidian → 设置 → 第三方插件 → 关闭"安全模式"。
2. 浏览 → 搜索 **HTML Direct Reader**（显示名，或搜 ID `html-direct-reader`）→ 安装 → 启用。
3. 国内若商店加载慢，可先装 **OpenPlug** 等加速插件，再走上面步骤。

> 上架后粉丝只需这一条路，无需翻墙、无需 GitHub。

### 方式二：手动安装（上架前的过渡方案）

1. 从发布页下载 `main.js` / `manifest.json` / `styles.css` 三个文件。
2. 打开你的 vault 文件夹 → `.obsidian/plugins/`，新建文件夹 `html-direct-reader/`。
3. 把三个文件放进去 → 重启 Obsidian → 设置 → 第三方插件 → 启用。

## 快速开始

1. 在文件管理器里双击一个 `.html` / `.htm` 文件（或点链接打开它）——默认会用本插件渲染。
2. 顶部工具栏从左到右依次是：查找、缩放（－ / ＋）、全屏、源码/渲染切换、外部打开、目录大纲、后退、前进。
3. 想看交互效果（Canvas、表单、脚本动画）：点工具栏的 **脚本开关** 打开，再重新打开文档。

## 设置项

| 设置 | 作用 |
|---|---|
| 防重载浮层 | 桌面端开启后，切换标签 / 点链接不再重新加载页面（滚动位置、表单状态都留住） |
| 脚本开关 | 默认关闭；打开后允许文档内 JavaScript 运行 |
| 缩放档位 | 提供若干固定缩放比例，配合 Ctrl + 滚轮微调 |

## 移动端说明

- 已实测安卓（Obsidian 安卓版）。iOS 全屏基本不可用（系统限制，已兜底不崩），其余功能正常。
- 移动端自动切换 `srcdoc` 渲染，绕开安卓 webview 对 `blob:` 的静默拦截。
- 工具栏按钮针对触屏做了紧凑处理。

## 常见问题

**Q：为什么我的 HTML 里有些图片不显示？**
A：外链图片（以 `http` 开头）和跨 vault 的资源不内联，需要本身体可访问；库内相对路径的图片会自动内联。内联失败的资源会出现在"内联失败清单"里。

**Q：会改动我的原文件吗？**
A：不会。插件只读渲染，所有内联都在内存里完成。

**Q：支持 `file://` 本地绝对路径吗？**
A：不支持。只处理库内相对路径资源。

## 更新日志（摘要）

- **1.8.x**：移动端支持（实验性）、切标签滚动保持、移动端工具栏紧凑样式。
- 完整历史见发布页 Release Notes。

---

如果你觉得这个插件有用，欢迎在 B 站 / 论坛分享。问题反馈请在 GitHub 提 Issue。
