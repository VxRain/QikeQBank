/**
 * grading.js 回归测试（node:test，无第三方依赖）：
 *  - 填空归一：trim / 大小写 / 全角→半角 / 空值必错
 *  - 多选口径：全对 / 漏选按比例（partial）/ 漏选 0 分（strict）/ 错选 0 / 未选
 *  - 得分率 → grade 四档映射（与后端 resolve_grade('exam') 语义对齐）
 *  - 满分/得分：显式 score 优先、缺省回退（判断 2 / 其余 5）、材料子题合计、0.5 分取整
 *  - gradeExamQuestion 材料递归 + summarizePaper 汇总口径（答对 = 得分率 ≥ 0.6）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  normFillValue,
  fillBlankCorrect,
  gradeSingle,
  gradeMulti,
  gradeFill,
  gradeShort,
  ratioToGrade,
  fullScoreOf,
  earnedOf,
  gradeExamQuestion,
  buildExamDetail,
  summarizePaper
} from '../../src/utils/grading.js'

describe('normFillValue / fillBlankCorrect', () => {
  it('trim + 大小写 + 全角→半角', () => {
    assert.equal(normFillValue('  ABC '), 'abc')
    assert.equal(normFillValue('Ａｂｃ'), 'abc')
    assert.equal(normFillValue('１９４９'), '1949')
    assert.equal(normFillValue('Ｘ＋１'), 'x+1')
    assert.equal(normFillValue('全　角空格'), '全 角空格')
  })
  it('空值必错；答案侧同样归一', () => {
    assert.equal(fillBlankCorrect({ answers: ['北京'] }, ''), false)
    assert.equal(fillBlankCorrect({ answers: ['北京'] }, '   '), false)
    assert.equal(fillBlankCorrect({ answers: ['Ｂeijing'] }, 'beijing'), true)
    assert.equal(fillBlankCorrect({ answers: ['a', 'b'] }, 'B'), true)
  })
})

describe('各题型判分', () => {
  const ids = ['o1', 'o2', 'o3']
  it('单选/判断：全对满分，未选 unanswered', () => {
    assert.deepEqual(gradeSingle({ answer: { ids: ['o2'] } }, 'o2'), { ratio: 1, unanswered: false })
    assert.equal(gradeSingle({ answer: { ids: ['o2'] } }, 'o1').ratio, 0)
    assert.equal(gradeSingle({ answer: { ids: ['o2'] } }, '').unanswered, true)
  })
  it('多选：全对 / 错选 0 / 漏选按比例（partial）', () => {
    const q = { answer: { ids } }
    assert.equal(gradeMulti(q, ['o1', 'o2', 'o3']).ratio, 1)
    assert.equal(gradeMulti(q, ['o1', 'o4']).ratio, 0)
    assert.equal(gradeMulti(q, []).unanswered, true)
    const sub = gradeMulti(q, ['o1', 'o3'])
    assert.equal(sub.ratio, 2 / 3)
    assert.equal(sub.subset, true)
  })
  it('多选 strict：漏选 0 分', () => {
    const r = gradeMulti({ answer: { ids } }, ['o1'], 'strict')
    assert.equal(r.ratio, 0)
    assert.equal(r.subset, true)
  })
  it('填空：逐空判对按比例折算；整题未作答 = 0 分', () => {
    const q = { answer: { blanks: [
      { id: 'b1', answers: ['A'] },
      { id: 'b2', answers: ['Ｂ'] },
      { id: 'b3', answers: ['C'] }
    ] } }
    const r = gradeFill(q, { b1: 'a', b2: 'b', b3: 'x' })
    assert.equal(r.ratio, 2 / 3)
    assert.deepEqual(r.results.map((x) => x.correct), [true, true, false])
    const none = gradeFill(q, {})
    assert.equal(none.ratio, 0)
    assert.equal(none.unanswered, true)
  })
  it('简答：自评两档', () => {
    assert.equal(gradeShort('会').ratio, 1)
    assert.equal(gradeShort('不会').ratio, 0)
    assert.equal(gradeShort('').unanswered, true)
  })
})

describe('分值与映射', () => {
  it('ratioToGrade 四档（后端 correct = good/easy ≡ 得分率≥0.6）', () => {
    assert.equal(ratioToGrade(1), 'easy')
    assert.equal(ratioToGrade(0.6), 'good')
    assert.equal(ratioToGrade(0.99), 'good')
    assert.equal(ratioToGrade(0.59), 'hard')
    assert.equal(ratioToGrade(0.01), 'hard')
    assert.equal(ratioToGrade(0), 'again')
  })
  it('fullScoreOf：显式 score 优先；缺省判断 2 / 其余 5；材料 = 子题合计', () => {
    assert.equal(fullScoreOf({ type: 'single', score: 3 }), 3)
    assert.equal(fullScoreOf({ type: 'judge', score: null }), 2)
    assert.equal(fullScoreOf({ type: 'short' }), 5)
    assert.equal(fullScoreOf({ type: 'material', children: [
      { type: 'single', score: 2 }, { type: 'judge' }
    ] }), 4)
  })
  it('earnedOf：0.5 分取整', () => {
    assert.equal(earnedOf(5, 1), 5)
    assert.equal(earnedOf(5, 0.5), 2.5)
    assert.equal(earnedOf(5, 0.75), 4) // 3.75 → 4
    assert.equal(earnedOf(0, 1), 0)
    assert.equal(earnedOf(5, 0), 0)
  })
})

describe('gradeExamQuestion / detail / 汇总', () => {
  const paper = [
    { id: 'q1', type: 'single', score: 3, answer: { ids: ['a'] }, options: [{ id: 'a' }, { id: 'b' }] },
    { id: 'q2', type: 'multi', score: 5, answer: { ids: ['a', 'b', 'c'] } },
    {
      id: 'q3', type: 'material', children: [
        { id: 'c1', type: 'judge', answer: { ids: ['a'] } },
        { id: 'c2', type: 'fill', answer: { blanks: [{ id: 'b1', answers: ['X'] }] } }
      ]
    },
    { id: 'q4', type: 'short', score: 8 }
  ]
  const ans = {
    q1: { selected: 'a' },
    q2: { picked: ['a', 'b'] }, // 漏选 1 → 2/3
    q3: { children: { c1: { selected: 'a' }, c2: { fillValues: {} } } }, // c2 未作答
    q4: {} // 未作答
  }
  it('材料递归：母题合计子题得分；未作答子题 0 分', () => {
    const r = gradeExamQuestion(paper[2], ans.q3)
    assert.equal(r.full, 7) // 判断 2 + 填空 5
    assert.equal(r.earned, 2)
    assert.equal(r.children[0].ratio, 1)
    assert.equal(r.children[1].unanswered, true)
    assert.equal(r.unanswered, false) // 有子题已作答
  })
  it('detail：exam_id/exam_seq/得分点；子题带 child_id/parent_id', () => {
    const res = gradeExamQuestion(paper[2].children[0], ans.q3.children.c1)
    const d = buildExamDetail(paper[2].children[0], ans.q3.children.c1, res, {
      examId: 'exam_x', seq: 3, childIndex: 1, parentId: 'q3'
    })
    assert.equal(d.exam_id, 'exam_x')
    assert.equal(d.exam_seq, 3)
    assert.equal(d.child_id, 'c1')
    assert.equal(d.parent_id, 'q3')
    assert.equal(d.score_earned, 2)
    assert.equal(d.full_score, 2)
    assert.deepEqual(d.selected, ['a'])
    const dMulti = buildExamDetail(paper[1], ans.q2, gradeExamQuestion(paper[1], ans.q2), { examId: 'e', seq: 2 })
    assert.equal(dMulti.multi_subset, true)
  })
  it('summarizePaper：答对 = 得分率 ≥ 0.6；错题清单 = 得分率 < 1', () => {
    const entries = paper.map((q, i) => ({ q, res: gradeExamQuestion(q, ans[q.id]), seq: i + 1 }))
    const s = summarizePaper(entries)
    assert.equal(s.full, 3 + 5 + 7 + 8)
    assert.equal(s.earned, 3 + Math.round(5 * (2 / 3) * 2) / 2 + 2 + 0)
    assert.equal(s.correctCount, 2) // q1 满、q2 ≥0.6
    assert.equal(s.unansweredCount, 1) // q4 整题未作答
    assert.equal(s.wrong.length, 3) // q2 / q3 / q4
    assert.ok(String(s.rate).length > 0)
  })
})
