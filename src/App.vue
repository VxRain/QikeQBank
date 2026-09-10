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
          <router-link to="/library" class="nav-link" active-class="active">题库</router-link>
          <router-link to="/create" class="nav-link primary" active-class="active">+ 新增</router-link>
          <router-link to="/practice" class="nav-link" active-class="active">刷题</router-link>
          <router-link to="/review" class="nav-link" active-class="active">复习</router-link>
        </nav>
      </div>
    </header>
    <main class="main">
      <router-view />
    </main>
  </div>
</template>

<script setup>
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
