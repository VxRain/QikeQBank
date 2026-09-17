/**
 * fsrs.js 回归测试（node:test，无第三方依赖）：
 *  - 四键 grade→Rating 映射；非法 grade 抛错
 *  - cardFromRow↔toRow 往返（Date↔ISO、state、空 last_reviewed_at）
 *  - toLog 只存有效字段（废弃 elapsed_days 不存）
 *  - requestRetention 影响毕业卡间隔（确定性 now，真算）
 *  - getScheduler 按参数签名缓存/重建
 *
 * 运行：pnpm test:unit（node --test tests/unit/）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createEmpty,
  cardFromRow,
  toRow,
  toLog,
  answer,
  getScheduler,
  withDefaults,
  FSRS_DEFAULTS,
} from '../../src/utils/fsrs.js'

const T0 = new Date('2026-09-17T12:00:00.000Z')

describe('fsrs 调度封装', () => {
  it('空卡默认 New 态，due 为 Date', () => {
    const c = createEmpty(T0)
    assert.equal(c.state, 0)
    assert.ok(c.due instanceof Date)
    assert.equal(c.reps, 0)
  })

  it('四键映射可用，非法 grade 抛错', () => {
    for (const g of ['again', 'hard', 'good', 'easy']) {
      const { card, log } = answer(createEmpty(T0), g, {}, T0)
      assert.ok(card.due instanceof Date)
      assert.ok(log.review instanceof Date)
    }
    assert.throws(() => answer(createEmpty(T0), 'bogus', {}, T0), /invalid fsrs grade/)
  })

  it('cardFromRow↔toRow 往返无损', () => {
    const row = {
      due_at: '2026-09-20T12:00:00.000Z',
      stability: 5.5,
      difficulty: 4.2,
      reps: 3,
      lapses: 1,
      state: 2,
      learning_steps: 0,
      scheduled_days: 4,
      last_result: 'good',
      last_reviewed_at: '2026-09-16T12:00:00.000Z',
    }
    const back = toRow(cardFromRow(row, T0), 'good')
    assert.equal(back.due_at, row.due_at)
    assert.equal(back.stability, 5.5)
    assert.equal(back.state, 2)
    assert.equal(back.last_result, 'good')
    assert.equal(back.last_reviewed_at, row.last_reviewed_at)
    // 空行 → 空卡；last_reviewed_at 缺省 → null
    const empty = toRow(cardFromRow(null, T0), 'again')
    assert.equal(empty.state, 0)
    assert.equal(empty.last_reviewed_at, null)
    assert.equal(empty.last_result, 'again')
  })

  it('toLog 只存有效字段', () => {
    const { log } = answer(createEmpty(T0), 'good', {}, T0)
    const snap = toLog(log)
    assert.equal(typeof snap.rating, 'number')
    assert.equal(typeof snap.due, 'string')
    assert.equal(typeof snap.review, 'string')
    assert.ok(!('elapsed_days' in snap))
    assert.ok(!('last_elapsed_days' in snap))
  })

  it('requestRetention 越低毕业间隔越长（真算，确定性时间）', () => {
    const graduate = (ret) => {
      let c = createEmpty(T0)
      c = answer(c, 'good', { requestRetention: ret }, T0).card
      c = answer(c, 'good', { requestRetention: ret }, new Date('2026-09-17T12:10:00.000Z')).card
      return c
    }
    const loose = graduate(0.85)
    const strict = graduate(0.9)
    assert.equal(loose.state, 2)
    assert.equal(strict.state, 2)
    assert.ok(loose.due > strict.due)
  })

  it('getScheduler 按参数签名缓存，变参重建', () => {
    const a = getScheduler({ requestRetention: 0.9 })
    const b = getScheduler({ requestRetention: 0.9 })
    assert.equal(a, b)
    const c = getScheduler({ requestRetention: 0.85 })
    assert.notEqual(a, c)
  })

  it('withDefaults 缺键补默认', () => {
    const p = withDefaults({})
    assert.equal(p.requestRetention, FSRS_DEFAULTS.requestRetention)
    assert.deepEqual(p.learningSteps, ['1m', '10m'])
    const q = withDefaults({ requestRetention: 0.8, learningSteps: ['5m'] })
    assert.equal(q.requestRetention, 0.8)
    assert.deepEqual(q.learningSteps, ['5m'])
  })
})
