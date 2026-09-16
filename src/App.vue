<template>
  <div class="min-h-screen flex flex-col">
    <header
      class="sticky top-0 z-20 border-b border-line bg-[rgba(244,241,234,0.88)] backdrop-blur-[12px] backdrop-saturate-[160%]"
    >
      <div class="max-w-[1140px] mx-auto px-7 flex items-center gap-6 h-[60px]">
        <div class="flex items-center gap-2.5 shrink-0" style="font-family:var(--serif)">
          <span class="text-[20px] font-700 tracking-[-0.01em] text-text">奇客题库</span>
          <span class="text-[12px] text-muted ml-1 tracking-normal font-400 hidden sm:inline">本地版</span>
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

    <!-- 设置弹窗 -->
    <Teleport to="body">
      <Transition name="dg">
        <div v-if="showSettings" class="dg-mask fixed inset-0 z-[1000] flex items-center justify-center bg-[rgba(15,23,42,0.45)] backdrop-blur-[3px]" @click.self="showSettings = false">
          <div class="dg-card w-[min(440px,calc(100vw-48px))] bg-card border border-line rounded-lg shadow-[0_20px_40px_rgba(2,6,23,0.25),0_4px_12px_rgba(2,6,23,0.12)] px-6 pt-5.5 pb-4.5" role="dialog" aria-label="设置">
            <h3 class="m-0 mb-4 text-[17px] font-700 tracking-[-0.01em] text-text font-[var(--serif)] flex items-center gap-2">
              <i class="i-lucide-settings-2 text-primary" />设置
            </h3>
            <div class="flex flex-col gap-2.5">
            <button
              type="button"
              role="switch"
              :aria-checked="settings.keepContentOnTypeChange"
              class="w-full flex items-start justify-between gap-3 p-3.5 border border-line rounded-[10px] bg-card cursor-pointer transition-[border-color,background-color] duration-150 hover:border-line-strong hover:bg-bg-accent text-left"
              @click="settings.keepContentOnTypeChange = !settings.keepContentOnTypeChange"
            >
              <span class="min-w-0">
                <span class="flex items-center gap-1.5 text-[14px] font-600 text-text">切换题型时保留内容<InfoTip text="启用后，切换试题类型时选项 / 答案 / 解析尽量复用而不重置（如单选切多选保留选项与答案，问答参考答案转存为解析）" /></span>
              </span>
              <span
                class="shrink-0 w-10 h-[22px] rounded-full mt-0.5 transition-colors duration-150 relative"
                :class="settings.keepContentOnTypeChange ? 'bg-primary' : 'bg-[var(--line-strong)]'"
              >
                <span
                  class="absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-all duration-150"
                  :class="settings.keepContentOnTypeChange ? 'left-[22px]' : 'left-[3px]'"
                />
              </span>
            </button>
            <div class="border border-line rounded-[10px] bg-card transition-[border-color,background-color] duration-150 hover:border-line-strong hover:bg-bg-accent">
            <button
              type="button"
              role="switch"
              :aria-checked="settings.autoNextOnCorrect"
              class="w-full flex items-start justify-between gap-3 p-3.5 pb-3 cursor-pointer text-left bg-transparent border-0"
              @click="settings.autoNextOnCorrect = !settings.autoNextOnCorrect"
            >
              <span class="min-w-0">
                <span class="flex items-center gap-1.5 text-[14px] font-600 text-text">答对自动下一题<InfoTip text="仅刷题模式生效：答对后短暂停留展示结果再自动下一题，等待时点击结果条可取消；答错停留看解析；复习模式仍需手动自评" /></span>
              </span>
              <span
                class="shrink-0 w-10 h-[22px] rounded-full mt-0.5 transition-colors duration-150 relative"
                :class="settings.autoNextOnCorrect ? 'bg-primary' : 'bg-[var(--line-strong)]'"
              >
                <span
                  class="absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-all duration-150"
                  :class="settings.autoNextOnCorrect ? 'left-[22px]' : 'left-[3px]'"
                />
              </span>
            </button>
            <div v-if="settings.autoNextOnCorrect" class="px-3.5 pb-3.5">
              <div class="border-t border-line pt-3 flex items-center gap-2">
              <span class="text-[12px] text-muted font-600">停留时长</span>
              <input
                v-model="delayText"
                class="input w-[76px] px-2.5 py-1.5 text-[13px] text-center"
                type="text"
                inputmode="decimal"
                autocomplete="off"
                @change="commitDelay"
                @blur="commitDelay"
                @keyup.enter="commitDelay"
                @keyup.esc="delayText = (settings.autoNextDelayMs / 1000).toString()"
              />
              <span class="text-[12px] text-muted">秒</span>
              </div>
            </div>
            </div>
            <button
              type="button"
              role="switch"
              :aria-checked="settings.rememberBankFilter"
              class="w-full flex items-start justify-between gap-3 p-3.5 border border-line rounded-[10px] bg-card cursor-pointer transition-[border-color,background-color] duration-150 hover:border-line-strong hover:bg-bg-accent text-left"
              @click="toggleRememberBankFilter"
            >
              <span class="min-w-0">
                <span class="flex items-center gap-1.5 text-[14px] font-600 text-text">记住各页题库选择<InfoTip text="开启后，刷题 / 复习 / 错题本 / 试题列表 / 新建试题的题库下拉会记住上次选择；关闭则每次默认全部题库（新建时须手动选库）" /></span>
              </span>
              <span
                class="shrink-0 w-10 h-[22px] rounded-full mt-0.5 transition-colors duration-150 relative"
                :class="settings.rememberBankFilter ? 'bg-primary' : 'bg-[var(--line-strong)]'"
              >
                <span
                  class="absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-all duration-150"
                  :class="settings.rememberBankFilter ? 'left-[22px]' : 'left-[3px]'"
                />
              </span>
            </button>
            <div class="border border-line rounded-[10px] bg-card p-3.5 flex items-center justify-between gap-3">
              <span class="min-w-0">
                <span class="flex items-center gap-1.5 text-[14px] font-600 text-text">连续答对自动移出错题<InfoTip text="错题连续答对该次数后自动移出错题本，中途答错重计；默认 1 次（答对即移出）" /></span>
              </span>
              <span class="flex items-center gap-1.5 shrink-0">
                <input
                  v-model="leaveText"
                  class="input w-[56px] px-2 py-1.5 text-[13px] text-center"
                  type="text"
                  inputmode="numeric"
                  autocomplete="off"
                  @change="commitLeave"
                  @blur="commitLeave"
                  @keyup.enter="commitLeave"
                  @keyup.esc="leaveText = String(settings.wrongLeaveAfterCorrect)"
                />
                <span class="text-[12px] text-muted">次</span>
              </span>
            </div>
            </div>
            <div class="border-t border-line mt-1 pt-3.5">
              <div class="flex items-center gap-1.5 text-[14px] font-600 text-text mb-2">
                <i class="i-lucide-info text-primary" />关于
              </div>
              <div class="text-[13px] text-muted flex flex-col gap-1.5">
                <div>奇客题库 <b class="text-text">{{ about.version || '—' }}</b><span v-if="about.portable !== null"> · {{ about.portable ? '便携版' : '安装版' }}</span></div>
                <div class="flex flex-wrap gap-2 pt-0.5">
                  <button type="button" class="btn btn-small" @click="openDataDir">
                    <i class="i-lucide-folder-open" />打开数据目录
                  </button>
                  <button type="button" class="btn btn-small" :disabled="about.update === 'checking'" @click="checkUpdate">
                    <i class="i-lucide-refresh-cw" />{{ about.update === 'checking' ? '检查中…' : '检查更新' }}
                  </button>
                  <button v-if="about.update === 'new'" type="button" class="btn btn-small btn-primary" @click="openReleases">
                    <i class="i-lucide-download" />下载 {{ about.latest }}
                  </button>
                </div>
                <div v-if="about.update === 'latest'" class="text-[12px] text-success">已是最新版本</div>
                <div v-if="about.update === 'failed'" class="text-[12px] text-danger">检查失败（离线或网络受限），可直接前往下载页查看</div>
                <button type="button" class="self-start text-[12px] text-muted-light hover:text-primary underline underline-offset-2" @click="openReleases">前往下载页查看所有版本</button>
              </div>
            </div>
            <div class="flex justify-end gap-2.5 mt-4">
              <button type="button" class="btn btn-primary" @click="showSettings = false">完成</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getVersion } from '@tauri-apps/api/app'
import { openUrl } from '@tauri-apps/plugin-opener'
import { loadBanks, bankStore, clearBankFilters } from '@/stores/bank.js'
import { settings } from '@/stores/settings.js'
import { toast } from '@/stores/ui.js'
import { cmd } from '@/api/bridge.js'
import { list as listQuestions } from '@/api/questions.js'
import { openDataDir as openDataDirApi } from '@/api/practice.js'
import DialogHost from '@/components/ui/DialogHost.vue'
import ToastHost from '@/components/ui/ToastHost.vue'
import InfoTip from '@/components/ui/InfoTip.vue'
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

// ── 关于 / 更新 ──
const about = reactive({ version: '', portable: null, update: 'idle', latest: '' })
async function ensureAbout() {
  if (about.version) return
  try {
    about.version = await getVersion()
  } catch {
    about.version = ''
  }
  try {
    const r = await cmd('is_portable_mode')
    about.portable = !!r?.data?.portable
  } catch {
    about.portable = null
  }
}
function cmpVer(a, b) {
  const pa = String(a).split('.').map((x) => Number(x) || 0)
  const pb = String(b).split('.').map((x) => Number(x) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}
async function checkUpdate() {
  about.update = 'checking'
  try {
    if (!about.version) {
      try {
        about.version = await getVersion()
      } catch { /* ignore */ }
    }
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
    if (!res.ok) throw new Error('http ' + res.status)
    const j = await res.json()
    const latest = String(j?.tag_name || '').replace(/^v/, '')
    if (!latest) throw new Error('empty tag')
    about.latest = latest
    about.update = !about.version || cmpVer(latest, about.version) > 0 ? 'new' : 'latest'
  } catch (e) {
    console.error(e)
    about.update = 'failed'
  }
}
async function openReleases() {
  try {
    await openUrl(RELEASES_URL)
  } catch (e) {
    console.error(e)
    toast('打开失败：' + (e?.message || e), 'error')
  }
}
async function openDataDir() {
  try {
    const d = await openDataDirApi()
    toast('已打开数据目录' + (d?.path ? `：${d.path}` : ''), 'success')
  } catch (e) {
    console.error(e)
    toast('打开失败：' + (e?.message || e), 'error')
  }
}

const showSettings = ref(false)

// 设置首次打开时懒加载版本/模式（纯前端 dev 下 invoke 失败就显示占位）
watch(showSettings, (v) => {
  if (v) ensureAbout()
})

// 关闭“记住题库选择”时顺手清掉各页记忆，下次全回默认全部题库
function toggleRememberBankFilter() {
  settings.rememberBankFilter = !settings.rememberBankFilter
  if (!settings.rememberBankFilter) clearBankFilters()
}

// 停留时长输入框：文本态本地持有，change/blur/回车时校验落盘，非法回滚
const delayText = ref((settings.autoNextDelayMs / 1000).toString())
watch(() => settings.autoNextDelayMs, (v) => {
  delayText.value = (v / 1000).toString()
})
function commitDelay() {
  const v = parseFloat(delayText.value)
  if (Number.isFinite(v) && v >= 0.3 && v <= 5) {
    settings.autoNextDelayMs = Math.round(v * 1000)
    delayText.value = (settings.autoNextDelayMs / 1000).toString()
  } else {
    delayText.value = (settings.autoNextDelayMs / 1000).toString()
    toast('停留时长请输入 0.3～5 之间的数字（秒）', 'error')
  }
}

// 错题移出阈值输入框：同上，整数 1–10
const leaveText = ref(String(settings.wrongLeaveAfterCorrect))
watch(() => settings.wrongLeaveAfterCorrect, (v) => {
  leaveText.value = String(v)
})
function commitLeave() {
  const v = Number(leaveText.value)
  if (Number.isFinite(v) && Number.isInteger(v) && v >= 1 && v <= 10) {
    settings.wrongLeaveAfterCorrect = v
    leaveText.value = String(v)
  } else {
    leaveText.value = String(settings.wrongLeaveAfterCorrect)
    toast('请输入 1～10 的整数（次）', 'error')
  }
}

const navItems = [
  { to: '/', label: '首页', icon: 'i-lucide-home' },
  { to: '/banks', label: '题库', icon: 'i-lucide-book-open' },
  { to: '/practice', label: '刷题', icon: 'i-lucide-zap' },
  { to: '/wrong', label: '错题本', icon: 'i-lucide-circle-x' },
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

/* App 内联设置弹窗入场（与 DialogHost 同语言；DialogHost 的是 scoped，App 用不了） */
.dg-enter-active, .dg-leave-active { transition: opacity .18s ease; }
.dg-enter-active .dg-card, .dg-leave-active .dg-card { transition: transform .18s ease; }
.dg-enter-from, .dg-leave-to { opacity: 0; }
.dg-enter-from .dg-card, .dg-leave-to .dg-card { transform: translateY(8px) scale(.97); }

/* 补线体标题工具类（由 uno.config theme.fontFamily.serif 提供 font-serif 原子类） */
</style>
