/*
XGstudio Minecraft Launcher (XGMCL)
Copyright (C) 2026  XG-cyhliu

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/



// xgmcl_log.js —— XGMCL 启动器日志（JS 版）

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { app } = require("electron");

let BASE;
if (app && app.isPackaged) {
  BASE = path.dirname(app.getPath("exe"));
} else {
  BASE = __dirname;
}
const LOG_DIR = path.join(BASE, "XGMCL", "xgmcllog");

// 当前日志文件路径（进程内单例）
let currentLogPath = null;
let currentDownloadLogPath = null;

function ensureDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  } catch (e) {
    console.error("[xgmcl_log] 创建日志目录失败:", e.message);
  }
}

function getLogDir() {
  return LOG_DIR;
}

// 按 "XGMCL_年.月.日.时_[n]LOG.log" 生成新文件名
function buildLogFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const base = `XGMCL_${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}.${pad(now.getHours())}`;

  ensureDir();
  let n = 1;
  const prefix = base + "_[";
  try {
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (f.startsWith(prefix) && f.endsWith("]LOG.log")) {
        const idxStr = f.slice(prefix.length, -"]LOG.log".length);
        const idx = parseInt(idxStr, 10);
        if (!isNaN(idx)) n = Math.max(n, idx + 1);
      }
    }
  } catch (_) {}

  return path.join(LOG_DIR, `${base}_[${n}]LOG.log`);
}

// 初始化：创建日志文件，写启动 banner
function initLog() {
  // 启动时压缩一遍旧日志
  try {
    runCompressIfNeeded();
  } catch (e) {
    console.error("[xgmcl_log] 压缩旧日志失败:", e.message);
  }

  currentLogPath = buildLogFilename();
  try {
    fs.writeFileSync(currentLogPath, "", { encoding: "utf-8", flag: "a" });
  } catch (e) {
    console.error("[xgmcl_log] 无法创建日志文件:", e.message);
  }

  // 下载日志跟主日志同名，加 _DOWNLOAD
  const base = path.basename(currentLogPath, ".log");
  currentDownloadLogPath = path.join(LOG_DIR, `${base}_DOWNLOAD.log`);

  writeLog("INFO", "========================================");
  writeLog("INFO", "  XGMCL 启动器启动");
  writeLog("INFO", `  日志文件: ${path.basename(currentLogPath)}`);
  writeLog("INFO", "========================================");
}

function formatTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}.${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatTimeOnly() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 写一条主日志
function writeLog(level, msg) {
  if (!currentLogPath) return;
  const line = `[${formatTimestamp()}] [${level}] ${msg}\n`;
  try {
    fs.appendFileSync(currentLogPath, line, "utf-8");
  } catch (_) {}
}

// 写一条下载日志（单独文件）
function writeDownloadLog(msg) {
  if (!currentDownloadLogPath) return;
  const line = `[${formatTimeOnly()}] ${msg}\n`;
  try {
    fs.appendFileSync(currentDownloadLogPath, line, "utf-8");
  } catch (_) {}
}

function getCurrentLogPath() {
  return currentLogPath;
}

// 列出所有日志文件
function listLogFiles() {
  ensureDir();
  if (!fs.existsSync(LOG_DIR)) return [];

  const files = [];
  for (const name of fs.readdirSync(LOG_DIR)) {
    if (!name.endsWith(".log") && !name.endsWith(".log.gz")) continue;
    const full = path.join(LOG_DIR, name);
    try {
      const st = fs.statSync(full);
      files.push({
        name,
        size: st.size,
        mtime: Math.floor(st.mtimeMs / 1000),
        compressed: name.endsWith(".gz"),
      });
    } catch (_) {}
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

// 读日志文件（防路径穿越）
function readLogFile(filename, maxLines = 5000) {
  if (!filename) return { lines: null, err: "文件名为空" };
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return { lines: null, err: "非法文件名" };
  }

  const full = path.join(LOG_DIR, filename);
  if (!fs.existsSync(full)) {
    return { lines: null, err: "文件不存在" };
  }

  try {
    let text;
    if (filename.endsWith(".gz")) {
      const buf = fs.readFileSync(full);
      text = zlib.gunzipSync(buf).toString("utf-8");
    } else {
      text = fs.readFileSync(full, "utf-8");
    }
    let lines = text.split(/\r?\n/);
    if (lines.length > maxLines) {
      lines = lines.slice(-maxLines);
    }
    return { lines, err: null };
  } catch (e) {
    return { lines: null, err: e.message };
  }
}

// ---- 日志自动压缩 ----

// 配置
const COMPRESS_THRESHOLD_MB = 5;      // 单个 .log 超过这个大小就压缩
const COMPRESS_TOTAL_THRESHOLD_MB = 20; // 整个目录超过这个大小就压缩所有旧日志
const DELETE_AFTER_DAYS = 30;          // 压缩包超过这个天数直接删除
const CURRENT_LOG_PROTECT_MS = 60 * 1000; // 当前正在写的日志，1 分钟内不动

// 把单个 .log 压成 .log.gz，成功返回 true
function gzipOne(filename) {
  const full = path.join(LOG_DIR, filename);
  if (!fs.existsSync(full)) return false;
  if (filename.endsWith(".gz")) return false;

  const gzPath = full + ".gz";
  if (fs.existsSync(gzPath)) {
    // 已经有压缩包 → 直接删原文件
    try { fs.unlinkSync(full); return true; } catch (_) { return false; }
  }

  try {
    const buf = fs.readFileSync(full);
    const gz = zlib.gzipSync(buf, { level: 6 });
    fs.writeFileSync(gzPath, gz);
    fs.unlinkSync(full);
    return true;
  } catch (e) {
    console.error(`[xgmcl_log] 压缩失败 ${filename}:`, e.message);
    return false;
  }
}

// 删太旧的压缩包
function deleteOldGz() {
  if (!fs.existsSync(LOG_DIR)) return 0;
  const now = Date.now();
  const maxAge = DELETE_AFTER_DAYS * 24 * 3600 * 1000;
  let deleted = 0;

  for (const name of fs.readdirSync(LOG_DIR)) {
    if (!name.endsWith(".log.gz")) continue;
    const full = path.join(LOG_DIR, name);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs > maxAge) {
        fs.unlinkSync(full);
        deleted++;
      }
    } catch (_) {}
  }
  return deleted;
}

// 主入口：调用一次就检查一遍
// 返回 { compressed: n, deleted: n }
function runCompressIfNeeded() {
  if (!fs.existsSync(LOG_DIR)) return { compressed: 0, deleted: 0 };

  let files = [];
  try {
    files = fs.readdirSync(LOG_DIR);
  } catch (_) {
    return { compressed: 0, deleted: 0 };
  }

  // 收集 .log 文件（不含 .gz）
  const logs = [];
  let totalSize = 0;
  let totalMb = 0;
  const now = Date.now();

  for (const name of files) {
    if (!name.endsWith(".log")) continue;
    const full = path.join(LOG_DIR, name);
    try {
      const st = fs.statSync(full);
      // 正在写的日志，1 分钟内不动
      if (now - st.mtimeMs < CURRENT_LOG_PROTECT_MS) continue;
      logs.push({ name, size: st.size, mtime: st.mtimeMs });
      totalSize += st.size;
    } catch (_) {}
  }

  // 全部 .log + .log.gz 的总大小
  for (const name of files) {
    if (!name.endsWith(".log") && !name.endsWith(".log.gz")) continue;
    try {
      totalSize += fs.statSync(path.join(LOG_DIR, name)).size;
    } catch (_) {}
  }
  totalMb = totalSize / 1024 / 1024;

  let toCompress = [];
  let hitSingle = false;
  let hitTotal = false;

  for (const l of logs) {
    if (l.size >= COMPRESS_THRESHOLD_MB * 1024 * 1024) {
      toCompress.push(l.name);
      hitSingle = true;
    }
  }

  if (totalMb >= COMPRESS_TOTAL_THRESHOLD_MB) {
    hitTotal = true;
    for (const l of logs) {
      if (!toCompress.includes(l.name)) toCompress.push(l.name);
    }
  }

  let compressed = 0;
  for (const name of toCompress) {
    if (gzipOne(name)) compressed++;
  }

  const deleted = deleteOldGz();

  if (compressed > 0 || deleted > 0) {
    console.log(`[xgmcl_log] 日志压缩: 压了 ${compressed} 个，删了 ${deleted} 个旧包`);
  }
  return { compressed, deleted };
}

module.exports = {
  LOG_DIR,
  getLogDir,
  getCurrentLogPath,
  initLog,
  writeLog,
  writeDownloadLog,
  listLogFiles,
  readLogFile,
  runCompressIfNeeded,
};