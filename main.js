/*
 * html-direct-reader — 在 Obsidian 内直接渲染 .html / .htm
 *
 * ── 为什么不用 app://local（重要，改动前请先读） ──────────────────────────
 * v1.0.0 ~ v1.2.0 用 iframe srcdoc + 注入 <base href="app://local/..."> 来解析
 * 相对资源。实测（2026-09-08）证明这条路是死的：
 *   · base 注入本身正确（document.baseURI 解析无误）
 *   · 但 srcdoc 文档继承 Obsidian 主窗口的源（host 不是 local），
 *     而库资源在 app://local（host = local）→ 不同源
 *   · 结果：CSS「规则不可读」、Image error、fetch Failed to fetch，
 *     连纯 ASCII 路径、连跨源 <script src>、连 iframe src=app://local 全部失败
 *   → 即「路径解析对了，请求发不出去」。
 *
 * 因此 v1.3.0 改走 Node 层预读 + 内联 + Blob URL：
 *   1. 用 vault.adapter 直接读盘（Node 权限，不存在浏览器跨源问题）
 *   2. CSS 内联成 <style>（并处理其内部的 url()），图片/字体转 data URI
 *   3. 拼好的 HTML 生成 Blob URL 交给 iframe
 * Blob URL 与创建者（Obsidian 主窗口）同源 → contentDocument 仍可访问，
 * 缩放 / 滚动保持 / 外链拦截全部保留，锚点也正常。
 * ──────────────────────────────────────────────────────────────────────
 */

const { Plugin, FileView, Notice, PluginSettingTab, Setting, TFile, Platform } = require('obsidian');

// ══════════════════════════════════════════════════════════════════════
//  全局可编辑配置
// ══════════════════════════════════════════════════════════════════════

const VIEW_TYPE_HTML = 'html-direct-reader-view';
const ZOOM_LEVELS = [50, 75, 100, 125, 150, 175, 200];
const RELOAD_DEBOUNCE_MS = 300;

// 单个资源超过此体积就不内联（该资源会加载失败并显示 alt / 回退样式）
const INLINE_LIMIT_OPTIONS = [2, 8, 20, 50]; // 单位 MB
const DEFAULT_INLINE_LIMIT_MB = 8;
// 单个文档内联总量上限（字节），防止超大页面把内存吃光
const MAX_TOTAL_INLINE_BYTES = 64 * 1024 * 1024;
// 已内联资源的缓存条目数（按 path → {mtime, uri, text}）
const INLINE_CACHE_MAX = 400;
// 每个文件的阅读位置记忆（记在插件级，跨视图实例与重载都有效），最多记多少个文件
const SCROLL_MEMO_MAX = 300;
// 还原阅读位置的重试时机（ms）。iframe 重载后文档高度往往还没撑开，
// 一次 scrollTo 会被夹到 0，所以要隔一会儿再试几次。
const SCROLL_RESTORE_DELAYS = [0, 60, 150, 300, 600];

// ── 防重载浮层（v1.7.8）────────────────────────────────────────
// 宿主要压住工作区内容，但必须低于命令面板 / 设置 / 右键菜单 / 通知
const FLOAT_HOST_Z_INDEX = 5;
// 宿主隐藏时不必每帧算位置，降频到每 N 帧查一次锚点回来没有。
// 别调太大：切回标签时最多要等 N 帧才会重新露面，20 帧≈333ms 肉眼可见地慢。
const FLOAT_HIDDEN_TICK = 6;
// 文档里出现这些动作说明用户在自己操作，立刻放弃排队中的还原
const SCROLL_CANCEL_EVENTS = ['wheel', 'mousedown', 'keydown', 'touchstart'];

// 走「文本 data URI」（encodeURIComponent）而非 base64 的扩展名：体积更小、可读性更好
const TEXTUAL_EXT = new Set([
  'css', 'js', 'mjs', 'cjs', 'json', 'svg', 'html', 'htm', 'xml', 'xsl', 'txt', 'map', 'webmanifest',
]);

const MIME = {
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
  json: 'application/json', map: 'application/json',
  html: 'text/html', htm: 'text/html', xml: 'application/xml', txt: 'text/plain',
  svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  apng: 'image/apng', tif: 'image/tiff', tiff: 'image/tiff',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  pdf: 'application/pdf',
};

// ══════════════════════════════════════════════════════════════════════
//  工具函数
// ══════════════════════════════════════════════════════════════════════

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function extOf(path) {
  const i = String(path).lastIndexOf('.');
  return i < 0 ? '' : String(path).slice(i + 1).toLowerCase();
}

function mimeOf(path) {
  return MIME[extOf(path)] || 'application/octet-stream';
}

// 把 'a/b/../c' 规范成 'a/c'
function normalizePath(p) {
  const out = [];
  for (const part of String(p).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

// 资源引用 → vault 相对路径；外链 / data URI / 锚点返回 null（保持原样不内联）
function resolveVaultPath(baseDir, url) {
  if (!url) return null;
  const raw = String(url).trim();
  if (!raw) return null;
  if (/^(data|blob|about|javascript|vbscript):/i.test(raw)) return null;
  if (/^(https?:)?\/\//i.test(raw)) return null;
  if (/^(mailto|tel|file):/i.test(raw)) return null;
  if (raw.charAt(0) === '#') return null;

  let p = raw.split('#')[0].split('?')[0];
  if (!p) return null;
  try { p = decodeURIComponent(p); } catch (e) { /* 非法编码就用原文 */ }

  const full = p.charAt(0) === '/' ? p.slice(1) : (baseDir ? baseDir + '/' + p : p);
  return normalizePath(full);
}

function base64FromBytes(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function textToDataUri(text, mime) {
  return 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(text);
}

function bytesToDataUri(bytes, mime) {
  return 'data:' + mime + ';base64,' + base64FromBytes(bytes);
}

// 匹配 CSS 里的 url(...)，捕获引号以便原位还原
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

// ══════════════════════════════════════════════════════════════════════
//  视图
// ══════════════════════════════════════════════════════════════════════

class HtmlReaderView extends FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.frame = null;
    this.scriptBtn = null;
    this.zoomLabel = null;
    this.resLabel = null;
    this.findBtn = null;
    this.findBar = null;
    this.findInput = null;
    this.findCountEl = null;
    this._findQuery = '';
    this._findIdx = 0;
    this._findTotal = 0;
    this._findTimer = null;
    this._renderKey = null;
    this._renderPath = null;
    this._reloadTimer = null;
    this._blobUrl = null;
    // 阅读位置记忆（v1.7.7）：位置存在插件级 Map 里，这里只放监听句柄
    this._memoScrollFn = null;
    this._memoPageHideFn = null;
    this._memoInputFn = null;
    this._restoreTimers = [];
    // 闸门：iframe 刚重载时程序性的滚动（归 0、我们自己的还原）不算数，
    // 只有用户真的动过（滚轮 / 点击 / 按键）才允许记录
    this._scrollReady = false;
    // 前进 / 后退历史栈（v1.5.0）
    this._history = [];
    this._historyIdx = -1;
    this.backBtn = null;
    this.fwdBtn = null;
    // 内联失败清单 + 目录大纲（v1.6.0）
    this._toc = [];
    this._lastStat = null;
    this.failPanel = null;
    this.tocPanel = null;
    this.tocBtn = null;
    // 大纲滚动同步（v1.7.2）
    this._tocScrollFn = null;
    this._tocScrollTimer = null;
    // 大纲「点击外部 / Esc 关闭」（v1.7.3）
    this._tocDocFn = null;
    this._tocFrameFn = null;
    this._tocKeyFn = null;
    // 源码 / 渲染切换 + 全屏（v1.7.0）
    this._rawHtml = null;        // 库内原始 HTML 文本
    this._inlinedHtml = null;    // 经过内联处理后的 HTML（B 视图）
    this._sourceMode = false;    // false=渲染，true=源码
    this._sourceView = 'raw';    // 'raw' | 'inlined'
    this.sourcePanel = null;
    this.sourceCode = null;
    this.srcRawBtn = null;
    this.srcInlinedBtn = null;
    this.sourceBtn = null;
    this.fullscreenBtn = null;
    this._fsHandler = null;
    // 防重载浮层（v1.7.8）：UI 的真实父容器与量位置用的锚点
    this.hostEl = null;
    this.anchorEl = null;
    this._floatMode = false;
    this._rafId = null;
    this._rafTick = 0;
    this._hostShown = false;
    this._hostRect = { t: -1, l: -1, w: -1, h: -1, shown: null, inFs: false };
    this._activateFn = null;
  }

  getViewType() { return VIEW_TYPE_HTML; }
  getDisplayText() { return this.file ? this.file.name : 'HTML 预览'; }
  getIcon() { return 'globe'; }

  // 视图是否还活着。浮层模式下 UI 在常驻宿主里，宿主在就算活着
  isLive() {
    if (this._floatMode) return !!(this.hostEl && this.hostEl.isConnected);
    return !!(this.frame && this.frame.isConnected);
  }

  async onOpen() {
    this.ensureUI();
    this.registerVaultEvents();
    // 桌面端 this.file 通常由框架在 onLoadFile 之前设好；移动端某些版本打开文件时
    // 不先设 this.file、也不调 onLoadFile（或调用晚于 onOpen），导致一开始 this.file 为空。
    // 用当前活动文件兜底，确保打开 .html 时一定能拿到文件去渲染（探针第三步修复）
    if (!this.file) {
      const af = this.resolveMobileFile();
      if (af) this.file = af;
    }
    if (this.file) {
      await this.renderHtml(false, 'onOpen');
    } else {
      this.showMessage('没有可预览的 HTML 文件。', '#888');
    }
  }

  // 移动端兜底：打开 .html 时它通常就是工作区当前活动文件
  resolveMobileFile() {
    try {
      const af = this.app.workspace.getActiveFile();
      if (af && (af.extension === 'html' || af.extension === 'htm')) return af;
    } catch (e) { /* 忽略 */ }
    return null;
  }

  async onClose() {
    this.stopFloatSync();
    this.destroyHost();
    this.resetUIState();
    this.plugin.flushSettings();
    const ce = this.contentEl;
    if (ce) {
      ce.empty();
      ce.removeClass('html-reader-anchorhost');
    }
  }

  // 把 UI 相关的引用清干净：关闭视图与重建 UI（浮层开关切换）都会走这里
  resetUIState() {
    clearTimeout(this._reloadTimer);
    this._reloadTimer = null;
    clearTimeout(this._findTimer);
    this._findTimer = null;
    this.cancelScrollRestore();
    this.detachVisibilityWatch();
    this._memoScrollFn = null;
    this._memoPageHideFn = null;
    this._memoInputFn = null;
    this._restoreTimers = [];
    this._scrollReady = false;
    this.plugin.flushSettings();
    this.releaseBlob();
    this.contentEl.empty();
    this.frame = null;
    this.scriptBtn = null;
    this.zoomLabel = null;
    this.resLabel = null;
    this.findBtn = null;
    this.findBar = null;
    this.findInput = null;
    this.findCountEl = null;
    this._findQuery = '';
    this._findIdx = 0;
    this._findTotal = 0;
    this._renderKey = null;
    this._renderPath = null;
    this._history = [];
    this._historyIdx = -1;
    this.backBtn = null;
    this.fwdBtn = null;
    this._toc = [];
    this._lastStat = null;
    this.failPanel = null;
    this.tocPanel = null;
    this.tocBtn = null;
    // 大纲滚动同步（v1.7.2）
    this._tocScrollFn = null;
    this._tocScrollTimer = null;
    // 大纲「点击外部 / Esc 关闭」（v1.7.3）
    this._tocDocFn = null;
    this._tocFrameFn = null;
    this._tocKeyFn = null;
    this._rawHtml = null;
    this._inlinedHtml = null;
    this._sourceMode = false;
    this._sourceView = 'raw';
    this.sourcePanel = null;
    this.sourceCode = null;
    this.srcRawBtn = null;
    this.srcInlinedBtn = null;
    this.sourceBtn = null;
    this.fullscreenBtn = null;
    if (this._fsHandler) {
      document.removeEventListener('fullscreenchange', this._fsHandler);
      this._fsHandler = null;
    }
    if (this._tocKeyFn) {
      document.removeEventListener('keydown', this._tocKeyFn, true);
      this._tocKeyFn = null;
    }
    if (document.fullscreenElement) {
      try { document.exitFullscreen(); } catch (e) { /* 忽略 */ }
    }
  }

  async onLoadFile(file) {
    // 移动端框架不一定会在调用 onLoadFile 之前把 this.file 设好，
    // 必须显式接管，否则 this.file 为空 → renderHtml 走「无文件」分支（经典移动端坑）
    this.file = file;
    await this.renderHtml(false, 'onLoadFile');
  }

  registerVaultEvents() {
    if (this._eventsRegistered) return;
    this._eventsRegistered = true;

    const onModify = (file) => {
      if (!this.isLive() || !this.plugin.settings.autoReload) return;
      if (!this.file || file.path !== this.file.path) return;
      clearTimeout(this._reloadTimer);
      this._reloadTimer = setTimeout(() => this.renderHtml(true), RELOAD_DEBOUNCE_MS);
    };

    const onRename = (file, oldPath) => {
      if (!this.isLive()) return;
      if (this._renderPath && oldPath === this._renderPath) this.renderHtml(true);
    };

    const refModify = this.app.vault.on('modify', onModify);
    const refRename = this.app.vault.on('rename', onRename);
    if (typeof this.registerEvent === 'function') {
      this.registerEvent(refModify);
      this.registerEvent(refRename);
    } else {
      this.plugin.registerEvent(refModify);
      this.plugin.registerEvent(refRename);
    }
  }

  ensureUI() {
    if (this.hostEl && this.hostEl.isConnected) return;              // 浮层：宿主常驻
    if (!this.hostEl && this.frame && this.frame.isConnected) return; // 内嵌
    this.buildHostAndUI();
  }

  // ── 防重载浮层（v1.7.8）────────────────────────────────────────
  // Obsidian 切走标签时会把该标签的 DOM 整个摘掉（detach），里面的 iframe
  // 因此被 Chromium 强制重新导航：页面重新解析、资源重新加载、脚本重新跑一遍，
  // Canvas / 表单 / 滚动日志这些状态全丢 —— 滚动记忆是补不回来的。
  //
  // 解法：把整套 UI 放进挂在 document.body 下的常驻宿主，视图里只留一个锚点
  // div 用来量位置，宿主每帧贴上去。iframe 全程不离开文档 → 不会被重新导航。
  //
  // 两种必须降级回内嵌的情况：
  //   1) 视图在独立弹出窗口里：contentEl 属于另一个 document，无法跨窗口算位置
  //   2) 用户在设置里关掉了这个开关
  wantFloatHost() {
    if (!this.plugin || !this.plugin.settings) return false;
    if (!this.plugin.settings.floatHost) return false;
    // 移动端单窗格、通常只挂一个 leaf，Obsidian 不会像桌面那样 detach 非活动标签，
    // 不需要「防重载浮层」。而且移动端 contentEl 的 ownerDocument 就绪时机不稳定，
    // 浮层宿主会在 onOpen / onLoadFile 两次调用间翻转，建出两个 frame：
    // onOpen 把「没有可预览」写进一个 frame，onLoadFile 把 blob 渲染进另一个 frame，
    // 屏上看到的始终是带死消息的那个 → 表现就是「渲染成功通知已弹，页面却仍是没文件」。
    // 直接关掉浮层、渲染进 leaf 本身，反而更简单也更稳（这也是移动端推荐形态）。
    if (Platform && Platform.isMobile) return false;
    const ce = this.contentEl;
    return !!(ce && ce.ownerDocument && ce.ownerDocument === window.document);
  }

  buildHostAndUI() {
    const ce = this.contentEl;
    if (!ce) return;
    ce.empty();
    ce.addClass('html-reader-anchorhost');

    this._floatMode = this.wantFloatHost();

    let root = ce;
    if (this._floatMode) {
      this.anchorEl = ce.createEl('div', { cls: 'html-reader-anchor' });
      const host = window.document.createElement('div');
      host.className = 'html-reader-host';
      host.style.zIndex = String(FLOAT_HOST_Z_INDEX);
      window.document.body.appendChild(host);
      this.hostEl = host;
      root = host;
    } else {
      this.anchorEl = null;
      this.hostEl = null;
      this.stopFloatSync();
    }
    this.buildUI(root);
    if (this._floatMode) this.startFloatSync();
  }

  // 浮层开关切换后：换一个父容器把整套 UI 重搭一遍（iframe 会重载一次，躲不掉）
  rebuildUI() {
    this.stopFloatSync();
    this.destroyHost();
    this.resetUIState();
    const ce = this.contentEl;
    if (ce) {
      ce.empty();
      ce.removeClass('html-reader-anchorhost');
    }
    this._renderKey = null;
    this._renderPath = null;
    this.ensureUI();
    this.renderHtml(true);
  }

  destroyHost() {
    const host = this.hostEl;
    if (host) {
      try { if (host.parentNode) host.parentNode.removeChild(host); } catch (e) { /* 忽略 */ }
    }
    this.hostEl = null;
    this.anchorEl = null;
    this._hostShown = false;
    this._hostRect = { t: -1, l: -1, w: -1, h: -1, shown: null, inFs: false };
  }

  startFloatSync() {
    this.stopFloatSync();
    const tick = () => {
      this._rafId = window.requestAnimationFrame(tick);
      this._rafTick++;
      // 藏着的时候不必每帧算，降频即可
      if (!this._hostShown && this._rafTick % FLOAT_HIDDEN_TICK !== 0) return;
      this.syncHostRect();
    };
    this._rafId = window.requestAnimationFrame(tick);
  }

  stopFloatSync() {
    if (this._rafId) {
      window.cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  syncHostRect() {
    const host = this.hostEl;
    const a = this.anchorEl;
    if (!host || !a) return;
    const m = this._hostRect;

    // 全屏时让浏览器自己铺满：内联的 top/left/width/height 优先级高于 UA 全屏样式，
    // 留着会把宿主钉在原来的位置，必须清掉
    if (document.fullscreenElement === host) {
      if (m.inFs) return;
      m.inFs = true;
      host.style.top = '';
      host.style.left = '';
      host.style.width = '';
      host.style.height = '';
      host.style.inset = '0';
      return;
    }
    if (m.inFs) {
      m.inFs = false;
      host.style.inset = '';
      m.t = -1; m.l = -1; m.w = -1; m.h = -1;
    }

    if (!a.isConnected) { this.setHostRect(host, 0, 0, 0, 0, false); return; }
    const r = a.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) { this.setHostRect(host, 0, 0, 0, 0, false); return; }
    // 滚出视口（工作区滚到别处）也收起来，免得飘在屏幕上
    if (r.bottom < 1 || r.top > window.innerHeight - 1 ||
        r.right < 1 || r.left > window.innerWidth - 1) {
      this.setHostRect(host, 0, 0, 0, 0, false);
      return;
    }
    this.setHostRect(host, r.top, r.left, r.width, r.height, true);
  }

  setHostRect(host, top, left, width, height, shown) {
    const m = this._hostRect;
    // 先落位再显形，避免显形那一帧还停在旧坐标上
    if (shown) {
      const t = Math.round(top), l = Math.round(left);
      const w = Math.round(width), h = Math.round(height);
      if (m.t !== t) { host.style.top = t + 'px'; m.t = t; }
      if (m.l !== l) { host.style.left = l + 'px'; m.l = l; }
      if (m.w !== w) { host.style.width = w + 'px'; m.w = w; }
      if (m.h !== h) { host.style.height = h + 'px'; m.h = h; }
    }
    if (m.shown === shown) return;
    // 只切 visibility，绝不切 display：display:none 会销毁布局盒，
    // iframe 的滚动位置会被浏览器重置（v1.7.8 就是栽在这里）
    if (typeof host.toggleClass === 'function') host.toggleClass('is-shown', !!shown);
    else if (host.classList) host.classList.toggle('is-shown', !!shown);
    m.shown = shown;
    this._hostShown = shown;
    if (shown) this.onHostShown();
    else this.onHostHidden();
  }

  // 宿主重新露面（切回标签 / 展开侧边栏）。
  // 必须在这里补一次位置还原：iframe 没被重载就不会有 load 事件，
  // afterFrameLoad() 不会跑，restoreScroll() 也就没有别的触发时机了。
  onHostShown() {
    this.restoreScroll();
  }

  // 宿主被收起之前先把阅读位置记下来。
  // 就算 visibility 保住了布局，也留一道兜底：真被重置了还有记忆可以还原。
  onHostHidden() {
    this.captureScrollMemo();
  }

  // UI 不在 leaf 的 DOM 里，点它不会让 Obsidian 把该标签设为活动，
  // 结果就是 Esc 关不掉大纲、命令作用到别的视图上。这里补一刀。
  activateLeaf() {
    try {
      const ws = this.app && this.app.workspace;
      if (!ws || ws.activeLeaf === this.leaf) return;
      // 不传 focus：只把标签设为活动，不抢焦点（否则会打断 iframe 里的输入）
      if (typeof ws.setActiveLeaf === 'function') ws.setActiveLeaf(this.leaf);
    } catch (e) { /* 忽略 */ }
  }

  buildUI(container) {
    container.empty();
    container.addClass('html-reader-container');
    // 移动端屏幕窄：整体换一套紧凑尺寸（配套样式见 styles.css 的 .html-reader-mobile）
    if (Platform && Platform.isMobile) container.addClass('html-reader-mobile');

    // 浮层模式下点 UI 不会让 Obsidian 认这个标签为活动，补一刀（见 activateLeaf）
    this._activateFn = () => this.activateLeaf();
    container.addEventListener('mousedown', this._activateFn, true);

    const toolbar = container.createEl('div', { cls: 'html-reader-toolbar' });

    const reloadBtn = toolbar.createEl('button', { cls: 'html-reader-btn', text: '重新加载' });
    reloadBtn.addEventListener('click', () => this.renderHtml(true));

    const backBtn = toolbar.createEl('button', { cls: 'html-reader-btn', text: '‹ 后退' });
    backBtn.setAttribute('aria-label', '后退');
    backBtn.addEventListener('click', () => this.goBack());
    this.backBtn = backBtn;

    const fwdBtn = toolbar.createEl('button', { cls: 'html-reader-btn', text: '前进 ›' });
    fwdBtn.setAttribute('aria-label', '前进');
    fwdBtn.addEventListener('click', () => this.goForward());
    this.fwdBtn = fwdBtn;

    const openBtn = toolbar.createEl('button', {
      cls: 'html-reader-btn',
      // 移动端这个最长，缩成 4 个字省下的宽度够放两个按钮
      text: Platform && Platform.isMobile ? '外部打开' : '外部浏览器打开',
    });
    openBtn.setAttribute('aria-label', '在外部浏览器中打开');
    openBtn.addEventListener('click', () => this.openExternal());

    const scriptBtn = toolbar.createEl('button', { cls: 'html-reader-btn' });
    scriptBtn.addEventListener('click', async () => {
      this.plugin.settings.allowScripts = !this.plugin.settings.allowScripts;
      await this.plugin.saveSettings();
      this.plugin.syncViews();
    });
    this.scriptBtn = scriptBtn;
    this.updateScriptBtn();

    const findBtn = toolbar.createEl('button', { cls: 'html-reader-btn', text: '查找' });
    findBtn.setAttribute('aria-label', '在页面内查找（Ctrl+F）');
    findBtn.addEventListener('click', () => this.toggleFind(true));
    this.findBtn = findBtn;

    const tocBtn = toolbar.createEl('button', { cls: 'html-reader-btn', text: '大纲' });
    tocBtn.setAttribute('aria-label', '目录大纲');
    tocBtn.addEventListener('click', () => this.toggleToc());
    this.tocBtn = tocBtn;

    const zoomWrap = toolbar.createEl('div', { cls: 'html-reader-zoom' });
    this.zoomWrap = zoomWrap;
    const zoomOutBtn = zoomWrap.createEl('button', { cls: 'html-reader-btn', text: '－' });
    zoomOutBtn.setAttribute('aria-label', '缩小');
    this.zoomLabel = zoomWrap.createEl('span', { cls: 'html-reader-zoom-label' });
    const zoomInBtn = zoomWrap.createEl('button', { cls: 'html-reader-btn', text: '＋' });
    zoomInBtn.setAttribute('aria-label', '放大');
    zoomOutBtn.addEventListener('click', () => this.stepZoom(-1));
    zoomInBtn.addEventListener('click', () => this.stepZoom(1));
    this.updateZoomLabel();

    // 内联资源的结果反馈：成功数 / 失败数（失败时点击展开清单）
    this.resLabel = toolbar.createEl('span', { cls: 'html-reader-res' });
    this.resLabel.addEventListener('click', () => this.toggleFailPanel());
    this.updateResLabel(null);

    const sourceBtn = toolbar.createEl('button', { cls: 'html-reader-btn', text: '源码' });
    sourceBtn.setAttribute('aria-label', '切换源码 / 渲染视图');
    sourceBtn.addEventListener('click', () => this.toggleSource());
    this.sourceBtn = sourceBtn;

    const fullscreenBtn = toolbar.createEl('button', { cls: 'html-reader-btn', text: '全屏' });
    fullscreenBtn.setAttribute('aria-label', '切换全屏');
    fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
    this.fullscreenBtn = fullscreenBtn;

    this.buildFindBar(toolbar);

    this.frame = container.createEl('iframe', { cls: 'html-reader-frame' });
    this.frame.addEventListener('load', () => this.afterFrameLoad());
    // 只在「内嵌模式」挂（v1.8.1）。判据是 _floatMode，不是 isMobile ——
    // 桌面端并非只有浮层一种形态：设置里可以关掉浮层、视图被拖进独立弹出窗口时
    // 也会自动降级为内嵌，这两种桌面场景同样会被归零、而且没有 onHostShown 兜底。
    // 浮层模式下宿主常驻 document.body，iframe 从不离开文档，不可能被归零 → 白挂，跳过。
    // 内嵌模式（含移动端，已真机确认是 display:none、iframe 不重载、没有 load 事件）
    // 下，「重新露面」是唯一的还原时机，必须留。
    if (!this._floatMode) this.attachVisibilityWatch();

    // 内联失败清单（失败数 > 0 时点击「资源 ✓N ✗M」展开）
    this.failPanel = container.createEl('div', { cls: 'html-reader-failpanel is-hidden' });
    // 目录大纲（点击工具栏「大纲」展开，点击条目滚到对应标题）
    this.tocPanel = container.createEl('div', { cls: 'html-reader-tocpanel is-hidden' });
    this.tocPanel.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('.html-reader-tocclose')) { this.toggleToc(); return; }
      const btn = t.closest('.html-reader-tocitem');
      if (!btn) return;
      this.scrollToHeading(btn.getAttribute('data-id'));
    });

    // 点击大纲面板以外 → 关闭（v1.7.3）
    // 注意：iframe 是独立文档，父窗口收不到它内部的点击，所以「文档正文」那一路
    // 由 attachTocOutsideClick() 单独挂到 iframe 的 document 上（Blob 同源，可访问）。
    this._tocDocFn = (e) => {
      if (!this.tocPanel || this.tocPanel.hasClass('is-hidden')) return;
      const t = e.target;
      if (!t) return;
      if (this.tocPanel.contains(t)) return;
      // 点「大纲」按钮时交给按钮自己的 click 去 toggle，否则会「关了又开」
      if (this.tocBtn && this.tocBtn.contains(t)) return;
      this.closeToc();
    };
    container.addEventListener('mousedown', this._tocDocFn, true);

    // Esc 关闭大纲；查找栏开着时先关查找栏（v1.7.3）
    this._tocKeyFn = (e) => {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      if (document.fullscreenElement) return; // 全屏下 Esc 留给浏览器退出全屏
      const leaf = this.app.workspace.activeLeaf;
      if (!leaf || leaf.view !== this) return; // 只处理当前激活的本插件视图
      if (this.findBar && !this.findBar.hasClass('is-hidden')) {
        e.preventDefault();
        e.stopPropagation();
        this.toggleFind(false);
        return;
      }
      if (!this.tocPanel || this.tocPanel.hasClass('is-hidden')) return;
      e.preventDefault();
      e.stopPropagation();
      this.closeToc();
    };
    document.addEventListener('keydown', this._tocKeyFn, true);

    // 源码 / 渲染切换（v1.7.0）：覆盖在 iframe 之上，纯文本展示，不依赖 allow-scripts
    this.sourcePanel = container.createEl('div', { cls: 'html-reader-sourcepanel is-hidden' });
    const srcHead = this.sourcePanel.createEl('div', { cls: 'html-reader-sourcehead' });
    srcHead.createEl('span', { cls: 'html-reader-sourcetitle', text: '源码视图' });
    const srcToggle = srcHead.createEl('div', { cls: 'html-reader-sourcetoggle' });
    this.srcRawBtn = srcToggle.createEl('button', { cls: 'html-reader-btn is-active', text: '原始源码' });
    this.srcRawBtn.addEventListener('click', () => this.setSourceView('raw'));
    this.srcInlinedBtn = srcToggle.createEl('button', { cls: 'html-reader-btn', text: '内联后' });
    this.srcInlinedBtn.addEventListener('click', () => this.setSourceView('inlined'));
    const srcClose = srcHead.createEl('button', { cls: 'html-reader-btn', text: '✕' });
    srcClose.setAttribute('aria-label', '返回渲染视图');
    srcClose.addEventListener('click', () => this.toggleSource(false));
    const srcPre = this.sourcePanel.createEl('pre', { cls: 'html-reader-sourcepre' });
    this.sourceCode = srcPre.createEl('code', { cls: 'html-reader-sourcecode' });

    // 全屏状态变化（含按 Esc 退出）时同步按钮文案
    this._fsHandler = () => this.updateFullscreenBtn();
    document.addEventListener('fullscreenchange', this._fsHandler);

    this._renderKey = null;
    this._renderPath = null;
  }

  releaseBlob() {
    if (this._blobUrl) {
      try { URL.revokeObjectURL(this._blobUrl); } catch (e) { /* 忽略 */ }
      this._blobUrl = null;
    }
  }

  // 移动端渲染模式：直接把内联后的 HTML 写进 srcdoc，绕开 blob:
  // 移动端 webview 的 CSP 可能拦掉 blob: 导航。这种失败是「静默」的：
  // iframe 不报错、不触发 error，而是继续显示上一个已加载的文档
  // （也就是 onOpen 写的「没有可预览」死消息），所以代码层面完全看不出异常。
  // srcdoc 的内容本就内联在属性里，不触发 blob: 这个资源类型，天然免疫。
  // 且 srcdoc 文档继承父窗口源，配 allow-same-origin 后父窗口照样能操作其 DOM，
  // 缩放 / 查找 / 滚动记忆 / 库内链接接管全部不受影响。
  useSrcdoc() {
    return !!(Platform && Platform.isMobile);
  }

  setFrameSrcdoc(html) {
    if (!this.frame) return;
    this.releaseBlob();
    this.frame.removeAttribute('src');
    // srcdoc 赋相同值不一定触发重新导航 → 先摘掉再写
    this.frame.removeAttribute('srcdoc');
    this.frame.srcdoc = html;
  }

  // 换 iframe 的 src：回收上一个 URL，并赋新值。
  // 注意：赋一个和当前相同的 src 不会触发 load 事件，那种情况要手动跑一遍加载后的动作。
  setFrameSrc(url) {
    // srcdoc 优先级高于 src，切换时必须先摘掉
    this.frame.removeAttribute('srcdoc');
    const prev = this._blobUrl;
    this._blobUrl = url;
    if (prev && prev !== url) {
      try { URL.revokeObjectURL(prev); } catch (e) { /* 忽略 */ }
    }
    if (this.frame.getAttribute('src') === url) {
      this.afterFrameLoad();
    } else {
      this.frame.src = url;
    }
  }

  async renderHtml(force = false, caller = '?') {
    this.ensureUI();
    if (!this.frame) return;

    const file = this.file;
    const s = this.plugin.settings;
    const sandbox = s.allowScripts ? 'allow-scripts allow-same-origin' : 'allow-same-origin';

    // 文件 / 版本 / 沙箱 / 内联配置任一变化才重新渲染
    const key = [
      file ? file.path + '|' + (file.stat ? file.stat.mtime : 0) : 'no-file',
      sandbox,
      s.inlineResources ? 'in' : 'raw',
      s.inlineLimitMb,
    ].join('|');
    if (!force && key === this._renderKey) return;

    const path = file ? file.path : null;
    // 只在「真的要离开当前这一页」时记录位置。
    // 同一路径的重渲染不能记：那时 iframe 可能已经重载归零，会把记下的位置覆盖成 0。
    if (path !== this._renderPath) this.captureScrollMemo();

    this._renderKey = key;
    this._renderPath = path;
    // 改 sandbox 属性会让浏览器丢弃并重新加载 iframe，值没变就别写
    if (this.frame.getAttribute('sandbox') !== sandbox) {
      this.frame.setAttribute('sandbox', sandbox);
    }

    if (!file) {
      this.showMessage('没有可预览的 HTML 文件。', '#888');
      return;
    }

    try {
      const raw = await this.app.vault.read(file);
      this._rawHtml = raw;
      let html = raw;
      let stat = null;

      if (s.inlineResources) {
        const prepared = await this.prepareHtml(raw, file);
        html = prepared.html;
        stat = prepared.stat;
        this._inlinedHtml = prepared.html;
      } else {
        this._inlinedHtml = null;
      }
      this.updateResLabel(stat);

      // 移动端走 srcdoc 绕开 blob:（见 useSrcdoc 注释）；桌面端维持 blob: 以保同源编排
      const mode = this.useSrcdoc() ? 'srcdoc' : 'blob';
      if (mode === 'srcdoc') {
        this.setFrameSrcdoc(html);
      } else {
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        this.setFrameSrc(URL.createObjectURL(blob));
      }

      this.recordHistory();
      if (this._sourceMode) this.renderSource();
    } catch (e) {
      new Notice('HTML 预览失败: ' + e.message);
      this.showMessage('读取失败: ' + e.message, '#c00');
    }
  }

  /**
   * 把 HTML 里指向库内文件的引用全部内联，返回可直接交给 Blob 的字符串。
   * 内联失败的资源保持原样（加载时会失败并显示 alt / 回退样式），不阻断渲染。
   */
  async prepareHtml(raw, file) {
    const baseDir = file.parent && file.parent.path !== '/' ? file.parent.path : '';
    const parser = new DOMParser();
    const doc = parser.parseFromString(raw, 'text/html');
    const stat = { ok: 0, fail: 0, totalBytes: 0, failList: [] };
    const maxBytes = this.plugin.maxInlineBytes();
    const budget = { left: MAX_TOTAL_INLINE_BYTES };

    // ---- 1. <link rel="stylesheet"> → <style> ----
    const links = Array.prototype.slice.call(doc.querySelectorAll('link[rel~="stylesheet"][href]'));
    for (const link of links) {
      const vp = resolveVaultPath(baseDir, link.getAttribute('href'));
      if (!vp) continue;
      const res = await this.plugin.readResource(vp, maxBytes, budget);
      if (!res.ok || res.text == null) {
        stat.failList.push({ path: vp, reason: this.failReasonText(res) });
        stat.fail++;
        continue;
      }
      const cssDir = dirOf(vp);
      const css = await this.inlineCssUrls(res.text, cssDir, maxBytes, budget, stat);
      const style = doc.createElement('style');
      style.textContent = css;
      const media = link.getAttribute('media');
      if (media) style.setAttribute('media', media);
      link.parentNode.replaceChild(style, link);
      stat.ok++;
    }

    // ---- 2. <script src> → 内联 ----
    const scripts = Array.prototype.slice.call(doc.querySelectorAll('script[src]'));
    for (const el of scripts) {
      const vp = resolveVaultPath(baseDir, el.getAttribute('src'));
      if (!vp) continue;
      const res = await this.plugin.readResource(vp, maxBytes, budget);
      if (!res.ok || res.text == null) {
        stat.failList.push({ path: vp, reason: this.failReasonText(res) });
        stat.fail++;
        continue;
      }
      el.removeAttribute('src');
      el.textContent = res.text;
      stat.ok++;
    }

    // ---- 3. 图片 / 音视频 / 嵌入 的 src ----
    const srcEls = Array.prototype.slice.call(doc.querySelectorAll(
      'img[src], source[src], video[src], audio[src], track[src], embed[src], input[src]'
    ));
    for (const el of srcEls) {
      const vp = resolveVaultPath(baseDir, el.getAttribute('src'));
      if (!vp) continue;
      const res = await this.plugin.readResource(vp, maxBytes, budget);
      if (!res.ok) {
        stat.failList.push({ path: vp, reason: this.failReasonText(res) });
        stat.fail++;
        continue;
      }
      el.setAttribute('src', res.uri);
      stat.ok++;
    }

    // ---- 4. srcset（可能含多个候选，逐个替换）----
    const setEls = Array.prototype.slice.call(doc.querySelectorAll('img[srcset], source[srcset]'));
    for (const el of setEls) {
      const value = el.getAttribute('srcset');
      if (!value) continue;
      const parts = value.split(',').map((x) => x.trim()).filter(Boolean);
      const out = [];
      for (const part of parts) {
        const seg = part.split(/\s+/);
        const desc = seg.slice(1).join(' ');
        const vp = resolveVaultPath(baseDir, seg[0]);
        let url = seg[0];
        if (vp) {
          const res = await this.plugin.readResource(vp, maxBytes, budget);
          if (res.ok) { url = res.uri; stat.ok++; } else {
            stat.failList.push({ path: vp, reason: this.failReasonText(res) });
            stat.fail++;
          }
        }
        out.push(desc ? url + ' ' + desc : url);
      }
      el.setAttribute('srcset', out.join(', '));
    }

    // ---- 5. 内联 <style> 与 style 属性里的 url() ----
    const styles = Array.prototype.slice.call(doc.querySelectorAll('style'));
    for (const el of styles) {
      if (!el.textContent) continue;
      el.textContent = await this.inlineCssUrls(el.textContent, baseDir, maxBytes, budget, stat);
    }
    const styled = Array.prototype.slice.call(doc.querySelectorAll('[style]'));
    for (const el of styled) {
      const v = el.getAttribute('style');
      if (!v || v.indexOf('url(') < 0) continue;
      el.setAttribute('style', await this.inlineCssUrls(v, baseDir, maxBytes, budget, stat));
    }

    const html = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
    return { html, stat };
  }

  /** 处理一段 CSS 里所有 url(...)，相对路径按 cssDir 解析 */
  async inlineCssUrls(cssText, cssDir, maxBytes, budget, stat) {
    const found = [];
    const re = new RegExp(CSS_URL_RE.source, 'g');
    let m;
    while ((m = re.exec(cssText)) !== null) found.push(m[2].trim());

    const uniq = [];
    const seen = new Set();
    for (const u of found) {
      if (!seen.has(u)) { seen.add(u); uniq.push(u); }
    }

    const map = new Map();
    for (const url of uniq) {
      const vp = resolveVaultPath(cssDir, url);
      if (!vp) { map.set(url, null); continue; }
      const res = await this.plugin.readResource(vp, maxBytes, budget);
      if (res.ok) { map.set(url, res.uri); stat.ok++; } else {
        map.set(url, null);
        stat.failList.push({ path: vp, reason: this.failReasonText(res) });
        stat.fail++;
      }
    }

    return cssText.replace(new RegExp(CSS_URL_RE.source, 'g'), (full, quote, url) => {
      const uri = map.get(url.trim());
      if (!uri) return full;
      const q = quote || '"';
      return 'url(' + q + uri + q + ')';
    });
  }

  showMessage(text, color) {
    if (!this.frame) return;
    this.releaseBlob();
    this.frame.removeAttribute('src');
    this.frame.srcdoc =
      '<p style="font-family:sans-serif;padding:1em;color:' + color + '">' + escapeHtml(text) + '</p>';
  }

  // ---- 与设置面板的同步 ----

  syncFromSettings() {
    this.updateScriptBtn();
    this.updateZoomLabel();
    this.applyZoom();
    this.renderHtml();
  }

  updateScriptBtn() {
    if (!this.scriptBtn) return;
    this.scriptBtn.setText(this.plugin.settings.allowScripts ? '脚本: 开' : '脚本: 关');
  }

  updateZoomLabel() {
    if (!this.zoomLabel) return;
    this.zoomLabel.setText((this.plugin.settings.zoom || 100) + '%');
  }

  updateResLabel(stat) {
    if (!this.resLabel) return;
    this._lastStat = stat || null;
    if (!this.plugin.settings.inlineResources) {
      this.resLabel.setText('资源: 未内联');
      this.resLabel.setAttribute('title', '已在设置中关闭内联，相对资源将无法显示');
      this.resLabel.className = 'html-reader-res is-warn';
      this.renderFailPanel(null);
      return;
    }
    if (!stat) {
      this.resLabel.setText('');
      this.resLabel.className = 'html-reader-res';
      this.renderFailPanel(null);
      return;
    }
    const hasFail = !!(stat.failList && stat.failList.length);
    const txt = stat.fail ? '资源: ✓' + stat.ok + ' ✗' + stat.fail : '资源: ✓' + stat.ok;
    this.resLabel.setText(txt);
    this.resLabel.setAttribute('title', hasFail
      ? '点击查看 ' + stat.fail + ' 个内联失败资源'
      : (stat.ok ? '已内联 ' + stat.ok + ' 个库内资源' : ''));
    this.resLabel.className = 'html-reader-res'
      + (stat.fail ? ' is-warn' : '')
      + (hasFail ? ' is-clickable' : '');
    this.renderFailPanel(stat);
  }

  // 把 readResource 的 reason 翻译成中文可读说明
  failReasonText(res) {
    if (!res) return '内联失败';
    if (res.reason === 'not-found') return '库内不存在';
    if (res.reason === 'too-large') {
      return '超过单文件上限 ' + Math.round(this.plugin.maxInlineBytes() / 1048576) + 'MB';
    }
    if (res.reason === 'over-budget') {
      return '超过单文档总量上限 ' + Math.round(MAX_TOTAL_INLINE_BYTES / 1048576) + 'MB';
    }
    if (res.reason === 'error') {
      return '读取出错' + (res.error && res.error.message ? '：' + res.error.message : '');
    }
    return '内联失败';
  }

  // 内联失败清单：失败时点击「资源 ✓N ✗M」展开
  renderFailPanel(stat) {
    if (!this.failPanel) return;
    if (!stat || !stat.failList || !stat.failList.length) {
      this.failPanel.empty();
      this.failPanel.addClass('is-hidden');
      return;
    }
    const rows = stat.failList.map((f) =>
      '<div class="html-reader-failrow"><span class="p">' + escapeHtml(f.path) +
      '</span><span class="r">' + escapeHtml(f.reason) + '</span></div>'
    ).join('');
    this.failPanel.innerHTML =
      '<div class="html-reader-failhead">内联失败资源 (' + stat.failList.length + ')</div>' + rows;
  }

  toggleFailPanel() {
    if (!this.failPanel) return;
    if (this.failPanel.hasClass('is-hidden')) {
      if (this._lastStat && this._lastStat.failList && this._lastStat.failList.length) {
        this.failPanel.removeClass('is-hidden');
      }
    } else {
      this.failPanel.addClass('is-hidden');
    }
  }

  // ---- 页内查找（window.find 版）----
  //
  // 用 Chromium 的 window.find()：高亮与滚动由浏览器原生处理，我们不改动 iframe 内的 DOM
  // （对比「自建 Range + <mark> 包裹」方案，后者高亮可控、能拿命中数，但要处理还原，
  //   且会改写用户文档。先上原生版，不够用再换）。

  buildFindBar(toolbar) {
    const bar = toolbar.createEl('div', { cls: 'html-reader-findbar is-hidden' });
    this.findBar = bar;
    // 插入到缩放组之前：默认隐藏时只占「大纲」与缩放之间的空当，
    // 展开后也只是在这一行内出现，不会新增一行挤占文档高度。
    if (this.zoomWrap && this.zoomWrap.parentNode === toolbar) {
      toolbar.insertBefore(bar, this.zoomWrap);
    }

    const input = bar.createEl('input', { cls: 'html-reader-find-input', type: 'text' });
    input.setAttribute('placeholder', '在页面内查找…');
    input.setAttribute('spellcheck', 'false');
    this.findInput = input;

    const prevBtn = bar.createEl('button', { cls: 'html-reader-btn', text: '↑' });
    prevBtn.setAttribute('aria-label', '上一处');
    prevBtn.addEventListener('click', () => this.runFind(-1));

    const nextBtn = bar.createEl('button', { cls: 'html-reader-btn', text: '↓' });
    nextBtn.setAttribute('aria-label', '下一处');
    nextBtn.addEventListener('click', () => this.runFind(1));

    this.findCountEl = bar.createEl('span', { cls: 'html-reader-find-count' });

    const closeBtn = bar.createEl('button', { cls: 'html-reader-btn', text: '✕' });
    closeBtn.setAttribute('aria-label', '关闭查找');
    closeBtn.addEventListener('click', () => this.toggleFind(false));

    input.addEventListener('input', () => {
      this.resetFind();
      clearTimeout(this._findTimer);
      this._findTimer = setTimeout(() => this.runFind(1), 220);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(this._findTimer);
        this.runFind(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.toggleFind(false);
      }
    });
  }

  toggleFind(open) {
    if (!this.findBar || !this.findInput) return;
    if (open) {
      this.findBar.removeClass('is-hidden');
      // 打开时预填页面里已选中的文本，省一次输入
      try {
        const win = this.frame && this.frame.contentWindow;
        const sel = win && win.getSelection ? String(win.getSelection()) : '';
        const s = (sel || '').trim();
        if (s && s.length <= 80) this.findInput.value = s;
      } catch (e) { /* 不可访问时跳过 */ }
      this.findInput.focus();
      this.findInput.select();
      this.resetFind();
      if (this._findQuery) this.runFind(1);
    } else {
      this.findBar.addClass('is-hidden');
      this._findQuery = '';
      this._findIdx = 0;
      this._findTotal = 0;
      clearTimeout(this._findTimer);
      this._findTimer = null;
      this.clearFindSelection();
      this.updateFindCount();
      if (this.frame && this.frame.contentWindow) {
        try { this.frame.contentWindow.focus(); } catch (e) { /* 忽略 */ }
      }
    }
  }

  resetFind() {
    this._findQuery = this.findInput ? String(this.findInput.value || '').trim() : '';
    this._findIdx = 0;
    this._findTotal = this._findQuery ? this.countMatches(this._findQuery) : 0;
    this.updateFindCount();
  }

  /**
   * 方向：1 = 下一处，-1 = 上一处。
   * window.find(aString, caseSensitive, backwards, wrap) 从当前选区开始找，
   * 找不到选区时从文档开头开始 —— 所以「从头找」要先塌陷选区到 body 起点。
   */
  runFind(dir) {
    const q = this._findQuery;
    if (!q) return;
    const win = this.frame && this.frame.contentWindow;
    if (!win) return;
    if (typeof win.find !== 'function') {
      new Notice('当前环境不支持页内查找（window.find 不可用）');
      return;
    }
    // 焦点保护：输入框里打字后 220ms 会触发 runFind，而 win.focus() 会把焦点
    // 从查找框抢到 iframe 上 —— 桌面端只是光标闪一下，移动端直接收起软键盘、
    // 输入框不再激活（看起来像"刷新"）。所以焦点在查找框时就别抢，找完再还回去。
    const keepFocus = !!(
      this.findInput &&
      this.findBar && !this.findBar.hasClass('is-hidden') &&
      typeof document !== 'undefined' && document.activeElement === this.findInput
    );
    if (!keepFocus) {
      try { win.focus(); } catch (e) { /* 忽略 */ }
    }

    let ok = false;
    if (dir < 0) {
      ok = win.find(q, false, true, true);
      if (ok) this._findIdx = this._findIdx > 1 ? this._findIdx - 1 : Math.max(1, this._findTotal);
    } else {
      if (this._findIdx === 0) this.collapseToStart(win);
      ok = win.find(q, false, false, true);
      if (ok) this._findIdx = this._findIdx >= this._findTotal ? 1 : this._findIdx + 1;
    }
    if (!ok) this._findIdx = 0;
    // window.find 本身也可能把焦点带走，找完把焦点还给查找框
    if (keepFocus) {
      try { this.findInput.focus(); } catch (e) { /* 忽略 */ }
    }
    this.updateFindCount();
  }

  collapseToStart(win) {
    try {
      const doc = win.document;
      const sel = win.getSelection();
      if (!sel || !doc || !doc.body) return;
      const r = doc.createRange();
      r.setStart(doc.body, 0);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) { /* 忽略 */ }
  }

  clearFindSelection() {
    try {
      const win = this.frame && this.frame.contentWindow;
      if (win && win.getSelection) win.getSelection().removeAllRanges();
    } catch (e) { /* 忽略 */ }
  }

  // 命中总数用可见文本粗算（window.find 不返回计数）：足够用于「k / n」显示
  countMatches(query) {
    const doc = this.frame && this.frame.contentDocument;
    if (!doc || !doc.body) return 0;
    let text = '';
    try { text = doc.body.innerText || ''; } catch (e) { return 0; }
    if (!text || !query) return 0;
    const hay = text.toLowerCase();
    const needle = query.toLowerCase();
    let n = 0;
    let i = hay.indexOf(needle);
    while (i >= 0) {
      n++;
      i = hay.indexOf(needle, i + needle.length);
      if (n > 20000) break;
    }
    return n;
  }

  updateFindCount() {
    if (!this.findCountEl) return;
    if (!this._findQuery) {
      this.findCountEl.setText('');
      this.findCountEl.className = 'html-reader-find-count';
      return;
    }
    if (!this._findTotal) {
      this.findCountEl.setText('无匹配');
      this.findCountEl.className = 'html-reader-find-count is-empty';
      return;
    }
    this.findCountEl.setText((this._findIdx || 0) + ' / ' + this._findTotal);
    this.findCountEl.className = 'html-reader-find-count';
  }

  // Ctrl / ⌘ + 滚轮缩放。滚轮事件发生在 iframe 内部，所以监听要挂在 iframe 文档上
  // （Blob URL 与父窗口同源，所以拿得到 contentDocument）。
  attachZoomWheel() {
    try {
      const doc = this.frame && this.frame.contentDocument;
      if (!doc || doc.__htmlReaderWheel) return;
      doc.__htmlReaderWheel = true;

      let acc = 0;
      let last = 0;
      doc.addEventListener('wheel', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const now = Date.now();
        if (now - last < 120) return;
        acc += e.deltaY;
        if (Math.abs(acc) < 12) return;
        const dir = acc > 0 ? -1 : 1; // 下滚 = 缩小
        acc = 0;
        last = now;
        this.stepZoom(dir);
      }, { passive: false });
    } catch (e) { /* 文档不可访问时静默跳过 */ }
  }

  async stepZoom(delta) {
    let i = ZOOM_LEVELS.indexOf(this.plugin.settings.zoom);
    if (i < 0) i = ZOOM_LEVELS.indexOf(100);
    i = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, i + delta));
    this.plugin.settings.zoom = ZOOM_LEVELS[i];
    this.plugin.syncViews();
    // 滚轮会连发，落盘防抖（真正保存由 flushSettings / 卸载时兜底）
    this.plugin.saveSettingsSoon();
  }

  applyZoom() {
    const zoom = this.plugin.settings.zoom || 100;
    try {
      const doc = this.frame && this.frame.contentDocument;
      if (doc && doc.documentElement) doc.documentElement.style.zoom = zoom + '%';
    } catch (e) { /* 文档尚未就绪或不可访问时静默跳过 */ }
  }

  // iframe 每次加载完要做的事。抽成方法，是因为命中渲染缓存时给 frame 赋同一个 URL
  // 不会触发 load 事件，需要手动调一次。
  afterFrameLoad() {
    // 新文档刚就位：这之后的滚动都是程序性的（归 0 / 我们自己的还原），先不记录
    this._scrollReady = false;
    this.applyZoom();
    this.restoreScroll();
    this.attachLinkHandler();
    this.attachZoomWheel();
    this.updateNavButtons();
    this.buildToc();
    this.attachTocScrollSync();
    this.attachTocOutsideClick();
    this.attachScrollMemo();
  }

  // ── 阅读位置记忆（v1.7.7 重写）──────────────────────────────────
  // 目标：点开页面里的任何链接（外链 / 新标签 / 站内跳转）再回来，都停在原处。
  //
  // 坑 1：记录必须「当场读值」。v1.7.6 是滚动后 200ms 再去读 scrollY，
  //   而 iframe 一重载位置先归 0，定时器醒来读到的已经是 0，
  //   等于把记下的位置覆盖掉 —— 这才是「仍然回到顶部」的真正原因。
  // 坑 2：位置要记在插件级（不是视图实例），视图万一被重建也还在。
  // 坑 3：还原必须重试。iframe 重载后文档高度还没撑开，一次 scrollTo 会被夹到 0。

  captureScroll() {
    this.captureScrollMemo();
  }

  // 读：用当前文件（还原时）；写：用 _renderPath（记录时，见 captureScrollMemo）
  memoPath() {
    return this.file ? this.file.path : this._renderPath;
  }

  scrollMemoMap() {
    const p = this.plugin;
    if (!p) return null;
    if (!p.scrollMemo) p.scrollMemo = new Map();
    return p.scrollMemo;
  }

  // 传了 y 就用它（调用方当场读到的值），否则现读 iframe 的滚动位置
  captureScrollMemo(y) {
    try {
      // 闸门：iframe 刚重载、用户还没动过时，滚动位置是 0，
      // 这时候记录会把真正的位置覆盖掉，必须跳过
      if (!this._scrollReady) return;
      // 记的是「屏幕上当前这一页」：切文件时 this.file 已经变成新文件了
      const p = this._renderPath;
      if (!p) return;
      let v = y;
      if (typeof v !== 'number') {
        const win = this.frame && this.frame.contentWindow;
        if (!win || typeof win.scrollY !== 'number') return;
        v = win.scrollY;
      }
      // 0 一律不记（v1.8.1）：切标签时容器被 display:none，布局盒销毁会让
      // iframe 的 scrollY 归 0 并派发 scroll 事件（页面本身不重载、没有 load 事件）。
      // 闸门此时是开着的（用户滚过之后就一直开着），这条 scroll 会把真值覆盖成 0，
      // 等 IntersectionObserver 的回调赶到时已经晚了 —— 这正是移动端「切回来就到顶」
      // 的根因。0 没有信息量（就是顶部），宁可留着上一个真值。
      if (!(v > 0)) return;
      const m = this.scrollMemoMap();
      if (!m) return;
      m.delete(p); // 先删再存，保持插入顺序供 LRU 淘汰
      m.set(p, v);
      while (m.size > SCROLL_MEMO_MAX) m.delete(m.keys().next().value);
    } catch (e) { /* 忽略 */ }
  }

  restoreScroll() {
    this.cancelScrollRestore();
    // 闸门必须在还原「之前」就关掉（v1.8.1）：scrollTo 会引发程序性 scroll 事件，
    // 还原途中的中间值（比如只滚到 100）会反过来把目标值 500 覆盖掉。
    // 之前只有 afterFrameLoad 关了闸门，IntersectionObserver 这条入口漏了。
    this._scrollReady = false;
    try {
      const m = this.scrollMemoMap();
      const y = m ? (m.get(this.memoPath()) || 0) : 0;
      if (!y) { this._scrollReady = true; return; }
      for (const d of SCROLL_RESTORE_DELAYS) {
        this._restoreTimers.push(setTimeout(() => this.applyScrollRestore(y), d));
      }
      // 还原窗口过去后放开闸门，之后用户再滚就正常记录了
      const last = SCROLL_RESTORE_DELAYS[SCROLL_RESTORE_DELAYS.length - 1];
      this._restoreTimers.push(setTimeout(() => { this._scrollReady = true; }, last + 50));
    } catch (e) { /* 忽略 */ }
  }

  applyScrollRestore(y) {
    try {
      const win = this.frame && this.frame.contentWindow;
      if (!win) return;
      const cur = typeof win.scrollY === 'number' ? win.scrollY : 0;
      if (Math.abs(cur - y) < 2) return; // 已经到位就别再动
      win.scrollTo(0, y);
    } catch (e) { /* 忽略 */ }
  }

  // 用户一动手就停止还原，避免跟他抢滚动位置
  cancelScrollRestore() {
    if (this._restoreTimers && this._restoreTimers.length) {
      for (const t of this._restoreTimers) clearTimeout(t);
      this._restoreTimers = [];
    }
  }

  attachScrollMemo() {
    try {
      const win = this.frame && this.frame.contentWindow;
      if (!win) return;

      if (this._memoScrollFn) {
        try { win.removeEventListener('scroll', this._memoScrollFn); } catch (e) { /* 忽略 */ }
      }
      // 关键：在事件里当场把 scrollY 读出来传进去，绝不留到定时器里再读
      this._memoScrollFn = () => {
        const y = typeof win.scrollY === 'number' ? win.scrollY : 0;
        this.captureScrollMemo(y);
      };
      win.addEventListener('scroll', this._memoScrollFn, { passive: true });

      // iframe 被摘掉（Obsidian 切标签会 detach 非活动标签，iframe 因此重载）
      // 或即将导航之前，再抓一次，兜住「没滚动过就点了链接」的情况
      if (this._memoPageHideFn) {
        try { win.removeEventListener('pagehide', this._memoPageHideFn); } catch (e) { /* 忽略 */ }
      }
      this._memoPageHideFn = () => this.captureScrollMemo();
      win.addEventListener('pagehide', this._memoPageHideFn);

      // 用户自己一动，就取消还在排队的还原动作
      if (this._memoInputFn) {
        for (const ev of SCROLL_CANCEL_EVENTS) {
          try { win.removeEventListener(ev, this._memoInputFn); } catch (e) { /* 忽略 */ }
        }
      }
      this._memoInputFn = () => {
        this._scrollReady = true; // 用户动手了，之后的滚动都是有效的
        this.cancelScrollRestore();
      };
      for (const ev of SCROLL_CANCEL_EVENTS) {
        try { win.addEventListener(ev, this._memoInputFn, { passive: true }); } catch (e) { /* 忽略 */ }
      }
    } catch (e) { /* 忽略 */ }
  }

  // ── 「重新露面」时补一次滚动还原（移动端切标签专用）──────────────
  // 桌面端靠两种情况兜住：①iframe 重载 → load 事件 → afterFrameLoad；②浮层宿主
  // 显隐 → onHostShown。移动端两条都不成立：浮层已强制关闭，且真机确认 Obsidian
  // 只是把容器 display:none —— 布局盒销毁会让 iframe 的 scrollY 归 0，
  // 但 iframe 不重载（没有 load 事件），于是「位置被重置了却没人还原」。
  // IntersectionObserver 对 display:none、detach、移出视口三种藏法都会报「不可见」，
  // 重新可见时再报一次，正好补上这个缺口。
  attachVisibilityWatch() {
    if (typeof IntersectionObserver !== 'function' || !this.frame) return;
    this.detachVisibilityWatch();
    this._visObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          this.restoreScroll();
        } else {
          // 收起前补记一次。读到 0 不写由 captureScrollMemo 统一保证（v1.8.1），
          // 这里不必再判断一次 —— 0 值保护集中在一处，避免漏改
          this.captureScrollMemo();
        }
      }
    }, { threshold: 0.01 });
    try { this._visObserver.observe(this.frame); } catch (e) { this._visObserver = null; }
  }

  detachVisibilityWatch() {
    if (!this._visObserver) return;
    try { this._visObserver.disconnect(); } catch (e) { /* 忽略 */ }
    this._visObserver = null;
  }

  // 从父窗口给 iframe 文档挂点击监听。
  // 不需要 allow-scripts：脚本禁用只限制 iframe 内部执行 JS，
  // 而 allow-same-origin（Blob URL 与创建者同源）让父窗口可以操作它的 DOM。
  attachLinkHandler() {
    try {
      const doc = this.frame && this.frame.contentDocument;
      if (!doc || doc.__htmlReaderLinked) return;
      doc.__htmlReaderLinked = true;

      // iframe 是独立文档，点它不会冒泡到宿主，激活状态要单独补一次
      if (this._activateFn) {
        doc.addEventListener('mousedown', this._activateFn, true);
      }

      doc.addEventListener('click', (e) => {
        const node = e.target;
        const anchor = node && node.closest ? node.closest('a') : null;
        if (!anchor) return;
        const href = anchor.getAttribute('href');
        if (!href) return;

        // 点链接这一刻先把位置记下来：点外链 / 开新标签后页面随时可能被重载，
        // 等事后再读就已经是 0 了
        this.captureScrollMemo();

        if (href.charAt(0) === '#') {
          const id = href.slice(1);
          if (!id) return;
          const dest = doc.getElementById(id) || doc.getElementsByName(id)[0];
          if (dest && dest.scrollIntoView) {
            e.preventDefault();
            dest.scrollIntoView();
          }
          return;
        }

        // 库内相对链接（.md 新标签页 / .html 当前视图 / 其它系统程序）
        const baseDir = dirOf(this.file ? this.file.path : '');
        const vp = resolveVaultPath(baseDir, href);
        if (vp) {
          e.preventDefault();
          this.handleVaultLink(vp, anchor);
          return;
        }

        if (/^(https?:|mailto:|tel:|\/\/)/i.test(href)) {
          e.preventDefault();
          window.open(anchor.href || href, '_blank');
        }
      }, true);
    } catch (e) { /* 文档不可访问时静默跳过 */ }
  }

  async openExternal() {
    if (this.file) {
      this.app.openWithDefaultApp(this.file.path);
    } else {
      new Notice('当前没有可打开的 HTML 文件');
    }
  }

  // ── 库内链接接管 ──────────────────────────────────────────────
  // 站内相对链接由父窗口拦截（不依赖 allow-scripts）：
  //   .html/.htm → 在当前阅读视图打开（写入历史，可前进 / 后退）
  //   .md        → 新标签页打开（Obsidian 原生 markdown 视图）
  //   其它扩展   → 交系统默认程序打开
  async handleVaultLink(vaultPath, anchor) {
    // 跳走之前先记下当前页的位置，后退回来才能落在点链接的那一行
    this.captureScrollMemo();
    const file = this.app.vault.getAbstractFileByPath(vaultPath);
    if (!file || !(file instanceof TFile)) {
      new Notice('库内文件不存在：' + vaultPath);
      return;
    }
    const ext = extOf(vaultPath);
    const newTab = anchor && anchor.getAttribute && anchor.getAttribute('target') === '_blank';
    try {
      if (ext === 'html' || ext === 'htm') {
        if (newTab) {
          const leaf = this.app.workspace.getLeaf(true);
          await leaf.openFile(file, { active: true });
        } else {
          await this.leaf.openFile(file, { active: true });
        }
      } else if (ext === 'md') {
        const leaf = this.app.workspace.getLeaf(true);
        await leaf.openFile(file, { active: true });
      } else {
        this.app.openWithDefaultApp(vaultPath);
      }
      this.updateNavButtons();
    } catch (e) {
      new Notice('无法打开 ' + vaultPath + '：' + e.message);
    }
  }

  // ── 前进 / 后退（本视图内的 .html 导航历史）────────────────────
  goBack() {
    if (this._historyIdx <= 0) return;
    this._historyIdx--;
    this.openHistoryTarget();
  }

  goForward() {
    if (this._historyIdx >= this._history.length - 1) return;
    this._historyIdx++;
    this.openHistoryTarget();
  }

  async openHistoryTarget() {
    const path = this._history[this._historyIdx];
    if (!path) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice('文件已不存在：' + path);
      return;
    }
    try {
      await this.leaf.openFile(file, { active: true });
    } catch (e) {
      new Notice('无法打开 ' + path + '：' + e.message);
    }
    this.updateNavButtons();
  }

  // 每次成功渲染一个真实文件后调用：把当前路径记录进历史。
  // 若与栈顶相同（来自后退 / 前进或重渲染）则不重复压栈。
  recordHistory() {
    const path = this.file ? this.file.path : null;
    if (!path) return;
    const top = this._history[this._historyIdx];
    if (top === path) { this.updateNavButtons(); return; }
    if (this._historyIdx >= 0) this._history.length = this._historyIdx + 1;
    this._history.push(path);
    this._historyIdx = this._history.length - 1;
    this.updateNavButtons();
  }

  updateNavButtons() {
    if (this.backBtn) this.backBtn.disabled = this._historyIdx <= 0;
    if (this.fwdBtn) this.fwdBtn.disabled = this._historyIdx >= this._history.length - 1;
  }

  // ── 目录大纲 TOC（v1.6.0）──────────────────────────────────────
  // iframe 与父窗口同源（Blob URL），load 后可读 contentDocument 的标题。
  toggleToc() {
    if (!this.tocPanel || !this.tocBtn) return;
    if (this.tocPanel.hasClass('is-hidden')) {
      this.buildToc();
      this.tocPanel.removeClass('is-hidden');
      this.tocBtn.addClass('is-active');
      this.updateTocCurrent();
    } else {
      this.closeToc();
    }
  }

  // 关闭大纲（幂等）：供 ✕ 按钮、点击外部、Esc、切文件等场景复用
  closeToc() {
    if (!this.tocPanel || this.tocPanel.hasClass('is-hidden')) return;
    this.tocPanel.addClass('is-hidden');
    if (this.tocBtn) this.tocBtn.removeClass('is-active');
  }

  buildToc() {
    try {
      const doc = this.frame && this.frame.contentDocument;
      if (!doc) return;
      const heads = Array.prototype.slice.call(doc.querySelectorAll('h1,h2,h3,h4,h5,h6'));
      const toc = [];
      let n = 0;
      for (const h of heads) {
        const text = (h.textContent || '').trim();
        if (!text) continue;
        if (!h.id) h.id = 'toc-' + (++n);
        toc.push({ level: parseInt(h.tagName.charAt(1), 10) || 1, text: text, id: h.id });
      }
      this._toc = toc;
      this.renderTocPanel();
    } catch (e) { /* 文档不可访问时静默跳过 */ }
  }

  renderTocPanel() {
    if (!this.tocPanel) return;
    const toc = this._toc || [];
    const head =
      '<div class="html-reader-tochead">' +
      '<span class="html-reader-toctitle">目录大纲</span>' +
      (toc.length ? '<span class="html-reader-toccount">' + toc.length + '</span>' : '') +
      '<button type="button" class="html-reader-tocclose" data-act="close" ' +
      'aria-label="关闭大纲" title="关闭">✕</button>' +
      '</div>';
    if (!toc.length) {
      this.tocPanel.innerHTML =
        head + '<div class="html-reader-tocempty">（文档没有 h1~h6 标题）</div>';
      return;
    }
    const items = toc.map((t) =>
      '<button type="button" class="html-reader-tocitem l' + t.level +
      '" data-id="' + escapeHtml(t.id) + '" title="' + escapeHtml(t.text) + '">' +
      escapeHtml(t.text) + '</button>'
    ).join('');
    this.tocPanel.innerHTML = head + '<div class="html-reader-toclist">' + items + '</div>';
  }

  scrollToHeading(id) {
    try {
      const doc = this.frame && this.frame.contentDocument;
      const el = doc && doc.getElementById(id);
      if (el && el.scrollIntoView) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // 平滑滚动期间 scroll 事件会持续触发；再补两次兜底刷新，确保高亮落位
        setTimeout(() => this.updateTocCurrent(), 80);
        setTimeout(() => this.updateTocCurrent(), 450);
      }
    } catch (e) { /* 忽略 */ }
  }

  // 大纲滚动同步：iframe 与父窗口同源，可直接监听其 scroll（v1.7.2）
  attachTocScrollSync() {
    try {
      const doc = this.frame && this.frame.contentDocument;
      const win = this.frame && this.frame.contentWindow;
      if (!doc || !win) return;
      // 重新渲染会换掉 document，先摘掉上一轮的监听，避免累积
      if (this._tocScrollFn) {
        try {
          doc.removeEventListener('scroll', this._tocScrollFn, true);
          win.removeEventListener('scroll', this._tocScrollFn);
        } catch (e) { /* 忽略 */ }
      }
      this._tocScrollFn = () => {
        if (this._tocScrollTimer) return;
        this._tocScrollTimer = setTimeout(() => {
          this._tocScrollTimer = null;
          this.updateTocCurrent();
        }, 120);
      };
      doc.addEventListener('scroll', this._tocScrollFn, true);
      win.addEventListener('scroll', this._tocScrollFn);
    } catch (e) { /* 忽略 */ }
  }

  // 把「当前视口顶部所在的那一段」在大纲里高亮出来
  updateTocCurrent() {
    if (!this.tocPanel || this.tocPanel.hasClass('is-hidden')) return;
    const toc = this._toc || [];
    if (!toc.length) return;
    try {
      const doc = this.frame && this.frame.contentDocument;
      if (!doc) return;
      const win = this.frame.contentWindow;
      const de = doc.documentElement;
      let curId = toc[0].id;
      // 已经滚到底：直接点亮最后一个标题（否则末尾短段落永远高亮不到）
      const atBottom = win && de
        ? (win.innerHeight + win.scrollY >= de.scrollHeight - 8)
        : false;
      if (atBottom) {
        curId = toc[toc.length - 1].id;
      } else {
        for (const t of toc) {
          const el = doc.getElementById(t.id);
          if (!el) continue;
          if (el.getBoundingClientRect().top <= 96) curId = t.id;
          else break;
        }
      }
      const items = this.tocPanel.querySelectorAll('.html-reader-tocitem');
      for (const it of items) {
        if (it.getAttribute('data-id') === curId) it.classList.add('is-current');
        else it.classList.remove('is-current');
      }
    } catch (e) { /* 忽略 */ }
  }

  // 文档正文的点击也算「点在大纲外」：iframe 是独立文档，父窗口监听不到，
  // 必须单独挂到它的 document 上（Blob 同源，v1.7.3）
  attachTocOutsideClick() {
    try {
      const doc = this.frame && this.frame.contentDocument;
      if (!doc) return;
      // 重新渲染会换掉 document，先摘旧监听避免累积
      if (this._tocFrameFn) {
        try { doc.removeEventListener('mousedown', this._tocFrameFn, true); } catch (e) { /* 忽略 */ }
      }
      this._tocFrameFn = () => {
        if (!this.tocPanel || this.tocPanel.hasClass('is-hidden')) return;
        this.closeToc();
      };
      doc.addEventListener('mousedown', this._tocFrameFn, true);
      // 焦点在文档内部时，父窗口收不到键盘事件，Esc 也得在这里接一份
      if (this._tocKeyFn) {
        try {
          doc.removeEventListener('keydown', this._tocKeyFn, true);
          doc.addEventListener('keydown', this._tocKeyFn, true);
        } catch (e) { /* 忽略 */ }
      }
    } catch (e) { /* 文档不可访问时静默跳过 */ }
  }

  // ── 源码 / 渲染切换（v1.7.0）──────────────────────────────────
  // 源码视图是一个覆盖在 iframe 之上的纯文本 <pre>，不依赖 allow-scripts。
  //   _sourceView = 'raw'    → 显示库内原始 HTML（默认，A）
  //   _sourceView = 'inlined'→ 显示经过内联处理后的 HTML（B，便于看 data URI / <style>）
  toggleSource(force) {
    const on = (typeof force === 'boolean') ? force : !this._sourceMode;
    this._sourceMode = on;
    if (this.sourcePanel) this.sourcePanel.toggleClass('is-hidden', !on);
    if (this.sourceBtn) {
      this.sourceBtn.setText(on ? '渲染' : '源码');
      this.sourceBtn.toggleClass('is-active', on);
    }
    if (on) {
      this.updateSourceToggle();
      this.renderSource();
      this.captureScroll(); // 进源码前记一下，回来还原
    } else {
      this.restoreScroll();
    }
  }

  setSourceView(which) {
    if (this._sourceView === which) return;
    this._sourceView = which;
    this.updateSourceToggle();
    this.renderSource();
  }

  updateSourceToggle() {
    if (this.srcRawBtn) this.srcRawBtn.toggleClass('is-active', this._sourceView === 'raw');
    if (this.srcInlinedBtn) this.srcInlinedBtn.toggleClass('is-active', this._sourceView === 'inlined');
  }

  renderSource() {
    if (!this.sourceCode) return;
    const text = this._sourceView === 'inlined'
      ? (this._inlinedHtml || '')
      : (this._rawHtml || '');
    if (!text) {
      this.sourceCode.setText('（暂无源码：当前没有渲染过 HTML 文件，或内联功能已关闭）');
      return;
    }
    // setText 走 textContent，自动转义，不会有 HTML 注入风险
    this.sourceCode.setText(text);
  }

  // ── 全屏（v1.7.0）────────────────────────────────────────────
  toggleFullscreen() {
    // 浮层模式下真正的 UI 在宿主里，全屏要对它做，否则全屏后只剩一个空锚点
    const el = this.hostEl || this.contentEl;
    if (!el || typeof el.requestFullscreen !== 'function') {
      new Notice('当前环境不支持全屏');
      return;
    }
    if (!document.fullscreenElement) {
      el.requestFullscreen().catch(() => { /* 用户拒绝或失败，忽略 */ });
    } else {
      document.exitFullscreen().catch(() => { /* 忽略 */ });
    }
  }

  updateFullscreenBtn() {
    if (!this.fullscreenBtn) return;
    const on = !!document.fullscreenElement;
    this.fullscreenBtn.setText(on ? '退出全屏' : '全屏');
    this.fullscreenBtn.toggleClass('is-active', on);
  }
}

function dirOf(vaultPath) {
  const i = String(vaultPath).lastIndexOf('/');
  return i < 0 ? '' : String(vaultPath).slice(0, i);
}

// ══════════════════════════════════════════════════════════════════════
//  插件
// ══════════════════════════════════════════════════════════════════════

class HtmlReaderPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    // path → { mtime, uri, text }，跨视图共享
    this.resourceCache = new Map();
    // path → 阅读位置（滚动像素）。记在插件级：视图被重建也还在
    this.scrollMemo = new Map();
    // 同一资源的并发读取去重：path → Promise
    this.pendingReads = new Map();

    this.registerView(VIEW_TYPE_HTML, (leaf) => new HtmlReaderView(leaf, this));
    this.registerExtensions(['html', 'htm'], VIEW_TYPE_HTML);

    this.addCommand({
      id: 'reload-html-reader',
      name: '重新加载当前 HTML',
      callback: () => {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HTML)) {
          const view = leaf.view;
          if (view && typeof view.renderHtml === 'function') view.renderHtml(true);
        }
      },
    });

    this.addCommand({
      id: 'find-in-html',
      name: '在页面内查找',
      callback: () => {
        const view = this.activeReaderView() || this.firstReaderView();
        if (view && typeof view.toggleFind === 'function') view.toggleFind(true);
      },
    });

    this.addCommand({
      id: 'toggle-source-view',
      name: '切换源码 / 渲染视图',
      callback: () => {
        const view = this.activeReaderView() || this.firstReaderView();
        if (view && typeof view.toggleSource === 'function') view.toggleSource();
      },
    });

    this.addCommand({
      id: 'toggle-fullscreen',
      name: '切换全屏',
      callback: () => {
        const view = this.activeReaderView() || this.firstReaderView();
        if (view && typeof view.toggleFullscreen === 'function') view.toggleFullscreen();
      },
    });

    // Ctrl / ⌘ + F：只有当前激活的是本插件视图时才接管，否则放行给 Obsidian 全局搜索
    this._keyHandler = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key !== 'f' && e.key !== 'F') return;
      const view = this.activeReaderView();
      if (!view) return;
      e.preventDefault();
      e.stopPropagation();
      view.toggleFind(true);
    };
    document.addEventListener('keydown', this._keyHandler, true);

    this.addSettingTab(new HtmlReaderSettingTab(this.app, this));
  }

  activeReaderView() {
    const leaf = this.app.workspace.activeLeaf;
    const view = leaf && leaf.view;
    return view && typeof view.getViewType === 'function' && view.getViewType() === VIEW_TYPE_HTML
      ? view
      : null;
  }

  firstReaderView() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_HTML)[0];
    return leaf && leaf.view ? leaf.view : null;
  }

  // 清掉不属于任何存活视图的浮层宿主（插件加载 / 卸载时各跑一次）
  cleanupStrayHosts() {
    try {
      const list = window.document.querySelectorAll('.html-reader-host');
      for (let i = 0; i < list.length; i++) {
        const el = list[i];
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }
    } catch (e) { /* 忽略 */ }
  }

  onunload() {
    // 兜底：万一有视图没走 onClose（热重载 / 异常），别把浮层宿主留在 body 上
    this.cleanupStrayHosts();
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler, true);
      this._keyHandler = null;
    }
    this.flushSettings();
    // 释放所有 Blob URL，避免重启/重载插件后残留
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HTML)) {
      const view = leaf.view;
      if (view && typeof view.releaseBlob === 'function') view.releaseBlob();
    }
    this.resourceCache.clear();
    this.pendingReads.clear();
  }

  maxInlineBytes() {
    const mb = this.settings.inlineLimitMb || DEFAULT_INLINE_LIMIT_MB;
    return mb * 1024 * 1024;
  }

  /**
   * 读取一个库内文件并转成 data URI。
   * 返回 { ok, uri, text }：text 仅对文本类资源有值（CSS 还要二次处理 url()）。
   */
  async readResource(vaultPath, maxBytes, budget) {
    const cache = this.resourceCache;

    let st = null;
    try { st = await this.app.vault.adapter.stat(vaultPath); } catch (e) { st = null; }
    if (!st) return { ok: false, uri: null, text: null, reason: 'not-found' };
    if (st.size > maxBytes) return { ok: false, uri: null, text: null, reason: 'too-large' };
    if (budget && st.size > budget.left) return { ok: false, uri: null, text: null, reason: 'over-budget' };

    const hit = cache.get(vaultPath);
    if (hit && hit.mtime === st.mtime) {
      if (budget) budget.left -= Math.min(st.size, budget.left);
      return { ok: true, uri: hit.uri, text: hit.text };
    }

    let pending = this.pendingReads.get(vaultPath);
    if (!pending) {
      pending = (async () => {
        const mime = mimeOf(vaultPath);
        if (TEXTUAL_EXT.has(extOf(vaultPath))) {
          const text = await this.app.vault.adapter.read(vaultPath);
          return { uri: textToDataUri(text, mime), text };
        }
        const buf = new Uint8Array(await this.app.vault.adapter.readBinary(vaultPath));
        return { uri: bytesToDataUri(buf, mime), text: null };
      })();
      this.pendingReads.set(vaultPath, pending);
    }

    try {
      const out = await pending;
      this.pendingReads.delete(vaultPath);
      cache.set(vaultPath, { mtime: st.mtime, uri: out.uri, text: out.text });
      while (cache.size > INLINE_CACHE_MAX) {
        cache.delete(cache.keys().next().value);
      }
      if (budget) budget.left -= Math.min(st.size, budget.left);
      return { ok: true, uri: out.uri, text: out.text };
    } catch (e) {
      this.pendingReads.delete(vaultPath);
      return { ok: false, uri: null, text: null, reason: 'error', error: e };
    }
  }

  syncViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HTML)) {
      const view = leaf.view;
      if (view && typeof view.syncFromSettings === 'function') view.syncFromSettings();
    }
  }

  // 浮层开关变了：父容器要换，只能把 UI 整个重搭（syncViews 那种软更新不够）
  rebuildViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HTML)) {
      const view = leaf.view;
      if (view && typeof view.rebuildUI === 'function') view.rebuildUI();
    }
  }

  async loadSettings() {
    this.settings = Object.assign(
      {
        allowScripts: false,
        autoReload: true,
        zoom: 100,
        inlineResources: true,
        inlineLimitMb: DEFAULT_INLINE_LIMIT_MB,
        // 防重载浮层（v1.7.8）：默认开，出问题可在设置里关掉退回内嵌
        floatHost: true,
      },
      await this.loadData()
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // 滚轮缩放会连发事件，落盘防抖 400ms；flushSettings() 负责兜底立即写入
  saveSettingsSoon() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveSettings();
    }, 400);
  }

  flushSettings() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      this.saveSettings();
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
//  设置面板
// ══════════════════════════════════════════════════════════════════════

class HtmlReaderSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'HTML Direct Reader Settings' });

    new Setting(containerEl)
      .setName('Anti-reload float layer (experimental)')
      .setDesc('On by default. When you switch away from a tab, Obsidian detaches its DOM and the iframe is forced to reload, losing script state, forms, Canvas and scroll position. With this on, the UI lives on a persistent host aligned per frame, so switching tabs or clicking links never reloads. Turn off to fall back to inline (rebuilds the view once) if you hit layering issues. Standalone popout windows are always inline. ｜ 中文：防重载浮层：切标签或点链接不再强制刷新，保留脚本与滚动位置；弹窗外自动关闭。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.floatHost !== false).onChange(async (v) => {
          this.plugin.settings.floatHost = v;
          await this.plugin.saveSettings();
          this.plugin.rebuildViews();
        })
      );

    new Setting(containerEl)
      .setName('Allow scripts')
      .setDesc('Off by default. When on, the HTML\'s JavaScript runs and the sandbox keeps allow-same-origin, meaning the file is fully trusted and can reach into the Obsidian window internals. Only enable for sources you trust. ｜ 中文：开启后 HTML 内脚本会执行，相当于完全信任该文件，仅对可信来源开启。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.allowScripts).onChange(async (v) => {
          this.plugin.settings.allowScripts = v;
          await this.plugin.saveSettings();
          this.plugin.syncViews();
        })
      );

    new Setting(containerEl)
      .setName('Inline in-vault resources')
      .setDesc('On by default. Obsidian\'s app://local is cross-origin with the preview, so the browser can\'t fetch in-vault relative assets. The plugin reads them in Node and inlines CSS as <style> and images/fonts as data URIs. Turn off only for debugging or very large pages — relative assets will then fail. ｜ 中文：把库内 CSS/图片/字体内联以绕过跨域；排查问题或超大页面时可关。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.inlineResources).onChange(async (v) => {
          this.plugin.settings.inlineResources = v;
          await this.plugin.saveSettings();
          this.plugin.syncViews();
        })
      );

    new Setting(containerEl)
      .setName('Inline size limit per resource')
      .setDesc('In-vault resources larger than this are not inlined (they fail to load and show alt text), to avoid large files slowing down rendering. ｜ 中文：超过此体积的资源不再内联，避免拖慢渲染。')
      .addDropdown((d) => {
        INLINE_LIMIT_OPTIONS.forEach((mb) => d.addOption(String(mb), mb + ' MB'));
        d.setValue(String(this.plugin.settings.inlineLimitMb || DEFAULT_INLINE_LIMIT_MB))
          .onChange(async (v) => {
            this.plugin.settings.inlineLimitMb = parseInt(v, 10) || DEFAULT_INLINE_LIMIT_MB;
            await this.plugin.saveSettings();
            this.plugin.syncViews();
          });
      });

    new Setting(containerEl)
      .setName('Auto-reload on file change')
      .setDesc('When the previewed HTML is modified externally, the view refreshes automatically (~0.3s after the change). Turn off if the page has a form you\'re filling or an animation playing, and use the toolbar "Reload" instead.' +
               ' ｜ 中文：外部改动 HTML 后自动刷新；有表单或动画时关闭，改用工具栏重载。')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoReload).onChange(async (v) => {
          this.plugin.settings.autoReload = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Default zoom')
      .setDesc('Overall zoom of the preview content. You can also use the － / ＋ buttons on the right of the toolbar, or hold Ctrl (⌘) and scroll the wheel over the preview.' +
               ' ｜ 中文：预览整体缩放；也可用工具栏按钮或 Ctrl/⌘ + 滚轮。')
      .addDropdown((d) => {
        ZOOM_LEVELS.forEach((z) => d.addOption(String(z), z + '%'));
        d.setValue(String(this.plugin.settings.zoom || 100)).onChange(async (v) => {
          this.plugin.settings.zoom = parseInt(v, 10) || 100;
          await this.plugin.saveSettings();
          this.plugin.syncViews();
        });
      });
  }
}

module.exports = HtmlReaderPlugin;
