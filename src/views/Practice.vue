<template>
  <div class="page">
    <div v-if="error" class="error-box">{{ error }}</div>

    <!-- 设置面板 -->
    <section v-if="phase === 'setup'" class="card max-w-[640px]">
      <div class="card-head">
        <h2 class="section-title flex items-center gap-2"><i class="i-lucide-zap text-primary" />{{ mode === 'recite' ? '开始背题' : '开始刷题' }}</h2>
        <span class="badge badge-type">{{ mode === 'recite' ? '背题模式 · 直接看答案与解析' : '练习模式 · 判分后计入复习' }}</span>
      </div>

      <div class="mb-5">
        <div class="field-label">模式</div>
        <div class="flex gap-2 flex-wrap">
          <button
            type="button"
            class="px-4.5 py-2 rounded-[8px] border border-line bg-card text-text-secondary text-[14px] font-500 cursor-pointer transition-[background-color,border-color,color] duration-150 shadow-sm hover:bg-bg-accent"
            :class="mode === 'practice' && 'bg-text text-white border-text'"
            @click="setMode('practice')"
          ><i class="i-lucide-zap mr-1.5" />练习 · 作答判分</button>
          <button
            type="button"
            class="px-4.5 py-2 rounded-[8px] border border-line bg-card text-text-secondary text-[14px] font-500 cursor-pointer transition-[background-color,border-color,color] duration-150 shadow-sm hover:bg-bg-accent"
            :class="mode === 'recite' && 'bg-text text-white border-text'"
            @click="setMode('recite')"
          ><i class="i-lucide-book-open mr-1.5" />背题 · 看答案过一遍</button>
        </div>
      </div>

      <div class="mb-5">
        <div class="field-label">题库</div>
        <select v-model="bankId" class="select w-full max-w-[320px]" @change="persistBankFilter('practice', bankId)">
          <option value="">全部题库</option>
          <option v-for="b in bankStore.banks" :key="b.id" :value="b.id">{{ b.name }}</option>
        </select>
      </div>

      <div class="mb-5">
        <div class="field-label">题型（多选）</div>
        <div class="flex flex-wrap gap-2.5">
          <label
            v-for="t in ALL_TYPES"
            :key="t"
            class="inline-flex items-center gap-1.5 px-4 py-2 border border-line rounded-full bg-card text-text-secondary text-[14px] cursor-pointer transition-[background-color,border-color,color] duration-150 select-none"
            :class="selectedTypes.includes(t) && 'bg-primary-bg border-primary-border text-primary font-600'"
          >
            <input v-model="selectedTypes" type="checkbox" :value="t" class="hidden" />
            {{ TYPE_FULL_LABELS[t] }}
          </label>
        </div>
      </div>

      <div class="mb-5">
        <div class="field-label">题量</div>
        <div class="flex gap-2 flex-wrap">
          <button
            v-for="c in COUNT_OPTIONS"
            :key="c.value"
            type="button"
            class="px-4.5 py-2 rounded-[8px] border border-line bg-card text-text-secondary text-[14px] font-500 cursor-pointer transition-[background-color,border-color,color] duration-150 shadow-sm hover:bg-bg-accent"
            :class="count === c.value && 'bg-text text-white border-text'"
            @click="count = c.value"
          >
            {{ c.label }}
          </button>
        </div>
      </div>

      <div>
        <button
          type="button"
          class="btn btn-primary btn-big"
          :disabled="!selectedTypes.length || fetching"
          @click="start"
        >
          <i class="i-lucide-play" />{{ fetching ? '正在抽题…' : (mode === 'recite' ? '开始背题' : '开始刷题') }}
        </button>
        <div class="text-[12px] text-muted-light mt-2.5 flex items-center gap-1.5">
          <i class="i-lucide-keyboard" />键盘：A–F 选题，Enter 提交，M 切换材料；背题模式 ←/→ 翻题
        </div>
      </div>
    </section>

    <!-- 作答卡片 -->
    <section v-else-if="phase === 'card'" ref="cardRef" tabindex="-1" class="card flex flex-col gap-3.5" @keydown="onCardKeydown">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <span class="badge badge-type">{{ curBadge }}</span>
          <span v-if="recite" class="badge shrink-0"><i class="i-lucide-book-open" />背题模式</span>
        </div>
        <span class="text-[13px] text-muted font-500 shrink-0">第 {{ curIdx + 1 }} / {{ pool.length }} 题</span>
      </div>
      <div class="progress-track"><div class="progress-inner" :style="{ width: progressPct + '%' }"></div></div>

      <QuestionRunner
        :item="cur"
        :mode="recite ? 'recite' : 'practice'"
        :selected="singlePick"
        :picked="multiPick"
        :fill-values="fillValues"
        :short-text="shortText"
        :show-ref="showRef"
        :material-open="materialOpen"
        :locked="graded"
        @update:selected="singlePick = $event"
        @update:picked="multiPick = $event"
        @update:short-text="shortText = $event"
        @update:show-ref="showRef = $event"
        @update:material-open="materialOpen = $event"
        @fill-enter="submit"
      >
        <!-- 简答自评（仅练习模式） -->
        <template #short-actions="{ showRef: refOpen }">
          <div v-if="refOpen && !graded" class="flex items-center gap-2.5 flex-wrap">
            <span class="text-[13px] text-muted">这道题你会吗？<span class="text-muted-light">（键盘 1 不会 · 2 会）</span></span>
            <button type="button" class="btn btn-danger" @click="shortSubmit('不会')"><i class="i-lucide-x" />不会</button>
            <button type="button" class="btn btn-primary" @click="shortSubmit('会')"><i class="i-lucide-check" />会</button>
          </div>
        </template>

        <!-- 背题模式：直接展示答案 + 解析，只留上下题 -->
        <template #default="{ analysisHtml, answerHtml, refHtml }">
          <div v-if="recite" class="border-t border-line pt-4 flex flex-col gap-3">
            <div v-if="isChoiceLike" class="answer-view border border-line rounded-[8px] p-2.5 bg-bg-accent text-[14px]" v-html="answerHtml"></div>
            <div v-else-if="cur.q.type === 'fill'" class="flex flex-col gap-1.5">
              <div v-for="b in cur.q.answer?.blanks || []" :key="b.id" class="flex items-baseline gap-2 px-3 py-2 rounded-[8px] text-[13px] border border-[#bcd9c4] bg-success-bg text-text-secondary">
                <span class="font-700 text-text">{{ b.id }}</span>
                <span>正确答案：{{ (b.answers || []).join(' / ') || '—' }}</span>
              </div>
            </div>
            <div v-else-if="cur.q.type === 'short' && refHtml" class="p-3.5 bg-success-bg border border-[#bcd9c4] rounded-[8px] text-[14px] leading-[1.7] text-text-secondary">
              <b class="text-success flex items-center gap-1"><i class="i-lucide-book-open text-[14px]" />参考答案：</b>
              <div v-html="refHtml"></div>
            </div>
            <div v-if="analysisHtml" class="analysis p-3.5 bg-bg-accent border border-line rounded-[8px] text-[14px] leading-[1.7] text-text-secondary">
              <b class="text-primary flex items-center gap-1"><i class="i-lucide-lightbulb text-[14px]" />解析：</b>
              <div v-html="analysisHtml"></div>
            </div>
            <div class="flex justify-between gap-2">
              <button type="button" class="btn btn-big" :disabled="curIdx === 0" title="← 上一题" @click="prev"><i class="i-lucide-arrow-left" />上一题</button>
              <button ref="nextBtnRef" type="button" class="btn btn-primary btn-big" title="→ 下一题" @click="next"><i class="i-lucide-arrow-right" />{{ isLast ? '完成' : '下一题' }}</button>
            </div>
          </div>

          <!-- 提交（仅练习模式） -->
          <div v-if="!recite && !graded && !isShort">
            <button type="button" class="btn btn-primary btn-big" :disabled="!canSubmit" @click="submit">
              <i class="i-lucide-check-circle" />提交判分
            </button>
          </div>

          <!-- 判分结果（判分前绝不展示答案/解析） -->
          <div v-if="graded" class="border-t border-line pt-4 flex flex-col gap-3">
            <div
              class="flex items-center gap-2 text-[16px] font-700 px-3.5 py-3 rounded-[8px] relative overflow-hidden"
              :class="[gradeResult.correct ? 'text-success bg-success-bg border border-[#bcd9c4]' : 'text-danger bg-danger-bg border border-[#e3c9c5]', autoNextPending && 'cursor-pointer select-none']"
              :role="autoNextPending ? 'button' : undefined"
              :tabindex="autoNextPending ? 0 : undefined"
              :title="autoNextPending ? '点击取消自动下一题' : undefined"
              @click="autoNextPending && cancelAutoNext()"
              @keydown.enter="autoNextPending && cancelAutoNext()"
              @keydown.space.prevent="autoNextPending && cancelAutoNext()"
            >
              <i :class="gradeResult.correct ? 'i-lucide-circle-check' : 'i-lucide-circle-x'" />
              <span>{{ gradeResult.correct ? '回答正确' : '回答错误' }}</span>
              <span v-if="autoNextPending" class="text-[12px] font-500 opacity-75">· {{ (autoNextMs / 1000).toFixed(1) }}s 后自动下一题，点击取消</span>
              <span v-if="autoNextPending" class="auto-next-track" aria-hidden="true"><span class="auto-next-fill" :style="{ animationDuration: autoNextMs + 'ms' }"></span></span>
            </div>

            <div v-if="isChoice && gradeResult" class="answer-view border border-line rounded-[8px] p-2.5 bg-bg-accent text-[14px]" v-html="answerHtml"></div>

            <div v-if="cur.q.type === 'fill'" class="flex flex-col gap-1.5">
              <div v-for="r in gradeResult.results" :key="r.id" class="flex items-baseline gap-2 flex-wrap px-3 py-2 rounded-[8px] text-[13px] border border-line" :class="r.correct ? 'bg-success-bg border-[#bcd9c4] text-text-secondary' : 'bg-danger-bg border-[#e3c9c5] text-text-secondary'">
                <span class="font-700 text-text">{{ r.id }}</span>
                <span>你的答案：{{ r.value || '（未填写）' }}</span>
                <span class="font-700" :class="r.correct ? 'text-success' : 'text-danger'">{{ r.correct ? '✓' : '✗' }}</span>
                <span v-if="!r.correct" class="text-danger font-500">正确答案：{{ blankAnswersOf(r.id) }}</span>
              </div>
            </div>

            <div v-if="analysisHtml" class="analysis p-3.5 bg-bg-accent border border-line rounded-[8px] text-[14px] leading-[1.7] text-text-secondary">
              <b class="text-primary flex items-center gap-1"><i class="i-lucide-lightbulb text-[14px]" />解析：</b>
              <div v-html="analysisHtml"></div>
            </div>

            <div v-if="recordError" class="text-[12px] text-danger flex items-center gap-1"><i class="i-lucide-triangle-alert" />记录失败：{{ recordError }}</div>

            <div class="flex justify-end">
              <button ref="nextBtnRef" type="button" class="btn btn-primary btn-big" @click="next"><i class="i-lucide-arrow-right" />下一题</button>
            </div>
          </div>
        </template>
      </QuestionRunner>
    </section>

    <!-- 结束页 -->
    <section v-else-if="phase === 'done'" class="card flex flex-col gap-5 items-center text-center">
      <div class="text-[22px] font-800 tracking-[-0.01em] font-[var(--serif)] flex items-center gap-2">
        <i :class="recite ? 'i-lucide-book-open' : 'i-lucide-trophy'" class="text-primary text-[26px]" />{{ recite ? '本轮背题结束' : '本轮练习结束' }}
      </div>
      <div class="flex gap-3.5 flex-wrap justify-center">
        <div v-if="recite" class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-text">{{ lastRound.total }}</div>
          <div class="text-[12px] text-muted mt-1">已过题数</div>
        </div>
        <template v-else>
        <div class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-text">{{ lastRound.correct }} / {{ lastRound.total }}</div>
          <div class="text-[12px] text-muted mt-1">答对题数</div>
        </div>
        <div class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-text">{{ lastRound.rate }}%</div>
          <div class="text-[12px] text-muted mt-1">正确率</div>
        </div>
        </template>
        <div class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-text">{{ fmtMs(lastRound.ms) }}</div>
          <div class="text-[12px] text-muted mt-1">本轮用时</div>
        </div>
        <div v-if="!recite && lastRound.wrong.length" class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-danger">{{ lastRound.wrong.length }}</div>
          <div class="text-[12px] text-muted mt-1">错题数</div>
        </div>
      </div>

      <div v-if="!recite && rounds.length > 1" class="text-[13px] text-muted">
        累计：{{ sessionStats.total }} 题 · 答对 {{ sessionStats.correct }} ·
        共 {{ fmtMs(sessionStats.ms) }}
      </div>

      <div class="flex gap-3 flex-wrap justify-center">
        <button
          v-if="lastRound.wrong.length"
          type="button"
          class="btn btn-primary btn-big"
          @click="startRedo"
        >
          错题重做（{{ lastRound.wrong.length }} 题）
        </button>
        <router-link to="/" class="btn btn-big"><i class="i-lucide-home" />返回首页</router-link>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { practicePool, recordAnswer, stats as fetchStats } from '@/api/practice.js'
import { expandQuestions } from '@/api/assets.js'
import QuestionRunner from '@/components/question/QuestionRunner.vue'
import { bankStore, loadBanks, resolveBankFilter, persistBankFilter } from '@/stores/bank.js'
import { settings } from '@/stores/settings.js'
import { cardFromRow, toRow, toLog, answer as fsrsAnswer } from '@/utils/fsrs.js'
import { gradeQuestion } from '@/utils/gradeQuestion.js'
import { ui, toast } from '@/stores/ui.js'
import { itemKeyOf, parentIdsOf, save as saveSession, scheduleSave, flush as flushSession, clear as clearSession, clampSnapshot } from '@/stores/session.js'
import { promptResume, discardSession } from '@/composables/sessionResume.js'
import { QUESTION_TYPE_KEYS, TYPE_FULL_LABELS } from '@/constants/questions.js'

// 题型清单/文案统一来自 constants/questions.js（FE-ARCH-01）；组卷面板用完整名（单选题）
const ALL_TYPES = QUESTION_TYPE_KEYS
const COUNT_OPTIONS = [
  { value: 5, label: '5 题' },
  { value: 10, label: '10 题' },
  { value: 20, label: '20 题' },
  { value: 0, label: '全部' }
]

const phase = ref('setup') // setup | card | done
const route = useRoute()
const router = useRouter()
const error = ref('')
const recordError = ref('')
const fetching = ref(false)

const selectedTypes = ref([...ALL_TYPES])
const count = ref(5)
const bankId = ref('')

// 模式：practice 作答判分（计入复习）；recite 背题（直接看答案/解析，不判分不记录）
const MODE_KEY = 'qbank.practiceMode'
const mode = ref(localStorage.getItem(MODE_KEY) === 'recite' ? 'recite' : 'practice')
function setMode(m) {
  mode.value = m
  try { localStorage.setItem(MODE_KEY, m) } catch { /* 忽略持久化失败 */ }
}
const recite = computed(() => mode.value === 'recite')

const pool = ref([]) // 子题队列：普通题=1 项，material=每子题 1 项
const curIdx = ref(0)
const cur = computed(() => pool.value[curIdx.value])
const graded = ref(false)
const gradeResult = ref(null)
const startedAt = ref(0)
const materialOpen = ref(true)

// 焦点锚点：切题/判分后把焦点送进作答区，Tab 不再掉回导航栏
const cardRef = ref(null)
const nextBtnRef = ref(null)
function focusCard() {
  nextTick(() => {
    if (cardRef.value && cardRef.value.focus) cardRef.value.focus({ preventScroll: true })
  })
}
function focusNextBtn() {
  nextTick(() => {
    if (nextBtnRef.value && nextBtnRef.value.focus) nextBtnRef.value.focus({ preventScroll: true })
  })
}

// 答对自动下一题（设置 autoNextOnCorrect 开启时，时长取 autoNextDelayMs）
// 计时（setTimeout）与进度条（CSS 动画）分离：条只负责展示，取消/翻页只停计时器
let autoNextTimer = null
const autoNextPending = ref(false)
const autoNextMs = ref(0)
function cancelAutoNext() {
  if (autoNextTimer) {
    clearTimeout(autoNextTimer)
    autoNextTimer = null
  }
  autoNextPending.value = false
}
onBeforeUnmount(cancelAutoNext)
const singlePick = ref('')
const multiPick = ref([])
const fillValues = reactive({})
const shortText = ref('')
const showRef = ref(false)
const selfGrade = ref('')

// 轮次统计
const rounds = ref([])
const round = ref({ total: 0, correct: 0, wrong: [], ms: 0 })

const isChoice = computed(() => cur.value && ['single', 'judge'].includes(cur.value.q.type))
const isChoiceLike = computed(() => cur.value && ['single', 'multi', 'judge'].includes(cur.value.q.type))
const isShort = computed(() => cur.value && cur.value.q.type === 'short')
const isLast = computed(() => curIdx.value === pool.value.length - 1)

const curBadge = computed(() => {
  const it = cur.value
  if (!it) return ''
  if (it.isChild) return `材料题 · 第 ${it.childIdx + 1}/${it.childCount} 问`
  return TYPE_FULL_LABELS[it.q.type] || it.q.type
})

const progressPct = computed(() => {
  const total = pool.value.length || 1
  const done = curIdx.value + (recite.value || graded.value ? 1 : 0)
  return Math.min(100, Math.round((done / total) * 100))
})

const canSubmit = computed(() => {
  const q = cur.value?.q
  if (!q) return false
  if (q.type === 'single' || q.type === 'judge') return !!singlePick.value
  if (q.type === 'multi') return multiPick.value.length > 0
  if (q.type === 'fill') return Object.keys(fillValues).some((k) => (fillValues[k] || '').trim())
  return true
})

const lastRound = computed(() => rounds.value[rounds.value.length - 1] || { total: 0, correct: 0, wrong: [], ms: 0, rate: 0 })
const sessionStats = computed(() => {
  let total = 0, correct = 0, ms = 0
  for (const r of rounds.value) { total += r.total; correct += r.correct; ms += r.ms }
  return { total, correct, ms }
})

function blankAnswersOf(id) {
  const blanks = cur.value?.q?.answer?.blanks || []
  const b = blanks.find((x) => x.id === id)
  return Array.isArray(b?.answers) ? b.answers.join(' / ') : ''
}
// 卡片级键盘流（状态机互斥，同一键不在两套状态同时有效）：
// 未判分：简答看答案后 1/2 自评、Enter 提交；判分后：Enter 下一题；Esc 取消自动下一题。
// A–F 选题 / M 切材料 / 填空跳空在 QuestionRunner 内处理；输入区/组词中/弹窗/带修饰键一律不劫持。
function onCardKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if (ui.dialog) return
  if (phase.value !== 'card') return
  const t = e.target
  const inField = !!(t && t.closest && t.closest('textarea, select, input, [contenteditable], .tiptap, .ProseMirror'))
  if (e.key === 'Escape') {
    if (autoNextPending) {
      e.preventDefault()
      cancelAutoNext()
    }
    return
  }
  // 背题模式：←/→ 或 Enter 翻题，其余键不劫持
  if (recite.value) {
    if (e.key === 'Enter' || e.key === 'ArrowRight') {
      e.preventDefault()
      next()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      prev()
    }
    return
  }
  if (e.key === 'Enter') {
    if (inField) return
    if (graded.value) {
      e.preventDefault()
      next()
      return
    }
    if (t && t.closest && t.closest('button.option-btn')) {
      // 选项按钮上回车：阻止原生切换，只提交（选择用空格/字母键/鼠标）
      e.preventDefault()
      if (!canSubmit.value) return
      submit()
      return
    }
    if (!canSubmit.value) return
    e.preventDefault()
    submit()
    return
  }
  if (inField || graded.value) return
  const k = typeof e.key === 'string' ? e.key.toUpperCase() : ''
  // A–F 选题、M 切材料已由 QuestionRunner 处理；这里只保留模式语义键
  if ((k === '1' || k === '2') && isShort.value && showRef.value) {
    shortSubmit(k === '1' ? '不会' : '会')
  }
}
function resetAnswer() {
  cancelAutoNext()
  singlePick.value = ''
  multiPick.value = []
  for (const k in fillValues) delete fillValues[k]
  shortText.value = ''
  showRef.value = false
  selfGrade.value = ''
  materialOpen.value = true
  graded.value = false
  gradeResult.value = null
  recordError.value = ''
}

function dedupeShuffle(list) {
  const seen = new Set()
  const out = []
  for (const q of list || []) {
    if (!q || !q.id || seen.has(q.id)) continue
    seen.add(q.id)
    out.push(q)
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function buildItems(questions) {
  const items = []
  for (const q of questions || []) {
    if (q.type === 'material' && Array.isArray(q.children) && q.children.length) {
      q.children.forEach((child, i) => {
        items.push({ q: child, parent: q, isChild: true, childIdx: i, childCount: q.children.length })
      })
    } else {
      items.push({ q, parent: null, isChild: false, childIdx: -1, childCount: 0 })
    }
  }
  return items.map((it, idx) => ({ ...it, uid: `${it.q.id}_${idx}` }))
}

// ── 会话快照（FE-ARCH-05）：只存题目 id 与作答状态，离开后可继续 ──
const SNAP_MODE = 'practice'
const answers = reactive({}) // key → { selected, picked, fillValues, shortText, selfGrade, showRef, graded }
function currentAnswerKey() {
  return itemKeyOf(cur.value)
}
function readAnswerRefs() {
  return {
    selected: singlePick.value,
    picked: [...multiPick.value],
    fillValues: { ...fillValues },
    shortText: shortText.value,
    selfGrade: selfGrade.value,
    showRef: showRef.value,
    graded: graded.value
  }
}
function rememberAnswer() {
  const k = currentAnswerKey()
  if (k) answers[k] = readAnswerRefs()
}
function restoreCachedAnswer() {
  const k = currentAnswerKey()
  const a = k ? answers[k] : null
  if (!a) return
  singlePick.value = a.selected || ''
  multiPick.value = Array.isArray(a.picked) ? [...a.picked] : []
  for (const key in fillValues) delete fillValues[key]
  Object.assign(fillValues, a.fillValues || {})
  shortText.value = a.shortText || ''
  selfGrade.value = a.selfGrade || ''
  showRef.value = !!a.showRef
  if (a.graded) {
    graded.value = true
    gradeResult.value = gradeItem(cur.value)
  }
}
function snapshotNow() {
  const out = { ...answers }
  const k = currentAnswerKey()
  if (k && phase.value === 'card') out[k] = readAnswerRefs()
  return {
    mode: SNAP_MODE,
    bankId: bankId.value,
    keys: pool.value.map(itemKeyOf),
    curIdx: curIdx.value,
    answers: out,
    round: { total: round.value.total, correct: round.value.correct, wrongKeys: round.value.wrong.map(itemKeyOf), ms: round.value.ms },
    rounds: rounds.value.map((r) => ({ total: r.total, correct: r.correct, wrongKeys: (r.wrong || []).map(itemKeyOf), ms: r.ms, rate: r.rate || 0 })),
    startedAt: startedAt.value,
    extra: { practiceMode: mode.value, selectedTypes: [...selectedTypes.value], count: count.value }
  }
}
function persistSession() {
  if (phase.value !== 'card') return
  scheduleSave(SNAP_MODE, snapshotNow())
}
watch([curIdx, phase, singlePick, multiPick, fillValues, shortText, selfGrade, showRef, graded], persistSession, { deep: true })
onBeforeUnmount(() => {
  if (phase.value !== 'card') return
  rememberAnswer()
  flushSession(SNAP_MODE)
  saveSession(SNAP_MODE, snapshotNow()) // 防抖窗口内的最后一次输入也要留下
})
function resetSessionState() {
  for (const k of Object.keys(answers)) delete answers[k]
  clearSession(SNAP_MODE)
}

// 恢复上次进度：按 id 重拉题目 → 跳过被删的题 → 对齐位置与已填作答
async function resumeSession(snap) {
  fetching.value = true
  try {
    const questions = await practicePool({ ids: parentIdsOf(snap.keys) })
    const items = buildItems(await expandQuestions(questions))
    const byKey = new Map(items.map((it) => [itemKeyOf(it), it]))
    const { snapshot, missing } = clampSnapshot(snap, snap.keys.filter((k) => byKey.has(k)))
    if (!snapshot) {
      discardSession(SNAP_MODE, '上次的题目已被删除，无法继续')
      return
    }
    pool.value = snapshot.keys.map((k) => byKey.get(k))
    for (const k of Object.keys(answers)) delete answers[k]
    Object.assign(answers, snapshot.answers)
    rounds.value = snapshot.rounds.map((r) => ({
      total: r.total,
      correct: r.correct,
      wrong: r.wrongKeys.map((k) => byKey.get(k)).filter(Boolean),
      ms: r.ms,
      rate: r.rate
    }))
    round.value = {
      total: snapshot.round.total || pool.value.length,
      correct: snapshot.round.correct,
      wrong: snapshot.round.wrongKeys.map((k) => byKey.get(k)).filter(Boolean),
      ms: snapshot.round.ms
    }
    curIdx.value = snapshot.curIdx
    startedAt.value = snapshot.startedAt
    if (snapshot.bankId) bankId.value = snapshot.bankId
    if (snapshot.extra?.practiceMode === 'recite') setMode('recite')
    else if (snapshot.extra?.practiceMode === 'practice') setMode('practice')
    resetAnswer()
    restoreCachedAnswer()
    phase.value = 'card'
    if (missing.length) toast(`有 ${missing.length} 项已被删除，已跳过`, 'info')
    focusCard()
  } catch (e) {
    console.error(e)
    discardSession(SNAP_MODE, '上次进度恢复失败，已重新开始')
  } finally {
    fetching.value = false
  }
}

async function start() {
  const types = selectedTypes.value
  if (!types.length) { error.value = '请至少选择一种题型'; return }
  if (fetching.value) return
  error.value = ''
  fetching.value = true
  try {
    let limit = count.value
    if (limit === 0) {
      // “全部”：用 stats 的 by_type 汇总得出精确上限
      const s = await fetchStats().catch(() => null)
      if (s && s.by_type && Object.keys(s.by_type).length) {
        limit = types.reduce((sum, t) => sum + (Number(s.by_type[t]) || 0), 0)
      } else if (s && typeof s.total === 'number') {
        limit = s.total
      } else {
        limit = 10000
      }
      limit = Math.max(limit, 1)
    }
    let questions
    if (types.length === ALL_TYPES.length) {
      questions = await practicePool({ limit, type: '', bankId: bankId.value })
    } else {
      const per = Math.ceil(limit / types.length)
      const merged = []
      for (const t of types) {
        const part = await practicePool({ limit: per, type: t, bankId: bankId.value })
        merged.push(...(part || []))
      }
      questions = dedupeShuffle(merged)
    }
    pool.value = buildItems(await expandQuestions(questions))
    if (!pool.value.length) {
      fetching.value = false
      error.value = '题库中没有符合条件的试题，请先到“新增试题”添加题目。'
      return
    }
    resetSessionState()
    curIdx.value = 0
    round.value = { total: pool.value.length, correct: 0, wrong: [], ms: 0 }
    resetAnswer()
    startedAt.value = Date.now()
    phase.value = 'card'
    focusCard()
  } catch (e) {
    console.error(e)
    error.value = '抽题失败：' + (e?.message || e)
  } finally {
    fetching.value = false
  }
}

function gradeItem(it) {
  const q = it.q
  // 未作答/缺答案的前置提示保持原顺序与文案（判分口径统一走 gradeQuestion）
  if (q.type === 'single' || q.type === 'judge') {
    if (!singlePick.value) return { valid: false, message: '请先选择一个选项' }
  } else if (q.type === 'multi') {
    if (!multiPick.value.length) return { valid: false, message: '请至少选择一个选项' }
  } else if (q.type === 'fill') {
    if (!(q.answer?.blanks || []).length) return { valid: false, message: '题目缺少答案（blank）' }
  } else if (q.type === 'short') {
    if (!showRef.value) return { valid: false, message: '请先查看参考答案' }
    if (!selfGrade.value) return { valid: false, message: '请自评：不会 / 会' }
  } else {
    return { valid: false, message: '暂不支持的题型：' + (q.type || '未知') }
  }
  const res = gradeQuestion(q, {
    selected: singlePick.value,
    picked: [...multiPick.value],
    fillValues: { ...fillValues },
    shortSelf: selfGrade.value,
    shortText: shortText.value
  }, { mode: 'practice' })
  const out = { valid: true, correct: !!res.correct }
  if (res.detail?.selected) out.selected = res.detail.selected
  if (res.detail?.blanks) out.results = res.detail.blanks
  if (res.detail?.self_grade) out.self = res.detail.self_grade
  return out
}

function buildDetail(it, res) {
  const detail = { type: it.q.type, correct: !!res.correct }
  if (it.isChild) {
    detail.child_id = it.q.id
    detail.child_index = it.childIdx + 1
    detail.parent_id = it.parent.id
  }
  if (res.selected) detail.selected = res.selected
  if (res.results) detail.blanks = res.results.map((r) => ({ id: r.id, value: r.value, correct: r.correct }))
  if (res.self) detail.self_grade = res.self
  // 简答作答原文（复习模式本就有 my_answer；刷题模式补上，供错题本查看）
  if (it.q.type === 'short' && shortText.value) detail.my_answer = shortText.value
  return detail
}

function commit(it, grade, elapsed, res) {
  graded.value = true
  gradeResult.value = res
  rememberAnswer()
  focusNextBtn()
  round.value.correct += res.correct ? 1 : 0
  round.value.ms += elapsed
  if (!res.correct) round.value.wrong.push(it)
  // FSRS：练习正确→Good / 错误→Again；“仅错题”入库时答对只写流水不建卡
  let card = null
  let fsrsLog = null
  if (!(settings.fsrs.practiceScope === 'wrong-only' && grade === 'good')) {
    try {
      const fsrsRow = it.parent ? it.parent.fsrs : it.q.fsrs
      const out = fsrsAnswer(cardFromRow(fsrsRow), grade, settings.fsrs)
      card = toRow(out.card, grade)
      fsrsLog = toLog(out.log)
    } catch (e) {
      console.error('fsrs answer failed', e)
      recordError.value = '调度计算失败：' + (e?.message || e)
    }
  }
  recordAnswer([{
    question_id: it.isChild ? it.parent.id : it.q.id,
    mode: 'practice',
    grade,
    elapsed_ms: elapsed,
    detail: buildDetail(it, res),
    card,
    fsrs_log: fsrsLog
  }]).catch((e) => {
    console.error('record_answer failed', e)
    recordError.value = (e?.message || e)
  })
  // 答对自动下一题：短暂停留展示结果（答错停留看解析；手动点下一题/点结果条会取消）
  if (res.correct && settings.autoNextOnCorrect) {
    autoNextMs.value = settings.autoNextDelayMs
    autoNextPending.value = true
    autoNextTimer = setTimeout(() => {
      autoNextPending.value = false
      autoNextTimer = null
      next()
    }, autoNextMs.value)
  }
}

function submit() {
  if (graded.value) return
  const it = cur.value
  if (!it) return
  const res = gradeItem(it)
  if (!res.valid) { error.value = res.message; return }
  error.value = ''
  commit(it, res.correct ? 'good' : 'again', Date.now() - startedAt.value, res)
}

function shortSubmit(grade) {
  if (graded.value) return
  const it = cur.value
  if (!it) return
  if (!showRef.value) { error.value = '请先查看参考答案'; return }
  selfGrade.value = grade
  const res = gradeItem(it)
  if (!res.valid) { error.value = res.message; return }
  error.value = ''
  commit(it, res.correct ? 'good' : 'again', Date.now() - startedAt.value, res)
}

function next() {
  cancelAutoNext()
  rememberAnswer()
  // 背题模式无 commit 计时：切题时把本页停留累进 round.ms（练习模式已在 commit 里记，此处不加防 double count）
  if (recite.value) round.value.ms += Date.now() - startedAt.value
  if (curIdx.value < pool.value.length - 1) {
    curIdx.value++
    resetAnswer()
    restoreCachedAnswer()
    startedAt.value = Date.now()
    focusCard()
  } else {
    rounds.value.push({ ...round.value, rate: round.value.total ? Math.round((round.value.correct / round.value.total) * 100) : 0 })
    phase.value = 'done'
    resetSessionState() // 本轮已收口，不再"继续上次"
  }
}

function prev() {
  if (curIdx.value > 0) {
    rememberAnswer()
    if (recite.value) round.value.ms += Date.now() - startedAt.value
    curIdx.value--
    resetAnswer()
    restoreCachedAnswer()
    startedAt.value = Date.now()
    focusCard()
  }
}

function startRedo() {
  const last = rounds.value[rounds.value.length - 1]
  if (!last || !last.wrong.length) return
  mode.value = 'practice' // 错题重做是作答判分，强制回练习模式
  resetSessionState()
  pool.value = last.wrong
  curIdx.value = 0
  round.value = { total: pool.value.length, correct: 0, wrong: [], ms: 0 }
  resetAnswer()
  startedAt.value = Date.now()
  phase.value = 'card'
  focusCard()
}

// 错题本重练：按指定 id 组卷，跳过 setup 直达作答
async function startFromIds(ids) {
  if (fetching.value) return
  mode.value = 'practice' // 错题重练是作答判分，强制回练习模式
  error.value = ''
  fetching.value = true
  try {
    const questions = await practicePool({ ids })
    pool.value = buildItems(await expandQuestions(questions))
    if (!pool.value.length) {
      error.value = '重练题目已不存在（可能被删除），请从错题本重新发起。'
      return
    }
    resetSessionState()
    curIdx.value = 0
    round.value = { total: pool.value.length, correct: 0, wrong: [], ms: 0 }
    resetAnswer()
    startedAt.value = Date.now()
    phase.value = 'card'
    focusCard()
  } catch (e) {
    console.error(e)
    error.value = '抽题失败：' + (e?.message || e)
  } finally {
    fetching.value = false
  }
}

onMounted(async () => {
  if (!bankStore.loaded) {
    try {
      await loadBanks()
    } catch (e) {
      console.error(e)
    }
  }
  bankId.value = resolveBankFilter('practice')
  if (route.query.retry) {
    let ids = []
    try {
      const raw = sessionStorage.getItem('qbank.retryIds')
      if (raw) ids = JSON.parse(raw)
    } catch {
      ids = []
    }
    sessionStorage.removeItem('qbank.retryIds')
    router.replace('/practice')
    if (Array.isArray(ids) && ids.filter(Boolean).length) {
      startFromIds(ids.filter(Boolean))
    } else {
      error.value = '没有收到重练题目，请从错题本重新发起。'
    }
    return
  }
  const snap = await promptResume(SNAP_MODE, { title: '继续上次刷题？' })
  if (snap) await resumeSession(snap)
})

function fmtMs(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}时${m}分${sec}秒`
  if (m) return `${m}分${sec}秒`
  return `${sec}秒`
}
</script>

<style scoped>
/* 自动下一题倒计时条：长在结果条底部，只负责展示，计时由 JS 定时器驱动 */
.auto-next-track {
  position: absolute; left: 0; right: 0; bottom: 0; height: 3px;
  background: rgba(47, 125, 79, 0.18);
}
.auto-next-fill {
  display: block; height: 100%; width: 100%;
  background: var(--success);
  animation: auto-next-shrink linear forwards;
}
@keyframes auto-next-shrink { from { width: 100%; } to { width: 0%; } }
</style>
