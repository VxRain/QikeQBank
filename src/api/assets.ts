import { cmd, unwrap } from './bridge.ts'
import { convertFileSrc } from '@tauri-apps/api/core'

// assets（题配图文件化存储）前端层：
// 题面 JSON 里只存 `asset:<64hex>` 引用；显示前 expand 成 asset 协议 URL；
// 保存前 normalize 把显示 URL 还原成引用（后端也会二次校验）。
const SHA_RE = /^[0-9a-f]{64}$/
/** sha -> path|null（GC 后由调用方 clearAssetCache） */
const pathCache = new Map<string, string | null>()

/**
 * 缓存代次（FE-P1-12）：每次 clearAssetCache 就 +1。
 *
 * 为什么需要它：`QuestionPreview` 会按「渲染输入签名」记忆已算好的 HTML
 * （多图/大文档重算一次要跑 KaTeX + 字符串拼接，很贵）。但 asset 解析结果并非常量——
 * `assets_gc` 后路径可能失效，此时**必须**让所有记忆条目一起失效。
 * 用代次做键前缀是最省事的做法：不用遍历清理，也不会漏掉某个条目。
 */
let cacheGen = 0

export function clearAssetCache(): void {
  pathCache.clear()
  cacheGen += 1
}

/** 当前缓存代次（渲染层记忆键的一部分） */
export function assetCacheGen(): number {
  return cacheGen
}

/** 批量判断 path 是否全部已知（不发 IPC） */
export function allAssetsResolved(list: unknown): boolean {
  const shas = new Set<string>()
  collectShas(list, shas)
  if (!shas.size) return true
  for (const s of shas) if (!pathCache.has(s)) return false
  return true
}

/** 是否含 asset: 引用（不深拷贝、不发 IPC） */
export function hasAssetRefs(list: unknown): boolean {
  const shas = new Set<string>()
  collectShas(list, shas)
  return shas.size > 0
}

export function isAssetRef(src: unknown): src is string {
  return typeof src === 'string' && /^asset:[0-9a-f]{64}$/.test(src)
}

export interface PutAssetInput {
  b64: string
  mime: string
  w?: number | null
  h?: number | null
}

export interface PutAssetResult {
  sha: string
  path?: string
}

export async function putAsset({ b64, mime, w, h }: PutAssetInput): Promise<PutAssetResult> {
  const data = unwrap<{ sha?: string; path?: string }>(
    await cmd('assets_put', { dataB64: b64, mime, width: w ?? null, height: h ?? null })
  )
  const sha = data?.sha
  const path = data?.path
  if (!sha) throw new Error('入库失败：未返回 sha')
  if (path) pathCache.set(sha, path)
  return { sha, path }
}

/** sha -> 可显示路径（null = 解析不到） */
export type AssetPathMap = Record<string, string | null>

export async function resolveAssetPaths(shas: string[]): Promise<AssetPathMap> {
  const uniq = [...new Set((shas || []).filter((s) => SHA_RE.test(s)))]
  const missing = uniq.filter((s) => !pathCache.has(s))
  // 后端单次上限 200：分片串行取
  for (let i = 0; i < missing.length; i += 200) {
    const data = unwrap<{ items?: Array<{ sha: string; path?: string | null }> }>(
      await cmd('assets_resolve', { shas: missing.slice(i, i + 200) })
    )
    for (const it of data?.items || []) pathCache.set(it.sha, it.path || null)
  }
  const out: AssetPathMap = {}
  for (const s of uniq) out[s] = pathCache.get(s) || null
  return out
}

export function assetFileUrl(path: string): string | null {
  try {
    return convertFileSrc(path)
  } catch {
    return null
  }
}

function walkNodes(v: any, visit: (node: any) => void): void {
  if (Array.isArray(v)) {
    v.forEach((x) => walkNodes(x, visit))
    return
  }
  if (v && typeof v === 'object') {
    visit(v)
    Object.values(v).forEach((x) => walkNodes(x, visit))
  }
}

function collectShas(doc: unknown, out: Set<string>): void {
  walkNodes(doc, (v) => {
    if (typeof v.src === 'string' && isAssetRef(v.src)) out.add(v.src.slice(6))
  })
}

function applyUrls(doc: unknown, map: AssetPathMap): void {
  walkNodes(doc, (v) => {
    if (typeof v.src === 'string' && isAssetRef(v.src)) {
      const p = map[v.src.slice(6)]
      if (p) {
        const u = assetFileUrl(p)
        if (u) v.src = u
      }
    }
  })
}

/** 把一批题目（含子结构）里的 asset: 引用就地换成可显示 URL（无引用时零开销：不发任何 invoke） */
export async function expandQuestions<T>(list: T[]): Promise<T[]> {
  const arr = Array.isArray(list) ? list : []
  if (!arr.length) return arr
  const shas = new Set<string>()
  arr.forEach((q) => collectShas(q, shas))
  if (!shas.size) return arr
  let map: AssetPathMap = {}
  try {
    map = await resolveAssetPaths([...shas])
  } catch (e) {
    console.error(e)
    return arr
  }
  arr.forEach((q) => applyUrls(q, map))
  return arr
}

// 把显示期 asset 协议 URL 还原成 asset: 引用（保存前调用；后端也会二次校验）
// 注意 sha 在 URL 里是分片存放的（<2hex>/<62hex>），连续 64 位只做兼容兜底
const ASSET_HOST_RE = /asset\.localhost|asset:\/\/localhost/
// 分片形 <2hex>(%5C|/)<62hex>.ext 优先，连续 64 位兜底；命中即整个 src 写成干净引用
const SHARDED_PART = /(?:%5C|%5c|\/)([0-9a-f]{2})(?:%5C|%5c|\/)([0-9a-f]{62})\.(?:webp|png|jpe?g|gif)(?=[?#"'\s]|$)/i
const CONTIG_PART = /([0-9a-f]{64})\.(?:webp|png|jpe?g|gif)(?=[?#"'\s]|$)/i

export function toAssetRef(src: unknown): string | null {
  if (typeof src !== 'string' || !ASSET_HOST_RE.test(src)) return null
  let m = SHARDED_PART.exec(src)
  if (m) return `asset:${m[1]}${m[2]}`
  m = CONTIG_PART.exec(src)
  if (m) return `asset:${m[1]}`
  return null
}

/** 把 doc 里的 asset 协议 URL 就地还原成 asset: 引用，返回同一对象（便于链式使用） */
export function normalizeDocAssets<T>(doc: T): T {
  walkNodes(doc, (v) => {
    if (typeof v.src === 'string' && ASSET_HOST_RE.test(v.src)) {
      const ref = toAssetRef(v.src)
      // 提不出来就原样留给后端 choke 点报错（fail fast，不静默存坏数据）
      if (ref) v.src = ref
    }
  })
  return doc
}

/** assets_gc 回收结果（impl 不包信封，unwrap 原样透传） */
export interface GcAssetsResult {
  removed: number
  freed_bytes: number
  total: number
  scanned: number
  /** 仍被题目引用但文件已缺失的条目 */
  dangling: Array<{ question_id: string; sha: string }>
}

export async function gcAssets(): Promise<GcAssetsResult> {
  return unwrap<GcAssetsResult>(await cmd('assets_gc', {}))
}

export function fmtBytes(n: unknown): string {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`
}
