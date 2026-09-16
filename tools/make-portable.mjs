#!/usr/bin/env node
/**
 * 便携版打包（Windows）：release 单 exe + 预建 data/ 目录 + 说明，打成 zip。
 * 便携语义见 src-tauri/src/db.rs portable_data_dir：exe 同目录存在 data/ 目录
 * 或 portable.ini 空文件（cc-switch 同款标记，二选一）即全部数据（qbank.db、
 * export/、WebView2 缓存）落在同目录 data/ 下，U 盘拷贝即走。
 * 要求：已安装 Rust 工具链 + Tauri CLI 依赖；目标机须自带 WebView2（Win10 1803+/Win11 预装）。
 * 用法：pnpm portable（全量：前端+release+组装+zip）
 *       node tools/make-portable.mjs --skip-build（复用已有构建，只组装+zip）
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

// 2) 组装 portable 目录
const stage = path.join(root, 'dist-portable', `${product}-portable-${version}`);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.copyFileSync(exe, path.join(stage, `${product}.exe`));
// 预建 data/ 目录：存在即便携模式（VSCode 同款约定）
fs.mkdirSync(path.join(stage, 'data'), { recursive: true });
// 3) 打 zip（系统自带 Compress-Archive）
fs.writeFileSync(
  path.join(stage, '便携版说明.txt'),
  [
    `${product} ${version} 便携版（Windows）`,
    '',
    '用法：解压到任意目录（U 盘亦可），双击运行。',
    '检测到本目录存在 data/ 文件夹即为便携模式，所有数据（题库 qbank.db、导出文件、浏览缓存）都存在里面。',
    '注意：',
    '  1. 需要系统自带 WebView2（Win10 1803+/Win11 一般预装）。',
    '  2. 搬家时整个目录一起拷走即可；删除 data/ 则回到系统目录模式。',
    '',
  ].join('\r\n'),
);

// 3) 打 zip（系统自带 Compress-Archive）
const zip = path.join(root, 'dist-portable', `${product}-portable-${version}-win64.zip`);
if (fs.existsSync(zip)) fs.rmSync(zip);
run(`powershell -NoProfile -Command "Compress-Archive -Path '${stage}' -DestinationPath '${zip}'"`);
console.log('PORTABLE OK →', zip);
