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

// mojang.js —— Minecraft 版本下载主流程

const fs = require("fs");
const path = require("path");
const verMod = require("./version.js");
const dl = require("./download.js");
const xgmclLog = require("./xgmcl_log.js");

const MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

// ---- 清单 / version.json ----

async function fetchManifest(source = "bmclapi") {
  const url = dl.rewriteUrl(MANIFEST_URL, source);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function fetchVersionJson(versionUrl, source = "bmclapi") {
  const url = dl.rewriteUrl(versionUrl, source);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// ---- rules ----

function rulesAllow(rules, osName = "windows", osArch = "x86_64") {
  if (!rules) return true;
  let allow = false;
  for (const r of rules) {
    const action = r.action;
    const osRule = r.os || {};
    if ("name" in osRule && osRule.name !== osName) continue;
    if ("arch" in osRule && osRule.arch !== osArch && osRule.arch !== "x86") continue;
    if (action === "allow") allow = true;
    else if (action === "disallow") return false;
  }
  return allow;
}

// ---- 文件收集 ----

function collectFiles(versionJson, versionDir, rootPath, source) {
  const files = [];
  const versionName = path.basename(versionDir);

  // 1. client.jar
  const client = (versionJson.downloads || {}).client;
  if (client && client.url) {
    files.push({
      url: dl.rewriteUrl(client.url, source),
      target: path.join(versionDir, `${versionName}.jar`),
      sha1: client.sha1 || "",
      size: client.size || 0,
      important: true,
    });
  }

  // 2. libraries
  const libsRoot = path.join(rootPath, "libraries");
  for (const lib of versionJson.libraries || []) {
    if (!rulesAllow(lib.rules)) continue;
    const artifact = (lib.downloads || {}).artifact;
    if (artifact && artifact.path) {
      if (!artifact.url) continue;
      files.push({
        url: dl.rewriteUrl(artifact.url, source),
        target: path.join(libsRoot, artifact.path.replace(/\//g, path.sep)),
        sha1: artifact.sha1 || "",
        size: artifact.size || 0,
        important: true,
      });
    }
  }

  // 3. assetIndex
  const assetIndexInfo = versionJson.assetIndex || {};
  const assetIndexId = assetIndexInfo.id || "";
  if (assetIndexId && assetIndexInfo.url) {
    const assetsRoot = path.join(rootPath, "assets");
    const indexTarget = path.join(assetsRoot, "indexes", `${assetIndexId}.json`);
    files.push({
      url: dl.rewriteUrl(assetIndexInfo.url, source),
      target: indexTarget,
      sha1: assetIndexInfo.sha1 || "",
      size: assetIndexInfo.size || 0,
      important: true,
    });
  }

  return files;
}

function collectAssetObjects(assetIndex, assetsRoot, source) {
  const files = [];
  const objects = assetIndex.objects || {};
  for (const [name, info] of Object.entries(objects)) {
    const h = info.hash || "";
    if (!h) continue;
    const sub = h.slice(0, 2);
    const url = dl.rewriteUrl(
      `https://resources.download.minecraft.net/${sub}/${h}`,
      source
    );
    files.push({
      url,
      target: path.join(assetsRoot, "objects", sub, h),
      sha1: h,
      size: info.size || 0,
      important: false,
    });
  }
  return files;
}

// ---- 主流程 ----

async function startDownload(rootPath, versionName, mcVersionId, mcVersionUrl, source, threads, taskId) {
  const t = dl.getTask(taskId);
  if (!t) {
    xgmclLog.writeDownloadLog(`[主流程] 任务不存在: ${taskId}`);
    return;
  }

  Object.assign(t, {
    active: true,
    cancel: false,
    version: versionName,
    mc_version: mcVersionId,
    root_path: rootPath,
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
  });

  try {
    // 1. 拉版本 json
    dl.setTaskField(taskId, "current_files", ["获取版本信息..."]);
    xgmclLog.writeDownloadLog(`[主流程] 开始下载 ${versionName} (源=${source})`);

    const versionJson = await fetchVersionJson(mcVersionUrl, source);

    // 2. 目标目录
    const versionDir = path.join(rootPath, "versions", versionName);
    fs.mkdirSync(versionDir, { recursive: true });

    // 3. 收集文件
    dl.setTaskField(taskId, "current_files", ["解析文件列表..."]);
    xgmclLog.writeDownloadLog("[主流程] 解析 client / libraries ...");
    const files = collectFiles(versionJson, versionDir, rootPath, source);
    xgmclLog.writeDownloadLog(`[主流程] client + libraries: ${files.length} 个文件`);

    // 4. assets
    const assetIndexInfo = versionJson.assetIndex || {};
    const assetIndexId = assetIndexInfo.id || "";
    if (assetIndexId) {
      xgmclLog.writeDownloadLog(`[主流程] 资源索引 ID: ${assetIndexId}`);
      const assetsRoot = path.join(rootPath, "assets");
      const indexesDir = path.join(assetsRoot, "indexes");
      const indexFile = path.join(indexesDir, `${assetIndexId}.json`);

      if (!fs.existsSync(indexFile)) {
        dl.setTaskField(taskId, "current_files", ["下载资源索引..."]);
        try {
          await dl.downloadOneFile({
            url: dl.rewriteUrl(assetIndexInfo.url, source),
            target: indexFile,
            sha1: assetIndexInfo.sha1 || "",
            size: assetIndexInfo.size || 0,
            important: true,
          }, source, 5, taskId);
        } catch (e) {
          xgmclLog.writeDownloadLog(`[主流程] 资源索引下载失败: ${e.message}`);
        }
      } else {
        xgmclLog.writeDownloadLog("[主流程] 资源索引已存在");
      }

      if (fs.existsSync(indexFile)) {
        try {
          const assetIndex = JSON.parse(fs.readFileSync(indexFile, "utf-8"));
          const assetFiles = collectAssetObjects(assetIndex, assetsRoot, source);
          files.push(...assetFiles);
          xgmclLog.writeDownloadLog(`[主流程] assets objects: ${assetFiles.length} 个文件`);
        } catch (e) {
          xgmclLog.writeDownloadLog(`[主流程] 解析资源索引失败: ${e.message}`);
        }
      }
    }

    // 5. 统计
    const total = files.reduce((s, f) => s + (f.size || 0), 0);
    xgmclLog.writeDownloadLog(`[主流程] 总计 ${files.length} 个文件，总大小 ${formatSize(total)}`);
    Object.assign(t, {
      total_bytes: total,
      files_total: files.length,
      current_files: [],
    });

    // 6. 速度线程
    dl.startSpeedUpdater(taskId);

    // 7. 并发下载
    const failed = await dl.downloadBatch(files, source, threads, taskId);

    // 等一下让文件句柄释放
    await dl.sleep(500);

    // 8. 统计输出
    const actual = t.actual_downloaded_bytes;
    const skipped = t.skipped_bytes;
    const fTotal = t.files_total;
    const fDone = t.files_done;
    const fSkip = t.files_skipped;
    const fDl = t.files_downloaded;
    const pct = ((actual + skipped) / Math.max(total, 1)) * 100;

    xgmclLog.writeDownloadLog("=".repeat(60));
    xgmclLog.writeDownloadLog(`[统计] 总文件数: ${fTotal}`);
    xgmclLog.writeDownloadLog(`[统计] 失败文件数: ${failed.length}`);
    xgmclLog.writeDownloadLog(`[统计] 本次下载: ${formatSize(actual)} (${fDl} 个文件)`);
    xgmclLog.writeDownloadLog(`[统计] 已跳过:   ${formatSize(skipped)} (${fSkip} 个文件)`);
    xgmclLog.writeDownloadLog(`[统计] 总大小:   ${formatSize(total)}`);
    xgmclLog.writeDownloadLog(`[统计] 进度:     ${pct.toFixed(1)}% (${fDone}/${fTotal})`);
    if (failed.length) {
      xgmclLog.writeDownloadLog("[统计] 失败列表（前 100 个）:");
      for (const ff of failed.slice(0, 100)) {
        xgmclLog.writeDownloadLog(`  - ${ff.path} : ${ff.error.slice(0, 100)}`);
      }
    }
    xgmclLog.writeDownloadLog("=".repeat(60));

    xgmclLog.writeLog("INFO", `下载完成: ${versionName}, 失败 ${failed.length} 个文件`);

    // 9. 写 json + 解 natives
    if (!dl.isTaskCancelled(taskId)) {
      fs.writeFileSync(
        path.join(versionDir, `${versionName}.json`),
        JSON.stringify(versionJson, null, 2),
        "utf-8"
      );

      try {
        const libsRoot = path.join(rootPath, "libraries");
        const nativesDir = path.join(versionDir, `${versionName}-natives`);
        verMod.extractNatives(versionJson, libsRoot, nativesDir);
      } catch (e) {
        console.log(`[WARN] natives 解压失败: ${e.message}`);
      }

      if (t.failed_count === 0) {
        t.done = true;
      } else {
        t.error = `${t.failed_count} 个文件下载失败`;
      }
      t.active = false;
    } else {
      // 取消：清理
      xgmclLog.writeDownloadLog(`[取消] 任务 ${taskId} 被取消，开始清理...`);
      let cleaned = 0;
      for (const f of files) {
        const temp = f.target + ".part";
        try {
          if (fs.existsSync(temp)) {
            fs.unlinkSync(temp);
            cleaned++;
          }
        } catch (_) {}
      }
      let removed = 0;
      for (const f of files) {
        try {
          if (fs.existsSync(f.target)) {
            fs.unlinkSync(f.target);
            removed++;
          }
        } catch (_) {}
      }
      xgmclLog.writeDownloadLog(`[取消] 清理完成：删了 ${cleaned} 个 .part，${removed} 个已下文件`);

      // 尝试删空目录
      try {
        if (fs.existsSync(versionDir) && fs.readdirSync(versionDir).length === 0) {
          fs.rmdirSync(versionDir);
        }
      } catch (_) {}

      t.cancel = true;
      t.active = false;
    }

  } catch (e) {
    const t2 = dl.getTask(taskId);
    if (t2) {
      t2.error = e.message;
      t2.active = false;
    }
    xgmclLog.writeDownloadLog(`[主流程][ERROR]致命错误: ${e.message}`);
    console.log(`[ERROR]下载失败: ${e.message}`);
  }
}

function formatSize(n) {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(2)} ${units[i]}`;
}

module.exports = {
  fetchManifest,
  fetchVersionJson,
  collectFiles,
  collectAssetObjects,
  startDownload,
  formatSize,
};