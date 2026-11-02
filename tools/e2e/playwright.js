/**
 * Playwright 解析
 *
 * 「为什么不能靠 npx 缓存碰运气」的来龙去脉见下面原注释。
 */
import { createRequire } from 'node:module'

/**
 * 解析 playwright。
 *
 * ── A3：为什么现在直接从已声明的依赖加载 ──
 * 旧实现不在 package.json 声明 playwright，而是去扫 npx 缓存目录（~/_npx 下的子目录），
 * 再靠 findChromium() 回退已装浏览器。后果：
 *   - `import('playwright')` 报 ERR_MODULE_NOT_FOUND（干净安装必现）
 *   - CI 无 npx 缓存 → 直接 exit 2，e2e 根本跑不起来
 *   - 实际能跑仅因为本机 npx 缓存里恰有 playwright 1.62.1
 *
 * 现在声明 `@playwright/test` 到 devDependencies（它带 chromium 导出，
 * 与单独的 `playwright` 包 API 一致），直接解析；带缓存的部分只是为了兼容
 * 已在跑旧环境的开发者，找不到会给出明确安装命令。
 */
export async function loadPlaywright() {
  // ① 项目已声明的依赖：@playwright/test（首选）
  try {
    const req = createRequire(import.meta.url)
    return req('@playwright/test')
  } catch { /* 继续 */ }
  // ② 旧项目直接装 playwright 的情况
  try {
    return await import('playwright')
  } catch { /* 继续 */ }

  console.error(
    '找不到 playwright。请在项目根执行：\n' +
    '  pnpm add -D @playwright/test\n' +
    '  npx playwright install chromium'
  )
  process.exit(2)
}
