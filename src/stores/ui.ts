/**
 * 应用内 UI 服务 — 全局弹层/通知（替代浏览器原生 alert/confirm/prompt）
 * 铁律：本仓库严禁 alert()/confirm()/prompt()，一律走本模块 + DialogHost/ToastHost
 */
import { reactive } from 'vue'

let uid = 0

export type ToastType = 'success' | 'error' | 'info'

export interface Toast {
  id: number
  type: ToastType
  text: string
}

export type DialogType = 'confirm' | 'prompt' | 'select'

/** 弹层选项 */
export interface SelectOption {
  value: string
  label: string
}

/** 弹层内部状态（由 DialogHost 渲染；resolve 决定调用方 await 的返回值类型） */
export interface DialogState {
  type: DialogType
  title: string
  message: string
  okText: string
  cancelText: string
  danger: boolean
  placeholder: string
  initial: string
  options?: SelectOption[]
  /**
   * 弹层关闭时把值交给调用方。`unknown` 而非 `any`：closeDialog 会对
   * prompt/select/confirm 分别做收窄，这里若写 any 等于放弃那层检查。
   */
  resolve: (v: unknown) => void
}

export const ui = reactive({
  toasts: [] as Toast[],
  /** 当前弹层；null = 无 */
  dialog: null as DialogState | null
})

/* ---------- Toast ---------- */

export function toast(text: string, type: ToastType = 'info', duration = 3000): number {
  const id = ++uid
  ui.toasts.push({ id, type, text })
  if (duration > 0) {
    setTimeout(() => dismissToast(id), duration)
  }
  return id
}

export function dismissToast(id: number): void {
  const i = ui.toasts.findIndex((t) => t.id === id)
  if (i >= 0) ui.toasts.splice(i, 1)
}

/* ---------- Dialog ---------- */

/** 确认框选项 */
export interface ConfirmOpts {
  title?: string
  message?: string
  okText?: string
  cancelText?: string
  danger?: boolean
}

/** 输入框选项 */
export interface PromptOpts {
  title?: string
  message?: string
  okText?: string
  cancelText?: string
  placeholder?: string
  initial?: string | number
}

/** 下拉选择选项 */
export interface SelectOpts {
  title?: string
  message?: string
  okText?: string
  cancelText?: string
  options?: SelectOption[]
}

export function confirmDialog(opts: ConfirmOpts = {}): Promise<boolean> {
  return new Promise((resolve) => {
    ui.dialog = {
      type: 'confirm',
      title: opts.title || '确认',
      message: opts.message || '',
      okText: opts.okText || '确定',
      cancelText: opts.cancelText || '取消',
      danger: Boolean(opts.danger),
      placeholder: '',
      initial: '',
      resolve
    }
  })
}

export function promptDialog(opts: PromptOpts = {}): Promise<string | null> {
  return new Promise((resolve) => {
    ui.dialog = {
      type: 'prompt',
      title: opts.title || '输入',
      message: opts.message || '',
      okText: opts.okText || '确定',
      cancelText: opts.cancelText || '取消',
      danger: false,
      placeholder: opts.placeholder || '',
      initial: opts.initial != null ? String(opts.initial) : '',
      resolve
    }
  })
}

/** 关闭当前弹层：confirm → resolve(true/false)；prompt → resolve(字符串或 null)；select → resolve(选中 value 或 null) */
export function closeDialog(value?: unknown): void {
  const d = ui.dialog
  if (!d) return
  ui.dialog = null
  if (d.type === 'prompt') {
    d.resolve(typeof value === 'string' ? value.trim() : null)
  } else if (d.type === 'select') {
    d.resolve(typeof value === 'string' && value ? value : null)
  } else {
    d.resolve(Boolean(value))
  }
}

/**
 * 下拉选择弹层：options=[{value,label}]，resolve 选中 value，取消为 null
 * 用法：const bankId = await selectDialog({ title:'移动到', options: banks.map(...) })
 */
export function selectDialog(opts: SelectOpts = {}): Promise<string | null> {
  return new Promise((resolve) => {
    ui.dialog = {
      type: 'select',
      title: opts.title || '请选择',
      message: opts.message || '',
      okText: opts.okText || '确定',
      cancelText: opts.cancelText || '取消',
      danger: false,
      placeholder: '',
      initial: '',
      options: Array.isArray(opts.options) ? opts.options : [],
      resolve
    }
  })
}
