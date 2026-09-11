<template>
  <div class="tiptap-editor border border-line rounded-[8px] bg-card" :class="{ compact }">
    <div v-if="editor" class="toolbar flex gap-1 p-1.5 bg-bg-accent border-b border-line flex-wrap items-center">
      <button class="btn btn-tiny" @click="insertInlineMath" title="插入行内公式"><i class="i-lucide-sigma" />公式</button>
      <button v-if="showBlank" class="btn btn-tiny" @click="insertBlank" title="插入填空">__ 填空</button>
      <label class="btn btn-tiny" title="插入行内图"><i class="i-lucide-image" />行内图<input type="file" accept="image/*" hidden @change="e=>uploadImage(e,'inlineImage')" /></label>
      <label class="btn btn-tiny" title="上传块级图"><i class="i-lucide-image" />块级图<input type="file" accept="image/*" hidden @change="e=>uploadImage(e,'imageBlock')" /></label>
      <button class="btn btn-tiny" @click="insertMathBlock" title="插入块公式"><i class="i-lucide-square-function" />块公式</button>
    </div>
    <BubbleMenu v-if="editor" :editor="editor" class="bubble-menu flex gap-[3px] p-1 bg-card border border-line rounded-[8px] shadow-lg items-center" :shouldShow="shouldShowBubble">
      <button class="btn btn-tiny" @click="editor.chain().focus().toggleBold().run()" :class="{ 'btn-primary': editor.isActive('bold') }" title="加粗"><b>B</b></button>
      <button class="btn btn-tiny" @click="editor.chain().focus().toggleItalic().run()" :class="{ 'btn-primary': editor.isActive('italic') }" title="斜体"><i>I</i></button>
      <label class="btn btn-tiny swatch relative inline-flex items-center gap-1 cursor-pointer" title="文字颜色">
        <span class="dot w-3 h-3 rounded-full inline-block border border-line-strong" :style="{background: editor.getAttributes('textStyle').color || '#1b1a17'}"></span>
        <input type="color" class="w-0 h-0 opacity-0 absolute" :value="editor.getAttributes('textStyle').color || '#1b1a17'" @input="editor.chain().focus().setColor($event.target.value).run()" />
      </label>
      <button class="btn btn-tiny" @click="editor.chain().focus().unsetColor().run()" title="清除颜色"><i class="i-lucide-rotate-ccw" /></button>
    </BubbleMenu>
    <editor-content :editor="editor" class="content" />

    <!-- LaTeX 行内编辑浮层 -->
    <teleport to="body">
      <div v-if="latexEdit.visible" ref="latexPop" class="latex-pop" :style="popStyle(latexEdit)" @mousedown.stop>
        <div class="pop-head" @mousedown="startDrag($event, latexEdit)">
          <span>{{ latexEdit.displayMode ? '块级公式' : '行内公式' }}</span>
          <button class="btn tiny close" @click="closeLatex">×</button>
        </div>
        <div class="latex-preview" v-html="latexPreview"></div>
        <textarea
          ref="latexInput"
          v-model="latexEdit.value"
          rows="2"
          class="latex-input"
          placeholder="LaTeX，如 \frac{a}{b}"
          @keydown.enter.exact.prevent="confirmLatex"
          @keydown.esc="closeLatex"
        ></textarea>
        <div class="latex-actions">
          <button class="btn tiny primary" @click="confirmLatex">确定</button>
          <button class="btn tiny" @click="closeLatex">取消</button>
          <span class="muted">Enter 确认 · Esc 取消 · 拖动标题栏移动</span>
        </div>
      </div>
    </teleport>

    <!-- 图片地址浮层 -->
    <teleport to="body">
      <div v-if="imgEdit.visible" ref="imgPop" class="latex-pop" :style="popStyle(imgEdit)" @mousedown.stop>
        <div class="pop-head" @mousedown="startDrag($event, imgEdit)">
          <span>图片</span>
          <button class="btn tiny close" @click="closeImg">×</button>
        </div>
        <img v-if="imgEdit.value" :src="imgEdit.value" class="img-preview" />
        <input v-model="imgEdit.value" class="latex-input" placeholder="图片 URL 或 data URI" @keydown.enter.exact.prevent="confirmImg" @keydown.esc="closeImg" />
        <div class="latex-actions">
          <button class="btn tiny primary" @click="confirmImg">确定</button>
          <button class="btn tiny" @click="closeImg">取消</button>
        </div>
      </div>
    </teleport>
  </div>
</template>

<script setup>
import { ref, reactive, watch, computed, onBeforeUnmount, nextTick } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import { BubbleMenu } from '@tiptap/vue-3/menus'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import { TextStyle } from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'
import { Node, mergeAttributes } from '@tiptap/core'
import katex from 'katex'

const props = defineProps({ modelValue: { type: Object, required: true }, showBlank: { type: Boolean, default: true }, compact: { type: Boolean, default: false } })
const emit = defineEmits(['update:modelValue','blankInserted'])

// ============ 自定义节点 ============
// —— InlineMath ——
const InlineMath = Node.create({
  name: 'inlineMath',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes(){ return { latex:{ default:'' } } },
  parseHTML(){ return [{tag:'span[data-type="inlineMath"]'}] },
  renderHTML({HTMLAttributes}){
    const latex = HTMLAttributes.latex||''
    let html=''
    try{ html=katex.renderToString(latex,{throwOnError:false}) }catch{ html=latex }
    return ['span', mergeAttributes({'data-type':'inlineMath', class:'inline-math'}, HTMLAttributes), html]
  },
  addNodeView(){
    return ({node, getPos, editor})=>{
      const span=document.createElement('span')
      span.className='inline-math clickable'
      const render=()=>{
        try{ span.innerHTML=katex.renderToString(node.attrs.latex||'',{throwOnError:false}) }catch{ span.textContent=node.attrs.latex||'' }
        span.title='点击编辑公式'
      }
      render()
      span.addEventListener('click',(ev)=>{
        openLatex({
          value: node.attrs.latex||'',
          anchorEl: span,
          onConfirm(v){ editor.chain().focus().setNodeSelection(getPos()).updateAttributes('inlineMath',{latex:v}).run() }
        })
      })
      return { dom:span, update(newNode){ if(newNode.attrs.latex!==node.attrs.latex) { node=newNode; render() } return true } }
    }
  }
})

// —— Blank ——
const Blank = Node.create({
  name: 'blank',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes(){ return { id:{default:''} } },
  parseHTML(){ return [{tag:'span[data-type="blank"]'}] },
  renderHTML({HTMLAttributes}){ return ['span', mergeAttributes({'data-type':'blank', class:'blank'}, HTMLAttributes)] },
  addNodeView(){
    return ({node})=>{
      const span=document.createElement('span')
      span.className='blank'
      span.textContent=''
      return { dom:span }
    }
  }
})

// —— InlineImage ——
const InlineImage = Node.create({
  name: 'inlineImage',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes(){ return { src:{default:''}, alt:{default:''} } },
  parseHTML(){ return [{tag:'img[data-inline]'}] },
  renderHTML({HTMLAttributes}){ return ['img', mergeAttributes({'data-inline':'true', style:'vertical-align:middle;height:1.4em;border-radius:4px;border:1px solid var(--line-strong)'}, HTMLAttributes)] },
})

// —— ImageBlock ——
const ImageBlock = Node.create({
  name: 'imageBlock',
  group: 'block',
  atom: true,
  addAttributes(){ return { src:{default:''}, caption:{default:''}, width:{default:600}, alt:{default:''} } },
  parseHTML(){ return [{tag:'figure[data-image-block]'}] },
  renderHTML({node}){
    return ['figure',{'data-image-block':'true', style:'text-align:center;margin:12px 0'},
      ['img',{src:node.attrs.src, alt:node.attrs.alt||node.attrs.caption, style:`max-width:${node.attrs.width}px;width:100%;border-radius:8px;border:1px solid #e3ddcd`}],
      ['figcaption',{style:'color:#7d7568;font-size:12px;margin-top:4px'}, node.attrs.caption||'']]
  },
  addNodeView(){
    return ({node, getPos, editor})=>{
      const wrap=document.createElement('div')
      wrap.style.cssText='border:1px solid var(--line);border-radius:10px;padding:8px;background:var(--bg-accent);margin:8px 0'
      const img=document.createElement('img')
      img.src=node.attrs.src||''
      img.style.cssText='max-width:100%;border-radius:8px;border:1px solid var(--line);background:#fffdf7;display:block;margin:0 auto;max-height:140px;cursor:pointer'
      img.title='点击更换图片'
      img.addEventListener('click',()=>{
        openImg({
          value: node.attrs.src||'',
          anchorEl: img,
          onConfirm(v){
            editor.commands.command(({tr,dispatch})=>{
              if(dispatch){ tr.setNodeMarkup(getPos(), undefined, {...node.attrs, src:v}) ; dispatch(tr) }
              return true
            })
            img.src=v
          }
        })
      })
      const cap=document.createElement('input')
      cap.value=node.attrs.caption||''
      cap.placeholder='图片标题'
      cap.style.cssText='width:100%;margin-top:6px;background:#fffdf7;border:1px solid var(--line);border-radius:6px;color:#1b1a17;padding:5px 8px;font-size:12px'
      cap.addEventListener('input',()=>{
        const pos=getPos()
        editor.chain().setNodeSelection(pos).updateAttributes('imageBlock',{caption:cap.value}).run()
      })
      wrap.appendChild(img)
      wrap.appendChild(cap)
      return { dom:wrap }
    }
  }
})

// —— MathBlock ——
const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  addAttributes(){ return { latex:{default:''} } },
  parseHTML(){ return [{tag:'div[data-math-block]'}] },
  renderHTML({node}){
    let html=''
    try{ html=katex.renderToString(node.attrs.latex||'',{throwOnError:false, displayMode:true}) }catch{ html=node.attrs.latex }
    return ['div',{'data-math-block':'true', class:'math-block', style:'text-align:center;padding:10px;background:var(--bg-accent);border:1px solid var(--line);border-radius:8px;margin:8px 0'}, html]
  },
  addNodeView(){
    return ({node, getPos, editor})=>{
      const div=document.createElement('div')
      div.style.cssText='border:1px dashed var(--primary-border);border-radius:10px;padding:10px;background:var(--bg-accent);margin:8px 0;text-align:center;cursor:pointer'
      const render=()=>{
        try{ div.innerHTML=katex.renderToString(node.attrs.latex||'',{throwOnError:false, displayMode:true}) }catch{ div.textContent=node.attrs.latex }
        div.title='点击编辑公式'
      }
      render()
      div.addEventListener('click',(ev)=>{
        openLatex({
          value: node.attrs.latex||'',
          anchorEl: div,
          displayMode:true,
          onConfirm(v){ editor.commands.command(({tr,dispatch})=>{
            if(dispatch){ tr.setNodeMarkup(getPos(), undefined, {...node.attrs, latex:v}); dispatch(tr) }
            return true
          })}
        })
      })
      return { dom:div, update(newNode){ if(newNode.attrs.latex!==node.attrs.latex){ node=newNode; render() } return true } }
    }
  }
})

// ============ 编辑器实例 ============
const editor = new Editor({
  extensions: [
    StarterKit.configure({ heading:false, horizontalRule:false }),
    TextStyle, Color.configure({ types:['textStyle'] }),
    Image.configure({ inline:false }),
    Placeholder.configure({ placeholder:'输入题干… 选中文本可加粗/变色' }),
    InlineMath, Blank, InlineImage, ImageBlock, MathBlock
  ],
  content: props.modelValue,
  onUpdate: ({editor})=>{
    emit('update:modelValue', editor.getJSON())
  }
})
watch(()=>props.modelValue, (val)=>{
  const cur = editor.getJSON()
  if(JSON.stringify(cur) !== JSON.stringify(val)){
    editor.commands.setContent(val, false)
  }
}, {deep:true})
onBeforeUnmount(()=> editor.destroy())

// ============ 浮层（LaTeX/图片）：定位 + 拖动 ============
const latexEdit = reactive({ visible:false, value:'', x:0, y:0, displayMode:false, confirm:null })
const imgEdit = reactive({ visible:false, value:'', x:0, y:0, confirm:null })
const latexInput = ref(null)
const latexPop = ref(null)
const imgPop = ref(null)
const latexPreview = computed(()=>{
  try{ return katex.renderToString(latexEdit.value||' ', {throwOnError:false, displayMode:latexEdit.displayMode}) }
  catch(e){ return '<span style="color:#ef4444">'+(e.message||'语法错误')+'</span>' }
})
// fixed 视口坐标，锚元素下方；右侧越界回缩，下方放不下弹到上方
function popStyle(state){
  return { left: state.x+'px', top: state.y+'px' }
}
function positionPop(state, anchorEl, width){
  const rect = anchorEl.getBoundingClientRect()
  const vw = window.innerWidth, vh = window.innerHeight
  let x = rect.left
  let y = rect.bottom + 8
  if(x + width > vw - 12) x = Math.max(12, vw - width - 12)
  if(y + 240 > vh) y = Math.max(12, rect.top - 248)
  state.x = Math.max(12, x)
  state.y = Math.max(12, y)
}
// 拖动（按住标题栏）
let drag=null
function startDrag(ev, state){
  drag = { state, sx: ev.clientX, sy: ev.clientY, ox: state.x, oy: state.y }
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', stopDrag)
}
function onDragMove(ev){
  if(!drag) return
  const vw=window.innerWidth
  drag.state.x = Math.max(0, Math.min(vw-80, drag.ox + (ev.clientX - drag.sx)))
  drag.state.y = Math.max(0, drag.oy + (ev.clientY - drag.sy))
}
function stopDrag(){
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', stopDrag)
  drag=null
}
onBeforeUnmount(()=> stopDrag())

function openLatex({value, anchorEl, displayMode=false, onConfirm}){
  latexEdit.value=value
  latexEdit.displayMode=displayMode
  latexEdit.confirm=onConfirm
  latexEdit.visible=true
  positionPop(latexEdit, anchorEl, 340)
  nextTick(()=> latexInput.value?.focus())
}
function confirmLatex(){
  const v=latexEdit.value.trim()
  if(!v){ closeLatex(); return }
  latexEdit.confirm?.(v)
  closeLatex()
}
function closeLatex(){ latexEdit.visible=false }

function openImg({value, anchorEl, onConfirm}){
  imgEdit.value=value
  imgEdit.confirm=onConfirm
  imgEdit.visible=true
  positionPop(imgEdit, anchorEl, 360)
}
function confirmImg(){
  const v=imgEdit.value.trim()
  if(!v){ closeImg(); return }
  imgEdit.confirm?.(v)
  closeImg()
}
function closeImg(){ imgEdit.visible=false }

// ============ 插入动作 ============
function insertInlineMath(){
  const anchorDom = selectionAnchorDom()
  openLatex({
    value:'', anchorEl: anchorDom,
    onConfirm(v){ editor.chain().focus().insertContent({type:'inlineMath', attrs:{latex:v}}).run() }
  })
}
function insertMathBlock(){
  const anchorDom = selectionAnchorDom()
  openLatex({
    value:'', anchorEl: anchorDom, displayMode:true,
    onConfirm(v){ editor.chain().focus().insertContent({type:'mathBlock', attrs:{latex:v}}).run() }
  })
}
// 取当前选区的 DOM 元素作为浮层锚点（取选区起点所在段落）
function selectionAnchorDom(){
  try{
    const { $from } = editor.state.selection
    const dom = editor.view.nodeDOM($from.pos)
    if(dom instanceof HTMLElement) return dom
  }catch{}
  return editor.view.dom
}
function insertBlank(){
  // 收集现有 blank id 取 max 序号 +1，生成 b{n}
  const docJson = editor.getJSON()
  let max=0
  function walk(n){ if(!n) return; if(n.type==='blank'){ const m=/^b(\d+)$/.exec(n.attrs.id||''); if(m) max=Math.max(max, Number(m[1])) } if(n.content) n.content.forEach(walk) }
  walk(docJson)
  const newId = `b${max+1}`
  const { from, to } = editor.state.selection
  let selectedText=''
  if(from !== to){
    try{ selectedText = editor.state.doc.textBetween(from, to, ' ').trim() }catch{}
  }
  if(selectedText){
    editor.chain().focus().deleteSelection().insertContent({type:'blank', attrs:{id:newId}}).run()
    emit('blankInserted', { id: newId, text: selectedText })
  } else {
    editor.chain().focus().insertContent({type:'blank', attrs:{id:newId}}).run()
  }
}
function shouldShowBubble({ state }){
  const { from, to } = state.selection
  if(from === to) return false
  let hasAtom=false
  state.doc.nodesBetween(from, to, node=>{
    if(['blank','inlineMath','inlineImage','imageBlock','mathBlock'].includes(node.type.name)) hasAtom=true
  })
  return !hasAtom
}

// ============ 图片上传 → data URI ============
const FALLBACK_SVG='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MDAiIGhlaWdodD0iMjAwIj48cmVjdCB3aWR0aD0iNjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iI2YxZjVmOSIvPjx0ZXh0IHg9IjMwMCIgeT0iMTAwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjOTRhM2I4Ij7pooTop4jlrZDpgJrov4c8L3RleHQ+PC9zdmc+'
function uploadImage(ev, kind){
  const file = ev.target.files?.[0]
  ev.target.value='' // 允许重复选择同一文件
  if(!file) return
  const reader=new FileReader()
  reader.onload=()=>{
    const src=String(reader.result||'')
    if(kind==='inlineImage'){
      editor.chain().focus().insertContent({type:'inlineImage', attrs:{src, alt:file.name}}).run()
    } else {
      editor.chain().focus().insertContent({type:'imageBlock', attrs:{src, caption:file.name.replace(/\.[^.]+$/,''), width:600}}).run()
    }
  }
  reader.readAsDataURL(file)
}
</script>

<style scoped>
.content{ padding:8px 10px; min-height:72px; background:var(--card) }
.content :deep(.tiptap){ outline:none; min-height:100px; color:var(--text-secondary) }
.content :deep(p){ margin:8px 0 }
.compact .content{ padding:4px 8px; min-height:0 }
.compact .content :deep(.tiptap){ min-height:22px }
.compact .content :deep(p){ margin:2px 0; line-height:1.5 }
.content :deep(p.is-editor-empty:first-child::before){ content:attr(data-placeholder); color:var(--muted-light); float:left; height:0; pointer-events:none }
.content :deep(img){ max-width:100%; border-radius:8px; border:1px solid var(--line) }
.content :deep(.inline-math.clickable){ background:var(--primary-bg); border:1px solid var(--primary-border); border-radius:999px; padding:2px 8px; font-size:12px; color:var(--primary) }
.content :deep(.blank){ display:inline-block; min-width:72px; border-bottom:2px solid var(--primary); color:var(--primary); text-align:center; padding:0 6px; margin:0 2px; font-weight:600; background:var(--primary-bg); border-radius:4px 4px 0 0 }
</style>

<style>
/* LaTeX / 图片浮层 — teleport 到 body，非 scoped；fixed 视口定位 */
.latex-pop{
  position:fixed; z-index:1000; width:340px;
  background:#fffdf7; border:1px solid var(--line-strong); border-radius:12px;
  box-shadow:0 12px 24px rgba(0,0,0,.14), 0 4px 8px rgba(0,0,0,.08);
  padding:0 12px 12px;
}
.latex-pop .pop-head{
  display:flex; align-items:center; justify-content:space-between;
  margin:0 -12px 8px; padding:7px 12px;
  background:var(--bg-accent); border-bottom:1px solid var(--line);
  border-radius:12px 12px 0 0;
  font-size:12px; font-weight:700; color:#3d3a33;
  cursor:move; user-select:none;
}
.latex-pop .pop-head .close{ border:none; background:transparent; font-size:14px; color:#7d7568 }
.latex-pop .latex-input{
  width:100%; box-sizing:border-box; resize:vertical;
  font-family:ui-monospace,Consolas,monospace; font-size:13px;
  background:var(--bg-accent); border:1px solid var(--line);
  border-radius:8px; color:#1b1a17; padding:8px;
}
.latex-pop .latex-input:focus{ outline:none; border-color:#1f4d3a }
.latex-pop .latex-preview{
  background:#f4f1ea; border:1px solid var(--line); border-radius:8px;
  padding:10px; margin:10px 0 8px; min-height:36px; overflow:auto; text-align:center;
}
.latex-pop .img-preview{
  max-width:100%; max-height:120px; display:block; margin:10px auto 8px;
  border-radius:8px; border:1px solid var(--line); background:#fffdf7;
}
.latex-pop .latex-actions{ display:flex; gap:8px; margin-top:8px; align-items:center }
.latex-pop .latex-actions .muted{ margin-left:auto }
.latex-pop .btn.primary{ background:#1f4d3a; border-color:#1f4d3a; color:#fffdf7 }
.latex-pop .btn{ background:#fffdf7; border:1px solid var(--line); color:#3d3a33; padding:5px 12px; border-radius:8px; cursor:pointer; font-size:12px; font-weight:500 }
.latex-pop .btn:hover{ background:#ece7db }
</style>
