#!/usr/bin/env node
// ============================================================
// web/ → Android assets 单向同步脚本（web/ 是唯一事实源）
// 用法：
//   node scripts/sync-android.mjs          # 复制 web/ 源码到 Android assets
//   node scripts/sync-android.mjs --check  # 只校验一致性，不同步（CI 用，漂移时退出码 1）
// ============================================================
import { cpSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "web");
const DST = join(root, "lol-app", "app", "src", "main", "assets", "nodejs-project");

// 两端共享的文件清单（test/ 等仅 web 侧使用的不在此列）
const FILES = [
  "server.js",
  "lib/lpl.js",
  "lib/names.js",
  "lib/standings.js",
  "public/app.js",
  "public/index.html",
  "public/style.css",
];

const check = process.argv.includes("--check");
let drift = 0;
for (const f of FILES) {
  const src = join(SRC, f);
  const dst = join(DST, f);
  if (!existsSync(dst)) {
    console.error(`✗ Android 侧缺失 ${f}`);
    drift++;
    continue;
  }
  if (readFileSync(src).equals(readFileSync(dst))) {
    console.log(`✓ ${f}`);
    continue;
  }
  if (check) {
    console.error(`✗ 不一致 ${f}`);
    drift++;
  } else {
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
    console.log(`→ 已同步 ${f}`);
  }
}

if (drift) {
  console.error(`\n${drift} 个文件不同步。请在 web/ 下修改，然后运行：node scripts/sync-android.mjs`);
  process.exit(1);
}
console.log(check ? "\nweb/ 与 Android assets 一致" : "\n同步完成");
