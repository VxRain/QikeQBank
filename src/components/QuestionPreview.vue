<template>
  <div class="preview bg-card border border-line rounded-[12px] p-4 min-h-[120px] leading-[1.7] shadow-sm text-text" v-html="html"></div>
</template>

<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import { renderDoc, renderMaterial, renderOptions } from '@/utils/render.js'
import { expandQuestions } from '@/api/assets.js'

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

const html = ref(compute(props.question))
// asset: 引用是异步解析的：先同步出一版文字（图片位空着），解析完再补全
let refreshSeq = 0
refresh()

async function refresh() {
  const my = ++refreshSeq
  const q = props.question
  if (q && q.type) {
    try {
      // 深拷贝后展开：不碰父组件对象，避免 watch 比对抖动
      const clone = JSON.parse(JSON.stringify(q))
      await expandQuestions([clone])
      if (my !== refreshSeq) return // 后来的刷新已接管，丢弃过期结果
      html.value = compute(clone)
      return
    } catch (e) {
      console.error(e)
    }
  }
  if (my !== refreshSeq) return
  html.value = compute(q)
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
