<template>
  <div class="preview cv-auto bg-card border border-line rounded-[12px] p-4 min-h-[120px] leading-[1.7] shadow-sm text-text" v-html="html"></div>
</template>

<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import { renderDoc, renderMaterial, renderOptions } from '@/utils/render.js'
import { expandQuestions, hasAssetRefs, allAssetsResolved, assetCacheGen } from '@/api/assets.js'

const props = defineProps({
  question: { type: Object, default: null },
  debounceMs: { type: Number, default: 180 }
})

function compute(q){
  if(!q || !q.type) return '<p style="color:#9aa3b2">暂无预览（请填写题干）</p>'
  if(q.type==='material') return renderMaterial(q)
  let h = renderDoc(q.stem)
  if(['single','multi','judge'].includes(q.type)) h += renderOptions(q.options, q.answer?.ids)
  if(q.analysis && q.analysis.content){
    h += `<div style="margin-top:12px;padding:12px;background:var(--bg-accent);border:1px solid var(--line);border-radius:10px"><b style="color:var(--primary)">解析：</b>${renderDoc(q.analysis)}</div>`
  }
  return h
}

const html = ref('')
// asset: 引用是异步解析的：解析完再一次性渲染（避免挂载时先算一遍、展开后又算一遍）
let refreshSeq = 0
let lastKey = ''

/**
 * 渲染结果记忆（FE-P1-12）。
 *
 * ── 为什么要缓存 ──
 * 列表页一页 50 行，每行点「预览」都会挂一个 QuestionPreview；材料题 20 张图时
 * `renderDoc` 要做 20 次字符串拼接 + KaTeX 排版。用户来回预览同一题、
 * 或「预览 A → 预览 B → 又预览 A」时，重复计算完全没必要。
 *
 * ── 缓存键为什么必须包含 asset 代次 ──
 * 渲染结果依赖 asset 解析后的 URL。`assets_gc` 后路径可能失效（见 api/assets.js
 * 的 cacheGen），只按 `signature` 记忆就会一直吐出带死链的旧 HTML。
 * 把代次拼进键里，清理缓存时自然全量失效，不需要遍历删除。
 *
 * ── 为什么有上限 ──
 * 大文档的 HTML 字符串不小，无界 Map 会随「翻页预览过的题数」一直涨。
 * 超过 100 条按插入顺序淘汰最旧的（FIFO 而非 LRU：这里没有命中率要求，
 * FIFO 实现简单，且不会因为「刚看过又刷新」把热点条目踢掉）。
 *
 * ── 声明顺序有讲究 ──
 * `memo` / `lastKey` 必须在下面第一次 `refresh()` **之前**声明。
 * 曾经把它写在 refresh() 之后，模块初始化时 refresh 访问未初始化的 const
 * 直接 TDZ 报错 → 整页白屏（且 build 与单测都不报）。
 */
const CACHE_LIMIT = 100
const memo = new Map() // key -> html

function memoKey(sig) {
  return `${assetCacheGen()}::${sig}`
}

function memoSet(key, value) {
  if (memo.size >= CACHE_LIMIT) {
    // FIFO：Map 保持插入顺序，删第一个即最旧
    const oldest = memo.keys().next().value
    if (oldest !== undefined) memo.delete(oldest)
  }
  memo.set(key, value)
}

// 测试与排障用：暴露缓存规模（不在 UI 上展示）
defineExpose({ cacheSize: () => memo.size })

refresh()

/**
 * 渲染输入签名：只取真正影响 HTML 的字段。
 * 改分值/难度/标签等不触发整块重渲染（KaTeX 排版不便宜）。
 */
function signature(q) {
  if (!q) return ''
  return JSON.stringify([q.type, q.stem, q.options, q.answer, q.analysis, q.children])
}

async function refresh() {
  const my = ++refreshSeq
  const q = props.question
  let src = q
  if (q && q.type) {
    try {
      // 快路：asset 全部已解析（最常见）→ 直接用原对象，不深拷贝也不发 IPC。
      // 深拷贝 + expandQuestions 只在「确有未解析的 asset: 引用」时才需要。
      if (hasAssetRefs(q) && !allAssetsResolved([q])) {
        // 深拷贝后展开：不碰父组件对象，避免 watch 比对抖动
        const clone = JSON.parse(JSON.stringify(q))
        await expandQuestions([clone])
        if (my !== refreshSeq) return // 后来的刷新已接管，丢弃过期结果
        src = clone
      }
    } catch (e) {
      console.error(e)
    }
  }
  if (my !== refreshSeq) return
  const sig = signature(src)
  const key = memoKey(sig)
  if (key === lastKey && html.value) return // 渲染输入（含 asset 代次）没变：跳过重算
  const hit = memo.get(key)
  if (hit !== undefined) {
    lastKey = key
    html.value = hit
    return
  }
  lastKey = key
  const out = compute(src)
  memoSet(key, out)
  html.value = out
}
let timer = null
let lastType = props.question?.type
let lastChildrenLen = props.question?.children?.length ?? -1
let lastOptionsLen = props.question?.options?.length ?? -1

watch(()=>props.question, (val)=>{
  clearTimeout(timer)
  const curType = val?.type
  const curChildrenLen = val?.children?.length ?? -1
  const curOptionsLen = val?.options?.length ?? -1
  const structural = curType !== lastType || curChildrenLen !== lastChildrenLen || curOptionsLen !== lastOptionsLen
  if(structural){
    lastType = curType; lastChildrenLen = curChildrenLen; lastOptionsLen = curOptionsLen
    refresh()
    return
  }
  timer = setTimeout(()=>{
    lastType = curType; lastChildrenLen = curChildrenLen; lastOptionsLen = curOptionsLen
    refresh()
  }, props.debounceMs)
}, { deep: true })

onBeforeUnmount(()=> clearTimeout(timer))
</script>

<style scoped>
.preview{ background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:16px; min-height:120px; line-height:1.7; box-shadow:var(--shadow-sm); color:var(--text) }
.preview :deep(p){ margin:10px 0; color:var(--text-secondary) }
.preview :deep(figure){ margin:14px 0; text-align:center }
.preview :deep(img){ max-width:100%; border-radius:8px; border:1px solid var(--line); background:#fffdf7; box-shadow:var(--shadow-sm) }
.preview :deep(.option){ padding:10px 12px; margin:6px 0; border:1px solid var(--line); border-radius:10px; background:var(--card); transition:all .15s }
.preview :deep(.option.correct){ border-color:#bcd9c4; background:var(--success-bg); box-shadow:var(--shadow-sm) }
.preview :deep(.key){ font-weight:700; color:var(--primary); margin-right:6px }
.preview :deep(.blank){ display:inline-block; min-width:72px; border-bottom:2px solid var(--primary); margin:0 4px; text-align:center; color:var(--primary); font-weight:600 }
.preview :deep(.sub-q){ margin:14px 0; padding:14px; background:var(--bg-accent); border:1px solid var(--line); border-radius:10px }
.preview :deep(.q-title){ font-weight:700; margin-bottom:8px; color:var(--text) }
.preview :deep(.material){ border-left:3px solid var(--primary); padding-left:12px; margin-bottom:14px }
.preview :deep(.math-block){ margin:12px 0; padding:12px; background:var(--bg-accent); border:1px solid var(--line); border-radius:8px; text-align:center }
</style>
