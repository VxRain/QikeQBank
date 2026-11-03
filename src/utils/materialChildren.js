/**
 * 材料子题排序 / 改题型的纯逻辑（FE-P1-05）
 *
 * ── 为什么抽成纯函数 ──
 * 子题排序有一个在界面上**完全看不出来**的陷阱：子题 id 要不要跟着位置重编？
 *
 * 后端 `ensure_child_ids`（src-tauri/src/db/questions.rs）只给**缺失**的 id 补
 * `<父 id>_c<序号>`，已有 id 一律不动——它不可能知道用户刚把第 3 问拖到了第 1 位。
 * 而 `child_id` 是答题记录的稳定引用：`exam_detail` / `practice` 的
 * `detail.child_id` 靠它定位（ExamHistory.vue、Wrong.vue 都按 id 找子题）。
 *
 * 所以两种做法各有代价，且都不会报错：
 *   · 只挪内容、id 跟着挪 → 界面「第 3 问」带着 `_c3` 的 id，历史回看仍按 id 找到
 *     同一道题（内容一致，只是名叫 c3），**记录不丢**，仅编号与位置不一致。
 *   · 按新位置重编 id → 界面编号漂亮了，但历史记录里的 `_c3` 现在指向**被挪过来的
 *     另一道题**，回看会张冠李戴甚至找不到题（新 `_c1` 与旧 `_c1` 是不同内容）。
 * 结论：**排序不重编**（保记录正确），**删除后不重编**（同理），
 * 只有**新增/复制**才给新元素分配 id——那时没有历史记录可破坏。
 *
 * 另一条不变量：材料题必须有子题。删掉最后一个子题会留下 type=material 但
 * children=[] 的题，练习/考试取题时拿不到任何可答内容（表现为「抽到了但点不进去」）。
 * 因此删除走 `removeChildAt`，它拒绝删掉最后一个。
 */

import { moveItem } from './arrayMove.js'

/**
 * 子题 id 前缀：`<父 id>_c<n>`，与后端 `ensure_child_ids` 同格式。
 * 父 id 缺失（新建尚未保存的题）时用 `q` 兜底，保证 id 非空且唯一。
 * @param {object} q 题目对象
 */
export function childIdSeed(q) {
  const id = q && typeof q === 'object' ? q.id : null
  const s = id == null ? '' : String(id)
  return s || 'q'
}

/**
 * 给「新增/复制」出来的子题分配一个不会与现有子题冲突的 id。
 *
 * 为什么不用 `_c{length+1}`：排序或删除后序号会有空洞（c1, c3），
 * 长度+1 会撞上已存在的 id（c3 在长度=2 时算出 c3）。所以取「现有最大序号 + 1」。
 *
 * @param {Array<object>} children 现有子题
 * @param {string} seed 见 childIdSeed
 * @returns {string}
 */
export function nextChildId(children, seed) {
  const prefix = `${seed}_c`
  let max = 0
  for (const c of Array.isArray(children) ? children : []) {
    const id = c && typeof c === 'string' ? c : c && c.id
    if (typeof id !== 'string' || !id.startsWith(prefix)) continue
    const n = Number(id.slice(prefix.length))
    if (Number.isInteger(n) && n > max) max = n
  }
  return `${prefix}${max + 1}`
}

/**
 * 根据拖拽指针位置算出「应该插到第几位」。
 *
 * ── 为什么不依赖 HTML5 DnD 的 drop 目标 ──
 * 原生 DnD 只能靠 `drop` 事件的 target 判定落点，这要求指针**恰好落在**某张卡片上。
 * 子题卡片带题干/选项/解析三个编辑器，实测单卡 856~1227px > 1024 最小窗可视高 768px，
 * 于是：拖一行距离仍在同一张卡内 → `from === to` → 看起来「拖了没反应」；
 * 拖到卡片间隙/页面空白 → 没有任何元素接收 drop → 同样静默失败。
 * 改为按坐标算落点，只要指针在子题区域内就一定能算出目标位。
 *
 * 算法：指针每越过一条**卡片中线**，插入位就前进一位（与逐行拖拽的直觉一致）。
 *
 * 约定：`pointerY` 与 `tops` 必须**同一坐标系**。调用方统一用视口坐标
 * （`clientY` 配 `getBoundingClientRect`），因为自动滚动会同时改变两者、
 * 保持可比；混用视口/文档坐标会让滚动方向与插入位方向相反。
 *
 * @param {number} pointerY 指针 y（与 tops 同坐标系）
 * @param {number[]} tops 每张卡片的中线 y（同样取视口坐标）
 * @returns {number} 插入位（0..tops.length，非整数输入返回 -1）
 */
export function insertionIndexFromY(pointerY, tops) {
  if (!Number.isFinite(pointerY)) return -1
  const mids = Array.isArray(tops) ? tops : []
  let idx = 0
  for (const m of mids) {
    if (!Number.isFinite(m)) continue
    if (pointerY > m) idx += 1
  }
  return idx
}

/**
 * 把「插入位」换算成 `moveChild` 需要的 to 下标。
 *
 * 两者的差别是「移走源元素后，插入位会整体前移一位」：
 *   从 0 插到末尾（插入位 3）→ 实际 to 应该是 length-1 = 2。
 * 直接拿插入位当 to 会越界（moveItem 返回 null），表现为拖到末尾无效。
 *
 * @param {number} from 源下标
 * @param {number} insertAt 插入位（来自 insertionIndexFromY）
 * @param {number} total 元素总数
 * @returns {number} moveChild 的 to；无需移动（插入位等于原位）返回 from
 */
export function insertIndexToMoveTarget(from, insertAt, total) {
  if (!Number.isInteger(from) || !Number.isInteger(insertAt) || !Number.isInteger(total)) return from
  if (total <= 0) return from
  const clamped = Math.min(Math.max(insertAt, 0), total)
  // 插入位在源自身之前或紧接自身之后 → 视为原地
  if (clamped === from || clamped === from + 1) return from
  return clamped > from ? clamped - 1 : clamped
}

/**
 * 拖到子题区域上/下边缘时该不该滚动、滚多少。
 *
 * 卡片高于视口时，用户从第 1 题拖到第 3 题必然要滚动。原生 DnD 的自动滚动
 * 在这个页面上会失控（实测从 scrollY 138 冲到 3288，目标区块被甩出视口），
 * 所以自己算：靠近边缘才滚，且速度随靠近程度递增（0..1 线性）。
 *
 * @param {number} pointerY
 * @param {number} top 可视区上沿
 * @param {number} bottom 可视区下沿
 * @param {number} maxSpeed 每帧最大滚动像素（16ms 一帧 → 60px/帧 ≈ 3750px/s，
 *   足够在 1s 内跨过一张 1227px 的卡片；太慢会让用户以为拖不动）
 * @returns {number} 正数向下、负数向上、0 不滚
 */
export function edgeScrollDelta(pointerY, top, bottom, maxSpeed = 60) {
  if (![pointerY, top, bottom, maxSpeed].every(Number.isFinite)) return 0
  if (bottom <= top) return 0
  const zone = Math.min(120, Math.max(40, (bottom - top) * 0.18))
  if (pointerY < top + zone) {
    const k = Math.min(1, Math.max(0, (top + zone - pointerY) / zone))
    return -Math.round(maxSpeed * k)
  }
  if (pointerY > bottom - zone) {
    const k = Math.min(1, Math.max(0, (pointerY - (bottom - zone)) / zone))
    return Math.round(maxSpeed * k)
  }
  return 0
}

/**
 * 新增子题时前端要不要自己发号？——只有题目**已持久化**（有 id）才发。
 *
 * 两种情形必须区别对待，否则两种错都会静默发生：
 *
 * ① 新建题（无 id）：**不发号**。后端 `ensure_child_ids` 会按
 *    `<新建后的父 id>_c<下标>` 统一分配。若前端先发 `q_c1`，后端看到 id 已存在
 *    就不再动它，结果**所有新建材料题的子题都叫 q_c1/q_c2**——跨题撞号，
 *    `detail.child_id` 完全失去定位能力。
 *
 * ② 已存在的题：**必须发号**。后端只补缺失 id，若新子题不带 id，它按
 *    「当前下标」补号；而删过子题后下标会与已有 id 相撞：
 *    children=[p_c1, p_c3]，新子题落在下标 3 → 补 p_c3 → 与现有 p_c3 撞号。
 *    用 max+1 则得 p_c4，安全。
 *
 * @param {object} question 当前题目（看它有没有 id）
 * @param {Array<object>} children 现有子题
 * @returns {string|null} null 表示「交给后端分配」
 */
export function childIdForAppend(question, children) {
  const hasParentId = !!(question && typeof question === 'object' && question.id)
  if (!hasParentId) return null
  return nextChildId(children, childIdSeed(question))
}

/**
 * 消除同一材料内的子题 id 重复。
 *
 * 只处理**重复**，不碰缺失——缺失交给后端补（见 childIdForAppend ①）。
 * 为什么重复必须修：同一材料里两道子题同号，`detail.child_id` 回看时
 * 只能命中第一个，成绩张冠李戴，而界面上看不出任何异常。
 *
 * @param {Array<object>} children
 * @param {string|null} parentId 有父 id 时给重复项重新发号；否则清空交给后端
 * @returns {Array<object>} 新数组
 */
export function dedupeChildIds(children, parentId) {
  const list = Array.isArray(children) ? children : []
  const seen = new Set()
  let max = 0
  // 先扫一遍最大值，保证新发的号不撞后面的
  const seed = parentId ? `${parentId}_c` : null
  if (seed) {
    for (const c of list) {
      const id = c && typeof c.id === 'string' ? c.id : ''
      if (!id.startsWith(seed)) continue
      const n = Number(id.slice(seed.length))
      if (Number.isInteger(n) && n > max) max = n
    }
  }
  return list.map((c) => {
    if (!c || typeof c !== 'object') return c
    const id = typeof c.id === 'string' ? c.id : null
    if (!id) return c // 缺失：原样留给后端
    if (!seen.has(id)) {
      seen.add(id)
      return c
    }
    const next = { ...c }
    if (seed) {
      max += 1
      next.id = `${seed}${max}`
      seen.add(next.id)
    } else {
      // 无父 id：不自己编号（否则重蹈 q_c1 跨题撞号的覆车），清掉让后端补
      delete next.id
    }
    return next
  })
}

/**
 * 移动子题（上移/下移/拖拽共用）。
 *
 * 深浅：整棵子题对象原样搬，**id 随内容一起走**（见文件头说明）。
 *
 * @param {Array<object>} children
 * @param {number} from
 * @param {number} to
 * @returns {Array<object>|null} 新数组；越界或原地不动返回 null（调用方跳过 emitUpdate）
 */
export function moveChild(children, from, to) {
  return moveItem(children, from, to)
}

/**
 * 上移一位：已在首位返回 null。
 * @returns {Array<object>|null}
 */
export function moveChildUp(children, index) {
  return moveChild(children, index, index - 1)
}

/**
 * 下移一位：已在末位返回 null。
 * @returns {Array<object>|null}
 */
export function moveChildDown(children, index) {
  return moveChild(children, index, index + 1)
}

/**
 * 按钮是否禁用。首/末位**禁用而非隐藏**：位置不跳动，用户不会追着按钮跑。
 * @param {number} index
 * @param {number} total
 * @param {-1|1} dir
 */
export function canMoveChild(index, total, dir) {
  if (!Number.isInteger(index) || !Number.isInteger(total)) return false
  if (index < 0 || index >= total) return false
  const target = index + dir
  return target >= 0 && target < total
}

/**
 * 删除第 index 个子题。
 *
 * 拒绝删掉最后一个：材料题的子题清空后会变成「点不进去的空题」，
 * 而且这个状态在列表里看不出异常。调用方据 `reason` 提示用户改为切换题型。
 *
 * @param {Array<object>} children
 * @param {number} index
 * @returns {{children: Array<object>}|{error: 'empty'|'range'}}
 *   `empty` = 这是最后一个子题；`range` = index 非法
 */
export function removeChildAt(children, index) {
  const list = Array.isArray(children) ? children : []
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return { error: 'range' }
  if (list.length <= 1) return { error: 'empty' }
  return { children: list.slice(0, index).concat(list.slice(index + 1)) }
}
