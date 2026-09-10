import { reactive } from 'vue'
import { listBanks } from '../api/banks.js'

// 全局题库状态：currentBankId 持久化到 localStorage
export const bankStore = reactive({
  banks: [],
  currentBankId: localStorage.getItem('qbank.currentBankId') || '',
  loaded: false
})

// 拉取题库列表；库非空且当前选择失效时回退到第一个；写 localStorage
export async function loadBanks() {
  const banks = (await listBanks()) || []
  bankStore.banks = banks
  if (banks.length > 0 && !banks.some((b) => b.id === bankStore.currentBankId)) {
    bankStore.currentBankId = banks[0].id
  }
  localStorage.setItem('qbank.currentBankId', bankStore.currentBankId)
  bankStore.loaded = true
}

export function setCurrentBank(id) {
  bankStore.currentBankId = id
  localStorage.setItem('qbank.currentBankId', id)
}