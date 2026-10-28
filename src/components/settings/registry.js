/**
 * 设置注册表 —— 设置页的唯一数据源（新增设置项只改这里，不动 UI 组件）
 *
 * 结构：sections[] → items[]
 *   section: { id, title, icon, desc?, items[] }
 *   item:
 *     key        唯一标识（列表 key / 搜索命中 / 锚点）
 *     title      行标题
 *     desc       ⓘ 气泡说明（长文案一律塞这里，别撑乱行）
 *     type       switch | number | text | select | segmented | custom | note
 *     value()    读当前值（响应式；组件内每次渲染都会重新求值）
 *     set(v)     写值
 *     visible()  可选，返回 false 时本行隐藏（如「停留时长」依赖父开关）
 *     dependsOn  可选，visible() 为 false 的因由，搜索态下提示"需先开启 …"
 *     keywords   可选，搜索补充词（标题/说明/所属分类之外的同义词）
 *     indent     可选，子项缩进样式
 *     unit       可选，number 单位（秒 / 天 / 次）
 *     min/max/integer/invalidMsg   number 校验
 *     decimals   可选，number 小数位（默认整数）
 *     options    [{ value, label }]  select / segmented 选项
 *     normalize(text) → { ok, value } | { ok: false, msg }   text 校验
 *     placeholder / width           输入框占位与宽度
 *     component / props             custom 类型渲染的组件
 */
import { settings, normalizeSteps, validateSteps } from '@/stores/settings.js'
import { clearBankFilters } from '@/stores/bank.js'
import S3SyncPanel from '@/components/S3SyncPanel.vue'
import AboutPanel from '@/components/settings/AboutPanel.vue'

const RETENTION_OPTIONS = [
  { value: 0.75, label: '0.75 · 宽松' },
  { value: 0.8, label: '0.80 · 较轻' },
  { value: 0.85, label: '0.85 · 适中' },
  { value: 0.9, label: '0.90 · 标准' },
  { value: 0.95, label: '0.95 · 严格' }
]

export const SETTINGS_SECTIONS = [
  {
    id: 'general',
    title: '常规',
    icon: 'i-lucide-sliders-horizontal',
    desc: '界面行为与输入习惯',
    items: [
      {
        key: 'keepContentOnTypeChange',
        title: '切换题型时保留内容',
        desc: '启用后，切换试题类型时选项 / 答案 / 解析尽量复用而不重置（如单选切多选保留选项与答案，问答参考答案转存为解析）。',
        keywords: '题型 单选 多选 判断 选项 答案 解析 复用 重置',
        type: 'switch',
        value: () => settings.keepContentOnTypeChange,
        set: (v) => {
          settings.keepContentOnTypeChange = v
        }
      },
      {
        key: 'rememberBankFilter',
        title: '记住各页题库选择',
        desc: '开启后，刷题 / 复习 / 错题本 / 试题列表 / 新建试题的题库下拉会记住上次选择；关闭则每次默认全部题库（新建时须手动选库）。',
        keywords: '题库 下拉 筛选 过滤 记忆 归属',
        type: 'switch',
        value: () => settings.rememberBankFilter,
        set: (v) => {
          settings.rememberBankFilter = v
          // 关闭时顺手清掉各页记忆，下次全回默认全部题库
          if (!v) clearBankFilters()
        }
      }
    ]
  },
  {
    id: 'practice',
    title: '刷题',
    icon: 'i-lucide-zap',
    desc: '作答节奏与自动推进',
    items: [
      {
        key: 'autoNextOnCorrect',
        title: '答对自动下一题',
        desc: '仅刷题模式生效：答对后短暂停留展示结果再自动下一题，等待时点击结果条可取消；答错停留看解析；复习模式仍需手动自评。',
        keywords: '自动 下一题 连刷 节奏 停留',
        type: 'switch',
        value: () => settings.autoNextOnCorrect,
        set: (v) => {
          settings.autoNextOnCorrect = v
        }
      },
      {
        key: 'autoNextDelayMs',
        title: '停留时长',
        desc: '答对后在此时间内可查看判定结果，超时自动进入下一题。',
        keywords: '停留 延时 间隔 秒 等待',
        type: 'number',
        indent: true,
        unit: '秒',
        min: 0.3,
        max: 5,
        step: 0.1,
        decimals: 1,
        width: 'w-[76px]',
        invalidMsg: '停留时长请输入 0.3～5 之间的数字（秒）',
        visible: () => settings.autoNextOnCorrect,
        dependsOn: '答对自动下一题',
        value: () => settings.autoNextDelayMs / 1000,
        set: (v) => {
          settings.autoNextDelayMs = Math.round(v * 1000)
        }
      }
    ]
  },
  {
    id: 'review',
    title: '间隔复习',
    icon: 'i-lucide-repeat',
    desc: '复习算法 FSRS：按记忆状态安排下次到期时间，修改立即对新作答生效；历史作答不受影响',
    items: [
      {
        key: 'fsrs.requestRetention',
        title: '目标记忆保持率',
        desc: '到期时还记得的概率目标：设得越高复习越频繁、记得越牢，但每天要复习的题也越多；0.90 是兼顾效率与效果的常用值。',
        keywords: '保持率 记忆 难度 频率 retention',
        type: 'select',
        options: RETENTION_OPTIONS,
        value: () => settings.fsrs.requestRetention,
        set: (v) => {
          settings.fsrs.requestRetention = Number(v)
        }
      },
      {
        key: 'fsrs.learningSteps',
        title: '学习步长',
        desc: '新卡答对后当天内重复的间隔，如 1m,10m 表示 1 分钟、10 分钟后各回来一次，毕业后进入长期复习。',
        keywords: '学习 步长 分钟 新卡 毕业 steps',
        type: 'text',
        placeholder: '1m,10m',
        width: 'w-[120px]',
        normalize: (text) => {
          const r = validateSteps(text)
          return r.ok ? { ok: true, value: r.steps.join(',') } : r
        },
        value: () => settings.fsrs.learningSteps.join(','),
        set: (text) => {
          settings.fsrs.learningSteps = normalizeSteps(text, ['1m', '10m'])
        }
      },
      {
        key: 'fsrs.relearningSteps',
        title: '重学步长',
        desc: '答错后当天内重复的间隔，如 10m 表示 10 分钟后回来。',
        keywords: '重学 步长 答错 分钟 relearn',
        type: 'text',
        placeholder: '10m',
        width: 'w-[120px]',
        normalize: (text) => {
          const r = validateSteps(text)
          return r.ok ? { ok: true, value: r.steps.join(',') } : r
        },
        value: () => settings.fsrs.relearningSteps.join(','),
        set: (text) => {
          settings.fsrs.relearningSteps = normalizeSteps(text, ['10m'])
        }
      },
      {
        key: 'fsrs.maximumInterval',
        title: '最大间隔',
        desc: '单张卡两次复习之间最长隔多少天：到期再久也只隔这么久就回来，防长期不碰的卡彻底遗忘；默认 100 年即不限。',
        keywords: '最大 间隔 天 上限 interval',
        type: 'number',
        unit: '天',
        min: 30,
        max: 36500,
        integer: true,
        width: 'w-[86px]',
        invalidMsg: '最大间隔请输入 30～36500 的整数（天）',
        value: () => settings.fsrs.maximumInterval,
        set: (v) => {
          settings.fsrs.maximumInterval = Math.round(v)
        }
      },
      {
        key: 'fsrs.enableFuzz',
        title: '随机间隔抖动',
        desc: '开启后到期时间加一点随机偏移，避免同批题总在同一天到期。',
        keywords: '抖动 随机 偏移 fuzz 分散',
        type: 'switch',
        value: () => settings.fsrs.enableFuzz,
        set: (v) => {
          settings.fsrs.enableFuzz = v
        }
      },
      {
        key: 'fsrs.practiceScope',
        title: '练习入库范围',
        desc: '全部试题：练习答对也进入复习（当天短时巩固后毕业）；仅错题：答对的只记流水不进复习，只有答错的才进。',
        keywords: '练习 入库 范围 错题 全部 收录',
        type: 'segmented',
        options: [
          { value: 'all', label: '全部' },
          { value: 'wrong-only', label: '仅错题' }
        ],
        value: () => settings.fsrs.practiceScope,
        set: (v) => {
          settings.fsrs.practiceScope = v
        }
      }
    ]
  },
  {
    id: 'wrong',
    title: '错题本',
    icon: 'i-lucide-circle-x',
    desc: '错题进出规则',
    items: [
      {
        key: 'wrongLeaveAfterCorrect',
        title: '连续答对自动移出',
        desc: '错题连续答对该次数后自动移出错题本，中途答错重计；默认 1 次（答对即移出）。',
        keywords: '错题 移出 答对 次数 掌握 阈值',
        type: 'number',
        unit: '次',
        min: 1,
        max: 10,
        integer: true,
        width: 'w-[64px]',
        invalidMsg: '请输入 1～10 的整数（次）',
        value: () => settings.wrongLeaveAfterCorrect,
        set: (v) => {
          settings.wrongLeaveAfterCorrect = Math.round(v)
        }
      }
    ]
  },
  {
    id: 'sync',
    title: '云端同步',
    icon: 'i-lucide-cloud',
    desc: '同步到你自己的 S3 存储（兼容 MinIO、Cloudflare R2、Backblaze B2 等）',
    items: [
      {
        key: 'autoSync',
        title: '自动同步',
        desc: '开启后每隔一段时间在后台与云端合并一次：本机改动先上传，再把云端的新改动拉回来合并，多台设备内容保持一致。只合并改动，不会清空本地题库。',
        keywords: '自动 同步 备份 后台 定时 云端 多设备 自动上传 自动下载',
        type: 'switch',
        value: () => settings.autoSyncEnabled,
        set: (v) => {
          settings.autoSyncEnabled = v
        }
      },
      {
        key: 'autoSyncInterval',
        title: '同步间隔',
        desc: '间隔太短会放大「两台设备同时修改同一条」时后写覆盖先写的概率，建议 30 分钟以上。',
        keywords: '间隔 频率 周期 分钟 定时',
        type: 'number',
        indent: true,
        unit: '分钟',
        min: 10,
        max: 240,
        decimals: 0,
        integer: true,
        width: 'w-[76px]',
        invalidMsg: '同步间隔请输入 10～240 的整数（分钟）',
        visible: () => settings.autoSyncEnabled,
        dependsOn: '自动同步',
        value: () => settings.autoSyncIntervalMin,
        set: (v) => {
          settings.autoSyncIntervalMin = Math.round(v)
        }
      },
      {
        key: 's3',
        title: '云同步（S3）',
        type: 'custom',
        component: S3SyncPanel,
        keywords: '同步 备份 s3 云端 上传 下载 r2 minio b2 密钥'
      }
    ]
  },
  {
    id: 'about',
    title: '关于与维护',
    icon: 'i-lucide-info',
    desc: '版本信息、数据目录与本地维护',
    items: [
      {
        key: 'about',
        title: '关于',
        type: 'custom',
        component: AboutPanel,
        keywords: '版本 更新 检查 数据目录 图片 清理 维护 gc'
      }
    ]
  }
]

/** 一个设置项是否可见（未声明 visible() 即恒可见） */
export function isItemVisible(item) {
  return typeof item.visible === 'function' ? !!item.visible() : true
}

/** 搜索匹配：标题 / 说明 / 分类名 / 关键词 / 单位；空查询视为全匹配 */
export function matchItem(item, section, q) {
  if (!q) return true
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  const hay = [
    item.title,
    item.desc,
    item.keywords,
    item.unit,
    section?.title,
    section?.desc,
    ...(item.options || []).map((o) => o.label)
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return needle.split(/\s+/).every((part) => hay.includes(part))
}
