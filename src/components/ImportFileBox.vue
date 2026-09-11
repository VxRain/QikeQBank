/**
 * 模板文件导入弹窗（txt / md）
 * 流程：选文件 → 解码（UTF-8 优先，GBK 兜底）→ md 预处理 → 严格模板解析 →
 * 预览（一票否决：有错块则不可导入）→ 批量入库到目标题库。
 */
<template>
  <Teleport to="body">
    <Transition name="dg">
      <div v-if="open" class="dg-mask fixed inset-0 z-[1000] flex items-center justify-center bg-[rgba(15,23,42,0.45)] backdrop-blur-[3px]" @click.self="onClose">
        <div class="dg-card w-[min(640px,calc(100vw-48px))] max-h-[calc(100vh-96px)] flex flex-col bg-card border border-line rounded-lg shadow-[0_20px_40px_rgba(2,6,23,0.25),0_4px_12px_rgba(2,6,23,0.12)] px-6 pt-5.5 pb-4.5" role="dialog" aria-label="导入试题文件">
          <h3 class="m-0 mb-1 text-[17px] font-700 tracking-[-0.01em] text-text font-[var(--serif)] flex items-center gap-2">
            <i class="i-lucide-file-up text-primary" />导入试题文件
          </h3>
          <p class="m-0 mb-4 text-[12px] text-muted">
            目标题库：<b class="text-text">{{ bankName }}</b> · 仅支持按模板编写的 .txt / .md
            <button type="button" class="ml-2 text-primary hover:underline bg-transparent border-none cursor-pointer text-[12px] p-0" @click="downloadSample">
              下载模板示例
            </button>
          </p>

          <!-- pick -->
          <div v-if="phase === 'pick'">
            <label class="flex flex-col items-center justify-center gap-2 border border-dashed border-line-strong rounded-[10px] bg-bg-accent px-4 py-8 cursor-pointer transition-[border-color,background-color] duration-150 hover:border-primary hover:bg-primary-bg">
              <i class="i-lucide-upload text-[28px] text-muted" />
              <span class="text-[14px] font-600 text-text">点击选择 .txt / .md 文件</span>
              <span class="text-[12px] text-muted">须按模板编写：每题以【单选/多选/判断/填空/问答/材料】开头</span>
              <input ref="fileEl" type="file" accept=".txt,.md,.markdown,.text" class="hidden" @change="onFile" />
            </label>
            <div v-if="fileError" class="error-box mt-3">{{ fileError }}</div>
            <div class="flex justify-end gap-2.5 mt-4">
              <button type="button" class="btn" @click="onClose">取消</button>
            </div>
          </div>

          <!-- preview -->
          <div v-else-if="phase === 'preview'" class="flex flex-col gap-3 min-h-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="badge badge-ok">{{ okCount }} 块通过</span>
              <span v-if="failCount" class="badge badge-bad">{{ failCount }} 块有误</span>
              <span class="text-[12px] text-muted truncate">{{ fileName }}</span>
            </div>
            <div v-if="failCount" class="error-box">
              有误的块须修改文件后重新选择（整文件一票否决，不入库脏数据）
            </div>
            <div class="overflow-y-auto flex flex-col gap-1.5 min-h-0 max-h-[320px] pr-0.5">
              <div
                v-for="b in blocks"
                :key="b.index"
                class="flex items-start gap-2 px-3 py-2 border rounded-[8px] text-[13px]"
                :class="b.error ? 'border-[#e3c9c5] bg-danger-bg' : 'border-line bg-card'"
              >
                <span class="text-muted-light text-[12px] w-7 shrink-0 pt-0.5">#{{ b.index }}</span>
                <span v-if="!b.error" class="badge badge-type shrink-0">{{ b.typeLabel }}{{ b.question?.type === 'material' ? `·${b.question.children.length}子题` : '' }}</span>
                <span v-else class="badge badge-bad shrink-0">有误</span>
                <span class="min-w-0 flex-1 text-text-secondary leading-[1.6] break-all">{{ b.error || b.stemText }}</span>
              </div>
            </div>
            <div class="flex justify-end gap-2.5">
              <button type="button" class="btn" @click="phase = 'pick'">重选文件</button>
              <button type="button" class="btn btn-primary" :disabled="failCount > 0 || !blocks.length" @click="onImport">
                <i class="i-lucide-check" />确认导入 {{ okCount }} 题
              </button>
            </div>
          </div>

          <!-- importing -->
          <div v-else-if="phase === 'importing'" class="flex flex-col gap-3 py-4">
            <div class="text-[14px] text-text-secondary flex items-center gap-2">
              <i class="i-lucide-loader-circle animate-spin text-primary" />正在导入 {{ doneCount }} / {{ blocks.length }}…
            </div>
            <div class="progress-track"><div class="progress-inner" :style="{ width: Math.round((doneCount / blocks.length) * 100) + '%' }"></div></div>
          </div>

          <!-- result -->
          <div v-else class="flex flex-col gap-3">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="badge badge-ok">成功 {{ successCount }} 题</span>
              <span v-if="failed.length" class="badge badge-bad">失败 {{ failed.length }} 题</span>
            </div>
            <div v-if="failed.length" class="overflow-y-auto flex flex-col gap-1.5 max-h-[200px]">
              <div v-for="(f, i) in failed" :key="i" class="px-3 py-2 border border-[#e3c9c5] bg-danger-bg rounded-[8px] text-[12px] text-text-secondary break-all">
                {{ f.stem }} —— {{ f.reason }}
              </div>
            </div>
            <div class="flex justify-end gap-2.5">
              <button type="button" class="btn btn-primary" @click="onFinish">完成</button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref } from 'vue'
import { parseTemplateFile } from '@/utils/parseTemplate.js'
import { TEMPLATE_SAMPLE } from '@/utils/parseTemplate.js'
import { stripMarkdown } from '@/utils/stripMarkdown.js'
import { saveTextFile } from '@/api/practice.js'
import { validateQuestion } from '@/utils/validate.js'
import { normalizeQuestion, getAggregatedPlainText } from '@/utils/normalize.js'
import { create } from '@/api/questions.js'
import { toast } from '@/stores/ui.js'

const props = defineProps({
  bankId: { type: String, required: true },
  bankName: { type: String, default: '' },
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['done', 'close'])

const phase = ref('pick') // pick | preview | importing | result
const fileEl = ref(null)
const fileName = ref('')
const fileError = ref('')
const blocks = ref([]) // [{index,type,typeLabel,stemText,question,error}]
const okCount = ref(0)
const failCount = ref(0)
const doneCount = ref(0)
const successCount = ref(0)
const failed = ref([])

function reset() {
  phase.value = 'pick'
  fileName.value = ''
  fileError.value = ''
  blocks.value = []
  okCount.value = 0
  failCount.value = 0
  doneCount.value = 0
  successCount.value = 0
  failed.value = []
  if (fileEl.value) fileEl.value.value = ''
}

function onClose() {
  if (phase.value === 'importing') return
  reset()
  emit('close')
}

async function downloadSample() {
  // Tauri 真机：blob <a download> 在 WebView 里无默认保存处理，走后端落盘返 path；
  // 无后端环境（浏览器 dev）：回退前端 blob 下载
  try {
    const res = await saveTextFile(TEMPLATE_SAMPLE, '试题导入模板.md')
    toast('模板已保存到：' + (res?.path || ''), 'success', 6000)
    return
  } catch (e) {
    console.warn('save_text_file 不可用，回退 blob 下载', e)
  }
  try {
    const blob = new Blob([TEMPLATE_SAMPLE], { type: 'text/markdown;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = '试题导入模板.md'
    // 必须挂载到 DOM 再点：未挂载的程序化 click 在 WebView 里会被吞掉
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  } catch (err) {
    console.error(err)
    toast('模板下载失败：' + (err?.message || err), 'error')
  }
}

async function onFile(e) {
  const f = e.target.files?.[0]
  if (!f) return
  fileError.value = ''
  fileName.value = f.name
  try {
    const buf = await f.arrayBuffer()
    let text = ''
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      text = new TextDecoder('gbk').decode(buf)
    }
    if (!text.trim()) {
      fileError.value = '文件为空'
      return
    }
    const isMd = /\.(md|markdown)$/i.test(f.name)
    const { blocks: parsed } = parseTemplateFile(isMd ? stripMarkdown(text) : text)
    if (!parsed.length) {
      fileError.value = '未识别到任何题块：每题须以【单选/多选/判断/填空/问答/材料】开头'
      return
    }
    // 补默认分值/难度（与 PasteBox 一致），validate 需临时 id
    for (const b of parsed) {
      const q = b.question
      if (!q) continue
      if (q.type === 'material') {
        for (const c of q.children || []) {
          if (!c.difficulty) c.difficulty = 2
          if (!c.score) c.score = c.type === 'judge' ? 2 : 5
        }
      } else {
        if (!q.difficulty) q.difficulty = 2
        if (!q.score) q.score = q.type === 'judge' ? 2 : 5
      }
      const v = validateQuestion({ ...q, id: `imp_${b.index}` })
      if (!v.valid) {
        b.error = `第 ${b.index} 块【${b.typeLabel}】结构校验未通过：${(v.errors || []).slice(0, 2).join('；')}`
        b.question = null
      }
    }
    blocks.value = parsed
    okCount.value = parsed.filter((b) => !b.error).length
    failCount.value = parsed.filter((b) => b.error).length
    phase.value = 'preview'
  } catch (err) {
    console.error(err)
    fileError.value = '读取失败：' + (err?.message || err)
  }
}

async function onImport() {
  const valids = blocks.value.filter((b) => !b.error && b.question)
  if (!valids.length) return
  phase.value = 'importing'
  doneCount.value = 0
  successCount.value = 0
  failed.value = []
  for (const b of valids) {
    try {
      const q = JSON.parse(JSON.stringify(b.question))
      delete q.id
      q.bank_id = props.bankId
      normalizeQuestion(q)
      q.plain_text = getAggregatedPlainText(q)
      await create(q)
      successCount.value++
    } catch (err) {
      console.error(err)
      failed.value.push({ stem: `#${b.index} ${b.stemText.slice(0, 40)}`, reason: err?.message || String(err) })
    } finally {
      doneCount.value++
    }
  }
  phase.value = 'result'
}

function onFinish() {
  const n = successCount.value
  reset()
  emit('done')
  if (n) toast(`已导入 ${n} 道题`, 'success')
}
</script>

<style scoped>
.dg-enter-active, .dg-leave-active { transition: opacity .18s ease; }
.dg-enter-active .dg-card, .dg-leave-active .dg-card { transition: transform .18s ease; }
.dg-enter-from, .dg-leave-to { opacity: 0; }
.dg-enter-from .dg-card, .dg-leave-to .dg-card { transform: translateY(8px) scale(.97); }
</style>
