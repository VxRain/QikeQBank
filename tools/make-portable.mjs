#!/usr/bin/env node
/**
 * 便携版打包（Windows）：release 单 exe + 预建 data/ 目录 + 说明，打成 zip。
 * 便携语义见 src-tauri/src/db.rs portable_data_dir：exe 同目录存在 data/ 目录
 * 或 portable.ini 空文件（cc-switch 同款标记，二选一）即全部数据（qbank.db、
 * export/、WebView2 缓存）落在同目录 data/ 下，U 盘拷贝即走。
 * 要求：已安装 Rust 工具链 + Tauri CLI 依赖；目标机须自带 WebView2（Win10 1803+/Win11 预装）。
 * 用法：pnpm portable（全量：前端+release+组装+zip）
 *       node tools/make-portable.mjs --skip-build（复用已有构建，只组装+zip）
 *
 * 安全约束：成品目录 dist-portable/<产品>-portable-<版本>/ 下的 data/ 是用户真实数据
 * （题库 qbank.db、图片、导出、WebView 缓存）。本脚本**只覆盖 exe 与说明文件**，
 * 不清空目录、不把 data/ 打进 zip；zip 恒为空白新包，解压即用。
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tauriDir = path.join(root, 'src-tauri')
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit', shell: true });

if (os.platform() !== 'win32') {
  console.error('便携版打包仅支持 Windows');
  process.exit(1);
}

const conf = JSON.parse(fs.readFileSync(path.join(tauriDir, 'tauri.conf.json'), 'utf8'));
const version = conf.version || '0.0.0';
const product = conf.productName || 'QBank';
const skipBuild = process.argv.includes('--skip-build');

// 1) 前端 + release 二进制（走 tauri 官方入口，确保资源正确嵌入）
// 注意：直接 cargo build --release 会缺失 codegen 的模式判定，
// 导致前端资源不嵌入 exe（便携包白屏 localhost 拒绝连接）
if (!skipBuild) {
  run('pnpm build');
  run('pnpm tauri build --no-bundle');
} else {
  console.log('skip build：复用已有构建产物');
}

const exe = path.join(tauriDir, 'target', 'release', 'qbank.exe');
if (!fs.existsSync(exe)) {
  console.error('找不到 release 二进制：' + exe);
  process.exit(1);
}

// 2) 组装：先在临时目录拼一份「干净的包」（data/ 为空），再回填到成品目录。
//    关键：成品目录里的 data/ 是用户的真实数据（题库/图片/导出），绝不能删更不能进 zip。
const distDir = path.join(root, 'dist-portable');
const finalDir = path.join(distDir, `${product}-portable-${version}`);
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'qbank-portable-'));
const README = [
  `${product} ${version} 便携版（Windows）`,
  '',
  '用法：解压到任意目录（U 盘亦可），双击运行。',
  '检测到本目录存在 data/ 文件夹即为便携模式，所有数据（题库 qbank.db、导出文件、浏览缓存）都存在里面。',
  '注意：',
  '  1. 需要系统自带 WebView2（Win10 1803+/Win11 一般预装）。',
  '  2. 搬家时整个目录一起拷走即可；删除 data/ 则回到系统目录模式。',
  '',
].join('\r\n');

try {
  const stageRoot = path.join(stage, `${product}-portable-${version}`);
  fs.mkdirSync(stageRoot, { recursive: true });
  fs.copyFileSync(exe, path.join(stageRoot, `${product}.exe`));
  // 预建空 data/ 目录：存在即便携模式（VSCode 同款约定）
  fs.mkdirSync(path.join(stageRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(stageRoot, '便携版说明.txt'), README);

  // 3) 打 zip（系统自带 Compress-Archive，只含刚组装的干净目录）
  fs.mkdirSync(distDir, { recursive: true });
  const zip = path.join(distDir, `${product}-portable-${version}-win64.zip`);
  if (fs.existsSync(zip)) fs.rmSync(zip);
  run(`powershell -NoProfile -Command "Compress-Archive -Path '${stageRoot}' -DestinationPath '${zip}'"`);

  // 4) 回填成品目录：只覆盖 exe 与说明，data/ 缺了才建，已有则原封不动
  fs.mkdirSync(finalDir, { recursive: true });
  const dataDir = path.join(finalDir, 'data');
  const hadData = fs.existsSync(dataDir);
  try {
    fs.copyFileSync(path.join(stageRoot, `${product}.exe`), path.join(finalDir, `${product}.exe`));
  } catch (e) {
    if (e && (e.code === 'EBUSY' || e.code === 'EPERM')) {
      console.error('写不进 exe：程序正在运行（或文件被占用）。请先关掉它再重跑打包。');
    }
    throw e;
  }
  fs.writeFileSync(path.join(finalDir, '便携版说明.txt'), README);
  if (!hadData) fs.mkdirSync(dataDir, { recursive: true });

  console.log('PORTABLE OK →', zip);
  console.log('成品目录 →', finalDir, hadData ? '（已有 data/ 测试数据，已保留）' : '（新建空 data/）');
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
