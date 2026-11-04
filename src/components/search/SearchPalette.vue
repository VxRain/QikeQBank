/**
 * 全局搜索命令面板（FE-P0-08）
 *
 * 为什么是「面板」而不是「下拉」：
 * 旧实现是 App.vue 顶栏里的一个 8 条题目下拉 —— 只有题目、无分组、无键盘选中、
 * 点空白不关、退出只认 Esc，且请求没带 summary（整批拉回富文本题干 + 选项 + 解析）。
 * 面板形态把「搜索」从「搜题」升级为「去哪 / 做什么」的统一入口。
 *
 * 分工：
 * - 分组构造 / 键盘规则 / 高亮 / 最近搜索 全在 `stores/search.js`（纯函数，可单测）
 * - 本文件只负责 DOM：遮罩、焦点、渲染、事件接线
 *
 * 数据来源（不新造第三套匹配逻辑）：
 * - 题目：api/questions.ts 的 list()，首屏 `summary: true`
 * - 题库：stores/bank.js 已加载的列表
 * - 页面：router 路由表（meta.title + PAGE_ALIASES 别称）
 * - 设置：components/settings/registry.js 的 matchItem / isItemVisible
 */
<template>
  <Teleport to="body">
    <Transition name="sp">
      <div v-if="modelValue" class="sp-mask" @mousedown.self="close">
        <div
          ref="cardEl"
          class="sp-card"
          role="dialog"
          aria-modal="true"
          aria-label="全局搜索"
          tabindex="-1"
        >
          <!-- 输入行 -->
          <div class="sp-head">
            <i class="i-lucide-search sp-head-icon" aria-hidden="true" />
            <input
              ref="inputEl"
              v-model="query"
              class="sp-input"
              type="text"
              placeholder="搜索试题、题库、页面、设置…"
              autocomplete="off"
              spellcheck="false"
              aria-label="搜索关键词"
              @keydown="onKeydown"
            />
            <button
              v-if="query"
              type="button"
              class="sp-clear"
              title="清空（Esc）"
              @click="clearQuery"
            ><i class="i-lucide-x" aria-hidden="true" /></button>
            <kbd v-else class="sp-kbd">Esc</kbd>
          </div>

          <!-- 结果区 -->
          <div ref="listEl" class="sp-list">
            <!-- 空关键词：最近搜索 -->
            <template v-if="!keyword">
              <div v-if="recent.length" class="sp-group">
                <div class="sp-group-head">
                  <span>最近搜索</span>
                  <button type="button" class="sp-group-act" @click="onClearRecent">清空</button>
                </div>
                <button
                  v-for="kw in recent"
                  :key="kw"
                  type="button"
                  class="sp-row"
                  :class="{ 'is-active': isActive(recentRow(kw)) }"
                  @click="applyRecent(kw)"
                  @mouseenter="setActive(recentRow(kw))"
                >
                  <i class="i-lucide-history sp-row-icon" aria-hidden="true" />
                  <span class="sp-row-main"><span class="sp-row-title">{{ kw }}</span></span>
                  <i class="i-lucide-corner-down-left sp-row-enter" aria-hidden="true" />
                </button>
              </div>
              <div v-else class="sp-empty">
                <i class="i-lucide-search" aria-hidden="true" />
                <p>输入关键词开始搜索</p>
                <span>可搜题干、题库名、页面名、设置项</span>
              </div>
            </template>

            <!-- 有结果 -->
            <template v-else>
              <div v-if="store.loading" class="sp-empty sp-empty-sm">
                <i class="i-lucide-loader-circle animate-spin" aria-hidden="true" />
                <p>搜索中…</p>
              </div>
              <div v-else-if="store.error" class="sp-error">
                <i class="i-lucide-triangle-alert" aria-hidden="true" />{{ store.error }}
              </div>

              <div v-for="group in groups" :key="group.kind" class="sp-group">
                <div class="sp-group-head">
                  <span>{{ group.label }}</span>
                  <span class="sp-group-count">{{ group.items.length }}</span>
                </div>
                <template v-for="item in group.items" :key="item.key">
                  <button
                    type="button"
                    class="sp-row"
                    :class="{ 'is-active': isActive(item) }"
                    @click="activate(item)"
                    @mouseenter="setActive(item)"
                  >
                    <i :class="rowIcon(item)" class="sp-row-icon" aria-hidden="true" />
                    <span class="sp-row-main">
                      <span class="sp-row-title">
                        <template v-for="(seg, si) in highlight(item.title)" :key="si">
                          <mark v-if="seg.hit" class="sp-mark">{{ seg.text }}</mark>
                          <template v-else>{{ seg.text }}</template>
                        </template>
                      </span>
                      <span v-if="rowDesc(item)" class="sp-row-desc">
                        <template v-for="(seg, si) in highlight(rowDesc(item))" :key="si">
                          <mark v-if="seg.hit" class="sp-mark">{{ seg.text }}</mark>
                          <template v-else>{{ seg.text }}</template>
                        </template>
                      </span>
                    </span>
                    <span v-if="item.kind === 'question'" class="sp-row-act">
                      <span class="badge badge-type">{{ typeLabel(item.raw?.type) }}</span>
                      <span
                        class="sp-expand"
                        :title="store.expandedId === item.id ? '收起预览（→）' : '预览题面（→）'"
                        role="button"
                        tabindex="-1"
                        @click.stop="toggleExpand(item)"
                      ><i :class="store.expandedId === item.id ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" aria-hidden="true" /></span>
                    </span>
                    <i v-else class="i-lucide-corner-down-left sp-row-enter" aria-hidden="true" />
                  </button>
                  <!-- 展开：此时才 questions_get(id) 取全文 -->
                  <div v-if="item.kind === 'question' && store.expandedId === item.id" class="sp-preview">
                    <div v-if="!store.expanded[item.id]" class="sp-empty sp-empty-sm">
                      <i class="i-lucide-loader-circle animate-spin" aria-hidden="true" />
                      <p>加载题面详情…</p>
                    </div>
                    <QuestionPreview v-else :question="store.expanded[item.id]" />
                    <div class="sp-preview-foot">
                      <button type="button" class="btn btn-small" @click="goQuestion(item.id)">去编辑</button>
                    </div>
                  </div>
                </template>
                <!-- 题目分组的「查看全部」紧跟在题目后面，避免掉到面板最底部 -->
                <button
                  v-if="group.kind === 'question' && viewAllRow"
                  type="button"
                  class="sp-row sp-row-all"
                  :class="{ 'is-active': isActive(viewAllRow) }"
                  @click="activate(viewAllRow)"
                  @mouseenter="setActive(viewAllRow)"
                >
                  <i class="i-lucide-list sp-row-icon" aria-hidden="true" />
                  <span class="sp-row-main">
                    <span class="sp-row-title">
                      <template v-for="(seg, si) in highlight(viewAllRow.title)" :key="si">
                        <mark v-if="seg.hit" class="sp-mark">{{ seg.text }}</mark>
                        <template v-else>{{ seg.text }}</template>
                      </template>
                    </span>
                    <span class="sp-row-desc">{{ viewAllRow.desc }}</span>
                  </span>
                  <i class="i-lucide-corner-down-left sp-row-enter" aria-hidden="true" />
                </button>
              </div>

              <div v-if="!store.loading && !rows.length" class="sp-empty">
                <i class="i-lucide-search-x" aria-hidden="true" />
                <p>没有匹配「{{ keyword }}」的结果</p>
                <span>试试更短的关键词，或换个说法</span>
              </div>
            </template>
          </div>

          <!-- 底栏提示：键位文案必须与 onKeydown 实际分支一致 -->
          <div class="sp-foot">
            <span><kbd class="sp-kbd">↑</kbd><kbd class="sp-kbd">↓</kbd>选择</span>
            <span><kbd class="sp-kbd">Enter</kbd>打开</span>
            <span><kbd class="sp-kbd">→</kbd>预览题面</span>
            <span><kbd class="sp-kbd">Esc</kbd>{{ keyword ? '清空' : '关闭' }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  SEARCH_DEBOUNCE,
  buildBankResults,
  buildGroups,
  buildPageResults,
  buildRows,
  buildSettingResults,
  escStep,
  expandQuestion,
  loadRecent,
  nextActive,
  normalizeKeyword,
  pushRecent,
  clearRecent,
  resetResults,
  runQuestionSearch,
  searchStore as store,
  splitHighlight
} from '@/stores/search.js'
import { bankStore } from '@/stores/bank.js'
import { list as listQuestions, get as getQuestion } from '@/api/questions.ts'
import { toast } from '@/stores/ui.js'
import { SETTINGS_SECTIONS, isItemVisible, matchItem } from '@/components/settings/registry.js'
import QuestionPreview from '@/components/QuestionPreview.vue'
import { typeLabel } from '@/constants/questions.js'

const props = defineProps({
  modelValue: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'open-settings'])

const router = useRouter()
const cardEl = ref(null)
const inputEl = ref(null)
const listEl = ref(null)

const query = ref('')
const recent = ref([])
const keyword = computed(() => normalizeKeyword(query.value))

/* ───────────── 结果构造：四组 + 「查看全部」 ───────────── */

const groups = computed(() =>
  buildGroups({
    kw: keyword.value,
    questions: store.questions,
    banks: store.banks,
    pages: store.pages,
    settings: store.settings
  })
)

const viewAllRow = computed(() => {
  const all = buildRows({ kw: keyword.value, questionTotal: store.questionTotal })
  return all.find((r) => r.kind === 'viewAll') || null
})

/**
 * 键盘遍历顺序 = 眼睛看到的顺序。
 * - 空关键词时遍历的是「最近搜索」（面板这时只显示它）
 * - 「查看全部」在 DOM 里紧跟题目分组，所以这里也必须紧跟（而不是拼到末尾）
 */
const rows = computed(() => {
  if (!keyword.value) return recent.value.map(recentRow)
  const out = []
  for (const g of groups.value) {
    for (const item of g.items) out.push(item)
    if (g.kind === 'question' && viewAllRow.value) out.push(viewAllRow.value)
  }
  return out
})

/** 最近搜索项也当作一行参与键盘遍历（同一套 ↑/↓/Enter） */
function recentRow(kw) {
  return { kind: 'recent', key: `recent:${kw}`, id: kw, title: kw }
}

const activeIndex = computed({
  get: () => (rows.value.length ? Math.min(store.activeIndex, rows.value.length - 1) : -1),
  set: (v) => { store.activeIndex = v }
})

function isActive(item) {
  return activeIndex.value >= 0 && rows.value[activeIndex.value]?.key === item.key
}
function setActive(item) {
  const i = rows.value.findIndex((r) => r.key === item.key)
  if (i >= 0) activeIndex.value = i
}

function highlight(text) {
  return splitHighlight(text, keyword.value)
}

function rowDesc(item) {
  if (item.kind === 'question') {
    const bid = item.raw?.bank_id
    return bankStore.banks.find((b) => b.id === bid)?.name || ''
  }
  return item.desc || ''
}

function rowIcon(item) {
  return {
    question: 'i-lucide-file-text',
    bank: 'i-lucide-book-open',
    page: 'i-lucide-corner-up-right',
    setting: 'i-lucide-settings-2',
    viewAll: 'i-lucide-list'
  }[item.kind] || 'i-lucide-dot'
}

/* ───────────── 搜索主流程 ───────────── */

let timer = null

function rebuildLocalGroups(kw) {
  store.banks = buildBankResults(bankStore.banks, kw)
  store.pages = buildPageResults(router.options.routes, kw)
  store.settings = buildSettingResults(SETTINGS_SECTIONS, kw, matchItem, isItemVisible)
}

async function runSearch() {
  const kw = keyword.value
  rebuildLocalGroups(kw)
  if (!kw) {
    store.questions = []
    store.questionTotal = 0
    store.loading = false
    return
  }
  await runQuestionSearch(kw, { listQuestions, store })
  store.activeIndex = 0
}

/**
 * 记一条最近搜索的时机：用户「选定」了这次搜索，而不是每敲一个字。
 *
 * 若在输入时就记，最近搜索会变成「搜过什么」的噪声（"错""错题""错题本" 三条）；
 * 真正有价值的是「我最终想找的那个词」。两个选定点：↑/↓ 选中后按 Enter、展开题面预览。
 * 点击结果跳转也会记（见 activate），但那条路径会立刻离开面板，所以这里补上原地选定的路径。
 */
function rememberSearch() {
  if (!keyword.value) return
  recent.value = pushRecent(keyword.value, recent.value)
}

watch(keyword, (kw) => {
  clearTimeout(timer)
  resetResults(store)
  if (!kw) {
    // 回到空态：立刻重建（题库/页面/设置均为空，只剩最近搜索）
    rebuildLocalGroups('')
    return
  }
  // 本地分组（题库/页面/设置）无 IPC 成本，立即出结果；题目走防抖 + summary 请求
  rebuildLocalGroups(kw)
  timer = setTimeout(() => { runSearch() }, SEARCH_DEBOUNCE)
})

onBeforeUnmount(() => clearTimeout(timer))

/* ───────────── 打开 / 关闭 ───────────── */

function close() {
  clearTimeout(timer)
  query.value = ''
  resetResults(store)
  emit('update:modelValue', false)
}

function clearQuery() {
  clearTimeout(timer)
  query.value = ''
  resetResults(store)
  nextTick(() => inputEl.value?.focus())
}

function onClearRecent() {
  recent.value = clearRecent()
  nextTick(() => inputEl.value?.focus())
}

function applyRecent(kw) {
  query.value = kw
  nextTick(() => inputEl.value?.focus())
}

watch(
  () => props.modelValue,
  async (v) => {
    if (!v) return
    recent.value = loadRecent()
    query.value = ''
    resetResults(store)
    await nextTick()
    inputEl.value?.focus()
    inputEl.value?.select?.()
  },
  { immediate: true }
)

/* ───────────── 键盘 ───────────── */

function onKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return
  if (e.ctrlKey || e.metaKey || e.altKey) return
  const n = rows.value.length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = nextActive(activeIndex.value, n, 1)
    scrollActiveIntoView()
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = nextActive(activeIndex.value, n, -1)
    scrollActiveIntoView()
    return
  }
  if (e.key === 'Enter') {
    const row = rows.value[activeIndex.value]
    rememberSearch()
    if (!row) {
      if (keyword.value) {
        // 无选中项时回车：把当前关键词记进最近搜索并发起一次搜索
        recent.value = pushRecent(keyword.value, recent.value)
        runSearch()
      }
      return
    }
    e.preventDefault()
    activate(row)
    return
  }
  if (e.key === 'Tab') {
    // 焦点留在面板内：面板只有一个输入框，Tab 不该把焦点丢到背后页面
    e.preventDefault()
    inputEl.value?.focus()
    return
  }
  if (e.key === 'Escape' || e.key === 'Esc') {
    e.preventDefault()
    // Esc 逐级：有关键词先清空，再按一次才关闭（规则在 store 的 escStep 里，单测覆盖）
    if (escStep(query.value) === 'clear') {
      clearQuery()
      return
    }
    close()
    return
  }
  if (e.key === 'ArrowRight') {
    const row = rows.value[activeIndex.value]
    if (row?.kind === 'question') {
      e.preventDefault()
      toggleExpand(row)
    }
  }
}

function scrollActiveIntoView() {
  nextTick(() => {
    const el = listEl.value?.querySelector('.sp-row.is-active')
    el?.scrollIntoView({ block: 'nearest' })
  })
}

/* ───────────── 激活（跳转 / 打开设置） ───────────── */

function activate(item) {
  if (!item) return
  if (item.kind === 'recent') {
    applyRecent(item.id)
    return
  }
  // 有结果时把关键词记入最近搜索（空关键词不记，避免最近列表被空串污染）
  if (keyword.value) recent.value = pushRecent(keyword.value, recent.value)
  if (item.kind === 'question') {
    goQuestion(item.id)
    return
  }
  if (item.kind === 'setting') {
    close()
    emit('open-settings', { sectionId: item.sectionId, query: keyword.value })
    return
  }
  close()
  router.push(item.to)
}

function goQuestion(id) {
  close()
  router.push(`/edit/${id}`)
}

/**
 * 展开题面：此时才 questions_get(id)（首屏只取过 summary）。
 * 已展开 → 收起。
 */
async function toggleExpand(item) {
  if (store.expandedId === item.id) {
    store.expandedId = ''
    nextTick(() => inputEl.value?.focus())
    return
  }
  rememberSearch()
  store.expandedId = item.id
  await nextTick()
  store.activeIndex = Math.max(0, rows.value.findIndex((r) => r.key === item.key))
  if (store.expanded[item.id]) return
  const full = await expandQuestion(item.id, { getQuestion, store })
  if (!full) toast(store.error || '加载题目详情失败', 'error')
  nextTick(() => inputEl.value?.focus())
}
</script>

<style scoped>
/* ── 遮罩与卡片：与 DialogHost / SettingsDialog 同一套入场语言 ── */
.sp-mask {
  position: fixed;
  inset: 0;
  z-index: 1040;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 92px 24px 24px;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(3px);
}
.sp-card {
  display: flex;
  flex-direction: column;
  width: min(640px, 100%);
  max-height: min(560px, calc(100vh - 140px));
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 40px rgba(2, 6, 23, 0.25), 0 4px 12px rgba(2, 6, 23, 0.12);
  overflow: hidden;
  outline: none;
}

/* ── 输入行 ── */
.sp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  height: 54px;
  padding: 0 12px 0 16px;
  border-bottom: 1px solid var(--line);
}
.sp-head-icon {
  font-size: 16px;
  color: var(--muted);
  flex-shrink: 0;
}
.sp-input {
  flex: 1;
  min-width: 0;
  height: 40px;
  border: 0;
  outline: none;
  background: transparent;
  font-size: 15px;
  color: var(--text);
}
.sp-input::placeholder { color: var(--muted-light); }
.sp-clear {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--muted);
  cursor: pointer;
  transition: color .15s ease, background-color .15s ease;
}
.sp-clear:hover { color: var(--text); background: var(--bg-accent); }

.sp-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 19px;
  padding: 0 4px;
  border: 1px solid var(--line);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--bg);
  color: var(--muted);
  font-size: 11px;
  font-family: inherit;
  line-height: 1;
}

/* ── 结果区 ── */
.sp-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}
.sp-group + .sp-group { margin-top: 2px; }
.sp-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 4px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--muted-light);
}
.sp-group-count { margin-left: auto; }
.sp-group-act {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--muted);
  cursor: pointer;
  text-transform: none;
  letter-spacing: 0;
}
.sp-group-act:hover { color: var(--primary); }

.sp-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 8px;
  text-align: left;
  cursor: pointer;
  transition: background-color .12s ease;
}
.sp-row.is-active { background: var(--primary-bg); }
.sp-row-icon { font-size: 14px; color: var(--muted); flex-shrink: 0; }
.sp-row.is-active .sp-row-icon { color: var(--primary); }
.sp-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.sp-row-title {
  font-size: 13.5px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-row-desc {
  font-size: 11.5px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-row-act { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
.sp-expand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  color: var(--muted);
  cursor: pointer;
}
.sp-expand:hover { background: var(--bg-accent); color: var(--text); }
.sp-row-enter { font-size: 13px; color: var(--muted-light); flex-shrink: 0; }
.sp-row.is-active .sp-row-enter { color: var(--primary); }
.sp-row-all .sp-row-title { color: var(--primary); font-weight: 600; }

/* 关键词高亮：主色底 + 文字同色系，不用浏览器默认黄底 */
.sp-mark {
  background: var(--primary-bg);
  color: var(--primary);
  font-weight: 700;
  border-radius: 3px;
  padding: 0 1px;
}

.sp-preview {
  margin: 2px 4px 8px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg);
}
.sp-preview-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

.sp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 40px 16px;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}
.sp-empty i { font-size: 22px; color: var(--muted-light); margin-bottom: 2px; }
.sp-empty p { margin: 0; color: var(--text-secondary); }
.sp-empty span { font-size: 12px; color: var(--muted-light); }
.sp-empty-sm { padding: 18px 16px; }

.sp-error {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 6px;
  padding: 9px 11px;
  border: 1px solid var(--danger);
  border-radius: 8px;
  background: var(--danger-bg);
  color: var(--danger);
  font-size: 12.5px;
}

/* ── 底栏 ── */
.sp-foot {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-shrink: 0;
  padding: 7px 14px;
  border-top: 1px solid var(--line);
  background: var(--bg);
  font-size: 11.5px;
  color: var(--muted);
}
.sp-foot span { display: inline-flex; align-items: center; gap: 4px; }

/* ── 入场动画（与 .dg / .sd 同语言：遮罩淡入 + 卡片轻微下移缩放） ── */
.sp-enter-active, .sp-leave-active { transition: opacity .16s ease; }
.sp-enter-active .sp-card, .sp-leave-active .sp-card { transition: transform .16s ease; }
.sp-enter-from, .sp-leave-to { opacity: 0; }
.sp-enter-from .sp-card, .sp-leave-to .sp-card { transform: translateY(-6px) scale(.985); }
@media (prefers-reduced-motion: reduce) {
  .sp-enter-active, .sp-leave-active,
  .sp-enter-active .sp-card, .sp-leave-active .sp-card { transition: none; }
}
</style>
