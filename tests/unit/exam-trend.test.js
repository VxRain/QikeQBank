import test from 'node:test'
import assert from 'node:assert/strict'

const { rateOf, buildTrend, trendSummary, buildReviewRows, enrichReviewItems, CHART } =
  await import('../../src/utils/examTrend.ts')

const s = (id, at, score, full) => ({ exam_id: id, started_at: at, score, full_score: full })

test('rateOf：得分率保留一位小数，full=0 不产生 NaN', () => {
  assert.equal(rateOf(s('a', '2026-01-01', 5, 10)), 50)
  assert.equal(rateOf(s('a', '2026-01-01', 2, 3)), 66.7)
  assert.equal(rateOf(s('a', '2026-01-01', 10, 10)), 100)
  assert.equal(rateOf(s('a', '2026-01-01', 0, 0)), 0)
  assert.equal(rateOf(s('a', '2026-01-01', 5, null)), 0)
  assert.equal(rateOf(null), 0)
})

test('buildTrend：空输入返回 null，单点也能画（居中）', () => {
  assert.equal(buildTrend([]), null)
  assert.equal(buildTrend(null), null)
  const one = buildTrend([s('e1', '2026-09-01T00:00:00Z', 5, 10)])
  assert.equal(one.points.length, 1)
  assert.equal(one.points[0].rate, 50)
  // 单点居中：x 在绘图区中点
  const mid = CHART.padL + (CHART.w - CHART.padL - CHART.padR) / 2
  assert.equal(one.points[0].x, Number(mid.toFixed(2)))
  assert.ok(one.path.startsWith('M'))
})

test('buildTrend：输入乱序也按时间升序（左旧右新）', () => {
  const t = buildTrend([
    s('e3', '2026-09-03T00:00:00Z', 9, 10),
    s('e1', '2026-09-01T00:00:00Z', 5, 10),
    s('e2', '2026-09-02T00:00:00Z', 7, 10)
  ])
  assert.deepEqual(t.points.map((p) => p.examId), ['e1', 'e2', 'e3'])
  assert.deepEqual(t.points.map((p) => p.rate), [50, 70, 90])
  // x 递增
  assert.ok(t.points[0].x < t.points[1].x && t.points[1].x < t.points[2].x)
  // y 递减（得分越高越靠上）
  assert.ok(t.points[0].y > t.points[1].y && t.points[1].y > t.points[2].y)
  assert.equal(t.first, 50)
  assert.equal(t.last, 90)
})

test('buildTrend：坐标都落在绘图区内（含 0% 与 100% 边界）', () => {
  const t = buildTrend([
    s('a', '2026-09-01T00:00:00Z', 0, 10),
    s('b', '2026-09-02T00:00:00Z', 10, 10)
  ])
  const right = CHART.w - CHART.padR
  const bottom = CHART.h - CHART.padB
  for (const p of t.points) {
    assert.ok(p.x >= CHART.padL - 0.01 && p.x <= right + 0.01, `x=${p.x} 越界`)
    assert.ok(p.y >= CHART.padT - 0.01 && p.y <= bottom + 0.01, `y=${p.y} 越界`)
  }
  // 100% 贴顶、0% 贴底
  assert.equal(t.points[1].y, CHART.padT)
  assert.equal(t.points[0].y, bottom)
})

test('buildTrend：全同分也能出图（area 有高度、不除零）', () => {
  const t = buildTrend([
    s('a', '2026-09-01T00:00:00Z', 6, 10),
    s('b', '2026-09-02T00:00:00Z', 6, 10),
    s('c', '2026-09-03T00:00:00Z', 6, 10)
  ])
  assert.equal(t.min, 60)
  assert.equal(t.max, 60)
  assert.equal(t.points.every((p) => p.y === t.points[0].y), true)
  assert.ok(t.areaPath.endsWith('Z'))
  // 网格三档
  assert.deepEqual(t.gridLines.map((g) => g.rate), [0, 50, 100])
})

test('trendSummary：不足两次给提示，涨跌/持平分明', () => {
  assert.equal(trendSummary([s('a', '2026-09-01', 5, 10)]).direction, 'flat')
  assert.match(trendSummary([]).label, /至少两次/)

  const up = trendSummary([s('a', '2026-09-01', 5, 10), s('b', '2026-09-02', 8, 10)])
  assert.equal(up.direction, 'up')
  assert.equal(up.delta, 30)
  assert.match(up.label, /\+30 个百分点/)

  const down = trendSummary([s('a', '2026-09-01', 8, 10), s('b', '2026-09-02', 5, 10)])
  assert.equal(down.direction, 'down')
  assert.match(down.label, /-30 个百分点/)

  const flat = trendSummary([s('a', '2026-09-01', 5, 10), s('b', '2026-09-02', 5, 10)])
  assert.equal(flat.direction, 'flat')
  assert.match(flat.label, /持平/)
})

test('buildReviewRows：正常行带出作答/得分/是否答对', () => {
  const rows = buildReviewRows([
    {
      record_id: 'r1',
      question_id: 'q1',
      answered_at: '2026-09-01T10:00:00Z',
      elapsed_ms: 4200,
      detail: { selected: ['o1'], score_earned: 5, full_score: 5 },
      question: { id: 'q1', type: 'single', stem: { t: 'stem' }, analysis: { t: 'an' } }
    },
    {
      record_id: 'r2',
      question_id: 'q2',
      detail: { selected: ['o2'], score_earned: 0, full_score: 5, unanswered: true },
      question: { id: 'q2', type: 'judge', stem: null, analysis: null }
    }
  ], (doc) => (doc ? `R:${doc.t}` : ''))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].index, 1)
  assert.equal(rows[0].stemHtml, 'R:stem')
  assert.equal(rows[0].analysisHtml, 'R:an')
  assert.deepEqual(rows[0].selected, ['o1'])
  assert.equal(rows[0].correct, true)
  assert.equal(rows[0].ratio, 1)
  assert.equal(rows[0].elapsedMs, 4200)
  assert.equal(rows[1].unanswered, true)
  assert.equal(rows[1].correct, false)
  assert.equal(rows[1].missing, false)
})

test('buildReviewRows：题被删时给出 missing 占位且不抛错', () => {
  const rows = buildReviewRows([
    { record_id: 'r1', question_id: 'gone', detail: { score_earned: 0, full_score: 5 }, question: null }
  ])
  assert.equal(rows[0].missing, true)
  assert.equal(rows[0].stemHtml, '')
  assert.equal(rows[0].full, 5)
  assert.equal(rows[0].type, '')
})

test('buildReviewRows：填空与简答形态', () => {
  const rows = buildReviewRows([
    { record_id: 'f', detail: { blanks: [{ id: 'b1', value: 'x', correct: true }], score_earned: 4, full_score: 4 }, question: { type: 'fill' } },
    { record_id: 's', detail: { my_answer: '我的答案', self_grade: '会', score_earned: 8, full_score: 10 }, question: { type: 'short' } }
  ])
  assert.equal(rows[0].blanks.length, 1)
  assert.equal(rows[0].blanks[0].correct, true)
  assert.equal(rows[1].myAnswer, '我的答案')
  assert.equal(rows[1].selfGrade, '会')
  assert.equal(rows[1].correct, true) // 8/10 = 0.8 ≥ 0.6，与成绩单「得分率 ≥ 0.6 算对」同口径
})

test('空输入不抛错', () => {
  assert.deepEqual(buildReviewRows(null), [])
  assert.deepEqual(buildReviewRows(undefined), [])
})

/* ══════════════════════════════════════════════════════════════════
 * enrichReviewItems：材料题子题切换 + 填空正确答案注入
 *
 * 这段逻辑原先写在 ExamHistory.vue 里（纯数据整理），迁到 examTrend.ts
 * 才可能被单测覆盖——SFC 未加 lang="ts"，且一行断言都没法写进组件。
 * 这里锁的是**回看的正确性**：切错子题 → 显示母题题面 + 裸选项 id；
 * 不注入正确答案 → 逐空行只有「我的答案」，看不出错在哪。
 * ══════════════════════════════════════════════════════════════════ */

const materialItem = () => ({
  record_id: 'r1',
  question_id: 'q1',
  answered_at: '2026-03-01T10:00:00.000Z',
  elapsed_ms: 1200,
  detail: { type: 'single', child_id: 'q1c2', child_index: 2 },
  question: {
    id: 'q1',
    type: 'material',
    stem: { type: 'doc', content: [{ t: '母题题面' }] },
    children: [
      { id: 'q1c1', type: 'single' },
      { id: 'q1c2', type: 'multi', answer: { blanks: [{ id: 'b1', answers: ['甲', '乙'] }] } }
    ]
  }
})

test('enrichReviewItems：按 detail.child_id 切到子题，并保留母题标记', () => {
  const [out] = enrichReviewItems([materialItem()])
  assert.equal(out.question.id, 'q1c2', '必须切到 detail.child_id 指向的子题')
  assert.equal(out.question.type, 'multi')
  assert.deepEqual(out.question._parentStem, { type: 'doc', content: [{ t: '母题题面' }] }, '母题题面要带上（模板提示用）')
  assert.equal(out.question._parentType, 'material')
  assert.equal(out.question._childIndex, 2, 'child_index 原样带到 _childIndex')
})

test('enrichReviewItems：把 question.answer.blanks 的正确答案并进 detail.blanks', () => {
  const [out] = enrichReviewItems([
    {
      ...materialItem(),
      detail: { child_id: 'q1c2', child_index: 2, blanks: [{ id: 'b1', value: '甲' }] }
    }
  ])
  const b = out.detail.blanks.find((x) => x.id === 'b1')
  assert.equal(b.value, '甲', '我的作答要保留')
  assert.deepEqual(b.answers, ['甲', '乙'], '正确答案要注入，否则逐空行看不出错在哪')
})

test('enrichReviewItems：无 child_id 时不切题（普通题原样返回）', () => {
  const plain = {
    record_id: 'r2',
    question_id: 'q2',
    detail: { type: 'judge' },
    question: { id: 'q2', type: 'judge', stem: { type: 'doc' } }
  }
  const [out] = enrichReviewItems([plain])
  assert.equal(out.question.id, 'q2')
  assert.equal(out.question._parentStem, undefined, '普通题不应被塞母题字段')
})

test('enrichReviewItems：空输入 / null 返回空数组（不抛）', () => {
  assert.deepEqual(enrichReviewItems([]), [])
  assert.deepEqual(enrichReviewItems(null), [])
  assert.deepEqual(enrichReviewItems(undefined), [])
})

test('enrichReviewItems：detail 为 null 时不炸，且 child 找不到时保留母题', () => {
  const [out] = enrichReviewItems([
    { record_id: 'r3', question_id: 'q3', detail: null, question: { id: 'q3', type: 'single' } }
  ])
  assert.equal(out.question.id, 'q3')
  const [miss] = enrichReviewItems([
    { ...materialItem(), detail: { child_id: 'nope', child_index: 1 } }
  ])
  assert.equal(miss.question.id, 'q1', '子题 id 对不上时不能把题面清空')
})

test('enrichReviewItems：null/缺失字段原样透传（与迁移前组件实现逐字等价）', () => {
  // 迁移时曾把 `detail:null` 洗成 `{}`、`question 缺失` 洗成 `null`——
  // 渲染看不出差别，但会改变下游的 `in` / `=== null` 判定。这里锁死等价性。
  const cases = [
    { name: 'detail 为 null', input: { record_id: 'r', question_id: 'q', detail: null, question: { id: 'q' } } },
    { name: 'detail 缺失', input: { record_id: 'r', question_id: 'q', question: { id: 'q' } } },
    { name: 'question 为 null', input: { record_id: 'r', question_id: 'q', detail: {}, question: null } },
    { name: 'question 缺失', input: { record_id: 'r', question_id: 'q', detail: {} } }
  ]
  for (const { name, input } of cases) {
    const [out] = enrichReviewItems([JSON.parse(JSON.stringify(input))])
    // 逐字段比对「键是否存在」与「值是否为 null」
    assert.deepEqual(
      { hasDetail: 'detail' in out, detail: out.detail ?? null, hasQuestion: 'question' in out, question: out.question ?? null },
      { hasDetail: 'detail' in input, detail: input.detail ?? null, hasQuestion: 'question' in input, question: input.question ?? null },
      `${name}：字段存在性与 null 语义必须与输入一致`
    )
  }
})
