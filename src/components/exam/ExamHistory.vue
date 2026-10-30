<template>
  <!-- 历史场次回看（FE-P0-07b）：只吃 exam_detail 的数据，不依赖内存中的 sheet -->
  <Teleport to="body">
    <Transition name="hr">
      <div v-if="open" class="hr-mask fixed inset-0 z-[1050] flex bg-[rgba(15,23,42,0.45)] backdrop-blur-[3px]" @click.self="$emit('close')">
        <aside class="hr-panel ml-auto w-full max-w-[620px] h-full bg-card border-l border-line shadow-lg flex flex-col">
          <div class="flex items-center justify-between gap-3 px-5 py-4 border-b border-line">
            <div class="min-w-0">
              <h3 class="m-0 text-[16px] font-700 text-text flex items-center gap-2">
                <i class="i-lucide-history text-primary" />历史回看
              </h3>
              <div v-if="detail" class="text-[12px] text-muted mt-0.5">
                {{ shortDate(detail.items?.[0]?.answered_at) }} · {{ detail.item_count }} 条作答 ·
                得分 {{ fmtScore(detail.score) }} / {{ fmtScore(detail.full_score) }}
                （{{ rateText }}）
              </div>
            </div>
            <button type="button" class="i-btn w-8 h-8" aria-label="关闭" @click="$emit('close')">
              <i class="i-lucide-x" />
            </button>
          </div>

          <div class="flex-1 overflow-auto px-5 py-4 flex flex-col gap-3">
            <div v-if="loading" class="text-muted flex items-center gap-2 py-6 justify-center">
              <i class="i-lucide-loader-circle animate-spin" />加载逐题明细…
            </div>
            <div v-else-if="error" class="error-box">{{ error }}</div>
            <template v-else-if="rows.length">
              <div
                v-for="r in rows"
                :key="r.key"
                class="border border-line rounded-[10px] bg-card overflow-hidden"
              >
                <button
                  type="button"
                  class="w-full flex items-center justify-between gap-3 px-3.5 py-2.5 text-left cursor-pointer bg-transparent border-0 hover:bg-bg-accent transition-colors"
                  @click="toggle(r.key)"
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="sc-index">{{ r.index }}</span>
                    <span class="text-[13px] font-500 text-text truncate">
                      {{ r.missing ? '题目已删除' : (TYPE_FULL_LABELS[r.type] || r.type) }}
                    </span>
                    <span v-if="r.childIndex" class="badge shrink-0">第 {{ r.childIndex }} 问</span>
                    <span v-if="r.unanswered" class="badge shrink-0">未作答</span>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <span class="text-[13px] font-700" :class="r.correct ? 'text-success' : 'text-danger'">
                      {{ fmtScore(r.earned) }} / {{ fmtScore(r.full) }}
                    </span>
                    <i :class="isOpen(r.key) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="text-muted text-[14px]" />
                  </div>
                </button>

                <div v-if="isOpen(r.key)" class="px-3.5 pb-3.5 flex flex-col gap-2.5 border-t border-line pt-3">
                  <div v-if="!r.missing" class="stem text-[13px] leading-[1.7] text-text" v-html="r.stemHtml"></div>
                  <div v-else class="text-[12px] text-muted-light">这道题已被删除，仅保留作答记录。</div>

                  <!-- 选择题作答 -->
                  <div v-if="r.selected.length" class="text-[12px] text-text-secondary">
                    你的作答：
                    <span class="font-600 text-text">{{ selectedTextOf(r) }}</span>
                    <span v-if="!r.correct && r.answerText" class="ml-2 text-success">正确答案：{{ r.answerText }}</span>
                  </div>

                  <!-- 填空逐空结果 -->
                  <div v-if="r.blanks.length" class="flex flex-col gap-1">
                    <div
                      v-for="b in r.blanks"
                      :key="b.id"
                      class="text-[12px] px-2.5 py-1.5 rounded-[6px] border"
                      :class="b.correct ? 'bg-success-bg border-[#bcd9c4]' : 'bg-danger-bg border-[#e3c9c5]'"
                    >
                      <span class="font-700">{{ b.id }}</span>
                      <span class="ml-1.5">{{ b.value || '（未填写）' }}</span>
                      <span class="ml-1 font-700" :class="b.correct ? 'text-success' : 'text-danger'">{{ b.correct ? '✓' : '✗' }}</span>
                      <span v-if="!b.correct && b.answers?.length" class="ml-1.5 text-danger">正确答案：{{ b.answers.join(' / ') }}</span>
                    </div>
                  </div>

                  <!-- 简答作答 -->
                  <div v-if="r.type === 'short'" class="text-[12px] text-text-secondary">
                    我的答案：<span class="text-text">{{ r.myAnswer || '（未填写）' }}</span>
                    <span v-if="r.selfGrade" class="ml-2 badge">{{ r.selfGrade === '会' ? '自评：会' : '自评：不会' }}</span>
                  </div>

                  <!-- 简答参考答案：answer.reference 是简答的「正确答案」，
                       与当场成绩单 refOf()、Wrong.vue 一致；缺了它回看只剩自己的答案 -->
                  <div
                    v-if="r.refHtml"
                    class="p-2.5 bg-success-bg border border-[#bcd9c4] rounded-[6px] text-[12px] leading-[1.7] text-text-secondary"
                  >
                    <b class="text-success">参考答案：</b>
                    <span v-html="r.refHtml"></span>
                  </div>

                  <!-- 正确答案摘要：选择题在作答行内展示，填空逐空自带，简答走参考答案块，这里只兜剩下无人认领的情况 -->
                  <div v-if="r.answerText && !r.selected.length && !r.blanks.length && r.type !== 'short'" class="text-[12px] text-success">
                    正确答案：{{ r.answerText }}
                  </div>

                  <div v-if="r.analysisHtml" class="analysis p-2.5 bg-bg-accent border border-line rounded-[6px] text-[12px] leading-[1.7] text-text-secondary">
                    <b class="text-primary">解析：</b>
                    <span v-html="r.analysisHtml"></span>
                  </div>
                </div>
              </div>
            </template>
            <div v-else class="text-[13px] text-muted text-center py-6">这场模考没有可回看的记录</div>
          </div>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
/**
 * 历史场次回看（FE-P0-07b）
 *
 * 关键约束：**不依赖内存中的 sheet**。用户可能重启应用后才来回看，
 * 所以一切数据都来自 exam_detail(exam_id)；父级只负责传 examId 与开关。
 */
import { ref, watch } from 'vue'
import { examDetail } from '@/api/exam.js'
import { buildReviewRows } from '@/utils/examTrend.js'
import { renderDoc } from '@/utils/render.js'
import { TYPE_FULL_LABELS } from '@/constants/questions.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  examId: { type: String, default: '' }
})
defineEmits(['close'])

const loading = ref(false)
const error = ref('')
const detail = ref(null)
const rows = ref([])
const openKeys = ref(new Set())

function isOpen(k) {
  return openKeys.value.has(k)
}
function toggle(k) {
  const next = new Set(openKeys.value)
  if (next.has(k)) next.delete(k)
  else next.add(k)
  openKeys.value = next
}

function fmtScore(v) {
  const n = Number(v) || 0
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}
function shortDate(iso) {
  return iso ? String(iso).slice(0, 10) : ''
}

const rateText = ref('')
function rateOfDetail(d) {
  const full = Number(d?.full_score) || 0
  if (!full) return '—'
  return `${Math.round((Number(d.score) / full) * 1000) / 10}%`
}

/** 作答的选项 id → 字母（o1 → A），与成绩单的选项编号一致 */
function selectedTextOf(r) {
  const opts = (r.options || []).map((o, i) => ({ id: o.id, letter: String.fromCharCode(65 + i) }))
  return r.selected.map((id) => opts.find((o) => o.id === id)?.letter || id).join('、')
}

/** 选择题正确答案的人读文本：把 answer.ids 映射回选项字母 */
function answerTextOf(q) {
  if (!q) return ''
  const ids = q.answer?.ids
  if (Array.isArray(ids) && ids.length) {
    const opts = (q.options || []).map((o, i) => ({ id: o.id, letter: String.fromCharCode(65 + i) }))
    return ids.map((id) => opts.find((o) => o.id === id)?.letter || id).join('、')
  }
  if (Array.isArray(q.answer?.blanks)) {
    return q.answer.blanks
      .map((b) => `${b.id}: ${(b.answers || []).join(' / ')}`)
      .join('；')
  }
  return ''
}

async function load() {
  if (!props.examId) return
  loading.value = true
  error.value = ''
  detail.value = null
  rows.value = []
  openKeys.value = new Set()
  try {
    const d = await examDetail(props.examId)
    detail.value = d
    rateText.value = rateOfDetail(d)
    // 填空题的「正确答案」要合到逐空行里；这里把题目答案注入 detail.blanks
    const enriched = (d.items || []).map((it) => {
      // 材料题的流水挂在母题 id 上，真正的题面/选项/答案在子题里：
      // detail.child_id 指向子题，parent_id 指向母题（见 utils/grading.js buildExamDetail）。
      // 不在这里切到子题，回看就只会显示母题题面 + 盒内选项 id。
      const detail = it.detail || {}
      let q = it.question
      if (detail.child_id && q?.children) {
        const child = q.children.find((c) => c && c.id === detail.child_id)
        if (child) {
          q = {
            ...child,
            // 保留母题标记，模板可据此提示「材料题第 N 问」
            _parentStem: q.stem,
            _parentType: q.type,
            _childIndex: detail.child_index ?? null
          }
        }
      }
      const blanks = detail.blanks
      if (Array.isArray(blanks) && q?.answer?.blanks) {
        const map = new Map(q.answer.blanks.map((b) => [b.id, b.answers || []]))
        it.detail = { ...detail, blanks: blanks.map((b) => ({ ...b, answers: map.get(b.id) || [] })) }
      }
      return { ...it, question: q }
    })
    const built = buildReviewRows(enriched, renderDoc)
    // 选择题正确答案摘要（附在行上，避免模板里再算一遍）
    built.forEach((r, i) => {
      const q = enriched[i]?.question
      r.answerText = answerTextOf(q)
      // 简答的正确答案存在 answer.reference（富文本），不是 ids/blanks
      r.refHtml = q?.type === 'short' && q.answer?.reference ? renderDoc(q.answer.reference) : ''
      // 选项表给「作答 id → 字母」映射用
      r.options = q?.options || []
      // 材料子题标记（标题上显示「第 N 问」）
      r.childIndex = q?._childIndex ?? null
    })
    rows.value = built
  } catch (e) {
    console.error('exam_detail failed', e)
    error.value = '加载失败：' + (e?.message || e)
  } finally {
    loading.value = false
  }
}

watch(
  [() => props.open, () => props.examId],
  ([open, id]) => {
    if (open && id) load()
  },
  { immediate: true }
)
</script>

<style scoped>
.hr-enter-active, .hr-leave-active { transition: opacity .18s ease; }
.hr-enter-active .hr-panel, .hr-leave-active .hr-panel { transition: transform .22s ease; }
.hr-enter-from, .hr-leave-to { opacity: 0; }
.hr-enter-from .hr-panel, .hr-leave-to .hr-panel { transform: translateX(24px); }
.sc-index {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 6px; flex-shrink: 0;
  font-size: 11px; font-weight: 700;
  background: var(--bg-accent); color: var(--muted); border: 1px solid var(--line);
}
</style>
