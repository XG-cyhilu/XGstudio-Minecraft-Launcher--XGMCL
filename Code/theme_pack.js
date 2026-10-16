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

// theme_pack.js —— 主题包（.xglt）打包 / 解包
//
// 包结构（zip，不压缩，仅储存）：
//   主题名.xglt
//     thset.json           # 全部配置 + 相对路径
//     XGMCLSFA/
//       CSS/A/             # 全局 CSS 本体
//       CSS/HOME/          # 主页 CSS 本体
//       M/                 # 壁纸本体
//       SVG/               # 标题栏自定义 SVG 本体
//       XGMCLLDJ/          # 原始 .xglt 包留一份

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const P = require("./paths.js");
const cfgMod = require("./config.js");
const xgmclLog = require("./xgmcl_log.js");

function ensureDir(d) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
}

function copyFileSafe(src, dst) {
  try {
    ensureDir(path.dirname(dst));
    fs.copyFileSync(src, dst);
    return true;
  } catch (e) {
    xgmclLog.writeLog("WARN", `[ThemePack] 复制失败 ${src} → ${dst}: ${e.message}`);
    return false;
  }
}

// 把绝对路径下的文件/目录复制进包
function copyIntoPack(srcAbs, packRoot, subDir) {
  if (!srcAbs || !fs.existsSync(srcAbs)) return "";
  const dstDir = path.join(packRoot, "XGMCLSFA", subDir);
  ensureDir(dstDir);

  try {
    const st = fs.statSync(srcAbs);
    if (st.isFile()) {
      const name = path.basename(srcAbs);
      copyFileSafe(srcAbs, path.join(dstDir, name));
      return `${subDir}/${name}`;
    }
    if (st.isDirectory()) {
      let count = 0;
      for (const name of fs.readdirSync(srcAbs)) {
        const s = path.join(srcAbs, name);
        try {
          if (fs.statSync(s).isFile()) {
            copyFileSafe(s, path.join(dstDir, name));
            count++;
          }
        } catch (_) {}
      }
      if (count > 0) return `${subDir}/`;
    }
  } catch (e) {
    xgmclLog.writeLog("WARN", `[ThemePack] copyIntoPack 失败: ${e.message}`);
  }
  return "";
}

// 从包内相对路径复制到本地主题目录，返回本地绝对路径
function copyFromPack(packRoot, relPath, localThemeDir, subDir) {
  if (!relPath) return "";
  const src = path.join(packRoot, "XGMCLSFA", relPath);
  const dstDir = path.join(localThemeDir, subDir);
  if (!fs.existsSync(src)) return "";

  ensureDir(dstDir);
  try {
    const st = fs.statSync(src);
    if (st.isFile()) {
      const dst = path.join(dstDir, path.basename(src));
      copyFileSafe(src, dst);
      return dst;
    }
    if (st.isDirectory()) {
      let first = "";
      for (const name of fs.readdirSync(src)) {
        const s = path.join(src, name);
        try {
          if (fs.statSync(s).isFile()) {
            const dst = path.join(dstDir, name);
            copyFileSafe(s, dst);
            if (!first) first = dst;
          }
        } catch (_) {}
      }
      return first || (dstDir + path.sep);
    }
  } catch (_) {}
  return "";
}

// ---- 导出 ----
async function exportThemePack(themeName, outputPath) {
  try {
    const safeName = String(themeName || "theme").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
    const tmpRoot = path.join(P.THEME_PACK_DIR, "__tmp_export__");
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    ensureDir(tmpRoot);

    const ui = cfgMod.collectUiSettingsForPack();
    const appearance = { ...(ui.appearance || {}) };

    const thset = {
      _format: "xglt",
      _version: 1,
      author: appearance._author || "",
      export_time: Math.floor(Date.now() / 1000),
      theme: ui.theme || {},
      mode: ui.mode || "custom",
      appearance: { ...appearance },
      paths: {},
    };

    // 全局 CSS
    if (appearance.global_css && fs.existsSync(appearance.global_css)) {
      const rel = copyIntoPack(appearance.global_css, tmpRoot, "CSS/A");
      if (rel) {
        thset.paths.global_css = rel;
        appearance.global_css = "__PACK_CSS_A__";
      }
    }
    // 主页 CSS
    if (appearance.home_css && fs.existsSync(appearance.home_css)) {
      const rel = copyIntoPack(appearance.home_css, tmpRoot, "CSS/HOME");
      if (rel) {
        thset.paths.home_css = rel;
        appearance.home_css = "__PACK_CSS_HOME__";
      }
    }

    // 壁纸
    if (appearance.bg_source && fs.existsSync(appearance.bg_source)) {
      const rel = copyIntoPack(appearance.bg_source, tmpRoot, "M");
      if (rel) {
        thset.paths.wallpaper = rel;
        appearance.bg_source = "__PACK_WALLPAPER__";
      }
    }
    if (appearance.global_bg_image && fs.existsSync(appearance.global_bg_image)) {
      const rel = copyIntoPack(appearance.global_bg_image, tmpRoot, "M");
      if (rel) {
        thset.paths.global_bg_image = rel;
        appearance.global_bg_image = "__PACK_WALLPAPER__";
      }
    }

    // 标题栏 SVG
    const svgKeys = ["titlebar_custom_min", "titlebar_custom_max",
                     "titlebar_custom_restore", "titlebar_custom_close"];
    for (const k of svgKeys) {
      const v = appearance[k];
      if (v && fs.existsSync(v)) {
        const rel = copyIntoPack(v, tmpRoot, "SVG");
        if (rel) {
          thset.paths[k] = rel;
          appearance[k] = `__PACK_SVG_${k}__`;
        }
      }
    }

    thset.appearance = appearance;

    fs.writeFileSync(
      path.join(tmpRoot, "thset.json"),
      JSON.stringify(thset, null, 2),
      "utf-8"
    );

    // 打 zip（不压缩）
    const out = outputPath;
    ensureDir(path.dirname(out));

    const zip = new AdmZip();
    zip.addLocalFolder(tmpRoot);
    // store 模式（不压缩）
    for (const entry of zip.getEntries()) {
      entry.header.method = 0;
    }
    zip.writeZip(out);

    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

    xgmclLog.writeLog("INFO", `[ThemePack] 导出成功: ${out}`);
    return { code: 200, msg: "导出成功", path: out };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `[ThemePack] 导出失败: ${e.message}`);
    return { code: 500, msg: `导出失败: ${e.message}` };
  }
}

// ---- 导入 ----
async function importThemePack(packPath, overrideName) {
  try {
    if (!packPath || !fs.existsSync(packPath)) {
      return { code: 400, msg: "文件不存在" };
    }

    const zip = new AdmZip(packPath);
    const thsetEntry = zip.getEntry("thset.json");
    if (!thsetEntry) {
      return { code: 400, msg: "不是合法的主题包（缺 thset.json）" };
    }
    let thset;
    try {
      thset = JSON.parse(thsetEntry.getData().toString("utf-8"));
    } catch (e) {
      return { code: 400, msg: `thset.json 解析失败: ${e.message}` };
    }

    let name = (overrideName || "").trim();
    if (!name) name = path.basename(packPath).replace(/\.xglt$/i, "");
    if (!name) name = "导入的主题";
    name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");

    const localDir = path.join(P.THEME_PACK_DIR, name);
    ensureDir(localDir);

    const tmp = path.join(P.THEME_PACK_DIR, `__tmp_import_${Date.now()}__`);
    ensureDir(tmp);
    try {
      zip.extractAllTo(tmp, true);
    } catch (e) {
      return { code: 500, msg: `解压失败: ${e.message}` };
    }

    const appearance = { ...(thset.appearance || {}) };
    const paths = thset.paths || {};

    if (appearance.global_css === "__PACK_CSS_A__" && paths.global_css) {
      appearance.global_css = copyFromPack(tmp, paths.global_css, localDir, "CSS/A");
    }
    if (appearance.home_css === "__PACK_CSS_HOME__" && paths.home_css) {
      appearance.home_css = copyFromPack(tmp, paths.home_css, localDir, "CSS/HOME");
    }
    if (appearance.bg_source === "__PACK_WALLPAPER__" && paths.wallpaper) {
      appearance.bg_source = copyFromPack(tmp, paths.wallpaper, localDir, "M");
    }
    if (appearance.global_bg_image === "__PACK_WALLPAPER__" && paths.global_bg_image) {
      appearance.global_bg_image = copyFromPack(tmp, paths.global_bg_image, localDir, "M");
    }
    const svgKeys = ["titlebar_custom_min", "titlebar_custom_max",
                     "titlebar_custom_restore", "titlebar_custom_close"];
    for (const k of svgKeys) {
      if (appearance[k] === `__PACK_SVG_${k}__` && paths[k]) {
        appearance[k] = copyFromPack(tmp, paths[k], localDir, "SVG");
      }
    }

    // 原始包留一份
    try {
      const rawDir = path.join(localDir, "XGMCLLDJ");
      ensureDir(rawDir);
      copyFileSafe(packPath, path.join(rawDir, path.basename(packPath)));
    } catch (_) {}

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

    cfgMod.applyUiSettingsFromPack({
      theme: thset.theme || {},
      appearance,
      mode: thset.mode || "custom",
    });

    cfgMod.setActiveThemeName(name);
    cfgMod.setThemeMode("custom");

    xgmclLog.writeLog("INFO", `[ThemePack] 导入成功: ${name}`);
    return { code: 200, msg: `已导入为「${name}」`, themeName: name };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `[ThemePack] 导入失败: ${e.message}`);
    return { code: 500, msg: `导入失败: ${e.message}` };
  }
}

module.exports = {
  exportThemePack,
  importThemePack,
};