<template>
  <div class="page">
    <div v-if="error" class="error-box">{{ error }}</div>

    <!-- 等待复习（due） -->
    <section v-if="phase === 'due'" class="card max-w-[640px]">
      <div class="card-head">
        <h2 class="section-title flex items-center gap-2"><i class="i-lucide-repeat text-primary" />间隔复习</h2>
        <span class="badge badge-type">SM-2</span>
      </div>
      <p class="text-text-secondary text-[14px] leading-[1.8] m-0 mb-4.5">
        {{ bankName ? `「${bankName}」` : '全部题库' }}当前待复习 <b class="text-primary text-[18px]">{{ dueTotal }}</b> 题，今日到期 <b class="text-primary text-[18px]">{{ dueToday }}</b> 题。
        按遗忘曲线安排，每次最多复习 20 题。
      </p>

      <div class="mb-4.5">
        <div class="field-label">题库</div>
        <select v-model="bankId" class="select w-full max-w-[320px]" @change="onBankChange">
          <option value="">全部题库</option>
          <option v-for="b in bankStore.banks" :key="b.id" :value="b.id">{{ b.name }}</option>
        </select>
      </div>

      <div>
        <button
          type="button"
          class="btn btn-primary btn-big"
          :disabled="dueLoading"
          @click="start"
        >
          <i class="i-lucide-play" />{{ dueLoading ? '正在拉取复习题目…' : '开始复习' }}
        </button>
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
        <span class="badge badge-type">{{ curBadge }}</span>
        <span class="text-[13px] text-muted font-500">第 {{ curIdx + 1 }} / {{ pool.length }} 题</span>
      </div>
      <div class="progress-track"><div class="progress-inner" :style="{ width: progressPct + '%' }"></div></div>

      <div v-if="cur.isChild" class="border border-dashed border-primary-border bg-bg-accent rounded-[12px] px-3.5 py-2">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[12px] font-600 text-muted flex items-center gap-1.5 min-w-0">
            <i class="i-lucide-book-open shrink-0" />材料 · 共 {{ cur.childCount }} 问 · 第 {{ cur.childIdx + 1 }} 问
          </span>
          <button type="button" class="btn btn-small shrink-0" title="M 展开/收起" @click="materialOpen = !materialOpen">
            <i :class="materialOpen ? 'i-lucide-eye-off' : 'i-lucide-eye'" />{{ materialOpen ? '收起' : '展开' }}
          </button>
        </div>
        <div v-if="materialOpen" class="text-[13px] text-text-secondary pt-2" v-html="materialStemHtml"></div>
      </div>

      <div class="stem leading-[1.8] text-text-secondary" :key="cur.uid" v-html="stemHtml" @input="onStemInput" @keydown="onStemKeydown"></div>

      <!-- 选择类 -->
      <div v-if="isChoice" class="flex flex-col gap-2">
        <button
          v-for="(o, i) in cur.q.options || []"
          :key="o.id"
          type="button"
          class="option-btn"
          title="空格/A–F 选择，回车判分"
          :class="singlePick === o.id && 'bg-primary-bg border-primary-border text-text shadow-[0_0_0_3px_rgba(31,77,58,0.12)]'"
          @click="singlePick = o.id"
        >
          <span class="key font-700 text-primary shrink-0">{{ keyOf(i) }}</span>
          <span class="opt-body" v-html="optHtml(o)"></span>
        </button>
      </div>
      <div v-else-if="cur.q.type === 'multi'" class="flex flex-col gap-2">
        <button
          v-for="(o, i) in cur.q.options || []"
          :key="o.id"
          type="button"
          class="option-btn"
          title="空格/A–F 选择，回车判分"
          :class="multiPick.includes(o.id) && 'bg-primary-bg border-primary-border text-text shadow-[0_0_0_3px_rgba(31,77,58,0.12)]'"
          @click="toggleMulti(o.id)"
        >
          <span class="key font-700 text-primary shrink-0">{{ keyOf(i) }}</span>
          <span class="opt-body" v-html="optHtml(o)"></span>
        </button>
      </div>

      <!-- 简答 -->
      <div v-else-if="cur.q.type === 'short'" class="flex flex-col gap-2.5">
        <textarea v-model="shortText" rows="5" class="w-full p-3 border border-line rounded-[8px] text-[14px] text-text bg-card outline-none resize-y shadow-sm transition-[border-color,box-shadow] duration-150 focus:border-primary focus:shadow-[0_0_0_3px_rgba(31,77,58,0.15)]" placeholder="请输入你的答案…"></textarea>
        <div class="flex gap-2">
          <button type="button" class="btn" @click="showRef = !showRef">
            <i :class="showRef ? 'i-lucide-eye-off' : 'i-lucide-eye'" />{{ showRef ? '收起参考答案' : '查看参考答案' }}
          </button>
        </div>
        <div v-if="showRef" class="p-3.5 bg-success-bg border border-[#bcd9c4] rounded-[8px] text-[14px] leading-[1.7] text-text-secondary">
          <b class="text-success flex items-center gap-1"><i class="i-lucide-book-open text-[14px]" />参考答案：</b>
          <div v-html="refHtml"></div>
        </div>
      </div>

      <!-- 自动判分（选择/填空） -->
      <div v-if="!graded && !isShort">
        <button type="button" class="btn btn-primary btn-big" :disabled="!canSubmit" @click="submit">
          <i class="i-lucide-check-circle" />判分
        </button>
      </div>

      <!-- 判分结果（判分前绝不展示答案/解析） -->
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

      <!-- 四键自评：判分后(选择/填空)或查看参考答案后(简答)出现 -->
      <div v-if="canSelfGrade" class="flex items-center gap-2 flex-wrap border-t border-line pt-3.5">
        <span class="text-[13px] text-muted font-600">自评记忆效果：<span class="font-400 text-muted-light">（键盘 1–4）</span></span>
        <button type="button" class="btn btn-danger" :disabled="submitting" @click="reviewGrade('again')"><i class="i-lucide-rotate-ccw" />忘记</button>
        <button type="button" class="btn border-[#d9c4a3] text-[#a06a2a] bg-[#f0e6d6] hover:bg-[#f0e6d6] hover:border-[#c4a87f]" :disabled="submitting" @click="reviewGrade('hard')"><i class="i-lucide-frown" />困难</button>
        <button type="button" class="btn border-[#bcd9c4] text-success bg-success-bg hover:bg-success-bg hover:border-[#9bc4ad]" :disabled="submitting" @click="reviewGrade('good')"><i class="i-lucide-meh" />良好</button>
        <button type="button" class="btn btn-primary-link" :disabled="submitting" @click="reviewGrade('easy')"><i class="i-lucide-smile" />简单</button>
      </div>
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
import { ref, reactive, computed, onMounted, nextTick } from 'vue'
import { reviewDue, recordAnswer, stats as fetchStats } from '@/api/practice.js'
import { renderDoc, renderOptions } from '@/utils/render.js'
import { bankStore, loadBanks, resolveBankFilter, persistBankFilter } from '@/stores/bank.js'
import { ui } from '@/stores/ui.js'

const TYPE_LABELS = {
  single: '单选题', multi: '多选题', judge: '判断题', fill: '填空题', short: '简答题', material: '材料题'
}

const phase = ref('due') // due | loading | card | done
const bankId = ref('')
const bankName = computed(() => bankStore.banks.find((b) => b.id === bankId.value)?.name || '')
const error = ref('')
const recordError = ref('')
const dueLoading = ref(false)
const dueTotal = ref(0)
const dueToday = ref(0)
const remainingDue = ref(null)

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

const curBadge = computed(() => {
  const it = cur.value
  if (!it) return ''
  if (it.isChild) return `材料题 · 第 ${it.childIdx + 1}/${it.childCount} 问`
  return TYPE_LABELS[it.q.type] || it.q.type
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

const stemHtml = computed(() => renderStemHtml(cur.value))
const materialStemHtml = computed(() => (cur.value?.parent ? renderDoc(cur.value.parent.stem) : ''))
const refHtml = computed(() => {
  const q = cur.value?.q
  return q?.type === 'short' && q.answer?.reference ? renderDoc(q.answer.reference) : ''
})
const analysisHtml = computed(() => {
  const q = cur.value?.q
  return q && q.analysis && Array.isArray(q.analysis.content) && q.analysis.content.length
    ? renderDoc(q.analysis)
    : ''
})
const answerHtml = computed(() => {
  const q = cur.value?.q
  if (!q || !isChoice.value) return ''
  return renderOptions(q.options, q.answer?.ids)
})

function keyOf(i) { return String.fromCharCode(65 + (i || 0)) }
function optHtml(o) { return renderDoc(o?.content).replace(/^<p>/, '').replace(/<\/p>$/, '') }
function blankAnswersOf(id) {
  const blanks = cur.value?.q?.answer?.blanks || []
  const b = blanks.find((x) => x.id === id)
  return Array.isArray(b?.answers) ? b.answers.join(' / ') : ''
}
function renderStemHtml(it) {
  if (!it) return ''
  const q = it.q
  if (q.type === 'fill') {
    return renderDoc(q.stem).replace(
      /<span class="blank"[^>]*data-id="([^"]+)"[^>]*>[\s\S]*?<\/span>/g,
      (m, id) => `<input class="qb-fill-input" data-blank="${id}" type="text" autocomplete="off" placeholder="填写答案" />`
    )
  }
  return renderDoc(q.stem)
}
function onStemInput(e) {
  const b = e.target && e.target.dataset && e.target.dataset.blank
  if (b) fillValues[b] = e.target.value
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
  const isFillInput = !!(t && t.classList && t.classList.contains('qb-fill-input'))
  const inField = isFillInput || !!(t && t.closest && t.closest('textarea, select, input, [contenteditable], .tiptap, .ProseMirror'))
  if (e.key === 'Enter') {
    if (isFillInput) return // 填空走 stem 跳空逻辑
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
  if (k === 'M' && cur.value?.isChild) {
    materialOpen.value = !materialOpen.value
    return
  }
  if (!graded.value && /^[A-F]$/.test(k)) {
    const q = cur.value?.q
    if (q && ['single', 'judge', 'multi'].includes(q.type)) {
      const opt = (q.options || [])[k.charCodeAt(0) - 65]
      if (opt) {
        if (q.type === 'multi') toggleMulti(opt.id)
        else singlePick.value = opt.id
      }
    }
    return
  }
  if (/^[1-4]$/.test(k) && canSelfGrade.value) {
    reviewGrade({ 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' }[k])
  }
}
// 填空回车：跳下一空并全选（直接覆盖写）；末空回车直接判分
function onStemKeydown(e) {
  if (e.key !== 'Enter') return
  const t = e.target
  if (!t || !t.classList || !t.classList.contains('qb-fill-input')) return
  e.preventDefault()
  const inputs = [...e.currentTarget.querySelectorAll('.qb-fill-input')]
  const i = inputs.indexOf(t)
  if (i >= 0 && i < inputs.length - 1) {
    inputs[i + 1].focus()
    if (inputs[i + 1].select) inputs[i + 1].select()
  } else {
    submit()
  }
}
function toggleMulti(id) {
  const i = multiPick.value.indexOf(id)
  if (i >= 0) multiPick.value.splice(i, 1)
  else multiPick.value.push(id)
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
    const questions = await reviewDue({ limit: 20, bankId: bankId.value })
    pool.value = buildItems(questions)
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
    const ans = q.answer?.ids || []
    return { valid: true, correct: ans.length === 1 && singlePick.value === ans[0], selected: [singlePick.value] }
  }
  if (q.type === 'multi') {
    if (!multiPick.value.length) return { valid: false, message: '请至少选择一个选项' }
    const ans = q.answer?.ids || []
    const sel = [...multiPick.value]
    return { valid: true, correct: ans.length === sel.length && ans.every((id) => sel.includes(id)), selected: sel }
  }
  if (q.type === 'fill') {
    const blanks = q.answer?.blanks || []
    if (!blanks.length) return { valid: false, message: '题目缺少答案（blank）' }
    const results = blanks.map((b) => {
      const raw = (fillValues[b.id] || '').trim()
      const norm = raw.toLowerCase()
      const correct = (b.answers || []).some((a) => String(a).trim().toLowerCase() === norm)
      return { id: b.id, value: raw, correct }
    })
    return { valid: true, correct: results.every((r) => r.correct), results }
  }
  return { valid: false, message: '暂不支持的题型：' + (q.type || '未知') }
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
  recordAnswer([{
    question_id: it.isChild ? it.parent.id : it.q.id,
    mode: 'review',
    grade: g,
    elapsed_ms: elapsed,
    detail: buildDetail(it, g, autoCorrect, elapsed)
  }]).then(() => next()).catch((e) => {
    console.error('record_answer failed', e)
    recordError.value = (e?.message || e)
    submitting.value = false
  })
}

function next() {
  if (curIdx.value < pool.value.length - 1) {
    curIdx.value++
    resetAnswer()
    startedAt.value = Date.now()
    focusCard()
  } else {
    phase.value = 'done'
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
})
</script>

<style scoped>
/* v-html 注入的题干 / 选项 / 解析 / 答案渲染样式，原子类无法覆盖，保留 :deep() */
.stem :deep(p) { margin: 10px 0; }
.stem :deep(figure) { margin: 14px 0; text-align: center; }
.stem :deep(img) { max-width: 100%; border-radius: 8px; border: 1px solid var(--line); background: #fffdf7; }
.stem :deep(.math-block) { margin: 12px 0; padding: 12px; background: var(--bg-accent); border: 1px solid var(--line); border-radius: 8px; text-align: center; }
.stem :deep(.qb-fill-input) {
  min-width: 92px; padding: 6px 10px; margin: 0 4px;
  border: 1px solid var(--line-strong); border-bottom: 2px solid var(--primary);
  border-radius: 8px; font-size: 14px; color: var(--text); background: var(--card);
  outline: none; transition: border-color .15s ease, box-shadow .15s ease; box-shadow: var(--shadow-sm);
}
.stem :deep(.qb-fill-input:focus) { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(31,77,58,.15); }
.opt-body :deep(p) { margin: 0; }
.answer-view :deep(.option) { padding: 6px 8px; border-radius: 8px; }
.answer-view :deep(.option.correct) { color: var(--success); font-weight: 600; }
.answer-view :deep(.key) { font-weight: 700; color: var(--primary); margin-right: 6px; }
.answer-view :deep(p) { margin: 4px 0; }
.analysis :deep(p) { margin: 6px 0; }
</style>
