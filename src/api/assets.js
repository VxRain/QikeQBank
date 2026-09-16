import { cmd } from './bridge.js'
import { convertFileSrc } from '@tauri-apps/api/core'

// assets（题配图文件化存储）前端层：
// 题面 JSON 里只存 `asset:<64hex>` 引用；显示前 expand 成 asset 协议 URL；
// 保存前 normalize 把显示 URL 还原成引用（后端也会二次校验）。
const SHA_RE = /^[0-9a-f]{64}$/
const pathCache = new Map() // sha -> path|null（GC 后由调用方 clearAssetCache）

export function clearAssetCache() {
  pathCache.clear()
}

export function isAssetRef(src) {
  return typeof src === 'string' && /^asset:[0-9a-f]{64}$/.test(src)
}

export async function putAsset({ b64, mime, w, h }) {
  const res = await cmd('assets_put', { dataB64: b64, mime, width: w ?? null, height: h ?? null })
  const sha = res?.data?.sha
  const path = res?.data?.path
  if (!sha) throw new Error('入库失败：未返回 sha')
  if (path) pathCache.set(sha, path)
  return { sha, path }
}

export async function resolveAssetPaths(shas) {
  const uniq = [...new Set((shas || []).filter((s) => SHA_RE.test(s)))]
  const missing = uniq.filter((s) => !pathCache.has(s))
  // 后端单次上限 200：分片串行取
  for (let i = 0; i < missing.length; i += 200) {
    const res = await cmd('assets_resolve', { shas: missing.slice(i, i + 200) })
    for (const it of res?.data?.items || []) pathCache.set(it.sha, it.path || null)
  }
  const out = {}
  for (const s of uniq) out[s] = pathCache.get(s) || null
  return out
}

export function assetFileUrl(path) {
  try {
    return convertFileSrc(path)
  } catch {
    return null
  }
}

function walkNodes(v, visit) {
  if (Array.isArray(v)) {
    v.forEach((x) => walkNodes(x, visit))
    return
  }
  if (v && typeof v === 'object') {
    visit(v)
    Object.values(v).forEach((x) => walkNodes(x, visit))
  }
}

function collectShas(doc, out) {
  walkNodes(doc, (v) => {
    if (typeof v.src === 'string' && isAssetRef(v.src)) out.add(v.src.slice(6))
  })
}

function applyUrls(doc, map) {
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

// 把一批题目（含子结构）里的 asset: 引用就地换成可显示 URL（无引用时零开销：不发任何 invoke）
export async function expandQuestions(list) {
  const arr = Array.isArray(list) ? list : []
  if (!arr.length) return arr
  const shas = new Set()
  arr.forEach((q) => collectShas(q, shas))
  if (!shas.size) return arr
  let map = {}
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
const SHARDED_PART = /(?:%5C|%5c|\/)([0-9a-f]{2})(?:%5C|%5c|\/)([0-9a-f]{62})\.(?:webp|png|jpe?g|gif)(?=[?#"')\s]|$)/
const CONTIG_PART = /([0-9a-f]{64})\.(?:webp|png|jpe?g|gif)(?=[?#"')\s]|$)/

export function toAssetRef(src) {
  if (typeof src !== 'string' || !ASSET_HOST_RE.test(src)) return null
  let m = SHARDED_PART.exec(src)
  if (m) return `asset:${m[1]}${m[2]}`
  m = CONTIG_PART.exec(src)
  if (m) return `asset:${m[1]}`
  return null
}

export function normalizeDocAssets(doc) {
  walkNodes(doc, (v) => {
    if (typeof v.src === 'string' && ASSET_HOST_RE.test(v.src)) {
      const ref = toAssetRef(v.src)
      // 提不出来就原样留给后端 choke 点报错（fail fast，不静默存坏数据）
      if (ref) v.src = ref
    }
  })
  return doc
}

export async function gcAssets() {
  const res = await cmd('assets_gc', {})
  return res?.data
}

export function fmtBytes(n) {
  n = Number(n) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
