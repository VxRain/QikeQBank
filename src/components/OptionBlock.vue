<template>
  <div class="option-block" :class="{correct: isCorrect}">
    <div class="head">
      <span class="key">{{ displayKey }}.</span>
      <label class="check"><input type="checkbox" :checked="isCorrect" @change="$emit('toggle')" /> 正确答案</label>
      <button v-if="removable" class="btn small danger" @click="$emit('remove')">删除</button>
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

<style scoped>
.option-block{ background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px; margin-bottom:10px; box-shadow:var(--shadow-sm); transition:all .15s }
.option-block:hover{ border-color:var(--line-strong); box-shadow:var(--shadow) }
.option-block.correct{ border-color:#86efac; background:var(--success-bg); box-shadow:var(--shadow-sm) }
.head{ display:flex; align-items:center; gap:8px; margin-bottom:10px }
.key{ font-weight:700; color:var(--primary); min-width:22px; width:22px; height:22px; display:flex; align-items:center; justify-content:center; background:var(--primary-bg); border-radius:50%; font-size:12px }
.check{ display:flex; gap:6px; align-items:center; font-size:13px; color:var(--text-secondary); cursor:pointer; font-weight:500 }
.btn{ background:var(--card); border:1px solid var(--line); color:var(--muted); padding:6px 10px; border-radius:8px; cursor:pointer; font-size:12px; font-weight:500; box-shadow:var(--shadow-sm) }
.btn:hover{ background:var(--bg-accent); border-color:var(--line-strong) }
.btn.danger{ border-color:#fecaca; color:var(--danger); background:#fff }
.btn.danger:hover{ background:var(--danger-bg) }
</style>
