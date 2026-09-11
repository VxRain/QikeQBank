<template>
  <div class="paste-box border border-dashed border-line-strong rounded-[8px] bg-bg-accent p-3 mb-2.5">
    <div class="flex items-center justify-between mb-1.5 gap-2 flex-wrap">
      <b class="text-[13px] flex items-center gap-1.5"><i class="i-lucide-clipboard text-primary text-[14px]" />粘贴智能填入（纯文本通用模板）</b>
      <span class="text-muted text-[11px] flex items-center gap-1"><i class="i-lucide-info text-[12px]" />支持：A. B. C. D. / 填空___/（） / 判断正确·错误 / 材料题</span>
    </div>
    <textarea v-model="text" class="w-full bg-card border border-line rounded-[8px] text-text p-2 text-[12px] leading-[1.6] resize-y outline-none transition-[border-color,box-shadow] duration-150 focus:border-primary focus:shadow-[0_0_0_3px_rgba(31,77,58,0.15)]" rows="4" placeholder="粘贴纯文本，例如：&#10;单选：成本函数…？&#10;A. 220元  B. 200元  C. 180元  D. 250元&#10;答案：A&#10;解析：代入…&#10;&#10;或：材料：某工厂…&#10;1. 当产量10时成本是？ A.220 B.200 答案：A&#10;2. 填空 ___ 元"></textarea>
    <div class="flex items-center gap-2 mt-1.5 flex-wrap">
      <button class="btn btn-primary btn-tiny" @click="onParse" :disabled="!text.trim()"><i class="i-lucide-wand-sparkles" />智能填入</button>
      <button class="btn btn-tiny" @click="text=''"><i class="i-lucide-x" />清空</button>
      <span v-if="msg" class="badge" :class="msgOk?'badge-ok':'badge-bad'">{{ msg }}</span>
      <span v-if="warn" class="text-muted text-[11px]">{{ warn }}</span>
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

