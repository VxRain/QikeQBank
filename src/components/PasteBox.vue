<template>
  <div class="paste-box">
    <div class="row" style="justify-content:space-between;margin-bottom:6px">
      <b style="font-size:13px">粘贴智能填入（纯文本通用模板）</b>
      <span class="muted" style="font-size:11px">支持：A. B. C. D. / 填空___/（） / 判断正确·错误 / 材料题</span>
    </div>
    <textarea v-model="text" class="textarea" rows="4" placeholder="粘贴纯文本，例如：&#10;单选：成本函数…？&#10;A. 220元  B. 200元  C. 180元  D. 250元&#10;答案：A&#10;解析：代入…&#10;&#10;或：材料：某工厂…&#10;1. 当产量10时成本是？ A.220 B.200 答案：A&#10;2. 填空 ___ 元"></textarea>
    <div class="row" style="margin-top:6px">
      <button class="btn primary" @click="onParse" :disabled="!text.trim()">智能填入</button>
      <button class="btn" @click="text=''">清空</button>
      <span v-if="msg" class="badge" :class="msgOk?'ok':'bad'">{{ msg }}</span>
      <span v-if="warn" class="muted" style="font-size:11px">{{ warn }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { parsePureText } from '@/utils/parsePureText.js'
import { validateQuestion } from '@/utils/validate.js'

const emit = defineEmits(['parsed'])
const text = ref('')
const msg = ref('')
const msgOk = ref(false)
const warn = ref('')

function onParse(){
  const raw = text.value.trim()
  if(!raw){ msg.value='请先粘贴文本'; msgOk.value=false; return }
  try{
    const q = parsePureText(raw)
    // material 的 children 已在解析中生成
    const v = validateQuestion(q.id ? q : { ...q, id:'tmp' })
    if(!v.valid){
      warn.value = '需手动核对：' + v.errors.slice(0,2).join('； ')
    } else warn.value = ''
    // 补齐通用字段
    if(!q.difficulty) q.difficulty = 2
    if(!q.score && q.type!=='material') q.score = q.type==='judge'?2:5
    if(!q.plain_text) q.plain_text = ''
    msg.value = `已识别：${q.type}${q.type==='material'?'（'+(q.children?.length||0)+'子题）':''}，已填入下方`
    msgOk.value = true
    emit('parsed', q)
  }catch(e){
    msg.value = '解析失败：' + String(e.message||e)
    msgOk.value = false
  }
}
</script>

<style scoped>
.paste-box{ background:var(--bg-accent); border:1px dashed var(--line-strong); border-radius:10px; padding:10px 12px; margin-bottom:10px }
.textarea{ width:100%; background:var(--card); border:1px solid var(--line); border-radius:8px; color:var(--text); padding:8px; font-size:12px; line-height:1.6; resize:vertical }
.textarea:focus{ border-color:var(--primary); outline:none }
.row{ display:flex; align-items:center; gap:8px; flex-wrap:wrap }
.btn{ background:var(--card); border:1px solid var(--line); color:var(--text-secondary); padding:5px 10px; border-radius:6px; cursor:pointer; font-size:11px }
.btn.primary{ background:var(--text); color:#fff; border-color:var(--text) }
.badge{ font-size:11px; padding:3px 8px; border-radius:999px; border:1px solid var(--line); background:var(--card) }
.badge.ok{ color:var(--success); border-color:#86efac; background:var(--success-bg) }
.badge.bad{ color:var(--danger); border-color:#fecaca; background:var(--danger-bg) }
.muted{ color:var(--muted) }
</style>
