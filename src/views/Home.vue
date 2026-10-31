/**
 * 仪表盘（/）
 * 统计区：即使 stats 接口失败也始终渲染占位（数字 0/— + 内联错误 + 重试），绝不吞掉整页。
 * 题库区：当前题库速览 + 入口；管理在 /banks 专页。
 */
<template>
  <div class="page">
    <div class="flex items-center justify-between gap-3">
      <h1 class="page-title flex items-center gap-2">
        <i class="i-lucide-layout-dashboard text-primary text-[24px]" />仪表盘
        <span v-if="isPortable" class="badge" title="数据存放在程序目录 data/ 下，随身携带">便携版</span>
        <span v-if="streak >= 2" class="badge" :title="`最近 ${streak} 天每天都有刷题`">
          <i class="i-lucide-flame text-[14px] text-danger" />连续学习 {{ streak }} 天
        </span>
      </h1>
      <button type="button" class="btn btn-small" @click="load">
        <i class="i-lucide-refresh-cw text-[14px]" />刷新
      </button>
    </div>

    <div v-if="error" class="error-box">
      <span class="flex items-center gap-2 min-w-0">
        <i class="i-lucide-triangle-alert shrink-0" />{{ error }}
      </span>
      <button type="button" class="btn btn-small shrink-0" @click="load">重试</button>
    </div>

    <!-- FE-P1-01 新用户三步引导：只在题库真为空时出现，有题即隐藏 -->
    <section v-if="guide.show" class="card flex flex-col gap-3.5">
      <div class="card-head !mb-0">
        <h2 class="section-title flex items-center gap-2">
          <i class="i-lucide-sparkles text-primary" />三步开始
        </h2>
        <span class="badge">首次使用</span>
      </div>
      <div class="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        <div
          v-for="(s, i) in guide.steps"
          :key="s.key"
          class="relative flex flex-col gap-1.5 p-3 border border-line rounded-[12px] bg-bg-accent"
          :class="s.done && 'border-success-border bg-success-bg'"
        >
          <div class="flex items-center gap-2">
            <span
              class="w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-[12px] font-700"
              :class="s.done ? 'bg-success text-white' : 'bg-card border border-line text-muted'"
            >
              <i v-if="s.done" class="i-lucide-check text-[14px]" />
              <template v-else>{{ i + 1 }}</template>
            </span>
            <span class="text-[14px] font-600 text-text">{{ s.title }}</span>
          </div>
          <div class="text-[12px] text-muted leading-[1.6]">{{ s.desc }}</div>
          <button type="button" class="btn btn-small mt-auto self-start" @click="go(s.href)">
            去这一步<i class="i-lucide-arrow-right text-[13px]" />
          </button>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2 pt-1 border-t border-line">
        <span class="text-[12px] text-muted flex items-center gap-1.5">
          <i class="i-lucide-file-down text-primary" />已有现成题目？下载模板批量导入
        </span>
        <span class="flex gap-2 ml-auto">
          <button type="button" class="btn btn-small" @click="openTemplate()"><i class="i-lucide-file-text" />打开模板文件夹</button>
          <button type="button" class="btn btn-small" @click="go('/library', { import: '1' })"><i class="i-lucide-file-up" />导入试题</button>
        </span>
      </div>
    </section>

    <!-- FE-P1-01 今日任务卡 -->
    <section v-else class="card flex flex-col gap-3.5">
      <div class="card-head !mb-0">
        <h2 class="section-title flex items-center gap-2">
          <i class="i-lucide-target text-primary" />今日任务
        </h2>
        <span class="text-[12px] text-muted-light">{{ todayLabel }}</span>
      </div>

      <div class="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3.5">
        <!-- 到期复习 -->
        <div class="flex flex-col gap-1 p-3 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[12px] text-muted">待复习到期</div>
          <div class="text-[26px] font-800 leading-none font-[var(--serif)]" :class="dueCount > 0 ? 'text-primary' : 'text-text'">
            {{ stats ? dueCount : '—' }}
          </div>
          <div class="text-[12px] text-muted-light">今日到期 {{ stats?.due_today ?? '—' }} · 学习中 {{ stats?.learning_due ?? '—' }}</div>
        </div>

        <!-- 今日进度 -->
        <div class="flex flex-col gap-1 p-3 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[12px] text-muted flex items-center gap-1.5">
            今日已刷 <b class="text-text">{{ progress.done }}</b> / {{ progress.goal }}
            <button type="button" class="i-btn !p-0.5" title="修改每日目标" @click="editGoal">
              <i class="i-lucide-pencil text-[12px]" />
            </button>
          </div>
          <div class="progress-track mt-1"><div class="progress-inner" :style="{ width: progress.pct + '%' }"></div></div>
          <div class="text-[12px]" :class="progress.reached ? 'text-success font-600' : 'text-muted-light'">
            {{ progress.reached ? '今日目标已完成' : `还差 ${progress.remain} 题达标` }}
          </div>
        </div>

        <!-- 最弱题型 -->
        <div class="flex flex-col gap-1 p-3 border border-line rounded-[12px] bg-bg-accent">
          <div class="text-[12px] text-muted">最弱题型</div>
          <template v-if="weak">
            <div class="text-[17px] font-700 text-text flex items-center gap-1.5">
              <span class="badge badge-type">{{ weak.label }}</span>
            </div>
            <div class="text-[12px] text-danger font-700">
              正确率 {{ Math.round(weak.rate * 100) }}% · {{ weak.count }} 次作答
            </div>
          </template>
          <template v-else>
            <div class="text-[17px] font-700 text-muted">暂无弱项</div>
            <div class="text-[12px] text-muted-light">多刷几题后按题型正确率给出</div>
          </template>
        </div>
      </div>

      <!-- 两个一键入口：首页 → 开始作答只要 1 次点击 -->
      <div class="flex flex-wrap gap-2.5">
        <button
          type="button"
          class="btn btn-primary"
          :disabled="dueCount === 0"
          @click="go(entryHref('/review', { bank: currentBank }), { bank: currentBank })"
        >
          <i class="i-lucide-repeat" />开始今日复习<template v-if="dueCount > 0">（{{ dueCount }}）</template>
        </button>
        <button type="button" class="btn" :disabled="!weak" @click="go(entryHref('/practice', { bank: currentBank, types: weak ? [weak.type] : null }))">
          <i class="i-lucide-crosshair" />弱项专练<template v-if="weak">（{{ weak.label }}）</template>
        </button>
        <button type="button" class="btn" @click="go(entryHref('/practice', { bank: currentBank }))">
          <i class="i-lucide-zap" />直接刷题
        </button>
      </div>
      <div v-if="dueCount === 0 && stats" class="text-[12px] text-muted-light flex items-center gap-1.5">
        <i class="i-lucide-info" />当前没有到期复习卡，先刷几题或去复习页手动抽题。
      </div>
    </section>

    <!-- FE-P1-01 数据安全状态：只有同步时间可用，不拿「备份」冒充已实现 -->
    <div class="card flex flex-wrap items-center gap-2.5" :class="fresh.overdue && '!border-danger-border'">
      <i
        class="text-[18px]"
        :class="fresh.overdue ? 'i-lucide-hard-drive-upload text-danger' : 'i-lucide-cloud text-muted-light'"
      />
      <span class="text-[13px] text-text-secondary">
        上次同步：<b class="text-text">{{ fresh.text }}</b>
        <span class="text-muted-light">（本地无时间点快照，建议开启 S3 同步防意外）</span>
      </span>
      <span class="flex gap-2 ml-auto">
        <button type="button" class="btn btn-small" @click="openSettings"><i class="i-lucide-settings" />同步设置</button>
      </span>
    </div>
    <div v-if="fresh.overdue" class="card !border-danger-border flex flex-wrap items-center gap-2.5">
      <i class="i-lucide-triangle-alert text-danger text-[18px]" />
      <span class="text-[13px] text-text">已经有 {{ fresh.days }} 天没有成功同步了，去检查一下同步配置或手动上传一次。</span>
      <button type="button" class="btn btn-small ml-auto" @click="openSettings"><i class="i-lucide-refresh-cw" />去处理</button>
    </div>

    <div class="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3.5">
      <div class="card card-interactive cursor-pointer flex flex-col gap-1" role="link" tabindex="0" title="进入试题列表" @click="go('/library')" @keyup.enter="go('/library')">
        <div class="flex items-start justify-between gap-2">
          <div class="text-[30px] font-800 tracking-[-0.02em] leading-none font-[var(--serif)] text-text">{{ stats?.total ?? '—' }}</div>
          <i class="i-lucide-library text-[16px] text-muted-light" />
        </div>
        <div class="text-[13px] font-500 text-muted">题库总题数</div>
      </div>
      <div class="card card-interactive cursor-pointer flex flex-col gap-1" role="link" tabindex="0" title="进入间隔复习" @click="go('/review')" @keyup.enter="go('/review')">
        <div class="flex items-start justify-between gap-2">
          <div class="text-[30px] font-800 tracking-[-0.02em] leading-none font-[var(--serif)] text-primary">{{ stats?.due_total ?? '—' }}</div>
          <i class="i-lucide-clock text-[16px] text-muted-light" />
        </div>
        <div class="text-[13px] font-500 text-muted">待复习总数</div>
        <div class="text-[12px] text-muted-light">今日到期 {{ stats?.due_today ?? '—' }}</div>
      </div>
      <div class="card card-interactive cursor-pointer flex flex-col gap-1" role="link" tabindex="0" title="进入刷题" @click="go('/practice')" @keyup.enter="go('/practice')">
        <div class="flex items-start justify-between gap-2">
          <div class="text-[30px] font-800 tracking-[-0.02em] leading-none font-[var(--serif)] text-text">{{ stats?.practiced_total ?? '—' }}</div>
          <i class="i-lucide-zap text-[16px] text-muted-light" />
        </div>
        <div class="text-[13px] font-500 text-muted">累计刷题</div>
        <div class="text-[12px] text-muted-light">今日 {{ stats?.practiced_today ?? '—' }}</div>
      </div>
      <div class="card flex flex-col gap-1">
        <div class="flex items-start justify-between gap-2">
          <div class="text-[30px] font-800 tracking-[-0.02em] leading-none font-[var(--serif)] text-text">{{ stats ? rateText : '—' }}</div>
          <i class="i-lucide-trophy text-[16px] text-muted-light" />
        </div>
        <div class="text-[13px] font-500 text-muted">总正确率</div>
        <div class="text-[12px] text-muted-light">练习 + 复习</div>
      </div>
    </div>

    <div v-if="(stats?.due_total ?? 0) > 0" class="card flex flex-wrap items-center gap-3 !border-primary-border !bg-primary-bg">
      <i class="i-lucide-repeat text-primary text-[20px]" />
      <span class="text-[14px] text-text font-500">有 <b class="text-primary text-[17px]">{{ stats.due_total }}</b> 题待复习，别让遗忘曲线得逞</span>
      <span class="flex gap-2 ml-auto">
        <button type="button" class="btn btn-primary" @click="go('/review')"><i class="i-lucide-play" />开始复习</button>
        <button type="button" class="btn" @click="go('/practice')"><i class="i-lucide-zap" />去刷题</button>
      </span>
    </div>

    <div class="card">
      <div class="card-head">
        <h2 class="section-title flex items-center gap-2">
          <i class="i-lucide-sigma text-primary" />题型分布
        </h2>
      </div>
      <div class="flex flex-wrap gap-2">
        <span v-for="t in QUESTION_TYPES" :key="t.key" class="badge badge-type">
          {{ t.label }} {{ stats?.by_type?.[t.key] ?? 0 }}
        </span>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2 class="section-title flex items-center gap-2">
          <i class="i-lucide-bar-chart-3 text-primary" />近 7 天练习趋势
        </h2>
        <button type="button" class="btn btn-small" @click="openOverview">
          <i class="i-lucide-table" />查看详情
        </button>
      </div>
      <div v-if="bars.length" class="flex items-end gap-2.5 pt-1.5">
        <div
          v-for="b in bars"
          :key="b.date"
          class="flex-1 flex flex-col items-center justify-end gap-1 min-w-0"
          :title="`${b.date} 刷题 ${b.count}，正确 ${b.correct}`"
        >
          <div class="w-full max-w-[46px] h-[120px] flex items-end bg-bg-accent border border-line rounded-[8px] p-[3px] shadow-sm">
            <div class="relative w-full bg-primary-bg rounded-[6px] min-h-[2px] overflow-hidden" :style="{ height: b.pct + '%' }">
              <div class="absolute left-0 right-0 bottom-0 bg-primary rounded-[6px]" :style="{ height: b.correctPct + '%' }"></div>
            </div>
          </div>
          <div class="text-[12px] font-700 text-text-secondary">{{ b.count }}</div>
          <div class="text-[11px] text-muted-light whitespace-nowrap">{{ b.dateLabel }}</div>
        </div>
      </div>
      <div v-else class="text-muted py-2 flex items-center gap-2">
        <i class="i-lucide-bar-chart-3" />近 7 天暂无练习记录
      </div>
    </div>

    <!-- 全部练习统计弹窗 -->
    <Teleport to="body">
      <Transition name="dg">
        <div v-if="showOverview" class="dg-mask fixed inset-0 z-[1000] flex items-center justify-center bg-[rgba(15,23,42,0.45)] backdrop-blur-[3px]" @click.self="showOverview = false">
          <div
            ref="ovCardEl"
            class="dg-card w-[min(640px,calc(100vw-48px))] max-h-[calc(100vh-96px)] flex flex-col bg-card border border-line rounded-lg shadow-[0_20px_40px_rgba(2,6,23,0.25),0_4px_12px_rgba(2,6,23,0.12)] px-6 pt-5 pb-4"
            role="dialog"
            aria-modal="true"
            aria-label="全部练习统计"
            tabindex="-1"
          >
            <h3 class="m-0 mb-3.5 text-[17px] font-700 tracking-[-0.01em] text-text font-[var(--serif)] flex items-center gap-2">
              <i class="i-lucide-table text-primary" />全部练习统计
            </h3>
            <div v-if="ovLoading" class="text-muted py-4 flex items-center gap-2">
              <i class="i-lucide-loader-circle animate-spin" />加载中…
            </div>
            <div v-else-if="ovError" class="error-box mb-3">{{ ovError }}</div>
            <div v-else class="overflow-y-auto flex flex-col gap-4 min-h-0 pr-0.5">
              <div v-if="!ovDays.length && !ovTypes.length" class="text-muted py-2">暂无练习记录</div>
              <div v-if="ovTypes.length">
                <div class="field-label">按题型</div>
                <table class="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th class="text-left px-2.5 py-2 border-b border-line text-[12px] text-muted font-600 bg-bg-accent">题型</th>
                      <th class="text-right px-2.5 py-2 border-b border-line text-[12px] text-muted font-600 bg-bg-accent">数量</th>
                      <th class="text-right px-2.5 py-2 border-b border-line text-[12px] text-muted font-600 bg-bg-accent">正确率</th>
                      <th class="text-right px-2.5 py-2 border-b border-line text-[12px] text-muted font-600 bg-bg-accent">平均用时</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="t in ovTypes" :key="t.type" class="hover:bg-card-hover">
                      <td class="px-2.5 py-2 border-b border-line"><span class="badge badge-type">{{ typeLabel(t.type) }}</span></td>
                      <td class="px-2.5 py-2 border-b border-line text-right">{{ t.count }}</td>
                      <td class="px-2.5 py-2 border-b border-line text-right" :class="t.count && (t.correct / t.count) < 0.6 ? 'text-danger font-700' : 'text-success font-600'">{{ t.count ? Math.round((t.correct / t.count) * 100) + '%' : '—' }}</td>
                      <td class="px-2.5 py-2 border-b border-line text-right text-muted">{{ fmtSec(t.avg_ms) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-if="ovDays.length">
                <div class="field-label">按天（近 {{ ovDays.length }} 天有记录）</div>
                <table class="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th class="text-left px-2.5 py-2 border-b border-line text-[12px] text-muted font-600 bg-bg-accent">日期</th>
                      <th class="text-right px-2.5 py-2 border-b border-line text-[12px] text-muted font-600 bg-bg-accent">数量</th>
                      <th class="text-right px-2.5 py-2 border-b border-line text-[12px] text-muted font-600 bg-bg-accent">答对</th>
                      <th class="text-right px-2.5 py-2 border-b border-line text-[12px] text-muted font-600 bg-bg-accent">平均用时</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="d in ovDays" :key="d.date" class="hover:bg-card-hover">
                      <td class="px-2.5 py-2 border-b border-line font-500">{{ d.date }}</td>
                      <td class="px-2.5 py-2 border-b border-line text-right">{{ d.count }}</td>
                      <td class="px-2.5 py-2 border-b border-line text-right text-success font-600">{{ d.correct }}</td>
                      <td class="px-2.5 py-2 border-b border-line text-right text-muted">{{ fmtSec(d.avg_ms) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div class="flex justify-end gap-2.5 mt-4">
              <button type="button" class="btn btn-primary" @click="showOverview = false">关闭</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { stats as fetchStats, recordsOverview, isPortableMode, openTemplatesDir } from '@/api/practice.js'
import { s3Status } from '@/api/sync.js'
import { bankStore, loadBanks } from '@/stores/bank.js'
import { settings, normalizeDailyGoal } from '@/stores/settings.js'
import { toast } from '@/stores/ui.js'
import { QUESTION_TYPES, typeLabel } from '@/constants/questions.js'
import { dailyProgress, weakestType, syncFreshness, newUserSteps, entryHref } from '@/utils/dailyTask.js'
import { useDialogA11y } from '@/composables/useDialogA11y.js'

const router = useRouter()
/**
 * 页内跳转。
 * @param {string} path 目标路径（可带 query）
 * @param {{bank?:string, import?:string}} [query] 额外查询参数（合并到已有 query 上）
 */
function go(path, query) {
  const [base, qs] = String(path).split('?')
  const merged = { ...Object.fromEntries(new URLSearchParams(qs || '')) }
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) if (v) merged[k] = v
  }
  router.push({ path: base, query: Object.keys(merged).length ? merged : undefined })
}

const stats = ref(null)
const error = ref('')
const isPortable = ref(false)
const streak = ref(0)
const showOverview = ref(false)
const ovLoading = ref(false)
const ovError = ref('')
const ovDays = ref([])
const ovTypes = ref([])
// 同步状态：只用来回答「上次同步是什么时候」（FE-P1-01 数据安全状态）
const lastSyncAt = ref('')

const todayLabel = computed(() =>
  new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
)
// 首页入口统一不带题库筛选（首页是全局视角）；先保留 currentBank 占位，FE-P1-02 题库页才是按库入口
const currentBank = ref('')
const dueCount = computed(() => Number(stats.value?.due_total) || 0)
const progress = computed(() => dailyProgress(stats.value, settings.dailyGoal))
const weak = computed(() => weakestType(ovTypes.value, (t) => typeLabel(t, { full: true })))
const guide = computed(() => newUserSteps(stats.value, bankStore.banks.length))
const fresh = computed(() => syncFreshness(lastSyncAt.value))

/** 修改每日目标：走应用内 prompt（禁止原生 prompt） */
async function editGoal() {
  const { promptDialog } = await import('@/stores/ui.js')
  const v = await promptDialog({
    title: '每日刷题目标',
    message: `当前目标 ${settings.dailyGoal} 道/天；只影响首页进度展示，不限制实际刷题量。`,
    placeholder: '1–500 的整数',
    initial: String(settings.dailyGoal)
  })
  if (v == null) return
  const n = Number(v)
  if (!Number.isFinite(n) || n < 1 || n > 500) {
    toast('请输入 1–500 之间的整数', 'error')
    return
  }
  settings.dailyGoal = normalizeDailyGoal(n)
  toast(`每日目标已设为 ${settings.dailyGoal} 道`, 'success')
}

/** 打开模板文件夹：与导入弹层同一个后端命令，模板目录随包内嵌 */
async function openTemplate() {
  try {
    await openTemplatesDir()
    toast('已打开模板文件夹，可下载或直接复制', 'success')
  } catch (e) {
    toast('打开模板文件夹失败：' + (e?.message || e), 'error')
  }
}

/** 同步设置就在设置弹层的「同步」分组：首页只负责把用户送到那里 */
function openSettings() {
  // 设置弹层由 App.vue 持有，这里用全局键位同款的 Esc 无关入口：直接派发自定义事件太重，
  // 改为导航到题库页顶部无法触达设置 → 因此改用 window 事件，App.vue 负责监听。
  window.dispatchEvent(new CustomEvent('qbank:open-settings', { detail: { sectionId: 'sync' } }))
}

function fmtSec(ms) {
  const s = Number(ms) / 1000
  if (!Number.isFinite(s) || s <= 0) return '—'
  return (s < 10 ? s.toFixed(1) : Math.round(s)) + 's'
}
async function openOverview() {
  showOverview.value = true
  await ensureOverview()
}

// FE-P1-11：统计弹窗也是 dialog（Esc / Tab 圈 / 焦点归位）
const ovCardEl = ref(null)
useDialogA11y({
  isOpen: computed(() => showOverview.value),
  containerRef: ovCardEl,
  onClose: () => { showOverview.value = false }
})

// 概览只拉一次：详情按钮与 streak 共用
async function ensureOverview() {
  if (ovDays.value.length || ovTypes.value.length || ovLoading.value) return
  ovLoading.value = true
  ovError.value = ''
  try {
    const data = await recordsOverview()
    ovDays.value = Array.isArray(data?.days) ? data.days : []
    ovTypes.value = Array.isArray(data?.by_type) ? data.by_type : []
    streak.value = calcStreak(ovDays.value)
  } catch (e) {
    console.error(e)
    ovError.value = '加载失败：' + (e?.message || e)
  } finally {
    ovLoading.value = false
  }
}

// 连续学习天数：有刷题记录的连续本地日期串；今天还没学则从昨天起算
// （后端按 UTC 日期聚合，跨零点附近可能差 1 天，v1 接受该误差）
function calcStreak(days) {
  const active = new Set((days || []).filter((d) => Number(d.count) > 0).map((d) => d.date))
  if (!active.size) return 0
  const fmt = (dt) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
  const cur = new Date()
  if (!active.has(fmt(cur))) cur.setDate(cur.getDate() - 1)
  let n = 0
  while (active.has(fmt(cur))) {
    n++
    cur.setDate(cur.getDate() - 1)
  }
  return n
}

const rateText = computed(() => {
  const r = stats.value?.correct_rate
  return r == null ? '—' : `${r}%`
})

const bars = computed(() => {
  const list = Array.isArray(stats.value?.records_7d) ? stats.value.records_7d : []
  const rows = list.map((d) => ({
    date: d.date || '',
    count: Number(d.count) || 0,
    correct: Number(d.correct) || 0
  }))
  const max = Math.max(1, ...rows.map((r) => r.count))
  return rows.map((r) => ({
    date: r.date,
    count: r.count,
    correct: r.correct,
    pct: Math.max(2, Math.round((r.count / max) * 100)),
    correctPct: r.count > 0 ? Math.round((r.correct / r.count) * 100) : 0,
    dateLabel: String(r.date || '').slice(5).replace('-', '/') || '-'
  }))
})

async function load() {
  error.value = ''
  // 便携标记静默探测：失败就当非便携，不污染错误区
  try {
    const r = await isPortableMode()
    isPortable.value = !!r
  } catch { /* ignore */ }
  // 题库数（新用户引导第一步是否完成）
  try {
    await loadBanks()
  } catch { /* 拿到 0 个题库也不算错：引导会显示第一步未完成 */ }
  // 同步时间：没配 S3 时 sync_s3_status 会失败，按「尚未同步过」处理
  try {
    const st = await s3Status()
    const a = String(st?.last_push_at || '')
    const b = String(st?.last_pull_at || '')
    lastSyncAt.value = a > b ? a : b
  } catch {
    lastSyncAt.value = ''
  }
  try {
    stats.value = await fetchStats()
  } catch (e) {
    console.error(e)
    stats.value = null
    error.value = '加载统计失败：' + (e?.message || e)
  }
  // streak / 最弱题型都来自 records_overview：失败当「无记录」，不影响其他卡片
  try {
    await ensureOverview()
  } catch { /* ignore */ }
}

onMounted(() => {
  load()
})
</script>

