/**
 * 数组内移动单个元素（FE-P1-05 / FE-P1-02 共用）
 *
 * 为什么单独抽：题库拖拽排序与材料子题排序是同一件事（把第 from 个挪到第 to 个），
 * 各写一份必然漂移——一边允许越界原地不动、另一边抛异常这种分歧，手测根本发现不了。
 * 这里定成纯函数：非法输入返回 null（调用方据此跳过持久化 / IPC）。
 */

/**
 * @param {Array} arr
 * @param {number} from
 * @param {number} to
 * @returns {Array|null} 新数组；非法或原地不动返回 null
 */
export function moveItem(arr, from, to) {
  const list = Array.isArray(arr) ? arr.slice() : []
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null
  if (from < 0 || to < 0 || from >= list.length || to >= list.length) return null
  if (from === to) return null
  const [item] = list.splice(from, 1)
  list.splice(to, 0, item)
  return list
}

/** 上移一位：已在首位返回 null */
export function moveUp(arr, i) {
  return moveItem(arr, i, i - 1)
}

/** 下移一位：已在末位返回 null */
export function moveDown(arr, i) {
  return moveItem(arr, i, i + 1)
}
