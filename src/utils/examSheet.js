/**
 * 模考答题卡的分组与状态计算（FE-P0-07a）
 *
 * 抽成纯函数的原因：分组规则（材料题按母题归组）与三态判定是答题卡的全部逻辑，
 * 但组件本身只有 DOM；把逻辑放这里就能用 node:test 覆盖边界，
 * 不必为了测一个分组去起浏览器。
 */

/** 判分前「有内容」即可（与 Exam.vue 的 hasAnswer 同口径：简答自评也算已答） */
export function hasAnswerEntry(a) {
  if (!a) return false
  if (a.selected) return true
  if (Array.isArray(a.picked) && a.picked.length) return true
  if (Object.values(a.fillValues || {}).some((v) => String(v || '').trim())) return true
  if (a.shortSelf) return true
  return false
}

/**
 * 分组：材料题的子题按 parent.id 归并成一组（不依赖子题在 items 中相邻），
 * 其余每项各自成组，顺序与 items 一致。
 *
 * @param {Array} items [{ uid, q, parent, isChild, childIdx, childCount }]
 * @param {Object} answers uid → 作答
 * @param {Object} flagged uid → true
 * @returns {Array<{key:string, isMaterial:boolean, parentIndex:number, items:Array}>}
 */
export function groupSheetItems(items, answers = {}, flagged = {}) {
  const out = []
  const byParent = new Map()
  const list = Array.isArray(items) ? items : []
  for (let i = 0; i < list.length; i++) {
    const it = list[i]
    const entry = {
      uid: it.uid,
      idx: i,
      q: it.q,
      flagged: !!flagged[it.uid],
      answered: hasAnswerEntry(answers[it.uid])
    }
    if (it.isChild && it.parent) {
      const key = it.parent.id
      let g = byParent.get(key)
      if (!g) {
        g = { key, isMaterial: true, parentIndex: i, items: [] }
        byParent.set(key, g)
        out.push(g)
      }
      g.items.push({ ...entry, childIdx: it.childIdx, childCount: it.childCount })
    } else {
      out.push({ key: it.uid, isMaterial: false, parentIndex: i, items: [entry] })
    }
  }
  return out
}

/** 三态计数（标记优先于已答：标了就是待定，视觉上要显眼） */
export function countSheet(items, answers = {}, flagged = {}) {
  let answered = 0
  let flaggedN = 0
  for (const it of Array.isArray(items) ? items : []) {
    if (hasAnswerEntry(answers[it.uid])) answered++
    if (flagged[it.uid]) flaggedN++
  }
  const total = (items || []).length
  return { total, answered, unanswered: total - answered, flagged: flaggedN }
}

/** 单元格状态：'flag' | 'done' | 'todo' */
export function cellStateOf(entry) {
  if (entry.flagged) return 'flag'
  return entry.answered ? 'done' : 'todo'
}

/**
 * 首个未答项下标（答题卡「跳到首个未答」）；全答完返回 -1。
 * @param {Array} items
 * @param {Object} answers
 */
export function firstUnansweredIndex(items, answers = {}) {
  const list = Array.isArray(items) ? items : []
  for (let i = 0; i < list.length; i++) {
    if (!hasAnswerEntry(answers[list[i].uid])) return i
  }
  return -1
}

/**
 * 恢复草稿时把旧的标记 uid 映射到重建后的 items。
 *
 * uid 形如 `<题目id>_<序号>`：题目被删后序号会前移，所以只能按题目 id 重映射，
 * 不能用 uid 字符串直接比。
 *
 * @param {string[]} oldUids 草稿里存的旧 uid 列表
 * @param {Array} items 重建后的 items
 * @returns {Object} 新 uid → true
 */
export function remapFlaggedUids(oldUids, items) {
  const out = {}
  const list = Array.isArray(items) ? items : []
  const qidOf = (uid) => String(uid).replace(/_\d+$/, '')
  const byQid = new Map()
  for (const it of list) {
    if (it.q?.id) byQid.set(it.q.id, it) // 普通题/子题自身的 id
    if (it.uid) byQid.set(it.uid, it) // 旧草稿恰好没变时直接命中
  }
  for (const old of Array.isArray(oldUids) ? oldUids : []) {
    const target = byQid.get(qidOf(old))
    if (target) out[target.uid] = true
  }
  return out
}
