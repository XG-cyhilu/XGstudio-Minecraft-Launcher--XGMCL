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




// ---- 依赖 ----
const fs = require("fs");
const path = require("path");
const cfgMod = require("./config.js");
const dlMod = require("./download.js");
const verMod = require("./version.js");
const fabricMod = require("./fabric.js");
const xgmclLog = require("./xgmcl_log.js");

// ---- Mojang ----

async function mojangManifest(q) {
  const source = q.source || "official";
  try {
    const mf = await mojangMod.fetchManifest(source);
    const versions = [];
    for (const v of mf.versions || []) {
      const t = v.type || "";
      if (t === "release" || t === "snapshot") {
        versions.push({
          id: v.id,
          type: t,
          releaseTime: v.releaseTime,
          url: v.url,
        });
      }
    }
    xgmclLog.writeLog("INFO", `获取 Mojang 版本列表: ${versions.length} 个 (源=${source})`);
    return { code: 200, versions, latest: mf.latest || {} };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `获取 Mojang 版本列表失败: ${e.message}`);
    return { code: 500, msg: `获取版本列表失败: ${e.message}` };
  }
}

function mojangCheckExists(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  const verDir = path.join(target.path, "versions", q.version_name || "");
  return { code: 200, exists: fs.existsSync(verDir), path: verDir };
}

async function mojangStart(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };

  // 并行上限
  const dlCfg = cfgMod.loadDownloadConfig();
  const maxParallel = dlCfg.max_parallel || 16;
  const activeCount = dlMod.listTasks().filter((t) => t.active).length;
  if (maxParallel < 16 && activeCount >= maxParallel) {
    return { code: 400, msg: `已达到最大并行任务数 (${maxParallel})，请等待其他任务完成` };
  }

  const versionName = (q.version_name || "").trim();
  if (!versionName) return { code: 400, msg: "版本名不能为空" };

  const verDir = path.join(target.path, "versions", versionName);
  if (fs.existsSync(verDir)) {
    xgmclLog.writeLog("WARN", `下载失败: 版本 ${versionName} 已存在`);
    return { code: 400, msg: `版本 ${versionName} 已存在，请换个名字` };
  }

  const g = cfgMod.loadGlobalConfig();
  const source = q.source || g.download_source || "bmclapi";
  let threads = parseInt(q.threads || "0", 10) || g.download_threads || 32;
  threads = Math.max(4, Math.min(threads, 256));

  const installFabric = q.install_fabric === "1";
  const fabricLoader = q.fabric_loader || "";
  const downloadFabricApi = q.download_fabric_api === "1";

  const taskType = installFabric ? "combined" : "vanilla";
  const stageTotal = installFabric ? (downloadFabricApi ? 3 : 2) : 1;

  const taskId = dlMod.createTask({
    task_name: versionName,
    task_type: taskType,
    root_path: target.path,
    mc_version: q.mc_version_id || "",
    source,
    threads,
  });

  Object.assign(dlMod.getTask(taskId), {
    stage_total: stageTotal,
    install_fabric: installFabric,
    fabric_loader: fabricLoader,
    version_name: versionName,
  });

  xgmclLog.writeLog("INFO",
    `开始下载: ${versionName} (MC=${q.mc_version_id}, 源=${source}, ` +
    `线程=${threads}, Fabric=${installFabric}, task_id=${taskId})`
  );

  // 异步跑
  downloadWorker(taskId, target.path, versionName, q.mc_version_id, q.mc_version_url,
                 source, threads, installFabric, fabricLoader, downloadFabricApi)
    .catch((e) => {
      xgmclLog.writeLog("ERROR", `downloadWorker 异常: ${e.message}`);
    });

  return { code: 200, msg: "下载已开始", task_id: taskId };
}

async function downloadWorker(taskId, rootPath, versionName, mcVersionId,
                              mcVersionUrl, source, threads,
                              installFabric, fabricLoader, downloadFabricApi) {
  try {
    // 阶段 1: 原版
    Object.assign(dlMod.getTask(taskId), { stage: 1 });
    await mojangMod.startDownload(rootPath, versionName, mcVersionId, mcVersionUrl,
                                  source, threads, taskId);

    const t1 = dlMod.getTask(taskId);
    if (!t1 || !t1.done || t1.error || t1.cancel) {
      finalizeTaskHistory(taskId);
      return;
    }

    // 阶段 2: Fabric
    if (installFabric && fabricLoader) {
      resetTaskStageProgress(taskId);
      Object.assign(dlMod.getTask(taskId), { stage: 2 });

      await fabricInstallMod.fabricInstallInner(
        taskId, rootPath, versionName, mcVersionId,
        fabricLoader, source, threads
      );

      const t2 = dlMod.getTask(taskId);
      if (!t2 || !t2.done || t2.error || t2.cancel) {
        finalizeTaskHistory(taskId);
        return;
      }

      // 阶段 3: Fabric API（可选）
      if (downloadFabricApi) {
        resetTaskStageProgress(taskId);
        Object.assign(dlMod.getTask(taskId), { stage: 3 });
        await fabricApiDownloadWorker(taskId, rootPath, versionName, mcVersionId);
      }
    }

    finalizeTaskHistory(taskId);
  } catch (e) {
    xgmclLog.writeLog("ERROR", `下载 worker 异常: ${e.message}`);
    const t = dlMod.getTask(taskId);
    if (t) {
      t.error = e.message;
      t.active = false;
    }
    finalizeTaskHistory(taskId);
  }
}

function resetTaskStageProgress(taskId) {
  const t = dlMod.getTask(taskId);
  if (!t) return;
  Object.assign(t, {
    active: true,
    done: false,
    error: null,
    total_bytes: 0,
    downloaded_bytes: 0,
    actual_downloaded_bytes: 0,
    skipped_bytes: 0,
    files_total: 0,
    files_done: 0,
    files_skipped: 0,
    files_downloaded: 0,
    current_files: [],
    failed_count: 0,
    failed_files: [],
  });
}

async function fabricApiDownloadWorker(taskId, rootPath, versionName, mcVersionId) {
  // TODO: 需要 modrinth.js，放到第 5 批实现
  // 现在先跳过
  const t = dlMod.getTask(taskId);
  if (t) {
    t.done = true;
    t.active = false;
  }
}

function finalizeTaskHistory(taskId) {
  try {
    const t = dlMod.getTask(taskId);
    if (!t) return;
    const record = {
      task_name: t.task_name || "",
      task_type: t.task_type || "vanilla",
      result: t.done ? "success" : (t.cancel ? "cancelled" : "failed"),
      downloaded_bytes: t.actual_downloaded_bytes || 0,
      total_bytes: t.total_bytes || 0,
      skipped_bytes: t.skipped_bytes || 0,
      error: t.error || "",
      root_path: t.root_path || "",
      mc_version: t.mc_version || "",
      finish_time: Math.floor(Date.now() / 1000),
    };
    cfgMod.appendDownloadHistory(record);
  } catch (e) {
    xgmclLog.writeLog("ERROR", `写下载历史失败: ${e.message}`);
  }
}

async function fabricInstallInner(taskId, rootPath, versionName, mcVersionId,
                                  loaderVersion, source, threads) {
  // 1. 拉 Fabric profile
  const t = dlMod.getTask(taskId);
  if (t) t.current_files = ["获取 Fabric profile..."];

  const profile = await fabricMod.fetchFabricProfile(mcVersionId, loaderVersion);

  // 2. 合并进原版 json
  const verDir = path.join(rootPath, "versions", versionName);
  const jsonPath = path.join(verDir, `${versionName}.json`);
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`版本 JSON 不存在: ${jsonPath}`);
  }
  const vanillaJson = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const merged = fabricMod.mergeFabricJson(vanillaJson, profile, loaderVersion, mcVersionId);

  // 3. 下载 Fabric 的 libraries
  const libsRoot = path.join(rootPath, "libraries");
  const files = [];
  for (const lib of profile.libraries || []) {
    const artifact = (lib.downloads || {}).artifact;
    if (!artifact || !artifact.path || !artifact.url) continue;
    files.push({
      url: dlMod.rewriteUrl(artifact.url, source),
      target: path.join(libsRoot, artifact.path.replace(/\//g, path.sep)),
      sha1: artifact.sha1 || "",
      size: artifact.size || 0,
      important: true,
    });
  }

  // 4. 统计 + 下载
  const total = files.reduce((s, f) => s + (f.size || 0), 0);
  if (t) {
    Object.assign(t, {
      total_bytes: total,
      files_total: files.length,
      current_files: [],
    });
  }
  dlMod.startSpeedUpdater(taskId);
  const failed = await dlMod.downloadBatch(files, source, threads, taskId);

  if (dlMod.isTaskCancelled(taskId)) {
    if (t) { t.cancel = true; t.active = false; }
    return;
  }

  if (failed.length > 0) {
    if (t) {
      t.error = `${failed.length} 个 Fabric 库文件下载失败`;
      t.active = false;
    }
    return;
  }

  // 5. 写回合并后的 json
  fs.writeFileSync(jsonPath, JSON.stringify(merged, null, 2), "utf-8");

  // 6. 重新解压 natives
  try {
    const nativesDir = path.join(verDir, `${versionName}-natives`);
    verMod.extractNatives(merged, libsRoot, nativesDir);
  } catch (e) {
    xgmclLog.writeLog("WARN", `Fabric natives 解压失败: ${e.message}`);
  }

  // 7. 删 classpath 缓存（json 变了，缓存要重算）
  const cpCache = path.join(verDir, ".xgmcl_cp_cache");
  if (fs.existsSync(cpCache)) {
    try { fs.unlinkSync(cpCache); } catch (_) {}
  }

  if (t) {
    t.done = true;
    t.active = false;
  }
  xgmclLog.writeLog("INFO", `Fabric ${loaderVersion} 安装完成: ${versionName}`);
}

async function fabricInstall(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };

  const dlCfg = cfgMod.loadDownloadConfig();
  const maxParallel = dlCfg.max_parallel || 16;
  const activeCount = dlMod.listTasks().filter((t) => t.active).length;
  if (maxParallel < 16 && activeCount >= maxParallel) {
    return { code: 400, msg: `已达到最大并行任务数 (${maxParallel})，请等待其他任务完成` };
  }

  if (!verMod.checkRootValid(target.path)) {
    return { code: 400, msg: "目录已失效" };
  }

  const versionName = q.version_name || "";
  const mcVersionId = q.mc_version_id || "";
  const loaderVersion = q.loader_version || "";
  if (!versionName || !mcVersionId || !loaderVersion) {
    return { code: 400, msg: "参数不完整" };
  }

  const g = cfgMod.loadGlobalConfig();
  const source = q.source || g.download_source || "bmclapi";
  let threads = parseInt(q.threads || "0", 10) || g.download_threads || 32;
  threads = Math.max(4, Math.min(threads, 256));

  const jsonPath = path.join(target.path, "versions", versionName, `${versionName}.json`);
  if (!fs.existsSync(jsonPath)) {
    return { code: 404, msg: `版本 JSON 不存在: ${jsonPath}` };
  }

  const taskId = dlMod.createTask({
    task_name: versionName + " (Fabric)",
    task_type: "fabric",
    root_path: target.path,
    mc_version: mcVersionId,
    source,
    threads,
  });

  xgmclLog.writeLog("INFO",
    `开始安装 Fabric: ${versionName} (MC=${mcVersionId}, loader=${loaderVersion}, task_id=${taskId})`
  );

  (async () => {
    try {
      const t = dlMod.getTask(taskId);
      Object.assign(t, {
        active: true,
        done: false,
        error: null,
        cancel: false,
        total_bytes: 0,
        downloaded_bytes: 0,
        actual_downloaded_bytes: 0,
        skipped_bytes: 0,
        files_total: 0,
        files_done: 0,
        files_skipped: 0,
        files_downloaded: 0,
        current_files: ["获取 Fabric profile..."],
      });

      await fabricInstallMod.fabricInstallInner(
        taskId, target.path, versionName, mcVersionId,
        loaderVersion, source, threads
      );
      finalizeTaskHistory(taskId);
    } catch (e) {
      xgmclLog.writeLog("ERROR", `Fabric 任务异常: ${e.message}`);
      const t = dlMod.getTask(taskId);
      if (t) {
        t.error = e.message;
        t.active = false;
      }
      finalizeTaskHistory(taskId);
    }
  })();

  return { code: 200, msg: "Fabric 安装已开始", task_id: taskId };
}

module.exports = {
  mojangManifest,
  mojangCheckExists,
  mojangStart,
  downloadWorker,
  fabricInstall,
  fabricInstallInner,
};