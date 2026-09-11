<template>
  <div class="option-block border rounded-[8px] p-3 mb-2.5 shadow-sm transition-[border-color,box-shadow,background-color] duration-150 hover:shadow-sm hover:border-line-strong" :class="isCorrect ? 'border-[#bcd9c4] bg-success-bg' : 'border-line bg-card'">
    <div class="flex items-center gap-2 mb-2.5">
      <span class="w-[22px] h-[22px] rounded-full bg-primary-bg text-primary font-700 text-[12px] flex items-center justify-center shrink-0">{{ displayKey }}</span>
      <label class="flex items-center gap-1.5 text-[13px] text-text-secondary cursor-pointer font-500 ml-auto">
        <input type="checkbox" :checked="isCorrect" @change="$emit('toggle')" /> 正确答案
      </label>
      <button v-if="removable" class="btn btn-small btn-danger" @click="$emit('remove')"><i class="i-lucide-trash-2" />删除</button>
    </div>
    <TiptapDocEditor :modelValue="doc" :showBlank="false" :compact="compact" @update:modelValue="onDocUpdate" />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import TiptapDocEditor from './TiptapDocEditor.vue'

const props = defineProps({
  modelValue: { type: Object, required: true },
  index: Number,
  removable: Boolean,
  displayKey: { type: String, default: 'A' },
  isCorrect: { type: Boolean, default: false },
  compact: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue','toggle','remove'])

const doc = computed(()=> props.modelValue.content)

function onDocUpdate(newDoc){
  emit('update:modelValue', { ...props.modelValue, content: newDoc })
}
</script>

