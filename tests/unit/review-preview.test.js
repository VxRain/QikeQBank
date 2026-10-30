import test from 'node:test'
import assert from 'node:assert/strict'

const { previewIntervals, formatInterval, revertPayloadOf, RATING_GRADES, REVERT_WINDOW_MS } =
  await import('../../src/utils/reviewPreview.js')

const NOW = new Date('2026-09-10T12:00:00.000Z')

function row(over = {}) {
  return {
    due_at: '2026-09-10T12:00:00.000Z',
    stability: 2.5,
    difficulty: 5,
    reps: 3,
    lapses: 0,
    state: 2,
    learning_steps: 0,
    scheduled_days: 3,
    last_reviewed_at: '2026-09-07T12:00:00.000Z',
    last_result: 'good',
    ...over
  }
}

test('formatInterval 分档：分钟/小时/天/月/年', () => {
  assert.equal(formatInterval(30_000), '<1m')
  assert.equal(formatInterval(0), '<1m')
  assert.equal(formatInterval(-1000), '<1m')
  assert.equal(formatInterval(60_000), '1m')
  assert.equal(formatInterval(10 * 60_000), '10m')
  assert.equal(formatInterval(59 * 60_000), '59m')
  assert.equal(formatInterval(2 * 3600_000), '2h')
  assert.equal(formatInterval(24 * 3600_000), '1d')
  assert.equal(formatInterval(3 * 24 * 3600_000), '3d')
  assert.equal(formatInterval(89 * 24 * 3600_000), '89d')
  assert.equal(formatInterval(180 * 24 * 3600_000), '6mo')
  assert.equal(formatInterval(800 * 24 * 3600_000), '2y')
  assert.equal(formatInterval(NaN), '<1m')
})

test('previewIntervals：四档齐全，again ≤ hard ≤ good ≤ easy', () => {
  const p = previewIntervals(row(), {}, NOW)
  assert.deepEqual(Object.keys(p).sort(), [...RATING_GRADES].sort())
  for (const g of RATING_GRADES) {
    assert.ok(p[g], `${g} 应有预览`)
    assert.equal(typeof p[g].label, 'string')
    assert.ok(p[g].ms > 0, `${g} 的间隔应为正数`)
    // dueAt 可被解析回同一时刻
    assert.equal(new Date(p[g].dueAt).getTime(), NOW.getTime() + p[g].ms)
  }
  assert.ok(p.again.ms <= p.hard.ms, 'again 不应比 hard 长')
  assert.ok(p.hard.ms <= p.good.ms, 'hard 不应比 good 长')
  assert.ok(p.good.ms <= p.easy.ms, 'good 不应比 easy 长')
})

test('previewIntervals：新卡（无复习态）也能出四档，且 again 落在学习步内', () => {
  const p = previewIntervals(null, {}, NOW)
  assert.ok(p)
  for (const g of RATING_GROUPS()) assert.ok(p[g])
  // 默认 learningSteps ['1m','10m']：again/hard 属于分钟级，不应直接跳到天
  assert.ok(p.again.ms <= 10 * 60_000, `again=${p.again.label} 应仍在学习步内`)
  function RATING_GROUPS() { return RATING_GRADES }
})

test('previewIntervals：不写库 —— 同一卡片连续预览两次结果一致', () => {
  const r = row()
  const a = previewIntervals(r, {}, NOW)
  const b = previewIntervals(r, {}, NOW)
  assert.deepEqual(a, b)
  // 入参对象未被改动（预览绝不能顺手把 due 推掉）
  assert.equal(r.due_at, '2026-09-10T12:00:00.000Z')
  assert.equal(r.reps, 3)
  assert.equal(r.stability, 2.5)
})

test('previewIntervals：设置不同 → 间隔不同（依赖设置而非常量）', () => {
  const r = row()
  const loose = previewIntervals(r, { requestRetention: 0.5 }, NOW)
  const tight = previewIntervals(r, { requestRetention: 0.97 }, NOW)
  // FSRS 语义：要求更高留存率 → 复习更勤 → 间隔更短
  assert.ok(tight.good.ms < loose.good.ms, `tight=${tight.good.label} 应短于 loose=${loose.good.label}`)
})

test('previewIntervals：坏行不抛错，整体返回可用结构', () => {
  // due_at 非法：cardFromRow 会兜底到 now，不应炸
  const p = previewIntervals({ ...row(), due_at: 'not-a-date', stability: NaN }, {}, NOW)
  assert.ok(p)
  assert.ok(RATING_GRADES.every((g) => p[g] === null || typeof p[g].label === 'string'))
})

test('revertPayloadOf：只挑后端认的字段，缺字段补 0', () => {
  const payload = revertPayloadOf(row())
  assert.deepEqual(Object.keys(payload).sort(), [
    'difficulty', 'due_at', 'last_result', 'last_reviewed_at',
    'lapses', 'learning_steps', 'reps', 'scheduled_days', 'stability', 'state'
  ].sort())
  assert.equal(payload.stability, 2.5)
  assert.equal(payload.due_at, '2026-09-10T12:00:00.000Z')

  // 部分字段缺失 → 数值补 0、时间保持 null，不产生 NaN
  const sparse = revertPayloadOf({ due_at: '2026-09-10T12:00:00.000Z' })
  assert.equal(sparse.stability, 0)
  assert.equal(sparse.reps, 0)
  assert.equal(sparse.last_reviewed_at, null)
  assert.equal(sparse.last_result, null)

  // 评分前没有复习态 → null，后端据此删整行
  assert.equal(revertPayloadOf(null), null)
})

test('撤销窗口常量为 5 秒（与 UI 约定一致）', () => {
  assert.equal(REVERT_WINDOW_MS, 5000)
})
