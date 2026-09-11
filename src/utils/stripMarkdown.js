/**
 * Markdown → 纯文本预处理（供导入管线喂给 parsePureText）
 * 原则：只剥标记、保留文字与结构（空行/题号/分隔线原样保留，切分靠它们）。
 * 注意：`---` 分隔线必须保留（splitQuestions 靠它切块），这里不动。
 */

/** 单块 md 清洗（splitQuestions 之后对每块调用也安全） */
export function stripMarkdown(src) {
  const lines = String(src || '').split('\n')
  const out = []
  let inFence = false
  for (const raw of lines) {
    // 代码围栏：去围栏行，内容原样保留
    if (/^\s*```/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push(raw)
      continue
    }
    let s = raw
    s = s.replace(/^\s{0,3}#{1,6}\s+/, '') // 标题 # / ##
    s = s.replace(/^\s{0,3}>\s?/, '') // 引用 >
    s = s.replace(/^\s*([-*+])\s+(?=\S)/, '') // 无序列表 - * +（有序 1. 保留：可能是题号）
    // 行内：图片 ![a](u) → [图]；链接 [t](u) → t
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '[图]')
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // 加粗/斜体：**t** __t__ *t* _t_ → t（填空 ___ / __ __ 不动：要求首字符非下划线空白）
    s = s.replace(/\*\*([^*]+?)\*\*/g, '$1')
    // __加粗__：起止紧贴非空白且前后不能是下划线，避免从 ___ 填空中间起跳跨句匹配
    s = s.replace(/(?<!_)__([^_\s][^_]*?)__(?!_)/g, '$1')
    s = s.replace(/`([^`]+?)`/g, '$1') // 行内代码
    s = s.replace(/\|/g, ' ') // 表格竖线→空格
    s = s.replace(/[ \t]+/g, ' ').trim()
    out.push(s)
  }
  // 收尾：压缩 3+ 连续空行为 2 个（保留段落感，不合并题块）
  const compact = []
  let empties = 0
  for (const l of out) {
    if (!l) {
      empties++
      if (empties <= 2) compact.push(l)
    } else {
      empties = 0
      compact.push(l)
    }
  }
  return compact.join('\n').trim()
}
