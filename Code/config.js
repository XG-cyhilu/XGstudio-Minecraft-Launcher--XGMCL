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

// config.js —— 所有 JSON 配置文件的读写

const fs = require("fs");
const path = require("path");
const P = require("./paths.js");

// ---- 通用读写 ----

function safeLoadJson(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(text);
  } catch (_) {
    return {};
  }
}

function safeSaveJson(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch (e) {
    console.error(`[config] 保存失败 ${filePath}:`, e.message);
    return false;
  }
}

// ---- 全局设置 ----

const DEFAULT_GLOBAL_CONFIG = {
  global_ram: 2048,
  global_java_path: "",
  process_priority: "正常",
  download_source: "bmclapi",
  download_threads: 32,
  default_isolated: false,
  download_mode: "save_dialog",
  modpack_mode: "download_only",
};

function loadGlobalConfig() {
  const d = safeLoadJson(P.GLOBAL_CONFIG);
  return { ...DEFAULT_GLOBAL_CONFIG, ...d };
}

function saveGlobalConfig(cfg) {
  return safeSaveJson(P.GLOBAL_CONFIG, cfg);
}

// ---- JVM 参数 ----

const DEFAULT_JVM = {
  jvm_args: "-XX:+UseG1GC -XX:MaxGCPauseMillis=200",
};

function loadJvmConfig() {
  const d = safeLoadJson(P.JVM_CONFIG);
  return { ...DEFAULT_JVM, ...d };
}

function saveJvmConfig(cfg) {
  return safeSaveJson(P.JVM_CONFIG, cfg);
}

// ---- 版本专属配置 ----

function versionCfgKey(rootPath, versionName) {
  return `${rootPath}|${versionName}`;
}

function loadVersionConfig(rootPath, versionName) {
  const defaults = getGlobalDefaults();
  const all = safeLoadJson(P.VERSION_CFG);
  const key = versionCfgKey(rootPath, versionName);

  if (all[key]) {
    return { ...defaults, ...all[key], _inherited: false };
  }
  return { ...defaults, _inherited: true };
}

function saveVersionConfig(rootPath, versionName, cfg) {
  const all = safeLoadJson(P.VERSION_CFG);
  all[versionCfgKey(rootPath, versionName)] = cfg;
  return safeSaveJson(P.VERSION_CFG, all);
}

function resetVersionConfig(rootPath, versionName) {
  const all = safeLoadJson(P.VERSION_CFG);
  const key = versionCfgKey(rootPath, versionName);
  if (key in all) {
    delete all[key];
    safeSaveJson(P.VERSION_CFG, all);
    return true;
  }
  return false;
}

// 全局默认值（供版本配置继承用）
function getGlobalDefaults() {
  const g = loadGlobalConfig();
  const j = loadJvmConfig();
  return {
    ram: g.global_ram || 2048,
    java_path: g.global_java_path || "",
    priority: g.process_priority || "正常",
    jvm_args: j.jvm_args || "",
    width: 1280,
    height: 720,
    isolated: Boolean(g.default_isolated),
  };
}

// ---- 版本隔离 ----

function getVersionIsolated(rootPath, versionName) {
  const all = safeLoadJson(P.VERSION_CFG);
  const cfg = all[versionCfgKey(rootPath, versionName)] || {};
  if ("isolated" in cfg) {
    return Boolean(cfg.isolated);
  }
  const g = loadGlobalConfig();
  return Boolean(g.default_isolated);
}

// 版本工作目录（PCL 结构：隔离时直接在版本目录下）
function getVersionGameDir(rootPath, versionName, isolated) {
  if (isolated === undefined || isolated === null) {
    isolated = getVersionIsolated(rootPath, versionName);
  }
  if (isolated) {
    return path.join(rootPath, "versions", versionName);
  }
  return rootPath;
}

// ---- 主题色 ----

const DEFAULT_THEME = {
  accent: "#4FC3F7",
  accent2: "#444444",
  danger: "#c0392b",
  bg: "#1f1f1f",
  text: "#ffffff",
  accent_hover: "",
  accent2_hover: "",
  danger_hover: "",
};

function isValidHexColor(s) {
  if (s === "" || s === null || s === undefined) return true;
  if (typeof s !== "string") return false;
  return /^#[0-9a-fA-F]{6}$/.test(s);
}

function importTheme(raw) {
  if (!raw || typeof raw !== "object") return null;
  const merged = { ...DEFAULT_THEME };
  for (const k of Object.keys(DEFAULT_THEME)) {
    const v = raw[k];
    if (typeof v !== "string") continue;
    if (!isValidHexColor(v)) continue;
    merged[k] = v;
  }
  return merged;
}

// 读 color.json 里的 active_theme
function getActiveThemeName() {
  const data = safeLoadJson(P.COLOR_PATH);
  return (data && typeof data.active_theme === "string") ? data.active_theme : "";
}

// 设置 active_theme（不改颜色字段）
function setActiveThemeName(name) {
  const data = safeLoadJson(P.COLOR_PATH);
  data.active_theme = name || "";
  safeSaveJson(P.COLOR_PATH, data);
}

// 方案文件路径
function themeFilePath(name) {
  // 文件名安全化：去掉非法字符
  const safe = String(name || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  if (!safe) return "";
  return path.join(P.THEME_DIR, safe + ".json");
}

// 列出所有方案
function listThemes() {
  const active = getActiveThemeName();
  const result = [{ name: "默认", active: active === "" || active === "默认", builtin: true }];

  if (!fs.existsSync(P.THEME_DIR)) return result;

  const files = [];
  try {
    for (const fn of fs.readdirSync(P.THEME_DIR)) {
      if (!fn.endsWith(".json")) continue;
      const full = path.join(P.THEME_DIR, fn);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        files.push({
          name: fn.slice(0, -5),
          mtime: Math.floor(st.mtimeMs / 1000),
        });
      } catch (_) {}
    }
  } catch (_) {}

  files.sort((a, b) => a.name.localeCompare(b.name, "zh"));

  for (const f of files) {
    if (f.name === "默认") continue;   // 保留"默认"占位，不从文件读
    result.push({ name: f.name, active: f.name === active, builtin: false });
  }
  return result;
}

// 读一个方案（默认 = 内置色）
function loadThemeByName(name) {
  if (!name || name === "默认") {
    // 从 color.json 读字段（老逻辑保留）
    const data = safeLoadJson(P.COLOR_PATH);
    const theme = { ...DEFAULT_THEME };
    if (data && typeof data === "object") {
      for (const k of Object.keys(DEFAULT_THEME)) {
        if (typeof data[k] === "string") theme[k] = data[k];
      }
    }
    return theme;
  }
  const fp = themeFilePath(name);
  if (!fp || !fs.existsSync(fp)) return { ...DEFAULT_THEME };
  const raw = safeLoadJson(fp);
  const theme = { ...DEFAULT_THEME };
  for (const k of Object.keys(DEFAULT_THEME)) {
    if (typeof raw[k] === "string" && isValidHexColor(raw[k])) theme[k] = raw[k];
  }
  return theme;
}

// 当前生效主题：优先 active_theme 方案，没有则默认
function loadTheme() {
  const active = getActiveThemeName();
  return loadThemeByName(active);
}

// 保存主题：更新当前激活方案，没有激活就写 color.json
function saveTheme(theme) {
  const merged = { ...DEFAULT_THEME };
  if (theme && typeof theme === "object") {
    for (const k of Object.keys(DEFAULT_THEME)) {
      if (typeof theme[k] === "string" && isValidHexColor(theme[k])) merged[k] = theme[k];
    }
  }

  const active = getActiveThemeName();
  if (active && active !== "默认") {
    const fp = themeFilePath(active);
    if (fp) safeSaveJson(fp, merged);
  } else {
    // 没激活方案：写 color.json（向后兼容）
    const data = safeLoadJson(P.COLOR_PATH);
    Object.assign(data, merged);
    safeSaveJson(P.COLOR_PATH, data);
  }
  return merged;
}

// 创建新方案（用当前主题的值）
function createTheme(name, theme) {
  if (!name || name === "默认") return { ok: false, msg: "名字不合法" };
  const fp = themeFilePath(name);
  if (!fp) return { ok: false, msg: "名字不合法" };
  if (fs.existsSync(fp)) return { ok: false, msg: "方案已存在" };

  const merged = { ...DEFAULT_THEME };
  const src = theme || loadTheme();
  for (const k of Object.keys(DEFAULT_THEME)) {
    if (typeof src[k] === "string" && isValidHexColor(src[k])) merged[k] = src[k];
  }
  safeSaveJson(fp, merged);
  return { ok: true, name };
}

// 重命名
function renameTheme(oldName, newName) {
  if (!oldName || oldName === "默认") return { ok: false, msg: "默认方案不可重命名" };
  if (!newName || newName === "默认") return { ok: false, msg: "新名字不合法" };
  const oldFp = themeFilePath(oldName);
  const newFp = themeFilePath(newName);
  if (!oldFp || !fs.existsSync(oldFp)) return { ok: false, msg: "方案不存在" };
  if (fs.existsSync(newFp)) return { ok: false, msg: "新名字已存在" };
  try {
    fs.renameSync(oldFp, newFp);
  } catch (e) {
    return { ok: false, msg: e.message };
  }
  // 如果重命名的是当前激活方案，同步更新
  if (getActiveThemeName() === oldName) {
    setActiveThemeName(newName);
  }
  return { ok: true, oldName, newName };
}

// 删除
function deleteTheme(name) {
  if (!name || name === "默认") return { ok: false, msg: "默认方案不可删除" };
  const fp = themeFilePath(name);
  if (!fp || !fs.existsSync(fp)) return { ok: false, msg: "方案不存在" };
  try {
    fs.unlinkSync(fp);
  } catch (e) {
    return { ok: false, msg: e.message };
  }
  // 删的是激活方案 → 切回默认
  if (getActiveThemeName() === name) {
    setActiveThemeName("");
  }
  return { ok: true };
}

// ---- 外观效果 ----

const APPEARANCE_DEFAULTS = {
  glass: false,
  liquid: false,
  btn_alpha: 100,
  btn_alpha_primary: null,
  btn_alpha_secondary: null,
  btn_alpha_danger: null,
  btn_alpha_small: null,
  blur_sidebar: 3,
  blur_card: 8,
  global_bg_image: "",
  global_bg_dim: 20,
  global_bg_blur: 0,
  card_alpha: 100,
  card_dim: 20,
  show_quickbar: true,
  nav_icon_color: "",
  nav_icon_active_color: "",
  nav_icon_hover_color: "",

  // 标题栏
  titlebar_style: "windows",     // "windows" / "mac" / "custom"
  titlebar_custom_size: 30,      // px，自定义图标大小
  titlebar_custom_gap: 8,        // px，自定义按钮间距
  titlebar_custom_anchor: "center", // "left" / "center" / "right"
  titlebar_custom_offset_x: 0,   // px，相对锚点的偏移（锚点 left 时为正，right 时为负更自然）
  titlebar_custom_min: "",       // 最小化 SVG 绝对路径
  titlebar_custom_max: "",       // 全屏 SVG
  titlebar_custom_restore: "",   // 还原 SVG
  titlebar_custom_close: "",     // 关闭 SVG
};

function loadAppearance() {
  const cfg = safeLoadJson(P.APPEARANCE);
  if (!cfg || typeof cfg !== "object") return { ...APPEARANCE_DEFAULTS };
  return { ...APPEARANCE_DEFAULTS, ...cfg };
}

function saveAppearance(cfg) {
  return safeSaveJson(P.APPEARANCE, cfg);
}

// ---- 主页配置 ----

const HOME_DEFAULTS = {
  content_type: "default",
  content_path: "",
  content_opacity: 100,
  global_css: "",
  home_css: "",
  web_url: "https://modrinth.com/",
  web_history: [],
  web_favorites: [{ name: "Modrinth", url: "https://modrinth.com/" }],
};

function loadHomeConfig() {
  const cfg = safeLoadJson(P.HOME_CONFIG);
  return { ...HOME_DEFAULTS, ...cfg };
}

function saveHomeConfig(cfg) {
  return safeSaveJson(P.HOME_CONFIG, cfg);
}

// ---- 下载配置 / 历史 ----

const DOWNLOAD_CFG_DEFAULTS = {
  max_parallel: 16,
  warn_on_close: true,
};

function loadDownloadConfig() {
  const cfg = safeLoadJson(P.DOWNLOAD_CFG);
  return { ...DOWNLOAD_CFG_DEFAULTS, ...cfg };
}

function saveDownloadConfig(cfg) {
  return safeSaveJson(P.DOWNLOAD_CFG, cfg);
}

function loadDownloadHistory() {
  const d = safeLoadJson(P.DOWNLOAD_HIST);
  return d.history || [];
}

function appendDownloadHistory(record) {
  const d = safeLoadJson(P.DOWNLOAD_HIST);
  let history = d.history || [];
  history.push(record);
  if (history.length > 200) history = history.slice(-200);
  safeSaveJson(P.DOWNLOAD_HIST, { history });
}

function clearDownloadHistory() {
  safeSaveJson(P.DOWNLOAD_HIST, { history: [] });
}

// ---- 服务端配置 ----

const SERVER_CFG_DEFAULTS = {
  java_path: "",
  ram_mb: 3072,
  jvm_args: "",
  last_dir: "",
};

function loadServerConfig() {
  const cfg = safeLoadJson(P.SERVER_CFG);
  return { ...SERVER_CFG_DEFAULTS, ...cfg };
}

function saveServerConfig(cfg) {
  return safeSaveJson(P.SERVER_CFG, cfg);
}

// ---- 软件设置 ----

const SOFTWARE_DEFAULTS = {
  nav_show_terminal: false,
  terminal_default_shell: "powershell",
};

function loadSoftwareConfig() {
  const cfg = safeLoadJson(P.SOFTWARE_CFG);
  return { ...SOFTWARE_DEFAULTS, ...cfg };
}

function saveSoftwareConfig(cfg) {
  return safeSaveJson(P.SOFTWARE_CFG, cfg);
}

// ---- XG-Boot 配置 ----

function loadBootConfig() {
  const cfg = safeLoadJson(P.BOOT_CONFIG);
  return { skip_verify: Boolean(cfg.skip_verify) };
}

function saveBootConfig(cfg) {
  return safeSaveJson(P.BOOT_CONFIG, cfg);
}

// ---- 首次运行初始化所有配置文件 ----

function initAllConfigs() {
  P.initXgmclDir();

  const defaults = [
    [P.ROOTS_DB,        { roots: [], active_id: "" }],
    [P.GLOBAL_CONFIG,   DEFAULT_GLOBAL_CONFIG],
    [P.JVM_CONFIG,      DEFAULT_JVM],
    [P.VERSION_CFG,     {}],
    [P.LAST_LAUNCH,     {}],
    [P.HOME_CONFIG,     HOME_DEFAULTS],
    [P.TRUSTED,         { trusted: [] }],
    [P.DOWNLOAD_CFG,    DOWNLOAD_CFG_DEFAULTS],
    [P.SERVER_CFG,      SERVER_CFG_DEFAULTS],
    [P.SOFTWARE_CFG,    SOFTWARE_DEFAULTS],
    [P.COLOR_PATH,      DEFAULT_THEME],
  ];

  for (const [file, val] of defaults) {
    if (!fs.existsSync(file)) {
      safeSaveJson(file, val);
    }
  }
}

module.exports = {
  safeLoadJson,
  safeSaveJson,

  loadGlobalConfig,
  saveGlobalConfig,
  loadJvmConfig,
  saveJvmConfig,

  versionCfgKey,
  loadVersionConfig,
  saveVersionConfig,
  resetVersionConfig,
  getGlobalDefaults,
  getVersionIsolated,
  getVersionGameDir,

  loadTheme,
  loadThemeByName,
  saveTheme,
  isValidHexColor,
  importTheme,
  getActiveThemeName,
  setActiveThemeName,
  listThemes,
  createTheme,
  renameTheme,
  deleteTheme,
  themeFilePath,

  loadAppearance,
  saveAppearance,

  loadHomeConfig,
  saveHomeConfig,

  loadDownloadConfig,
  saveDownloadConfig,
  loadDownloadHistory,
  appendDownloadHistory,
  clearDownloadHistory,

  loadServerConfig,
  saveServerConfig,

  loadSoftwareConfig,
  saveSoftwareConfig,

  loadBootConfig,
  saveBootConfig,

  initAllConfigs,
};