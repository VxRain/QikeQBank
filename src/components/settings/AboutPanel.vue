/**
 * 关于与维护面板：版本 / 便携模式 / 数据目录 / 清理无用图片 / 检查更新
 * 从 App.vue 迁入设置页（关于类动作也应随设置项一起演进，不再散落在根组件里）
 */
<template>
  <div class="border border-line rounded-[10px] bg-card px-3.5 py-3 flex flex-col gap-2.5">
    <div class="text-[13px] text-muted flex flex-col gap-2">
      <div>
        奇客题库 <b class="text-text">{{ version || '—' }}</b>
        <span v-if="portable !== null"> · {{ portable ? '便携版' : '安装版' }}</span>
      </div>

      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn btn-small" @click="openDataDir">
          <i class="i-lucide-folder-open" />打开数据目录
        </button>
        <button type="button" class="btn btn-small" :disabled="gcRunning" @click="runGc">
          <i class="i-lucide-trash-2" />{{ gcRunning ? '清理中…' : '清理无用图片' }}
        </button>
        <button type="button" class="btn btn-small" :disabled="update === 'checking'" @click="checkUpdate">
          <i class="i-lucide-refresh-cw" />{{ update === 'checking' ? '检查中…' : '检查更新' }}
        </button>
        <button v-if="update === 'new'" type="button" class="btn btn-small btn-primary" @click="openReleases">
          <i class="i-lucide-download" />下载 {{ latest }}
        </button>
      </div>

      <div v-if="gcResult" class="text-[12px] text-success leading-relaxed">{{ gcResult }}</div>
      <div v-if="update === 'latest'" class="text-[12px] text-success">已是最新版本</div>
      <div v-if="update === 'failed'" class="text-[12px] text-danger">检查失败（离线或网络受限），可直接前往下载页查看</div>

      <button
        type="button"
        class="self-start text-[12px] text-muted-light hover:text-primary underline underline-offset-2"
        @click="openReleases"
      >前往下载页查看所有版本</button>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { getVersion } from '@tauri-apps/api/app'
import { openUrl } from '@tauri-apps/plugin-opener'
import { openDataDir as openDataDirApi, isPortableMode } from '@/api/practice.js'
import { gcAssets, clearAssetCache, fmtBytes } from '@/api/assets.js'
import { toast } from '@/stores/ui.js'

const REPO = 'VxRain/QikeQBank'
const RELEASES_URL = `https://github.com/${REPO}/releases`

const version = ref('')
const portable = ref(null)
const update = ref('idle')
const latest = ref('')
const gcRunning = ref(false)
const gcResult = ref('')

onMounted(async () => {
  try {
    version.value = await getVersion()
  } catch {
    version.value = ''
  }
  try {
    const r = await isPortableMode()
    portable.value = r
  } catch {
    portable.value = null
  }
})

/** 语义化版本比大小（缺位补 0） */
function cmpVer(a, b) {
  const pa = String(a).split('.').map((x) => Number(x) || 0)
  const pb = String(b).split('.').map((x) => Number(x) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

async function checkUpdate() {
  update.value = 'checking'
  try {
    if (!version.value) {
      try {
        version.value = await getVersion()
      } catch {
        /* 无版本号时按"有新版本"处理 */
      }
    }
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
    if (!res.ok) throw new Error('http ' + res.status)
    const j = await res.json()
    const tag = String(j?.tag_name || '').replace(/^v/, '')
    if (!tag) throw new Error('empty tag')
    latest.value = tag
    update.value = !version.value || cmpVer(tag, version.value) > 0 ? 'new' : 'latest'
  } catch (e) {
    console.error(e)
    update.value = 'failed'
  }
}

async function openReleases() {
  try {
    await openUrl(RELEASES_URL)
  } catch (e) {
    console.error(e)
    toast('打开失败：' + (e?.message || e), 'error')
  }
}

async function runGc() {
  if (gcRunning.value) return
  gcRunning.value = true
  gcResult.value = ''
  try {
    const d = await gcAssets()
    // 响应缺键说明前后端版本不一致（dev 热更只更了前端时会出现）：宁可报错，不编数字
    if (!d || !('scanned' in d) || !('dangling' in d)) {
      toast('后端版本过旧：Rust 未重编，请重启开发版后再试', 'error')
      return
    }
    const removed = Number(d?.removed) || 0
    const dangling = Array.isArray(d?.dangling) ? d.dangling.length : 0
    const scanned = Number(d?.scanned) || 0
    const parts = []
    parts.push(
      removed > 0
        ? `清理 ${removed} 张无用图片，释放 ${fmtBytes(d?.freed_bytes)}`
        : `扫描 ${scanned} 道题：没有可清理的图片`
    )
    if (dangling > 0) parts.push(`另有 ${dangling} 处图片引用缺失（题还在，文件/登记没了），请找到对应试题重新上传`)
    gcResult.value = parts.join('；')
    clearAssetCache()
  } catch (e) {
    console.error(e)
    toast('清理失败：' + (e?.message || e), 'error')
  } finally {
    gcRunning.value = false
  }
}

async function openDataDir() {
  try {
    const d = await openDataDirApi()
    toast('已打开数据目录' + (d?.path ? `：${d.path}` : ''), 'success')
  } catch (e) {
    console.error(e)
    toast('打开失败：' + (e?.message || e), 'error')
  }
}
</script>
