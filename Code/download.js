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

// download.js —— 多任务下载核心（任务管理 + 单文件下载 + 断点续传 + 多源切换）

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const xgmclLog = require("./xgmcl_log.js");

// ---- 全局任务表 ----
const TASKS = new Map(); // task_id -> task_state

function createTask(opts) {
  const {
    task_name,
    task_type = "vanilla",
    root_path = "",
    mc_version = "",
    source = "bmclapi",
    threads = 16,
  } = opts;

  const taskId = crypto.randomUUID();
  const state = {
    task_id: taskId,
    task_name,
    task_type,
    stage: 1,
    stage_total: 1,
    active: false,
    cancel: false,
    version: task_name,
    mc_version,
    root_path,
    source,
    threads,
    total_bytes: 0,
    downloaded_bytes: 0,
    actual_downloaded_bytes: 0,
    skipped_bytes: 0,
    speed: 0,
    current_files: [],
    files_total: 0,
    files_done: 0,
    files_skipped: 0,
    files_downloaded: 0,
    error: null,
    done: false,
    start_time: Math.floor(Date.now() / 1000),
    last_bytes: 0,
    retry_log: [],
    failed_count: 0,
    failed_files: [],
  };
  TASKS.set(taskId, state);
  return taskId;
}

function getTask(taskId) {
  return TASKS.get(taskId) || null;
}

function listTasks() {
  return Array.from(TASKS.values());
}

function removeTask(taskId) {
  TASKS.delete(taskId);
}

function isTaskCancelled(taskId) {
  if (!taskId) return false;
  const t = TASKS.get(taskId);
  if (!t) return true;
  return Boolean(t.cancel);
}

function setTaskField(taskId, key, val) {
  if (!taskId) return;
  const t = TASKS.get(taskId);
  if (t) t[key] = val;
}

function addProgress(taskId, bytes) {
  if (!taskId) return;
  const t = TASKS.get(taskId);
  if (!t) return;
  t.actual_downloaded_bytes += bytes;
  t.downloaded_bytes += bytes;
}

function markSkipped(taskId, size) {
  if (!taskId) return;
  const t = TASKS.get(taskId);
  if (!t) return;
  t.skipped_bytes += size;
  t.downloaded_bytes += size;
  t.files_skipped++;
}

function markDownloaded(taskId) {
  if (!taskId) return;
  const t = TASKS.get(taskId);
  if (!t) return;
  t.files_downloaded++;
}

// 每个任务一个速度计时器
function startSpeedUpdater(taskId) {
  const timer = setInterval(() => {
    const t = TASKS.get(taskId);
    if (!t || !t.active) {
      clearInterval(timer);
      return;
    }
    const now = t.actual_downloaded_bytes;
    t.speed = now - (t.last_bytes || 0);
    t.last_bytes = now;
  }, 1000);
  return timer;
}

// ---- 源重写 ----

const SOURCE_ORDER = ["bmclapi", "official", "mcbbbs"];

const SOURCE_MAP = {
  bmclapi: {
    "piston-meta.mojang.com": "bmclapi2.bangbang93.com",
    "piston-data.mojang.com": "bmclapi2.bangbang93.com",
    "libraries.minecraft.net": "bmclapi2.bangbang93.com/maven",
    "resources.download.minecraft.net": "bmclapi2.bangbang93.com/assets",
  },
  official: {},
  mcbbbs: {
    "piston-meta.mojang.com": "download.mcbbs.net",
    "piston-data.mojang.com": "download.mcbbs.net",
    "libraries.minecraft.net": "download.mcbbs.net/maven",
    "resources.download.minecraft.net": "download.mcbbs.net/assets",
  },
};

function rewriteUrl(url, source) {
  const rules = SOURCE_MAP[source] || {};
  let result = url;
  for (const [from, to] of Object.entries(rules)) {
    result = result.split(from).join(to);
  }
  return result;
}

function reverseRewriteUrl(url) {
  for (const [src, rules] of Object.entries(SOURCE_MAP)) {
    if (src === "official") continue;
    for (const [official, mirror] of Object.entries(rules)) {
      if (url.includes(mirror)) {
        return url.split(mirror).join(official);
      }
    }
  }
  return url;
}

// ---- SHA1 ----

function computeSha1(filePath) {
  const h = crypto.createHash("sha1");
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(65536);
  try {
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.slice(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

// ---- 单文件下载 ----

// 返回值: { status: "done" | "skipped" | "cancelled", bytes }
async function downloadOneFile(fileInfo, baseSource = "bmclapi", maxRetries = 5, taskId = null) {
  if (isTaskCancelled(taskId)) {
    return { status: "cancelled", bytes: 0 };
  }

  const originalUrl = fileInfo.url;
  const target = fileInfo.target;
  const sha1 = fileInfo.sha1 || "";
  const important = fileInfo.important || false;
  const expectedSize = fileInfo.size || 0;

  // 短路径用于日志
  let relPath = target;
  try {
    if (target.includes("objects")) {
      relPath = "assets/" + path.basename(target).slice(0, 16);
    } else if (target.includes("libraries")) {
      relPath = "libs/" + path.basename(target);
    } else {
      relPath = path.basename(target);
    }
  } catch (_) {}

  xgmclLog.writeDownloadLog(`[开始] ${relPath}`);

  const officialUrl = reverseRewriteUrl(originalUrl);
  const temp = target + ".part";

  // 已存在且大小对 → 跳过
  if (fs.existsSync(target)) {
    try {
      const st = fs.statSync(target);
      if (expectedSize && st.size === expectedSize) {
        if (important && sha1) {
          if (computeSha1(target) === sha1) {
            xgmclLog.writeDownloadLog(`[跳过] ${relPath} (已存在)`);
            markSkipped(taskId, expectedSize);
            return { status: "skipped", bytes: expectedSize };
          }
        } else {
          xgmclLog.writeDownloadLog(`[跳过] ${relPath} (已存在)`);
          markSkipped(taskId, expectedSize);
          return { status: "skipped", bytes: expectedSize };
        }
      }
    } catch (_) {}
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });

  let lastError = null;

  // 源序列
  const sourceSeq = [baseSource];
  for (const s of SOURCE_ORDER) {
    if (s !== baseSource && !sourceSeq.includes(s)) {
      sourceSeq.push(s);
    }
  }

  // Modrinth CDN 域名切换
  const extraCdnUrls = [];
  if (originalUrl.includes("cdn.modrinth.com")) {
    extraCdnUrls.push(originalUrl.replace("cdn.modrinth.com", "cdn-raw.modrinth.com"));
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const useRawCdn = Math.floor(attempt / 2) % 2 === 1 && extraCdnUrls.length > 0;

    const currentSource = sourceSeq[attempt % sourceSeq.length];
    let currentUrl;
    if (useRawCdn) {
      currentUrl = extraCdnUrls[0];
    } else {
      currentUrl = rewriteUrl(officialUrl, currentSource);
    }
    // 只在 BMCLAPI 镜像时把 + 编码成 %2B（BMCLAPI 需要）
    if (currentUrl.includes("bmclapi2.bangbang93.com")) {
      currentUrl = currentUrl.replace(/\+/g, "%2B");
    }

    // 续传
    let resume = 0;
    if (fs.existsSync(temp)) {
      resume = fs.statSync(temp).size;
      if (expectedSize && resume === expectedSize) {
        try {
          if (fs.existsSync(target)) fs.unlinkSync(target);
          fs.renameSync(temp, target);
          fsyncFile(target);
          xgmclLog.writeDownloadLog(`[完成] ${relPath} (从 .part 移正)`);
          markDownloaded(taskId);
          return { status: "done", bytes: expectedSize };
        } catch (_) {}
      }
    }

    try {
      const headers = {};
      if (resume > 0) {
        headers["Range"] = `bytes=${resume}-`;
      }

      const ctrl = new AbortController();
      const res = await fetch(currentUrl, { headers, signal: ctrl.signal });

      if (res.status === 416) {
        resume = 0;
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
        throw new Error("Range 416");
      }
      if (res.status === 404) {
        throw new Error("404 Not Found");
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const fileStream = fs.createWriteStream(temp, { flags: resume > 0 ? "a" : "w" });
      const nodeStream = Readable.fromWeb(res.body);

      await new Promise((resolve, reject) => {
        let cancelled = false;
        nodeStream.on("data", (chunk) => {
          if (isTaskCancelled(taskId)) {
            cancelled = true;
            nodeStream.destroy();
            return;
          }
          fileStream.write(chunk);
          addProgress(taskId, chunk.length);
        });
        nodeStream.on("end", () => fileStream.end(resolve));
        nodeStream.on("error", (e) => {
          fileStream.end();
          reject(e);
        });
        fileStream.on("error", reject);
        fileStream.on("close", () => {
          if (cancelled) reject(new Error("cancelled"));
        });
      });

      // SHA1 校验
      if (important && sha1) {
        const actual = computeSha1(temp);
        if (actual !== sha1) {
          if (fs.existsSync(temp)) fs.unlinkSync(temp);
          throw new Error("SHA1 不符");
        }
      }

      // 移正
      if (fs.existsSync(target)) fs.unlinkSync(target);
      fs.renameSync(temp, target);
      fsyncFile(target);

      const realHost = hostOf(currentUrl);
      xgmclLog.writeDownloadLog(`[完成] ${relPath} (真实源=${realHost})`);
      markDownloaded(taskId);
      return { status: "done", bytes: expectedSize };

    } catch (e) {
      if (isTaskCancelled(taskId)) {
        try {
          if (fs.existsSync(temp)) fs.unlinkSync(temp);
        } catch (_) {}
        xgmclLog.writeDownloadLog(`[取消] ${relPath}`);
        return { status: "cancelled", bytes: 0 };
      }

      lastError = e.message;
      const realHost = hostOf(currentUrl);
      xgmclLog.writeDownloadLog(
        `[失败] ${relPath} (真实源=${realHost}, 基源=${currentSource}) - ${lastError.slice(0, 120)}`
      );
      if (taskId) {
        const t = TASKS.get(taskId);
        if (t) {
          t.retry_log.push(
            `重试 ${attempt + 1}/${maxRetries} (${realHost}): ${relPath} - ${lastError.slice(0, 60)}`
          );
        }
      }
      await sleep(1000);
    }
  }

  xgmclLog.writeDownloadLog(`[彻底失败] ${relPath} - 已重试 ${maxRetries} 次`);
  throw new Error(`下载失败（已重试 ${maxRetries} 次）: ${lastError}`);
}

function hostOf(url) {
  try {
    return new URL(url).host || "?";
  } catch (_) {
    return "?";
  }
}

function fsyncFile(filePath) {
  try {
    const fd = fs.openSync(filePath, "r+");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch (_) {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 并发下载一批文件（限制并发数）
async function downloadBatch(files, source, threads, taskId) {
  const failed = [];
  let index = 0;
  let cancelled = false;

  async function worker() {
    while (true) {
      if (cancelled || isTaskCancelled(taskId)) {
        cancelled = true;
        return;
      }
      const i = index++;
      if (i >= files.length) return;

      const f = files[i];
      try {
        await downloadOneFile(f, source, 5, taskId);
      } catch (e) {
        failed.push({ path: f.target, error: e.message.slice(0, 200) });
        const t = TASKS.get(taskId);
        if (t) {
          t.failed_count++;
          if (t.failed_files.length < 50) {
            t.failed_files.push(path.basename(f.target));
          }
        }
      } finally {
        const t = TASKS.get(taskId);
        if (t) t.files_done++;
      }
    }
  }

  const n = Math.max(1, Math.min(threads, files.length));
  const workers = [];
  for (let i = 0; i < n; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return failed;
}

module.exports = {
  TASKS,
  createTask,
  getTask,
  listTasks,
  removeTask,
  isTaskCancelled,
  setTaskField,
  addProgress,
  markSkipped,
  markDownloaded,
  startSpeedUpdater,
  rewriteUrl,
  reverseRewriteUrl,
  computeSha1,
  downloadOneFile,
  downloadBatch,
  sleep,
};