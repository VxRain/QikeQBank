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
            目标题库：<b class="text-text">{{ bankName }}</b>
          </p>

          <div class="flex items-center justify-between gap-2 mb-2">
            <div class="field-label !mb-0">模板示例（照着格式准备好再导入）</div>
            <button type="button" class="btn btn-small shrink-0" @click="openDir"><i class="i-lucide-folder-open" />打开文件夹</button>
          </div>
          <div class="flex flex-col gap-2 mb-4">
            <div
              v-for="t in templates"
              :key="t.file"
              class="flex items-center gap-2.5 px-3 py-2 border border-line rounded-[8px] bg-bg-accent"
            >
              <i class="i-lucide-file-text text-primary text-[16px] shrink-0" />
              <span class="min-w-0 flex-1">
                <span class="block text-[13px] font-600 text-text">{{ t.title }}</span>
                <span class="block text-[12px] text-muted leading-[1.5]">{{ t.desc }}</span>
              </span>
            </div>
          </div>

          <div class="field-label">从文件导入</div>

          <!-- pick -->
          <div v-if="phase === 'pick'">
            <label class="flex flex-col items-center justify-center gap-2 border border-dashed border-line-strong rounded-[10px] bg-bg-accent px-4 py-8 cursor-pointer transition-[border-color,background-color] duration-150 hover:border-primary hover:bg-primary-bg">
              <i class="i-lucide-upload text-[28px] text-muted" />
              <span class="text-[14px] font-600 text-text">点击选择 .txt / .md / .xlsx / .docx 文件</span>
              <span class="text-[12px] text-muted">文本须按模板编写：每题以【单选/多选/判断/填空/问答/材料】开头；表格须含 ID/题目/题型/答案列；文档按章节题号排版</span>
              <input ref="fileEl" type="file" accept=".txt,.md,.markdown,.text,.xlsx,.xls,.csv,.docx" class="hidden" @change="onFile" />
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
            <div v-if="warnText" class="text-[12px] text-muted flex items-center gap-1.5 px-1">
              <i class="i-lucide-triangle-alert" />{{ warnText }}
            </div>
            <div v-if="failCount" class="error-box">
              {{ failCount }} 块有误不会入库，可直接导入通过的部分，或改完文件重来
            </div>
            <div class="overflow-y-auto flex flex-col gap-1.5 min-h-0 max-h-[320px] pr-0.5">
              <template v-for="b in blocks" :key="b.index">
              <div
                class="flex items-start gap-2 px-3 py-2 border rounded-[8px] text-[13px]"
                :class="b.error ? 'border-[#e3c9c5] bg-danger-bg' : 'border-line bg-card'"
              >
                <span class="text-muted-light text-[12px] w-7 shrink-0 pt-0.5">#{{ b.index }}</span>
                <span v-if="!b.error" class="badge badge-type shrink-0 !py-0 h-[22px] inline-flex items-center">{{ b.typeLabel }}{{ b.question?.type === 'material' ? `·${b.question.children.length}子题` : '' }}</span>
                <span v-else class="badge badge-bad shrink-0 !py-0 h-[22px] inline-flex items-center">有误</span>
                <span class="min-w-0 flex-1 text-text-secondary leading-[1.6] break-all">{{ b.error || b.stemText }}</span>
                <button
                  v-if="b.error || b.question"
                  type="button"
                  class="btn btn-tiny shrink-0 !py-0 h-[22px] inline-flex items-center"
                  :title="openIdx === b.index ? '收起' : (b.error ? '查看原文' : '预览题目')"
                  @click="openIdx = openIdx === b.index ? null : b.index"
                >{{ openIdx === b.index ? '收起' : (b.error ? '原文' : '预览') }}</button>
              </div>
              <div v-if="openIdx === b.index" class="px-3 py-2 border border-line rounded-[8px] bg-bg-accent">
                <pre v-if="b.error" class="m-0 text-[12px] leading-[1.6] text-text-secondary whitespace-pre-wrap break-all font-inherit">{{ b.raw || '(无原文)' }}
<span class="text-danger font-600">{{ b.error }}</span></pre>
                <QuestionPreview v-else-if="b.question" :question="b.question" />
              </div>
              </template>
            </div>
            <div class="flex justify-end gap-2.5 items-center">
              <span v-if="failCount" class="text-[12px] text-muted mr-auto">{{ failCount }} 块有误将被跳过</span>
              <button type="button" class="btn" @click="phase = 'pick'">重选文件</button>
              <button type="button" class="btn btn-primary" :disabled="!okCount" @click="onImport">
                <i class="i-lucide-check" />确认导入 {{ okCount }} 题
              </button>
            </div>
          </div>

          <!-- importing -->
          <div v-else-if="phase === 'importing'" class="flex flex-col gap-3 py-4">
            <div class="text-[14px] text-text-secondary flex items-center gap-2">
              <i class="i-lucide-loader-circle animate-spin text-primary" />正在批量导入 {{ validTotal }} 题…
            </div>
          </div>

          <!-- result -->
          <div v-else class="flex flex-col gap-3">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="badge badge-ok">成功 {{ successCount }} 题</span>
              <span v-if="dupCount" class="badge badge-type">跳过重复 {{ dupCount }} 题</span>
              <span v-if="failed.length" class="badge badge-bad">失败 {{ failed.length }} 题</span>
            </div>
            <div v-if="dups.length" class="overflow-y-auto flex flex-col gap-1.5 max-h-[120px]">
              <div v-for="(d, i) in dups" :key="'d'+i" class="px-3 py-2 border border-line bg-bg-accent rounded-[8px] text-[12px] text-muted break-all">
                #{{ d.index }} 已跳过（{{ d.reason }})
              </div>
            </div>
            <div v-if="failed.length" class="overflow-y-auto flex flex-col gap-1.5 max-h-[200px]">
              <div v-for="(f, i) in failed" :key="i" class="px-3 py-2 border border-[#e3c9c5] bg-danger-bg rounded-[8px] text-[12px] text-text-secondary break-all">
                {{ f.stem }} —— {{ f.reason }}
              </div>
            </div>
            <div class="flex justify-end gap-2.5">
              <button v-if="insertedIds.length" type="button" class="btn btn-danger" :disabled="undoing" @click="onUndo">
                <i class="i-lucide-rotate-ccw" />{{ undoing ? '撤销中…' : `撤销本次导入（${insertedIds.length} 题）` }}
              </button>
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
import { parseSheetRows } from '@/utils/parseSheet.js'
import { parseDocxFile } from '@/utils/parseDocxTemplate.js'
import * as XLSX from 'xlsx'
import mammoth from 'mammoth'
import { stripMarkdown } from '@/utils/stripMarkdown.js'
import { openTemplatesDir as openTemplatesDirApi, importQuestions } from '@/api/practice.js'
import { validateQuestion } from '@/utils/validate.js'
import { normalizeQuestion, getAggregatedPlainText } from '@/utils/normalize.js'
import { remove } from '@/api/questions.js'
import QuestionPreview from '@/components/QuestionPreview.vue'
import { toast, confirmDialog } from '@/stores/ui.js'

const templates = [
  { file: 'MD模板.md', title: 'MD模板.md', desc: '记事本手写：每题以【单选/多选/判断/填空/问答/材料】开头，适合少量精编' },
  { file: 'Excel模板.xlsx', title: 'Excel模板.xlsx', desc: '表格批量：按 ID/题目/题型/答案列填写，适合大批量' },
  { file: 'Word模板.docx', title: 'Word模板.docx', desc: 'Word 章节题号排版，老师现有卷子直接改' },
]

async function openDir() {
  // 文件夹由后端 open_templates_dir 直接打开（便携目录走前端 openPath 会被 scope 拦）
  try {
    await openTemplatesDirApi()
  } catch (err) {
    console.error(err)
    toast('打开文件夹失败：' + (err?.message || err), 'error')
  }
}

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
const blocks = ref([]) // [{index,type,typeLabel,stemText,raw,startLine,question,error}]
const warnText = ref('')
const okCount = ref(0)
const failCount = ref(0)
const openIdx = ref(null)
const validTotal = ref(0)
const successCount = ref(0)
const dupCount = ref(0)
const dups = ref([])
const failed = ref([])
const insertedIds = ref([])
const batchId = ref('')
const undoing = ref(false)

function reset() {
  phase.value = 'pick'
  fileName.value = ''
  fileError.value = ''
  blocks.value = []
  okCount.value = 0
  failCount.value = 0
  openIdx.value = null
  warnText.value = ''
  validTotal.value = 0
  successCount.value = 0
  dupCount.value = 0
  dups.value = []
  failed.value = []
  insertedIds.value = []
  batchId.value = ''
  undoing.value = false
  if (fileEl.value) fileEl.value.value = ''
}

function onClose() {
  if (phase.value === 'importing') return
  reset()
  emit('close')
}

async function onFile(e) {
  const f = e.target.files?.[0]
  if (!f) return
  fileError.value = ''
  fileName.value = f.name
  try {
    const isMd = /\.(md|markdown)$/i.test(f.name)
    const isSheet = /\.(xlsx|xls|csv)$/i.test(f.name)
    const isDocx = /\.docx$/i.test(f.name)
    let parsed
    let docWarnings = null
    if (isSheet) {
      // Excel：首个 sheet → 二维数组 → 表格解析（表头定位，ID 分组）
      const buf = await f.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      if (!ws) {
        fileError.value = '工作簿中没有工作表'
        return
      }
      parsed = parseSheetRows(XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }))
    } else if (isDocx) {
      // Word：mammoth 转 HTML → 章节/题号状态机组装；公式图片只计数跳过
      const buf = await f.arrayBuffer()
      const r = await parseDocxFile({ arrayBuffer: buf }, mammoth)
      parsed = r
      docWarnings = r.warnings
    } else {
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
      parsed = parseTemplateFile(isMd ? stripMarkdown(text) : text)
    }
    if (!parsed.blocks.length) {
      fileError.value = isSheet ? '表中没有任何数据行' : (isDocx ? '文档中未识别到任何题目' : '未识别到任何题块：每题须以【单选/多选/判断/填空/问答/材料】开头')
      return
    }
    warnText.value = docWarnings && (docWarnings.images + docWarnings.formulas)
      ? `文档中公式 ${docWarnings.formulas} 处、图片 ${docWarnings.images} 张暂不支持，已跳过` : ''
    const list = parsed.blocks
    // 补默认分值/难度（与 PasteBox 一致），validate 需临时 id
    for (const b of list) {
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
    blocks.value = list
    okCount.value = list.filter((b) => !b.error).length
    failCount.value = list.filter((b) => b.error).length
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
  validTotal.value = valids.length
  successCount.value = 0
  dupCount.value = 0
  dups.value = []
  failed.value = []
  insertedIds.value = []
  try {
    // 前端归一化 + 纯文本聚合，后端单命令事务批量入库（含库内判重）
    const items = valids.map((b) => {
      const q = JSON.parse(JSON.stringify(b.question))
      delete q.id
      normalizeQuestion(q)
      q.plain_text = getAggregatedPlainText(q)
      return { q, index: b.index, stemText: b.stemText }
    })
    const data = await importQuestions(items.map((x) => x.q), props.bankId)
    batchId.value = data?.batch_id || ''
    for (const r of data?.items || []) {
      const src = items[r.index - 1]
      if (r.status === 'inserted') {
        successCount.value++
        if (r.id) insertedIds.value.push(r.id)
      } else if (r.status === 'duplicate') {
        dupCount.value++
        dups.value.push({ index: r.index, reason: r.message || '重复' })
      } else {
        failed.value.push({ stem: `#${r.index} ${(src?.stemText || '').slice(0, 40)}`, reason: r.message || '未知错误' })
      }
    }
  } catch (err) {
    console.error(err)
    failed.value.push({ stem: '批量导入', reason: err?.message || String(err) })
  }
  phase.value = 'result'
}

async function onUndo() {
  if (!insertedIds.value.length || undoing.value) return
  const ok = await confirmDialog({
    title: '撤销本次导入',
    message: `确定删除本次导入的 ${insertedIds.value.length} 道试题？此操作不可撤销。`,
    okText: '撤销导入',
    danger: true
  })
  if (!ok) return
  undoing.value = true
  let fail = 0
  try {
    for (const id of insertedIds.value) {
      try {
        await remove(id)
      } catch (e) {
        fail++
        console.error('undo failed', id, e)
      }
    }
    toast(fail ? `撤销完成，${fail} 道失败` : `已撤销本次导入（${insertedIds.value.length} 题）`, fail ? 'error' : 'success')
  } finally {
    undoing.value = false
  }
  reset()
  emit('done')
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
