<template>
  <div class="min-h-screen flex flex-col">
    <header
      class="sticky top-0 z-20 border-b border-line bg-[rgba(244,241,234,0.88)] backdrop-blur-[12px] backdrop-saturate-[160%]"
    >
      <div class="max-w-[1140px] mx-auto px-7 flex items-center gap-10 h-[60px]">
        <div class="flex items-center gap-2.5 shrink-0" style="font-family:var(--serif)">
          <span class="text-[20px] font-700 tracking-[-0.01em] text-text">奇客题库</span>
        </div>
        <nav class="flex items-center gap-1 h-full ml-1">
          <router-link
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            active-class="active"
            class="nav-link relative inline-flex items-center gap-1 px-3.5 h-full text-[14px] font-500 no-underline text-text-secondary transition-[color] duration-150 hover:text-text"
          ><i :class="item.icon" aria-hidden="true" />{{ item.label }}</router-link>
        </nav>
        <div class="ml-auto flex items-center gap-2">
          <div class="relative hidden sm:block">
            <i class="i-lucide-search absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-light text-[14px] pointer-events-none" />
            <input
              v-model="searchText"
              class="input pl-8 pr-7 py-1.5 text-[13px] w-[210px]"
              type="text"
              placeholder="全局搜索试题…"
              autocomplete="off"
              @input="onSearchInput"
              @focus="onSearchFocus"
              @keyup.esc="closeSearch"
            />
            <button
              v-if="searchText"
              type="button"
              class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-light hover:text-text"
              title="清空"
              @click="clearSearch"
            ><i class="i-lucide-x text-[14px]" /></button>
            <div v-if="searchOpen" class="absolute right-0 top-full mt-2 w-[min(400px,calc(100vw-48px))] max-h-[60vh] overflow-auto card !p-2 z-[1001] shadow-lg text-left">
              <div v-if="searching" class="px-3 py-2.5 text-muted text-[13px]">搜索中…</div>
              <div v-else-if="searchText.trim() && !searchResults.length" class="px-3 py-2.5 text-muted text-[13px]">没有匹配的试题</div>
              <div v-for="q in searchResults" :key="q.id">
                <button type="button" class="w-full text-left px-2.5 py-2 rounded-[8px] hover:bg-bg-accent flex flex-col gap-0.5" @click="toggleSearchPreview(q.id)">
                  <span class="flex items-center gap-1.5 min-w-0">
                    <span class="badge badge-type shrink-0">{{ typeLabel(q.type) }}</span>
                    <span class="text-[13px] text-text truncate">{{ stemText(q) }}</span>
                  </span>
                  <span class="text-[12px] text-muted-light pl-1">{{ bankName(q.bank_id) }}</span>
                </button>
                <div v-if="expandedId === q.id" class="mx-1 mb-2 p-3 border border-line rounded-[8px] bg-bg">
                  <QuestionPreview :question="q" />
                  <div class="flex justify-end mt-2">
                    <button type="button" class="btn btn-small" @click="goEdit(q.id)">去编辑</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <button type="button" class="i-btn px-2.5 py-1.5 text-[13px]" title="设置" @click="showSettings = true">
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

    <SettingsDialog v-model="showSettings" />
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { loadBanks, bankStore } from '@/stores/bank.js'
import { toast } from '@/stores/ui.js'
import { list as listQuestions } from '@/api/questions.js'
import { stats as fetchStats } from '@/api/practice.js'
import DialogHost from '@/components/ui/DialogHost.vue'
import ToastHost from '@/components/ui/ToastHost.vue'
import SettingsDialog from '@/components/settings/SettingsDialog.vue'
import QuestionPreview from '@/components/QuestionPreview.vue'

const route = useRoute()
const router = useRouter()

const REPO = 'VxRain/QikeQBank'
const RELEASES_URL = `https://github.com/${REPO}/releases`

// ── 全局搜索：跨库搜题干，展开行内预览 + 去编辑 ──
const SEARCH_TYPE_LABELS = { single: '单选', multi: '多选', judge: '判断', fill: '填空', short: '简答', material: '材料' }
const searchText = ref('')
const searchResults = ref([])
const searching = ref(false)
const searchOpen = ref(false)
const expandedId = ref(null)
let searchTimer = null

function typeLabel(t) {
  return SEARCH_TYPE_LABELS[t] || t || '-'
}
function stemText(q) {
  const s = String(q?.plain_text || '').replace(/\s+/g, ' ').trim()
  return s ? (s.length > 60 ? s.slice(0, 60) + '…' : s) : '(空题干)'
}
function bankName(bid) {
  return bankStore.banks.find((b) => b.id === bid)?.name || '未知题库'
}
async function runSearch() {
  const kw = searchText.value.trim()
  if (!kw) {
    searchResults.value = []
    searching.value = false
    return
  }
  searching.value = true
  try {
    const res = await listQuestions({ query: kw, limit: 8 })
    searchResults.value = res?.data?.items || []
  } catch (e) {
    console.error(e)
    searchResults.value = []
  } finally {
    searching.value = false
  }
}
function onSearchInput() {
  if (!searchText.value.trim()) {
    clearSearch()
    return
  }
  searchOpen.value = true
  expandedId.value = null
  clearTimeout(searchTimer)
  searchTimer = setTimeout(runSearch, 250)
}
function onSearchFocus() {
  if (searchText.value.trim()) {
    searchOpen.value = true
    runSearch()
  }
}
function toggleSearchPreview(id) {
  expandedId.value = expandedId.value === id ? null : id
}
function closeSearch() {
  searchOpen.value = false
  expandedId.value = null
}
function clearSearch() {
  clearTimeout(searchTimer)
  searchText.value = ''
  searchResults.value = []
  searching.value = false
  expandedId.value = null
  searchOpen.value = false
}
function goEdit(id) {
  closeSearch()
  router.push(`/edit/${id}`)
}
watch(() => route.fullPath, closeSearch)

const showSettings = ref(false)

const navItems = [
  { to: '/', label: '首页', icon: 'i-lucide-home' },
  { to: '/banks', label: '题库', icon: 'i-lucide-book-open' },
  { to: '/practice', label: '刷题', icon: 'i-lucide-zap' },
  { to: '/exam', label: '模考', icon: 'i-lucide-clipboard-list' },
  { to: '/wrong', label: '错题本', icon: 'i-lucide-circle-x' },
  { to: '/review', label: '复习', icon: 'i-lucide-repeat' }
]

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

onMounted(() => { loadBanks(); maybeNotifyFsrsUpgrade() })
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

/* 设置弹窗入场动画已随组件迁入 components/settings/SettingsDialog.vue（scoped） */

/* 补线体标题工具类（由 uno.config theme.fontFamily.serif 提供 font-serif 原子类） */
</style>
