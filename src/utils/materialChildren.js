/**
 * 材料子题编辑操作纯逻辑（FE-P1-05）
 *
 * 为什么抽出来：子题「排序 / 改题型 / 复制」都有同一个隐性不变量——
 * **子题 id 必须与父 id 绑定**（后端 `ensure_child_ids` 生成 `<父 id>_c<n>`，
 * 而 `exam_detail` / `practice` 的 `child_id` 引用就靠它）。一旦复制子题时把 id 原样带过去，
 * 同一份材料里会出现两个相同 child_id，历史回看会张冠李戴——这类缺陷在界面上完全看不出来。
 * 因此全部收成纯函数，由 tests/unit/material-children.test.js 逐条锁住。
 */

/**
 * 给子题打上新的唯一 id。
 *
 * 为什么要重新分配而不是沿用：材料题的子题在保存前可能还没有 id（新建时、复制的），
 * 而「复制子题」必定要把 id 挪开。格式与后端一致（`<父 id>_c<n>`），后端 `ensure_child_ids`
 * 只补缺失的，已存在的不动，所以这里生成什么它都尊重。
 *
 * @param {object} child
 * @param {string} seed 唯一前缀（父 id，或父 id + 复制序号）
 * @param {number} index 从 1 开始的序号
 */
export function withChildId(child, seed, index) {
  const q = JSON.parse(JSON.stringify(child || {}))
  q.id = `${seed}_c${index}`
  return q
}

/**
 * 重新编号全部子题 id：排序 / 删除 / 复制之后调用，保证 `<父>_c1..cN` 连续且唯一。
 *
 * 为什么排序后也要重编：用户把第 3 问拖到第 1 位后，若 id 仍是 c3，
 * 成绩单上的「第 1 问」会挂着 c3 的记录，历史回看的编号与界面编号对不上。
 *
 * @param {Array<object>} children
 * @param {string} parentId
 * @returns {Array<object>} 新数组（每个子题 id 已重编）
 */
export function renumberChildren(children, parentId) {
  const list = Array.isArray(children) ? children : []
  const seed = String(parentId || 'q')
  return list.map((c, i) => {
    const q = JSON.parse(JSON.stringify(c || {}))
    q.id = `${seed}_c${i + 1}`
    return q
  })
}

/**
 * 移动子题。返回 null 表示无需变更（越界 / 原地），调用方据此跳过 emitUpdate。
 * @param {Array<object>} children
 * @param {number} from
 * @param {number} to
 * @param {string} parentId
 */
export function moveChild(children, from, to, parentId) {
  const list = Array.isArray(children) ? children : []
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null
  if (from < 0 || to < 0 || from >= list.length || to >= list.length || from === to) return null
  const next = list.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return renumberChildren(next, parentId)
}

/**
 * 复制第 index 个子题并插到它后面（用户预期：副本紧跟原件）。
 * 子题 id 全部重编，避免同材料内 child_id 冲突。
 *
 * @returns {{children: Array<object>, index: number}} index = 副本位置
 */
export function duplicateChild(children, index, parentId) {
  const list = Array.isArray(children) ? children : []
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return null
  const copy = JSON.parse(JSON.stringify(list[index]))
  // 副本不带 id，交给 renumberChildren 统一重编（否则会与原件同 id）
  delete copy.id
  const next = list.slice()
  next.splice(index + 1, 0, copy)
  return { children: renumberChildren(next, parentId), index: index + 1 }
}

/**
 * 单题「另存为副本」的载荷：新 id 由后端生成（这里必须清掉旧的）。
 * 同时清掉 plain_text（派生字段）与 children 的 id（材料题同样要重编）。
 *
 * @param {object} q
 * @returns {object} 可直接提交给 questions_create 的副本
 */
export function asNewCopy(q) {
  // 非对象（null / 字符串 / 数字）一律给空对象：调用方拿到的必须是可提交的载荷，
  // 而不是把脏入参原样传给后端的 JSON.stringify
  if (!q || typeof q !== 'object' || Array.isArray(q)) return {}
  const copy = JSON.parse(JSON.stringify(q))
  delete copy.id
  delete copy.plain_text
  // 时间戳由后端按「新建」重新盖章
  delete copy.created_at
  delete copy.updated_at
  if (Array.isArray(copy.children)) {
    // 子题 id 也清掉：后端 ensure_child_ids 会按新父 id 补
    copy.children = copy.children.map((c) => {
      const child = JSON.parse(JSON.stringify(c || {}))
      delete child.id
      return child
    })
  }
  return copy
}

/** 子题是否还有内容（用于「删除最后一个子题」之类的守卫提示） */
export function hasContent(q) {
  if (!q || typeof q !== 'object') return false
  if (q.stem) return true
  if (Array.isArray(q.options) && q.options.length) return true
  if (q.answer && Object.keys(q.answer).length) return true
  return false
}
