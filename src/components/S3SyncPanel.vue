<template>
  <div class="border border-line rounded-[10px] bg-card transition-[border-color,background-color] duration-150 hover:border-line-strong">
    <button
      type="button"
      class="w-full flex items-center justify-between gap-3 p-3.5 cursor-pointer text-left bg-transparent border-0"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="min-w-0">
        <span class="flex items-center gap-1.5 text-[14px] font-600 text-text">
          <i class="i-lucide-cloud text-primary" />云同步（S3）
          <InfoTip text="把题库同步到你自己的 S3 存储（兼容 MinIO、Cloudflare R2、Backblaze B2 等）。" />
        </span>
        <span class="block text-[12px] text-muted-light mt-0.5">{{ statusText }}</span>
      </span>
      <span class="shrink-0 text-[12px]" :class="configured ? 'text-success' : 'text-muted'">
        {{ configured ? '已连接' : '未配置' }}
      </span>
    </button>

    <div v-if="open" class="px-3.5 pb-3.5 flex flex-col gap-3">
      <!-- 日常动作：同步（= 先推本地增量再拉云端增量）/ 仅上传 / 修复缺图 -->
      <div class="flex flex-col gap-2.5">
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" class="btn btn-small btn-primary" :disabled="cardBusy || !configured" @click="syncNow">
            <i :class="busy === 'sync' || autoSync.running ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-refresh-cw'" />
            {{ busy === 'sync' || autoSync.running ? '同步中…' : '立即同步' }}
          </button>
          <button
            type="button"
            class="btn btn-small"
            :disabled="cardBusy || !configured"
            title="只把本机改动传到云端，云端内容不会覆盖本机"
            @click="upload"
          >
            <i class="i-lucide-cloud-upload" />{{ busy === 'upload' ? '上传中…' : '仅上传' }}
          </button>
          <button
            type="button"
            class="btn btn-small"
            :disabled="cardBusy || !configured"
            title="只补传云端缺失的图片，不扫描题库"
            @click="repairAssets"
          >
            <i class="i-lucide-images" />{{ busy === 'repair' ? '修复中…' : '修复云端图片' }}
          </button>
        </div>
        <div class="text-[12px] text-muted leading-relaxed">
          <template v-if="settings.autoSyncEnabled">
            <i class="i-lucide-clock mr-1 text-muted-light" />
            自动同步已开启 · 每 {{ settings.autoSyncIntervalMin }} 分钟一次{{ nextText }}
            <span v-if="!configured">（配置云端存储后开始生效）</span>
          </template>
          <template v-else>自动同步未开启，可在上方打开；关闭时只能点上面的按钮手动同步。</template>
        </div>
        <div v-if="busy === 'sync'" class="text-[12px] text-muted">
          正在与云端同步，首次同步可能需要一点时间，请稍候…
        </div>
        <div v-if="lastResult" class="text-[12px] text-success leading-relaxed whitespace-pre-line">{{ lastResult }}</div>

        <!-- FE-P1-10 同步详情：上次时间（相对+绝对）/ 未同步变更 / 冲突 -->
        <div v-if="configured" class="flex flex-col gap-1.5 px-2.5 py-2 bg-bg-accent border border-line rounded-[8px] text-[12px]">
          <div class="flex items-center justify-between gap-2">
            <span class="text-muted">上次同步</span>
            <span class="text-text-secondary text-right">
              {{ statusText.replace(/^上次同步：/, '') }}
              <span v-if="lastSyncAbs" class="text-muted-light ml-1">（{{ lastSyncAbs }}）</span>
            </span>
          </div>
          <div class="flex items-center justify-between gap-2">
            <span class="text-muted">未同步变更</span>
            <button
              v-if="pendingRows.length"
              type="button"
              class="text-primary bg-transparent border-0 p-0 cursor-pointer text-[12px] flex items-center gap-1"
              :aria-expanded="pendingOpen"
              @click="pendingOpen = !pendingOpen"
            >{{ pendingText }}<i :class="pendingOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" /></button>
            <span v-else class="text-text-secondary">{{ pendingText }}</span>
          </div>
          <div v-if="pendingOpen && pendingRows.length" class="flex flex-wrap gap-x-3 gap-y-1 pl-1 text-muted">
            <span v-for="r in pendingRows" :key="r.key">{{ r.label }} {{ r.count }}</span>
          </div>
          <div class="flex items-center justify-between gap-2">
            <span class="text-muted">冲突</span>
            <button
              v-if="conflictCount > 0"
              type="button"
              class="text-danger bg-transparent border-0 p-0 cursor-pointer text-[12px] flex items-center gap-1"
              :aria-expanded="conflictOpen"
              @click="conflictOpen = !conflictOpen"
            >{{ conflictCount }} 项<i :class="conflictOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" /></button>
            <span v-else class="text-text-secondary">无</span>
          </div>
          <div v-if="conflictOpen && conflictCount > 0" class="text-muted leading-[1.6] pl-1">
            上次同步时有 {{ conflictCount }} 项本地改动被云端版本覆盖（同一条记录两端都改过时以较新的为准）。
            逐条对比与取舍待后续版本提供；如需保留本地版本，请先「仅上传」再做其它设备操作。
          </div>
        </div>
      </div>

      <!-- 配置：一次性设置，平时折叠 -->
      <div class="border-t border-line pt-2.5">
        <button
          type="button"
          class="w-full flex items-center gap-1.5 text-[12.5px] text-muted bg-transparent border-0 p-0 cursor-pointer text-left"
          :aria-expanded="showConfig"
          @click="showConfig = !showConfig"
        >
          <i :class="showConfig ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />
          云端存储设置
        </button>

        <div v-if="showConfig" class="flex flex-col gap-2.5 mt-2.5">
          <div class="grid grid-cols-2 gap-2.5">
            <label class="flex flex-col gap-1 col-span-2">
              <span class="text-[12px] text-muted">Endpoint</span>
              <input
                v-model="form.endpoint"
                class="input px-2.5 py-1.5 text-[13px]"
                type="text"
                autocomplete="off"
                spellcheck="false"
                placeholder="https://s3.us-east-1.amazonaws.com"
              />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[12px] text-muted">Region</span>
              <input v-model="form.region" class="input px-2.5 py-1.5 text-[13px]" type="text" autocomplete="off" spellcheck="false" placeholder="us-east-1" />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[12px] text-muted">Bucket</span>
              <input v-model="form.bucket" class="input px-2.5 py-1.5 text-[13px]" type="text" autocomplete="off" spellcheck="false" placeholder="my-qbank" />
            </label>
            <label class="flex flex-col gap-1 col-span-2">
              <span class="text-[12px] text-muted">前缀（可选，多份题库可共用同一个桶）</span>
              <input v-model="form.prefix" class="input px-2.5 py-1.5 text-[13px]" type="text" autocomplete="off" spellcheck="false" placeholder="qbank" />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[12px] text-muted">Access Key</span>
              <input v-model="form.access_key" class="input px-2.5 py-1.5 text-[13px]" type="text" autocomplete="off" spellcheck="false" placeholder="AKIA..." />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-[12px] text-muted">Secret Key</span>
              <input
                v-model="form.secret_key"
                class="input px-2.5 py-1.5 text-[13px]"
                type="password"
                autocomplete="new-password"
                :placeholder="hasSecret ? '已保存，留空不修改' : '必填'"
              />
            </label>
          </div>

          <button type="button" role="switch" :aria-checked="form.path_style" class="w-full flex items-center justify-between gap-3 cursor-pointer text-left bg-transparent border-0 p-0" @click="form.path_style = !form.path_style">
            <span class="inline-flex items-center gap-1 text-[13px] text-muted">
              路径风格（path-style）
              <InfoTip text="MinIO、带端口的自建端点、Cloudflare R2 等需要开启；AWS 官方端点两种都支持。" />
            </span>
            <ToggleSwitch :model-value="form.path_style" />
          </button>

          <button type="button" class="btn btn-small self-start" :disabled="!!busy" @click="saveAndTest">
            <i class="i-lucide-plug-zap" />{{ busy === 'save' ? '测试中…' : '保存并测试' }}
          </button>
        </div>
      </div>

      <div class="text-[11.5px] text-muted-light leading-relaxed">
        密钥只保存在本机，不会上传。云端为明文数据，请使用私有桶。
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { s3ConfigGet, s3ConfigSet, s3Test, s3Push, s3Status, s3Pending, s3RepairAssets } from '@/api/sync.js'
import { settings } from '@/stores/settings.js'
import { autoSync, beginCloudTask, endCloudTask, resetAutoSyncClock, runSync } from '@/stores/autoSync.js'
import { toast } from '@/stores/ui.js'
import InfoTip from '@/components/ui/InfoTip.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'

const open = ref(false)
const showConfig = ref(false)
const busy = ref('')
const configured = ref(false)
const hasSecret = ref(false)
const status = ref(null)
// FE-P1-10：未同步变更数（known=false 表示从未推送过）
const pending = ref(null)
const lastResult = ref('')
// 相对时间要随时间前进刷新（面板打开时每 30 秒一次）
const now = ref(Date.now())
let tickTimer = null

const cardBusy = computed(() => autoSync.running || busy.value !== '')

const form = reactive({
  endpoint: '',
  region: 'us-east-1',
  bucket: '',
  prefix: '',
  path_style: true,
  access_key: '',
  secret_key: '',
})

function errText(e) {
  return e?.message || String(e || '未知错误')
}

/** 后端把"云端数据不完整"等情况放在 warnings 里：只展示面向用户的动作提示。 */
function showWarnings(res, duration = 9000) {
  const list = Array.isArray(res?.warnings) ? res.warnings : []
  const msgs = []
  for (const w of list) {
    if (w?.message) {
      msgs.push(w.message)
      toast(w.message, 'info', duration)
    }
  }
  return msgs.join('\n')
}

/** 把后端 asset_errors 的 reason 翻译成用户能照做的提示。 */
function assetErrorText(errors) {
  const map = {
    'not-in-bucket': '云端缺少原图',
    'sha-mismatch': '图片校验失败',
    'file-missing': '本地缺少图片文件',
    'not-registered': '本地缺少图片登记',
    'bad-mime': '图片格式不支持',
  }
  return [...new Set(errors.map((e) => map[e?.reason] || e?.reason || '未知原因'))].join('、')
}

/** 相对时间：让用户看到"上次同步是什么时候"，而不是批次号/游标。 */
function relTime(iso) {
  if (!iso) return '从未'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '从未'
  return relMs(Date.now() - t)
}

function relMs(delta) {
  const sec = Math.max(0, Math.round(delta / 1000))
  if (sec < 45) return '刚刚'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.round(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.round(hour / 24)} 天前`
}

/** 距下次自动同步还有多久（用 now 参与计算，面板开着时每 30 秒自动前进） */
const nextText = computed(() => {
  const at = autoSync.nextAt
  if (!at) return ''
  const left = at - now.value
  if (left <= 0) return '（即将开始）'
  const min = Math.ceil(left / 60_000)
  return ` · 约 ${min} 分钟后自动同步`
})

// 排期一变就把 now 拉回当下，否则「约 N 分钟」会因旧时钟多算一分钟
watch(
  () => autoSync.nextAt,
  () => {
    now.value = Date.now()
  }
)

const statusText = computed(() => {
  if (!configured.value) return '尚未配置云端存储'
  // 自动同步刚跑过：以运行时时间为准，比 DB 里的时间戳更及时
  if (autoSync.lastAt) {
    const rows = autoSync.lastRows
    return `上次同步：${relMs(Date.now() - autoSync.lastAt)}` + (rows > 0 ? ` · 合并 ${rows} 项` : '')
  }
  const up = status.value?.last_push_at
  const down = status.value?.last_pull_at
  const last = [up, down].filter(Boolean).sort().pop()
  if (!last) return '还没有同步过'
  return `上次同步：${relTime(last)}`
})

/** 上次同步的绝对时间（相对时间之外再给一个可核对的绝对值） */
const lastSyncAbs = computed(() => {
  const up = status.value?.last_push_at
  const down = status.value?.last_pull_at
  const last = [up, down].filter(Boolean).sort().pop()
  if (!last) return ''
  const d = new Date(last)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
})

/** 未同步变更的展示文案 */
const pendingText = computed(() => {
  if (!pending.value) return '未同步变更：—'
  if (!pending.value.known) return '未同步变更：未知（还没推送过）'
  const n = Number(pending.value.total) || 0
  return n > 0 ? `未同步变更：${n} 项` : '未同步变更：无'
})

/** 未同步变更的分项（展开看是哪些表） */
const pendingRows = computed(() => {
  const by = pending.value?.by_table
  if (!by) return []
  const NAMES = { banks: '题库', questions: '试题', records: '作答记录', review_state: '复习状态', settings: '设置' }
  return Object.entries(by)
    .filter(([, n]) => Number(n) > 0)
    .map(([k, n]) => ({ key: k, label: NAMES[k] || k, count: Number(n) }))
})

/** 冲突：上次同步里「以云端为准覆盖本地」的条数（autoSync 运行时最及时） */
const conflictCount = computed(() => Number(autoSync.lastConflicts) || 0)
const conflictOpen = ref(false)
const pendingOpen = ref(false)

function applyConfig(cfg) {
  if (!cfg) return
  configured.value = Boolean(cfg.configured)
  hasSecret.value = Boolean(cfg.has_secret)
  if (cfg.endpoint != null) form.endpoint = cfg.endpoint
  if (cfg.region != null) form.region = cfg.region
  if (cfg.bucket != null) form.bucket = cfg.bucket
  if (cfg.prefix != null) form.prefix = cfg.prefix
  if (cfg.path_style != null) form.path_style = cfg.path_style
  if (cfg.access_key != null) form.access_key = cfg.access_key
  form.secret_key = ''
  // 未配置时直接把设置摊开，省得用户还要多点一次
  if (!cfg.configured) showConfig.value = true
}

async function refresh() {
  try {
    applyConfig(await s3ConfigGet())
    status.value = await s3Status()
  await refreshPending()
    await refreshPending()
    await refreshPending()
  } catch {
    /* 未配置或后端不可用时静默，面板仍可填写 */
  }
}

/** 未同步变更数：失败不影响面板其它部分（它只是辅助信息） */
async function refreshPending() {
  try {
    pending.value = await s3Pending()
  } catch {
    pending.value = null
  }
}

async function persistConfig() {
  const payload = { ...form }
  // 留空 = 沿用已保存的密钥
  if (!payload.secret_key) delete payload.secret_key
  const res = await s3ConfigSet(payload)
  applyConfig(res)
  status.value = await s3Status()
  await refreshPending()
}

async function saveAndTest() {
  busy.value = 'save'
  beginCloudTask()
  try {
    await persistConfig()
    const res = await s3Test()
    lastResult.value = `连接正常（${res.endpoint}）`
    toast('连接测试通过', 'success')
  } catch (e) {
    lastResult.value = ''
    toast(errText(e), 'error', 8000)
  } finally {
    busy.value = ''
    endCloudTask()
  }
}

async function upload() {
  busy.value = 'upload'
  beginCloudTask()
  try {
    const res = await s3Push()
    status.value = await s3Status()
  await refreshPending()
    await refreshPending()
    showWarnings(res)
    if (res.skipped) {
      const n = Number(res.assets_uploaded || 0)
      lastResult.value = n ? `已补传 ${n} 张图片` : '没有需要上传的改动'
      toast(n ? '图片上传完成' : '云端已是最新', n ? 'success' : 'info')
      const errs = Array.isArray(res.asset_errors) ? res.asset_errors : []
      if (errs.length) {
        const reasons = assetErrorText(errs)
        const terminal = errs.some((e) => ['file-missing', 'not-registered', 'bad-mime'].includes(e.reason))
        lastResult.value += `\n有 ${errs.length} 张图片未能上传（${reasons}）`
        lastResult.value += terminal
          ? '。本机缺少图片文件，换一台有原图的设备点「修复云端图片」'
          : '，下次上传会自动重试'
        console.warn('[s3] asset_errors', errs)
      }
    } else {
      const kb = (Number(res.bytes || 0) / 1024).toFixed(1)
      lastResult.value = `已上传 ${res.rows} 项改动 · ${kb} KB` + (res.assets_uploaded ? ` · 图片 ${res.assets_uploaded} 张` : '')
      toast('上传完成', 'success')
      const errs = Array.isArray(res.asset_errors) ? res.asset_errors : []
      if (errs.length) {
        const reasons = assetErrorText(errs)
        const terminal = errs.some((e) => ['file-missing', 'not-registered', 'bad-mime'].includes(e.reason))
        lastResult.value += `\n有 ${errs.length} 张图片未能上传（${reasons}）`
        lastResult.value += terminal
          ? '。本机缺少图片文件，换一台有原图的设备点「修复云端图片」'
          : '，下次上传会自动重试'
        console.warn('[s3] asset_errors', errs)
      }
    }
  } catch (e) {
    toast(errText(e), 'error', 8000)
  } finally {
    busy.value = ''
    endCloudTask()
  }
}

async function repairAssets() {
  busy.value = 'repair'
  beginCloudTask()
  try {
    const res = await s3RepairAssets()
    status.value = await s3Status()
  await refreshPending()
    await refreshPending()
    const reg = Number(res.registered || 0)
    const missing = Number(res.missing || 0)
    const uploaded = Number(res.uploaded || 0)
    const bucket = Number(res.bucket_assets || 0)
    if (reg === 0) {
      lastResult.value = '本机没有图片登记，无法补传；请到创建过图片的设备上执行'
    } else {
      lastResult.value = `云端已有 ${bucket} 张 · 本地登记 ${reg} 张 · 补传前缺失 ${missing} 张 · 本次补传 ${uploaded} 张`
    }
    const errs = Array.isArray(res.asset_errors) ? res.asset_errors : []
    if (errs.length) {
      lastResult.value += `\n有 ${errs.length} 张未能补传（${assetErrorText(errs)}）`
      console.warn('[s3] repair asset_errors', errs)
      toast(uploaded ? `已补传 ${uploaded} 张，${errs.length} 张失败` : `${errs.length} 张图片未能补传`, 'error', 8000)
    } else if (uploaded) {
      toast(`已补传 ${uploaded} 张图片`, 'success')
    } else {
      toast('没有需要补传的登记图片', 'info')
    }
  } catch (e) {
    toast(errText(e), 'error', 8000)
  } finally {
    busy.value = ''
    endCloudTask()
  }
}

/** 同步 = 先推本地增量、再拉云端增量合并（后端 pull 内部就是这个顺序） */
async function syncNow() {
  busy.value = 'sync'
  lastResult.value = ''
  try {
    const r = await runSync({ reason: 'manual' })
    if (r.skipped === 'busy') {
      toast('正在同步中，请稍候', 'info')
      return
    }
    if (r.skipped === 'unconfigured') {
      toast('尚未配置云端存储', 'error')
      return
    }
    if (!r.ok) {
      toast(r.error, 'error', 10000)
      return
    }
    const res = r.res || {}
    // 手动同步后重置周期，避免刚点完又被自动同步跑一次
    resetAutoSyncClock()
    await refresh()
    const rows = autoSync.lastRows
    const warn = showWarnings(res, 15000)
    const parts = [rows > 0 ? `已合并 ${rows} 项改动` : '云端没有新的改动']
    if (res.assets_pulled) parts.push(`图片 ${res.assets_pulled} 张`)
    if (autoSync.lastConflicts > 0) parts.push(`其中 ${autoSync.lastConflicts} 条以云端为准`)
    lastResult.value = parts.join(' · ') + (warn ? `\n${warn}` : '')
    toast(rows > 0 ? '同步完成' : '已是最新', rows > 0 ? 'success' : 'info')
    const errs = Array.isArray(res.asset_errors) ? res.asset_errors : []
    if (errs.length) {
      const reasons = assetErrorText(errs)
      const notInBucket = errs.some((e) => e.reason === 'not-in-bucket')
      const corrupted = errs.some((e) => e.reason === 'sha-mismatch')
      lastResult.value += `\n有 ${errs.length} 张图片未能下载（${reasons}）`
      if (notInBucket) {
        lastResult.value += '。请在有原图的设备上点「修复云端图片」，再回来同步'
      } else if (corrupted) {
        lastResult.value += '。云端图片内容校验失败，请在有原图的设备上重新插入该图片后再上传'
      } else {
        lastResult.value += '，下次同步会自动重试'
      }
      console.warn('[s3] asset_errors', errs)
    }
  } catch (e) {
    toast(errText(e), 'error', 10000)
  } finally {
    busy.value = ''
  }
}

onMounted(() => {
  refresh()
  // 相对时间（上次同步 / 下次同步）需要随开着的面板前进
  tickTimer = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})

onUnmounted(() => clearInterval(tickTimer))
</script>
