<template>
  <div class="page">
    <div v-if="error" class="error-box">{{ error }}</div>

    <!-- 准备面板 -->
    <section v-if="phase === 'setup'" class="card max-w-[640px]">
      <div class="card-head">
        <h2 class="section-title flex items-center gap-2"><i class="i-lucide-clipboard-list text-primary" />开始模考</h2>
        <span class="badge badge-type">整卷限时 · 交卷自动判分 · 不计入复习统计</span>
      </div>

      <div class="mb-5">
        <div class="field-label">题库</div>
        <select v-model="bankId" class="select w-full max-w-[320px]" @change="persistBankFilter('exam', bankId)">
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

      <div class="mb-5">
        <div class="field-label">多选题计分 <span class="text-[12px] text-muted-light">（错选一律 0 分）</span></div>
        <div class="flex gap-2 flex-wrap">
          <button
            type="button"
            class="px-4.5 py-2 rounded-[8px] border border-line bg-card text-text-secondary text-[14px] font-500 cursor-pointer transition-[background-color,border-color,color] duration-150 shadow-sm hover:bg-bg-accent"
            :class="multiRule === 'partial' && 'bg-text text-white border-text'"
            @click="setMultiRule('partial')"
          >漏选按比例给分</button>
          <button
            type="button"
            class="px-4.5 py-2 rounded-[8px] border border-line bg-card text-text-secondary text-[14px] font-500 cursor-pointer transition-[background-color,border-color,color] duration-150 shadow-sm hover:bg-bg-accent"
            :class="multiRule === 'strict' && 'bg-text text-white border-text'"
            @click="setMultiRule('strict')"
          >漏选不得分</button>
        </div>
      </div>

      <div class="mb-5">
        <div class="field-label">限时</div>
        <div class="flex gap-2 flex-wrap">
          <button
            v-for="d in DURATION_OPTIONS"
            :key="d.value"
            type="button"
            class="px-4.5 py-2 rounded-[8px] border border-line bg-card text-text-secondary text-[14px] font-500 cursor-pointer transition-[background-color,border-color,color] duration-150 shadow-sm hover:bg-bg-accent"
            :class="durationMin === d.value && 'bg-text text-white border-text'"
            @click="setDuration(d.value)"
          >
            {{ d.label }}
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
          <i class="i-lucide-play" />{{ fetching ? '正在抽题…' : '开始模考' }}
        </button>
        <div class="text-[12px] text-muted-light mt-2.5 flex items-center gap-1.5">
          <i class="i-lucide-keyboard" />键盘：A–F 选题，Enter 下一题，M 切换材料；中途可回看改答，交卷后统一判分
        </div>
      </div>
    </section>

    <!-- 最近模考 -->
    <section v-if="phase === 'setup' && history.length" class="card max-w-[640px]">
      <div class="card-head">
        <h2 class="section-title flex items-center gap-2"><i class="i-lucide-history text-primary" />最近模考</h2>
      </div>
      <div class="flex flex-col divide-y divide-line">
        <div v-for="h in history" :key="h.exam_id" class="flex items-center justify-between gap-3 py-2.5">
          <div class="min-w-0">
            <div class="text-[14px] font-500 text-text">{{ fmtDate(h.started_at) }}</div>
            <div class="text-[12px] text-muted mt-0.5">{{ h.item_count }} 条作答 · {{ fmtDur(h) }}</div>
          </div>
          <div class="shrink-0 text-right">
            <div class="text-[15px] font-700 text-text">{{ fmtScore(h.score) }} <span class="text-[12px] font-500 text-muted">/ {{ fmtScore(h.full_score) }}</span></div>
            <div class="text-[12px] text-muted mt-0.5">得分率 {{ h.full_score > 0 ? Math.round((h.score / h.full_score) * 1000) / 10 : 0 }}%</div>
          </div>
        </div>
      </div>
    </section>

    <!-- 作答卡片 -->
    <section v-else-if="phase === 'card'" ref="cardRef" tabindex="-1" class="card flex flex-col gap-3.5" @keydown="onCardKeydown">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <span class="badge badge-type">{{ curBadge }}</span>
          <span v-if="cur.q.type === 'multi'" class="badge shrink-0">多选：{{ multiRule === 'partial' ? '漏选按比例' : '漏选不得分' }}</span>
        </div>
        <div class="flex items-center gap-2.5 shrink-0">
          <span v-if="durationMin > 0" class="badge" :class="clockUrgent ? 'badge-bad' : ''">
            <i class="i-lucide-timer" />{{ clockStr }}
          </span>
          <span class="text-[13px] text-muted font-500">第 {{ curIdx + 1 }} / {{ items.length }} 题</span>
        </div>
      </div>
      <div class="progress-track"><div class="progress-inner" :style="{ width: progressPct + '%' }"></div></div>

      <QuestionRunner
        :item="cur"
        mode="exam"
        :selected="curAns.selected"
        :picked="curAns.picked"
        :fill-values="curAns.fillValues"
        :short-text="curAns.shortText"
        :show-ref="curAns.showRef"
        :material-open="materialOpen"
        short-placeholder="请输入你的答案…（交卷前可回看修改）"
        interactive-hint="A–F 选择"
        @update:selected="curAns.selected = $event"
        @update:picked="curAns.picked = $event"
        @update:short-text="curAns.shortText = $event"
        @update:show-ref="curAns.showRef = $event"
        @update:material-open="materialOpen = $event"
        @fill-enter="curIdx < items.length - 1 && go(curIdx + 1)"
      >
        <!-- 简答自评（模考：与「查看参考答案」同一行） -->
        <template #short-toolbar="{ showRef }">
          <template v-if="showRef">
            <button type="button" class="btn btn-danger" :class="curAns.shortSelf === '不会' && '!bg-danger-bg !border-[#d2a39c] !text-danger'" @click="curAns.shortSelf = '不会'"><i class="i-lucide-x" />不会</button>
            <button type="button" class="btn btn-primary" @click="curAns.shortSelf = '会'"><i class="i-lucide-check" />会</button>
          </template>
        </template>

        <!-- 底部导航（模考专属，放在 runner 的默认 slot 内） -->
        <div class="flex items-center justify-between gap-3 flex-wrap pt-1">
          <button type="button" class="btn" :disabled="curIdx === 0" @click="go(curIdx - 1)">
            <i class="i-lucide-arrow-left" />上一题
          </button>
          <span class="text-[13px] text-muted">已答 {{ answeredCount }} / {{ items.length }}</span>
          <div class="flex gap-2">
            <button v-if="curIdx < items.length - 1" type="button" class="btn btn-primary" @click="go(curIdx + 1)">
              下一题<i class="i-lucide-arrow-right" />
            </button>
            <button type="button" class="btn btn-danger" :disabled="submitting" @click="confirmSubmit">
              <i class="i-lucide-flag" />{{ submitting ? '判分中…' : '交卷' }}
            </button>
          </div>
        </div>
      </QuestionRunner>
    </section>

    <!-- 成绩单 -->
    <section v-else-if="phase === 'result' && sheet" class="card flex flex-col gap-5">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div class="text-[22px] font-800 tracking-[-0.01em] font-[var(--serif)] flex items-center gap-2">
          <i class="i-lucide-trophy text-primary text-[26px]" />模考结束
        </div>
        <span v-if="sheet.timeout" class="badge badge-bad"><i class="i-lucide-alarm-clock" />到时自动交卷</span>
      </div>

      <div class="flex gap-3.5 flex-wrap">
        <div class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-text">{{ fmtScore(sheet.earned) }} <span class="text-[14px] font-500 text-muted">/ {{ fmtScore(sheet.full) }}</span></div>
          <div class="text-[12px] text-muted mt-1">总得分 / 满分</div>
        </div>
        <div class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-text">{{ sheet.rate }}%</div>
          <div class="text-[12px] text-muted mt-1">得分率</div>
        </div>
        <div class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-text">{{ sheet.correctCount }} / {{ sheet.entries.length }}</div>
          <div class="text-[12px] text-muted mt-1">答对题数（得分率 ≥ 60%）</div>
        </div>
        <div class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-text">{{ fmtMs(sheet.endedAt - sheet.startedAt) }}</div>
          <div class="text-[12px] text-muted mt-1">用时</div>
        </div>
        <div v-if="sheet.unansweredCount" class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-danger">{{ sheet.unansweredCount }}</div>
          <div class="text-[12px] text-muted mt-1">未作答</div>
        </div>
      </div>

      <!-- 逐题成绩 -->
      <div class="flex flex-col gap-2">
        <div v-for="e in sheet.entries" :key="e.q.id" class="border border-line rounded-[10px] bg-card overflow-hidden">
          <button type="button" class="w-full flex items-center gap-3 px-3.5 py-2.5 text-left bg-transparent border-0 cursor-pointer hover:bg-bg-accent transition-[background-color] duration-150" @click="toggleRow(e.pi)">
            <i :class="rowOpen.has(e.pi) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="text-muted shrink-0" />
            <span class="text-[12px] font-600 text-muted shrink-0 w-[44px]">第 {{ e.pi + 1 }} 题</span>
            <span class="text-[13px] text-text-secondary truncate flex-1">{{ excerptOf(e.q) }}</span>
            <span class="badge shrink-0">{{ TYPE_FULL_LABELS[e.q.type] || e.q.type }}</span>
            <span class="text-[13px] font-700 shrink-0" :class="e.res.ratio >= 1 ? 'text-success' : (e.res.ratio >= 0.6 ? 'text-text' : 'text-danger')">
              {{ fmtScore(e.res.earned) }} / {{ fmtScore(e.res.full) }}
            </span>
            <span v-if="e.res.unanswered" class="badge badge-bad shrink-0">未作答</span>
          </button>
          <div v-if="rowOpen.has(e.pi)" class="px-4 pb-3.5 flex flex-col gap-2.5">
            <div v-for="row in rowsOf(e)" :key="row.label + (row.q.id || '')" class="border border-line rounded-[8px] px-3 py-2.5 flex flex-col gap-2 bg-bg-accent">
              <div class="flex items-center gap-2 flex-wrap">
                <span v-if="row.label" class="badge">{{ row.label }}</span>
                <span class="text-[12px] text-muted">{{ TYPE_FULL_LABELS[row.q.type] || row.q.type }}</span>
                <span class="text-[13px] font-700 ml-auto" :class="row.res.ratio >= 1 ? 'text-success' : (row.res.ratio >= 0.6 ? 'text-text' : 'text-danger')">
                  {{ fmtScore(row.res.earned) }} / {{ fmtScore(row.res.full) }}
                </span>
              </div>

              <div v-if="['single', 'judge', 'multi'].includes(row.q.type)" class="flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
                <span>你的选择：<b :class="row.res.ratio > 0 ? 'text-text' : 'text-danger'">{{ lettersOf(row.q, row.q.type === 'multi' ? row.ans.picked : [row.ans.selected].filter(Boolean)) || '—' }}</b></span>
                <span>正确答案：<b class="text-success">{{ lettersOf(row.q, row.q.answer?.ids) || '—' }}</b></span>
                <span v-if="row.res.subset" class="text-muted">（漏选）</span>
              </div>

              <div v-else-if="row.q.type === 'fill'" class="flex flex-col gap-1 text-[13px]">
                <div v-for="(b, bi) in row.q.answer?.blanks || []" :key="b.id" class="flex gap-2 items-baseline flex-wrap">
                  <span class="text-muted w-[46px] shrink-0">空 {{ bi + 1 }}</span>
                  <span :class="isBlankOk(row, b) ? 'text-text' : 'text-danger'">{{ row.ans.fillValues?.[b.id]?.trim() || '（未填）' }}</span>
                  <span class="text-muted">→ <span class="text-success font-500">{{ (b.answers || []).join(' / ') || '—' }}</span></span>
                </div>
              </div>

              <div v-else-if="row.q.type === 'short'" class="flex flex-col gap-1.5 text-[13px]">
                <span>自评：<b :class="row.ans.shortSelf === '会' ? 'text-success' : 'text-danger'">{{ row.ans.shortSelf || '（未自评）' }}</b></span>
                <div v-if="refOf(row.q)" class="text-text-secondary">
                  <b class="text-success">参考答案：</b>
                  <div class="analysis" style="padding-top:2px" v-html="refOf(row.q)"></div>
                </div>
              </div>
            </div>
            <div v-if="analysisOf(e.q)" class="analysis p-3.5 bg-bg-accent border border-line rounded-[8px] text-[14px] leading-[1.7] text-text-secondary">
              <b class="text-primary flex items-center gap-1"><i class="i-lucide-lightbulb text-[14px]" />解析：</b>
              <div v-html="analysisOf(e.q)"></div>
            </div>
          </div>
        </div>
      </div>

      <div class="flex gap-3 flex-wrap">
        <button v-if="sheet.wrong.length" type="button" class="btn btn-primary" @click="retryWrong">
          <i class="i-lucide-rotate-ccw" />错题重练（{{ sheet.wrong.length }} 题）
        </button>
        <button type="button" class="btn" @click="restart">
          <i class="i-lucide-clipboard-list" />再考一轮
        </button>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { practicePool, recordAnswer, stats as fetchStats } from '@/api/practice.js'
import { examSessions } from '@/api/exam.js'
import { expandQuestions } from '@/api/assets.js'
import { renderDoc } from '@/utils/render.js'
import { bankStore, loadBanks, resolveBankFilter, persistBankFilter } from '@/stores/bank.js'
import { ui, confirmDialog, toast } from '@/stores/ui.js'
import { randomUUID } from '@/utils/device.js'
import { save as saveSession, scheduleSave, flush as flushSession, load as loadSession, clear as clearSession, parentIdsOf } from '@/stores/session.js'
import { buildExamDetail, summarizePaper, ratioToGrade } from '@/utils/grading.js'
import { gradeQuestion } from '@/utils/gradeQuestion.js'
import QuestionRunner from '@/components/question/QuestionRunner.vue'
import { QUESTION_TYPE_KEYS, TYPE_FULL_LABELS } from '@/constants/questions.js'

// 题型清单/文案统一来自 constants/questions.js（FE-ARCH-01）；组卷面板与成绩单用完整名
const ALL_TYPES = QUESTION_TYPE_KEYS
const COUNT_OPTIONS = [
  { value: 5, label: '5 题' },
  { value: 10, label: '10 题' },
  { value: 20, label: '20 题' },
  { value: 0, label: '全部' }
]
const DURATION_OPTIONS = [
  { value: 0, label: '不限时' },
  { value: 30, label: '30 分钟' },
  { value: 60, label: '60 分钟' },
  { value: 90, label: '90 分钟' },
  { value: 120, label: '120 分钟' }
]
const MULTI_RULE_KEY = 'qbank.exam.multiRule'
const DURATION_KEY = 'qbank.exam.durationMin'

const router = useRouter()
const phase = ref('setup') // setup | card | result
const error = ref('')
const fetching = ref(false)
const submitting = ref(false)

const selectedTypes = ref([...ALL_TYPES])
const count = ref(10)
const bankId = ref('')
const multiRule = ref(localStorage.getItem(MULTI_RULE_KEY) === 'strict' ? 'strict' : 'partial')
const durationMin = ref(Number(localStorage.getItem(DURATION_KEY)) || 60)
function setMultiRule(r) {
  multiRule.value = r
  try { localStorage.setItem(MULTI_RULE_KEY, r) } catch { /* 忽略持久化失败 */ }
}
function setDuration(v) {
  durationMin.value = v
  try { localStorage.setItem(DURATION_KEY, String(v)) } catch { /* 忽略持久化失败 */ }
}

// 母题（展开后）与作答条目（材料拆子题）；paperRaw 存引用形态入草稿
const paper = ref([])
const paperRaw = ref([])
const items = ref([])
const curIdx = ref(0)
const cur = computed(() => items.value[curIdx.value])
const answers = reactive({}) // uid -> { selected, picked, fillValues, shortSelf, shortText, showRef }
const itemElapsed = reactive({}) // uid -> 累计毫秒
let idxMap = {} // `${parentId|qid}#${childIdx|-1}` -> uid
let itemStartTs = 0
const examId = ref('')
const startedAt = ref(0)
const remainingMs = ref(0)
const sheet = ref(null)
const history = ref([])
const rowOpen = reactive(new Set())
const materialOpen = ref(true)
const cardRef = ref(null)

const isChoice = computed(() => cur.value && ['single', 'judge'].includes(cur.value.q.type))
const curAns = computed(() => (cur.value ? answers[cur.value.uid] : null))
const curBadge = computed(() => {
  const it = cur.value
  if (!it) return ''
  if (it.isChild) return `材料题 · 第 ${it.childIdx + 1}/${it.childCount} 问`
  return TYPE_FULL_LABELS[it.q.type] || it.q.type
})
const answeredCount = computed(() => items.value.filter(hasAnswer).length)
const progressPct = computed(() => {
  const total = items.value.length || 1
  return Math.min(100, Math.round((answeredCount.value / total) * 100))
})
const clockUrgent = computed(() => durationMin.value > 0 && remainingMs.value <= 5 * 60000)
const clockStr = computed(() => {
  const s = Math.max(0, Math.ceil((remainingMs.value || 0) / 1000))
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
})

function hasAnswer(it) {
  const a = answers[it.uid]
  if (!a) return false
  if (a.selected) return true
  if (a.picked?.length) return true
  if (Object.values(a.fillValues || {}).some((v) => String(v || '').trim())) return true
  if (a.shortSelf) return true
  return false
}

// 条目与索引：与 Practice 同构（材料拆子题），uid 确定性（同题序可重建，草稿可恢复）
function buildExamItems(questions) {
  const list = []
  for (const q of questions || []) {
    if (q.type === 'material' && Array.isArray(q.children) && q.children.length) {
      q.children.forEach((child, ci) => list.push({ q: child, parent: q, isChild: true, childIdx: ci, childCount: q.children.length }))
    } else {
      list.push({ q, parent: null, isChild: false, childIdx: -1, childCount: 0 })
    }
  }
  return list.map((it, idx) => ({ ...it, uid: `${it.q.id}_${idx}` }))
}
function rebuildIndex() {
  idxMap = {}
  for (const it of items.value) {
    const pk = it.parent ? it.parent.id : it.q.id
    idxMap[`${pk}#${it.isChild ? it.childIdx : -1}`] = it.uid
  }
}
function initAnswers() {
  for (const k of Object.keys(answers)) delete answers[k]
  for (const it of items.value) {
    answers[it.uid] = { selected: '', picked: [], fillValues: {}, shortSelf: '', shortText: '', showRef: false }
  }
  for (const k of Object.keys(itemElapsed)) delete itemElapsed[k]
  for (const it of items.value) itemElapsed[it.uid] = 0
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

async function start() {
  const types = selectedTypes.value
  if (!types.length) { error.value = '请至少选择一种题型'; return }
  if (fetching.value) return
  error.value = ''
  fetching.value = true
  try {
    let limit = count.value
    if (limit === 0) {
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
    if (!questions || !questions.length) {
      error.value = '题库中没有符合条件的试题，请先到「新增试题」添加题目。'
      return
    }
    const ok = await beginExam(questions, randomUUID(), Date.now())
    if (!ok) return
  } catch (e) {
    console.error(e)
    error.value = '抽题失败：' + (e?.message || e)
  } finally {
    fetching.value = false
  }
}

async function beginExam(rawQuestions, id, startTs) {
  const expanded = await expandQuestions(rawQuestions)
  paperRaw.value = rawQuestions
  paper.value = expanded
  items.value = buildExamItems(expanded)
  if (!items.value.length) {
    error.value = '抽到的题目无法组卷（缺少子题/内容），请检查题目数据。'
    phase.value = 'setup'
    return false
  }
  examId.value = id
  startedAt.value = startTs
  curIdx.value = 0
  initAnswers()
  rebuildIndex()
  materialOpen.value = true
  itemStartTs = Date.now()
  rowOpen.clear()
  sheet.value = null
  remainingMs.value = durationMin.value > 0 ? startedAt.value + durationMin.value * 60000 - Date.now() : 0
  phase.value = 'card'
  startTimer()
  saveDraft()
  focusCard()
  return true
}

// 计时：读秒由定时器驱动；到 0 自动交卷（未作答按 0 分落库）
let timerId = null
function startTimer() {
  stopTimer()
  if (durationMin.value > 0) {
    timerId = setInterval(() => {
      remainingMs.value = startedAt.value + durationMin.value * 60000 - Date.now()
      if (remainingMs.value <= 0) {
        stopTimer()
        if (phase.value === 'card') submitPaper(true)
      }
    }, 1000)
  }
}
function stopTimer() {
  if (timerId) { clearInterval(timerId); timerId = null }
}

function go(idx) {
  if (idx < 0 || idx >= items.value.length || idx === curIdx.value) return
  if (cur.value) itemElapsed[cur.value.uid] += Date.now() - itemStartTs
  curIdx.value = idx
  itemStartTs = Date.now()
  materialOpen.value = true
  saveDraft()
  focusCard()
}

// 草稿：统一会话快照（stores/session.js）。只存题目 id + 作答，恢复时按 id 重拉；不落库不进同步。
const SNAP_MODE = 'exam'
function draftSnapshot() {
  return {
    mode: SNAP_MODE,
    bankId: bankId.value,
    keys: items.value.map((it) => it.uid),
    curIdx: curIdx.value,
    answers,
    round: { total: items.value.length, correct: 0, wrongKeys: [], ms: 0 },
    rounds: [],
    startedAt: startedAt.value,
    extra: {
      examId: examId.value,
      durationMin: durationMin.value,
      multiRule: multiRule.value,
      itemElapsed: { ...itemElapsed },
      questionIds: paperRaw.value.map((q) => q.id)
    }
  }
}
function saveDraft() {
  if (phase.value !== 'card') return
  saveSession(SNAP_MODE, draftSnapshot())
}
function scheduleDraft() {
  if (phase.value !== 'card') return
  scheduleSave(SNAP_MODE, draftSnapshot())
}
function readDraft() {
  const d = loadSession(SNAP_MODE)
  return d && d.keys.length ? d : null
}
function clearDraft() {
  clearSession(SNAP_MODE)
}
watch(answers, scheduleDraft, { deep: true })

async function restoreDraft(d) {
  fetching.value = true
  try {
    durationMin.value = d.extra?.durationMin ?? 60
    multiRule.value = d.extra?.multiRule || 'partial'
    // 按 id 重拉试卷（practice_pool 保持传入顺序）；题目被删则缺项按未作答处理
    const ids = d.extra?.questionIds || parentIdsOf(d.keys)
    const raw = await practicePool({ ids })
    const ok = await beginExam(raw, d.extra?.examId || randomUUID(), d.startedAt || Date.now())
    if (!ok) { clearDraft(); return }
    // 恢复作答：uid 形如 `<题目id>_<序号>`，序号会随被删题目前移，因此按题目 id 重映射
    const qidOf = (k) => String(k).replace(/_\d+$/, '')
    const oldAnswers = new Map()
    for (const [k, v] of Object.entries(d.answers || {})) oldAnswers.set(qidOf(k), v)
    const oldElapsed = new Map()
    for (const [k, v] of Object.entries(d.extra?.itemElapsed || {})) oldElapsed.set(qidOf(k), v)
    const alive = new Set(items.value.map((it) => it.uid))
    const missing = d.keys.filter((k) => !alive.has(k))
    for (const it of items.value) {
      const a = oldAnswers.get(qidOf(it.uid))
      if (a) Object.assign(answers[it.uid], a)
      const e = oldElapsed.get(qidOf(it.uid))
      if (e !== undefined && itemElapsed[it.uid] !== undefined) itemElapsed[it.uid] = e
    }
    if (missing.length) toast(`有 ${missing.length} 项题目已被删除，已按未作答处理`, 'info')
    curIdx.value = Math.min(Math.max(0, d.curIdx || 0), items.value.length - 1)
    if (remainingMs.value <= 0 && durationMin.value > 0) {
      toast('草稿已超时，按到时交卷处理', 'info')
      submitPaper(true)
      return
    }
    itemStartTs = Date.now()
    saveDraft()
    focusCard()
  } catch (e) {
    console.error(e)
    error.value = '恢复模考草稿失败：' + (e?.message || e)
    clearDraft()
    phase.value = 'setup'
  } finally {
    fetching.value = false
  }
}

function ansForPaper(q) {
  if (q.type === 'material') {
    const children = {}
    ;(q.children || []).forEach((c, ci) => {
      const uid = idxMap[`${q.id}#${ci}`]
      const a = uid ? answers[uid] : null
      if (a) children[c.id] = ansPlain(a)
    })
    return { children }
  }
  const uid = idxMap[`${q.id}#-1`]
  return ansPlain(uid ? answers[uid] : {})
}
function ansPlain(a) {
  return {
    selected: a.selected || '',
    picked: [...(a.picked || [])],
    fillValues: { ...(a.fillValues || {}) },
    shortSelf: a.shortSelf || '',
    shortText: a.shortText || ''
  }
}

async function confirmSubmit() {
  const unanswered = items.value.length - answeredCount.value
  const ok = await confirmDialog({
    title: '交卷判分',
    message: unanswered > 0
      ? `还有 ${unanswered} 题未作答，交卷后按 0 分计。确定交卷？`
      : `共 ${items.value.length} 题已作答完毕，确定交卷？`,
    okText: '交卷',
    cancelText: '继续作答'
  })
  if (ok) submitPaper(false)
}

// 交卷：全卷统一判分落库（mode='exam'，不建 FSRS 卡；材料拆子题，一子题一条流水）
async function submitPaper(timeout = false) {
  if (phase.value !== 'card' || submitting.value) return
  stopTimer()
  if (cur.value) itemElapsed[cur.value.uid] += Date.now() - itemStartTs
  const opts = { multiRule: multiRule.value }
  const entries = paper.value.map((q, pi) => {
    const ans = ansForPaper(q)
    return { q, pi, ans, res: gradeQuestion(q, ans, { mode: 'exam', multiRule: opts.multiRule }) }
  })
  const records = []
  for (const e of entries) {
    if (e.q.type === 'material') {
      ;(e.q.children || []).forEach((c, ci) => {
        const res = e.res.children[ci]
        const uid = idxMap[`${e.q.id}#${ci}`]
        records.push({
          id: randomUUID(),
          question_id: e.q.id,
          mode: 'exam',
          grade: ratioToGrade(res.ratio),
          elapsed_ms: Math.round(uid ? itemElapsed[uid] || 0 : 0),
          detail: buildExamDetail(c, e.ans.children?.[c.id] || {}, res, {
            examId: examId.value, seq: e.pi + 1, childIndex: ci + 1, parentId: e.q.id, timeout
          })
        })
      })
    } else {
      const uid = idxMap[`${e.q.id}#-1`]
      records.push({
        id: randomUUID(),
        question_id: e.q.id,
        mode: 'exam',
        grade: ratioToGrade(e.res.ratio),
        elapsed_ms: Math.round(uid ? itemElapsed[uid] || 0 : 0),
        detail: buildExamDetail(e.q, e.ans, e.res, { examId: examId.value, seq: e.pi + 1, timeout })
      })
    }
  }
  submitting.value = true
  let saved = true
  try {
    await recordAnswer(records)
  } catch (err) {
    console.error('exam record_answer failed', err)
    saved = false
    toast('成绩落库失败：' + (err?.message || err) + '（草稿已保留，可再次交卷重试）', 'error', 6000)
  } finally {
    submitting.value = false
  }
  sheet.value = { ...summarizePaper(entries), entries, timeout, startedAt: startedAt.value, endedAt: Date.now() }
  if (saved) clearDraft()
  phase.value = 'result'
  if (saved) loadHistory()
}

// 成绩单展示辅助
function toggleRow(pi) {
  if (rowOpen.has(pi)) rowOpen.delete(pi)
  else rowOpen.add(pi)
}
function rowsOf(e) {
  if (e.q.type === 'material') {
    return (e.q.children || []).map((c, ci) => ({
      q: c, ans: e.ans?.children?.[c.id] || {}, res: e.res.children[ci], label: `第 ${ci + 1} 问`
    }))
  }
  return [{ q: e.q, ans: e.ans, res: e.res, label: '' }]
}
function letterOf(q, id) {
  const i = (q.options || []).findIndex((o) => o.id === id)
  return i >= 0 ? String.fromCharCode(65 + i) : ''
}
function lettersOf(q, ids) {
  return (ids || []).map((x) => letterOf(q, x)).filter(Boolean).join('、')
}
function isBlankOk(row, b) {
  return !!(row.res.blanks || []).find((r) => r.id === b.id && r.correct)
}
function refOf(q) {
  return q?.type === 'short' && q.answer?.reference ? renderDoc(q.answer.reference) : ''
}
function analysisOf(q) {
  return q?.analysis?.content?.length ? renderDoc(q.analysis) : ''
}
function excerptOf(q) {
  const t = String(q?.plain_text || '').trim().replace(/\s+/g, ' ')
  return t.length > 60 ? t.slice(0, 60) + '…' : (t || '（无题干文本）')
}
function fmtScore(n) {
  const v = Number(n) || 0
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10)
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
function fmtDate(iso) {
  const dt = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`
}
function fmtDur(s) {
  return fmtMs(Math.max(0, new Date(s.ended_at) - new Date(s.started_at)))
}

async function loadHistory() {
  try {
    const d = await examSessions(10)
    history.value = (d && d.items) || []
  } catch (e) {
    console.error(e)
    history.value = []
  }
}

// 错题重练：复用错题本的 retryIds 通道（练习模式判分，计入复习/错题本口径）
async function retryWrong() {
  const ids = (sheet.value?.wrong || []).map((e) => e.q.id)
  if (!ids.length) return
  const ok = await confirmDialog({
    title: '错题重练',
    message: `将按练习模式重练 ${ids.length} 道母题（材料题整题重练），判分计入复习与错题本口径。`,
    okText: '去重练',
    cancelText: '取消'
  })
  if (!ok) return
  sessionStorage.setItem('qbank.retryIds', JSON.stringify(ids))
  router.push('/practice?retry=1')
}

function restart() {
  phase.value = 'setup'
  sheet.value = null
  rowOpen.clear()
  error.value = ''
  loadHistory()
}

// 键盘流（与 Practice 同范式）：A–F 选题、M 切材料、Enter 下一题、填空回车跳空、简答看答案后 1/2 自评
function onCardKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if (ui.dialog) return
  if (phase.value !== 'card') return
  const t = e.target
  const inField = !!(t && t.closest && t.closest('textarea, select, input, [contenteditable], .tiptap, .ProseMirror'))
  if (e.key === 'Enter') {
    if (inField) return
    if (t && t.closest && t.closest('button')) return // 按钮上的回车走原生（选项勾选/交卷）
    e.preventDefault()
    if (curIdx.value < items.value.length - 1) go(curIdx.value + 1)
    return
  }
  if (inField) return
  const k = typeof e.key === 'string' ? e.key.toUpperCase() : ''
  // A–F 选题、M 切材料已由 QuestionRunner 处理；这里只保留简答自评
  if ((k === '1' || k === '2') && cur.value?.q.type === 'short' && curAns.value?.showRef) {
    curAns.value.shortSelf = k === '1' ? '不会' : '会'
  }
}
// 填空回车：跳下一空并全选；末空回车 → 下一题

function focusCard() {
  nextTick(() => {
    if (cardRef.value && cardRef.value.focus) cardRef.value.focus({ preventScroll: true })
  })
}

onBeforeUnmount(() => {
  stopTimer()
  if (phase.value === 'card') {
    flushSession(SNAP_MODE)
    saveDraft()
  }
})

onMounted(async () => {
  if (!bankStore.loaded) {
    try { await loadBanks() } catch (e) { console.error(e) }
  }
  bankId.value = resolveBankFilter('exam')
  loadHistory()
  const d = readDraft()
  if (d) {
    const go0 = await confirmDialog({
      title: '继续上次模考？',
      message: `检测到未交卷的模考草稿（约 ${d.keys.length} 题），可以继续作答；放弃则删除草稿重新开始。`,
      okText: '继续作答',
      cancelText: '放弃'
    })
    if (go0) {
      restoreDraft(d)
    } else {
      clearDraft()
    }
  }
})
</script>

<style scoped>
</style>
