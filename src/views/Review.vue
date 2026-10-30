<template>
  <div class="page">
    <div v-if="error" class="error-box">{{ error }}</div>

    <!-- 等待复习（due） -->
    <section v-if="phase === 'due'" class="card max-w-[640px]">
      <div class="card-head">
        <h2 class="section-title flex items-center gap-2"><i class="i-lucide-repeat text-primary" />间隔复习</h2>
        <span class="badge badge-type">FSRS</span>
      </div>
      <p class="text-text-secondary text-[14px] leading-[1.8] m-0 mb-4.5">
        {{ bankName ? `「${bankName}」` : '全部题库' }}当前待复习 <b class="text-primary text-[18px]">{{ dueTotal }}</b> 题，今日到期 <b class="text-primary text-[18px]">{{ dueToday }}</b> 题<span v-if="learningDue > 0">（其中学习中 <b class="text-primary text-[18px]">{{ learningDue }}</b> 题）</span>。
        按记忆状态安排。
      </p>

      <div class="mb-4.5">
        <div class="field-label">题库</div>
        <select v-model="bankId" class="select w-full max-w-[320px]" @change="onBankChange">
          <option value="">全部题库</option>
          <option v-for="b in bankStore.banks" :key="b.id" :value="b.id">{{ b.name }}</option>
        </select>
      </div>

      <div class="mb-4.5">
        <div class="field-label">题量</div>
        <div class="inline-flex items-stretch border border-line rounded-[8px] overflow-hidden shadow-sm bg-card transition-colors focus-within:border-primary">
          <input
            v-model="countText"
            class="w-[64px] px-2 py-2 text-[14px] text-center text-text bg-transparent outline-none border-0"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            title="每次复习题数（1～500）"
            @change="commitCount"
            @blur="commitCount"
            @keyup.enter="commitCount"
            @keyup.esc="countText = String(lastCount)"
          />
          <span class="w-px bg-line my-1" aria-hidden="true" />
          <button
            type="button"
            class="px-4 text-[14px] font-500 cursor-pointer transition-colors text-text-secondary hover:bg-bg-accent"
            title="填入今日到期题数"
            @click="fillAll"
          >
            全部
          </button>
        </div>
      </div>

      <div>
        <button
          type="button"
          class="btn btn-primary btn-big"
          :disabled="dueLoading || noDue"
          @click="start"
        >
          <i class="i-lucide-play" />{{ dueLoading ? '正在拉取复习题目…' : '开始复习' }}
        </button>
        <div v-if="noDue" class="mt-3 p-3 bg-bg-accent border border-line rounded-[12px] flex items-center justify-between gap-3 flex-wrap">
          <span class="text-[13px] text-text-secondary">
            <i class="i-lucide-info text-primary mr-1" />当前没有待复习的题，可用题量 0。
          </span>
          <div class="flex gap-2">
            <button type="button" class="btn" @click="router.push('/practice')"><i class="i-lucide-zap" />去刷题</button>
            <button type="button" class="btn" @click="router.push('/create')"><i class="i-lucide-plus" />去录题</button>
          </div>
        </div>
        <div class="text-[12px] text-muted-light mt-2.5 flex items-center gap-1.5">
          <i class="i-lucide-keyboard" />键盘：A–F 选题，Enter 判分，判分后 1–4 自评
        </div>
      </div>
    </section>

    <section v-else-if="phase === 'loading'" class="card flex items-center gap-3">
      <span class="badge badge-type">复习</span>
      <div class="text-muted flex items-center gap-2"><i class="i-lucide-loader-circle animate-spin" />正在准备复习题目…</div>
    </section>

    <!-- 作答卡片 -->
    <section v-else-if="phase === 'card'" ref="cardRef" tabindex="-1" class="card flex flex-col gap-3.5" @keydown="onCardKeydown">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <span class="badge badge-type">{{ curBadge }}</span>
          <span v-if="curFsrsState === 1 || curFsrsState === 3" class="badge shrink-0"><i class="i-lucide-book-open" />学习中</span>
        </div>
        <span class="text-[13px] text-muted font-500 shrink-0">
          第 {{ curIdx + 1 }} / {{ pool.length }} 题
          <span class="ml-1.5 text-muted-light">· 已复习 {{ reviewedCount }} / 剩 {{ retainCount }}</span>
        </span>
      </div>
      <div class="progress-track"><div class="progress-inner" :style="{ width: progressPct + '%' }"></div></div>


      <QuestionRunner
        :item="cur"
        mode="review"
        :selected="singlePick"
        :picked="multiPick"
        :fill-values="fillValues"
        :short-text="shortText"
        :show-ref="showRef"
        :material-open="materialOpen"
        :locked="graded"
        interactive-hint="A–F 选择，回车判分"
        @update:selected="singlePick = $event"
        @update:picked="multiPick = $event"
        @update:short-text="shortText = $event"
        @update:show-ref="showRef = $event"
        @update:material-open="materialOpen = $event"
        @fill-enter="submit"
      >
        <template #default="{ analysisHtml, answerHtml }">
          <div v-if="!graded && !isShort">
            <button type="button" class="btn btn-primary btn-big" :disabled="!canSubmit" @click="submit">
              <i class="i-lucide-check-circle" />判分
            </button>
          </div>

          <div v-if="graded" ref="resultRef" tabindex="-1" class="border-t border-line pt-4 flex flex-col gap-3">
            <div class="flex items-center gap-2 text-[16px] font-700 px-3.5 py-3 rounded-[8px]" :class="gradeResult.correct ? 'text-success bg-success-bg border border-[#bcd9c4]' : 'text-danger bg-danger-bg border border-[#e3c9c5]'">
              <i :class="gradeResult.correct ? 'i-lucide-circle-check' : 'i-lucide-circle-x'" />{{ gradeResult.correct ? '回答正确' : '回答错误' }}
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
          </div>

          <div v-if="recordError" class="text-[12px] text-danger flex items-center gap-1"><i class="i-lucide-triangle-alert" />记录失败：{{ recordError }}</div>

          <div v-if="canSelfGrade" class="flex items-center gap-2 flex-wrap border-t border-line pt-3.5">
            <span class="text-[13px] text-muted font-600">自评记忆效果：<span class="font-400 text-muted-light">（键盘 1–4）</span></span>
            <button type="button" class="btn btn-danger" :disabled="submitting" title="下次复习：{{ previewLabel('again') }}" @click="reviewGrade('again')"><i class="i-lucide-rotate-ccw" />忘记<span v-if="previewLabel('again')" class="ml-1.5 text-[11px] font-400 opacity-75">{{ previewLabel('again') }}</span></button>
            <button type="button" class="btn border-[#d9c4a3] text-[#a06a2a] bg-[#f0e6d6] hover:bg-[#f0e6d6] hover:border-[#c4a87f]" :disabled="submitting" title="下次复习：{{ previewLabel('hard') }}" @click="reviewGrade('hard')"><i class="i-lucide-frown" />困难<span v-if="previewLabel('hard')" class="ml-1.5 text-[11px] font-400 opacity-75">{{ previewLabel('hard') }}</span></button>
            <button type="button" class="btn border-[#bcd9c4] text-success bg-success-bg hover:bg-success-bg hover:border-[#9bc4ad]" :disabled="submitting" title="下次复习：{{ previewLabel('good') }}" @click="reviewGrade('good')"><i class="i-lucide-meh" />良好<span v-if="previewLabel('good')" class="ml-1.5 text-[11px] font-400 opacity-75">{{ previewLabel('good') }}</span></button>
            <button type="button" class="btn btn-primary-link" :disabled="submitting" title="下次复习：{{ previewLabel('easy') }}" @click="reviewGrade('easy')"><i class="i-lucide-smile" />简单<span v-if="previewLabel('easy')" class="ml-1.5 text-[11px] font-400 opacity-75">{{ previewLabel('easy') }}</span></button>
          </div>

          <!-- 撤销：评分后 5 秒内可回退（与 toast 同时出现，两者共用 lastRevert） -->
          <div v-if="lastRevert" class="flex items-center gap-2 flex-wrap text-[13px] text-text-secondary">
            <i class="i-lucide-undo-2 text-primary" />
            <span>已记为{{ GRADE_TEXT[lastRevert.grade] }}</span>
            <button type="button" class="btn" @click="undoLastGrade"><i class="i-lucide-rotate-ccw" />撤销<span class="ml-1 text-[11px] text-muted">{{ Math.round(REVERT_WINDOW_MS / 1000) }}s</span></button>
          </div>
        </template>
      </QuestionRunner>
    </section>

    <!-- 结束页 -->
    <section v-else-if="phase === 'done'" class="card flex flex-col gap-5 items-center text-center">
      <div class="text-[22px] font-800 tracking-[-0.01em] font-[var(--serif)] flex items-center gap-2">
        <i class="i-lucide-circle-check text-success text-[26px]" />本轮复习完成
      </div>
      <div class="flex gap-3.5 flex-wrap justify-center">
        <div class="min-w-[120px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-text">{{ reviewedCount }}</div>
          <div class="text-[12px] text-muted mt-1">复习题数</div>
        </div>
        <div class="min-w-[120px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-text">{{ fmtMs(roundMs) }}</div>
          <div class="text-[12px] text-muted mt-1">用时</div>
        </div>
        <div class="min-w-[120px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-danger">{{ gradesCount.again }}</div>
          <div class="text-[12px] text-muted mt-1">忘记</div>
        </div>
        <div class="min-w-[120px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-text">{{ gradesCount.hard }}</div>
          <div class="text-[12px] text-muted mt-1">困难</div>
        </div>
        <div class="min-w-[120px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-success">{{ gradesCount.good }}</div>
          <div class="text-[12px] text-muted mt-1">良好</div>
        </div>
        <div class="min-w-[120px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-success">{{ gradesCount.easy }}</div>
          <div class="text-[12px] text-muted mt-1">简单</div>
        </div>
      </div>

      <div class="text-[13px] text-muted">
        {{ reviewedCount }} 题中 {{ gradesCount.good + gradesCount.easy }} 题自评良好及以上
        · 剩余待复习 {{ remainingDue == null ? '—' : remainingDue }} 题
      </div>

      <div class="flex gap-3 flex-wrap justify-center">
        <button v-if="remainingDue > 0" type="button" class="btn btn-primary btn-big" @click="backToDue">
          <i class="i-lucide-repeat" />再复习一轮
        </button>
        <router-link to="/" class="btn btn-big"><i class="i-lucide-home" />返回首页</router-link>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { reviewDue, practicePool, recordAnswer, reviewRevert, stats as fetchStats } from '@/api/practice.js'
import { expandQuestions } from '@/api/assets.js'
import QuestionRunner from '@/components/question/QuestionRunner.vue'
import { cardFromRow, toRow, toLog, answer as fsrsAnswer } from '@/utils/fsrs.js'
import { gradeQuestion } from '@/utils/gradeQuestion.js'
import { bankStore, loadBanks, resolveBankFilter, persistBankFilter } from '@/stores/bank.js'
import { settings } from '@/stores/settings.js'
import { ui, toast } from '@/stores/ui.js'
import { itemKeyOf, parentIdsOf, save as saveSession, scheduleSave, flush as flushSession, clear as clearSession, clampSnapshot } from '@/stores/session.js'
import { promptResume, discardSession } from '@/composables/sessionResume.js'
import { useSessionLeaveNotice } from '@/composables/sessionLeaveNotice.js'
import { typeLabel } from '@/constants/questions.js'
import { previewIntervals, revertPayloadOf, REVERT_WINDOW_MS } from '@/utils/reviewPreview.js'
import { randomUUID } from '@/utils/device.js'
import { loadRunConfig, saveRunConfig, MAX_PER_ROUND } from '@/stores/runConfig.js'

const phase = ref('due') // due | loading | card | done
const bankId = ref('')
// 题量：输入框（默认 20，钳制 1–500）；“全部”按钮把今日到期数回填进输入框
// FE-P0-05：题量记忆——刷新后保持上次选择（localStorage，键统一在 stores/runConfig.js）
const countText = ref('20')
const lastCount = ref(20)
// 初值从记忆里取（脏数据已由 normalizeConfig 归一，不会把输入框打空）
{
  const init = loadRunConfig('review')
  const n = Math.min(Math.max(Number(init?.count) || 20, 1), MAX_PER_ROUND)
  lastCount.value = n
  countText.value = String(n)
}
function fillAll() {
  const n = Math.min(Math.max(dueToday.value || 0, 1), MAX_PER_ROUND)
  lastCount.value = n
  countText.value = String(n)
}
function commitCount() {
  const v = Number(String(countText.value).trim())
  if (Number.isFinite(v) && Number.isInteger(v) && v >= 1 && v <= MAX_PER_ROUND) {
    lastCount.value = v
    countText.value = String(v)
    saveRunConfig('review', { count: v })
  } else {
    countText.value = String(lastCount.value)
    error.value = `题量请输入 1～${MAX_PER_ROUND} 的整数`
  }
}
const reviewLimit = computed(() => lastCount.value)
const router = useRouter()
const bankName = computed(() => bankStore.banks.find((b) => b.id === bankId.value)?.name || '')
const error = ref('')
const recordError = ref('')
const dueLoading = ref(false)
const dueTotal = ref(0)
const dueToday = ref(0)
const learningDue = ref(0)
const remainingDue = ref(null)
// FE-P0-05：待复习 0 题时禁用开始（不让人点下去才报错）
const noDue = computed(() => !dueLoading.value && dueTotal.value === 0)
// FE-P0-06：本轮剩余未评分数（已复习 = 已评分的项）
const retainCount = computed(() => Math.max(0, pool.value.length - reviewedCount.value))

const pool = ref([])
const curIdx = ref(0)
const cur = computed(() => pool.value[curIdx.value])
const graded = ref(false)
const gradeResult = ref(null)
const startedAt = ref(0)
const materialOpen = ref(true)
const submitting = ref(false)

// 焦点锚点：切题/判分后把焦点送进作答区，Tab 不再掉回导航栏
const cardRef = ref(null)
const resultRef = ref(null)
function focusCard() {
  nextTick(() => {
    if (cardRef.value && cardRef.value.focus) cardRef.value.focus({ preventScroll: true })
  })
}
function focusResult() {
  nextTick(() => {
    if (resultRef.value && resultRef.value.focus) resultRef.value.focus({ preventScroll: true })
  })
}

// 作答状态
const singlePick = ref('')
const multiPick = ref([])
const fillValues = reactive({})
const shortText = ref('')
const showRef = ref(false)

// 本轮汇总
const reviewedCount = ref(0)
const roundMs = ref(0)
const gradesCount = reactive({ again: 0, hard: 0, good: 0, easy: 0 })

const isChoice = computed(() => cur.value && ['single', 'judge'].includes(cur.value.q.type))
const isShort = computed(() => cur.value && cur.value.q.type === 'short')
const canSelfGrade = computed(() => !!cur.value && (graded.value || (isShort.value && showRef.value)))

// 当前题 FSRS 状态（子题看父题行；用于“学习中”徽标）
const curFsrsRow = computed(() => {
  const it = cur.value
  if (!it) return null
  return it.parent ? it.parent.fsrs : it.q.fsrs
})
const curFsrsState = computed(() => curFsrsRow.value?.state ?? null)

// FE-P0-06：四键下次间隔预览（只计算、不写库；每换一题重算）
// 依赖 curFsrsRow：同一张卡不会变，所以按题切题才需要重算
const intervalPreview = computed(() => previewIntervals(curFsrsRow.value, settings.fsrs))
const previewLabel = (g) => intervalPreview.value?.[g]?.label || ''

// 撤销窗口：记录上一条评分的撤销载荷，5 秒内可回退
// lastRevert = { recordId, questionId, card, grade }；用完置 null
const lastRevert = ref(null)
let revertTimer = null
function clearRevert() {
  if (revertTimer) { clearTimeout(revertTimer); revertTimer = null }
  lastRevert.value = null
}
function armRevert(payload) {
  clearRevert()
  lastRevert.value = payload
  revertTimer = setTimeout(clearRevert, REVERT_WINDOW_MS)
}
const GRADE_TEXT = { again: '忘记', hard: '困难', good: '良好', easy: '简单' }
async function undoLastGrade() {
  const p = lastRevert.value
  if (!p) return
  clearRevert()
  try {
    await reviewRevert([{ record_id: p.recordId, question_id: p.questionId, card: p.card }])
    // 回到刚才那题，把计数退回，让用户重新评
    gradesCount[p.grade] = Math.max(0, gradesCount[p.grade] - 1)
    reviewedCount.value = Math.max(0, reviewedCount.value - 1)
    curIdx.value = p.idx
    resetAnswer()
    restoreCachedAnswer()
    // 下次重新评分要用新 UUID（旧流水已被删除，复用会造成语义混乱）
    forgetRecordId(cur.value)
    graded.value = true // 保留刚看的判分结果
    if (p.gradeResult) gradeResult.value = p.gradeResult
    toast('已撤销，可重新评分', 'success')
    focusCard()
  } catch (e) {
    console.error('review_revert failed', e)
    toast('撤销失败：' + (e?.message || e), 'error', 5000)
  }
}

const curBadge = computed(() => {
  const it = cur.value
  if (!it) return ''
  if (it.isChild) return `材料题 · 第 ${it.childIdx + 1}/${it.childCount} 问`
  return typeLabel(it.q.type, { full: true })
})

const progressPct = computed(() => {
  const total = pool.value.length || 1
  const done = curIdx.value + (graded.value ? 1 : 0)
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

function blankAnswersOf(id) {
  const blanks = cur.value?.q?.answer?.blanks || []
  const b = blanks.find((x) => x.id === id)
  return Array.isArray(b?.answers) ? b.answers.join(' / ') : ''
}
// 卡片级键盘流（状态机互斥，同一键不在两套状态同时有效）：
// 未判分：A–F 选择类选题（单选设值/多选切换）、M 切材料、Enter 判分；
// 判分后：1 忘记 / 2 困难 / 3 良好 / 4 简单（自评并自动下一题）；Enter 无动作。
// 输入区（文本域/输入框/下拉/编辑器）/组词中/弹窗开着/带修饰键，一律不劫持。
function onCardKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if (ui.dialog) return
  if (phase.value !== 'card') return
  const t = e.target
  const inField = !!(t && t.closest && t.closest('textarea, select, input, [contenteditable], .tiptap, .ProseMirror'))
  if (e.key === 'Enter') {
    if (inField) return
    if (graded.value) return // 复习判分后 Enter 无动作，坚持显式自评
    if (t && t.closest && t.closest('button.option-btn')) {
      // 选项按钮上回车：阻止原生切换，只判分（选择用空格/字母键/鼠标）
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
  if (inField) return
  const k = typeof e.key === 'string' ? e.key.toUpperCase() : ''
  // A–F 选题、M 切材料已由 QuestionRunner 处理；这里只保留 1–4 自评
  if (/^[1-4]$/.test(k) && canSelfGrade.value) {
    reviewGrade({ 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' }[k])
  }
}
function resetAnswer() {
  singlePick.value = ''
  multiPick.value = []
  for (const k in fillValues) delete fillValues[k]
  shortText.value = ''
  showRef.value = false
  materialOpen.value = true
  graded.value = false
  gradeResult.value = null
  recordError.value = ''
  submitting.value = false
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
const SNAP_MODE = 'review'
const answers = reactive({}) // key → { selected, picked, fillValues, shortText, showRef, graded }
function currentAnswerKey() {
  return itemKeyOf(cur.value)
}
function readAnswerRefs() {
  return {
    selected: singlePick.value,
    picked: [...multiPick.value],
    fillValues: { ...fillValues },
    shortText: shortText.value,
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
    // 复习没有“对/错”口径，只记已复习数与用时；各档次数放 extra
    round: { total: reviewedCount.value, correct: 0, wrongKeys: [], ms: roundMs.value },
    rounds: [],
    startedAt: startedAt.value,
    extra: { limit: reviewLimit.value, gradesCount: { ...gradesCount } }
  }
}
function persistSession() {
  if (phase.value !== 'card') return
  scheduleSave(SNAP_MODE, snapshotNow())
}

// FE-P0-04：离开时只提示「进度已保住」，不拦路
useSessionLeaveNotice(
  () => phase.value === 'card',
  '复习进度已保存，下次进来可以接着刷',
  { before: () => { rememberAnswer(); flushSession(SNAP_MODE); saveSession(SNAP_MODE, snapshotNow()) } }
)
watch(
  [curIdx, phase, singlePick, multiPick, fillValues, shortText, showRef, graded, reviewedCount, roundMs],
  persistSession,
  { deep: true }
)
onBeforeUnmount(() => {
  if (phase.value !== 'card') return
  rememberAnswer()
  flushSession(SNAP_MODE)
  saveSession(SNAP_MODE, snapshotNow())
})
function resetSessionState() {
  for (const k of Object.keys(answers)) delete answers[k]
  clearSession(SNAP_MODE)
}

async function resumeSession(snap) {
  dueLoading.value = true
  try {
    const questions = await practicePool({ ids: parentIdsOf(snap.keys) })
    const items = buildItems(await expandQuestions(questions))
    const byKey = new Map(items.map((it) => [itemKeyOf(it), it]))
    const { snapshot, missing } = clampSnapshot(snap, snap.keys.filter((k) => byKey.has(k)))
    if (!snapshot) {
      discardSession(SNAP_MODE, '上次的复习题已被删除，无法继续')
      await refreshDue()
      return
    }
    pool.value = snapshot.keys.map((k) => byKey.get(k))
    for (const k of Object.keys(answers)) delete answers[k]
    Object.assign(answers, snapshot.answers)
    curIdx.value = snapshot.curIdx
    reviewedCount.value = snapshot.round.total
    roundMs.value = snapshot.round.ms
    startedAt.value = snapshot.startedAt
    const g = snapshot.extra?.gradesCount || {}
    for (const k of ['again', 'hard', 'good', 'easy']) gradesCount[k] = Math.max(0, Number(g[k]) || 0)
    if (snapshot.bankId) bankId.value = snapshot.bankId
    resetAnswer()
    restoreCachedAnswer()
    phase.value = 'card'
    if (missing.length) toast(`有 ${missing.length} 项已被删除，已跳过`, 'info')
    focusCard()
  } catch (e) {
    console.error(e)
    discardSession(SNAP_MODE, '上次复习进度恢复失败，已返回准备页')
    phase.value = 'due'
    await refreshDue()
  } finally {
    dueLoading.value = false
  }
}

function onBankChange() {
  persistBankFilter('review', bankId.value)
  refreshDue()
}

async function refreshDue() {
  try {
    // 统计跟随当前选中的题库（与开始复习的拉题范围一致，避免计数和实际可复习对不上）
    const s = await fetchStats(bankId.value || undefined)
    dueTotal.value = s?.due_total ?? 0
    dueToday.value = s?.due_today ?? 0
    learningDue.value = s?.learning_due ?? 0
    remainingDue.value = dueTotal.value
  } catch (e) {
    console.error(e)
    error.value = '加载复习统计失败：' + (e?.message || e)
  }
}

async function start() {
  if (dueLoading.value) return
  error.value = ''
  dueLoading.value = true
  phase.value = 'loading'
  try {
    // 全部 = 后端上限 500（一轮拉完到期题；真超 500 的极端情况分多轮消化）
    const questions = await reviewDue({ limit: reviewLimit.value, bankId: bankId.value })
    pool.value = buildItems(await expandQuestions(questions))
    if (!pool.value.length) {
      phase.value = 'due'
      dueTotal.value = 0
      error.value = bankName.value
        ? `「${bankName.value}」中没有待复习的题目，切换到全部题库看看，或先在“刷题”中练习吧！`
        : '当前没有待复习的题目，先在“刷题”中练习吧！'
      return
    }
    reviewedCount.value = 0
    roundMs.value = 0
    gradesCount.again = 0; gradesCount.hard = 0; gradesCount.good = 0; gradesCount.easy = 0
    resetSessionState()
    curIdx.value = 0
    resetAnswer()
    startedAt.value = Date.now()
    phase.value = 'card'
    focusCard()
  } catch (e) {
    console.error(e)
    phase.value = 'due'
    error.value = '拉取复习题目失败：' + (e?.message || e)
  } finally {
    dueLoading.value = false
  }
}

function gradeItem(it) {
  const q = it.q
  if (q.type === 'single' || q.type === 'judge') {
    if (!singlePick.value) return { valid: false, message: '请先选择一个选项' }
  } else if (q.type === 'multi') {
    if (!multiPick.value.length) return { valid: false, message: '请至少选择一个选项' }
  } else if (q.type === 'fill') {
    if (!(q.answer?.blanks || []).length) return { valid: false, message: '题目缺少答案（blank）' }
  } else {
    // 复习的简答不做自动判分，直接走四键自评（与既有行为一致）
    return { valid: false, message: '暂不支持的题型：' + (q.type || '未知') }
  }
  const res = gradeQuestion(q, {
    selected: singlePick.value,
    picked: [...multiPick.value],
    fillValues: { ...fillValues },
    shortText: shortText.value
  }, { mode: 'review' })
  const out = { valid: true, correct: !!res.correct }
  if (res.detail?.selected) out.selected = res.detail.selected
  if (res.detail?.blanks) out.results = res.detail.blanks
  if (res.detail?.self_grade) out.self = res.detail.self_grade
  return out
}

function submit() {
  if (graded.value) return
  const it = cur.value
  if (!it) return
  const res = gradeItem(it)
  if (!res.valid) { error.value = res.message; return }
  error.value = ''
  graded.value = true
  gradeResult.value = res
  focusResult()
}

function buildDetail(it, g, autoCorrect, elapsed) {
  const detail = {
    type: it.q.type,
    grade: g,
    correct: g === 'good' || g === 'easy',
    auto_correct: autoCorrect == null ? null : !!autoCorrect,
    elapsed_ms: elapsed
  }
  if (it.isChild) {
    detail.child_id = it.q.id
    detail.child_index = it.childIdx + 1
    detail.parent_id = it.parent.id
  }
  if (gradeResult.value?.selected) detail.selected = gradeResult.value.selected
  if (gradeResult.value?.results) detail.blanks = gradeResult.value.results.map((r) => ({ id: r.id, value: r.value, correct: r.correct }))
  if (isShort.value) detail.my_answer = shortText.value
  return detail
}

function reviewGrade(g) {
  if (submitting.value) return
  const it = cur.value
  if (!it) return
  const elapsed = Date.now() - startedAt.value
  submitting.value = true
  gradesCount[g]++
  reviewedCount.value++
  roundMs.value += elapsed
  const autoCorrect = gradeResult.value?.correct ?? null
  // FSRS：四键 1:1 映射 Rating，前端算卡，后端可信写入
  let card = null
  let fsrsLog = null
  let fsrsRowSnapshot = null
  try {
    const fsrsRow = it.parent ? it.parent.fsrs : it.q.fsrs
    fsrsRowSnapshot = fsrsRow || null // 撤销时要写回的「评分前」快照
    const res = fsrsAnswer(cardFromRow(fsrsRow), g, settings.fsrs)
    card = toRow(res.card, g)
    fsrsLog = toLog(res.log)
  } catch (e) {
    console.error('fsrs answer failed', e)
    recordError.value = '调度计算失败：' + (e?.message || e)
    submitting.value = false
    return
  }
  // 先取流水 ID 再发请求：后端会用这个 ID 落库，撤销时才能精确引用
  const recId = recordIdOf(it)
  recordAnswer([{
    id: recId,
    question_id: it.isChild ? it.parent.id : it.q.id,
    mode: 'review',
    grade: g,
    elapsed_ms: elapsed,
    detail: buildDetail(it, g, autoCorrect, elapsed),
    card,
    fsrs_log: fsrsLog
  }]).then(() => {
    // 记下撤销载荷：流水 ID 与评分前的卡片快照（后端靠它写回）
    forgetRecordId(it) // 已写入就丢掉临时 ID：回看再评会产生新流水，不复用旧 UUID
    armRevert({
      recordId: recId,
      questionId: it.isChild ? it.parent.id : it.q.id,
      card: revertPayloadOf(fsrsRowSnapshot),
      grade: g,
      idx: curIdx.value,
      gradeResult: gradeResult.value
    })
    toast(`已记为${GRADE_TEXT[g]} · 可撤销`, 'info', REVERT_WINDOW_MS)
    next()
  }).catch((e) => {
    console.error('record_answer failed', e)
    recordError.value = (e?.message || e)
    submitting.value = false
  })
}

// 前端为每条复习流水生成 UUID（离线幂等 + 撤销时能精确引用）
const pendingRecordIds = new Map() // key -> { id, key }
function recordIdOf(it) {
  const key = it.uid || (it.isChild ? `${it.parent.id}#${it.q.id}` : it.q.id)
  let id = pendingRecordIds.get(key)
  if (!id) {
    id = randomUUID()
    pendingRecordIds.set(key, id)
  }
  return id
}
/** 撤销后扔掉该题的流水 ID：下次重新评分用新 UUID，不复用已删除的 ID */
function forgetRecordId(it) {
  if (!it) return
  const key = it.uid || (it.isChild ? `${it.parent.id}#${it.q.id}` : it.q.id)
  pendingRecordIds.delete(key)
}

function next() {
  rememberAnswer()
  if (curIdx.value < pool.value.length - 1) {
    curIdx.value++
    resetAnswer()
    restoreCachedAnswer()
    startedAt.value = Date.now()
    focusCard()
  } else {
    phase.value = 'done'
    resetSessionState() // 本轮已收口，不再“继续上次”
    refreshDue().catch(() => {})
  }
}

async function backToDue() {
  remainingDue.value = null
  phase.value = 'due'
  await refreshDue()
}

function fmtMs(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}时${m}分${sec}秒`
  if (m) return `${m}分${sec}秒`
  return `${sec}秒`
}

onMounted(async () => {
  if (!bankStore.loaded) {
    try {
      await loadBanks()
    } catch (e) {
      console.error(e)
    }
  }
  bankId.value = resolveBankFilter('review')
  await refreshDue()
  const snap = await promptResume(SNAP_MODE, { title: '继续上次复习？' })
  if (snap) await resumeSession(snap)
})
</script>

<style scoped>
</style>
