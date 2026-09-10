/**
 * 应用内 UI 服务 — 全局弹层/通知（替代浏览器原生 alert/confirm/prompt）
 * 铁律：本仓库严禁 alert()/confirm()/prompt()，一律走本模块 + DialogHost/ToastHost
 */
import { reactive } from 'vue'

let uid = 0

export const ui = reactive({
  toasts: [],
  dialog: null // { type: 'confirm'|'prompt', title, message, okText, cancelText, danger, placeholder, initial, resolve }
})

/* ---------- Toast ---------- */

export function toast(text, type = 'info', duration = 3000) {
  const id = ++uid
  ui.toasts.push({ id, type, text })
  if (duration > 0) {
    setTimeout(() => dismissToast(id), duration)
  }
  return id
}

export function dismissToast(id) {
  const i = ui.toasts.findIndex((t) => t.id === id)
  if (i >= 0) ui.toasts.splice(i, 1)
}

/* ---------- Dialog ---------- */

export function confirmDialog(opts = {}) {
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

export function promptDialog(opts = {}) {
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

/** 关闭当前弹层：confirm → resolve(true/false)；prompt → resolve(字符串或 null) */
export function closeDialog(value) {
  const d = ui.dialog
  if (!d) return
  ui.dialog = null
  if (d.type === 'prompt') {
    d.resolve(typeof value === 'string' ? value.trim() : null)
  } else {
    d.resolve(Boolean(value))
  }
}
