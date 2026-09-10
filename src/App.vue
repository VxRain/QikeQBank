<template>
  <div class="app">
    <header class="topbar">
      <div class="inner">
        <div class="brand">
          <span class="logo">Q</span> QBank
          <span class="sub">题库 · Blocks JSON</span>
        </div>
        <nav class="nav">
          <router-link to="/" class="nav-link" active-class="active">首页</router-link>
          <router-link to="/banks" class="nav-link" active-class="active">题库</router-link>
          <router-link to="/practice" class="nav-link" active-class="active">刷题</router-link>
          <router-link to="/review" class="nav-link" active-class="active">复习</router-link>
        </nav>
      </div>
    </header>
    <main class="main">
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

onMounted(loadBanks)
</script>

<style>
:root {
  --bg: #f8fafc;
  --bg-accent: #f1f5f9;
  --card: #ffffff;
  --card-hover: #f8fafc;
  --line: #e2e8f0;
  --line-strong: #cbd5e1;
  --text: #0f172a;
  --text-secondary: #334155;
  --muted: #64748b;
  --muted-light: #94a3b8;
  --primary: #0ea5e9;
  --primary-hover: #0284c7;
  --primary-bg: #e0f2fe;
  --primary-border: #7dd3fc;
  --success: #10b981;
  --success-bg: #ecfdf5;
  --danger: #ef4444;
  --danger-bg: #fef2f2;
  --radius: 12px;
  --radius-lg: 16px;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.04), 0 1px 3px rgba(0,0,0,.06);
  --shadow: 0 4px 6px rgba(0,0,0,.04), 0 2px 4px rgba(0,0,0,.03);
  --shadow-lg: 0 10px 15px rgba(0,0,0,.05), 0 4px 6px rgba(0,0,0,.04);
}
* { box-sizing: border-box; }
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
/* 表单控件继承字体，避免默认系统控件视觉 */
button, input, select, textarea { font-family: inherit; }
button { user-select: none; -webkit-user-select: none; }

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
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 9px center;
  background-size: 12px;
  padding-right: 30px;
}
.app { min-height: 100vh; display: flex; flex-direction: column; }
.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  background: rgba(255,255,255,.85);
  backdrop-filter: blur(12px) saturate(180%);
  border-bottom: 1px solid var(--line);
  box-shadow: var(--shadow-sm);
}
.topbar .inner {
  max-width: 1160px;
  margin: 0 auto;
  padding: 14px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 800;
  font-size: 20px;
  letter-spacing: -0.02em;
  color: var(--text);
}
.logo{
  width:32px; height:32px; border-radius:8px;
  background: linear-gradient(135deg, #0ea5e9, #06b6d4);
  color:#fff; display:flex; align-items:center; justify-content:center;
  font-size:16px; font-weight:800;
  box-shadow: 0 2px 8px rgba(14,165,233,.3);
}
.sub{ font-weight:500; font-size:12px; color:var(--muted); margin-left:4px; letter-spacing:0 }
.nav { display: flex; gap: 8px; align-items:center }
.nav-link {
  padding: 8px 16px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  text-decoration: none !important;
  transition: all .15s ease;
  box-shadow: var(--shadow-sm);
}
.nav-link:hover { background: var(--card-hover); border-color: var(--line-strong); color: var(--text); transform: translateY(-1px); box-shadow: var(--shadow); }
.nav-link.active { background: var(--text); color: #fff; border-color: var(--text); box-shadow: var(--shadow); }
.nav-link.primary.active{ background: var(--primary); border-color: var(--primary); }
.main {
  max-width: 1160px;
  width: 100%;
  margin: 0 auto;
  padding: 28px 24px;
  flex: 1;
}
</style>
