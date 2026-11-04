<template>
  <div class="min-h-screen flex flex-col">
    <header
      class="sticky top-0 z-20 border-b border-line bg-[rgba(244,241,234,0.88)] backdrop-blur-[12px] backdrop-saturate-[160%]"
    >
      <!--
        顶栏响应式（2026-11 修 1024 最小窗错乱）：
        原实现 header-inner 用 gap-10 + 三段都不收缩约束，max-content 需求
        81(logo)+461(nav)+342(右侧)+80(两处 gap)+56(padding)=1020px，
        而 1024 窗实际 clientWidth 只有 1014（10px 滚动条）→ 溢出。
        浏览器只能压宽 + 换行：nav 文字与「设置」被挤成竖排，右侧按钮组溢出被裁。
        现在：三段 shrink-0/nowrap 立住，靠 gap 与搜索入口按断点逐级收窄腾空间。
      -->
      <div class="header-inner max-w-[1140px] mx-auto px-7 flex items-center justify-between h-[60px]">
        <div class="flex items-center shrink-0" style="font-family:var(--serif)">
          <span class="text-[20px] font-700 tracking-[-0.01em] text-text whitespace-nowrap">奇客题库</span>
        </div>
        <nav class="flex items-center gap-1 h-full shrink-0">
          <router-link
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            active-class="active"
            class="nav-link relative inline-flex items-center gap-1 px-3.5 h-full text-[14px] font-500 no-underline text-text-secondary whitespace-nowrap transition-[color] duration-150 hover:text-text"
          ><i :class="item.icon" aria-hidden="true" />{{ item.label }}</router-link>
        </nav>
        <div class="flex items-center gap-2 shrink-0">
          <!--
            顶栏搜索入口：不再自带下拉结果，点击直接唤起命令面板（Ctrl/Cmd+K）。
            外观仍像输入框，但它是按钮 —— 两套搜索逻辑（自绘下拉 + 面板）正是 FE-P0-08 要消除的问题。
          -->
          <button
            type="button"
            class="sp-trigger"
            title="全局搜索（Ctrl+K）"
            aria-label="全局搜索"
            @click="openSearch"
          >
            <i class="i-lucide-search sp-trigger-icon" aria-hidden="true" />
            <span class="sp-trigger-text">搜索试题、题库、页面…</span>
            <kbd class="sp-trigger-kbd">Ctrl K</kbd>
          </button>
          <button type="button" class="i-btn px-2.5 py-1.5 text-[13px] whitespace-nowrap" title="快捷键帮助（?）" @click="showShortcuts = true">
            <i class="i-lucide-keyboard text-[15px]" />
          </button>
          <button type="button" class="i-btn px-2.5 py-1.5 text-[13px] whitespace-nowrap" title="设置" @click="showSettings = true">
            <i class="i-lucide-settings-2 text-[15px]" />设置
          </button>
        </div>
      </div>
    </header>
    <main class="max-w-[1140px] w-full mx-auto px-7 py-8 flex-1">
      <router-view />
    </main>
    <DialogHost />
    <ToastHost />

    <SearchPalette v-model="searchOpen" @open-settings="onOpenSettingsFromSearch" />
    <ShortcutsDialog v-model="showShortcuts" @open-search="openSearch" />

    <SettingsDialog ref="settingsRef" v-model="showSettings" @open-shortcuts="openShortcutsFromSettings" />
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { loadBanks, bankStore } from '@/stores/bank.ts'
import { initAutoSync } from '@/stores/autoSync.ts'
import { toast, ui } from '@/stores/ui.ts'
import { stats as fetchStats } from '@/api/practice.ts'
import DialogHost from '@/components/ui/DialogHost.vue'
import ToastHost from '@/components/ui/ToastHost.vue'
import SettingsDialog from '@/components/settings/SettingsDialog.vue'
import SearchPalette from '@/components/search/SearchPalette.vue'
import ShortcutsDialog from '@/components/ui/ShortcutsDialog.vue'

const route = useRoute()
const router = useRouter()

const REPO = 'VxRain/QikeQBank'
const RELEASES_URL = `https://github.com/${REPO}/releases`

// ── 全局搜索（FE-P0-08）──
// 旧实现是顶栏里的一个自绘下拉：只搜题目、8 条上限、无键盘选中、点空白不关、
// 且请求没带 summary（整批拉回富文本题干 + 选项 + 解析）。
// 现在统一收敛为 SearchPalette 命令面板：顶栏按钮与 Ctrl/Cmd+K 打开同一面板，
// 面板内的分组/键盘/高亮/最近搜索规则全在 stores/search.ts（纯函数，可单测）。
const searchOpen = ref(false)
const showSettings = ref(false)
const showShortcuts = ref(false)
const settingsRef = ref(null)

function openSearch() {
  // 打开搜索前先收起设置/快捷键弹层，避免三层叠加（z-index 里也压不住焦点）
  showSettings.value = false
  showShortcuts.value = false
  searchOpen.value = true
}

/** 面板里点「设置」类结果：打开设置并把关键词喂给它的搜索框 */
function onOpenSettingsFromSearch(payload) {
  showSettings.value = true
  settingsRef.value?.focusItem?.(payload?.sectionId, payload?.query)
}

/**
 * 从设置弹层打开快捷键帮助（FE-P1-10）。
 * 复用同一个 ShortcutsDialog（与 `?` 入口共享组件），不新写一份快捷键清单——
 * 两处清单分叉是必然的漂移。先收起设置，避免两层弹层叠加时焦点跳不出来。
 */
function openShortcutsFromSettings() {
  showSettings.value = false
  showShortcuts.value = true
}

/**
 * 全局键位（挂在 window 上，整站生效）：
 * - Ctrl/Cmd+K 唤起搜索（任何页面、任何焦点位置，除输入框里的组合键仍照常交给编辑器）
 * - `?` 打开快捷键帮助 —— 只在**没有焦点在输入框 / 没有弹层**时生效，
 *   否则用户打问号会被吞掉（练习页的填空、录题的题干编辑器都会用到「?」）。
 * - Esc 关闭快捷键帮助（搜索面板的 Esc 由面板自己管，它还要处理「先清空」一级）
 */
function isTypingTarget(t) {
  if (!t || !t.closest) return false
  return !!t.closest('input, textarea, select, [contenteditable], .tiptap, .ProseMirror')
}

function onGlobalKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return
  const mod = e.ctrlKey || e.metaKey
  if (mod && !e.altKey && (e.key || '').toLowerCase() === 'k') {
    // 即使焦点在编辑器里也拦截：Ctrl+K 不是任何编辑器的既有快捷键
    e.preventDefault()
    if (searchOpen.value) searchOpen.value = false
    else openSearch()
    return
  }
  if (e.key === 'Escape' && showShortcuts.value) {
    e.preventDefault()
    showShortcuts.value = false
    return
  }
  if (e.key !== '?' || mod || e.altKey) return
  if (isTypingTarget(e.target)) return
  if (searchOpen.value || showSettings.value || ui.dialog) return
  e.preventDefault()
  showShortcuts.value = true
}

// 顶栏导航由路由表派生：有 meta.nav 的路由按 order 升序渲染，新增页面只改 router/index.js。
const navItems = router.options.routes
  .filter((r) => r.meta?.nav)
  .sort((a, b) => a.meta.nav.order - b.meta.nav.order)
  .map((r) => ({ to: r.path, label: r.meta.nav.label, icon: r.meta.nav.icon }))

// 页面标题随路由变化：`meta.title · 奇客题库`，未声明 meta.title 时只显示站点名。
const APP_NAME = '奇客题库'
function syncDocumentTitle() {
  const title = route.meta?.title
  document.title = title ? `${title} · ${APP_NAME}` : APP_NAME
}
syncDocumentTitle()
watch(() => route.fullPath, syncDocumentTitle)
// 首次进入（含直接命中 '/'）时 fullPath 不变，等首次导航完成后再同步一次标题
router.isReady().then(syncDocumentTitle)

// FSRS 升级一次性提示：有历史作答记录的老用户才提示，全新安装静默
const FSRS_MIGRATED_KEY = 'qbank.fsrsMigrated.v1'
function maybeNotifyFsrsUpgrade() {
  try {
    if (localStorage.getItem(FSRS_MIGRATED_KEY)) return
    localStorage.setItem(FSRS_MIGRATED_KEY, '1')
    fetchStats().then((s) => {
      if (s && (s.practiced_total ?? 0) > 0) toast('复习算法已升级为 FSRS，历史复习进度已重置', 'info')
    }).catch(() => {})
  } catch { /* 忽略持久化失败 */ }
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown)
  loadBanks()
  maybeNotifyFsrsUpgrade()
  // 自动同步：按设置开关排期（首次延迟 60 秒，避开启动高峰）
  initAutoSync()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
})
</script>

<style>
:root {
  /* 「墨砚」设计系统：暖纸底 + 墨绿主色 + 衬线标题，区别于通用蓝色 SaaS */
  --bg: #f4f1ea;
  --bg-accent: #ece7db;
  --card: #fffdf7;
  --card-hover: #faf7ee;
  --line: #e3ddcd;
  --line-strong: #c9c1ad;
  --text: #1b1a17;
  --text-secondary: #3d3a33;
  --muted: #7d7568;
  --muted-light: #a89f8e;
  --primary: #1f4d3a;
  --primary-hover: #163b2c;
  --primary-bg: #e6efe8;
  /* 主色淡底控件的 hover 底：只比 --primary-bg 深一档，保证「有反馈」又不跳色 */
  --primary-bg-hover: #d8e7dc;
  --primary-border: #a3c7af;
  --success: #2f7d4f;
  --success-bg: #e8f2ea;
  --danger: #b4453a;
  --danger-bg: #f6e8e6;
  /* 实心深色控件（分段/选项选中）的 hover 色：必须比 --text 略浅，
     否则「选中后 hover」没有任何可感反馈；见 uno.config.js 的 seg-on 注释 */
  --text-hover: #3d3a33;
  /* 危险态选中控件的 hover 边框（danger-bg 上加深一档）*/
  --danger-border-strong: #c08b83;
  --radius: 10px;
  --radius-lg: 12px;
  --shadow-sm: 0 1px 2px rgba(60,50,30,.05);
  --shadow: 0 2px 6px rgba(60,50,30,.06), 0 1px 2px rgba(60,50,30,.04);
  --shadow-lg: 0 8px 20px rgba(60,50,30,.08), 0 3px 8px rgba(60,50,30,.05);
  --serif: 'Source Serif 4', 'Noto Serif SC', Georgia, 'Times New Roman', serif;
}
* { box-sizing: border-box; }
/* UnoCSS 无 preflight：补 Tailwind 式 border 默认值，否则 <button> 用 outset、<a>/<div> 用 none → 边框丢失或立体感 */
*, *::before, *::after { border-style: solid; border-width: 0; }
html, body { margin: 0; padding: 0; }
/*
 * 滚动条槽位常驻（修「切页面时顶栏宽度/位置跳动」）：
 *
 * 缺陷：页面一旦超过一屏（如模考 / 错题本），WebView2 会给出 10px 占位滚动条，
 * 视口可用宽度从 1280 掉到 1270 → `max-w-[1140px] mx-auto` 的顶栏内层左边距
 * 从 70 变 65，同时 header 自身宽度少 10px。看起来就是「换个页面顶栏左右抖一下」。
 *
 * 为什么不用 `overflow-y: scroll`：那会让短页面也常驻一条滚动条轨道（空槽），
 * 且不改滚动条「占位/不占位」的事实，只是把它固定成常占位。
 * `scrollbar-gutter: stable` 只是**预留槽位**：不出现滚动条时不画轨道，
 * 出现时直接落在预留位里 → 两种状态的布局宽度完全一致，视觉上无位移。
 *
 * 实测（headed Chromium，1280×720）：无此规则时 banks/exam 两态 innerLeft 70↔65、
 * headerW 1280↔1270；加上后两态均为 65 / 1270。
 * 弹层锁滚动（SettingsDialog 的 `body.overflow=hidden`）也因此不再引起横移。
 */
html { scrollbar-gutter: stable; }
body {
  font-family: 'Inter', ui-sans, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--primary); text-decoration: none; }
a:hover { color: var(--primary-hover); }

/* ── 原生感 UI 全局规范（防 WebView 套壳感）── */
button, input, select, textarea { font-family: inherit; }
button { user-select: none; -webkit-user-select: none; color: inherit; font: inherit; background: none; }

/* 自定义滚动条（WebKit/Blink，Windows WebView2 生效） */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--line-strong);
  border-radius: 999px;
  border: 2px solid var(--bg);
}
::-webkit-scrollbar-thumb:hover { background: var(--muted-light); }

/* 难度点阵（5 个点，亮起数 = difficulty）：列表页与刷题页共用。
   放全局而不是某个页面的 scoped —— scoped 会让第二处静默失效
   （DOM 里 class 看着完全正常，就是没有点阵样式）。 */
.difficulty-dots { display: inline-flex; gap: 2px; align-items: center; }
.difficulty-dots .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--line); }
.difficulty-dots .dot.on { background: var(--primary); }

/* 键盘焦点态：统一主色光环 */
:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
  border-radius: 6px;
}

/* 选区颜色 */
::selection { background: var(--primary-bg); color: var(--text); }

/* select 去掉原生箭头 → 自定义 chevron（全局统一下拉观感） */
.select {
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a89f8e' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  background-size: 12px;
}
/* 导航 tab：底部细线指示器（书签感），非胶囊 */.nav-link {
  border-bottom: 2px solid transparent;
}
.nav-link:hover { border-bottom-color: var(--line-strong); }
.nav-link.active,
.nav-link.active:hover {
  color: var(--primary);
  border-bottom-color: var(--primary);
  background: transparent;
}

/* 顶栏搜索入口：外观是输入框，实际是打开命令面板的按钮（FE-P0-08） */
.sp-trigger {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 8px 0 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--card);
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  transition: border-color .15s ease, color .15s ease, box-shadow .15s ease;
}
.sp-trigger:hover {
  border-color: var(--line-strong);
  color: var(--text-secondary);
  box-shadow: var(--shadow-sm);
}
.sp-trigger-icon { font-size: 14px; color: var(--muted-light); }
.sp-trigger:hover .sp-trigger-icon { color: var(--primary); }
.sp-trigger-text {
  min-width: 0;
  white-space: nowrap;
}
.sp-trigger-kbd {
  margin-left: 6px;
  padding: 1px 5px;
  border: 1px solid var(--line);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--bg);
  color: var(--muted-light);
  font-family: inherit;
  font-size: 10.5px;
  line-height: 1.5;
  white-space: nowrap;
}

/* ── 顶栏响应式：靠间距分级腾空间，不靠压文字换行 ──
 *
 * 硬约束：应用最小窗宽 1024（lib.rs min_inner_size），扣掉 10px 滚动条与 56px 左布
 * → 内容区 1014。三段 max-content：logo 81 + nav 478 + 右侧组 342（搜索 233 +
 * 两个图标钮 93 + 间距 16）。原实现用 gap-10：
 *   81 + 478 + 342 + 80(gap) + 56(padding) = 1020 > 1014 → 溢 6px。
 * 又因为三段都没有 shrink 约束 / nowrap，浏览器只能压宽 + 换行，于是 nav 文字与
 * 「设置」被挤成竖排两行，右侧按钮组溢出后被裁掉（用户截图即此）。
 *
 * 修法：三段都 shrink-0 + nowrap 立住，空间只从「装饰」上腾（不碰字）：
 *   ≥1080   gap 24，nav padding 14，搜索入口完整（提示 + Ctrl K）
 *   <1080   gap 16，nav padding 10（省 48），隐藏 Ctrl K 键标（省 47）
 *           → 1024 下实需 941，余 73
 *   <1000  搜索入口只留图标（已低于桌面端最小窗，仅浏览器窗口会到这）
 *   <820    隐藏搜索入口（Ctrl+K 始终可用）
 *
 * 要点：不靠 overflow:hidden 做省略号 —— 那会把 span 变成滚动容器，使按钮的
 * max-content 塌陷，于是即使空间富余也会被截断。宁可在断点上隐去装饰，
 * 实在挤不下也是 header 横向溢出（局部、可救），不再是全局错乱。
 */
.header-inner { gap: 24px; }
@media (max-width: 1079px) {
  .header-inner { gap: 16px; }
  header .nav-link { padding-left: 10px; padding-right: 10px; }
  .sp-trigger-kbd { display: none; }
}
@media (max-width: 999px) {
  .sp-trigger-text { display: none; }
}
@media (max-width: 819px) {
  .sp-trigger { display: none; }
}
/* 低于 720 已远超桌面端与最小窗宽，再无可挥霍的空间：
   顶栏改为横向滚动保底，宁可左右滚也不裁切、不换行。 */
@media (max-width: 719px) {
  .header-inner { overflow-x: auto; }
}

/* 设置弹窗入场动画已随组件迁入 components/settings/SettingsDialog.vue（scoped） */

/* 补线体标题工具类（由 uno.config theme.fontFamily.serif 提供 font-serif 原子类） */
</style>
