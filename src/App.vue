<template>
  <div class="min-h-screen flex flex-col">
    <header
      class="sticky top-0 z-20 border-b border-line bg-[rgba(244,241,234,0.88)] backdrop-blur-[12px] backdrop-saturate-[160%]"
    >
      <div class="max-w-[1140px] mx-auto px-7 flex items-center gap-6 h-[60px]">
        <div class="flex items-center gap-2.5 shrink-0" style="font-family:var(--serif)">
          <span
            class="w-8 h-8 rounded-[7px] flex items-center justify-center text-white text-[17px] font-700 bg-primary shadow-[0_2px_6px_rgba(31,77,58,0.28)]"
          >Q</span>
          <span class="text-[20px] font-700 tracking-[-0.01em] text-text">QBank</span>
          <span class="text-[12px] text-muted ml-1 tracking-normal font-400 hidden sm:inline">题库 · Blocks JSON</span>
        </div>
        <nav class="flex items-center gap-1 h-full ml-2">
          <router-link
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            active-class="active"
            class="nav-link relative inline-flex items-center gap-1.5 px-3.5 h-full text-[14px] font-500 no-underline text-text-secondary transition-[color] duration-150 hover:text-text"
          ><i :class="item.icon" aria-hidden="true" />{{ item.label }}</router-link>
        </nav>
        <div class="ml-auto" />
      </div>
    </header>
    <main class="max-w-[1140px] w-full mx-auto px-7 py-8 flex-1">
      <router-view />
    </main>
    <DialogHost />
    <ToastHost />
  </div>
</template>

<script setup>
import { onMounted } from 'vue'
import { loadBanks } from '@/stores/bank.js'
import DialogHost from '@/components/ui/DialogHost.vue'
import ToastHost from '@/components/ui/ToastHost.vue'

const navItems = [
  { to: '/', label: '首页', icon: 'i-lucide-home' },
  { to: '/banks', label: '题库', icon: 'i-lucide-book-open' },
  { to: '/practice', label: '刷题', icon: 'i-lucide-zap' },
  { to: '/review', label: '复习', icon: 'i-lucide-repeat' }
]

onMounted(loadBanks)
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
  --primary-border: #a3c7af;
  --success: #2f7d4f;
  --success-bg: #e8f2ea;
  --danger: #b4453a;
  --danger-bg: #f6e8e6;
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
/* 导航 tab：底部细线指示器（书签感），非胶囊 */
.nav-link {
  border-bottom: 2px solid transparent;
}
.nav-link:hover { border-bottom-color: var(--line-strong); }
.nav-link.active,
.nav-link.active:hover {
  color: var(--primary);
  border-bottom-color: var(--primary);
  background: transparent;
}

/* 补线体标题工具类（由 uno.config theme.fontFamily.serif 提供 font-serif 原子类） */
</style>
