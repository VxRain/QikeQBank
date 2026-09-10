<template>
  <div class="page">
    <div v-if="error" class="error">{{ error }}</div>

    <!-- 等待复习（due） -->
    <section v-if="phase === 'due'" class="card due">
      <div class="card-head">
        <h2>间隔复习</h2>
        <span class="badge type">SM-2</span>
      </div>
      <p class="due-desc">
        当前待复习 <b>{{ dueTotal }}</b> 题，今日到期 <b>{{ dueToday }}</b> 题。
        按遗忘曲线安排，每次最多复习 20 题。
      </p>

      <div class="field">
        <div class="label">题库</div>
        <select v-model="bankId" class="select">
          <option value="">全部题库</option>
          <option v-for="b in bankStore.banks" :key="b.id" :value="b.id">{{ b.name }}</option>
        </select>
      </div>

      <div class="start-row">
        <button
          type="button"
          class="btn primary big"
          :disabled="dueLoading"
          @click="start"
        >
          {{ dueLoading ? '正在拉取复习题目…' : '开始复习' }}
        </button>
      </div>
    </section>

    <section v-else-if="phase === 'loading'" class="card loading">
      <span class="badge type">复习</span>
      <div class="loading-text">正在准备复习题目…</div>
    </section>

    <!-- 作答卡片 -->
    <section v-else-if="phase === 'card'" class="card q-card">
      <div class="progress-row">
        <span class="badge type">{{ curBadge }}</span>
        <span class="q-pos">第 {{ curIdx + 1 }} / {{ pool.length }} 题</span>
      </div>
      <div class="progress-bar"><div class="progress-inner" :style="{ width: progressPct + '%' }"></div></div>

      <div v-if="cur.isChild" class="material-stem">
        <div class="material-head">
          <button type="button" class="btn small" @click="materialOpen = !materialOpen">
            {{ materialOpen ? '收起' : '展开' }}材料
          </button>
        </div>
        <div v-if="materialOpen" class="material-doc" v-html="materialStemHtml"></div>
        <div v-else class="material-tip">共 {{ cur.childCount }} 问 · 正在作答第 {{ cur.childIdx + 1 }} 问</div>
      </div>

      <div class="stem" :key="cur.uid" v-html="stemHtml" @input="onStemInput"></div>

      <!-- 选择类 -->
      <div v-if="isChoice" class="options">
        <button
          v-for="(o, i) in cur.q.options || []"
          :key="o.id"
          type="button"
          class="option-btn"
          :class="{ on: singlePick === o.id }"
          @click="singlePick = o.id"
        >
          <span class="key">{{ keyOf(i) }}</span>
          <span class="opt-body" v-html="optHtml(o)"></span>
        </button>
      </div>
      <div v-else-if="cur.q.type === 'multi'" class="options">
        <button
          v-for="(o, i) in cur.q.options || []"
          :key="o.id"
          type="button"
          class="option-btn"
          :class="{ on: multiPick.includes(o.id) }"
          @click="toggleMulti(o.id)"
        >
          <span class="key">{{ keyOf(i) }}</span>
          <span class="opt-body" v-html="optHtml(o)"></span>
        </button>
      </div>

      <!-- 简答 -->
      <div v-else-if="cur.q.type === 'short'" class="short-block">
        <textarea v-model="shortText" rows="5" placeholder="请输入你的答案…"></textarea>
        <div class="short-actions">
          <button type="button" class="btn" @click="showRef = !showRef">
            {{ showRef ? '收起参考答案' : '查看参考答案' }}
          </button>
        </div>
        <div v-if="showRef" class="ref-box">
          <b class="ref-title">参考答案：</b>
          <div v-html="refHtml"></div>
        </div>
      </div>

      <!-- 自动判分（选择/填空） -->
      <div v-if="!graded && !isShort" class="submit-row">
        <button type="button" class="btn primary big" :disabled="!canSubmit" @click="submit">判分</button>
      </div>

      <!-- 判分结果（判分前绝不展示答案/解析） -->
      <div v-if="graded" class="result">
        <div class="verdict" :class="gradeResult.correct ? 'ok' : 'no'">
          {{ gradeResult.correct ? '✓ 回答正确' : '✗ 回答错误' }}
        </div>

        <div v-if="isChoice && gradeResult" class="answer-view" v-html="answerHtml"></div>

        <div v-if="cur.q.type === 'fill'" class="blank-results">
          <div v-for="r in gradeResult.results" :key="r.id" class="blank-res" :class="r.correct ? 'ok' : 'no'">
            <span class="blank-id">{{ r.id }}</span>
            <span class="blank-you">你的答案：{{ r.value || '（未填写）' }}</span>
            <span class="verdict-inline">{{ r.correct ? '✓' : '✗' }}</span>
            <span v-if="!r.correct" class="blank-ans">
              正确答案：{{ blankAnswersOf(r.id) }}
            </span>
          </div>
        </div>

        <div v-if="analysisHtml" class="analysis">
          <b class="analysis-title">解析：</b>
          <div v-html="analysisHtml"></div>
        </div>
      </div>

      <div v-if="recordError" class="record-warn">记录失败：{{ recordError }}</div>

      <!-- 四键自评：判分后(选择/填空)或查看参考答案后(简答)出现 -->
      <div v-if="canSelfGrade" class="grade-row">
        <span class="grade-tip">自评记忆效果：</span>
        <button type="button" class="btn grade-again" :disabled="submitting" @click="reviewGrade('again')">忘记 (again)</button>
        <button type="button" class="btn grade-hard" :disabled="submitting" @click="reviewGrade('hard')">困难 (hard)</button>
        <button type="button" class="btn grade-good" :disabled="submitting" @click="reviewGrade('good')">良好 (good)</button>
        <button type="button" class="btn grade-easy" :disabled="submitting" @click="reviewGrade('easy')">简单 (easy)</button>
      </div>
    </section>

    <!-- 结束页 -->
    <section v-else-if="phase === 'done'" class="card done">
      <div class="done-title">本轮复习完成 ✅</div>
      <div class="done-stats">
        <div class="done-stat">
          <div class="num">{{ reviewedCount }}</div>
          <div class="lbl">复习题数</div>
        </div>
        <div class="done-stat">
          <div class="num">{{ fmtMs(roundMs) }}</div>
          <div class="lbl">用时</div>
        </div>
        <div class="done-stat">
          <div class="num danger-num">{{ gradesCount.again }}</div>
          <div class="lbl">忘记</div>
        </div>
        <div class="done-stat">
          <div class="num">{{ gradesCount.hard }}</div>
          <div class="lbl">困难</div>
        </div>
        <div class="done-stat">
          <div class="num success-num">{{ gradesCount.good }}</div>
          <div class="lbl">良好</div>
        </div>
        <div class="done-stat">
          <div class="num success-num">{{ gradesCount.easy }}</div>
          <div class="lbl">简单</div>
        </div>
      </div>

      <div class="cum">
        {{ reviewedCount }} 题中 {{ gradesCount.good + gradesCount.easy }} 题自评良好及以上
        · 剩余待复习 {{ remainingDue == null ? '—' : remainingDue }} 题
      </div>

      <div class="done-actions">
        <button v-if="remainingDue > 0" type="button" class="btn primary big" @click="backToDue">再复习一轮</button>
        <router-link to="/" class="btn big">返回首页</router-link>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { reviewDue, recordAnswer, stats as fetchStats } from '@/api/practice.js'
import { renderDoc, renderOptions } from '@/utils/render.js'
import { bankStore } from '@/stores/bank.js'

const TYPE_LABELS = {
  single: '单选题', multi: '多选题', judge: '判断题', fill: '填空题', short: '简答题', material: '材料题'
}

const phase = ref('due') // due | loading | card | done
const bankId = ref(bankStore.currentBankId || '')
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

async function refreshDue() {
  try {
    const s = await fetchStats()
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
      error.value = '当前没有待复习的题目，先在“刷题”中练习吧！'
      return
    }
    reviewedCount.value = 0
    roundMs.value = 0
    gradesCount.again = 0; gradesCount.hard = 0; gradesCount.good = 0; gradesCount.easy = 0
    curIdx.value = 0
    resetAnswer()
    startedAt.value = Date.now()
    phase.value = 'card'
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

onMounted(refreshDue)
</script>

<style scoped>
.page { display: flex; flex-direction: column; gap: 16px; }
.error {
  color: #b91c1c; background: var(--danger-bg); border: 1px solid #fecaca;
  padding: 12px; border-radius: 10px;
}
.card {
  background: var(--card); border: 1px solid var(--line);
  border-radius: var(--radius-lg); padding: 24px; box-shadow: var(--shadow);
}
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.card-head h2 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
.badge {
  display: inline-block; font-size: 12px; padding: 4px 10px;
  border-radius: 999px; border: 1px solid var(--line);
  color: var(--muted); background: var(--bg-accent); font-weight: 500;
}
.badge.type { color: var(--primary); border-color: var(--primary-border); background: var(--primary-bg); }

.due { max-width: 640px; }
.due-desc { color: var(--text-secondary); font-size: 14px; line-height: 1.8; margin: 0 0 18px; }
.due-desc b { color: var(--primary); font-size: 18px; }
.field { margin-bottom: 18px; }
.label { font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 10px; }
.select {
  width: 100%; max-width: 320px; padding: 9px 12px;
  border: 1px solid var(--line-strong); border-radius: 10px;
  font-size: 14px; color: var(--text); background: var(--card);
  outline: none; box-shadow: var(--shadow-sm); font-family: inherit; cursor: pointer;
}
.select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(14,165,233,.15); }
.start-row { display: flex; }
.loading { display: flex; align-items: center; gap: 12px; }
.loading-text { color: var(--muted); }

.btn {
  padding: 8px 14px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--card); color: var(--text-secondary); cursor: pointer;
  font-size: 13px; font-weight: 500;
  transition: all .15s ease; box-shadow: var(--shadow-sm);
  text-decoration: none !important; display: inline-flex; align-items: center; justify-content: center;
}
.btn:hover { background: var(--bg-accent); border-color: var(--line-strong); transform: translateY(-1px); box-shadow: var(--shadow); }
.btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
.btn.primary { background: var(--text); color: #fff; border-color: var(--text); }
.btn.primary:hover { background: #1e293b; }
.btn.big { padding: 10px 22px; font-size: 15px; border-radius: 12px; }
.btn.small { padding: 6px 12px; font-size: 12px; border-radius: 8px; }

.q-card { display: flex; flex-direction: column; gap: 14px; }
.progress-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.q-pos { font-size: 13px; color: var(--muted); font-weight: 500; }
.progress-bar { height: 6px; background: var(--bg-accent); border-radius: 999px; overflow: hidden; }
.progress-inner { height: 100%; background: var(--primary); border-radius: 999px; transition: width .25s ease; }

.material-stem {
  border: 1px dashed var(--primary-border); background: var(--bg-accent);
  border-radius: var(--radius); padding: 12px 14px;
}
.material-head { display: flex; justify-content: flex-end; margin-bottom: 8px; }
.material-doc { font-size: 13px; color: var(--text-secondary); }
.material-tip { font-size: 12px; color: var(--muted); }

.stem { line-height: 1.8; color: var(--text-secondary); }
.stem :deep(p) { margin: 10px 0; }
.stem :deep(figure) { margin: 14px 0; text-align: center; }
.stem :deep(img) { max-width: 100%; border-radius: 8px; border: 1px solid var(--line); background: #fff; }
.stem :deep(.math-block) { margin: 12px 0; padding: 12px; background: var(--bg-accent); border: 1px solid var(--line); border-radius: 8px; text-align: center; }
.stem :deep(.qb-fill-input) {
  min-width: 92px; padding: 6px 10px; margin: 0 4px;
  border: 1px solid var(--line-strong); border-bottom: 2px solid var(--primary);
  border-radius: 8px; font-size: 14px; color: var(--text); background: var(--card);
  outline: none; transition: all .15s ease; box-shadow: var(--shadow-sm);
}
.stem :deep(.qb-fill-input:focus) { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(14,165,233,.15); }

.options { display: flex; flex-direction: column; gap: 8px; }
.option-btn {
  display: flex; align-items: flex-start; gap: 8px; text-align: left;
  padding: 10px 14px; border: 1px solid var(--line); border-radius: 10px;
  background: var(--card); color: var(--text-secondary); cursor: pointer;
  font-size: 14px; line-height: 1.6; transition: all .15s ease; box-shadow: var(--shadow-sm);
}
.option-btn:hover { background: var(--bg-accent); border-color: var(--line-strong); }
.option-btn.on { background: var(--primary-bg); border-color: var(--primary-border); color: var(--text); box-shadow: 0 0 0 3px rgba(14,165,233,.12); }
.option-btn .key { font-weight: 700; color: var(--primary); margin-right: 2px; flex-shrink: 0; }
.option-btn.on .key { color: var(--primary-hover); }
.opt-body :deep(p) { margin: 0; }

.short-block { display: flex; flex-direction: column; gap: 10px; }
.short-block textarea {
  width: 100%; padding: 12px; border: 1px solid var(--line); border-radius: 10px;
  font: inherit; font-size: 14px; color: var(--text); background: var(--card);
  outline: none; resize: vertical; box-shadow: var(--shadow-sm);
}
.short-block textarea:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(14,165,233,.15); }
.short-actions { display: flex; gap: 8px; }
.ref-box {
  padding: 12px 14px; background: var(--success-bg); border: 1px solid #a7f3d0;
  border-radius: 10px; font-size: 14px; line-height: 1.7; color: var(--text-secondary);
}
.ref-title { color: var(--success); }
.ref-box :deep(p) { margin: 6px 0; }

.submit-row { margin-top: 4px; }

.result {
  border-top: 1px solid var(--line); padding-top: 16px;
  display: flex; flex-direction: column; gap: 12px;
}
.verdict { font-size: 16px; font-weight: 700; padding: 12px 14px; border-radius: 10px; }
.verdict.ok { color: var(--success); background: var(--success-bg); border: 1px solid #a7f3d0; }
.verdict.no { color: var(--danger); background: var(--danger-bg); border: 1px solid #fecaca; }
.answer-view {
  border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px;
  background: var(--bg-accent); font-size: 14px;
}
.answer-view :deep(.option) { padding: 6px 8px; border-radius: 8px; }
.answer-view :deep(.option.correct) { color: var(--success); font-weight: 600; }
.answer-view :deep(.key) { font-weight: 700; color: var(--primary); margin-right: 6px; }
.answer-view :deep(p) { margin: 4px 0; }
.blank-results { display: flex; flex-direction: column; gap: 6px; }
.blank-res {
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  padding: 8px 12px; border-radius: 8px; font-size: 13px;
  border: 1px solid var(--line);
}
.blank-res.ok { background: var(--success-bg); border-color: #a7f3d0; color: var(--text-secondary); }
.blank-res.no { background: var(--danger-bg); border-color: #fecaca; color: var(--text-secondary); }
.blank-id { font-weight: 700; color: var(--text); }
.blank-ans { color: var(--danger); font-weight: 500; }
.verdict-inline { font-weight: 700; }
.blank-res.ok .verdict-inline { color: var(--success); }
.blank-res.no .verdict-inline { color: var(--danger); }
.analysis {
  padding: 12px 14px; background: var(--bg-accent); border: 1px solid var(--line);
  border-radius: 10px; font-size: 14px; line-height: 1.7; color: var(--text-secondary);
}
.analysis-title { color: var(--primary); }
.analysis :deep(p) { margin: 6px 0; }
.record-warn { font-size: 12px; color: var(--danger); }

.grade-row {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  border-top: 1px solid var(--line); padding-top: 14px;
}
.grade-tip { font-size: 13px; color: var(--muted); font-weight: 600; }
.grade-row .btn { padding: 8px 12px; }
.btn.grade-again { background: var(--danger-bg); border-color: #fecaca; color: var(--danger); }
.btn.grade-again:hover { border-color: #fca5a5; }
.btn.grade-hard { background: #fff7ed; border-color: #fed7aa; color: #ea580c; }
.btn.grade-hard:hover { border-color: #fdba74; }
.btn.grade-good { background: var(--success-bg); border-color: #a7f3d0; color: var(--success); }
.btn.grade-good:hover { border-color: #6ee7b7; }
.btn.grade-easy { background: var(--primary-bg); border-color: var(--primary-border); color: var(--primary); }
.btn.grade-easy:hover { border-color: var(--primary); }

.done { display: flex; flex-direction: column; gap: 20px; align-items: center; text-align: center; }
.done-title { font-size: 22px; font-weight: 800; letter-spacing: -0.01em; }
.done-stats { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; }
.done-stat {
  min-width: 120px; padding: 18px; border: 1px solid var(--line);
  border-radius: var(--radius); background: var(--bg-accent);
}
.done-stat .num { font-size: 24px; font-weight: 800; color: var(--text); }
.done-stat .num.danger-num { color: var(--danger); }
.done-stat .num.success-num { color: var(--success); }
.done-stat .lbl { font-size: 12px; color: var(--muted); margin-top: 4px; }
.cum { font-size: 13px; color: var(--muted); }
.done-actions { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
</style>
