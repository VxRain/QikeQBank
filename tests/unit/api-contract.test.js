import test from 'node:test'
import assert from 'node:assert/strict'
import { cmd, unwrap, setProvider } from '../../src/api/bridge.js'
import { list as listQuestions, get as getQuestion } from '../../src/api/questions.js'
import { listBanks } from '../../src/api/banks.js'
import { stats, isPortableMode } from '../../src/api/practice.js'

// FE-ARCH-06 契约守卫：信封只允许在 bridge.unwrap 处拆，页面/调用方只拿业务数据。
function withProvider(invoke, fn) {
  setProvider({ invoke })
  return Promise.resolve()
    .then(fn)
    .finally(() => setProvider(null))
}

test('unwrap: 成功信封取 data', () => {
  assert.deepEqual(unwrap({ success: true, data: { total: 2, items: [] } }), { total: 2, items: [] })
  assert.equal(unwrap({ success: true, data: null }), null)
})

test('unwrap: success=false 抛可读错误', () => {
  assert.throws(() => unwrap({ success: false, error: 'boom' }), /boom/)
  assert.throws(() => unwrap({ success: false }), /操作失败/)
})

test('unwrap: 非信封返回值原样透传（provider 可直给 data）', () => {
  assert.deepEqual(unwrap([1, 2]), [1, 2])
  assert.equal(unwrap(null), null)
  assert.equal(unwrap(undefined), undefined)
})

test('questions_list: 拆包后为 {total, items}', async () => {
  const calls = []
  await withProvider(
    async (name, args) => {
      calls.push([name, args])
      return { success: true, data: { total: 1, items: [{ id: 'q1', type: 'single' }] } }
    },
    async () => {
      const data = await listQuestions({ query: '', type: 'single', bankId: 'b1', limit: 50, offset: 100, summary: true })
      assert.deepEqual(data, { total: 1, items: [{ id: 'q1', type: 'single' }] })
    }
  )
  assert.equal(calls[0][0], 'questions_list')
  // 空 query 不下传；type/typeFilter 双写法都映射到 typeFilter
  assert.deepEqual(calls[0][1], { typeFilter: 'single', bankId: 'b1', limit: 50, offset: 100, summary: true })
})

test('questions_get: 返回题目本体而非信封', async () => {
  await withProvider(
    async () => ({ success: true, data: { id: 'q9', type: 'fill' } }),
    async () => {
      assert.deepEqual(await getQuestion('q9'), { id: 'q9', type: 'fill' })
    }
  )
})

test('banks_list: 直给数组的 provider 也能用', async () => {
  await withProvider(
    async () => [{ id: 'b1', name: '默认' }],
    async () => {
      assert.deepEqual(await listBanks(), [{ id: 'b1', name: '默认' }])
    }
  )
})

test('review_stats: 统计字段透传', async () => {
  await withProvider(
    async () => ({ success: true, data: { total: 3, due_today: 1, correct_rate: 66.7 } }),
    async () => {
      const s = await stats('b1')
      assert.equal(s.due_today, 1)
      assert.equal(s.correct_rate, 66.7)
    }
  )
})

test('is_portable_mode: 收敛为布尔', async () => {
  await withProvider(
    async () => ({ success: true, data: { portable: true } }),
    async () => {
      assert.equal(await isPortableMode(), true)
    }
  )
})

test('cmd: 后端 Err（reject）原样抛出，不被 unwrap 吞掉', async () => {
  await withProvider(
    async () => {
      throw new Error('bank not found: b0')
    },
    async () => {
      await assert.rejects(() => listBanks(), /bank not found/)
      await assert.rejects(() => cmd('banks_list'), /bank not found/)
    }
  )
})
