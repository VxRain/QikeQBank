/**
 * Excel 题库表解析（网校 题库excel模板.xlsx 布局，其他表按同样列名兼容）
 *
 * 布局（首行为表头，只读第一个 sheet）：
 *   ID | 题目 | 题型 | 分数 | 难度 | 选项A | 选项B | 选项C | 选项D | 选项E | 答案 | 解析
 * 规则：
 * - ID：分组键（整数行 + 小数子行如 7.1，子行须紧跟材料父行之后），不导入为 id；
 * - 题型：单选（题）/多选（题）/判断（题）/填空（题）/问答（题）/材料（题）；
 * - 选项：F..J 列非空，须连续（中间留空报错，防字母错位）；非选择题选项须全空；
 * - 答案：K 列必填；选择题字母可连写（AB）或分隔（A,B,D）；判断 对/错/T/F；
 *   填空组间 ；多解 ，；问答即参考答案；
 * - 分数/难度：数字或数字文本，非法回默认（判断 2 分其余 5 分，难度 2，难度钳制 1–5）；
 * - 子题干行首 (1) 编号剥离；全字段 trim；ID+题目全空的行跳过。
 *
 * 对外：parseSheetRows(rows) -> { blocks }，rows 为 SheetJS sheet_to_json(header:1) 的二维数组；
 * block 形状与 parseTemplateFile 一致 { index, type, typeLabel, stemText, raw, question|null, error|null }。
 */
import type { QuestionType } from '../api/types.ts'
import { TYPE_ALIASES, TYPE_LABELS } from '../constants/questions.ts'
import {
  textToDoc,
  stemToFillDoc,
  parseAnswerIds,
  parseFillBlanks,
  judgeValue,
} from './parseTemplate.ts'

// 列下标（A=0）：ID0 题目1 题型2 分数3 难度4 选项A-E 5..9 答案10 解析11
const C = { ID: 0, STEM: 1, TYPE: 2, SCORE: 3, DIFF: 4, OPT_A: 5, OPT_E: 9, ANSWER: 10, ANALYSIS: 11 }

/** SheetJS `sheet_to_json(header:1, defval:null)` 里的单元格：表格能出现的标量值 */
type SheetCell = string | number | boolean | Date | null | undefined
/** 表格一行 */
type SheetRow = ReadonlyArray<SheetCell>
/** 按数字下标取格的形状（整行数组与 `{ 0: cell }` 单格对象共用） */
type CellRow = { readonly [i: number]: SheetCell }
/** 分值/难度的原始值：数字单元格或数字文本 */
type ScoreRaw = string | number | null | undefined

/**
 * 题型表按 string 索引取用：索引键来自表格文本（不可穷举）。
 *
 * `TYPE_ALIASES` 已是 `Readonly<Record<string, QuestionType>>`，故这里只换短名，
 * 不需要注解或断言。查不到时是 `undefined`，由调用方 `|| typeKey` 兜底。
 */
const ALIAS_TO_TYPE: Readonly<Record<string, QuestionType>> = TYPE_ALIASES
/** key → 规范短名（缺键时调用方 `|| typeKey` 兜底，与改造前一致） */
const TYPE_LABEL_OF: Readonly<Record<string, string>> = TYPE_LABELS

const cell = (row: CellRow, i: number): string => {
  const v = row[i]
  if (v == null) return ''
  return String(v).replace(/\r\n/g, '\n').trim()
}
const numOr = (raw: ScoreRaw, fb: number, min: number, max: number): number => {
  const s = String(raw ?? '').trim()
  if (!s) return fb
  const n = Number(s)
  if (!Number.isFinite(n)) return fb
  return Math.min(max, Math.max(min, n))
}
const stripSubNum = (s: string | null | undefined): string => String(s || '').replace(/^[(（]?\d{1,3}[)）]?[.、)]?\s*/, '')
export { stripSubNum }

/**
 * 一个块里的题目对象（`ParseBlock.question` 的非空形态）。
 * 保留宽松索引签名：分数/难度等公共字段由 `applyScoreDiff` 事后补写，
 * 各题型的私有字段（options/answer/blanks…）形状不同。
 */
export interface ParseQuestion {
  type: string
  stem?: unknown
  /** 材料子题（仅材料父题有；非材料题不写这个键） */
  children?: Array<Record<string, unknown>>
  analysis?: unknown
  score?: number | null
  difficulty?: number | null
  [k: string]: unknown
}

/** buildOne 的入参（表格一行拆出来的题面片段） */
export interface BuildOneInput {
  type: string
  typeLabel: string
  stemText: string
  optTexts: string[]
  answerRaw: string | null | undefined
  analysisRaw: string | null | undefined
}

/**
 * 单题装配结果：成功带 question + stemText，失败只带 error。
 * 形状与 parseTemplate 的 BuildResult 一致 —— `if (r.error)` 的真值判断就能收窄两个分支。
 */
type BuildResult =
  | { question: ParseQuestion; stemText: string; error?: undefined }
  | { error: string; question?: undefined; stemText?: undefined }

export function applyScoreDiff(q: ParseQuestion, typeKey: string, scoreRaw: ScoreRaw, diffRaw: ScoreRaw): void {
  if (typeKey === 'judge') {
    if (!q.score) q.score = numOr(scoreRaw, 2, 0.5, 1000)
  } else if (!q.score) {
    q.score = numOr(scoreRaw, 5, 0.5, 1000)
  }
  if (!q.difficulty) q.difficulty = numOr(diffRaw, 2, 1, 5)
}

export function buildOne({ type, typeLabel, stemText, optTexts, answerRaw, analysisRaw }: BuildOneInput, ctx: string): BuildResult {
  const err = (msg: string): string => `${ctx}：${msg}`
  if (!stemText) return { error: err(`【${typeLabel}】题干为空`) }
  const analysis = analysisRaw ? textToDoc(analysisRaw) : null

  if (type === 'single' || type === 'multi') {
    if (optTexts.length < 2) return { error: err(`【${typeLabel}】选项不足 2 个`) }
    if (answerRaw == null || !answerRaw) return { error: err(`【${typeLabel}】缺少答案`) }
    const letters = optTexts.map((_, i) => String.fromCharCode(65 + i))
    const ids = parseAnswerIds(answerRaw, letters)
    if (type === 'single' && ids.length !== 1) return { error: err(`【${typeLabel}】答案须恰为 1 个，实得 ${ids.length} 个`) }
    if (!ids.length) return { error: err(`【${typeLabel}】答案为空`) }
    for (const id of ids) {
      if (!letters.includes(id)) return { error: err(`【${typeLabel}】答案 ${id} 不在选项内`) }
    }
    return {
      question: {
        type,
        stem: textToDoc(stemText),
        options: optTexts.map((t, i) => ({ id: `o${i + 1}`, content: textToDoc(t) })),
        answer: { ids: ids.map((l) => `o${l.charCodeAt(0) - 64}`) },
        analysis,
      },
      stemText,
    }
  }

  if (type === 'judge') {
    if (optTexts.length) return { error: err('【判断】不应填写选项（答案填答案列）') }
    if (answerRaw == null || !answerRaw) return { error: err('【判断】缺少答案') }
    const val = judgeValue(answerRaw)
    if (val === undefined) return { error: err(`【判断】答案须为 正确/错误（实得“${answerRaw}”）`) }
    return {
      question: {
        type,
        stem: textToDoc(stemText),
        options: [
          { id: 'o1', content: textToDoc('正确') },
          { id: 'o2', content: textToDoc('错误') },
        ],
        answer: { ids: [val ? 'o1' : 'o2'] },
        analysis,
      },
      stemText,
    }
  }

  if (type === 'fill') {
    if (optTexts.length) return { error: err('【填空】不应填写选项（答案填答案列）') }
    // 本模板用 ——（2 个以上连字符）作占位，先归一为 ___ 再走通用装配
    const { doc, count } = stemToFillDoc(stemText.replace(/[—―─]{2,}/g, '___'))
    if (!count) return { error: err('【填空】题干中未找到 ___ / ( ) / —— 占位符') }
    const fr = parseFillBlanks(answerRaw, count, '【填空】')
    if (fr.error) return { error: err(fr.error) }
    return { question: { type, stem: doc, answer: { blanks: fr.blanks }, analysis }, stemText }
  }

  if (type === 'short') {
    if (optTexts.length) return { error: err('【问答】不应填写选项（参考答案填答案列）') }
    if (answerRaw == null || !answerRaw) return { error: err('【问答】缺少参考答案') }
    return {
      question: { type, stem: textToDoc(stemText), answer: { reference: textToDoc(answerRaw) }, analysis },
      stemText,
    }
  }

  return { error: err(`未知题型“${typeLabel}”`) }
}

/**
 * 解析产物里的一个块（Excel/CSV 导入的中间形态，最终由 Form 落库）。
 * `question` 为 null 表示该行没有可导入的题（此时 error 必有值）。
 */
export interface ParseBlock {
  index: number
  type: string
  typeLabel: string
  stemText: string
  raw: string
  question: ParseQuestion | null
  error: string | null
}

/** pushSingle 的选项（默认值留在解构里，与改造前逐字一致） */
type PushSingleOptions = { stripNum?: boolean; attachTo?: ParseBlock | null }

export function parseSheetRows(rows: ReadonlyArray<SheetRow> | null | undefined): { blocks: ParseBlock[] } {
  const blocks: ParseBlock[] = []
  const all: ReadonlyArray<SheetRow> = Array.isArray(rows) ? rows : []
  // 表头定位：首个含 题目/题型 单元格的行（模板顶部可能有标题行）；找不到直接报错
  let headIdx = -1
  for (let i = 0; i < all.length; i++) {
    const cells = (all[i] || []).map((c) => (c == null ? '' : String(c).trim()))
    if (cells.includes('题目') || cells.includes('题型')) {
      headIdx = i
      break
    }
  }
  if (headIdx === -1) {
    return { blocks: [{ index: 1, type: '', typeLabel: '', stemText: '', raw: '', question: null, error: '未找到表头行（须含 ID/题目/题型/答案列）' }] }
  }
  const data = all.slice(headIdx + 1)
  const rawRow = (row: SheetRow): string => row.map((c) => cell({ 0: c }, 0)).join(' | ')
  // 材料父题占位：子行按引用追加，天然保持行序
  let openMaterial: { intId: string; item: ParseBlock; rowIdx: number } | null = null

  const pushSingle = (
    rowIdx: number,
    row: SheetRow,
    { stripNum = false, attachTo = null }: PushSingleOptions = {}
  ): ParseQuestion | null => {
    const index = blocks.length + 1
    const ctx = `行 ${rowIdx}`
    const raw = rawRow(row)
    const typeRaw = cell(row, C.TYPE)
    const typeKey = ALIAS_TO_TYPE[typeRaw]
    const typeLabel = typeRaw || ''
    if (!typeKey || typeKey === 'material') {
      blocks.push({ index, type: '', typeLabel, stemText: '', raw, question: null, error: `${ctx}：题型须为 单选/多选/判断/填空/简答${attachTo ? '（子题不能是材料）' : ''}` })
      return null
    }
    const stemText = stripNum ? stripSubNum(cell(row, C.STEM)) : cell(row, C.STEM)
    const optTexts: string[] = []
    for (let c = C.OPT_A; c <= C.OPT_E; c++) {
      const t = cell(row, c)
      if (t) optTexts.push(t)
    }
    // 选项须连续：中间出现空列视为填表错误（避免字母错位）
    if (typeKey === 'single' || typeKey === 'multi') {
      let firstEmpty = -1
      let lastFilled = -1
      for (let c = C.OPT_A; c <= C.OPT_E; c++) {
        if (!cell(row, c)) { if (firstEmpty === -1) firstEmpty = c }
        else lastFilled = c
      }
      if (firstEmpty !== -1 && lastFilled > firstEmpty) {
        blocks.push({ index, type: typeKey, typeLabel, stemText, raw, question: null, error: `${ctx}：选项须从 A 列连续填写，中间不可留空` })
        return null
      }
    }
    const r = buildOne(
      {
        type: typeKey,
        typeLabel: TYPE_LABEL_OF[typeKey] || typeKey,
        stemText,
        optTexts,
        answerRaw: cell(row, C.ANSWER),
        analysisRaw: cell(row, C.ANALYSIS),
      },
      ctx
    )
    if (r.error) {
      blocks.push({ index, type: typeKey, typeLabel, stemText, raw, question: null, error: r.error })
      return null
    }
    const q = r.question
    applyScoreDiff(q, typeKey, cell(row, C.SCORE), cell(row, C.DIFF))
    if (attachTo) {
      attachTo.question.children.push(q)
      return q
    }
    blocks.push({ index, type: typeKey, typeLabel, stemText, raw, question: q, error: null })
    return q
  }

  data.forEach((row, i) => {
    const rowIdx = i + 2 // Excel 行号（含表头）
    const idRaw = cell(row, C.ID)
    const stemRaw = cell(row, C.STEM)
    if (!idRaw && !stemRaw) return // 空行跳过
    if (!idRaw) {
      blocks.push({ index: blocks.length + 1, type: '', typeLabel: '', stemText: '', raw: rawRow(row), question: null, error: `行 ${rowIdx}：缺少 ID` })
      return
    }
    if (idRaw.includes('.')) {
      // 子行：归属紧邻其前的材料父题
      const parentInt = idRaw.split('.')[0]
      if (!openMaterial || openMaterial.intId !== parentInt) {
        blocks.push({ index: blocks.length + 1, type: '', typeLabel: '', stemText: '', raw: rawRow(row), question: null, error: `行 ${rowIdx}：子题 ${idRaw} 找不到前面的材料父题 ${parentInt}` })
        return
      }
      pushSingle(rowIdx, row, { stripNum: true, attachTo: openMaterial.item })
      return
    }
    // 整数行：先结算上一个材料父题（无子题则报错）
    if (openMaterial && !openMaterial.item.question.children.length) {
      openMaterial.item.error = `行 ${openMaterial.rowIdx}：【材料】没有子题`
      openMaterial.item.question = null
    }
    openMaterial = null
    const typeRaw = cell(row, C.TYPE)
    const typeKey = ALIAS_TO_TYPE[typeRaw]
    if (!typeKey) {
      blocks.push({ index: blocks.length + 1, type: '', typeLabel: typeRaw, stemText: '', raw: rawRow(row), question: null, error: `行 ${rowIdx}：未知题型“${typeRaw}”（须为 单选/多选/判断/填空/简答/材料）` })
      return
    }
    if (typeKey !== 'material') {
      pushSingle(rowIdx, row, {})
      return
    }
    const stemText = cell(row, C.STEM)
    const index = blocks.length + 1
    if (!stemText) {
      blocks.push({ index, type: 'material', typeLabel: '材料', stemText: '', raw: rawRow(row), question: null, error: `行 ${rowIdx}：【材料】题干为空` })
      return
    }
    const item: ParseBlock = {
      index,
      type: 'material',
      typeLabel: '材料',
      stemText,
      raw: rawRow(row),
      question: {
        type: 'material',
        stem: textToDoc(stemText),
        children: [],
        analysis: cell(row, C.ANALYSIS) ? textToDoc(cell(row, C.ANALYSIS)) : null,
      },
      error: null,
    }
    applyScoreDiff(item.question, 'material', cell(row, C.SCORE), cell(row, C.DIFF))
    blocks.push(item)
    openMaterial = { intId: idRaw, item, rowIdx }
  })

  // 文件末尾的材料父题结算
  if (openMaterial && !openMaterial.item.question.children.length) {
    openMaterial.item.error = `行 ${openMaterial.rowIdx}：【材料】没有子题`
    openMaterial.item.question = null
  }
  // index 重排（错误行不占导入序号，统一重编）
  blocks.forEach((b, i) => { b.index = i + 1 })
  return { blocks }
}
