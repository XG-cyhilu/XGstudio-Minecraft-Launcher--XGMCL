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

// loaders/quilt.js —— Quilt loader

const fs = require("fs");
const path = require("path");
const dl = require("../download.js");
const xgmclLog = require("../xgmcl_log.js");

const META = "https://meta.quiltmc.org/v3";

const cache = new Map();
const CACHE_TTL = 300 * 1000;

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

// 按 groupId 选 maven
function pickMaven(group) {
  if (group.startsWith("org.quiltmc")) return "https://maven.quiltmc.org/repository/release/";
  if (group.startsWith("net.fabricmc")) return "https://maven.fabricmc.net/";
  if (group.startsWith("org.ow2.asm")) return "https://repo1.maven.org/maven2/";
  if (group.startsWith("org.jetbrains")) return "https://repo1.maven.org/maven2/";
  if (group.startsWith("com.google")) return "https://repo1.maven.org/maven2/";
  if (group.startsWith("org.slf4j")) return "https://repo1.maven.org/maven2/";
  if (group.startsWith("org.apache")) return "https://repo1.maven.org/maven2/";
  if (group.startsWith("commons-")) return "https://repo1.maven.org/maven2/";
  return "https://repo1.maven.org/maven2/";
}

// quilt-json5 特殊处理：group 是 org.quiltmc，但 profile 里给的 name 可能缺 group
function specialRel(group, aname, ver, classifier) {
  if (aname === "quilt-json5") {
    return {
      maven: "https://maven.quiltmc.org/repository/release/",
      rel: `org/quiltmc/quilt-json5/${ver}/quilt-json5-${ver}${classifier}.jar`,
    };
  }
  return null;
}

async function fetchLoaders(mcVersion) {
  if (!mcVersion) throw new Error("mc_version 不能为空");

  const now = Date.now();
  const cached = cache.get(mcVersion);
  if (cached && now - cached.ts < CACHE_TTL) return cached.data;

  const raw = await getJson(`${META}/versions/loader/${mcVersion}`);
  if (raw === null) throw new Error("无法获取 Quilt loader 列表");

  const loaders = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    if (item.loader && typeof item.loader === "object") {
      loaders.push({
        version: item.loader.version || "",
        stable: true,
      });
    }
  }
  const result = loaders.slice(0, 5);
  cache.set(mcVersion, { ts: now, data: result });
  return result;
}

async function fetchProfile(mcVersion, loaderVersion) {
  const url = `${META}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`;
  const data = await getJson(url, 20000);
  if (data === null) throw new Error("无法获取 Quilt profile");
  return data;
}

function mergeJson(vanillaJson, profile, loaderVersion, mcVersion) {
  const merged = JSON.parse(JSON.stringify(vanillaJson));
  merged.mainClass = profile.mainClass || merged.mainClass || "";

  const vanillaLibs = merged.libraries || [];
  const profileLibs = profile.libraries || [];
  merged.libraries = profileLibs.concat(vanillaLibs);

  merged.XGMCL_LOADER = "quilt";
  merged.XGMCL_LOADER_VERSION = loaderVersion;
  merged.XGMCL_MC_VERSION = mcVersion;

  if (!merged.id && profile.id) merged.id = profile.id;
  if (!merged.arguments) merged.arguments = vanillaJson.arguments || {};
  return merged;
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
             !n.includes("neoforge");
    });
    delete vanillaJson.XGMCL_LOADER;
    delete vanillaJson.XGMCL_LOADER_VERSION;
    delete vanillaJson.XGMCL_MC_VERSION;
    if (!vanillaJson.mainClass) {
      vanillaJson.mainClass = "net.minecraft.client.main.Main";
    }
  }

  set("current_files", ["获取 Quilt profile..."]);
  xgmclLog.writeDownloadLog(`[Quilt] 获取 profile: MC=${mcVersion}, loader=${loaderVersion}`);
  const profile = await fetchProfile(mcVersion, loaderVersion);

  const merged = mergeJson(vanillaJson, profile, loaderVersion, mcVersion);

  const libsRoot = path.join(rootPath, "libraries");
  const files = [];

  for (const lib of profile.libraries || []) {
    const artifact = (lib.downloads || {}).artifact;

    if (artifact && artifact.url && artifact.path) {
      // 有 artifact：直接用
      files.push({
        url: dl.rewriteUrl(artifact.url, source),
        target: path.join(libsRoot, artifact.path.replace(/\//g, path.sep)),
        sha1: artifact.sha1 || "",
        size: artifact.size || 0,
        important: true,
      });
      continue;
    }

    // 没 artifact：按 groupId 拼 maven 路径
    const name = lib.name || "";
    if (!name || !name.includes(":")) continue;
    const parts = name.split(":");
    if (parts.length < 3) continue;
    const [group, aname, ver] = parts;
    const classifier = parts.length >= 4 ? "-" + parts[3] : "";

    // ★ 调试：打出所有没 artifact 的库
    xgmclLog.writeDownloadLog(
      `[Quilt-DEBUG] name=${name} | group=${group} | aname=${aname} | ver=${ver}`
    );

    let mavenBase = pickMaven(group);
    let rel = `${group.replace(/\./g, "/")}/${aname}/${ver}/${aname}-${ver}${classifier}.jar`;

    // 特殊修正
    const special = specialRel(group, aname, ver, classifier);
    if (special) {
      mavenBase = special.maven;
      rel = special.rel;
    }

    const url = `${mavenBase}${rel}`;
    files.push({
      url,
      target: path.join(libsRoot, rel.replace(/\//g, path.sep)),
      sha1: "",
      size: 0,
      important: false,
    });
  }

  xgmclLog.writeDownloadLog(`[Quilt] 需下载 ${files.length} 个库`);

  const total = files.reduce((s, f) => s + (f.size || 0), 0);
  set("total_bytes", total);
  set("files_total", files.length);
  set("current_files", []);

  dl.startSpeedUpdater(taskId);
  const failed = await dl.downloadBatch(files, source, threads, taskId);

  if (!cancelled() && failed.length === 0) {
    fs.writeFileSync(jsonPath, JSON.stringify(merged, null, 2), "utf-8");
    xgmclLog.writeDownloadLog(`[Quilt] 合并 JSON 已写回: ${jsonPath}`);
  }

  const t = dl.getTask(taskId);
  if (!t) return;
  if (t.cancel) {
    xgmclLog.writeDownloadLog("[Quilt] 任务被取消，清理...");
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
    xgmclLog.writeDownloadLog(`[Quilt] 清理: ${cleaned} 个 .part, ${removed} 个已下文件`);
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
  id: "quilt",
  name: "Quilt",
  fetchLoaders,
  install,
};