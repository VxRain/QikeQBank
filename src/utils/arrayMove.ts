/**
 * 数组内移动单个元素（题库拖拽排序与材料子题排序共用）
 *
 * 为什么单独抽：题库拖拽与材料子题排序是同一件事（把第 from 个挪到第 to 个），
 * 各写一份必然漂移——一边越界时原地不动、另一边抛异常这类分歧，手测发现不了。
 * 这里定成纯函数：非法输入或原地不动返回 null，调用方据此跳过持久化 / IPC /
 * emitUpdate，避免写入一堆无变化的记录。
 *
 * @param arr 源数组（不会被修改）
 * @param from 起始下标
 * @param to 目标下标
 * @returns 新数组（不改入参）；非法或原地不动返回 null
 */
export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] | null {
  const list = Array.isArray(arr) ? arr.slice() : []
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null
  if (from < 0 || to < 0 || from >= list.length || to >= list.length) return null
  if (from === to) return null
  const [item] = list.splice(from, 1)
  list.splice(to, 0, item)
  return list
}
