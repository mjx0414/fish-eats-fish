#!/usr/bin/env node
/**
 * 发布构建：把运行时文件收进 release/dist，打成 zip，并生成 SHA256 校验和。
 *
 * 为什么不用现成的打包器：整个项目零依赖，发布链路也不该引入一个。
 * zip 格式由 zlib 的 raw deflate + 手写中央目录实现，~80 行，无第三方。
 *
 * 用法：npm run release
 */

import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'release');
const DIST = path.join(OUT_DIR, 'dist');

/** 进入发布产物的文件。白名单而非黑名单——避免把测试、报告、node_modules 误打进去。 */
const RUNTIME = ['index.html', 'style.css', 'src/rules.js', 'src/game.js'];

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ZIP = path.join(OUT_DIR, `fish-eats-fish-v${version}.zip`);

/* ---------------- 收集 ---------------- */

function collect() {
  const files = [];
  for (const rel of RUNTIME) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) throw new Error(`缺少运行时文件：${rel}`);
    const raw = fs.readFileSync(abs);
    // 归档前把 CRLF 归一化为 LF。产物哈希不能取决于开发机的 core.autocrlf，
    // 否则同一标签在 Windows 与 Linux 上会算出不同的 SHA256。
    const data = Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    const st = fs.statSync(abs);
    files.push({ rel: rel.split(path.sep).join('/'), data, mtimeMs: st.mtimeMs });
  }
  return files;
}

/**
 * 归档时间戳必须确定，否则同一份源码两次构建得到不同哈希，
 * "重建产物 == 已发布产物"就无法校验。
 * 优先 SOURCE_DATE_EPOCH（可复现构建的通用约定），否则取输入文件的最大 mtime。
 */
function stamp(files) {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  const secs = epoch ? Number(epoch) : Math.floor(Math.max(...files.map((f) => f.mtimeMs)) / 1000);
  if (!Number.isFinite(secs) || secs <= 0) throw new Error('SOURCE_DATE_EPOCH 非法');
  // DOS 时间只存偶数秒，先归一化，避免奇偶差异造成哈希漂移
  return new Date(Math.floor(secs / 2) * 2 * 1000);
}

/* ---------------- CRC32 ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------------- ZIP ---------------- */

function dosTime(d) {
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
    date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
  };
}

function buildZip(files) {
  const now = dosTime(stamp(files));
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const name = Buffer.from(f.rel, 'utf8');
    const comp = deflateRawSync(f.data, { level: 9 });
    // 压缩后反而更大时退回 STORE，避免小文件被 deflate 撑大
    const method = comp.length < f.data.length ? 8 : 0;
    const body = method === 8 ? comp : f.data;
    const crc = crc32(f.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(now.time, 12);
    central.writeUInt16LE(now.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk
    central.writeUInt16LE(0, 36);        // internal attr
    central.writeUInt32LE(0, 38);        // external attr
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

/* ---------------- 执行 ---------------- */

const files = collect();

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
for (const f of files) {
  const dest = path.join(DIST, f.rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, f.data);
}

const zip = buildZip(files);
fs.writeFileSync(ZIP, zip);

const sums = files.map((f) => `${createHash('sha256').update(f.data).digest('hex')}  ${f.rel}`);
const zipHash = createHash('sha256').update(zip).digest('hex');
fs.writeFileSync(
  path.join(OUT_DIR, 'SHA256SUMS.txt'),
  [
    `# 大鱼吃小鱼 v${version}`,
    `# 校验：sha256sum -c SHA256SUMS.txt`,
    '',
    ...sums,
    '',
    `# 归档`,
    `${zipHash}  ${path.basename(ZIP)}`,
    ''
  ].join('\n'),
  'utf8'
);

const total = files.reduce((s, f) => s + f.data.length, 0);
console.log(`v${version} → ${path.relative(ROOT, ZIP)}`);
console.log(`  源文件 ${files.length} 个，${(total / 1024).toFixed(1)} KB（未压缩）`);
console.log(`  归档   ${(zip.length / 1024).toFixed(1)} KB`);
for (const f of files) console.log(`    ${f.rel.padEnd(16)} ${String(f.data.length).padStart(6)} B`);
