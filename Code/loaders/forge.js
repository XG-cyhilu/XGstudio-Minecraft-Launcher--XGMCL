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

// loaders/forge.js —— Forge loader（手动解析 installer，支持 1.20.2+）

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const dl = require("../download.js");
const xgmclLog = require("../xgmcl_log.js");
const processorMod = require("./processor.js");

const INDEX_URL = "https://files.minecraftforge.net/net/minecraftforge/forge";
const MAVEN_BASE = "https://maven.minecraftforge.net/";

const cache = new Map();
const CACHE_TTL = 600 * 1000;

// MC 版本比较，判断是否 >= 1.20.2
function mcAtLeast1202(mcVersion) {
  const parts = String(mcVersion).split(".").map((x) => parseInt(x, 10) || 0);
  const [major, minor, patch] = [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  if (major !== 1) return major > 1;
  if (minor !== 20) return minor > 20;
  return patch >= 2;
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

async function getText(url, timeout = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 从 "1.21.1-52.0.5" 里拆出 forge 版本 "52.0.5"
function forgeVerOnly(fullVersion, mcVersion) {
  const prefix = mcVersion + "-";
  if (fullVersion.startsWith(prefix)) return fullVersion.slice(prefix.length);
  return fullVersion;
}

// 版本排序（降序）
function compareForgeVer(a, b) {
  const pa = String(a).split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va !== vb) return vb - va;
  }
  return 0;
}

async function fetchLoaders(mcVersion) {
  if (!mcVersion) throw new Error("mc_version 不能为空");

  // 只支持 1.20.2+
  if (!mcAtLeast1202(mcVersion)) {
    return [];
  }

  const now = Date.now();
  const cached = cache.get(mcVersion);
  if (cached && now - cached.ts < CACHE_TTL) return cached.data;

  // 用 maven-metadata.xml（files.minecraftforge.net 被 Cloudflare 挡了）
  const url = `${MAVEN_BASE}net/minecraftforge/forge/maven-metadata.xml`;
  const xml = await getText(url);
  if (!xml) {
    throw new Error(`无法获取 Forge 版本列表（MC ${mcVersion}）`);
  }

  // 简单 XML 解析：抽 <version>xxx</version>
  const versions = [];
  const re = /<version>([^<]+)<\/version>/g;
  let m;
  const prefix = mcVersion + "-";
  while ((m = re.exec(xml)) !== null) {
    const full = m[1];
    if (full.startsWith(prefix)) {
      versions.push(full);
    }
  }

  if (versions.length === 0) {
    return [];
  }

  versions.sort((a, b) => compareForgeVer(a, b));

  const loaders = [];
  for (const full of versions) {
    const forgeVer = forgeVerOnly(full, mcVersion);
    loaders.push({
      version: forgeVer,
      full_version: full,
      stable: !forgeVer.includes("beta"),
    });
    if (loaders.length >= 10) break;
  }

  const result = loaders.slice(0, 5);
  cache.set(mcVersion, { ts: now, data: result });
  return result;
}

// 硬合并
function hardMerge(vanillaJson, forgeJson, loaderVersion, mcVersion) {
  const merged = JSON.parse(JSON.stringify(vanillaJson));

  delete merged.inheritsFrom;

  if (forgeJson.mainClass) merged.mainClass = forgeJson.mainClass;

  const vanillaLibs = merged.libraries || [];
  const forgeLibs = forgeJson.libraries || [];
  merged.libraries = forgeLibs.concat(vanillaLibs);

  const vArgs = merged.arguments || {};
  const fArgs = forgeJson.arguments || {};
  merged.arguments = {
    jvm: (fArgs.jvm || []).concat(vArgs.jvm || []),
    game: (fArgs.game || []).concat(vArgs.game || []),
  };

  merged.XGMCL_LOADER = "forge";
  merged.XGMCL_LOADER_VERSION = loaderVersion;
  merged.XGMCL_MC_VERSION = mcVersion;

  if (!merged.id) merged.id = mcVersion;

  return merged;
}

// library → 下载信息
function libToDownload(lib) {
  const name = lib.name || "";

  // 跳过 forge-client.jar，由 processor 生成，不在 maven
  if (name.match(/^net\.minecraftforge:forge:[^:]+:client$/)) {
    xgmclLog.writeDownloadLog(`[Forge] 跳过 processor 生成库: ${name}`);
    return null;
  }

  const artifact = (lib.downloads || {}).artifact;
  if (artifact && artifact.url && artifact.path) {
    xgmclLog.writeDownloadLog(`[Forge-DEBUG] lib=${name} → artifact.url=${artifact.url}`);
    return {
      url: artifact.url,
      path: artifact.path,
      sha1: artifact.sha1 || "",
      size: artifact.size || 0,
    };
  }

  if (!name || !name.includes(":")) return null;
  const parts = name.split(":");
  if (parts.length < 3) return null;
  const [group, aname, ver] = parts;
  const classifier = parts.length >= 4 ? "-" + parts[3] : "";
  const rel = `${group.replace(/\./g, "/")}/${aname}/${ver}/${aname}-${ver}${classifier}.jar`;

  // Forge 的库大多在 minecraftforge maven，少量在 central
  let mavenBase = "https://repo1.maven.org/maven2/";
  if (
    group.startsWith("net.minecraftforge") ||
    group.startsWith("net.minecraft") ||
    group.startsWith("cpw.mods") ||
    group.startsWith("com.electronwill.night-config")
  ) {
    mavenBase = MAVEN_BASE;
  }
  const url = mavenBase + rel;
  xgmclLog.writeDownloadLog(`[Forge-DEBUG] lib=${name} → fallback.url=${url}`);
  return {
    url,
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
    if (!vanillaJson.mainClass || vanillaJson.mainClass.toLowerCase().includes("forge")) {
      vanillaJson.mainClass = "net.minecraft.client.main.Main";
    }
  }

  // 1. 下载 installer
  set("current_files", [`下载 Forge installer ${loaderVersion}...`]);
  const fullVersion = `${mcVersion}-${loaderVersion}`;
  const installerUrl = `${MAVEN_BASE}net/minecraftforge/forge/${fullVersion}/forge-${fullVersion}-installer.jar`;
  const installerPath = path.join(verDir, ".forge-installer.jar");

  xgmclLog.writeDownloadLog(`[Forge] 下载 installer: ${installerUrl}`);

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

  // 2. 解析 installer
  set("current_files", ["解析 installer..."]);
  xgmclLog.writeDownloadLog("[Forge] 解析 installer...");

  const zip = new AdmZip(installerPath);

  let installProfile = null;
  try {
    const text = zip.readAsText("install_profile.json");
    installProfile = JSON.parse(text);
  } catch (e) {
    xgmclLog.writeDownloadLog(`[Forge] 读 install_profile.json 失败: ${e.message}`);
    throw new Error("installer 里没有 install_profile.json");
  }

  let forgeVersionJson = null;
  try {
    const text = zip.readAsText("version.json");
    forgeVersionJson = JSON.parse(text);
  } catch (e) {
    xgmclLog.writeDownloadLog(`[Forge] 读 version.json 失败: ${e.message}`);
    throw new Error("installer 里没有 version.json");
  }

  // 2.5 解压 installer 里自带的 maven/ 目录到 libsRoot
  // （forge-<mc>-<ver>-client.jar 等库就在里面）
  xgmclLog.writeDownloadLog("[Forge] 解压 installer 内置库...");
  const libsRoot = path.join(rootPath, "libraries");
  let extractedCount = 0;
  for (const entry of zip.getEntries()) {
    const name = entry.entryName;
    if (!name.startsWith("maven/")) continue;
    if (entry.isDirectory) continue;

    // maven/net/minecraftforge/forge/xxx.jar → libsRoot/net/minecraftforge/forge/xxx.jar
    const rel = name.slice("maven/".length);
    if (!rel) continue;

    const target = path.join(libsRoot, rel.replace(/\//g, path.sep));
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) {
        fs.writeFileSync(target, entry.getData());
        extractedCount++;
      }
    } catch (e) {
      xgmclLog.writeDownloadLog(`[Forge] 解压 ${rel} 失败: ${e.message}`);
    }
  }
  xgmclLog.writeDownloadLog(`[Forge] 从 installer 解压 ${extractedCount} 个内置库`);

  // 3. 硬合并
  xgmclLog.writeDownloadLog("[Forge] 硬合并 JSON");
  const merged = hardMerge(vanillaJson, forgeVersionJson, loaderVersion, mcVersion);

  // 4. 收集 libraries
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

  for (const lib of installProfile.libraries || []) addLib(lib);
  for (const lib of forgeVersionJson.libraries || []) addLib(lib);

  xgmclLog.writeDownloadLog(`[Forge] 需下载 ${files.length} 个库`);

  const total = files.reduce((s, f) => s + (f.size || 0), 0);
  set("total_bytes", total);
  set("files_total", files.length);
  set("current_files", []);

  dl.startSpeedUpdater(taskId);
  const failed = await dl.downloadBatch(files, source, threads, taskId);

  // 5. 写回 merged json
  if (!cancelled() && failed.length === 0) {
    fs.writeFileSync(jsonPath, JSON.stringify(merged, null, 2), "utf-8");
    xgmclLog.writeDownloadLog(`[Forge] 合并 JSON 已写回: ${jsonPath}`);
  }

  // 6. 跑 processors
  if (!cancelled() && failed.length === 0) {
    set("current_files", ["跑 processor..."]);
    xgmclLog.writeDownloadLog("[Forge] 开始跑 processors");
    try {
      const clientJar = path.join(verDir, `${versionName}.jar`);
      await processorMod.runProcessors(taskId, installProfile, libsRoot, source, {
        minecraftJar: clientJar,
        installerJar: installerPath,
        rootPath: rootPath,
        mcVersion: mcVersion,
      });
      xgmclLog.writeDownloadLog("[Forge] processors 全部完成");
    } catch (e) {
      xgmclLog.writeDownloadLog(`[Forge] processors 失败: ${e.message}`);
      throw new Error(`processors 失败: ${e.message}`);
    }
  }

  // 7. 删 installer
  try { fs.unlinkSync(installerPath); } catch (_) {}

  // 8. 完成
  const t = dl.getTask(taskId);
  if (!t) return;
  if (t.cancel) {
    xgmclLog.writeDownloadLog("[Forge] 任务被取消");
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
  id: "forge",
  name: "Forge",
  fetchLoaders,
  install,
};