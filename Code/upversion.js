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

// upversion.js —— 一键升级（新建目标版本 + 升级 mods）

const fs = require("fs");
const path = require("path");
const cfgMod = require("./config.js");
const dl = require("./download.js");
const mojangMod = require("./mojang.js");
const modsMod = require("./mods.js");
const modrinthMod = require("./modrinth.js");
const fabricInstallMod = require("./fabric_install.js");
const xgmclLog = require("./xgmcl_log.js");

// 缓存：(mod_id|slug, mc, loader) → info | null
const resolveCache = new Map();

// 查一个 mod 在目标 MC + loader 下有没有可用版本
async function resolveModrinth(modId, slug, mcVersion, loader) {
  const key = `${modId || slug || ""}|${mcVersion}|${loader}`;
  if (resolveCache.has(key)) return resolveCache.get(key);

  let result = null;
  try {
    let realSlug = slug;

    if (!realSlug && modId) {
      const hits = await modrinthMod.search(modId, 5, 0, mcVersion, loader);
      for (const h of (hits.hits || [])) {
        const title = (h.title || "").toLowerCase();
        const slug2 = (h.slug || "").toLowerCase();
        if (modId.toLowerCase() === slug2 || title.includes(modId.toLowerCase())) {
          realSlug = h.slug || "";
          break;
        }
      }
      if (!realSlug && hits.hits && hits.hits.length) {
        realSlug = hits.hits[0].slug || "";
      }
    }

    if (realSlug) {
      const versions = await modrinthMod.getProjectVersions(realSlug, mcVersion, loader);
      for (const v of versions) {
        const f = modrinthMod.pickPrimaryFile(v.files || []);
        if (!f) continue;
        result = {
          url: f.url || "",
          filename: f.filename || "",
          sha1: (f.hashes || {}).sha1 || "",
          size: f.size || 0,
          modrinth_version: v.version_number || "",
        };
        break;
      }
    }
  } catch (e) {
    xgmclLog.writeLog("WARN", `升级 mod 查询失败 ${modId || slug}: ${e.message}`);
    result = null;
  }

  resolveCache.set(key, result);
  return result;
}

// 主 worker
async function upversionWorker(taskId, rootPath, sourceVersion, targetMc,
                               targetLoader, targetName, fabricLoader,
                               source, threads, copyOptions) {
  function set(key, val) {
    const t = dl.getTask(taskId);
    if (t) t[key] = val;
  }

  function cancelled() {
    return dl.isTaskCancelled(taskId);
  }

  function incr(key, delta) {
    const t = dl.getTask(taskId);
    if (t) t[key] = (t[key] || 0) + delta;
  }

  try {
    // ===== 阶段 1：下载原版 =====
    set("stage", 1);
    set("stage_total", 4);
    set("current_files", [`下载原版 ${targetMc}...`]);
    set("upgrade_result", null);

    xgmclLog.writeDownloadLog(`[UpVersion] 获取 manifest 找 ${targetMc}`);
    const mf = await mojangMod.fetchManifest(source);
    let mcVersionUrl = "";
    for (const v of mf.versions || []) {
      if (v.id === targetMc) {
        mcVersionUrl = v.url || "";
        break;
      }
    }
    if (!mcVersionUrl) throw new Error(`未找到 MC ${targetMc} 的版本信息`);

    const versionDir = path.join(rootPath, "versions", targetName);
    if (fs.existsSync(versionDir)) throw new Error(`目标版本名已存在: ${targetName}`);

    // 子任务
    const subTaskId = dl.createTask({
      task_name: targetName,
      task_type: "vanilla",
      root_path: rootPath,
      mc_version: targetMc,
      source,
      threads,
    });

    xgmclLog.writeDownloadLog(`[UpVersion] 起子任务下原版: ${subTaskId}`);

    const subPromise = mojangMod.startDownload(
      rootPath, targetName, targetMc, mcVersionUrl,
      source, threads, subTaskId
    );

    // 轮询子任务，同步进度
    let pollCount = 0;
    const syncInterval = setInterval(() => {
      if (cancelled()) {
        dl.setTaskField(subTaskId, "cancel", true);
      }
      const sub = dl.getTask(subTaskId);
      if (!sub) return;
      const t = dl.getTask(taskId);
      if (!t) return;

      if (sub.total_bytes > 0) t.total_bytes = sub.total_bytes;
      t.downloaded_bytes = sub.downloaded_bytes || 0;
      t.speed = sub.speed || 0;
      t.files_done = sub.files_done || 0;
      t.files_total = sub.files_total || 0;
      t.current_files = sub.current_files || [];

      pollCount++;
      if (pollCount % 20 === 0) {
        xgmclLog.writeDownloadLog(
          `[UpVersion] 轮询子任务: tb=${sub.total_bytes} db=${sub.downloaded_bytes} ` +
          `files=${sub.files_done}/${sub.files_total}`
        );
      }
    }, 500);

    await subPromise;
    clearInterval(syncInterval);

    const sub = dl.getTask(subTaskId);
    if (!sub || !sub.done) {
      const err = (sub && sub.error) || "原版下载失败";
      throw new Error(err);
    }

    if (cancelled()) {
      set("active", false);
      return;
    }

    xgmclLog.writeDownloadLog("[UpVersion] 原版下载完成");

    // ===== 阶段 2：装 Fabric =====
    set("stage", 2);
    set("current_files", [`安装 Fabric ${fabricLoader}...`]);
    xgmclLog.writeDownloadLog(`[UpVersion] 安装 Fabric ${fabricLoader}`);

    Object.assign(dl.getTask(taskId), {
      total_bytes: 0, downloaded_bytes: 0, files_done: 0, files_total: 0,
    });

    await fabricInstallMod.fabricInstallInner(
      taskId, rootPath, targetName, targetMc,
      fabricLoader, source, threads
    );

    const t2 = dl.getTask(taskId);
    if (!t2 || !t2.done || t2.error) {
      throw new Error("Fabric 安装失败");
    }

    if (cancelled()) {
      set("active", false);
      return;
    }

    xgmclLog.writeDownloadLog("[UpVersion] Fabric 安装完成");

    // ===== 阶段 3：扫描源 mods =====
    set("stage", 3);
    set("done", false);
    set("active", true);
    set("current_files", ["扫描源版本 mods..."]);

    const srcIsolated = cfgMod.getVersionIsolated(rootPath, sourceVersion);
    let srcModsDir, srcGameDir;
    if (srcIsolated) {
      srcModsDir = path.join(rootPath, "versions", sourceVersion, "mods");
      srcGameDir = path.join(rootPath, "versions", sourceVersion);
    } else {
      srcModsDir = path.join(rootPath, "mods");
      srcGameDir = rootPath;
    }

    const newVerDir = path.join(rootPath, "versions", targetName);
    const newModsDir = path.join(newVerDir, "mods");
    fs.mkdirSync(newModsDir, { recursive: true });

    const modFiles = [];
    if (fs.existsSync(srcModsDir)) {
      for (const fn of fs.readdirSync(srcModsDir)) {
        if (fn.endsWith(".jar") || fn.endsWith(".jar.disabled")) {
          const full = path.join(srcModsDir, fn);
          try {
            if (fs.statSync(full).isFile()) modFiles.push(fn);
          } catch (_) {}
        }
      }
    }

    xgmclLog.writeDownloadLog(`[UpVersion] 源版本共 ${modFiles.length} 个 mod`);

    set("files_total", modFiles.length);
    set("files_done", 0);
    set("total_bytes", modFiles.length * 5 * 1024 * 1024);
    set("downloaded_bytes", 0);

    // ===== 阶段 4：并行升级 =====
    set("stage", 4);

    const upgraded = [];
    const failed = [];

    let doneCount = 0;
    const MAX_WORKERS = 5;
    let index = 0;

    async function processOne(fn) {
      if (cancelled()) return;

      const srcPath = path.join(srcModsDir, fn);

      let meta;
      try {
        meta = modsMod.readJarMeta(srcPath);
      } catch (e) {
        failed.push({ filename: fn, mod_id: "", reason: `读取 jar 失败: ${e.message.slice(0, 60)}` });
        doneCount++;
        set("files_done", doneCount);
        return;
      }

      const modId = meta.mod_id || "";
      const slug = meta.slug || "";

      const info = await resolveModrinth(modId, slug, targetMc, targetLoader);

      if (!info) {
        failed.push({
          filename: fn,
          mod_id: modId,
          reason: (modId || slug) ? "Modrinth 上没有对应版本" : "无法识别 Mod ID",
        });
        doneCount++;
        set("files_done", doneCount);
        return;
      }

      const wasDisabled = fn.endsWith(".jar.disabled");
      let newFilename = info.filename;
      if (wasDisabled && !newFilename.endsWith(".disabled")) newFilename += ".disabled";

      const targetPath = path.join(newModsDir, newFilename);

      try {
        xgmclLog.writeDownloadLog(
          `[UpVersion] 下载 mod: ${fn} → ${newFilename} (v${info.modrinth_version})`
        );
        await dl.downloadOneFile({
          url: info.url,
          target: targetPath,
          sha1: info.sha1,
          size: info.size,
          important: false,
        }, source, 3, taskId);

        try {
          await modsMod.autoWriteMetaAfterDownload(targetPath);
        } catch (e) {
          xgmclLog.writeLog("WARN", `升级后写元数据失败: ${e.message}`);
        }

        upgraded.push({
          old_filename: fn,
          new_filename: newFilename,
          mod_id: modId,
          modrinth_version: info.modrinth_version || "",
          title_cn: "",
        });
      } catch (e) {
        failed.push({ filename: fn, mod_id: modId, reason: `下载失败: ${e.message.slice(0, 80)}` });
      }

      doneCount++;
      set("files_done", doneCount);
    }

    async function worker() {
      while (true) {
        if (cancelled()) return;
        const i = index++;
        if (i >= modFiles.length) return;
        await processOne(modFiles[i]);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(MAX_WORKERS, modFiles.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    xgmclLog.writeDownloadLog(
      `[UpVersion] Mod 升级完成：成功 ${upgraded.length}，失败 ${failed.length}`
    );

    // ===== 可选复制 =====
    if (copyOptions.copy_config) {
      set("current_files", ["复制 config..."]);
      try {
        const srcCfg = path.join(srcGameDir, "config");
        const dstCfg = path.join(newVerDir, "config");
        if (fs.existsSync(srcCfg)) {
          copyDir(srcCfg, dstCfg);
          xgmclLog.writeDownloadLog("[UpVersion] config 复制完成");
        }
      } catch (e) {
        xgmclLog.writeLog("WARN", `复制 config 失败: ${e.message}`);
      }
    }

    if (copyOptions.copy_resourcepacks) {
      set("current_files", ["复制 resourcepacks..."]);
      try {
        const srcRp = path.join(srcGameDir, "resourcepacks");
        const dstRp = path.join(newVerDir, "resourcepacks");
        if (fs.existsSync(srcRp)) {
          copyDir(srcRp, dstRp);
          xgmclLog.writeDownloadLog("[UpVersion] resourcepacks 复制完成");
        }
      } catch (e) {
        xgmclLog.writeLog("WARN", `复制 resourcepacks 失败: ${e.message}`);
      }
    }

    if (copyOptions.copy_shaderpacks) {
      set("current_files", ["复制 shaderpacks..."]);
      try {
        const srcSp = path.join(srcGameDir, "shaderpacks");
        const dstSp = path.join(newVerDir, "shaderpacks");
        if (fs.existsSync(srcSp)) {
          copyDir(srcSp, dstSp);
          xgmclLog.writeDownloadLog("[UpVersion] shaderpacks 复制完成");
        }
      } catch (e) {
        xgmclLog.writeLog("WARN", `复制 shaderpacks 失败: ${e.message}`);
      }
    }

    // ===== 完成 =====
    const t = dl.getTask(taskId);
    if (t) {
      t.upgrade_result = {
        target_name: targetName,
        target_mc: targetMc,
        target_loader: targetLoader,
        total: modFiles.length,
        upgraded,
        failed,
      };
      t.done = true;
      t.active = false;
      t.current_files = [];
    }
  } catch (e) {
    xgmclLog.writeDownloadLog(`[UpVersion] 失败: ${e.message}\n${e.stack || ""}`);
    xgmclLog.writeLog("ERROR", `升级任务失败: ${e.message}`);
    const t = dl.getTask(taskId);
    if (t) {
      t.error = e.message;
      t.active = false;
    }
  }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

module.exports = { upversionWorker };