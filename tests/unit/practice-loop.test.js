/**
 * 刷题完成闭环与弱项专练守卫（FE-P1-06）
 *
 * 这些推荐逻辑一旦选错，用户会被反复推去做已经很好的题型，
 * 而界面上完全看不出来「推荐错了」——只能靠测试锁住阈值与排序规则。
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '../..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const { rankWeakTypes, weakPracticeEntry, doneActions, parseAgainQuery, WEAK_MIN_ATTEMPTS, WEAK_RATE_THRESHOLD } =
  await import('../../src/utils/practiceLoop.js')

describe('弱项题型排序', () => {
  test('正确率最低的排第一', () => {
    const r = rankWeakTypes([
      { type: 'single', count: 10, correct: 9 },
      { type: 'multi', count: 5, correct: 1 },
      { type: 'judge', count: 10, correct: 6 }
    ])
    assert.equal(r[0].type, 'multi')
    assert.equal(r[0].rate, 0.2)
  })

  test('正确率达标的不进推荐（不推已经不错的题型）', () => {
    const r = rankWeakTypes([{ type: 'single', count: 10, correct: 8 }])
    assert.deepEqual(r, [])
    // 恰好等于阈值也算达标（阈值语义是「低于才弱」）
    assert.deepEqual(rankWeakTypes([{ type: 'single', count: 10, correct: WEAK_RATE_THRESHOLD * 10 }]), [])
  })

  test(`作答数不足 ${WEAK_MIN_ATTEMPTS} 次不参与（1 题答错不代表题型弱）`, () => {
    assert.deepEqual(rankWeakTypes([{ type: 'multi', count: WEAK_MIN_ATTEMPTS - 1, correct: 0 }]), [])
  })

  test('同正确率时错得多的优先', () => {
    const r = rankWeakTypes([
      { type: 'single', count: 10, correct: 5 },
      { type: 'multi', count: 20, correct: 10 }
    ])
    // 两者 rate 都是 0.5，multi 错 10 次 > single 错 5 次
    assert.equal(r[0].type, 'multi')
  })

  test('同正确率同错题数时样本大的优先', () => {
    const r = rankWeakTypes([
      { type: 'single', count: 4, correct: 2 },
      { type: 'judge', count: 8, correct: 4 }
    ])
    assert.equal(r[0].type, 'judge')
  })

  test('脏数据不抛异常也不产生 NaN', () => {
    for (const v of [null, undefined, 'x', [], [{}, { type: 'x' }, { type: 'y', count: 'a' }]]) {
      const r = rankWeakTypes(v)
      assert.ok(Array.isArray(r))
      for (const row of r) assert.ok(Number.isFinite(row.rate), `rate 必须是有限数：${JSON.stringify(row)}`)
    }
  })
})

describe('弱项专练入口', () => {
  test('取最弱一类并拼出 /practice?types=<type>', () => {
    const e = weakPracticeEntry({ by_type: [{ type: 'multi', count: 10, correct: 2 }] })
    assert.equal(e.type, 'multi')
    assert.match(e.href, /^\/practice\?types=multi$/)
  })

  test('带题库范围时同时带 bank 参数', () => {
    const e = weakPracticeEntry({ by_type: [{ type: 'multi', count: 10, correct: 2 }] }, 'bank_b')
    assert.match(e.href, /bank=bank_b/)
    assert.match(e.href, /types=multi/)
  })

  test('也接受裸 by_type 数组（调用方传法不同不该导致入口消失）', () => {
    const e = weakPracticeEntry([{ type: 'fill', count: 5, correct: 1 }])
    assert.equal(e.type, 'fill')
  })

  test('无弱项返回 null（界面显示「暂无弱项」而不是莫名其妙一个入口）', () => {
    assert.equal(weakPracticeEntry({ by_type: [] }), null)
    assert.equal(weakPracticeEntry(null), null)
    assert.equal(weakPracticeEntry({ by_type: [{ type: 'single', count: 10, correct: 10 }] }), null)
  })

  test('文案用注入的 labelOf（与页面同一套题型名）', () => {
    const e = weakPracticeEntry({ by_type: [{ type: 'multi', count: 10, correct: 2 }] }, '', (t) => `《${t}》`)
    assert.equal(e.label, '《multi》')
  })
})

describe('完成页动作', () => {
  test('三入口齐全：再来一轮 / 去复习 / 去错题本', () => {
    const a = doneActions({ types: ['single'], count: 10, bankId: 'bank_a' })
    assert.deepEqual(a.map((x) => x.key), ['again', 'review', 'wrong'])
    assert.deepEqual(a.map((x) => x.label), ['同配置再来一轮', '去复习', '去错题本'])
  })

  test('「再来一轮」完整复现上一轮的范围（题型 + 题量 + 题库）', () => {
    const [again] = doneActions({ types: ['single', 'multi'], count: 20, bankId: 'bank_a' })
    assert.match(again.href, /bank=bank_a/)
    assert.match(again.href, /types=single%2Cmulti/)
    assert.match(again.href, /count=20/)
    assert.match(again.href, /again=1/)
  })

  test('无题库/无题型时不留空参数', () => {
    const [again] = doneActions({ types: null, count: 0 })
    assert.equal(again.href, '/practice?again=1')
  })

  test('去复习/去错题本带题库范围（不让用户回默认全部）', () => {
    const [, review, wrong] = doneActions({ bankId: 'bank_b' })
    assert.equal(review.href, '/review?bank=bank_b')
    assert.equal(wrong.href, '/wrong?bank=bank_b')
    // 无题库时退化为裸路径
    const [, r2, w2] = doneActions({})
    assert.equal(r2.href, '/review')
    assert.equal(w2.href, '/wrong')
  })
})

describe('再来一轮参数解析', () => {
  const ALL = ['single', 'multi', 'judge', 'fill', 'short', 'material']

  test('合法题型与题量', () => {
    assert.deepEqual(parseAgainQuery({ types: 'single,multi', count: '20' }, ALL), { types: ['single', 'multi'], count: 20 })
  })

  test('非法题型被过滤，全非法则回落 null（而不是空数组）', () => {
    assert.equal(parseAgainQuery({ types: 'nope' }, ALL).types, null)
    assert.deepEqual(parseAgainQuery({ types: 'single,nope' }, ALL).types, ['single'])
  })

  test('题量越界/非整数回落 null', () => {
    for (const v of ['0', '-3', '501', '1.5', 'abc', undefined]) {
      assert.equal(parseAgainQuery({ count: v }, ALL).count, null, String(v))
    }
    assert.equal(parseAgainQuery({ count: '500' }, ALL).count, 500)
  })

  test('空 query 不抛异常', () => {
    assert.deepEqual(parseAgainQuery(null, ALL), { types: null, count: null })
  })
})

describe('视图接线（静态守卫）', () => {
  const practice = read('src/views/Practice.vue')
  const runner = read('src/components/question/QuestionRunner.vue')

  test('选项自身标绿/红：markOf + option-btn-right/wrong', () => {
    assert.match(runner, /function markOf\(id\)/)
    assert.match(runner, /option-btn-right/)
    assert.match(runner, /option-btn-wrong/)
    // 作答中绝不泄露答案
    assert.match(runner, /if \(!props\.locked\) return ''/)
  })

  test('选项样式必须在 uno.config 里成对定义（否则 DOM 正常、无颜色）', () => {
    const uno = read('uno.config.js')
    assert.match(uno, /\['option-btn-right'/)
    assert.match(uno, /\['option-btn-wrong'/)
  })

  test('完成页三入口 + 弱项专练卡片', () => {
    assert.match(practice, /同配置再来一轮/)
    assert.match(practice, /去复习/)
    assert.match(practice, /去错题本/)
    assert.match(practice, /weakPracticeEntry\(\{ by_type: ovByType\.value \}/)
    assert.match(practice, /function goWeakPractice/)
    assert.match(practice, /async function startAgain/)
  })

  test('弱项数据只在完成页拉取（作答中不打扰）', () => {
    assert.match(practice, /if \(p === 'done'\) ensureWeakData\(\)/)
    assert.match(practice, /recordsOverview/)
  })

  test('单题计时与难度标识（可选项）已落地', () => {
    assert.match(practice, /itemElapsedMs/)
    assert.match(practice, /function fmtClock/)
    assert.match(practice, /curDifficulty/)
    assert.match(practice, /difficulty-dots/)
  })

  test('同路由深链参数变化必须被 watch 到（否则「弱项专练」点了没反应）', () => {
    // 坑：完成页点弱项专练 / 再来一轮都是 router.push('/practice?…')，命中同一条路由，
    // 组件不重新挂载 → onMounted 的深链逻辑不再执行。实测表现是「hash 带了 types=multi，
    // 但题型还是上一轮的」。这里锁住 watch 的存在与覆盖的四个参数。
    assert.match(practice, /watch\(\s*\n?\s*\(\) => \[route\.query\.bank, route\.query\.types, route\.query\.count, route\.query\.again\]/)
    assert.match(practice, /if \(route\.query\.retry\) return/)
  })

  test('难度点阵样式是全局的（List 与 Practice 共用，scoped 会让第二处静默失效）', () => {
    const app = read('src/App.vue')
    assert.match(app, /\.difficulty-dots \{/)
    const list = read('src/views/List.vue')
    // List.vue 的 <style scoped> 里不应再定义它
    const styleBlock = list.slice(list.indexOf('<style scoped>'))
    assert.ok(!styleBlock.includes('.difficulty-dots {'), 'List.vue 仍在自己定义 difficulty-dots')
  })
})
