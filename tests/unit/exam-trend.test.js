import test from 'node:test'
import assert from 'node:assert/strict'

const { rateOf, buildTrend, trendSummary, buildReviewRows, CHART } =
  await import('../../src/utils/examTrend.js')

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
