/**
 * 全局搜索 · 命令面板状态机（FE-P0-08）
 *
 * 为什么单独抽一层：
 * 旧实现把「输入 → 防抖 → 请求 → 下拉渲染 → 键盘 → 关闭」全塞在 App.vue 里，
 * 只有题目一种结果，且取回的是完整题目字段（题干富文本 + 选项 + 解析）。
 * 现在要出四组结果（题目 / 题库 / 页面 / 设置）+ 键盘选中 + Esc 逐级 + 最近搜索，
 * 再堆进 App.vue 会变成第二个 700 行怪物，也让这些规则无法单测。
 *
 * 设计取舍：
 * - **纯函数优先**：分组构造 / 键盘移动 / Esc 语义 / 关键词高亮全部是纯函数，
 *   入参只接受普通对象，不依赖 vue、不下发请求 → `node --test` 直接覆盖。
 *   registry.js 会 import .vue（node 无法解析），所以这里**不** import 它，
 *   设置分组由调用方注入 `sections` + `match`（组件传 registry 的 matchItem），
 *   保证全仓库仍只有一套设置搜索逻辑。
 * - **题目结果先 summary**：`questions_list` 传 `summary: true` 只取摘要字段，
 *   展开某条时才 `questions_get(id)` 取全文并缓存（同一 id 不重复请求）。
 * - **最近搜索只落 localStorage**：与 stores/runConfig.ts / listFilter.ts 同判断，
 *   属「本机行为偏好」，不进 SQLite、不进同步契约。
 */
import { reactive } from 'vue'

/**
 * 设置分区里的一个设置项。形状权威在 components/settings/registry.js，
 * 那是 .js（未迁移），所以这里只声明「搜索用得到」的部分；
 * 多出来的字段由 registry 自己的 match 函数读取。
 */
export interface SettingItemLike {
  id?: string
  key?: string
  title?: string
  desc?: string
  category?: string
  /** 依赖未满足时提示「需先开启 …」（registry.js 真实字段） */
  dependsOn?: string
  // 不写索引签名：写了会要求源类型（registry 的真实 item）也带，反而卡死赋值
}

/** 设置项匹配函数（注入 registry.matchItem） */
export type MatchFn = (item: SettingItemLike, section: SettingSectionLike, needle: string) => boolean

/** 设置项是否可见（依赖未满足时仍展示，但标注原因） */
export type VisibleFn = (item: SettingItemLike) => boolean

/** 取题目摘要列表的参数（api/questions.ts::ListParams 的子集） */
export interface SearchListParams {
  query?: string
  limit?: number
  summary?: boolean
  bankId?: string
}

/**
 * 题目摘要（questions_list summary=true）：不含 stem/options/answer/analysis。
 *
 * **不写索引签名**：`SearchListResult.items` 要能同时接住 api 层的
 * `Question | QuestionSummary`（联合），带索引签名会要求两边都声明索引签名，
 * 反而赋值失败。这里只列本模块真正读的字段。
 */
export interface QuestionSummaryLike {
  id: string
  type?: string
  plain_text?: string
  children_count?: number
  children_score?: number
}

/** 取题目摘要列表的返回（api/questions.ts::list 的 data） */
export interface SearchListResult {
  total?: number
  items?: QuestionSummaryLike[]
}

/** 展开的题目全文（本模块只读 id/type/stem 等展示字段，其余透传） */
export interface QuestionDetailLike {
  id?: string
  type?: string
  stem?: unknown
  options?: unknown[]
  answer?: unknown
  plain_text?: string
}

/** 面板里的一条结果（题目 / 题库 / 页面 / 设置 共用） */
export interface SearchItem {
  kind: 'question' | 'bank' | 'page' | 'setting' | 'viewAll'
  key: string
  id: string
  title: string
  desc: string
  to?: string
  order?: number | string
  /** 原始命中对象（题目/题库/设置项）。调用方按 kind 自行收窄，故为 unknown */
  raw?: unknown
  sectionId?: string
}

/**
 * 取题目结果里的题型（模板用）。
 *
 * `SearchItem.raw` 是 unknown：它可能是 QuestionSummary、Bank 或设置项。
 * 模板表达式不是完整 TS 上下文，写不了断言，所以在**这里**做一次 `in` 收窄，
 * 模板保持 `questionTypeOf(item)` 的可读写法。
 */
export function questionTypeOf(item: SearchItem | null | undefined): string {
  const raw = item?.raw
  if (!raw || typeof raw !== 'object' || !('type' in raw)) return ''
  return typeof raw.type === 'string' ? raw.type : ''
}

/** 题库最小形状 */
export interface BankLike {
  id: string
  name?: string
  question_count?: number
}

/** 路由最小形状 */
export interface RouteLike {
  path: string
  meta?: { title?: string; nav?: { order?: number } }
}

/** 设置分区最小形状 */
export interface SettingSectionLike {
  id: string
  title: string
  /** 分区内的设置项（形状由 registry.js 定义，本模块只透传给 match/isVisible） */
  items?: SettingItemLike[]
}

/** 面板运行时状态 */
export interface SearchStore {
  open: boolean
  query: string
  loading: boolean
  error: string
  questions: SearchItem[]
  questionTotal: number
  expandedId: string
  /** 已展开题目的全文结果，按题目 id 索引 */
  expanded: Record<string, QuestionDetailLike>
  expandedLoading: boolean
  banks: SearchItem[]
  pages: SearchItem[]
  settings: SearchItem[]
  activeIndex: number
  recent: string[]
  pendingSettingsQuery: string
}

/** runQuestionSearch / expandQuestion 的注入依赖（便于 node 下单测） */
export interface SearchDeps {
  /** 取题目摘要列表（注入 api/questions.ts 的 list，便于 node 下单测） */
  listQuestions?: (params: SearchListParams) => Promise<SearchListResult>
  /** 取单题全文（注入 api/questions.ts 的 get） */
  getQuestion?: (id: string) => Promise<QuestionDetailLike>
  store?: SearchStore
  routes?: RouteLike[]
  banks?: BankLike[]
  sections?: SettingSectionLike[]
  match?: MatchFn
  isVisible?: VisibleFn
}

/** buildRows 的入参 */
export interface BuildRowsOpts {
  questions?: SearchItem[]
  banks?: SearchItem[]
  pages?: SearchItem[]
  settings?: SearchItem[]
  kw?: string
  questionTotal?: number
}


/** 单次面板最多取回多少条题目（「查看全部」交给列表页） */
export const QUESTION_LIMIT = 8
/** 最近搜索保留条数 */
export const RECENT_LIMIT = 5
/** 最近搜索的 localStorage 键（带版本，形态变更时可弃旧值） */
export const RECENT_KEY = 'qbank.searchRecent.v1'
/** 输入防抖（ms）：与旧实现的 250ms 一致，避免每敲一个字发一次 IPC */
export const SEARCH_DEBOUNCE = 250

/**
 * 页面结果的补充关键词。
 *
 * 路由表只有 `meta.title`（页面名），用户往往按「练习」「列表」这类别称找页面。
 * 别称表放这里而不是塞进 router 的 meta：路由表是导航/标题的唯一来源，
 * 塞搜索词会让它承担第三份职责。键必须是路由表的 path（守卫测试会校正）。
 */
export const PAGE_ALIASES = Object.freeze({
  '/': 'home 主页 开始',
  '/library': '列表 试题 题库列表 全部试题',
  '/banks': '题库 管理 新建题库',
  '/create': '新增 录入 添加 新题',
  '/wrong': '错题 错题本 复习错题',
  '/practice': '练习 刷题 做题 组卷',
  '/exam': '考试 模考 测验 试卷',
  '/review': '复习 复习计划 到期'
})

/** 结果分组顺序（面板渲染顺序 + 键盘遍历顺序，两处共用） */
export const GROUP_ORDER = Object.freeze([
  Object.freeze({ kind: 'question', label: '试题' }),
  Object.freeze({ kind: 'bank', label: '题库' }),
  Object.freeze({ kind: 'page', label: '页面' }),
  Object.freeze({ kind: 'setting', label: '设置' })
])

export function normalizeKeyword(kw: unknown): string {
  return String(kw ?? '').replace(/\s+/g, ' ').trim()
}

/* ────────────────────────── 最近搜索 ────────────────────────── */

/** 读最近搜索：脏数据（非数组/非字符串/空串）一律过滤，读失败给空数组 */
export function loadRecent(storage: Storage | undefined = globalThis.localStorage): string[] {
  try {
    const raw = storage?.getItem(RECENT_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    const out = []
    for (const v of arr) {
      const kw = typeof v === 'string' ? normalizeKeyword(v) : ''
      if (kw && !out.includes(kw)) out.push(kw)
      if (out.length >= RECENT_LIMIT) break
    }
    return out
  } catch {
    return []
  }
}

/** 写最近搜索：写失败（隐私模式 / 配额）静默忽略，不能阻断搜索 */
export function saveRecent(list: unknown[] | null | undefined, storage: Storage | undefined = globalThis.localStorage): string[] {
  const clean = []
  for (const v of list || []) {
    const kw = normalizeKeyword(v)
    if (kw && !clean.includes(kw)) clean.push(kw)
    if (clean.length >= RECENT_LIMIT) break
  }
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(clean))
  } catch {
    /* 忽略持久化失败 */
  }
  return clean
}

/**
 * 记一条最近搜索：去重（大小写不敏感）+ 置顶 + 截断到 RECENT_LIMIT。
 * 纯函数，返回新数组（不改入参），调用方负责落地。
 */
export function pushRecent(kw: unknown, list: unknown[] = [], storage: Storage | undefined = globalThis.localStorage): string[] {
  const needle = normalizeKeyword(kw)
  const rest = (list || [])
    .map((v) => normalizeKeyword(v))
    .filter((v) => v && v.toLowerCase() !== needle.toLowerCase())
  const next: string[] = needle ? [needle, ...rest].slice(0, RECENT_LIMIT) : rest.slice(0, RECENT_LIMIT)
  saveRecent(next, storage)
  return next
}

export function clearRecent(storage: Storage | undefined = globalThis.localStorage): string[] {
  try {
    storage?.removeItem(RECENT_KEY)
  } catch {
    /* 同上 */
  }
  return []
}

/* ────────────────────────── 分组构造 ────────────────────────── */

/**
 * 题库分组：按名称模糊匹配，命中词高亮由组件负责。
 * 顺序保持 bankStore 的顺序（后端已按名称/创建序返回），不在这里二次排序。
 */
export function buildBankResults(banks: BankLike[] | null | undefined, kw: unknown): SearchItem[] {
  const needle = normalizeKeyword(kw).toLowerCase()
  if (!needle) return []
  return (banks || [])
    .filter((b) => String(b?.name || '').toLowerCase().includes(needle))
    .slice(0, 5)
    .map((b) => ({
      kind: 'bank',
      key: `bank:${b.id}`,
      id: b.id,
      title: b.name || '(未命名题库)',
      desc: `${b.question_count ?? 0} 题`,
      to: `/library?bank=${b.id}`
    }))
}

/**
 * 页面分组：**从路由表派生**（FE-P0-08 要求「页面结果可从路由表生成」）。
 *
 * 只收静态路径（含 `:param` 的路由是「编辑某题」这类入口，不能从面板直达），
 * 且按 meta.nav.order → title 排序，保证顺序稳定、可断言。
 *
 * @param routes 路由表原始数组（router.options.routes 是只读的，这里只读遍历，不拷贝不修改）
 */
export function buildPageResults(
  routes: ReadonlyArray<RouteLike> | null | undefined,
  kw: unknown
): SearchItem[] {
  const needle = normalizeKeyword(kw).toLowerCase()
  if (!needle) return []
  const out = []
  for (const r of routes || []) {
    const path = r?.path
    const title = r?.meta?.title
    if (!path || !title || path.includes(':')) continue
    const alias = PAGE_ALIASES[path] || ''
    const hay = `${title} ${alias} ${path}`.toLowerCase()
    // 多个关键词按 AND 匹配（与 registry.matchItem 同语义，用户不必记全名）
    if (!needle.split(' ').every((part) => hay.includes(part))) continue
    out.push({
      kind: 'page',
      key: `page:${path}`,
      id: path,
      title,
      desc: path,
      to: path,
      order: r?.meta?.nav?.order ?? 99
    })
  }
  return out.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
}

/**
 * 设置分组：**复用 registry.js 的 matchItem**，不写第三套搜索逻辑。
 *
 * match 由调用方注入（组件传 registry.matchItem）：registry 依赖 .vue 组件，
 * 这里若直接 import 会让本模块无法在 node 下单测。
 *
 * 依赖未满足的行（visible() 为 false）也返回，desc 里说明「需先开启」，
 * 与 SettingsDialog 的搜索态行为保持一致。
 */
export function buildSettingResults(
  sections: SettingSectionLike[] | null | undefined,
  kw: unknown,
  match?: MatchFn,
  isVisible?: VisibleFn
): SearchItem[] {
  const needle = normalizeKeyword(kw)
  if (!needle) return []
  const out = []
  for (const section of sections || []) {
    for (const item of section?.items || []) {
      if (typeof match === 'function' && !match(item, section, needle)) continue
      const visible = typeof isVisible === 'function' ? isVisible(item) : true
      out.push({
        kind: 'setting',
        key: `setting:${section.id}:${item.key}`,
        id: item.key,
        sectionId: section.id,
        title: item.title,
        desc: visible ? section.title : `需先开启 ${item.dependsOn || '相关开关'}`,
        order: section.title
      })
    }
  }
  return out
}

/**
 * 拍平成分组行，供渲染与键盘遍历 **共用同一份顺序**。
 *
 * 键盘高亮用扁平索引（不区分组），所以要保证「眼睛看到的顺序」=「↑/↓ 走的顺序」，
 * 唯一做法是渲染和遍历都从这一个函数取数。
 */
export function buildGroups({
  questions = [],
  banks = [],
  pages = [],
  settings = [],
  kw = ''
}: {
  questions?: SearchItem[]
  banks?: SearchItem[]
  pages?: SearchItem[]
  settings?: SearchItem[]
  kw?: string
} = {}): Array<{ kind: string; label: string; items: SearchItem[] }> {
  const bucket = { question: questions, bank: banks, page: pages, setting: settings }
  return GROUP_ORDER
    .map((g) => ({ kind: g.kind, label: g.label, items: bucket[g.kind] || [] }))
    .filter((g) => g.items.length > 0)
}

/** 扁平行 = 所有分组项按分组顺序拼接（「查看全部」单列在最后，见 buildRows） */
export function buildRows(opts: BuildRowsOpts = {}): SearchItem[] {
  const rows = []
  for (const g of buildGroups(opts)) {
    for (const item of g.items) rows.push(item)
  }
  const kw = normalizeKeyword(opts.kw)
  if (kw && (opts.questionTotal ?? 0) > 0) {
    rows.push({
      kind: 'viewAll',
      key: 'viewAll',
      id: 'viewAll',
      title: `查看全部结果：${kw}`,
      desc: `共 ${opts.questionTotal} 题`,
      to: `/library?q=${encodeURIComponent(kw)}`
    })
  }
  return rows
}

/* ────────────────────────── 键盘 / 关闭语义 ────────────────────────── */

/** ↑/↓：在 [0, len) 内**环绕**移动；len 为 0 时恒返回 -1 */
export function nextActive(current: number, len: number, delta: number): number {
  if (!len || len < 1) return -1
  const base = Number.isInteger(current) && current >= 0 && current < len ? current : (delta > 0 ? -1 : len)
  return ((base + delta) % len + len) % len
}

/**
 * Esc 逐级（FE-P0-08 验收：先清关键词，再关面板）。
 * 返回下一步动作，由组件执行 —— 便于单测，不用挂 DOM。
 */
export function escStep(query: unknown): 'clear' | 'close' {
  return normalizeKeyword(query) ? 'clear' : 'close'
}

/* ────────────────────────── 关键词高亮 ────────────────────────── */

/**
 * 把文本按关键词切成 [{text, hit}] 片段，供组件渲染 `<mark>`。
 *
 * 规则：
 * - 大小写不敏感；多个关键词（空格分隔）全部高亮；
 * - 命中区间合并，避免「ab」+「bc」重叠时切出碎片段；
 * - 空查询 / 无命中 → 单片段（hit=false），调用方不必分支。
 */
export function splitHighlight(text: unknown, kw: unknown): Array<{ text: string; hit: boolean }> {
  const src = String(text ?? '')
  const parts = normalizeKeyword(kw).toLowerCase().split(' ').filter(Boolean)
  if (!src || !parts.length) return [{ text: src, hit: false }]
  const lower = src.toLowerCase()
  const ranges = []
  for (const p of parts) {
    let at = lower.indexOf(p)
    while (at >= 0) {
      ranges.push([at, at + p.length])
      at = lower.indexOf(p, at + p.length)
    }
  }
  if (!ranges.length) return [{ text: src, hit: false }]
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged = [ranges[0]]
  for (const [s, e] of ranges.slice(1)) {
    const last = merged[merged.length - 1]
    if (s <= last[1]) last[1] = Math.max(last[1], e)
    else merged.push([s, e])
  }
  const out = []
  let cursor = 0
  for (const [s, e] of merged) {
    if (s > cursor) out.push({ text: src.slice(cursor, s), hit: false })
    out.push({ text: src.slice(s, e), hit: true })
    cursor = e
  }
  if (cursor < src.length) out.push({ text: src.slice(cursor), hit: false })
  return out
}

/** 题干摘要：压平空白 + 截断（面板一行放不下整段） */
export function snippet(text: unknown, max = 70): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return '(空题干)'
  return s.length > max ? s.slice(0, max) + '…' : s
}

/* ────────────────────────── 运行时状态 ────────────────────────── */

/**
 * 面板运行时状态（单例，与 stores/settings.ts 同风格）。
 *
 * 这里只放「界面要用」的状态；分组构造与键盘规则仍是上面的纯函数，
 * 组件每次渲染用 computed 调它们 —— 状态与规则分离，规则才可单测。
 */
export const searchStore: SearchStore = reactiveState()

function reactiveState(): SearchStore {
  return reactive({
    open: false,
    query: '',
    loading: false,
    error: '',
    /** 题目摘要结果（summary: true 取回，不含选项/解析全文） */
    questions: [],
    /** 题目命中总数（用于「查看全部 N 题」） */
    questionTotal: 0,
    /** 展开的题目 id（同一时刻只展开一条） */
    expandedId: '',
    /** 展开后取回的全量题目缓存：id → question */
    expanded: {},
    expandedLoading: false,
    banks: [],
    pages: [],
    settings: [],
    activeIndex: 0,
    recent: [],
    /** 设置结果的跳转意图：打开设置并预填搜索词 */
    pendingSettingsQuery: ''
  })
}

/** 重置分组结果（换关键词 / 关闭面板时调用） */
export function resetResults(store: SearchStore = searchStore): void {
  store.questions = []
  store.questionTotal = 0
  store.banks = []
  store.pages = []
  store.settings = []
  store.expandedId = ''
  store.expanded = {}
  store.expandedLoading = false
  store.error = ''
  store.activeIndex = 0
}

/**
 * 执行一次题目搜索（summary 优先）。
 *
 */
export async function runQuestionSearch(kw: unknown, deps: SearchDeps = {}) {
  const store = deps.store || searchStore
  const needle = normalizeKeyword(kw)
  const listFn = deps.listQuestions
  if (!needle) {
    store.questions = []
    store.questionTotal = 0
    store.loading = false
    return { questions: [], total: 0 }
  }
  store.loading = true
  store.error = ''
  try {
    // summary: true —— 只取摘要字段；全文留给展开时按需 get(id)
    const data = await listFn({ query: needle, limit: QUESTION_LIMIT, summary: true })
    const items = Array.isArray(data?.items) ? data.items : []
    store.questions = items.map((q) => ({
      kind: 'question',
      key: `question:${q.id}`,
      id: q.id,
      title: snippet(q.plain_text),
      // q 是 QuestionSummary（不含 stem/options/answer），raw 原样透传给组件
      desc: '',
      raw: q
    }))
    store.questionTotal = Number(data?.total) || items.length
    return { questions: store.questions, total: store.questionTotal }
  } catch (e) {
    store.questions = []
    store.questionTotal = 0
    store.error = e?.message || '搜索失败'
    return { questions: [], total: 0 }
  } finally {
    store.loading = false
  }
}

/**
 * 展开某题的全文：命中缓存直接返回，未命中才 questions_get(id)。
 * 返回全量题目（失败返回 null，由组件 toast）。
 */
export async function expandQuestion(id: string, deps: SearchDeps = {}) {
  const store = deps.store || searchStore
  if (!id) return null
  if (store.expanded[id]) return store.expanded[id]
  if (store.expandedId && store.expandedId !== id) {
    // 同一时刻只展开一条，避免面板被两份全文撑长
    store.expandedId = id
  }
  const getFn = deps.getQuestion
  if (typeof getFn !== 'function') return null
  store.expandedLoading = true
  try {
    const full = await getFn(id)
    if (full && full.id) store.expanded = { ...store.expanded, [id]: full }
    return full || null
  } catch (e) {
    store.error = e?.message || '加载题目详情失败'
    return null
  } finally {
    store.expandedLoading = false
  }
}
