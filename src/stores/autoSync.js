/**
 * 自动同步运行时：定时在后台与云端合并。
 *
 * 为什么只有「同步」一个动作：后端 pull_pass 进来第一件事就是 push
 * （src-tauri/src/db/s3/sync.rs「每轮拉取前先把本地改动推上去」），
 * 所以 pull 本身就是「先推本地增量，再拉云端增量合并」，天然是双向同步。
 * 「仅上传」保留给只想上行、绝不想让云端内容进本机的保守场景。
 *
 * 偏好（开关 / 间隔）是**本机行为**，只走 localStorage，不进 SYNC_KEYS：
 * 台式机可以常开、笔记本按需，不该被另一台设备改掉。
 *
 * 失败策略：后台任务不弹窗刷屏。连续失败到阈值才提示一次，平时只把
 * 错误留在状态里，供设置面板显示。
 */
import { reactive, watch } from 'vue'
import { s3ConfigGet, s3Pull } from '../api/sync.js'
import { loadBanks } from './bank.js'
import { hydrateFromDb, settings } from './settings.js'
import { toast } from './ui.js'

/** 启动后首次同步的延迟：避开首屏加载与注水高峰 */
export const STARTUP_DELAY_MS = 60_000
/** 失败重试起点（指数退避） */
const RETRY_BASE_MS = 5 * 60_000
/** 任意两次同步之间的硬性最小间隔，防误触与重复排期 */
const MIN_GAP_MS = 60_000
/** 连续失败多少次才打扰用户一次 */
const NOTIFY_AFTER_FAILURES = 3

/** applied 里的统计键不是「合并行数」，计数时要排除 */
const STAT_KEYS = new Set(['skipped', 'dropped_orphans', 'conflicts'])

export const autoSync = reactive({
  running: false,
  otherBusy: 0, // 面板上的其它云操作（仅上传/修复/测试）计数：避免两条链路同时打桶
  lastAt: 0, // 上次成功同步的时间戳（0 = 本次运行还没成功过）
  lastRows: 0, // 上次合并的改动数
  lastConflicts: 0, // 上次以云端为准覆盖本地条数
  failures: 0, // 连续失败次数（成功后清零）
  lastError: '',
  nextAt: 0 // 下次计划时间戳；0 = 未排期
})

let timer = null

function errText(e) {
  return e?.message || String(e || '未知错误')
}

/** applied 各表行数求和（排除统计键） */
export function appliedRows(res) {
  const applied = res?.applied
  if (!applied || typeof applied !== 'object') return 0
  let n = 0
  for (const [k, v] of Object.entries(applied)) {
    if (STAT_KEYS.has(k)) continue
    n += Number(v || 0)
  }
  return n
}

/** 失败后的重试延迟：指数退避，但不超过正常间隔 */
export function retryDelayMs(failures, intervalMin) {
  const interval = Math.max(1, Number(intervalMin) || 30) * 60_000
  const backoff = RETRY_BASE_MS * 2 ** Math.max(0, Math.min(4, Number(failures || 1) - 1))
  return Math.min(interval, Math.max(MIN_GAP_MS, backoff))
}

/** 考试进行中不自动同步：后台合并会改写题目与复习状态，答题体验要优先 */
function inExam() {
  return typeof location !== 'undefined' && String(location.hash || '').startsWith('#/exam')
}

/** 面板上的其它云操作（仅上传 / 修复缺图 / 连接测试）开始与结束 */
export function beginCloudTask() {
  autoSync.otherBusy += 1
}

export function endCloudTask() {
  autoSync.otherBusy = Math.max(0, autoSync.otherBusy - 1)
}

function clearTimer() {
  if (timer) clearTimeout(timer)
  timer = null
  autoSync.nextAt = 0
}

function schedule(delayMs) {
  clearTimer()
  if (!settings.autoSyncEnabled) return
  const delay = Math.max(MIN_GAP_MS, delayMs)
  autoSync.nextAt = Date.now() + delay
  timer = setTimeout(tick, delay)
}

/**
 * 执行一次同步（自动与手动共用，天然互斥）。
 * @param {{reason?: 'auto'|'manual'}} opts
 * @returns {Promise<{ok:boolean, res?:object, error?:string, skipped?:string}>}
 */
export async function runSync({ reason = 'auto' } = {}) {
  if (autoSync.running || autoSync.otherBusy > 0) return { ok: false, skipped: 'busy' }
  if (reason === 'auto' && inExam()) return { ok: false, skipped: 'exam' }
  autoSync.running = true
  try {
    // 每次现查配置：用户可能刚刚填完密钥，无需重启或手动刷新面板
    const cfg = await s3ConfigGet()
    if (!cfg?.configured) return { ok: false, skipped: 'unconfigured' }
    const res = await s3Pull()
    // PLAN §323：拉取成功后必须重新加载题库与设置，否则界面还停在旧数据
    await loadBanks()
    await hydrateFromDb()
    autoSync.lastAt = Date.now()
    autoSync.lastRows = appliedRows(res)
    autoSync.lastConflicts = Number(res?.conflicts || 0)
    autoSync.failures = 0
    autoSync.lastError = ''
    return { ok: true, res }
  } catch (e) {
    autoSync.failures += 1
    autoSync.lastError = errText(e)
    if (reason === 'auto' && autoSync.failures === NOTIFY_AFTER_FAILURES) {
      toast(`自动同步连续失败：${autoSync.lastError}`, 'error', 8000)
    }
    return { ok: false, error: autoSync.lastError }
  } finally {
    autoSync.running = false
  }
}

async function tick() {
  timer = null
  const r = await runSync({ reason: 'auto' })
  if (!settings.autoSyncEnabled) {
    autoSync.nextAt = 0
    return
  }
  const interval = settings.autoSyncIntervalMin * 60_000
  // 考试/未配置/正忙属于「跳过」而非失败：按正常节奏重排，不进入退避
  const failed = r.ok === false && !r.skipped
  schedule(failed ? retryDelayMs(autoSync.failures, settings.autoSyncIntervalMin) : interval)
}

/** 应用启动时调用一次 */
export function initAutoSync() {
  if (settings.autoSyncEnabled) schedule(STARTUP_DELAY_MS)
}

/** 手动同步成功后调用：把周期重新对齐到「现在 + 间隔」，避免紧接着又自动跑一次 */
export function resetAutoSyncClock() {
  if (settings.autoSyncEnabled) schedule(settings.autoSyncIntervalMin * 60_000)
}

// 用户在设置里改开关或间隔：立即按新配置重排（改间隔时 60 秒后先跑一次，
// 让用户马上看到效果，不必等满一个周期）
watch(
  () => [settings.autoSyncEnabled, settings.autoSyncIntervalMin],
  ([enabled, minutes]) => {
    if (!enabled) {
      clearTimer()
      return
    }
    schedule(Math.min(STARTUP_DELAY_MS, Number(minutes) * 60_000))
  }
)