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

// modpack.js —— 整合包导入 / 导出（Modrinth + MCBBS）

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const AdmZip = require("adm-zip");
const dl = require("./download.js");
const xgmclLog = require("./xgmcl_log.js");
const loadersMod = require("./loaders/index.js");
const mojangMod = require("./mojang.js");

// ============ 格式探测 ============

// 返回 { format: "modrinth" | "mcbbs" | null, meta: {...} }
function detectFormat(zipPath) {
  if (!fs.existsSync(zipPath)) {
    throw new Error(`文件不存在: ${zipPath}`);
  }

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().map((e) => e.entryName);

  // Modrinth: 有 modrinth.index.json
  if (entries.includes("modrinth.index.json")) {
    try {
      const text = zip.readAsText("modrinth.index.json");
      const meta = JSON.parse(text);
      return { format: "modrinth", meta };
    } catch (e) {
      throw new Error(`解析 modrinth.index.json 失败: ${e.message}`);
    }
  }

  // MCBBS: 有 mcbbs.packmeta
  if (entries.includes("mcbbs.packmeta")) {
    try {
      const text = zip.readAsText("mcbbs.packmeta");
      const meta = JSON.parse(text);
      return { format: "mcbbs", meta };
    } catch (e) {
      throw new Error(`解析 mcbbs.packmeta 失败: ${e.message}`);
    }
  }

  // 未知
  return { format: null, meta: null };
}

// ============ Modrinth 解析 ============

// modrinth.index.json 结构：
// {
//   "formatVersion": 1,
//   "game": "minecraft",
//   "versionId": "xxx",
//   "name": "整合包名",
//   "summary": "...",
//   "files": [
//     {
//       "path": "mods/sodium.jar",
//       "hashes": { "sha1": "...", "sha512": "..." },
//       "env": { "client": "required", "server": "unsupported" },
//       "downloads": ["https://cdn.modrinth.com/..."],
//       "fileSize": 123456
//     },
//     ...
//   ],
//   "dependencies": {
//     "minecraft": "1.20.1",
//     "fabric-loader": "0.15.11",
//     "quilt-loader": "...",
//     "forge": "...",
//     "neoforge": "..."
//   }
// }

function parseModrinthIndex(meta) {
  const deps = meta.dependencies || {};

  let loaderType = null;
  let loaderVersion = "";
  if (deps["fabric-loader"]) {
    loaderType = "fabric";
    loaderVersion = deps["fabric-loader"];
  } else if (deps["quilt-loader"]) {
    loaderType = "quilt";
    loaderVersion = deps["quilt-loader"];
  } else if (deps["neoforge"]) {
    loaderType = "neoforge";
    loaderVersion = deps["neoforge"];
  } else if (deps["forge"]) {
    throw new Error("暂不支持 Forge 整合包");
  }

  return {
    name: meta.name || "未命名整合包",
    version: meta.versionId || "1.0",
    mcVersion: deps.minecraft || "",
    loaderType,
    loaderVersion,
    files: (meta.files || []).map((f) => ({
      path: f.path || "",
      url: (f.downloads || [])[0] || "",
      sha1: (f.hashes || {}).sha1 || "",
      sha512: (f.hashes || {}).sha512 || "",
      size: f.fileSize || 0,
      env: f.env || null,
    })),
  };
}

// ============ MCBBS 解析 ============
// 等你样本后再补，现在是占位

function parseMcbbsMeta(meta) {
  throw new Error("MCBBS 整合包暂未支持（等样本）");
}

// ============ 导入主流程 ============

// 返回 { name, mcVersion, loaderType, loaderVersion, versionName }
async function importModpack(taskId, zipPath, rootPath, overrideVersionName) {
  function set(key, val) {
    const t = dl.getTask(taskId);
    if (t) t[key] = val;
  }
  function cancelled() {
    return dl.isTaskCancelled(taskId);
  }

  // 1. 探测格式
  set("current_files", ["解析整合包..."]);
  xgmclLog.writeDownloadLog(`[Modpack] 解析: ${zipPath}`);

  const detected = detectFormat(zipPath);
  if (!detected.format) {
    throw new Error("无法识别的整合包格式（不是 Modrinth 也不是 MCBBS）");
  }
  xgmclLog.writeDownloadLog(`[Modpack] 格式: ${detected.format}`);

  let parsed;
  if (detected.format === "modrinth") {
    parsed = parseModrinthIndex(detected.meta);
  } else if (detected.format === "mcbbs") {
    parsed = parseMcbbsMeta(detected.meta);
  }

  if (!parsed.mcVersion) {
    throw new Error("整合包没有指定 Minecraft 版本");
  }

  xgmclLog.writeDownloadLog(
    `[Modpack] MC=${parsed.mcVersion}, loader=${parsed.loaderType || "无"}, ` +
    `loaderVer=${parsed.loaderVersion || "无"}, 文件数=${parsed.files.length}`
  );

  // 2. 定版本名
  let versionName = overrideVersionName || "";
  if (!versionName) {
    // 从整合包名生成：<name>-<version>
    versionName = parsed.name;
    if (parsed.version && parsed.version !== "1.0") {
      versionName += "-" + parsed.version;
    }
    // 去掉非法字符
    versionName = versionName.replace(/[<>:"/\\|?*]/g, "_");
  }

  xgmclLog.writeDownloadLog(`[Modpack] 版本名: ${versionName}`);

  // 3. 检查目标目录
  const verDir = path.join(rootPath, "versions", versionName);
  if (fs.existsSync(verDir)) {
    throw new Error(`版本已存在: ${versionName}`);
  }

  // 4. 下载原版 MC
  set("current_files", [`下载原版 ${parsed.mcVersion}...`]);
  xgmclLog.writeDownloadLog(`[Modpack] 下载原版 MC ${parsed.mcVersion}`);

  const mf = await mojangMod.fetchManifest("bmclapi");
  let mcVersionUrl = "";
  for (const v of mf.versions || []) {
    if (v.id === parsed.mcVersion) {
      mcVersionUrl = v.url || "";
      break;
    }
  }
  if (!mcVersionUrl) {
    throw new Error(`找不到 MC ${parsed.mcVersion}`);
  }

  // 起子任务
  const subTaskId = dl.createTask({
    task_name: versionName + " (原版)",
    task_type: "vanilla",
    root_path: rootPath,
    mc_version: parsed.mcVersion,
    source: "bmclapi",
    threads: 8,
  });

  const subPromise = mojangMod.startDownload(
    rootPath, versionName, parsed.mcVersion, mcVersionUrl,
    "bmclapi", 8, subTaskId
  );

  // 同步子任务进度
  const syncInterval = setInterval(() => {
    if (cancelled()) {
      dl.setTaskField(subTaskId, "cancel", true);
    }
    const sub = dl.getTask(subTaskId);
    const t = dl.getTask(taskId);
    if (!sub || !t) return;
    if (sub.total_bytes > 0) t.total_bytes = sub.total_bytes;
    t.downloaded_bytes = sub.downloaded_bytes || 0;
    t.speed = sub.speed || 0;
    t.files_done = sub.files_done || 0;
    t.files_total = sub.files_total || 0;
    t.current_files = sub.current_files || [];
  }, 500);

  await subPromise;
  clearInterval(syncInterval);

  if (cancelled()) {
    set("active", false);
    return { versionName };
  }

  const sub = dl.getTask(subTaskId);
  if (!sub || !sub.done) {
    throw new Error("原版下载失败: " + ((sub && sub.error) || "未知错误"));
  }

  xgmclLog.writeDownloadLog("[Modpack] 原版下载完成");

  // 5. 装 loader
  if (parsed.loaderType) {
    set("current_files", [`安装 ${parsed.loaderType}...`]);
    xgmclLog.writeDownloadLog(`[Modpack] 安装 ${parsed.loaderType}`);

    const loader = loadersMod.getLoader(parsed.loaderType);
    if (!loader) {
      throw new Error(`不支持的 loader: ${parsed.loaderType}`);
    }

    // 如果 loader 版本为空，拉最新
    let loaderVersion = parsed.loaderVersion;
    if (!loaderVersion) {
      const loaders = await loader.fetchLoaders(parsed.mcVersion);
      if (loaders.length === 0) {
        throw new Error(`无法获取 ${parsed.loaderType} 版本（MC ${parsed.mcVersion}）`);
      }
      loaderVersion = loaders[0].version;
      xgmclLog.writeDownloadLog(`[Modpack] 自动选 ${parsed.loaderType} 版本: ${loaderVersion}`);
    }

    // 重置进度
    Object.assign(dl.getTask(taskId), {
      total_bytes: 0, downloaded_bytes: 0,
      files_done: 0, files_total: 0,
    });

    await loader.install(
      taskId, rootPath, versionName, parsed.mcVersion,
      loaderVersion, "bmclapi", 8
    );

    const t2 = dl.getTask(taskId);
    if (!t2 || !t2.done || t2.error) {
      throw new Error(`${parsed.loaderType} 安装失败`);
    }

    xgmclLog.writeDownloadLog(`[Modpack] ${parsed.loaderType} 安装完成`);
  }

  // 6. 下载整合包里的文件
  set("current_files", ["下载整合包文件..."]);
  xgmclLog.writeDownloadLog(`[Modpack] 下载 ${parsed.files.length} 个文件`);

  const fileList = parsed.files.map((f) => ({
    url: f.url,
    target: path.join(verDir, f.path.replace(/\//g, path.sep)),
    sha1: f.sha1,
    size: f.size,
    important: false,
  }));

  const totalSize = fileList.reduce((s, f) => s + (f.size || 0), 0);
  Object.assign(dl.getTask(taskId), {
    total_bytes: totalSize,
    downloaded_bytes: 0,
    actual_downloaded_bytes: 0,
    skipped_bytes: 0,
    files_total: fileList.length,
    files_done: 0,
    files_skipped: 0,
    files_downloaded: 0,
  });

  dl.startSpeedUpdater(taskId);
  const failed = await dl.downloadBatch(fileList, "official", 8, taskId);

  xgmclLog.writeDownloadLog(
    `[Modpack] 整合包文件下载完成：失败 ${failed.length} 个`
  );

  if (failed.length > 0) {
    xgmclLog.writeDownloadLog("[Modpack] 失败列表（前 10 个）:");
    for (const ff of failed.slice(0, 10)) {
      xgmclLog.writeDownloadLog(`  - ${ff.path}: ${ff.error}`);
    }
  }

  // 7. 解压 overrides（如果有）
  xgmclLog.writeDownloadLog("[Modpack] 解压 overrides...");
  const zip = new AdmZip(zipPath);
  let overrideCount = 0;
  for (const entry of zip.getEntries()) {
    const name = entry.entryName;
    if (name.startsWith("overrides/")) {
      if (entry.isDirectory) continue;
      const rel = name.slice("overrides/".length);
      if (!rel) continue;
      const target = path.join(verDir, rel.replace(/\//g, path.sep));
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.getData());
        overrideCount++;
      } catch (e) {
        xgmclLog.writeDownloadLog(`[Modpack] overrides 解压失败 ${rel}: ${e.message}`);
      }
    }
    // 有些整合包用 client-overrides/
    if (name.startsWith("client-overrides/")) {
      if (entry.isDirectory) continue;
      const rel = name.slice("client-overrides/".length);
      if (!rel) continue;
      const target = path.join(verDir, rel.replace(/\//g, path.sep));
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.getData());
        overrideCount++;
      } catch (e) {
        xgmclLog.writeDownloadLog(`[Modpack] client-overrides 解压失败 ${rel}: ${e.message}`);
      }
    }
  }
  xgmclLog.writeDownloadLog(`[Modpack] overrides 解压 ${overrideCount} 个文件`);

  // 8. 完成
  const t = dl.getTask(taskId);
  if (t) {
    if (cancelled()) {
      t.active = false;
    } else if (failed.length > 0) {
      t.error = `${failed.length} 个文件下载失败`;
      t.active = false;
    } else {
      t.done = true;
      t.active = false;
    }
  }

  return {
    versionName,
    mcVersion: parsed.mcVersion,
    loaderType: parsed.loaderType,
    loaderVersion: parsed.loaderVersion,
  };
}

// ============ 导出主流程 ============

// 导出为 .mrpack
// 步骤：
//   1. 扫描版本的 mods/，逐个算 sha1 / sha512
//   2. 查 Modrinth 的 version_file 拿 project_id + url
//   3. 能找到 → 写进 files；找不到 → 写进 overrides/ 打包
//   4. 生成 modrinth.index.json
//   5. 打包成 .mrpack

async function exportModpack(taskId, versionDir, versionName, mcVersion, loaderType, loaderVersion, outputPath, opts) {
  opts = opts || {};
  function set(key, val) {
    const t = dl.getTask(taskId);
    if (t) t[key] = val;
  }
  function cancelled() {
    return dl.isTaskCancelled(taskId);
  }

  const modrinthMod = require("./modrinth.js");

  // 1. 扫 mods
  set("current_files", ["扫描 mods..."]);
  const modsDir = path.join(versionDir, "mods");
  const files = [];      // 记 URL，不打进 zip
  const overrides = [];  // 打包进 zip

  if (fs.existsSync(modsDir)) {
    const modFiles = fs.readdirSync(modsDir).filter((f) => f.endsWith(".jar"));
    xgmclLog.writeDownloadLog(`[Modpack] 扫描 ${modFiles.length} 个 mod`);

    // 算 hash
    for (let i = 0; i < modFiles.length; i++) {
      if (cancelled()) break;
      const fn = modFiles[i];
      const full = path.join(modsDir, fn);
      set("current_files", [`计算 hash ${fn} (${i+1}/${modFiles.length})`]);

      try {
        const buf = fs.readFileSync(full);
        const sha1 = crypto.createHash("sha1").update(buf).digest("hex");
        const sha512 = crypto.createHash("sha512").update(buf).digest("hex");
        overrides.push({
          filename: fn,
          full,
          sha1,
          sha512,
          size: buf.length,
          content: buf,
        });
      } catch (e) {
        xgmclLog.writeDownloadLog(`[Modpack] 读 ${fn} 失败: ${e.message}`);
      }
    }
  }

  // 2. 批量查 Modrinth
  set("current_files", ["查询 Modrinth..."]);
  const hashList = overrides.map((o) => o.sha512);
  let hashMap = {};
  if (hashList.length > 0) {
    try {
      const raw = await modrinthMod.versionsFromHashes(hashList);
      hashMap = raw || {};
    } catch (e) {
      xgmclLog.writeDownloadLog(`[Modpack] 哈希反查失败: ${e.message}`);
    }
  }

  // 3. 分拣
  const fileEntries = [];
  const overrideEntries = [];

  for (const o of overrides) {
    const info = hashMap[o.sha512];
    if (info && info.files && info.files.length > 0) {
      // 找主文件
      let primary = null;
      for (const f of info.files) {
        if (f.primary) { primary = f; break; }
      }
      if (!primary) primary = info.files[0];

      if (primary && primary.url) {
        // 能找到 → 记 URL，不打进 zip
        fileEntries.push({
          path: "mods/" + o.filename,
          hashes: { sha1: primary.hashes.sha1, sha512: primary.hashes.sha512 },
          downloads: [primary.url],
          fileSize: primary.size,
        });
        continue;
      }
    }

    // 找不到 → 打包进 overrides
    overrideEntries.push(o);
  }

  xgmclLog.writeDownloadLog(
    `[Modpack] ${fileEntries.length} 个来自 Modrinth，${overrideEntries.length} 个打包进 overrides`
  );

  // 4. 扫其他目录（config / resourcepacks / shaderpacks / saves 等）
  set("current_files", ["扫描其他目录..."]);
  const otherDirs = ["config", "defaultconfigs"];
  if (opts.includeResourcepacks) otherDirs.push("resourcepacks");
  if (opts.includeShaderpacks) otherDirs.push("shaderpacks");
  for (const sub of otherDirs) {
    const dir = path.join(versionDir, sub);
    if (!fs.existsSync(dir)) continue;

    const walk = (d, relBase) => {
      for (const name of fs.readdirSync(d)) {
        const full = path.join(d, name);
        const rel = path.join(relBase, name).replace(/\\/g, "/");
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          walk(full, rel);
        } else {
          try {
            overrideEntries.push({
              filename: rel,
              full,
              content: fs.readFileSync(full),
            });
          } catch (_) {}
        }
      }
    };
    walk(dir, sub);
  }

  // 5. 生成 modrinth.index.json
  set("current_files", ["生成 index..."]);
  if (fileEntries.length === 0 && overrideEntries.length === 0) {
    const t = dl.getTask(taskId);
    if (t) { t.error = "没有可导出的内容（mods 为空）"; t.active = false; }
    xgmclLog.writeDownloadLog("[Modpack] 导出失败：mods 为空");
    return { outputPath: "" };
  }
  const index = {
    formatVersion: 1,
    game: "minecraft",
    versionId: versionName,
    name: versionName,
    summary: "",
    files: fileEntries,
    dependencies: {
      minecraft: mcVersion,
    },
  };

  if (loaderType === "fabric") {
    index.dependencies["fabric-loader"] = loaderVersion;
  } else if (loaderType === "quilt") {
    index.dependencies["quilt-loader"] = loaderVersion;
  } else if (loaderType === "neoforge") {
    index.dependencies["neoforge"] = loaderVersion;
  } else if (loaderType === "forge") {
    index.dependencies["forge"] = loaderVersion;
  }

  // 6. 打包
  set("current_files", ["打包中..."]);
  xgmclLog.writeDownloadLog(`[Modpack] 打包 → ${outputPath}`);

  const outZip = new AdmZip();

  // 加 modrinth.index.json
  outZip.addFile("modrinth.index.json", Buffer.from(JSON.stringify(index, null, 2), "utf-8"));

  // 加 overrides/
  for (const o of overrideEntries) {
    outZip.addFile("overrides/" + o.filename.replace(/\\/g, "/"), o.content);
  }

  outZip.writeZip(outputPath);

  // 7. 完成
  const t = dl.getTask(taskId);
  if (t) {
    if (cancelled()) {
      t.active = false;
    } else {
      t.done = true;
      t.active = false;
    }
  }

  xgmclLog.writeDownloadLog(`[Modpack] 导出完成: ${outputPath}`);

  return { outputPath };
}

module.exports = {
  detectFormat,
  parseModrinthIndex,
  importModpack,
  exportModpack,
};