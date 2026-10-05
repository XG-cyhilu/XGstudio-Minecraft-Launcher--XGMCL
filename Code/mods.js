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

// mods.js —— 版本 mods 目录管理（列表 / 开关 / 删除 / 导入 / 元数据）

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const modrinth = require("./modrinth.js");
const xgmclLog = require("./xgmcl_log.js");

// 从 jar 里读 mod 元数据
function readJarMeta(jarPath) {
  const result = { mod_id: "", slug: "", modrinth_url: "" };

  function extractSlug(...urls) {
    for (const u of urls) {
      if (!u || typeof u !== "string") continue;
      const m = u.match(/modrinth\.com\/mod\/([A-Za-z0-9_\-]+)/);
      if (m) return m[1];
    }
    return "";
  }

  try {
    const zip = new AdmZip(jarPath);
    const names = zip.getEntries().map((e) => e.entryName);

    // Fabric
    if (names.includes("fabric.mod.json")) {
      try {
        const data = JSON.parse(zip.readAsText("fabric.mod.json"));
        if (data && typeof data === "object") {
          result.mod_id = (data.id || "").trim();
          const contact = data.contact || {};
          const slug = extractSlug(contact.sources, contact.homepage, contact.issues);
          if (slug) {
            result.slug = slug;
            result.modrinth_url = `https://modrinth.com/mod/${slug}`;
            return result;
          }
        }
      } catch (_) {}
    }

    // Quilt
    if (names.includes("quilt.mod.json")) {
      try {
        const data = JSON.parse(zip.readAsText("quilt.mod.json"));
        if (data && typeof data === "object") {
          const ql = data.quilt_loader || {};
          result.mod_id = (ql.id || "").trim();
          const meta = ql.metadata || {};
          const slug = extractSlug(meta.homepage);
          if (slug) {
            result.slug = slug;
            result.modrinth_url = `https://modrinth.com/mod/${slug}`;
            return result;
          }
        }
      } catch (_) {}
    }

    // Forge 1.13+
    if (names.includes("META-INF/mods.toml")) {
      try {
        const text = zip.readAsText("META-INF/mods.toml");
        const m = text.match(/modId\s*=\s*"([^"]+)"/);
        if (m) result.mod_id = m[1].trim();
        const u = text.match(/displayURL\s*=\s*"([^"]+)"/);
        if (u) {
          const slug = extractSlug(u[1]);
          if (slug) {
            result.slug = slug;
            result.modrinth_url = `https://modrinth.com/mod/${slug}`;
            return result;
          }
        }
      } catch (_) {}
    }

    // 老 Forge
    if (names.includes("mcmod.info")) {
      try {
        const data = JSON.parse(zip.readAsText("mcmod.info"));
        if (Array.isArray(data) && data.length) {
          result.mod_id = (data[0].modid || "").trim();
          const slug = extractSlug(data[0].url);
          if (slug) {
            result.slug = slug;
            result.modrinth_url = `https://modrinth.com/mod/${slug}`;
            return result;
          }
        } else if (data && typeof data === "object") {
          result.mod_id = (data.modid || "").trim();
        }
      } catch (_) {}
    }
  } catch (e) {
    xgmclLog.writeLog("WARN", `读 jar 元数据失败 ${jarPath}: ${e.message}`);
  }

  return result;
}

// mod 缓存文件
function loadModCache(verDir) {
  const p = path.join(verDir, ".xgmcl_mod_cache.json");
  if (!fs.existsSync(p)) return {};
  try {
    const d = JSON.parse(fs.readFileSync(p, "utf-8"));
    return d && typeof d === "object" ? d : {};
  } catch (_) {
    return {};
  }
}

function saveModCache(verDir, cache) {
  try {
    const p = path.join(verDir, ".xgmcl_mod_cache.json");
    fs.mkdirSync(verDir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache, null, 2), "utf-8");
  } catch (e) {
    xgmclLog.writeLog("WARN", `写 mod 缓存失败 ${verDir}: ${e.message}`);
  }
}

// 列表
function listMods(rootPath, versionName) {
  const wiki = modrinth.loadWikiEntries();
  const isolated = require("./config.js").getVersionIsolated(rootPath, versionName);

  let verDir, modsDir;
  if (isolated) {
    verDir = path.join(rootPath, "versions", versionName);
    modsDir = path.join(verDir, "mods");
  } else {
    verDir = rootPath;
    modsDir = path.join(rootPath, "mods");
  }

  if (!fs.existsSync(modsDir)) {
    return { mods: [], mods_dir: modsDir, exists: false };
  }

  const cache = loadModCache(verDir);
  const newCache = {};
  const mods = [];

  for (const fn of fs.readdirSync(modsDir)) {
    let enabled;
    if (fn.endsWith(".jar.disabled")) enabled = false;
    else if (fn.endsWith(".jar")) enabled = true;
    else continue;

    const full = path.join(modsDir, fn);
    let st;
    try {
      st = fs.statSync(full);
      if (!st.isFile()) continue;
    } catch (_) { continue; }

    const cacheKey = `${fn}|${Math.floor(st.mtimeMs / 1000)}|${st.size}`;

    let modId, slug, mrUrl, titleCn;
    if (cache[cacheKey]) {
      modId = cache[cacheKey].mod_id || "";
      slug = cache[cacheKey].slug || "";
      mrUrl = cache[cacheKey].modrinth_url || "";
      titleCn = cache[cacheKey].title_cn || "";
      // 老缓存没 slug：重读一次
      if (modId && !slug) {
        const meta = readJarMeta(full);
        slug = meta.slug;
        mrUrl = meta.modrinth_url;
      }
    } else {
      const meta = readJarMeta(full);
      modId = meta.mod_id;
      slug = meta.slug;
      mrUrl = meta.modrinth_url;
      titleCn = modId ? (wiki[modId.toLowerCase()] || "") : "";
    }

    newCache[cacheKey] = {
      mod_id: modId,
      slug,
      modrinth_url: mrUrl,
      title_cn: titleCn,
    };

    mods.push({
      filename: fn,
      size: st.size,
      mtime: Math.floor(st.mtimeMs / 1000),
      enabled,
      mod_id: modId,
      slug,
      modrinth_url: mrUrl,
      title_cn: titleCn,
    });
  }

  saveModCache(verDir, newCache);
  return { mods, mods_dir: modsDir, exists: true };
}

// 启用/禁用
function toggleMod(rootPath, versionName, filename, enable) {
  if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return { code: 400, msg: "非法文件名" };
  }

  const isolated = require("./config.js").getVersionIsolated(rootPath, versionName);
  const modsDir = isolated
    ? path.join(rootPath, "versions", versionName, "mods")
    : path.join(rootPath, "mods");

  const srcPath = path.join(modsDir, filename);
  if (!fs.existsSync(srcPath)) {
    return { code: 404, msg: `文件不存在: ${filename}` };
  }

  try {
    if (enable) {
      if (filename.endsWith(".jar.disabled")) {
        const newName = filename.slice(0, -".disabled".length);
        const dstPath = path.join(modsDir, newName);
        if (fs.existsSync(dstPath)) {
          return { code: 400, msg: `目标文件已存在: ${newName}` };
        }
        fs.renameSync(srcPath, dstPath);
        xgmclLog.writeLog("INFO", `启用 Mod: ${filename} → ${newName}`);
        return { code: 200, msg: "已启用", filename: newName };
      } else if (filename.endsWith(".jar")) {
        return { code: 200, msg: "已经是启用状态", filename };
      }
      return { code: 400, msg: "不是 .jar / .jar.disabled 文件" };
    } else {
      if (filename.endsWith(".jar")) {
        const newName = filename + ".disabled";
        const dstPath = path.join(modsDir, newName);
        if (fs.existsSync(dstPath)) {
          return { code: 400, msg: `目标文件已存在: ${newName}` };
        }
        fs.renameSync(srcPath, dstPath);
        xgmclLog.writeLog("INFO", `禁用 Mod: ${filename} → ${newName}`);
        return { code: 200, msg: "已禁用", filename: newName };
      } else if (filename.endsWith(".jar.disabled")) {
        return { code: 200, msg: "已经是禁用状态", filename };
      }
      return { code: 400, msg: "不是 .jar / .jar.disabled 文件" };
    }
  } catch (e) {
    xgmclLog.writeLog("ERROR", `切换 Mod 状态失败: ${filename} - ${e.message}`);
    return { code: 500, msg: `操作失败: ${e.message}` };
  }
}

// 批量删除
function deleteMods(rootPath, versionName, filenames) {
  const isolated = require("./config.js").getVersionIsolated(rootPath, versionName);
  const modsDir = isolated
    ? path.join(rootPath, "versions", versionName, "mods")
    : path.join(rootPath, "mods");

  if (!fs.existsSync(modsDir)) {
    return { code: 404, msg: `mods 目录不存在: ${modsDir}` };
  }

  const deleted = [];
  const failed = [];

  for (const fn of filenames) {
    if (!fn || fn.includes("/") || fn.includes("\\") || fn.includes("..")) {
      failed.push({ filename: fn, error: "非法文件名" });
      continue;
    }
    const full = path.join(modsDir, fn);
    if (!fs.existsSync(full)) {
      failed.push({ filename: fn, error: "文件不存在" });
      continue;
    }
    try {
      fs.unlinkSync(full);
      deleted.push(fn);
    } catch (e) {
      failed.push({ filename: fn, error: e.message });
    }
  }

  xgmclLog.writeLog("INFO", `删除 Mod: 成功 ${deleted.length} 个，失败 ${failed.length} 个`);
  return {
    code: 200,
    msg: `已删除 ${deleted.length} 个文件`,
    deleted,
    failed,
  };
}

// 导入（拖拽）
function importMods(rootPath, versionName, srcPaths, overwrite) {
  const isolated = require("./config.js").getVersionIsolated(rootPath, versionName);
  const modsDir = isolated
    ? path.join(rootPath, "versions", versionName, "mods")
    : path.join(rootPath, "mods");

  try {
    fs.mkdirSync(modsDir, { recursive: true });
  } catch (e) {
    return { code: 500, msg: `创建 mods 目录失败: ${e.message}` };
  }

  const imported = [];
  const skipped = [];
  const failed = [];

  for (const src of srcPaths) {
    if (!fs.existsSync(src)) {
      failed.push({ src, error: "源文件不存在" });
      continue;
    }

    const fn = path.basename(src);
    if (!fn.endsWith(".jar") && !fn.endsWith(".jar.disabled")) {
      failed.push({ src, error: "只支持 .jar / .jar.disabled" });
      continue;
    }

    const dst = path.join(modsDir, fn);

    if (fs.existsSync(dst)) {
      if (overwrite) {
        try {
          fs.unlinkSync(dst);
        } catch (e) {
          failed.push({ src, error: `删除旧文件失败: ${e.message}` });
          continue;
        }
      } else {
        skipped.push(fn);
        continue;
      }
    }

    // 同一个文件？
    try {
      if (fs.existsSync(dst) && fs.realpathSync(src) === fs.realpathSync(dst)) {
        skipped.push(fn);
        continue;
      }
    } catch (_) {}

    try {
      fs.copyFileSync(src, dst);
      imported.push(fn);
    } catch (e) {
      failed.push({ src, error: e.message });
    }
  }

  xgmclLog.writeLog("INFO", `导入 Mod: 成功 ${imported.length}，跳过 ${skipped.length}，失败 ${failed.length}`);
  return {
    code: 200,
    msg: `导入 ${imported.length} 个`,
    imported,
    skipped,
    failed,
  };
}

// 元数据目录
function metaDir(rootPath, versionName) {
  return path.join(rootPath, "versions", versionName, ".xgmcl", "mods");
}

// 列出所有 mod 元数据
function listMeta(rootPath, versionName) {
  const dir = metaDir(rootPath, versionName);
  const result = {};
  if (!fs.existsSync(dir)) return result;

  for (const fn of fs.readdirSync(dir)) {
    if (!fn.endsWith(".json")) continue;
    const full = path.join(dir, fn);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      const d = JSON.parse(fs.readFileSync(full, "utf-8"));
      const pid = d.project_id || fn.slice(0, -5);
      result[pid] = d;
    } catch (e) {
      xgmclLog.writeLog("WARN", `读元数据失败 ${fn}: ${e.message}`);
    }
  }
  return result;
}

// 写入一批元数据
function saveMeta(rootPath, versionName, metas) {
  const dir = metaDir(rootPath, versionName);
  fs.mkdirSync(dir, { recursive: true });

  let saved = 0;
  for (const [pid, meta] of Object.entries(metas)) {
    if (!pid || !meta || typeof meta !== "object") continue;
    try {
      const p = path.join(dir, `${pid}.json`);
      fs.writeFileSync(p, JSON.stringify(meta, null, 2), "utf-8");
      saved++;
    } catch (e) {
      xgmclLog.writeLog("WARN", `写元数据失败 ${pid}: ${e.message}`);
    }
  }

  xgmclLog.writeLog("INFO", `写入 mod 元数据: ${saved} 条 → ${versionName}`);
  return { code: 200, msg: `已保存 ${saved} 条`, saved };
}

// 下载完后自动写元数据
async function autoWriteMetaAfterDownload(target) {
  if (!target || !fs.existsSync(target)) return;

  // 算 SHA-512
  const crypto = require("crypto");
  const h = crypto.createHash("sha512");
  const fd = fs.openSync(target, "r");
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
  const sha512 = h.digest("hex");

  // 查 Modrinth
  let v;
  try {
    const res = await fetch(`${modrinth.API}/version_file/${sha512}?algorithm=sha512`, {
      headers: modrinth.headers(),
    });
    if (!res.ok) {
      xgmclLog.writeLog("INFO", `哈希反查无结果（可能是非 Modrinth 文件）: ${path.basename(target)}`);
      return;
    }
    v = await res.json();
  } catch (e) {
    xgmclLog.writeLog("WARN", `哈希反查请求失败: ${e.message}`);
    return;
  }

  const pid = v.project_id || "";
  if (!pid) return;

  // 拉项目信息
  let title = "", slug = "", iconUrl = "";
  try {
    const pr = await fetch(`${modrinth.API}/project/${pid}`, { headers: modrinth.headers() });
    if (pr.ok) {
      const p = await pr.json();
      title = p.title || "";
      slug = p.slug || "";
      iconUrl = p.icon_url || "";
    }
  } catch (_) {}

  const wiki = modrinth.loadWikiEntries();
  const titleCn = wiki[(slug || "").toLowerCase()] || "";

  const files = v.files || [];
  let primary = null;
  for (const f of files) {
    if (f.primary) { primary = f; break; }
  }
  if (!primary && files.length) primary = files[0];

  // 目标 mods 目录 = target 所在目录
  const modsDir = path.dirname(target);
  const versionDir = path.dirname(modsDir);

  const dir = metaDir(path.dirname(path.dirname(versionDir)), path.basename(versionDir));
  // 上面这行有点绕，直接重新算
  const actualVerDir = path.dirname(modsDir);
  const actualRootPath = path.dirname(path.dirname(actualVerDir));

  // 简单点：直接用 versionDir 的父级的父级当 rootPath
  // 对于隔离版本：target = <root>/versions/<ver>/mods/xxx.jar
  //    modsDir = <root>/versions/<ver>/mods
  //    versionDir = <root>/versions/<ver>
  //    rootPath = <root>
  const rootPath = path.dirname(path.dirname(versionDir));
  const versionName = path.basename(versionDir);

  saveMeta(rootPath, versionName, {
    [pid]: {
      project_id: pid,
      slug,
      title,
      title_cn: titleCn,
      version_id: v.id || "",
      version_number: v.version_number || "",
      download_url: (primary || {}).url || "",
      filename: path.basename(target),
      dependencies: v.dependencies || [],
      source: "modrinth",
      updated_at: Math.floor(Date.now() / 1000),
    },
  });
  xgmclLog.writeLog("INFO", `已写入 mod 元数据: ${title || pid}`);
}

module.exports = {
  readJarMeta,
  listMods,
  toggleMod,
  deleteMods,
  importMods,
  metaDir,
  listMeta,
  saveMeta,
  autoWriteMetaAfterDownload,
};