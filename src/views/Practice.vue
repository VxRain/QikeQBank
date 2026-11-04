<template>
  <div class="page">
    <div v-if="error" class="error-box">{{ error }}</div>

    <!-- 设置面板 -->
    <section v-if="phase === 'setup'" class="card max-w-[640px]">
      <div class="card-head">
        <h2 class="section-title flex items-center gap-2"><i class="i-lucide-zap text-primary" />{{ mode === 'recite' ? '开始背题' : '开始刷题' }}</h2>
        <span class="badge badge-type">{{ mode === 'recite' ? '背题模式 · 直接看答案与解析' : '练习模式 · 判分后计入复习' }}</span>
      </div>

      <div class="mb-5">
        <div class="field-label">模式</div>
        <div class="flex gap-2 flex-wrap">
          <button
            type="button"
            class="seg"
            :class="mode === 'practice' && 'seg-on'"
            @click="setMode('practice')"
          ><i class="i-lucide-zap mr-1.5" />练习 · 作答判分</button>
          <button
            type="button"
            class="seg"
            :class="mode === 'recite' && 'seg-on'"
            @click="setMode('recite')"
          ><i class="i-lucide-book-open mr-1.5" />背题 · 看答案过一遍</button>
        </div>
      </div>

      <div class="mb-5">
        <div class="field-label">题库</div>
        <select v-model="bankId" class="select w-full max-w-[320px]" @change="persistBankFilter('practice', bankId)">
          <option value="">全部题库</option>
          <option v-for="b in bankStore.banks" :key="b.id" :value="b.id">{{ b.name }}</option>
        </select>
      </div>

      <div class="mb-5">
        <div class="field-label">题型（多选）</div>
        <div class="flex flex-wrap gap-2.5">
          <label
            v-for="t in ALL_TYPES"
            :key="t"
            class="inline-flex items-center gap-1.5 px-4 py-2 border border-line rounded-full bg-card text-text-secondary text-[14px] cursor-pointer transition-[background-color,border-color,color] duration-150 select-none"
            :class="selectedTypes.includes(t) && 'bg-primary-bg border-primary-border text-primary font-600'"
          >
            <input v-model="selectedTypes" type="checkbox" :value="t" class="hidden" />
            {{ TYPE_FULL_LABELS[t] }}
          </label>
        </div>
      </div>

      <div class="mb-5">
        <div class="field-label !flex items-center justify-between gap-3">
          <span>题量</span>
          <span class="text-[12px] font-400 text-muted-light">
            <template v-if="availLoading"><i class="i-lucide-loader-circle animate-spin" /> 统计可用题量…</template>
            <template v-else-if="availableCount === null">可用题量未知</template>
            <template v-else>可用 <b class="text-text">{{ availableCount }}</b> 题</template>
          </span>
        </div>
        <div class="flex gap-2 flex-wrap">
          <button
            v-for="c in COUNT_OPTIONS"
            :key="c.value"
            type="button"
            class="seg"
            :class="count === c.value && 'seg-on'"
            @click="count = c.value"
          >
            {{ c.label }}
          </button>
        </div>
        <div v-if="plan.capped" class="text-[12px] text-muted mt-2 flex items-center gap-1.5">
          <i class="i-lucide-info" />本轮最多 {{ MAX_PER_ROUND }} 题，超出请分多轮。
        </div>
      </div>

      <div v-if="noAvailable" class="mb-4 p-3 bg-bg-accent border border-line rounded-[12px] flex items-center justify-between gap-3 flex-wrap">
        <span class="text-[13px] text-text-secondary">
          <i class="i-lucide-info text-primary mr-1" />当前范围没有可练习的试题。
        </span>
        <div class="flex gap-2">
          <button type="button" class="btn" @click="router.push('/create')"><i class="i-lucide-plus" />去录题</button>
          <button type="button" class="btn" @click="router.push('/library')"><i class="i-lucide-file-up" />去导入</button>
        </div>
      </div>

      <div>
        <button
          type="button"
          class="btn btn-primary btn-big"
          :disabled="!selectedTypes.length || fetching || noAvailable"
          @click="start"
        >
          <i class="i-lucide-play" />{{ fetching ? '正在抽题…' : (mode === 'recite' ? '开始背题' : '开始刷题') }}
        </button>
        <div v-if="noAvailable" class="text-[12px] text-muted-light mt-2.5 flex items-center gap-1.5">
          <i class="i-lucide-info" />换一个题库或题型后即可开始（或先录入题目）
        </div>
        <div v-else class="text-[12px] text-muted-light mt-2.5 flex items-center gap-1.5">
          <i class="i-lucide-keyboard" />键盘：A–F 选题，Enter 提交，M 切换材料；背题模式 ←/→ 翻题
        </div>
      </div>
    </section>

    <!-- 作答卡片 -->
    <section v-else-if="phase === 'card'" ref="cardRef" tabindex="-1" class="card flex flex-col gap-3.5" @keydown="onCardKeydown">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0 flex-wrap">
          <span class="badge badge-type">{{ curBadge }}</span>
          <!-- 难度标识（FE-P1-06）：与列表页同一套点阵（样式在 App.vue 全局） -->
          <span
            v-if="curDifficulty"
            class="difficulty-dots shrink-0"
            :title="`难度 ${curDifficulty} / 5`"
            aria-label="难度"
          ><i v-for="n in 5" :key="n" :class="['dot', n <= curDifficulty && 'on']" /></span>
          <span v-if="recite" class="badge shrink-0"><i class="i-lucide-book-open" />背题模式</span>
          <span v-if="isFlagged" class="badge badge-bad shrink-0"><i class="i-lucide-flag" />已标记</span>
        </div>
        <span class="text-[13px] text-muted font-500 shrink-0 flex items-center gap-2.5">
          <!-- 单题计时（FE-P1-06）：本题用时，切走再切回不清零；判分后停表 -->
          <span v-if="itemElapsedMs > 0" class="tabular-nums flex items-center gap-1" title="本题已用时">
            <i class="i-lucide-timer text-[13px]" />{{ fmtClock(itemElapsedMs) }}
          </span>
          <span>第 {{ curIdx + 1 }} / {{ pool.length }} 题</span>
        </span>
      </div>
      <div class="progress-track"><div class="progress-inner" :style="{ width: progressPct + '%' }"></div></div>

      <!-- FE-P0-06 练习导航：上一题 / 标记 / 跳过 + 已答·剩余计数 -->
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="btn"
            :disabled="curIdx === 0"
            title="回到上一题（可回看/修改答案）"
            @click="prev"
          ><i class="i-lucide-arrow-left" />上一题</button>
          <button
            type="button"
            class="btn"
            :class="isFlagged && 'seg-danger'"
            :title="isFlagged ? '取消标记' : '标记待定，稍后再看'"
            @click="toggleFlag"
          ><i class="i-lucide-flag" />{{ isFlagged ? '取消标记' : '标记' }}</button>
          <button
            type="button"
            class="btn"
            :disabled="graded || recite"
            title="跳过本题，本轮末尾再出现"
            @click="skipCurrent"
          ><i class="i-lucide-skip-forward" />跳过</button>
        </div>
        <span class="text-[12px] text-muted">
          已答 <b class="text-text">{{ answeredCount }}</b> / 剩余 <b class="text-text">{{ remainingCount }}</b>
          <span v-if="flaggedKeys.size" class="ml-1.5 text-danger">· 标记 {{ flaggedKeys.size }}</span>
        </span>
      </div>

      <QuestionRunner
        :item="cur"
        :mode="recite ? 'recite' : 'practice'"
        :selected="singlePick"
        :picked="multiPick"
        :fill-values="fillValues"
        :short-text="shortText"
        :show-ref="showRef"
        :material-open="materialOpen"
        :locked="graded"
        @update:selected="singlePick = $event"
        @update:picked="multiPick = $event"
        @update:short-text="shortText = $event"
        @update:show-ref="showRef = $event"
        @update:material-open="materialOpen = $event"
        @fill-enter="submit"
      >
        <!-- 简答自评（仅练习模式） -->
        <template #short-actions="{ showRef: refOpen }">
          <div v-if="refOpen && !graded" class="flex items-center gap-2.5 flex-wrap">
            <span class="text-[13px] text-muted">这道题你会吗？<span class="text-muted-light">（键盘 1 不会 · 2 会）</span></span>
            <button type="button" class="btn btn-danger" @click="shortSubmit('不会')"><i class="i-lucide-x" />不会</button>
            <button type="button" class="btn btn-primary" @click="shortSubmit('会')"><i class="i-lucide-check" />会</button>
          </div>
        </template>

        <!-- 背题模式：直接展示答案 + 解析，只留上下题 -->
        <template #default="{ analysisHtml, answerHtml, refHtml }">
          <div v-if="recite" class="border-t border-line pt-4 flex flex-col gap-3">
            <div v-if="isChoiceLike" class="answer-view border border-line rounded-[8px] p-2.5 bg-bg-accent text-[14px]" v-html="answerHtml"></div>
            <div v-else-if="cur.q.type === 'fill'" class="flex flex-col gap-1.5">
              <div v-for="b in cur.q.answer?.blanks || []" :key="b.id" class="flex items-baseline gap-2 px-3 py-2 rounded-[8px] text-[13px] border border-[#bcd9c4] bg-success-bg text-text-secondary">
                <span class="font-700 text-text">{{ b.id }}</span>
                <span>正确答案：{{ (b.answers || []).join(' / ') || '—' }}</span>
              </div>
            </div>
            <div v-else-if="cur.q.type === 'short' && refHtml" class="p-3.5 bg-success-bg border border-[#bcd9c4] rounded-[8px] text-[14px] leading-[1.7] text-text-secondary">
              <b class="text-success flex items-center gap-1"><i class="i-lucide-book-open text-[14px]" />参考答案：</b>
              <div v-html="refHtml"></div>
            </div>
            <div v-if="analysisHtml" class="analysis p-3.5 bg-bg-accent border border-line rounded-[8px] text-[14px] leading-[1.7] text-text-secondary">
              <b class="text-primary flex items-center gap-1"><i class="i-lucide-lightbulb text-[14px]" />解析：</b>
              <div v-html="analysisHtml"></div>
            </div>
            <div class="flex justify-between gap-2">
              <button type="button" class="btn btn-big" :disabled="curIdx === 0" title="← 上一题" @click="prev"><i class="i-lucide-arrow-left" />上一题</button>
              <button ref="nextBtnRef" type="button" class="btn btn-primary btn-big" title="→ 下一题" @click="next"><i class="i-lucide-arrow-right" />{{ isLast ? '完成' : '下一题' }}</button>
            </div>
          </div>

          <!-- 提交（仅练习模式） -->
          <div v-if="!recite && !graded && !isShort">
            <button type="button" class="btn btn-primary btn-big" :disabled="!canSubmit" @click="submit">
              <i class="i-lucide-check-circle" />提交判分
            </button>
          </div>

          <!-- 判分结果（判分前绝不展示答案/解析） -->
          <div v-if="graded" class="border-t border-line pt-4 flex flex-col gap-3">
            <div
              class="flex items-center gap-2 text-[16px] font-700 px-3.5 py-3 rounded-[8px] relative overflow-hidden"
              :class="[gradeResult.correct ? 'text-success bg-success-bg border border-[#bcd9c4]' : 'text-danger bg-danger-bg border border-[#e3c9c5]', autoNextPending && 'cursor-pointer select-none']"
              :role="autoNextPending ? 'button' : undefined"
              :tabindex="autoNextPending ? 0 : undefined"
              :title="autoNextPending ? '点击取消自动下一题' : undefined"
              @click="autoNextPending && cancelAutoNext()"
              @keydown.enter="autoNextPending && cancelAutoNext()"
              @keydown.space.prevent="autoNextPending && cancelAutoNext()"
            >
              <i :class="gradeResult.correct ? 'i-lucide-circle-check' : 'i-lucide-circle-x'" />
              <span>{{ gradeResult.correct ? '回答正确' : '回答错误' }}</span>
              <span v-if="autoNextPending" class="text-[12px] font-500 opacity-75">· {{ (autoNextMs / 1000).toFixed(1) }}s 后自动下一题，点击取消</span>
              <span v-if="autoNextPending" class="auto-next-track" aria-hidden="true"><span class="auto-next-fill" :style="{ animationDuration: autoNextMs + 'ms' }"></span></span>
            </div>

            <div v-if="isChoice && gradeResult" class="answer-view border border-line rounded-[8px] p-2.5 bg-bg-accent text-[14px]" v-html="answerHtml"></div>

            <div v-if="cur.q.type === 'fill'" class="flex flex-col gap-1.5">
              <div v-for="r in gradeResult.results" :key="r.id" class="flex items-baseline gap-2 flex-wrap px-3 py-2 rounded-[8px] text-[13px] border border-line" :class="r.correct ? 'bg-success-bg border-[#bcd9c4] text-text-secondary' : 'bg-danger-bg border-[#e3c9c5] text-text-secondary'">
                <span class="font-700 text-text">{{ r.id }}</span>
                <span>你的答案：{{ r.value || '（未填写）' }}</span>
                <span class="font-700" :class="r.correct ? 'text-success' : 'text-danger'">{{ r.correct ? '✓' : '✗' }}</span>
                <span v-if="!r.correct" class="text-danger font-500">正确答案：{{ blankAnswersOf(cur.value?.q, r.id) }}</span>
              </div>
            </div>

            <div v-if="analysisHtml" class="analysis p-3.5 bg-bg-accent border border-line rounded-[8px] text-[14px] leading-[1.7] text-text-secondary">
              <b class="text-primary flex items-center gap-1"><i class="i-lucide-lightbulb text-[14px]" />解析：</b>
              <div v-html="analysisHtml"></div>
            </div>

            <div v-if="recordError" class="text-[12px] text-danger flex items-center gap-1"><i class="i-lucide-triangle-alert" />记录失败：{{ recordError }}</div>

            <div class="flex justify-end">
              <button ref="nextBtnRef" type="button" class="btn btn-primary btn-big" @click="next"><i class="i-lucide-arrow-right" />下一题</button>
            </div>
          </div>
        </template>
      </QuestionRunner>
    </section>

    <!-- 结束页 -->
    <section v-else-if="phase === 'done'" class="card flex flex-col gap-5 items-center text-center">
      <div class="text-[22px] font-800 tracking-[-0.01em] font-[var(--serif)] flex items-center gap-2">
        <i :class="recite ? 'i-lucide-book-open' : 'i-lucide-trophy'" class="text-primary text-[26px]" />{{ recite ? '本轮背题结束' : '本轮练习结束' }}
      </div>
      <div class="flex gap-3.5 flex-wrap justify-center">
        <div v-if="recite" class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-text">{{ lastRound.total }}</div>
          <div class="text-[12px] text-muted mt-1">已过题数</div>
        </div>
        <template v-else>
        <div class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-text">{{ lastRound.correct }} / {{ lastRound.total }}</div>
          <div class="text-[12px] text-muted mt-1">答对题数</div>
        </div>
        <div class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-text">{{ lastRound.rate }}%</div>
          <div class="text-[12px] text-muted mt-1">正确率</div>
        </div>
        </template>
        <div class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-text">{{ fmtDurationCn(lastRound.ms) }}</div>
          <div class="text-[12px] text-muted mt-1">本轮用时</div>
        </div>
        <div v-if="!recite && lastRound.wrong.length" class="min-w-[150px] p-4.5 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[24px] font-800 text-danger">{{ lastRound.wrong.length }}</div>
          <div class="text-[12px] text-muted mt-1">错题数</div>
        </div>
      </div>

      <div v-if="!recite && rounds.length > 1" class="text-[13px] text-muted">
        累计：{{ sessionStats.total }} 题 · 答对 {{ sessionStats.correct }} ·
        共 {{ fmtDurationCn(sessionStats.ms) }}
      </div>

      <div class="flex gap-3 flex-wrap justify-center">
        <button
          v-if="lastRound.wrong.length"
          type="button"
          class="btn btn-primary btn-big"
          @click="startRedo"
        >
          错题重做（{{ lastRound.wrong.length }} 题）
        </button>
        <!-- 同配置再来一轮（FE-P1-06）：保留题库/题型/题量，直接开新轮 -->
        <button type="button" class="btn btn-big" :disabled="fetching" @click="startAgain">
          <i class="i-lucide-refresh-cw" />同配置再来一轮
        </button>
        <router-link :to="doneLinksOf.review" class="btn btn-big"><i class="i-lucide-repeat" />去复习</router-link>
        <router-link :to="doneLinksOf.wrong" class="btn btn-big"><i class="i-lucide-circle-x" />去错题本</router-link>
        <router-link to="/" class="btn btn-big"><i class="i-lucide-home" />返回首页</router-link>
      </div>

      <!-- 弱项专练（FE-P1-06）：按题型正确率推荐；没有弱项就不给这个入口 -->
      <div
        v-if="weakEntry"
        class="w-full max-w-[560px] p-3.5 border border-primary-border bg-primary-bg rounded-[12px] flex items-center gap-3 flex-wrap text-left"
      >
        <i class="i-lucide-crosshair text-primary text-[18px] shrink-0" />
        <span class="text-[13px] text-text flex-1 min-w-0">
          「<b>{{ weakEntry.label }}</b>」正确率只有
          <b class="text-danger">{{ Math.round(weakEntry.rate * 100) }}%</b>
          （{{ weakEntry.count }} 次作答），建议专门练这个题型。
        </span>
        <button type="button" class="btn btn-primary btn-small shrink-0" @click="goWeakPractice">
          <i class="i-lucide-play" />弱项专练
        </button>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { practicePool, recordAnswer, stats as fetchStats, recordsOverview } from '@/api/practice.ts'
import { expandQuestions } from '@/api/assets.ts'
import QuestionRunner from '@/components/question/QuestionRunner.vue'
import { bankStore, loadBanks, resolveBankFilter, persistBankFilter, bankExists } from '@/stores/bank.ts'
import { settings } from '@/stores/settings.ts'
import { cardFromRow, toRow, toLog, answer as fsrsAnswer } from '@/utils/fsrs.ts'
import { gradeQuestion } from '@/utils/gradeQuestion.ts'
import { ui, toast } from '@/stores/ui.ts'
import { itemKeyOf, parentIdsOf, save as saveSession, scheduleSave, flush as flushSession, clear as clearSession, clampSnapshot } from '@/stores/session.ts'
import { promptResume, discardSession } from '@/composables/sessionResume.js'
import { useSessionLeaveNotice } from '@/composables/sessionLeaveNotice.js'
import { QUESTION_TYPE_KEYS, TYPE_FULL_LABELS } from '@/constants/questions.js'
import { loadRunConfig, saveRunConfig, availableCountOf, plannedCountOf, MAX_PER_ROUND } from '@/stores/runConfig.ts'
import { elapsedMsOf, fmtClock, weakPracticeEntry, doneLinks } from '@/utils/practiceLoop.ts'
import { blankAnswersOf, fmtDurationCn, dedupeShuffle, buildRunItems } from '@/utils/questionDisplay.ts'

// 题型清单/文案统一来自 constants/questions.js（FE-ARCH-01）；组卷面板用完整名（单选题）
const ALL_TYPES = QUESTION_TYPE_KEYS
const COUNT_OPTIONS = [
  { value: 5, label: '5 题' },
  { value: 10, label: '10 题' },
  { value: 20, label: '20 题' },
  { value: 0, label: '全部' }
]

const phase = ref('setup') // setup | card | done
const route = useRoute()
const router = useRouter()
const error = ref('')
const recordError = ref('')
const fetching = ref(false)

// FE-P0-05：配置记忆 + 可用题量预览
// 初值走 stores/runConfig 的归一化（脏数据不会把页面打空）
const savedCfg = loadRunConfig('practice', ALL_TYPES)
const selectedTypes = ref(savedCfg.types ? [...savedCfg.types] : [...ALL_TYPES])
const count = ref(savedCfg.count)
const bankId = ref('')
// 可用题量：按当前题库 + 选中题型汇总（review_stats 的 by_type）
const availStats = ref(null)
const availLoading = ref(false)
let availSeq = 0 // 只采信最后一次请求，避免快速切题库时旧结果覆盖新结果
const pickedTypes = computed(() => (selectedTypes.value.length === ALL_TYPES.length ? null : selectedTypes.value))
const availableCount = computed(() => availableCountOf(availStats.value, pickedTypes.value))
const plan = computed(() => plannedCountOf(count.value, availableCount.value ?? 0))
const noAvailable = computed(() => availableCount.value === 0)

async function refreshAvailable() {
  const seq = ++availSeq
  availLoading.value = true
  try {
    const s = await fetchStats(bankId.value || undefined)
    if (seq === availSeq) availStats.value = s || null
  } catch (e) {
    // 统计失败不阻断开始作答：仅把预览降级为「未知」
    if (seq === availSeq) availStats.value = null
    console.error(e)
  } finally {
    if (seq === availSeq) availLoading.value = false
  }
}

// 配置变更即记忆（含连续点击档位的瞬时值）
watch(
  [selectedTypes, count],
  () => { saveRunConfig('practice', { types: pickedTypes.value, count: count.value }, ALL_TYPES) },
  { deep: true }
)
// 题型或题库变了，可用题量跟着变
watch([pickedTypes, bankId], refreshAvailable, { deep: true })

// 模式：practice 作答判分（计入复习）；recite 背题（直接看答案/解析，不判分不记录）
const MODE_KEY = 'qbank.practiceMode'
const mode = ref(localStorage.getItem(MODE_KEY) === 'recite' ? 'recite' : 'practice')
function setMode(m) {
  mode.value = m
  try { localStorage.setItem(MODE_KEY, m) } catch { /* 忽略持久化失败 */ }
}
const recite = computed(() => mode.value === 'recite')

const pool = ref([]) // 子题队列：普通题=1 项，material=每子题 1 项
const curIdx = ref(0)
const cur = computed(() => pool.value[curIdx.value])
const graded = ref(false)
const gradeResult = ref(null)
const startedAt = ref(0)
const materialOpen = ref(true)

// 焦点锚点：切题/判分后把焦点送进作答区，Tab 不再掉回导航栏
const cardRef = ref(null)
const nextBtnRef = ref(null)
function focusCard() {
  nextTick(() => {
    if (cardRef.value && cardRef.value.focus) cardRef.value.focus({ preventScroll: true })
  })
}
function focusNextBtn() {
  nextTick(() => {
    if (nextBtnRef.value && nextBtnRef.value.focus) nextBtnRef.value.focus({ preventScroll: true })
  })
}

// 答对自动下一题（设置 autoNextOnCorrect 开启时，时长取 autoNextDelayMs）
// 计时（setTimeout）与进度条（CSS 动画）分离：条只负责展示，取消/翻页只停计时器
let autoNextTimer = null
const autoNextPending = ref(false)
const autoNextMs = ref(0)
function cancelAutoNext() {
  if (autoNextTimer) {
    clearTimeout(autoNextTimer)
    autoNextTimer = null
  }
  autoNextPending.value = false
}
onBeforeUnmount(cancelAutoNext)
const singlePick = ref('')
const multiPick = ref([])
const fillValues = reactive({})
const shortText = ref('')
const showRef = ref(false)
const selfGrade = ref('')

// 轮次统计
const rounds = ref([])
const round = ref({ total: 0, correct: 0, wrong: [], ms: 0 })

const isChoice = computed(() => cur.value && ['single', 'judge'].includes(cur.value.q.type))
const isChoiceLike = computed(() => cur.value && ['single', 'multi', 'judge'].includes(cur.value.q.type))
const isShort = computed(() => cur.value && cur.value.q.type === 'short')
const isLast = computed(() => curIdx.value === pool.value.length - 1)

const curBadge = computed(() => {
  const it = cur.value
  if (!it) return ''
  if (it.isChild) return `材料题 · 第 ${it.childIdx + 1}/${it.childCount} 问`
  return TYPE_FULL_LABELS[it.q.type] || it.q.type
})

const progressPct = computed(() => {
  const total = pool.value.length || 1
  const done = curIdx.value + (recite.value || graded.value ? 1 : 0)
  return Math.min(100, Math.round((done / total) * 100))
})

const canSubmit = computed(() => {
  const q = cur.value?.q
  if (!q) return false
  if (q.type === 'single' || q.type === 'judge') return !!singlePick.value
  if (q.type === 'multi') return multiPick.value.length > 0
  if (q.type === 'fill') return Object.keys(fillValues).some((k) => (fillValues[k] || '').trim())
  return true
})

/** 当前题难度（材料子题取子题自己的难度；越界/缺省走 schema 默认 2） */
const curDifficulty = computed(() => {
  const d = Number(cur.value?.q?.difficulty)
  return Number.isFinite(d) && d >= 1 && d <= 5 ? d : 2
})

/** 完成页「去复习 / 去错题本」：带当前题库范围（不带的话用户点过去看到的是全部题库） */
const doneLinksOf = computed(() => doneLinks(bankId.value))

/**
 * 弱项数据（records_overview.by_type）。
 *
 * 为什么不用 availStats.by_type：那是**题量**，没有「做过多少次、对了多少次」，
 * 判不出弱项。这个请求只在完成页出现时才发（见 phase 的 watch），作答过程中不打扰。
 */
const ovByType = ref([])
const weakLoading = ref(false)
async function ensureWeakData() {
  if (ovByType.value.length || weakLoading.value) return
  weakLoading.value = true
  try {
    const data = await recordsOverview()
    ovByType.value = Array.isArray(data?.by_type) ? data.by_type : []
  } catch (e) {
    // 拉不到就当「无弱项」：推荐失败不该影响完成页的其它入口
    console.error(e)
    ovByType.value = []
  } finally {
    weakLoading.value = false
  }
}

/**
 * 弱项专练推荐：无弱项返回 null，界面不显示该卡片。
 * 传 availableByType 是为了排除「历史上很弱但现在一道题都不剩」的题型——
 * 推一个点了就报「没有符合条件的试题」的入口，比不推更糟。
 */
const weakEntry = computed(() =>
  weakPracticeEntry({ by_type: ovByType.value }, {
    bankId: bankId.value,
    labelOf: (t) => TYPE_FULL_LABELS[t] || t,
    availableByType: availStats.value?.by_type || null
  })
)

/** 走弱项专练：参数进 URL，由 watch(route.query.*) 应用（同路由不重新挂载，见下方 watch） */
function goWeakPractice() {
  if (!weakEntry.value) return
  const qs = new URLSearchParams(weakEntry.value.href.split('?')[1] || '')
  router.push({ path: '/practice', query: Object.fromEntries(qs) })
}

const lastRound = computed(() => rounds.value[rounds.value.length - 1] || { total: 0, correct: 0, wrong: [], ms: 0, rate: 0 })
const sessionStats = computed(() => {
  let total = 0, correct = 0, ms = 0
  for (const r of rounds.value) { total += r.total; correct += r.correct; ms += r.ms }
  return { total, correct, ms }
})

// 卡片级键盘流（状态机互斥，同一键不在两套状态同时有效）：
// 未判分：简答看答案后 1/2 自评、Enter 提交；判分后：Enter 下一题；Esc 取消自动下一题。
// A–F 选题 / M 切材料 / 填空跳空在 QuestionRunner 内处理；输入区/组词中/弹窗/带修饰键一律不劫持。
function onCardKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if (ui.dialog) return
  if (phase.value !== 'card') return
  const t = e.target
  const inField = !!(t && t.closest && t.closest('textarea, select, input, [contenteditable], .tiptap, .ProseMirror'))
  if (e.key === 'Escape') {
    if (autoNextPending) {
      e.preventDefault()
      cancelAutoNext()
    }
    return
  }
  // 背题模式：←/→ 或 Enter 翻题，其余键不劫持
  if (recite.value) {
    if (e.key === 'Enter' || e.key === 'ArrowRight') {
      e.preventDefault()
      next()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      prev()
    }
    return
  }
  if (e.key === 'Enter') {
    if (inField) return
    if (graded.value) {
      e.preventDefault()
      next()
      return
    }
    if (t && t.closest && t.closest('button.option-btn')) {
      // 选项按钮上回车：阻止原生切换，只提交（选择用空格/字母键/鼠标）
      e.preventDefault()
      if (!canSubmit.value) return
      submit()
      return
    }
    if (!canSubmit.value) return
    e.preventDefault()
    submit()
    return
  }
  if (inField || graded.value) return
  const k = typeof e.key === 'string' ? e.key.toUpperCase() : ''
  // A–F 选题、M 切材料已由 QuestionRunner 处理；这里只保留模式语义键
  if ((k === '1' || k === '2') && isShort.value && showRef.value) {
    shortSubmit(k === '1' ? '不会' : '会')
  }
}
/**
 * 单题计时（FE-P1-06）：累计 base + 本次进入的增量。
 *
 * 刻意用「累计 + 进入时刻」而不是从进入本题起算到现在的差值：
 * 判分后停表、跳走再跳回时用户看的仍然是「这题一共花了多久」。
 * 只从进入起算的话，跳走再回来会从 0 重新计，看起来像「刚才白答了」。
 * 不足 1 秒显示 0，避免一进页面就蹦出 00:00 的噪声。
 */
const itemBaseMs = ref(0)      // 本题此前累计的停留时长
const itemEnteredAt = ref(0)   // 本次进入的时刻；0 = 不在计时
const nowTick = ref(Date.now())
let clockTimer = null
const itemElapsedMs = computed(() =>
  elapsedMsOf({ base: itemBaseMs.value, enteredAt: itemEnteredAt.value, now: nowTick.value })
)
/** 停表：把本次段累进 base（判分后 / 跳走前都要调，且幂等） */
function pauseItemClock() {
  if (!itemEnteredAt.value) return
  itemBaseMs.value += Math.max(0, Date.now() - itemEnteredAt.value)
  itemEnteredAt.value = 0
}
/** 开始计时（进入本题 / 恢复未判分的题） */
function resumeItemClock() {
  if (itemEnteredAt.value) return
  itemEnteredAt.value = Date.now()
  nowTick.value = Date.now()
  if (!clockTimer) clockTimer = setInterval(() => { nowTick.value = Date.now() }, 1000)
}
/** 换题：清零重新计 */
function resetItemClock() {
  itemBaseMs.value = 0
  itemEnteredAt.value = 0
  nowTick.value = Date.now()
}
function stopClockTimer() {
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null }
}
// 只在作答阶段走表（setup / done 没有「本题」概念）
watch(phase, (p) => {
  if (p !== 'card') { pauseItemClock(); stopClockTimer() }
  // 完成页才需要弱项数据：作答过程中不打扰（一次 records_overview 全库聚合不便宜）
  if (p === 'done') ensureWeakData()
})
onBeforeUnmount(stopClockTimer)

function resetAnswer() {
  cancelAutoNext()
  singlePick.value = ''
  multiPick.value = []
  for (const k in fillValues) delete fillValues[k]
  shortText.value = ''
  showRef.value = false
  selfGrade.value = ''
  materialOpen.value = true
  graded.value = false
  gradeResult.value = null
  recordError.value = ''
}

// ── 会话快照（FE-ARCH-05）：只存题目 id 与作答状态，离开后可继续 ──
const SNAP_MODE = 'practice'
const answers = reactive({}) // key → { selected, picked, fillValues, shortText, selfGrade, showRef, graded }

// FE-P0-06 练习导航：标记待定 / 跳过的题
// 两者都按「本轮内的 item key」记录，不存题面（与 stores/session.ts 同口径）
const flaggedKeys = ref(new Set())
const skippedKeys = ref(new Set())
const isFlagged = computed(() => !!cur.value && flaggedKeys.value.has(itemKeyOf(cur.value)))
function toggleFlag() {
  const k = itemKeyOf(cur.value)
  if (!k) return
  // Set 直接换新实例，才能触发 computed / 会话快照的变更
  const next = new Set(flaggedKeys.value)
  if (next.has(k)) next.delete(k)
  else next.add(k)
  flaggedKeys.value = next
}

// 已答 / 剩余：已答 = 本轮真有作答内容或已判分的项
// （不能用「answers 里有键」判断：切题时 rememberAnswer 会给未作答的题写空记录）
function hasAnswerContent(a) {
  if (!a) return false
  if (a.graded) return true
  if (a.selected) return true
  if (Array.isArray(a.picked) && a.picked.length) return true
  if (Object.values(a.fillValues || {}).some((v) => String(v || '').trim())) return true
  if (String(a.shortText || '').trim()) return true
  return false
}
const answeredCount = computed(() => pool.value.reduce((n, it) => (hasAnswerContent(answers[itemKeyOf(it)]) ? n + 1 : n), 0))
const remainingCount = computed(() => Math.max(0, pool.value.length - answeredCount.value))

/** 跳到指定下标（统一处理记住当前作答、重置、恢复缓存、计时） */
function jumpTo(idx) {
  if (idx < 0 || idx >= pool.value.length || idx === curIdx.value) return
  cancelAutoNext()
  rememberAnswer()
  pauseItemClock() // 先把本题停留累进 base（下面 readAnswerRefs 会把它写进缓存）
  if (recite.value) round.value.ms += Date.now() - startedAt.value
  curIdx.value = idx
  resetAnswer()
  resetItemClock() // 换题从 0 起算；这一题之前来过则由 restoreCachedAnswer 恢复累计
  restoreCachedAnswer()
  startedAt.value = Date.now()
  focusCard()
}

// 跳过：标记本题，本轮其余题走完后再回来做（不重排 pool，避免与快照 keys 失同步）
function firstPendingIndex(from, { includeSkipped = false } = {}) {
  const list = pool.value
  for (let i = Math.max(0, from); i < list.length; i++) {
    const k = itemKeyOf(list[i])
    if (!k) continue
    if (answers[k]?.graded) continue // 已判分的不算待做
    if (!includeSkipped && skippedKeys.value.has(k)) continue
    return i
  }
  return -1
}

function skipCurrent() {
  const it = cur.value
  if (!it) return
  const k = itemKeyOf(it)
  if (!k) return
  // 已判分的题不能「跳过」：已入流水，再答一遍会造成重复记录
  if (graded.value) return
  skippedKeys.value = new Set(skippedKeys.value).add(k)
  // 先找后面还没跳过的待做项；没有就回卷把所有待做项（含跳过的）重新走一遍
  let idx = firstPendingIndex(curIdx.value + 1)
  if (idx < 0) idx = firstPendingIndex(0, { includeSkipped: true })
  if (idx < 0) {
    toast('本轮题目已全部处理完毕', 'info')
    return
  }
  jumpTo(idx)
  toast('已跳过，本题会在本轮末尾再出现', 'info', 2500)
}
function currentAnswerKey() {
  return itemKeyOf(cur.value)
}
function readAnswerRefs() {
  return {
    selected: singlePick.value,
    picked: [...multiPick.value],
    fillValues: { ...fillValues },
    shortText: shortText.value,
    selfGrade: selfGrade.value,
    showRef: showRef.value,
    graded: graded.value,
    // 本题已用时长（含本次段）：切走再切回来接着算，而不是从 0 重开
    elapsedMs: itemBaseMs.value + (itemEnteredAt.value ? Math.max(0, Date.now() - itemEnteredAt.value) : 0)
  }
}
function rememberAnswer() {
  const k = currentAnswerKey()
  if (k) answers[k] = readAnswerRefs()
}
function restoreCachedAnswer() {
  const k = currentAnswerKey()
  const a = k ? answers[k] : null
  if (!a) return
  singlePick.value = a.selected || ''
  multiPick.value = Array.isArray(a.picked) ? [...a.picked] : []
  for (const key in fillValues) delete fillValues[key]
  Object.assign(fillValues, a.fillValues || {})
  shortText.value = a.shortText || ''
  selfGrade.value = a.selfGrade || ''
  showRef.value = !!a.showRef
  itemBaseMs.value = Math.max(0, Number(a.elapsedMs) || 0)
  if (a.graded) {
    graded.value = true
    gradeResult.value = gradeItem(cur.value)
    itemEnteredAt.value = 0 // 已判分的题不再走表
  } else {
    resumeItemClock()
  }
}
function snapshotNow() {
  const out = { ...answers }
  const k = currentAnswerKey()
  if (k && phase.value === 'card') out[k] = readAnswerRefs()
  return {
    mode: SNAP_MODE,
    bankId: bankId.value,
    keys: pool.value.map(itemKeyOf),
    curIdx: curIdx.value,
    answers: out,
    round: { total: round.value.total, correct: round.value.correct, wrongKeys: round.value.wrong.map(itemKeyOf), ms: round.value.ms },
    rounds: rounds.value.map((r) => ({ total: r.total, correct: r.correct, wrongKeys: (r.wrong || []).map(itemKeyOf), ms: r.ms, rate: r.rate || 0 })),
    startedAt: startedAt.value,
    extra: {
      practiceMode: mode.value,
      selectedTypes: [...selectedTypes.value],
      count: count.value,
      // FE-P0-06：标记/跳过的题按 key 存，恢复时只保留仍存在的项
      flaggedKeys: [...flaggedKeys.value],
      skippedKeys: [...skippedKeys.value]
    }
  }
}
function persistSession() {
  if (phase.value !== 'card') return
  scheduleSave(SNAP_MODE, snapshotNow())
}

// FE-P0-04：离开时只提示「进度已保住」，不拦路（进度已在 sessionStorage）
useSessionLeaveNotice(
  () => phase.value === 'card',
  '刷题进度已保存，下次进来可以继续',
  { before: () => { rememberAnswer(); flushSession(SNAP_MODE); saveSession(SNAP_MODE, snapshotNow()) } }
)
watch([curIdx, phase, singlePick, multiPick, fillValues, shortText, selfGrade, showRef, graded], persistSession, { deep: true })
onBeforeUnmount(() => {
  if (phase.value !== 'card') return
  rememberAnswer()
  flushSession(SNAP_MODE)
  saveSession(SNAP_MODE, snapshotNow()) // 防抖窗口内的最后一次输入也要留下
})
function resetSessionState() {
  for (const k of Object.keys(answers)) delete answers[k]
  flaggedKeys.value = new Set()
  skippedKeys.value = new Set()
  clearSession(SNAP_MODE)
}

// 恢复上次进度：按 id 重拉题目 → 跳过被删的题 → 对齐位置与已填作答
async function resumeSession(snap) {
  fetching.value = true
  try {
    const questions = await practicePool({ ids: parentIdsOf(snap.keys) })
    const items = buildRunItems(await expandQuestions(questions))
    const byKey = new Map(items.map((it) => [itemKeyOf(it), it]))
    const { snapshot, missing } = clampSnapshot(snap, snap.keys.filter((k) => byKey.has(k)))
    if (!snapshot) {
      discardSession(SNAP_MODE, '上次的题目已被删除，无法继续')
      return
    }
    pool.value = snapshot.keys.map((k) => byKey.get(k))
    for (const k of Object.keys(answers)) delete answers[k]
    Object.assign(answers, snapshot.answers)
    rounds.value = snapshot.rounds.map((r) => ({
      total: r.total,
      correct: r.correct,
      wrong: r.wrongKeys.map((k) => byKey.get(k)).filter(Boolean),
      ms: r.ms,
      rate: r.rate
    }))
    round.value = {
      total: snapshot.round.total || pool.value.length,
      correct: snapshot.round.correct,
      wrong: snapshot.round.wrongKeys.map((k) => byKey.get(k)).filter(Boolean),
      ms: snapshot.round.ms
    }
    curIdx.value = snapshot.curIdx
    startedAt.value = snapshot.startedAt
    if (snapshot.bankId) bankId.value = snapshot.bankId
    if (snapshot.extra?.practiceMode === 'recite') setMode('recite')
    else if (snapshot.extra?.practiceMode === 'practice') setMode('practice')
    // 标记/跳过只保留仍在本轮里的项（题目被删时不能留下悬空 key）
    const liveKeys = new Set(snapshot.keys)
    flaggedKeys.value = new Set((snapshot.extra?.flaggedKeys || []).filter((k) => liveKeys.has(k)))
    skippedKeys.value = new Set((snapshot.extra?.skippedKeys || []).filter((k) => liveKeys.has(k)))
    resetAnswer()
    resetItemClock()
    restoreCachedAnswer() // 未判分的题会在内部 resumeItemClock()
    phase.value = 'card'
    if (missing.length) toast(`有 ${missing.length} 项已被删除，已跳过`, 'info')
    focusCard()
  } catch (e) {
    console.error(e)
    discardSession(SNAP_MODE, '上次进度恢复失败，已重新开始')
  } finally {
    fetching.value = false
  }
}

async function start() {
  const types = selectedTypes.value
  if (!types.length) { error.value = '请至少选择一种题型'; return }
  if (fetching.value) return
  error.value = ''
  fetching.value = true
  try {
    let limit = count.value
    if (limit === 0) {
      // “全部”：优先用界面已拉到的可用题量（与预览数字一致，不再多发一次请求）
      limit = availableCount.value ?? 0
      if (!limit) {
        const s = await fetchStats(bankId.value || undefined).catch(() => null)
        if (s && s.by_type && Object.keys(s.by_type).length) {
          limit = types.reduce((sum, t) => sum + (Number(s.by_type[t]) || 0), 0)
        } else if (s && typeof s.total === 'number') {
          limit = s.total
        }
      }
      limit = Math.max(Math.min(limit, MAX_PER_ROUND), 1)
    }
    let questions
    if (types.length === ALL_TYPES.length) {
      questions = await practicePool({ limit, type: '', bankId: bankId.value })
    } else {
      const per = Math.ceil(limit / types.length)
      const merged = []
      for (const t of types) {
        const part = await practicePool({ limit: per, type: t, bankId: bankId.value })
        merged.push(...(part || []))
      }
      questions = dedupeShuffle(merged, (q) => q?.id)
    }
    pool.value = buildRunItems(await expandQuestions(questions))
    if (!pool.value.length) {
      fetching.value = false
      error.value = '题库中没有符合条件的试题，请先到“新增试题”添加题目。'
      return
    }
    resetSessionState()
    curIdx.value = 0
    round.value = { total: pool.value.length, correct: 0, wrong: [], ms: 0 }
    resetAnswer()
    resetItemClock()
    resumeItemClock()
    startedAt.value = Date.now()
    phase.value = 'card'
    focusCard()
  } catch (e) {
    console.error(e)
    error.value = '抽题失败：' + (e?.message || e)
  } finally {
    fetching.value = false
  }
}

function gradeItem(it) {
  const q = it.q
  // 未作答/缺答案的前置提示保持原顺序与文案（判分口径统一走 gradeQuestion）
  if (q.type === 'single' || q.type === 'judge') {
    if (!singlePick.value) return { valid: false, message: '请先选择一个选项' }
  } else if (q.type === 'multi') {
    if (!multiPick.value.length) return { valid: false, message: '请至少选择一个选项' }
  } else if (q.type === 'fill') {
    if (!(q.answer?.blanks || []).length) return { valid: false, message: '题目缺少答案（blank）' }
  } else if (q.type === 'short') {
    if (!showRef.value) return { valid: false, message: '请先查看参考答案' }
    if (!selfGrade.value) return { valid: false, message: '请自评：不会 / 会' }
  } else {
    return { valid: false, message: '暂不支持的题型：' + (q.type || '未知') }
  }
  const res = gradeQuestion(q, {
    selected: singlePick.value,
    picked: [...multiPick.value],
    fillValues: { ...fillValues },
    shortSelf: selfGrade.value,
    shortText: shortText.value
  }, { mode: 'practice' })
  const out = { valid: true, correct: !!res.correct }
  if (res.detail?.selected) out.selected = res.detail.selected
  if (res.detail?.blanks) out.results = res.detail.blanks
  if (res.detail?.self_grade) out.self = res.detail.self_grade
  return out
}

function buildDetail(it, res) {
  const detail = { type: it.q.type, correct: !!res.correct }
  if (it.isChild) {
    detail.child_id = it.q.id
    detail.child_index = it.childIdx + 1
    detail.parent_id = it.parent.id
  }
  if (res.selected) detail.selected = res.selected
  if (res.results) detail.blanks = res.results.map((r) => ({ id: r.id, value: r.value, correct: r.correct }))
  if (res.self) detail.self_grade = res.self
  // 简答作答原文（复习模式本就有 my_answer；刷题模式补上，供错题本查看）
  if (it.q.type === 'short' && shortText.value) detail.my_answer = shortText.value
  return detail
}

function commit(it, grade, elapsed, res) {
  graded.value = true
  pauseItemClock() // 判分后停表：结果已定，再涨没有意义
  gradeResult.value = res
  rememberAnswer()
  focusNextBtn()
  round.value.correct += res.correct ? 1 : 0
  round.value.ms += elapsed
  if (!res.correct) round.value.wrong.push(it)
  // FSRS：练习正确→Good / 错误→Again；“仅错题”入库时答对只写流水不建卡
  let card = null
  let fsrsLog = null
  if (!(settings.fsrs.practiceScope === 'wrong-only' && grade === 'good')) {
    try {
      const fsrsRow = it.parent ? it.parent.fsrs : it.q.fsrs
      const out = fsrsAnswer(cardFromRow(fsrsRow), grade, settings.fsrs)
      card = toRow(out.card, grade)
      fsrsLog = toLog(out.log)
    } catch (e) {
      console.error('fsrs answer failed', e)
      recordError.value = '调度计算失败：' + (e?.message || e)
    }
  }
  recordAnswer([{
    question_id: it.isChild ? it.parent.id : it.q.id,
    mode: 'practice',
    grade,
    elapsed_ms: elapsed,
    detail: buildDetail(it, res),
    card,
    fsrs_log: fsrsLog
  }]).catch((e) => {
    console.error('record_answer failed', e)
    recordError.value = (e?.message || e)
  })
  // 答对自动下一题：短暂停留展示结果（答错停留看解析；手动点下一题/点结果条会取消）
  if (res.correct && settings.autoNextOnCorrect) {
    autoNextMs.value = settings.autoNextDelayMs
    autoNextPending.value = true
    autoNextTimer = setTimeout(() => {
      autoNextPending.value = false
      autoNextTimer = null
      next()
    }, autoNextMs.value)
  }
}

function submit() {
  if (graded.value) return
  const it = cur.value
  if (!it) return
  const res = gradeItem(it)
  if (!res.valid) { error.value = res.message; return }
  error.value = ''
  commit(it, res.correct ? 'good' : 'again', Date.now() - startedAt.value, res)
}

function shortSubmit(grade) {
  if (graded.value) return
  const it = cur.value
  if (!it) return
  if (!showRef.value) { error.value = '请先查看参考答案'; return }
  selfGrade.value = grade
  const res = gradeItem(it)
  if (!res.valid) { error.value = res.message; return }
  error.value = ''
  commit(it, res.correct ? 'good' : 'again', Date.now() - startedAt.value, res)
}

function next() {
  cancelAutoNext()
  rememberAnswer()
  // 背题模式无 commit 计时：切题时把本页停留累进 round.ms（练习模式已在 commit 里记，此处不加防 double count）
  if (recite.value) round.value.ms += Date.now() - startedAt.value
  if (curIdx.value < pool.value.length - 1) {
    jumpTo(curIdx.value + 1)
  } else {
    // 到了队尾但有跳过的题：回卷把它补完（FE-P0-06 的「跳过题本轮末尾重现」）
    const pending = firstPendingIndex(0, { includeSkipped: true })
    if (!recite.value && pending >= 0 && pending !== curIdx.value) {
      jumpTo(pending)
      toast('回到本轮跳过的题目', 'info', 2500)
      return
    }
    rounds.value.push({ ...round.value, rate: round.value.total ? Math.round((round.value.correct / round.value.total) * 100) : 0 })
    phase.value = 'done'
    resetSessionState() // 本轮已收口，不再"继续上次"
  }
}

function prev() {
  if (curIdx.value > 0) {
    jumpTo(curIdx.value - 1)
  }
}

/**
 * 同配置再来一轮（FE-P1-06）：保留题库 / 题型 / 题量，重新抽一批。
 *
 * 刻意不复用 startRedo（那是「重做本轮错题」，题目集合不同），
 * 也不刷新页面：复位会话状态后直接再走一次 start()，用户视野留在练习页。
 */
async function startAgain() {
  if (fetching.value) return
  cancelAutoNext()
  stopClockTimer()
  resetSessionState()
  rounds.value = []
  round.value = { total: 0, correct: 0, wrong: [], ms: 0 }
  pool.value = []
  curIdx.value = 0
  resetAnswer()
  resetItemClock()
  phase.value = 'setup'
  error.value = ''
  await start()
}

function startRedo() {
  const last = rounds.value[rounds.value.length - 1]
  if (!last || !last.wrong.length) return
  mode.value = 'practice' // 错题重做是作答判分，强制回练习模式
  resetSessionState()
  pool.value = last.wrong
  curIdx.value = 0
  round.value = { total: pool.value.length, correct: 0, wrong: [], ms: 0 }
  resetAnswer()
  resetItemClock()
  resumeItemClock()
  startedAt.value = Date.now()
  phase.value = 'card'
  focusCard()
}

// 错题本重练：按指定 id 组卷，跳过 setup 直达作答
async function startFromIds(ids) {
  if (fetching.value) return
  mode.value = 'practice' // 错题重练是作答判分，强制回练习模式
  error.value = ''
  fetching.value = true
  try {
    const questions = await practicePool({ ids })
    pool.value = buildRunItems(await expandQuestions(questions))
    if (!pool.value.length) {
      error.value = '重练题目已不存在（可能被删除），请从错题本重新发起。'
      return
    }
    resetSessionState()
    curIdx.value = 0
    round.value = { total: pool.value.length, correct: 0, wrong: [], ms: 0 }
    resetAnswer()
    resetItemClock()
    resumeItemClock()
    startedAt.value = Date.now()
    phase.value = 'card'
    focusCard()
  } catch (e) {
    console.error(e)
    error.value = '抽题失败：' + (e?.message || e)
  } finally {
    fetching.value = false
  }
}

/** 深链题型预选：`?types=single,multi`（弱项专练、再来一轮都走它；非法值一概忽略） */
function applyDeepLinkTypes(raw) {
  const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(',') : ''
  if (!text) return
  const wanted = new Set(text.split(',').map((x) => x.trim()).filter(Boolean))
  const kept = ALL_TYPES.filter((t) => wanted.has(t))
  if (!kept.length) return
  selectedTypes.value = kept
}

/**
 * 应用深链参数（onMounted 与同路由 watch 共用同一套）。返回值表示「应当立刻开新轮」。
 *
 * `bank/title` 给了才套——避免 watch 在用户作答中被无关 query 变更打断范围。
 * @returns {Promise<boolean>} 是否已开新轮
 */
async function applyDeepLink() {
  const deepBank = route.query.bank
  // 重练/续做要沿用错题范围，不能被深链改写
  if (typeof deepBank === 'string' && bankExists(deepBank)) bankId.value = deepBank
  applyDeepLinkTypes(route.query.types)
  const again = consumeRunQuery()
  if (again) await start()
  else refreshAvailable()
  return again
}

/**
 * 消费「重复查询参数」：把 ?again/?types/?count 归一进配置再清掉。
 *
 * 为什么要清：留在 URL 上刷新页面会反复触发「直接开始新轮」，
 * 用户按一次 F5 就白答一轮。清掉后 URL 只保留题库与最终配置。
 * @returns {boolean} 是否应当立刻开新轮
 */
function consumeRunQuery() {
  const text = typeof route.query.types === 'string' ? route.query.types : ''
  const n = Number(route.query.count)
  if (Number.isInteger(n) && n > 0 && n <= MAX_PER_ROUND) count.value = n
  void text
  const again = route.query.again === '1'
  if (again || route.query.types || route.query.count) {
    router.replace({
      path: '/practice',
      query: {
        ...(bankId.value ? { bank: bankId.value } : {}),
        ...(pickedTypes.value ? { types: pickedTypes.value.join(',') } : {}),
        ...(count.value ? { count: String(count.value) } : {})
      }
    })
  }
  return again
}

onMounted(async () => {
  if (!bankStore.loaded) {
    try {
      await loadBanks()
    } catch (e) {
      console.error(e)
    }
  }
  // 深链题库（?bank=，弱项专练带上它）：不存在则回落到记忆/全部
  bankId.value = resolveBankFilter('practice', route.query.bank)
  // FE-P0-05：进入即拉一次可用题量（统计跟随当前题库，与实际抽题范围一致）
  refreshAvailable()
  // 深链入口：?types= 题型、?count= 题量、?again=1 直接开新轮。
  // 必须让位于「重练」：那条路径要沿用错题范围，不能被参数改写。
  if (route.query.retry) {
    let ids = []
    try {
      const raw = sessionStorage.getItem('qbank.retryIds')
      if (raw) ids = JSON.parse(raw)
    } catch {
      ids = []
    }
    sessionStorage.removeItem('qbank.retryIds')
    router.replace('/practice')
    if (Array.isArray(ids) && ids.filter(Boolean).length) {
      startFromIds(ids.filter(Boolean))
    } else {
      error.value = '没有收到重练题目，请从错题本重新发起。'
    }
    return
  }
  if (!route.query.retry && await applyDeepLink()) return
  const snap = await promptResume(SNAP_MODE, { title: '继续上次刷题？' })
  if (snap) await resumeSession(snap)
})

/**
 * 同路由内深链参数变化（FE-P1-06 的关键修复）。
 *
 * 完成页点「弱项专练」「再来一轮」都是 `router.push('/practice?types=…')` ——
 * 命中的是**同一条路由**，组件不会重新挂载，`onMounted` 里的深链逻辑根本不会再跑，
 * 表现就是「点了什么都没变」（e2e 实测：hash 带了 types=multi，题型还是上一轮的）。
 * 所以参数变化必须在这里重新应用。
 *
 * 只改参数、不在作答中重开一轮：用户正在答题时 URL 被无关改写，
 * 不该把他这一轮打散（`?again=1` 是显式意图，才允许重开）。
 */
watch(
  () => [route.query.bank, route.query.types, route.query.count, route.query.again],
  () => {
    if (route.query.retry) return
    applyDeepLink()
  }
)

</script>

<style scoped>
/* 自动下一题倒计时条：长在结果条底部，只负责展示，计时由 JS 定时器驱动 */
.auto-next-track {
  position: absolute; left: 0; right: 0; bottom: 0; height: 3px;
  background: rgba(47, 125, 79, 0.18);
}
.auto-next-fill {
  display: block; height: 100%; width: 100%;
  background: var(--success);
  animation: auto-next-shrink linear forwards;
}
@keyframes auto-next-shrink { from { width: 100%; } to { width: 0%; } }
</style>
