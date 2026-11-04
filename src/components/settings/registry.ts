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
 *     step       可选，number 步进
 *     options    [{ value, label }]  select / segmented 选项
 *     normalize(text) → { ok, value } | { ok: false, msg }   text 校验
 *     placeholder / width           输入框占位与宽度
 *     component / props             custom 类型渲染的组件
 *
 * ── .js → .ts（2026-11）──
 * 原文件用 JSDoc 描述结构。此前 21 条 noImplicitAny 全部来自
 * `set: (v) => …` / `normalize: (text) => …` / `matchItem(item, section, q)`
 * 这些回调的参数——没有上下文类型时一律隐式 any。
 * 迁 .ts 后把上述结构写成 `SettingItem` / `SettingSection` interface，
 * 回调参数即由上下文推断，无需逐个注解。
 *
 * `type` 用联合字面量而非 `string`：`SettingRow.vue` 里 `item.type === 'number'`
 * 这类分支因此能收窄；`props` 用 `Record<string, unknown>`（v-bind 透传给组件）。
 */
import { settings, normalizeSteps, validateSteps } from '../../stores/settings.ts'
import { clearBankFilters } from '../../stores/bank.ts'
import S3SyncPanel from '../S3SyncPanel.vue'
import AboutPanel from './AboutPanel.vue'
import type { Component } from 'vue'

/** 设置项的控件类型 */
export type SettingType = 'switch' | 'number' | 'text' | 'select' | 'segmented' | 'custom' | 'note'

/** select / segmented 的选项 */
export interface SettingOption {
  value: string | number
  label: string
}

/**
 * `normalize()` 的返回（判别联合）。
 *
 * 不写成「`ok` + 两个可选字段」的宽结构：宽结构实测会漏检
 * `{ ok: true }`（缺 `value`）与成功分支误读 `msg`。
 *
 * 消费方（`SettingRow.vue:152`）用的是 `if (!res.ok) … res.msg`——naked `!res.ok`
 * 在 `strict:false` 下**不收窄**，但该 SFC 未加 `lang="ts"`、`res` 是 `any`，
 * 所以不受影响。将来若给 SFC 开 `lang="ts"`，需把它改成 `if (res.ok === false)`
 * 或加类型谓词（实测两种写法在 `strict:false` 下都可收窄）。
 */
export type NormalizeResult = { ok: true; value: string } | { ok: false; msg: string }

/** 一个设置项 */
export interface SettingItem {
  key: string
  title: string
  desc?: string
  keywords?: string
  type: SettingType
  /** 读当前值（响应式） */
  value?: () => unknown
  /**
   * 写值。
   *
   * 参数用 `boolean | number | string` 而非具体的单种：`SettingItem` 是一个
   * 异构数组（`items: SettingItem[]`），`set` 的具体入参无法从外部收窄。
   * 而 `SettingRow.vue` 的每个调用点确实只传对应控件的值（switch 传 boolean、
   * number 传 number、select/segmented 传 `string | number`），实际调用不会被放宽影响。
   */
  set?: (v: boolean | number | string) => void
  /** 返回 false 时本行隐藏 */
  visible?: () => boolean
  /** visible() 为 false 的因由，搜索态下提示「需先开启 …」 */
  dependsOn?: string
  /** 隐藏时的自定义提示（SettingRow 的 `hiddenHint`） */
  hiddenHint?: string
  /** 子项缩进 */
  indent?: boolean
  /** number 单位（秒 / 天 / 次） */
  unit?: string
  min?: number
  max?: number
  step?: number
  integer?: boolean
  decimals?: number
  invalidMsg?: string
  options?: SettingOption[]
  /** text 校验：成功返回规整后的文本 */
  normalize?: (text: string) => NormalizeResult
  placeholder?: string
  width?: string
  /** custom 类型渲染的组件 */
  component?: Component
  /** custom 组件透传的 props */
  props?: Record<string, unknown>
}

/** 一个设置分区 */
export interface SettingSection {
  id: string
  title: string
  icon: string
  desc?: string
  items: SettingItem[]
}

const RETENTION_OPTIONS: SettingOption[] = [
  { value: 0.75, label: '0.75 · 宽松' },
  { value: 0.8, label: '0.80 · 较轻' },
  { value: 0.85, label: '0.85 · 适中' },
  { value: 0.9, label: '0.90 · 标准' },
  { value: 0.95, label: '0.95 · 严格' }
]

export const SETTINGS_SECTIONS: SettingSection[] = [
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
        set: (v: boolean) => {
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
        set: (v: boolean) => {
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
        set: (v: boolean) => {
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
        set: (v: number) => {
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
        set: (v: string | number) => {
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
        normalize: (text: string): NormalizeResult => {
          const r = validateSteps(text)
          return r.ok === true ? { ok: true, value: r.steps.join(',') } : { ok: false, msg: r.msg }
        },
        value: () => settings.fsrs.learningSteps.join(','),
        set: (text: string) => {
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
        normalize: (text: string): NormalizeResult => {
          const r = validateSteps(text)
          return r.ok === true ? { ok: true, value: r.steps.join(',') } : { ok: false, msg: r.msg }
        },
        value: () => settings.fsrs.relearningSteps.join(','),
        set: (text: string) => {
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
        set: (v: number) => {
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
        set: (v: boolean) => {
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
        set: (v: string) => {
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
        desc: '错题连续答对该次数后自动移出错题本，中途答错重计；默认 1 次（答对即移出）。填 0 表示永不自动移出（只在你手动「移除」时离开错题本）。',
        keywords: '错题 移出 答对 次数 掌握 阈值 不自动 保留',
        type: 'number',
        unit: '次',
        min: 0,
        max: 10,
        integer: true,
        width: 'w-[64px]',
        invalidMsg: '请输入 0～10 的整数（0 = 永不自动移出）',
        value: () => settings.wrongLeaveAfterCorrect,
        set: (v: number) => {
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
        desc: '开启后每隔设定时间在后台与云端合并一次：先把本机改动传上去，再把云端的新改动拉回来，多台设备内容保持一致。只合并改动，不会清空本地题库。',
        keywords: '自动 同步 备份 后台 定时 云端 多设备 自动上传 自动下载',
        type: 'switch',
        value: () => settings.autoSyncEnabled,
        set: (v: boolean) => {
          settings.autoSyncEnabled = v
        }
      },
      {
        key: 'autoSyncInterval',
        title: '同步间隔',
        desc: '每隔多少分钟自动同步一次。允许的值为 10～60 分钟。',
        keywords: '间隔 频率 周期 分钟 定时',
        type: 'number',
        indent: true,
        unit: '分钟',
        min: 10,
        max: 60,
        decimals: 0,
        integer: true,
        width: 'w-[76px]',
        invalidMsg: '同步间隔请输入 10～60 的整数（分钟）',
        visible: () => settings.autoSyncEnabled,
        dependsOn: '自动同步',
        value: () => settings.autoSyncIntervalMin,
        set: (v: number) => {
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

/**
 * 宽松的设置项形状：只保证 `isItemVisible` / `matchItem` 真正读的字段。
 *
 * 为什么需要：`SettingRow.vue` / `SettingsDialog.vue` 的 props 来自
 * `defineProps({ item: { type: Object } })`，被推断成 `Record<string, any>`；
 * 两个 SFC 未加 `lang="ts"`，写不了精确 prop 类型。把这些函数的入参
 * 收紧成 `SettingItem` 会报 TS2345（`any` 与具体 interface 无公共属性）。
 *
 * 注意不写索引签名：写了会要求源类型也带，反而卡死赋值。
 */
export interface SettingItemLike {
  title?: string
  desc?: string
  keywords?: string
  unit?: string
  visible?: () => boolean
  options?: Array<{ label?: string }>
}

/**
 * 一个设置项是否可见（未声明 visible() 即恒可见）。
 *
 * 入参用 `SettingItemLike` 而非 `SettingItem`，理由见上方注释。
 * 函数体只读 `visible` 一个字段，放宽不损失保护。
 */
export function isItemVisible(item: SettingItemLike): boolean {
  return typeof item.visible === 'function' ? !!item.visible() : true
}

/** 搜索匹配：标题 / 说明 / 分类名 / 关键词 / 单位；空查询视为全匹配 */
export function matchItem(
  item: SettingItemLike,
  section: { title?: string; desc?: string } | undefined,
  q: string
): boolean {
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
