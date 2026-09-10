<template>
  <div class="page">
    <div v-if="error" class="error">{{ error }}</div>

    <!-- 设置面板 -->
    <section v-if="phase === 'setup'" class="card setup">
      <div class="card-head">
        <h2>开始刷题</h2>
        <span class="badge">练习模式 · 判分后计入复习</span>
      </div>

      <div class="field">
        <div class="label">题型（多选）</div>
        <div class="type-grid">
          <label
            v-for="t in ALL_TYPES"
            :key="t"
            class="chip"
            :class="{ on: selectedTypes.includes(t) }"
          >
            <input v-model="selectedTypes" type="checkbox" :value="t" />
            {{ TYPE_LABELS[t] }}
          </label>
        </div>
      </div>

      <div class="field">
        <div class="label">题量</div>
        <div class="count-row">
          <button
            v-for="c in COUNT_OPTIONS"
            :key="c.value"
            type="button"
            class="count-btn"
            :class="{ on: count === c.value }"
            @click="count = c.value"
          >
            {{ c.label }}
          </button>
        </div>
      </div>

      <div class="start-row">
        <button
          type="button"
          class="btn primary big"
          :disabled="!selectedTypes.length || fetching"
          @click="start"
        >
          {{ fetching ? '正在抽题…' : '开始刷题' }}
        </button>
      </div>
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
        <div v-if="showRef && !graded" class="self-grade">
          <span class="self-tip">这道题你会吗？</span>
          <button type="button" class="btn danger" @click="shortSubmit('不会')">不会</button>
          <button type="button" class="btn primary" @click="shortSubmit('会')">会</button>
        </div>
      </div>

      <!-- 提交 -->
      <div v-if="!graded && !isShort" class="submit-row">
        <button type="button" class="btn primary big" :disabled="!canSubmit" @click="submit">提交判分</button>
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

        <div v-if="recordError" class="record-warn">记录失败：{{ recordError }}</div>

        <div class="next-row">
          <button type="button" class="btn primary big" @click="next">下一题</button>
        </div>
      </div>
    </section>

    <!-- 结束页 -->
    <section v-else-if="phase === 'done'" class="card done">
      <div class="done-title">本轮练习结束 🎉</div>
      <div class="done-stats">
        <div class="done-stat">
          <div class="num">{{ lastRound.correct }} / {{ lastRound.total }}</div>
          <div class="lbl">答对题数</div>
        </div>
        <div class="done-stat">
          <div class="num">{{ lastRound.rate }}%</div>
          <div class="lbl">正确率</div>
        </div>
        <div class="done-stat">
          <div class="num">{{ fmtMs(lastRound.ms) }}</div>
          <div class="lbl">本轮用时</div>
        </div>
        <div class="done-stat" v-if="lastRound.wrong.length">
          <div class="num danger-num">{{ lastRound.wrong.length }}</div>
          <div class="lbl">错题数</div>
        </div>
      </div>

      <div v-if="rounds.length > 1" class="cum">
        累计：{{ sessionStats.total }} 题 · 答对 {{ sessionStats.correct }} ·
        共 {{ fmtMs(sessionStats.ms) }}
      </div>

      <div class="done-actions">
        <button
          v-if="lastRound.wrong.length"
          type="button"
          class="btn primary big"
          @click="startRedo"
        >
          错题重做（{{ lastRound.wrong.length }} 题）
        </button>
        <router-link to="/" class="btn big">返回首页</router-link>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { practicePool, recordAnswer, stats as fetchStats } from '@/api/practice.js'
import { renderDoc, renderOptions } from '@/utils/render.js'

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
const error = ref('')
const recordError = ref('')
const fetching = ref(false)

const selectedTypes = ref([...ALL_TYPES])
const count = ref(5)

const pool = ref([]) // 子题队列：普通题=1 项，material=每子题 1 项
const curIdx = ref(0)
const cur = computed(() => pool.value[curIdx.value])
const graded = ref(false)
const gradeResult = ref(null)
const startedAt = ref(0)
const materialOpen = ref(true)

// 作答状态
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
      questions = await practicePool({ limit, type: '' })
    } else {
      const per = Math.ceil(limit / types.length)
      const merged = []
      for (const t of types) {
        const part = await practicePool({ limit: per, type: t })
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
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
.card-head h2 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
.badge {
  display: inline-block; font-size: 12px; padding: 4px 10px;
  border-radius: 999px; border: 1px solid var(--line);
  color: var(--muted); background: var(--bg-accent); font-weight: 500;
}
.badge.type { color: var(--primary); border-color: var(--primary-border); background: var(--primary-bg); }

.field { margin-bottom: 20px; }
.label { font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 10px; }
.type-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 16px; border: 1px solid var(--line);
  border-radius: 999px; background: var(--card); color: var(--text-secondary);
  font-size: 14px; cursor: pointer; transition: all .15s ease; user-select: none;
}
.chip input { display: none; }
.chip.on { background: var(--primary-bg); border-color: var(--primary-border); color: var(--primary); font-weight: 600; }

.count-row { display: flex; gap: 8px; flex-wrap: wrap; }
.count-btn {
  padding: 8px 18px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--card); color: var(--text-secondary); cursor: pointer;
  font-size: 14px; font-weight: 500; transition: all .15s ease; box-shadow: var(--shadow-sm);
}
.count-btn:hover { background: var(--bg-accent); }
.count-btn.on { background: var(--text); color: #fff; border-color: var(--text); }

.start-row { margin-top: 8px; }

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
.btn.danger { border-color: #fecaca; color: var(--danger); background: #fff; }
.btn.danger:hover { background: var(--danger-bg); border-color: #fca5a5; }
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
.self-grade { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.self-tip { font-size: 13px; color: var(--muted); }

.submit-row { margin-top: 4px; }

.result {
  border-top: 1px solid var(--line); padding-top: 16px;
  display: flex; flex-direction: column; gap: 12px;
}
.verdict {
  font-size: 16px; font-weight: 700; padding: 12px 14px; border-radius: 10px;
}
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
.next-row { display: flex; justify-content: flex-end; }

.done { display: flex; flex-direction: column; gap: 20px; align-items: center; text-align: center; }
.done-title { font-size: 22px; font-weight: 800; letter-spacing: -0.01em; }
.done-stats { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; }
.done-stat {
  min-width: 150px; padding: 18px; border: 1px solid var(--line);
  border-radius: var(--radius); background: var(--bg-accent);
}
.done-stat .num { font-size: 24px; font-weight: 800; color: var(--text); }
.done-stat .num.danger-num { color: var(--danger); }
.done-stat .lbl { font-size: 12px; color: var(--muted); margin-top: 4px; }
.cum { font-size: 13px; color: var(--muted); }
.done-actions { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
</style>
