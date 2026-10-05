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



// fabric.js —— Fabric loader 查询 + 版本 JSON 合并

const FABRIC_META = "https://meta.fabricmc.net/v2";
const FABRIC_META_MIRROR = "https://bmclapi2.bangbang93.com/fabric-meta/v2";

// 缓存 loader 列表：key = mc_version
const loaderCache = new Map();
const CACHE_TTL = 300 * 1000; // 5 分钟

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

// 获取指定 MC 版本的 Fabric loader 列表，只返回最新 5 个
// 返回 [{version, stable}, ...]
async function fetchFabricLoaders(mcVersion) {
  if (!mcVersion) throw new Error("mc_version 不能为空");

  const now = Date.now();
  const cached = loaderCache.get(mcVersion);
  if (cached && now - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  const urls = [
    `${FABRIC_META}/versions/loader/${mcVersion}`,
    `${FABRIC_META_MIRROR}/versions/loader/${mcVersion}`,
  ];

  let raw = null;
  let lastErr = null;
  for (const url of urls) {
    raw = await getJson(url);
    if (raw !== null) break;
    lastErr = new Error(`请求失败: ${url}`);
  }

  if (raw === null) {
    throw new Error(`无法获取 Fabric loader 列表（官方和镜像都失败）: ${lastErr?.message || "unknown"}`);
  }

  // Fabric Meta 返回 [{loader: {version, stable}, ...}]，有些版本是简化格式
  const loaders = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    if (item.loader && typeof item.loader === "object") {
      loaders.push({
        version: item.loader.version || "",
        stable: Boolean(item.loader.stable),
      });
    } else if (item.version) {
      loaders.push({
        version: item.version || "",
        stable: Boolean(item.stable),
      });
    }
  }

  const result = loaders.slice(0, 5);
  loaderCache.set(mcVersion, { ts: now, data: result });
  return result;
}

// 获取 Fabric profile JSON（含 libraries、mainClass）
async function fetchFabricProfile(mcVersion, loaderVersion) {
  if (!mcVersion || !loaderVersion) {
    throw new Error("mc_version / loader_version 不能为空");
  }

  const urls = [
    `${FABRIC_META}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`,
    `${FABRIC_META_MIRROR}/versions/loader/${mcVersion}/${loaderVersion}/profile/json`,
  ];

  let lastErr = null;
  for (const url of urls) {
    const data = await getJson(url, 20000);
    if (data !== null) return data;
    lastErr = new Error(`请求失败: ${url}`);
  }

  throw new Error(`无法获取 Fabric profile: ${lastErr?.message || "unknown"}`);
}

// 合并原版 version.json 和 Fabric profile.json
function mergeFabricJson(vanillaJson, fabricProfile, loaderVersion, mcVersion) {
  const merged = JSON.parse(JSON.stringify(vanillaJson));

  // mainClass 用 Fabric 的
  merged.mainClass = fabricProfile.mainClass || merged.mainClass || "";

  // libraries = fabric + vanilla（fabric 在前，避免被覆盖）
  const vanillaLibs = merged.libraries || [];
  const fabricLibs = fabricProfile.libraries || [];
  merged.libraries = fabricLibs.concat(vanillaLibs);

  // 记录标识
  merged.XGMCL_LOADER = "fabric";
  merged.XGMCL_FABRIC_VERSION = loaderVersion;
  merged.XGMCL_MC_VERSION = mcVersion;

  // 保留原版 id（PCL 靠它识别）
  if (!merged.id && fabricProfile.id) {
    merged.id = fabricProfile.id;
  }

  // arguments：Fabric 一般不带，保留原版
  if (!merged.arguments) {
    merged.arguments = vanillaJson.arguments || {};
  }

  return merged;
}

module.exports = {
  fetchFabricLoaders,
  fetchFabricProfile,
  mergeFabricJson,
};