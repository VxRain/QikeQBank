import test from 'node:test'
import assert from 'node:assert/strict'
import {
  QUESTION_TYPES,
  QUESTION_TYPE_KEYS,
  CHILD_QUESTION_TYPES,
  TYPE_LABELS,
  TYPE_ALIASES,
  typeLabel,
  typeIcon,
  hasOptions,
  defaultScoreOf,
  defaultDifficultyOf,
  isQuestionType
} from '../../src/constants/questions.js'

// FE-ARCH-01 守卫：题型元数据只有这一份，任何"改名/加类型"都必须先过这里。
test('QUESTION_TYPES: 六个题型、key 唯一、order 递增', () => {
  assert.equal(QUESTION_TYPES.length, 6)
  assert.equal(new Set(QUESTION_TYPE_KEYS).size, 6)
  assert.deepEqual(QUESTION_TYPE_KEYS, ['single', 'multi', 'judge', 'fill', 'short', 'material'])
  const orders = QUESTION_TYPES.map((t) => t.order)
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b))
  for (const t of QUESTION_TYPES) {
    assert.ok(t.label && t.shortLabel && t.fullLabel && t.icon, `${t.key} 字段缺失`)
    assert.ok(Number.isFinite(t.defaultScore) && Number.isFinite(t.defaultDifficulty), `${t.key} 默认值缺失`)
  }
})

test('题型命名口径：short 统一为「简答/简答题」', () => {
  assert.equal(typeLabel('short'), '简答')
  assert.equal(typeLabel('short', { full: true }), '简答题')
  assert.equal(typeLabel('short', true), '简答题')
  assert.equal(TYPE_LABELS.short, '简答')
})

test('未知题型保持旧行为：回显原 key（key 为空时给 -）', () => {
  assert.equal(typeLabel('ranking'), 'ranking')
  assert.equal(typeLabel(''), '-')
  assert.equal(typeLabel(undefined), '-')
  assert.equal(isQuestionType('ranking'), false)
  assert.equal(typeIcon('ranking'), '')
  assert.equal(defaultDifficultyOf('ranking'), 2)
  assert.equal(defaultScoreOf('ranking'), 5)
})

test('选项/分值口径与既有判分默认一致', () => {
  assert.equal(hasOptions('single'), true)
  assert.equal(hasOptions('multi'), true)
  assert.equal(hasOptions('judge'), true)
  assert.equal(hasOptions('fill'), false)
  assert.equal(hasOptions('short'), false)
  assert.equal(hasOptions('material'), false)
  // grading.fullScoreOf：判断 2 分、其余 5 分；材料题无自身分值
  assert.equal(defaultScoreOf('judge'), 2)
  assert.equal(defaultScoreOf('single'), 5)
  assert.equal(defaultScoreOf('material'), 0)
})

test('导入别名全部指向已知题型（问答/问答题 仍被接受）', () => {
  for (const [alias, key] of Object.entries(TYPE_ALIASES)) {
    assert.ok(isQuestionType(key), `别名 ${alias} 指向未知题型 ${key}`)
  }
  assert.equal(TYPE_ALIASES['问答'], 'short')
  assert.equal(TYPE_ALIASES['简答题'], 'short')
  assert.equal(TYPE_ALIASES['材料题'], 'material')
})

test('材料子题类型不含 material（禁止嵌套）', () => {
  assert.equal(CHILD_QUESTION_TYPES.length, 5)
  assert.ok(!CHILD_QUESTION_TYPES.some((t) => t.key === 'material'))
})

test('元数据只读，防止运行时被就地改写', () => {
  assert.ok(Object.isFrozen(QUESTION_TYPES))
  assert.ok(Object.isFrozen(TYPE_LABELS))
  assert.ok(Object.isFrozen(TYPE_ALIASES))
})
