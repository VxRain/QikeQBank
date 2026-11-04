/**
 * 刷题反馈与完成闭环守卫（FE-P1-06）
 *
 * 这一组全是「写错了界面上看不出来」的口径：
 *   ① 判分标色：漏选的正确项不标绿 → 用户以为全对，只看到「回答错误」；
 *      未判分就标色 → 直接把答案泄露给用户。
 *   ② 单题计时：切走再切回从 0 重开 → 用户觉得「刚才白答了」。
 *   ③ 弱项排序：判反了 → 用户被反复推去做已经很好的题型。
 * 所以每条规则都在这里锁死，并单独说明「为什么是这个口径」。
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '../..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const {
  optionMarkOf, elapsedMsOf, fmtClock, rankWeakTypes, weakPracticeEntry, doneLinks,
  WEAK_MIN_ATTEMPTS, WEAK_RATE_THRESHOLD
} = await import('../../src/utils/practiceLoop.ts')

describe('判分后的选项标色（optionMarkOf）', () => {
  const q = { answer: { ids: ['o1', 'o3'] } }

  test('正确选项标绿——即使我没选它（漏选也要绿，否则看不出漏了哪个）', () => {
    assert.equal(optionMarkOf(q, 'o1', { picked: [] }, true), 'correct')
    assert.equal(optionMarkOf(q, 'o3', { picked: [] }, true), 'correct')
  })

  test('我选了但不在正确集合里 → 标红', () => {
    assert.equal(optionMarkOf(q, 'o2', { picked: ['o2'] }, true), 'wrong')
    // 多选：选对一半 + 选错一个 → 选错的才红，选对的绿
    assert.equal(optionMarkOf(q, 'o1', { picked: ['o1', 'o2'] }, true), 'correct')
    assert.equal(optionMarkOf(q, 'o2', { picked: ['o1', 'o2'] }, true), 'wrong')
  })

  test('单选（selected）与多选（picked）口径一致', () => {
    assert.equal(optionMarkOf(q, 'o2', { selected: 'o2' }, true), 'wrong')
    assert.equal(optionMarkOf(q, 'o1', { selected: 'o1' }, true), 'correct')
  })

  test('既不是答案、我也没选 → 不标', () => {
    assert.equal(optionMarkOf(q, 'o9', { picked: ['o2'] }, true), '')
  })

  test('**未判分恒返回空**：作答中绝不泄露答案', () => {
    // 这条是硬要求。locked=false 时哪怕答案已存在、我也选对了，也不能有标记
    for (const answer of [{ picked: ['o1'] }, { selected: 'o1' }, {}, { picked: ['o2'] }]) {
      for (const id of ['o1', 'o2', 'o3']) {
        assert.equal(optionMarkOf(q, id, answer, false), '', `locked=false 却给了标记：${id}`)
      }
    }
  })

  test('题目没答案/结构异常时不标（不能整列变红）', () => {
    for (const bad of [null, undefined, {}, { answer: {} }, { answer: { ids: [] } }, { answer: { ids: 'o1' } }]) {
      for (const locked of [true, false]) {
        assert.equal(optionMarkOf(bad, 'o1', { picked: ['o1'] }, locked), '', JSON.stringify(bad))
      }
    }
  })

  test('判断题同样走这套口径（正确答案 o1 / 我选 o2）', () => {
    const judge = { answer: { ids: ['o1'] } }
    assert.equal(optionMarkOf(judge, 'o1', { selected: 'o2' }, true), 'correct')
    assert.equal(optionMarkOf(judge, 'o2', { selected: 'o2' }, true), 'wrong')
  })
})

describe('单题计时（elapsedMsOf / fmtClock）', () => {
  test('不足 1 秒显示 0（一进页面就蹦 00:00 是噪声）', () => {
    assert.equal(elapsedMsOf({ base: 0, enteredAt: 1000, now: 1999 }), 0)
    assert.equal(elapsedMsOf({}), 0)
  })

  test('累计 + 本次段相加（切走再切回不从 0 重开）', () => {
    // 之前在本题待了 30s，这次又进来待了 15s → 45s
    assert.equal(elapsedMsOf({ base: 30000, enteredAt: 1000, now: 16000 }), 45000)
  })

  test('enteredAt=0 表示不在计时：只算累计', () => {
    assert.equal(elapsedMsOf({ base: 12000, enteredAt: 0, now: 999999 }), 12000)
  })

  test('取整到秒（向下），避免每帧数字抖动', () => {
    // 5.4s → 5s、5.9s → 5s：m:ss 显示不上浮，否则 tick 落点会让读数来回跳
    assert.equal(elapsedMsOf({ base: 5400 }), 5000)
    assert.equal(elapsedMsOf({ base: 5900 }), 5000)
    assert.equal(elapsedMsOf({ base: 5999 }), 5000)
    assert.equal(elapsedMsOf({ base: 6000 }), 6000)
  })

  test('脏数据不产生 NaN / 负数', () => {
    for (const cfg of [null, undefined, { base: 'x', enteredAt: 'y', now: 'z' }, { base: -5 }, { enteredAt: 9999, now: 1000 }]) {
      const v = elapsedMsOf(cfg || {})
      assert.ok(Number.isFinite(v) && v >= 0, `${JSON.stringify(cfg)} → ${v}`)
    }
  })

  test('mm:ss / 超 1 小时带小时位', () => {
    assert.equal(fmtClock(0), '00:00')
    assert.equal(fmtClock(9000), '00:09')
    assert.equal(fmtClock(65000), '01:05')
    assert.equal(fmtClock(3600000), '1:00:00')
    assert.equal(fmtClock(3661000), '1:01:01')
  })
})

describe('弱项题型排序（rankWeakTypes）', () => {
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
    assert.deepEqual(rankWeakTypes([{ type: 'single', count: 10, correct: 8 }]), [])
    // 恰好等于阈值也算达标（阈值语义是「低于才弱」）
    assert.deepEqual(rankWeakTypes([{ type: 'single', count: 10, correct: WEAK_RATE_THRESHOLD * 10 }]), [])
  })

  test(`作答数不足 ${WEAK_MIN_ATTEMPTS} 次不参与（1 题答错不代表这个题型弱）`, () => {
    assert.deepEqual(rankWeakTypes([{ type: 'multi', count: WEAK_MIN_ATTEMPTS - 1, correct: 0 }]), [])
    assert.equal(rankWeakTypes([{ type: 'multi', count: WEAK_MIN_ATTEMPTS, correct: 0 }]).length, 1)
  })

  test('同正确率时错得多的优先', () => {
    const r = rankWeakTypes([
      { type: 'single', count: 10, correct: 5 },
      { type: 'multi', count: 20, correct: 10 }
    ])
    assert.equal(r[0].type, 'multi') // 都是 50%，multi 错 10 > single 错 5
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

describe('弱项专练入口（weakPracticeEntry）', () => {
  test('取最弱一类并拼出 /practice?types=<type>&again=1', () => {
    const e = weakPracticeEntry({ by_type: [{ type: 'multi', count: 10, correct: 2 }] })
    assert.equal(e.type, 'multi')
    // again=1 是刻意的：弱项专练 = 「按这个题型开一轮新的」。
    // 少了它，在完成页点这个入口只会改 URL，phase 仍是 done → 用户点了没反应。
    assert.equal(e.href, '/practice?types=multi&again=1')
  })

  test('带题库范围时同时带 bank 参数', () => {
    const e = weakPracticeEntry({ by_type: [{ type: 'multi', count: 10, correct: 2 }] }, { bankId: 'bank_b' })
    assert.match(e.href, /bank=bank_b/)
    assert.match(e.href, /types=multi/)
  })

  test('也接受裸 by_type 数组（调用方传法不同不该让入口直接消失）', () => {
    assert.equal(weakPracticeEntry([{ type: 'fill', count: 5, correct: 1 }]).type, 'fill')
  })

  test('无弱项返回 null（不给无意义入口）', () => {
    assert.equal(weakPracticeEntry({ by_type: [] }), null)
    assert.equal(weakPracticeEntry(null), null)
    assert.equal(weakPracticeEntry({ by_type: [{ type: 'single', count: 10, correct: 10 }] }), null)
  })

  test('弱但该题型已无题可练 → 跳过它推下一个（推了点了就报错比不推更糟）', () => {
    const byType = [
      { type: 'multi', count: 10, correct: 1 },   // 最弱，但可用 0 题
      { type: 'fill', count: 10, correct: 4 }     // 次弱，可用 3 题
    ]
    const e = weakPracticeEntry({ by_type: byType }, { availableByType: { multi: 0, fill: 3 } })
    assert.equal(e.type, 'fill')
    // 全都没题可练 → 不给入口
    assert.equal(weakPracticeEntry({ by_type: byType }, { availableByType: { multi: 0, fill: 0 } }), null)
    // 不做可用性过滤（统计拉失败）时仍按弱项推荐
    assert.equal(weakPracticeEntry({ by_type: byType }, { availableByType: null }).type, 'multi')
  })

  test('文案用注入的 labelOf（与页面同一套题型全称）', () => {
    const e = weakPracticeEntry({ by_type: [{ type: 'multi', count: 10, correct: 2 }] }, { labelOf: (t) => `《${t}》` })
    assert.equal(e.label, '《multi》')
  })
})

describe('完成页闭环链接（doneLinks）', () => {
  test('带题库范围（不带的话用户点过去看到的是全部题库）', () => {
    assert.deepEqual(doneLinks('bank_b'), { review: '/review?bank=bank_b', wrong: '/wrong?bank=bank_b' })
  })

  test('无题库时候退化为裸路径', () => {
    assert.deepEqual(doneLinks(''), { review: '/review', wrong: '/wrong' })
    assert.deepEqual(doneLinks(), { review: '/review', wrong: '/wrong' })
  })

  test('题库 id 做 URL 编码（id 目前是 UUID，但别指望以后一直是）', () => {
    assert.equal(doneLinks('a b&c').wrong, '/wrong?bank=a%20b%26c')
  })
})

/**
 * 以下不测界面文案，测的是「接错线就静默失效」的地方：
 * 判定函数写好了但没接到模板、样式类写了但 UnoCSS 生成不出来、
 * 样式还在 scoped 里（第二处用到时静默无效）。
 */
describe('接线守卫', () => {
  const runner = read('src/components/question/QuestionRunner.vue')
  const practice = read('src/views/Practice.vue')
  const uno = read('uno.config.js')

  test('选项把 markOf 真的接进了模板（不是只写了函数）', () => {
    assert.match(runner, /:class="optionClass\(o\.id\)"/)
    assert.match(runner, /v-if="markOf\(o\.id\) === 'correct'"/)
    assert.match(runner, /v-else-if="markOf\(o\.id\) === 'wrong'"/)
    // 无障碍：颜色之外还要有语义（读屏用户看不到绿/红）
    assert.match(runner, /aria-label="正确答案"/)
    assert.match(runner, /aria-label="你选错了"/)
  })

  test('标色样式在 uno.config.js 里成对定义且带 !（否则 DOM 正常、无颜色）', () => {
    assert.match(uno, /\['option-btn-right',\s*'!bg-success-bg/)
    assert.match(uno, /\['option-btn-wrong',\s*'!bg-danger-bg/)
    // 必须自带 hover 配对：静态配色用了 !important 会把 base 的 hover 整体压掉
    assert.match(uno, /\['option-btn-right',\s*'[^']*hover:!bg-success-bg/)
    assert.match(uno, /\['option-btn-wrong',\s*'[^']*hover:!bg-danger-bg/)
  })

  test('难度点阵样式是全局的（List 与 Practice 共用，scoped 会让第二处静默失效）', () => {
    assert.match(read('src/App.vue'), /\.difficulty-dots \{/)
    const list = read('src/views/List.vue')
    const styleBlock = list.slice(list.indexOf('<style scoped>'))
    assert.ok(!styleBlock.includes('.difficulty-dots {'), 'List.vue 仍在 scoped 里定义 difficulty-dots')
    assert.match(practice, /class="difficulty-dots/, '作答卡没用到难度点阵')
  })

  test('完成页三入口齐全', () => {
    assert.match(practice, /同配置再来一轮/)
    assert.match(practice, /:to="doneLinksOf\.review"/)
    assert.match(practice, /:to="doneLinksOf\.wrong"/)
    assert.match(practice, /async function startAgain\(/)
  })

  test('弱项数据只在完成页拉取（作答中不打扰）', () => {
    assert.match(practice, /if \(p === 'done'\) ensureWeakData\(\)/)
    assert.match(practice, /recordsOverview/)
  })

  test('同路由深链参数变化必须被 watch 到（否则「弱项专练」点了没反应）', () => {
    // 坑：完成页点弱项专练/再来一轮都是 router.push('/practice?…')，命中同一条路由，
    // 组件不重新挂载 → onMounted 的深链逻辑不再执行。e2e 实测表现为「hash 带了
    // types=multi，但题型还是上一轮的」。
    assert.match(practice, /\(\) => \[route\.query\.bank, route\.query\.types, route\.query\.count, route\.query\.again\]/)
    assert.match(practice, /if \(route\.query\.retry\) return/)
  })

  test('计时在换题/判分处都要停（漏一处就会「松手后还在涨」）', () => {
    const body = (name) => {
      const i = practice.indexOf(`function ${name}(`)
      assert.ok(i > 0, `找不到 ${name}`)
      const open = practice.indexOf('{', i)
      let d = 0
      for (let j = open; j < practice.length; j += 1) {
        if (practice[j] === '{') d += 1
        else if (practice[j] === '}') { d -= 1; if (d === 0) return practice.slice(open + 1, j) }
      }
      return ''
    }
    assert.match(body('commit'), /pauseItemClock\(\)/)
    assert.match(body('jumpTo'), /pauseItemClock\(\)/)
    assert.match(body('startAgain'), /stopClockTimer\(\)/)
    // 卸载时必须停掉定时器，否则拖着一轮不结束会留个 setInterval
    assert.match(practice, /onBeforeUnmount\(stopClockTimer\)/)
  })

  test('「去复习 / 去错题本」的目标页真的认 ?bank=（否则带了也白带）', () => {
    assert.match(read('src/views/Review.vue'), /resolveBankFilter\('review', route\.query\.bank\)/)
    assert.match(read('src/views/Wrong.vue'), /resolveBankFilter\('wrong', route\.query\.bank\)/)
  })
})
