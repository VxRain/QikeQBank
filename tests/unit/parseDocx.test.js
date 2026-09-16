/**
 * parseDocxTemplate 回归测试（node:test，无第三方依赖）：
 *  - 反斜杠转义行在“答案/解析续行”中必须留在续行里，禁止抬进题干
 *    （真案：测试导入.docx 解析（1）-（4）枚举被导入题干）
 *  - 锁定既有行为：题干区转义仍去题干、材料正文转义仍去正文、
 *    未转义半角 (n) 在材料节仍开子题
 *
 * 运行：pnpm test:unit（node --test tests/unit/）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseDocxHtml } from '../../src/utils/parseDocxTemplate.js'

// mammoth 风格扁平 HTML
const P = (s) => `<p>${s}</p>`
const html = (lines) => lines.map(P).join('')

// block.question 内富文本 doc 取纯文本
function docText(doc) {
  if (!doc || !Array.isArray(doc.content)) return ''
  return doc.content
    .map((p) => (p.content || []).map((n) => n.text || '').join(''))
    .join('\n')
}

describe('escaped lines in answer/analysis continuations', () => {
  // 本案复刻：解析内的 \（n）枚举行
  const caseHtml = html([
    '二十一、多选题',
    '333.申请大型活动安全许可时，需提交哪些材料？',
    'A.活动场所管理者同意证明',
    'B.承办者合法成立的证明',
    'C.活动现场警力部署方案',
    'D.安全工作方案',
    '答案:ABD',
    '解析:申请时应当提交下列材料：',
    '\\（1）承办者合法成立的证明；',
    '\\（2）大型群众性活动方案；',
    '\\（3）大型群众性活动安全工作方案；',
    '\\（4）活动场所管理者同意提供活动场所的证明。',
  ])

  it('转义枚举行不进题干', () => {
    const { blocks } = parseDocxHtml(caseHtml)
    assert.equal(blocks.length, 1)
    assert.match(blocks[0].stemText, /需提交哪些材料？/)
    assert.doesNotMatch(blocks[0].stemText, /承办者合法成立/)
  })

  it('转义枚举行留在解析且去反斜杠', () => {
    const { blocks } = parseDocxHtml(caseHtml)
    const ana = docText(blocks[0].question.analysis)
    for (const n of ['（1）', '（2）', '（3）', '（4）']) {
      assert.ok(ana.includes(n), `解析缺失 ${n}`)
    }
    assert.doesNotMatch(ana, /\\/)
  })

  it('答案/选项/参考答案不受影响', () => {
    const { blocks } = parseDocxHtml(caseHtml)
    const q = blocks[0].question
    assert.equal(q.type, 'multi')
    assert.equal(q.options.length, 4)
    assert.deepEqual(q.answer.ids, ['o1', 'o2', 'o4'])
  })
})

describe('long analysis continuations stay in analysis', () => {
  // 大全文档形态：解析 + 举例/口诀/法条全文 + 所属试卷尾行，一题也不许裂开
  const caseHtml = html([
    '一、判断题',
    '1.网信部门发现违法信息时，无需采取任何措施。',
    '答案:错误',
    '解析:选项错误，根据《网络安全法》第50条，应当采取消除等处置措施。',
    '举例：某网站发布违法信息，网信部门要求其删除。',
    '口诀：发现禁止信息，必须采取措施。',
    '法条全文：《网络安全法》第50条：国家网信部门……阻断传播。',
    '所属试卷：2025年科目一思想政治与法律基础',
    '2.下一题题干？',
    '答案:正确',
  ])

  it('一题一答案：不裂块、不丢块', () => {
    const { blocks } = parseDocxHtml(caseHtml)
    assert.equal(blocks.length, 2)
    assert.ok(!blocks.some((b) => b.error))
  })

  it('举例/口诀/法条全文/尾行全进解析', () => {
    const { blocks } = parseDocxHtml(caseHtml)
    const ana = docText(blocks[0].question.analysis)
    for (const s of ['举例', '口诀', '法条全文', '所属试卷']) {
      assert.ok(ana.includes(s), `解析缺失 ${s}`)
    }
    assert.match(blocks[1].stemText, /下一题题干/)
  })
})

describe('escaped lines elsewhere keep legacy routing', () => {
  it('参考答案续行转义留在参考答案', () => {
    const { blocks } = parseDocxHtml(
      html(['一、问答题', '1.何为秦律？', '参考答案:秦律是秦朝法律', '\\（1）补充说明；'])
    )
    const q = blocks[0].question
    assert.equal(q.type, 'short')
    assert.match(docText(q.answer.reference), /补充说明/)
    assert.doesNotMatch(blocks[0].stemText, /补充说明/)
  })

  it('题干区转义仍去题干（去反斜杠）', () => {
    const { blocks } = parseDocxHtml(
      html(['一、单选题', '\\1.字面序号题干？', 'A.甲', 'B.乙', '答案:A'])
    )
    assert.match(blocks[0].stemText, /^1\.字面序号题干？/)
    assert.doesNotMatch(blocks[0].stemText, /\\/)
  })

  it('材料正文转义仍去正文', () => {
    const { blocks } = parseDocxHtml(
      html([
        '三、材料题',
        '阅读材料回答问题。',
        '\\（注）本行为字面枚举；',
        '(1)子题一？',
        'A.甲',
        'B.乙',
        '答案:A',
      ])
    )
    const mat = blocks.find((b) => b.question?.type === 'material')
    assert.ok(mat, '应有材料父块')
    assert.match(docText(mat.question.stem), /本行为字面枚举/)
  })

  it('未转义半角 (n) 在材料节仍开子题', () => {
    const { blocks } = parseDocxHtml(
      html([
        '三、材料题',
        '阅读材料回答问题。',
        '(1)子题一？',
        'A.甲',
        'B.乙',
        '答案:A',
        '(2)子题二？',
        'A.丙',
        'B.丁',
        '答案:B',
      ])
    )
    const mat = blocks.find((b) => b.question?.type === 'material')
    assert.ok(mat, '应有材料父块')
    assert.equal(mat.question.children.length, 2)
  })
})
