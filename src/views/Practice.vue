<template>
  <div class="page">
    <div v-if="error" class="error-box">{{ error }}</div>

    <!-- 设置面板 -->
    <section v-if="phase === 'setup'" class="card max-w-[640px]">
      <div class="card-head">
        <h2 class="section-title flex items-center gap-2"><i class="i-lucide-zap text-primary" />开始刷题</h2>
        <span class="badge badge-type">练习模式 · 判分后计入复习</span>
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
            {{ TYPE_LABELS[t] }}
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
          <i class="i-lucide-play" />{{ fetching ? '正在抽题…' : '开始刷题' }}
        </button>
      </div>
    </section>

    <!-- 作答卡片 -->
    <section v-else-if="phase === 'card'" class="card flex flex-col gap-3.5">
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
          <button type="button" class="btn btn-small shrink-0" @click="materialOpen = !materialOpen">
            <i :class="materialOpen ? 'i-lucide-eye-off' : 'i-lucide-eye'" />{{ materialOpen ? '收起' : '展开' }}
          </button>
        </div>
        <div v-if="materialOpen" class="text-[13px] text-text-secondary pt-2" v-html="materialStemHtml"></div>
      </div>

      <div class="stem leading-[1.8] text-text-secondary" :key="cur.uid" v-html="stemHtml" @input="onStemInput"></div>

      <!-- 选择类 -->
      <div v-if="isChoice" class="flex flex-col gap-2">
        <button
          v-for="(o, i) in cur.q.options || []"
          :key="o.id"
          type="button"
          class="option-btn"
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
        <div v-if="showRef && !graded" class="flex items-center gap-2.5 flex-wrap">
          <span class="text-[13px] text-muted">这道题你会吗？</span>
          <button type="button" class="btn btn-danger" @click="shortSubmit('不会')"><i class="i-lucide-x" />不会</button>
          <button type="button" class="btn btn-primary" @click="shortSubmit('会')"><i class="i-lucide-check" />会</button>
        </div>
      </div>

      <!-- 提交 -->
      <div v-if="!graded && !isShort">
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
          <button type="button" class="btn btn-primary btn-big" @click="next"><i class="i-lucide-arrow-right" />下一题</button>
        </div>
      </div>
    </section>

    <!-- 结束页 -->
    <section v-else-if="phase === 'done'" class="card flex flex-col gap-5 items-center text-center">
      <div class="text-[22px] font-800 tracking-[-0.01em] font-[var(--serif)] flex items-center gap-2">
        <i class="i-lucide-trophy text-primary text-[26px]" />本轮练习结束
      </div>
      <div class="flex gap-3.5 flex-wrap justify-center">
        <div class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-text">{{ lastRound.correct }} / {{ lastRound.total }}</div>
          <div class="text-[12px] text-muted mt-1">答对题数</div>
        </div>
        <div class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-text">{{ lastRound.rate }}%</div>
          <div class="text-[12px] text-muted mt-1">正确率</div>
        </div>
        <div class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-text">{{ fmtMs(lastRound.ms) }}</div>
          <div class="text-[12px] text-muted mt-1">本轮用时</div>
        </div>
        <div v-if="lastRound.wrong.length" class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-danger">{{ lastRound.wrong.length }}</div>
          <div class="text-[12px] text-muted mt-1">错题数</div>
        </div>
      </div>

      <div v-if="rounds.length > 1" class="text-[13px] text-muted">
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
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { practicePool, recordAnswer, stats as fetchStats } from '@/api/practice.js'
import { renderDoc, renderOptions } from '@/utils/render.js'
import { bankStore, loadBanks, resolveBankFilter, persistBankFilter } from '@/stores/bank.js'
import { settings } from '@/stores/settings.js'

const TYPE_ORDER = ['single', 'multi', 'judge', 'fill', 'short', 'material']
const TYPE_LABELS = {
  single: '单选题', multi: '多选题', judge: '判断题', fill: '填空题', short: '简答题', material: '材料题'
}
const ALL_TYPES = TYPE_ORDER
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

const pool = ref([]) // 子题队列：普通题=1 项，material=每子题 1 项
const curIdx = ref(0)
const cur = computed(() => pool.value[curIdx.value])
const graded = ref(false)
const gradeResult = ref(null)
const startedAt = ref(0)
const materialOpen = ref(true)

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
const isShort = computed(() => cur.value && cur.value.q.type === 'short')

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

const lastRound = computed(() => rounds.value[rounds.value.length - 1] || { total: 0, correct: 0, wrong: [], ms: 0, rate: 0 })
const sessionStats = computed(() => {
  let total = 0, correct = 0, ms = 0
  for (const r of rounds.value) { total += r.total; correct += r.correct; ms += r.ms }
  return { total, correct, ms }
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
function toggleMulti(id) {
  const i = multiPick.value.indexOf(id)
  if (i >= 0) multiPick.value.splice(i, 1)
  else multiPick.value.push(id)
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
    pool.value = buildItems(questions)
    if (!pool.value.length) {
      fetching.value = false
      error.value = '题库中没有符合条件的试题，请先到“新增试题”添加题目。'
      return
    }
    curIdx.value = 0
    round.value = { total: pool.value.length, correct: 0, wrong: [], ms: 0 }
    resetAnswer()
    startedAt.value = Date.now()
    phase.value = 'card'
  } catch (e) {
    console.error(e)
    error.value = '抽题失败：' + (e?.message || e)
  } finally {
    fetching.value = false
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
  if (q.type === 'short') {
    if (!showRef.value) return { valid: false, message: '请先查看参考答案' }
    if (!selfGrade.value) return { valid: false, message: '请自评：不会 / 会' }
    return { valid: true, correct: selfGrade.value === '会', self: selfGrade.value }
  }
  return { valid: false, message: '暂不支持的题型：' + (q.type || '未知') }
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
  round.value.correct += res.correct ? 1 : 0
  round.value.ms += elapsed
  if (!res.correct) round.value.wrong.push(it)
  recordAnswer([{
    question_id: it.isChild ? it.parent.id : it.q.id,
    mode: 'practice',
    grade,
    elapsed_ms: elapsed,
    detail: buildDetail(it, res)
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
  if (curIdx.value < pool.value.length - 1) {
    curIdx.value++
    resetAnswer()
    startedAt.value = Date.now()
  } else {
    rounds.value.push({ ...round.value, rate: round.value.total ? Math.round((round.value.correct / round.value.total) * 100) : 0 })
    phase.value = 'done'
  }
}

function startRedo() {
  const last = rounds.value[rounds.value.length - 1]
  if (!last || !last.wrong.length) return
  pool.value = last.wrong
  curIdx.value = 0
  round.value = { total: pool.value.length, correct: 0, wrong: [], ms: 0 }
  resetAnswer()
  startedAt.value = Date.now()
  phase.value = 'card'
}

// 错题本重练：按指定 id 组卷，跳过 setup 直达作答
async function startFromIds(ids) {
  if (fetching.value) return
  error.value = ''
  fetching.value = true
  try {
    const questions = await practicePool({ ids })
    pool.value = buildItems(questions)
    if (!pool.value.length) {
      error.value = '重练题目已不存在（可能被删除），请从错题本重新发起。'
      return
    }
    curIdx.value = 0
    round.value = { total: pool.value.length, correct: 0, wrong: [], ms: 0 }
    resetAnswer()
    startedAt.value = Date.now()
    phase.value = 'card'
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
  }
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
