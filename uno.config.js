import { defineConfig, presetUno, presetIcons } from 'unocss'

/**
 * UnoCSS 设计系统
 * 颜色全部映射到 App.vue :root 变量（铁律 ② 色板唯一来源）
 * shortcuts 沉淀跨页复用组件；字号/行高用显式值，避免 presetUno 的 leading-<n> 误判为 n×0.25rem
 */
export default defineConfig({
  presets: [
    presetUno(),
    // presetAttributify 已移除：项目全程 class="..." 写法，attributify 未被使用；
    // 其提取器会把 i-lucide-repeat 与后续 token 粘连成假图标候选（failed to load icon 警告）
    presetIcons({
      scale: 1,
      extraProperties: {
        display: 'inline-block',
        'vertical-align': 'middle',
        'min-width': '1em',
        height: '1em'
      },
      warn: true
    })
  ],
  theme: {
    colors: {
      bg: 'var(--bg)',
      'bg-accent': 'var(--bg-accent)',
      card: 'var(--card)',
      'card-hover': 'var(--card-hover)',
      line: 'var(--line)',
      'line-strong': 'var(--line-strong)',
      text: 'var(--text)',
      'text-secondary': 'var(--text-secondary)',
      muted: 'var(--muted)',
      'muted-light': 'var(--muted-light)',
      primary: 'var(--primary)',
      'primary-hover': 'var(--primary-hover)',
      'primary-bg': 'var(--primary-bg)',
      'primary-bg-hover': 'var(--primary-bg-hover)',
      'primary-border': 'var(--primary-border)',
      success: 'var(--success)',
      'success-bg': 'var(--success-bg)',
      danger: 'var(--danger)',
      'danger-bg': 'var(--danger-bg)',
      'danger-border-strong': 'var(--danger-border-strong)',
      'text-hover': 'var(--text-hover)'
    },
    borderRadius: {
      DEFAULT: 'var(--radius)',
      lg: 'var(--radius-lg)'
    },
    boxShadow: {
      sm: 'var(--shadow-sm)',
      DEFAULT: 'var(--shadow)',
      lg: 'var(--shadow-lg)'
    }
  },
  shortcuts: [
    // ── 布局容器 ──
    ['page', 'flex flex-col gap-4'],
    ['card', 'bg-card border border-line rounded-lg p-5 shadow-sm transition-[box-shadow,border-color] duration-150 ease-out'],
    ['card-interactive', 'hover:shadow hover:border-line-strong'],
    ['card-head', 'flex items-center justify-between gap-3 mb-4'],
    ['page-title', 'm-0 text-[24px] font-700 tracking-[-0.02em] text-text font-[var(--serif)]'],
    ['section-title', 'm-0 text-[15px] font-700 tracking-[-0.005em] text-text font-[var(--serif)]'],

    // ── 按钮（基础中性 + 变体修饰，模板用 class="btn btn-primary" 组合）──
    ['btn', 'inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-[8px] border border-line bg-card text-text-secondary text-[13px] font-500 no-underline cursor-pointer select-none shadow-sm transition-[background-color,border-color,color,box-shadow] duration-150 ease-out hover:bg-bg-accent hover:border-line-strong hover:text-text hover:shadow disabled:opacity-50 disabled:pointer-events-none disabled:shadow-sm'],
    ['btn-primary', 'bg-primary text-white border-primary hover:bg-primary-hover hover:border-primary-hover hover:text-white'],
    ['btn-danger', 'border-[#e3c9c5] text-danger bg-card hover:bg-danger-bg hover:border-[#d2a39c] hover:text-danger'],
    ['btn-primary-link', 'text-primary border-primary-border bg-card hover:bg-primary-bg hover:border-primary-border hover:text-primary-hover'],
    ['btn-ghost', 'border-transparent bg-transparent shadow-none hover:bg-bg-accent hover:shadow-none'],
    ['btn-small', 'px-3 py-1.5 text-[12px] rounded-[7px]'],
    ['btn-big', 'px-5 py-2.5 text-[15px] rounded-[10px]'],
    ['btn-tiny', 'px-2 py-1 text-[11px] rounded-[6px]'],

    // ── 分段选择器（Practice 模式/题量、Exam 题量/计分/限时共用）──
    //
    // 为什么必须封装：这套 class 原本在 7 处逐字复制（Practice 3 处 + Exam 4 处）。
    // 一旦要调 hover 行为就得改 7 个文件，而且每个文件各自为政 → 实测出现过
    // 「黑色选中按钮 hover 背景退回浅米色、白字整块消失」。
    //
    // 为什么选中态要用 `!`：`.hover\:bg-bg-accent:hover` 是 (0,2,0)特异度，
    // `.bg-text` 只有 (0,1,0)，同元素上 hover 规则**必然**赢，跟发射顺序无关。
    // 所以选中态的无条件配色必须 important 才能站稳。
    ['seg', 'px-4.5 py-2 rounded-[8px] border border-line bg-card text-text-secondary text-[14px] font-500 cursor-pointer shadow-sm transition-[background-color,border-color,color] duration-150 hover:bg-bg-accent hover:border-line-strong hover:text-text'],
    // 选中态**必须成对声明 hover**：否则 `!important` 会把 seg 的 hover 一并冻住，
    // 鼠标移上去毫无反馈（用户实测：「hover 和不 hover 一模一样」）。
    // 变体只包含选中态差异部分，尺寸/圆角仍由 seg 提供。
    ['seg-on', '!bg-text !text-white !border-text hover:!bg-text-hover hover:!border-text-hover'],
    // 危险态选中（标记待定 / 不会）：底色不反转，hover 只加深边框，不跳色
    // 静态态也用 `!`：否则会靠「shortcut 发射顺序」才能赢过 seg 的 card 底色，属于隐性依赖
    ['seg-danger', '!bg-danger-bg !text-danger !border-[#e3c9c5] hover:!bg-danger-bg hover:!border-danger-border-strong hover:!text-danger'],

    // ── 徽章（胶囊）──
    ['badge', 'inline-flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-full border border-line text-muted bg-bg-accent font-500 whitespace-nowrap'],
    ['badge-type', 'text-primary border-primary-border bg-primary-bg'],
    ['badge-cur', 'text-primary border-primary-border bg-card'],
    ['badge-ok', 'text-success border-[#bcd9c4] bg-success-bg'],
    ['badge-bad', 'text-danger border-[#e3c9c5] bg-danger-bg'],

    // ── 表单控件 ──
    ['input', 'px-3.5 py-2.25 rounded-[8px] border border-line bg-card text-text text-[14px] outline-none shadow-sm transition-[border-color,box-shadow] duration-150 placeholder:text-muted-light focus:border-primary focus:shadow-[0_0_0_3px_rgba(31,77,58,0.14)] disabled:opacity-60'],
    ['select', 'px-3.5 py-2.25 pr-[30px] rounded-[8px] border border-line bg-card text-text text-[14px] outline-none shadow-sm transition-[border-color,box-shadow] duration-150 cursor-pointer focus:border-primary focus:shadow-[0_0_0_3px_rgba(31,77,58,0.14)] disabled:opacity-60'],
    ['field-label', 'block text-[13px] font-600 text-muted mb-2.5'],

    // ── 文本/状态 ──
    ['muted', 'text-muted'],
    ['error-box', 'flex items-center justify-between gap-3 rounded-[8px] border border-[#e3c9c5] bg-danger-bg px-3.5 py-3 text-danger text-[14px]'],

    // ── 图标按钮 ──
    ['i-btn', 'inline-flex items-center justify-center gap-1.5 border border-line bg-card text-text-secondary rounded-[8px] shadow-sm transition-[background-color,border-color,color,box-shadow] duration-150 ease-out hover:text-text hover:border-line-strong hover:bg-bg-accent hover:shadow'],

    // ── 作答选项 ──
    ['option-btn', 'flex items-start gap-2 text-left px-3.5 py-2.5 rounded-[8px] border border-line bg-card text-text-secondary text-[14px] leading-[1.6] cursor-pointer shadow-sm transition-[background-color,border-color,box-shadow] duration-150 hover:bg-bg-accent hover:border-line-strong'],
    // 选项选中：主色淡底 + 主色描边 + 光环。成对声明 hover（不加深的话 hover 时只改边框很寡淡）
    // shadow 必须带 `!`：option-btn 自带 shadow-sm，同层竞争靠发射顺序太脆
    ['option-btn-on', '!bg-primary-bg !border-primary-border !text-text !shadow-[0_0_0_3px_rgba(31,77,58,0.12)] hover:!bg-primary-bg hover:!border-primary hover:!text-text'],
    // 判分后的选项自身着色（FE-P1-06）：必须在 option-btn-on 之后定义，且带 `!`
    // ——判分后这一项既要压过 option-btn 的默认底色，也要压过选中态。
    // 颜色沿用 App.vue 的 --success/--danger 色系（success-bg / danger-bg + 同族描边）。
    ['option-btn-right', '!bg-success-bg !border-[#bcd9c4] !text-text !shadow-[0_0_0_3px_rgba(47,125,79,0.14)] hover:!bg-success-bg hover:!border-[#bcd9c4] hover:!text-text'],
    ['option-btn-wrong', '!bg-danger-bg !border-[#e3c9c5] !text-text !shadow-[0_0_0_3px_rgba(180,60,50,0.12)] hover:!bg-danger-bg hover:!border-[#e3c9c5] hover:!text-text'],

    // ── 图标组（Banks 视图切换等「多选一」图标钮）──
    // base 只改尺寸/形状，方块化交给外层容器；不嵌 btn（避免 shadow-none/阴影叠加歧义）
    ['seg-icon', 'inline-flex items-center justify-center gap-1.5 border-0 bg-card text-text-secondary text-[13px] font-500 cursor-pointer transition-colors duration-150 hover:bg-bg-accent hover:text-text'],
    ['seg-icon-on', '!bg-primary-bg !text-primary hover:!bg-primary-bg-hover hover:!text-primary'],

    // ── 表格行选中（List / Wrong 勾选后整行高亮）──
    // 必须成对 hover，且 hover 色要**仍然像选中**：行自带 hover:bg-card-hover 会被 `!` 压掉，
    // 若不补一对 hover，选中行悬停时画面完全不动（用户报「hover 和不 hover 一样」）。
    // 这里用深一档的主色淡底：既给出反馈，又不退回中性 card 色而丢失选中感。
    ['row-on', '!bg-primary-bg hover:!bg-primary-bg-hover'],

    // ── 进度条 ──
    ['progress-track', 'h-1.5 rounded-full bg-bg-accent overflow-hidden'],
    ['progress-inner', 'h-full rounded-full bg-primary transition-[width] duration-250 ease-out']
  ],
  content: {
    pipeline: {
      include: [/src\/.*\.(vue|js|ts|jsx|tsx|html)$/]
    }
  }
})
