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

// loaders/neoforge.js —— NeoForge loader（手动解析 installer）

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const dl = require("../download.js");
const xgmclLog = require("../xgmcl_log.js");
const processorMod = require("./processor.js");
xgmclLog.writeLog("INFO", `[NeoForge] processorMod 加载: ${typeof processorMod.runProcessors}, keys=${Object.keys(processorMod).join(",")}`);

const VERSIONS_API = "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";
const MAVEN_BASE = "https://maven.neoforged.net/releases/";

const cache = new Map();
const CACHE_TTL = 600 * 1000;

// MC 版本 → NeoForge 前缀
// 1.20.4 → "20.4"
// 1.21   → "21.0"
// 1.21.1 → "21.1"
function mcToNeoPrefix(mcVersion) {
  const parts = String(mcVersion).split(".");
  if (parts[0] !== "1") return null;
  const minor = parts[1];
  const patch = parts[2] || "0";
  const minorN = parseInt(minor, 10);
  const patchN = parseInt(patch, 10);
  if (isNaN(minorN) || isNaN(patchN)) return null;
  // NeoForge 从 1.20.2 开始
  if (minorN < 20 || (minorN === 20 && patchN < 2)) return null;
  return `${minor}.${patch}`;
}

// NeoForge 版本号排序用（把 -beta 当 0）
function parseVersion(v) {
  const parts = String(v).split("-")[0].split(".");
  return parts.map((x) => parseInt(x, 10) || 0);
}

function compareVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va !== vb) return vb - va;  // 降序
  }
  // 数字一样 → beta 排后面
  const aBeta = a.includes("-");
  const bBeta = b.includes("-");
  if (aBeta !== bBeta) return aBeta ? 1 : -1;
  return 0;
}

async function getJson(url, timeout = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLoaders(mcVersion) {
  if (!mcVersion) throw new Error("mc_version 不能为空");

  const prefix = mcToNeoPrefix(mcVersion);
  if (!prefix) {
    // 不支持（MC 低于 1.20.2）
    return [];
  }

  const now = Date.now();
  const cached = cache.get(prefix);
  if (cached && now - cached.ts < CACHE_TTL) return cached.data;

  const data = await getJson(VERSIONS_API);
  if (!data || !Array.isArray(data.versions)) {
    throw new Error("无法获取 NeoForge 版本列表");
  }

  const loaders = [];
  for (const v of data.versions) {
    if (v.startsWith(prefix + ".")) {
      loaders.push({
        version: v,
        stable: !v.includes("-"),
      });
    }
  }

  loaders.sort((a, b) => compareVersion(a.version, b.version));
  const result = loaders.slice(0, 5);
  cache.set(prefix, { ts: now, data: result });
  return result;
}

// 硬合并：把 NeoForge 的 version.json 合并到原版 json
function hardMerge(vanillaJson, neoforgeJson, loaderVersion, mcVersion) {
  const merged = JSON.parse(JSON.stringify(vanillaJson));

  // 去 inheritsFrom
  delete merged.inheritsFrom;

  // mainClass 用 NeoForge 的
  if (neoforgeJson.mainClass) merged.mainClass = neoforgeJson.mainClass;

  // libraries：NeoForge 的在前 + 原版在后
  const vanillaLibs = merged.libraries || [];
  const neoLibs = neoforgeJson.libraries || [];
  merged.libraries = neoLibs.concat(vanillaLibs);

  // arguments 合并
  const vArgs = merged.arguments || {};
  const nArgs = neoforgeJson.arguments || {};
  merged.arguments = {
    jvm: (nArgs.jvm || []).concat(vArgs.jvm || []),
    game: (nArgs.game || []).concat(vArgs.game || []),
  };

  // 标记
  merged.XGMCL_LOADER = "neoforge";
  merged.XGMCL_LOADER_VERSION = loaderVersion;
  merged.XGMCL_MC_VERSION = mcVersion;

  // 保留原版 id
  if (!merged.id) merged.id = mcVersion;

  return merged;
}

// 从 library 的 name 拼下载信息
// 返回 { url, path } 或 null
function libToDownload(lib) {
  const artifact = (lib.downloads || {}).artifact;
  if (artifact && artifact.url && artifact.path) {
    return {
      url: artifact.url,
      path: artifact.path,
      sha1: artifact.sha1 || "",
      size: artifact.size || 0,
    };
  }

  // 没 artifact：按 maven 结构拼
  const name = lib.name || "";
  if (!name || !name.includes(":")) return null;
  const parts = name.split(":");
  if (parts.length < 3) return null;
  const [group, aname, ver] = parts;
  const classifier = parts.length >= 4 ? "-" + parts[3] : "";
  const rel = `${group.replace(/\./g, "/")}/${aname}/${ver}/${aname}-${ver}${classifier}.jar`;

  // NeoForge 的库大多在 neoforged maven，少部分在 central
  let mavenBase = "https://repo1.maven.org/maven2/";
  if (group.startsWith("net.neoforged") || group.startsWith("net.minecraftforge")) {
    mavenBase = "https://maven.neoforged.net/releases/";
  }
  return {
    url: mavenBase + rel,
    path: rel,
    sha1: "",
    size: 0,
  };
}

async function install(taskId, rootPath, versionName, mcVersion, loaderVersion, source, threads) {
  function set(key, val) {
    const t = dl.getTask(taskId);
    if (t) t[key] = val;
  }
  function cancelled() {
    return dl.isTaskCancelled(taskId);
  }

  const verDir = path.join(rootPath, "versions", versionName);
  const jsonPath = path.join(verDir, `${versionName}.json`);

  let vanillaJson = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

  // 剥离旧 loader layer
  if (vanillaJson.XGMCL_LOADER) {
    const libs = vanillaJson.libraries || [];
    vanillaJson.libraries = libs.filter((l) => {
      const n = (l.name || "").toLowerCase();
      return !n.includes("fabric-loader") &&
             !n.includes("quilt-loader") &&
             !n.includes("forge") &&
             !n.includes("neoforge") &&
             !n.includes("bootstraplauncher") &&
             !n.includes("securejarhandler");
    });
    delete vanillaJson.XGMCL_LOADER;
    delete vanillaJson.XGMCL_LOADER_VERSION;
    delete vanillaJson.XGMCL_MC_VERSION;
    if (!vanillaJson.mainClass || vanillaJson.mainClass.toLowerCase().includes("neoforge")) {
      vanillaJson.mainClass = "net.minecraft.client.main.Main";
    }
  }

  // 1. 下载 installer jar
  set("current_files", [`下载 NeoForge installer ${loaderVersion}...`]);
  const installerUrl = `${MAVEN_BASE}net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
  const installerPath = path.join(verDir, `.neoforge-installer.jar`);

  xgmclLog.writeDownloadLog(`[NeoForge] 下载 installer: ${installerUrl}`);

  await dl.downloadOneFile({
    url: installerUrl,
    target: installerPath,
    sha1: "",
    size: 0,
    important: false,
  }, source, 5, taskId);

  if (cancelled()) {
    try { fs.unlinkSync(installerPath); } catch (_) {}
    set("active", false);
    return;
  }

  // 2. 从 installer 里读
  set("current_files", ["解析 installer..."]);
  xgmclLog.writeDownloadLog("[NeoForge] 解析 installer...");

  const zip = new AdmZip(installerPath);

  // install_profile.json
  let installProfile = null;
  try {
    const text = zip.readAsText("install_profile.json");
    installProfile = JSON.parse(text);
  } catch (e) {
    xgmclLog.writeDownloadLog(`[NeoForge] 读 install_profile.json 失败: ${e.message}`);
    throw new Error("installer 里没有 install_profile.json");
  }

  // version.json
  let neoVersionJson = null;
  try {
    const text = zip.readAsText("version.json");
    neoVersionJson = JSON.parse(text);
  } catch (e) {
    xgmclLog.writeDownloadLog(`[NeoForge] 读 version.json 失败: ${e.message}`);
    throw new Error("installer 里没有 version.json");
  }

  // 3. 硬合并
  xgmclLog.writeDownloadLog("[NeoForge] 硬合并 JSON");
  const merged = hardMerge(vanillaJson, neoVersionJson, loaderVersion, mcVersion);

  // 4. 收集所有 libraries
  const libsRoot = path.join(rootPath, "libraries");
  const files = [];
  const seenPaths = new Set();

  function addLib(lib) {
    const info = libToDownload(lib);
    if (!info) return;
    if (seenPaths.has(info.path)) return;
    seenPaths.add(info.path);
    files.push({
      url: dl.rewriteUrl(info.url, source),
      target: path.join(libsRoot, info.path.replace(/\//g, path.sep)),
      sha1: info.sha1,
      size: info.size,
      important: true,
    });
  }

  // install_profile.libraries
  for (const lib of installProfile.libraries || []) addLib(lib);
  // version.json.libraries
  for (const lib of neoVersionJson.libraries || []) addLib(lib);

  xgmclLog.writeDownloadLog(`[NeoForge] 需下载 ${files.length} 个库`);

  // 5. 统计 + 下载
  const total = files.reduce((s, f) => s + (f.size || 0), 0);
  set("total_bytes", total);
  set("files_total", files.length);
  set("current_files", []);

  dl.startSpeedUpdater(taskId);
  const failed = await dl.downloadBatch(files, source, threads, taskId);

  // 6. 写回 merged json
  if (!cancelled() && failed.length === 0) {
    fs.writeFileSync(jsonPath, JSON.stringify(merged, null, 2), "utf-8");
    xgmclLog.writeDownloadLog(`[NeoForge] 合并 JSON 已写回: ${jsonPath}`);
  }

  // 6.5 跑 processors（生成 client-extra.jar 等）
  if (!cancelled() && failed.length === 0) {
    set("current_files", ["跑 processor..."]);
    xgmclLog.writeDownloadLog("[NeoForge] 开始跑 processors");
    try {
      const clientJar = path.join(verDir, `${versionName}.jar`);
      await processorMod.runProcessors(taskId, installProfile, libsRoot, source, {
        minecraftJar: clientJar,
        installerJar: installerPath,
      });
      xgmclLog.writeDownloadLog("[NeoForge] processors 全部完成");
    } catch (e) {
      xgmclLog.writeDownloadLog(`[NeoForge] processors 失败: ${e.message}`);
      throw new Error(`processors 失败: ${e.message}`);
    }
  }

  // 7. 删 installer + 临时目录
  try { fs.unlinkSync(installerPath); } catch (_) {}
  try {
    const extractDir = path.join(verDir, ".neoforge-extracted");
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  } catch (_) {}

  // 8. 完成状态
  const t = dl.getTask(taskId);
  if (!t) return;
  if (t.cancel) {
    xgmclLog.writeDownloadLog("[NeoForge] 任务被取消，清理...");
    let cleaned = 0, removed = 0;
    for (const f of files) {
      try {
        const temp = f.target + ".part";
        if (fs.existsSync(temp)) { fs.unlinkSync(temp); cleaned++; }
      } catch (_) {}
      try {
        if (fs.existsSync(f.target)) { fs.unlinkSync(f.target); removed++; }
      } catch (_) {}
    }
    xgmclLog.writeDownloadLog(`[NeoForge] 清理: ${cleaned} 个 .part, ${removed} 个已下文件`);
    t.active = false;
  } else if (failed.length) {
    t.error = `${failed.length} 个库下载失败`;
    t.active = false;
  } else {
    t.done = true;
    t.active = false;
  }
}

module.exports = {
  id: "neoforge",
  name: "NeoForge",
  fetchLoaders,
  install,
};