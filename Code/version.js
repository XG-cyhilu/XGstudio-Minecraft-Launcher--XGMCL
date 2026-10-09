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

// version.js —— 版本扫描 / 解析 / JSON 继承合并 / classpath 构建

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const P = require("./paths.js");
const cfg = require("./config.js");

// ---- 根目录 ----

function checkRootValid(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) return false;
  try {
    if (!fs.statSync(rootPath).isDirectory()) return false;
  } catch (_) {
    return false;
  }
  return (
    fs.existsSync(path.join(rootPath, "versions")) &&
    fs.existsSync(path.join(rootPath, "libraries"))
  );
}

function getRootById(rootId) {
  const db = cfg.safeLoadJson(P.ROOTS_DB);
  const roots = db.roots || [];
  if (rootId) {
    return roots.find((r) => r.id === rootId) || null;
  }
  const activeId = db.active_id || "";
  return roots.find((r) => r.id === activeId) || null;
}

// ---- 版本信息解析 ----

// 从一个版本的 json 里推断 MC 版本号 + loader 类型
function parseVersionInfo(verName, verDir) {
  const jsonPath = path.join(verDir, `${verName}.json`);
  let gameVer = "未知";
  let loader = "Vanilla";

  if (fs.existsSync(jsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

      const clientVer = data.clientVersion || "";
      if (clientVer) {
        gameVer = clientVer;
      } else {
        const m = verName.match(/\d+\.\d+(?:\.\d+)?/);
        gameVer = m ? m[0] : "未知";
      }

      const mainClass = (data.mainClass || "").toLowerCase();
      if (mainClass.includes("fabric") || mainClass.includes("fabricmc")) {
        loader = "Fabric";
      } else if (mainClass.includes("neoforge")) {
        loader = "NeoForge";
      } else if (mainClass.includes("forge") && !mainClass.includes("neoforge")) {
        loader = "Forge";
      } else {
        const libNames = (data.libraries || [])
          .map((l) => (l.name || "").toLowerCase())
          .join(" ");
        if (libNames.includes("fabric-loader")) loader = "Fabric";
        else if (libNames.includes("neoforge")) loader = "NeoForge";
        else if (libNames.includes("forge") && libNames.includes("minecraftforge")) loader = "Forge";
        else if (libNames.includes("optifine")) loader = "OptiFine";
        else loader = "Vanilla";
      }
    } catch (e) {
      console.warn(`[version] 解析 ${jsonPath} 失败:`, e.message);
      const m = verName.match(/\d+\.\d+(?:\.\d+)?/);
      gameVer = m ? m[0] : "未知";
    }
  } else {
    const m = verName.match(/\d+\.\d+(?:\.\d+)?/);
    gameVer = m ? m[0] : "未知";
    const lower = verName.toLowerCase();
    if (lower.includes("fabric")) loader = "Fabric";
    else if (lower.includes("neoforge")) loader = "NeoForge";
    else if (lower.includes("forge")) loader = "Forge";
  }

  const showName = verName.length <= 20 ? verName : verName.slice(0, 20) + "……";
  return {
    full_name: verName,
    show_name: showName,
    game_version: gameVer,
    loader_type: loader,
  };
}

// 扫描一个根目录下的所有版本
function scanVersionsOfRoot(rootPath) {
  const list = [];
  const verDir = path.join(rootPath, "versions");
  if (!fs.existsSync(verDir)) return list;

  for (const name of fs.readdirSync(verDir)) {
    const full = path.join(verDir, name);
    try {
      if (fs.statSync(full).isDirectory()) {
        list.push(parseVersionInfo(name, full));
      }
    } catch (_) {}
  }
  return list;
}

// ---- version.json 继承合并 ----

// 读版本 json，如果有 inheritsFrom 就展平
function loadVersionJsonWithInherit(gameRoot, versionName) {
  const verDir = path.join(gameRoot, "versions", versionName);
  const jsonPath = path.join(verDir, `${versionName}.json`);

  const vj = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const inherits = vj.inheritsFrom;
  if (!inherits) return vj;

  const parentDir = path.join(gameRoot, "versions", inherits);
  const parentJson = path.join(parentDir, `${inherits}.json`);
  if (!fs.existsSync(parentJson)) {
    console.warn(`[inheritsFrom] 父版本 json 不存在: ${parentJson}，按独立版本处理`);
    return vj;
  }

  let pj = JSON.parse(fs.readFileSync(parentJson, "utf-8"));
  if (pj.inheritsFrom) {
    pj = flattenVersionJson(gameRoot, inherits, pj);
  }

  return mergeVersionJson(pj, vj);
}

// 递归展平（内部用）
function flattenVersionJson(gameRoot, versionName, vj) {
  const inherits = vj.inheritsFrom;
  if (!inherits) return vj;

  const parentDir = path.join(gameRoot, "versions", inherits);
  const parentJson = path.join(parentDir, `${inherits}.json`);
  if (!fs.existsSync(parentJson)) return vj;

  let pj = JSON.parse(fs.readFileSync(parentJson, "utf-8"));
  if (pj.inheritsFrom) {
    pj = flattenVersionJson(gameRoot, inherits, pj);
  }
  return mergeVersionJson(pj, vj);
}

// 把父版本和子版本合并（子覆盖父）
function mergeVersionJson(pj, vj) {
  const merged = { ...pj };

  // 子版本有的字段直接用子的
  const overrideKeys = [
    "id", "mainClass", "type", "assets", "assetIndex",
    "downloads", "javaVersion", "complianceLevel",
    "logging", "releaseTime", "time", "minimumLauncherVersion",
    "clientVersion",
  ];
  for (const k of overrideKeys) {
    if (k in vj) merged[k] = vj[k];
  }

  // libraries：父 + 子，按 name 去重，子优先
  const libMap = new Map();
  for (const lib of pj.libraries || []) {
    libMap.set(lib.name || "", lib);
  }
  for (const lib of vj.libraries || []) {
    libMap.set(lib.name || "", lib);
  }
  merged.libraries = Array.from(libMap.values());

  // arguments：jvm / game 相加
  const pArgs = pj.arguments || {};
  const cArgs = vj.arguments || {};
  merged.arguments = {
    jvm: [...(pArgs.jvm || []), ...(cArgs.jvm || [])],
    game: [...(pArgs.game || []), ...(cArgs.game || [])],
  };

  // 老格式 minecraftArguments 兼容
  if (vj.minecraftArguments) merged.minecraftArguments = vj.minecraftArguments;
  else if (pj.minecraftArguments) merged.minecraftArguments = pj.minecraftArguments;

  return merged;
}

// ---- rules / classpath ----

function ruleAllows(rules, osName = "windows", osArch = "x86_64") {
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

function libToJarPath(lib, libsRoot) {
  const name = lib.name || "";
  const artifact = (lib.downloads || {}).artifact;

  if (artifact && artifact.path) {
    return path.join(libsRoot, artifact.path.replace(/\//g, path.sep));
  }

  if (!name) return null;
  const parts = name.split(":");
  if (parts.length < 3) return null;

  const [group, aname, version] = parts;
  const classifier = parts.length >= 4 ? "-" + parts[3] : "";
  const rel = `${group.replace(/\./g, "/")}/${aname}/${version}/${aname}-${version}${classifier}.jar`;
  return path.join(libsRoot, rel.replace(/\//g, path.sep));
}

// 构建 classpath（带缓存）
function buildClasspath(versionJson, libsRoot, clientJar) {
  const verDir = path.dirname(clientJar);
  const cacheFile = path.join(verDir, ".xgmcl_cp_cache");
  const jsonPath = path.join(verDir, `${path.basename(verDir)}.json`);

  // 缓存有效就直接返回
  if (fs.existsSync(cacheFile) && fs.existsSync(jsonPath)) {
    try {
      const cacheMtime = fs.statSync(cacheFile).mtimeMs;
      const jsonMtime = fs.statSync(jsonPath).mtimeMs;
      if (cacheMtime > jsonMtime) {
        const cached = fs.readFileSync(cacheFile, "utf-8");
        if (cached) return cached;
      }
    } catch (_) {}
  }

  const jars = [];
  const seen = new Set();
  // 按 groupId:artifactId 去重（保留第一个，即靠前的 loader 版本）
  const seenGA = new Set();

  for (const lib of versionJson.libraries || []) {
    if (!ruleAllows(lib.rules)) continue;

    // 从 name 里抽出 group:artifact
    const name = lib.name || "";
    const parts = name.split(":");
    if (parts.length >= 2) {
      const ga = parts[0] + ":" + parts[1];
      if (seenGA.has(ga)) continue;   // 同名库跳过
      seenGA.add(ga);
    }

    const jar = libToJarPath(lib, libsRoot);
    if (!jar || seen.has(jar)) continue;
    seen.add(jar);
    jars.push(jar);
  }

  if (clientJar && !seen.has(clientJar)) {
    jars.push(clientJar);
  }

  const classpath = jars.join(";");
  try {
    fs.writeFileSync(cacheFile, classpath, "utf-8");
  } catch (_) {}
  return classpath;
}

// 解压 natives（跳过已存在的）
function extractNatives(versionJson, libsRoot, nativesDir) {
  const AdmZip = require("adm-zip");
  fs.mkdirSync(nativesDir, { recursive: true });

  let extracted = 0;
  let skipped = 0;

  for (const lib of versionJson.libraries || []) {
    const name = lib.name || "";
    if (!name.includes("natives") || !name.includes("windows")) continue;

    const jarPath = libToJarPath(lib, libsRoot);
    if (!jarPath || !fs.existsSync(jarPath)) continue;

    try {
      const zip = new AdmZip(jarPath);
      for (const entry of zip.getEntries()) {
        const entryName = entry.entryName;
        if (!/\.(dll|so|dylib)$/i.test(entryName)) continue;

        const target = path.join(nativesDir, path.basename(entryName));
        if (fs.existsSync(target)) {
          skipped++;
          continue;
        }
        fs.writeFileSync(target, entry.getData());
        extracted++;
      }
    } catch (e) {
      console.warn(`[natives] 解压 ${jarPath} 失败:`, e.message);
    }
  }

  if (extracted || skipped) {
    console.log(`[natives] 新解压 ${extracted} 个，跳过 ${skipped} 个`);
  }
}

// ---- 变量替换 ----

function replaceVars(items, varMap) {
  const result = [];
  for (const item of items) {
    if (typeof item === "string") {
      let s = item;
      for (const k in varMap) {
        s = s.split("${" + k + "}").join(String(varMap[k]));
      }
      result.push(s);
    } else if (item && typeof item === "object") {
      // 带 rules 的参数对象，这里简化忽略
      continue;
    } else {
      result.push(String(item));
    }
  }
  return result;
}

// ---- 离线 UUID ----

// 返回带横杠的标准 UUID（Minecraft 启动参数 auth_uuid 需要这个格式）
function offlineUuid(username) {
  const digest = crypto.createHash("md5").update("OfflinePlayer:" + username, "utf-8").digest();
  // 按 Java UUID.nameUUIDFromBytes 规则改 version/variant
  digest[6] = (digest[6] & 0x0f) | 0x30;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return hex.replace(
    /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
    "$1-$2-$3-$4-$5"
  );
}

module.exports = {
  checkRootValid,
  getRootById,
  parseVersionInfo,
  scanVersionsOfRoot,
  loadVersionJsonWithInherit,
  ruleAllows,
  libToJarPath,
  buildClasspath,
  extractNatives,
  replaceVars,
  offlineUuid,
};