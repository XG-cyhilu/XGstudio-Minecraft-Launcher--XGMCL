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

const { app, BrowserWindow, ipcMain, shell, dialog, protocol } = require("electron");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// 本地模块
const xgmclLog = require("./xgmcl_log.js");
const fabricMod = require("./fabric.js");
const cfgMod = require("./config.js");
const verMod = require("./version.js");
const P = require("./paths.js");
const launcherMod = require("./launcher.js");
const logsMod = require("./logs.js");
const dlMod = require("./download.js");
const mojangMod = require("./mojang.js");
const loadersMod = require("./loaders/index.js");
const modrinthMod = require("./modrinth.js");
const modsMod = require("./mods.js");
const serverMod = require("./server.js");
const xgMod = require("./xg.js");
const avatarMod = require("./avatar.js");
const javaDeepScanMod = require("./java_deep_scan.js");
const upversionMod = require("./upversion.js");
const littleskinMod = require("./littleskin.js");
const modpackMod = require("./modpack.js");
const terminalMod = require("./terminal.js");
const fabricInstallMod = require("./fabric_install.js");
let mainWindow = null;

// ---- 内置游戏目录 ----
function ensureBuiltinInstance() {
  const builtinPath = path.join(P.BASE, ".xgstudiomclauncher");

  // 1. 建目录结构
  const dirs = [
    path.join(builtinPath, "assets"),
    path.join(builtinPath, "libraries"),
    path.join(builtinPath, "versions"),
  ];
  for (const d of dirs) {
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch (e) {
      xgmclLog.writeLog("ERROR", `创建内置目录失败 ${d}: ${e.message}`);
    }
  }

  // 2. 注册到 roots.json
  const db = cfgMod.safeLoadJson(P.ROOTS_DB);
  const roots = db.roots || [];
  const normBuiltin = path.normalize(builtinPath).toLowerCase();

  const existing = roots.find(
    (r) => path.normalize(r.path || "").toLowerCase() === normBuiltin
  );

  if (existing) {
    if (!db.active_id) {
      db.active_id = existing.id;
      cfgMod.safeSaveJson(P.ROOTS_DB, db);
    }
    return;
  }

  const id = require("crypto").randomUUID();
  roots.unshift({
    id,
    name: ".xgstudiomclauncher",
    path: builtinPath,
    builtin: true,
  });
  db.roots = roots;
  db.active_id = id;
  cfgMod.safeSaveJson(P.ROOTS_DB, db);

  xgmclLog.writeLog("INFO", `已注册内置游戏目录: ${builtinPath}`);
}

// ============ 背景协议注册 ============
protocol.registerSchemesAsPrivileged([
  {
    scheme: P.BG_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,       // 视频要流式读取，必须开
      bypassCSP: true,
    },
  },
]);

// ============ 单实例锁 ============

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log("[Single] 已有实例在运行，退出");
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ============ 资源铺放 ============

function killTree(proc) {
  if (!proc || proc.killed) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "ignore" });
    } else {
      proc.kill("SIGKILL");
    }
  } catch (_) {
    try { proc.kill(); } catch (_) {}
  }
}

function ensureResources() {
  if (!app.isPackaged) return;

  const baseDir = path.dirname(app.getPath("exe"));
  const resDir = process.resourcesPath;

  const singles = [
    ["wiki_entries.json", path.join(baseDir, "wiki_entries.json")],
    [path.join("XGMCL", "data", "treasure_links.json"),
     path.join(baseDir, "XGMCL", "data", "treasure_links.json")],
  ];

  for (const [from, to] of singles) {
    const src = path.join(resDir, from);
    if (fs.existsSync(src) && !fs.existsSync(to)) {
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(src, to);
        console.log(`[ensure] ${from} 已铺到 ${to}`);
      } catch (e) {
        console.error(`[ensure] 拷 ${from} 失败:`, e.message);
      }
    }
  }

  const bootSrc = path.join(resDir, "boot_files");
  const xgmclData = path.join(baseDir, "XGMCL", "data");
  for (const sub of ["i18n", "lib", "skins"]) {
    const src = path.join(bootSrc, sub);
    const dst = path.join(xgmclData, sub);
    if (fs.existsSync(src)) {
      try {
        copyDirRecursive(src, dst);
        console.log(`[ensure] ${sub} 已铺到 ${dst}`);
      } catch (e) {
        console.error(`[ensure] 拷 ${sub} 失败:`, e.message);
      }
    }
  }
}

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) {
      copyDirRecursive(s, d);
    } else {
      if (fs.existsSync(d) && fs.statSync(d).size === st.size) continue;
      fs.copyFileSync(s, d);
    }
  }
}

// ============ 窗口控制（自绘标题栏）============

ipcMain.handle("win:minimize", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.minimize();
});

ipcMain.handle("win:maximize", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

ipcMain.handle("win:close", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.close();
});

ipcMain.handle("win:is-maximized", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  return win ? win.isMaximized() : false;
});

// 选 SVG 文件
ipcMain.handle("titlebar:pick_svg", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return "";
  const r = await dialog.showOpenDialog(mainWindow, {
    title: "选择 SVG 图标",
    filters: [{ name: "SVG 图标", extensions: ["svg"] }],
    properties: ["openFile"],
  });
  if (r.canceled || !r.filePaths.length) return "";
  return r.filePaths[0];
});

// 读 SVG 文件内容（返回文本，前端 innerHTML 进去）
ipcMain.handle("titlebar:read_svg", async (_e, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    xgmclLog.writeLog("ERROR", `读 SVG 失败 ${filePath}: ${e.message}`);
    return "";
  }
});

// ============ 弹窗辅助 ============

async function pickDirectory(title) {
  if (!mainWindow || mainWindow.isDestroyed()) return "";
  const r = await dialog.showOpenDialog(mainWindow, {
    title: title || "选择目录",
    properties: ["openDirectory"],
  });
  if (r.canceled || !r.filePaths.length) return "";
  return r.filePaths[0];
}

async function pickFile(title, filters) {
  if (!mainWindow || mainWindow.isDestroyed()) return "";
  const r = await dialog.showOpenDialog(mainWindow, {
    title: title || "选择文件",
    filters: filters || [{ name: "所有文件", extensions: ["*"] }],
    properties: ["openFile"],
  });
  if (r.canceled || !r.filePaths.length) return "";
  return r.filePaths[0];
}

async function pickSaveFile(title, defaultName, filters) {
  if (!mainWindow || mainWindow.isDestroyed()) return "";
  const r = await dialog.showSaveDialog(mainWindow, {
    title: title || "保存文件",
    defaultPath: defaultName || "",
    filters: filters || [{ name: "所有文件", extensions: ["*"] }],
  });
  if (r.canceled || !r.filePath) return "";
  return r.filePath;
}

// ============ 请求体解析 ============

async function parseBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  try {
    return JSON.parse(body);
  } catch (_) {
    return {};
  }
}

// ============ IPC 入口 ============

ipcMain.handle("api:call", async (_e, reqPath, options) => {
  const [pathOnly, queryStr] = String(reqPath || "").split("?");

  const params = {};
  if (queryStr) {
    for (const kv of queryStr.split("&")) {
      const [k, v] = kv.split("=");
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || "");
    }
  }

  const method = ((options && options.method) || "GET").toUpperCase();
  const bodyData = await parseBody(options && options.body);

  try {
    return await route(pathOnly, params, method, bodyData);
  } catch (e) {
    console.error(`[ipc] ${pathOnly} 异常:`, e);
    return { code: 500, msg: e.message };
  }
});

// ============ 路由表 ============

async function route(p, q, method, body) {
  // 调试：记录所有进入的请求
  if (p.startsWith("/server/")) {
    xgmclLog.writeLog("INFO", `[route] ${method} ${p}`);
  }
  // ---- i18n 语言列表 ----
  if (p === "/i18n/list") {
    return i18nList();
  }

  // ---- 启动器日志 ----
  if (p === "/launcher_log/list") {

    return { code: 200, files: xgmclLog.listLogFiles() };
  }
  if (p === "/launcher_log/read") {
    const r = xgmclLog.readLogFile(q.filename || "", parseInt(q.max_lines || "5000", 10));
    if (r.err) return { code: 404, msg: r.err };
    return { code: 200, lines: r.lines };
  }

  if (p === "/launcher_log/compress") {
    const r = xgmclLog.runCompressIfNeeded();
    return { code: 200, msg: `压缩 ${r.compressed} 个，删除 ${r.deleted} 个旧包`, ...r };
  }

  if (p === "/launcher_log/open_folder") {
    await shell.openPath(xgmclLog.getLogDir());
    return { code: 200, msg: "已打开文件夹", path: xgmclLog.getLogDir() };
  }

  // ---- 多 loader 统一入口 ----
  if (p === "/loader/types") {
    return { code: 200, types: loadersMod.listLoaderTypes() };
  }
  if (p === "/loader/loaders") {
    return await loaderFetchLoaders(q);
  }
  if (p === "/loader/install") {
    return await loaderInstall(q);
  }

  // ---- 兼容旧接口（Fabric）----
  if (p === "/fabric/loaders") {
    const loaders = await fabricMod.fetchFabricLoaders(q.mc_version || "");
    return { code: 200, loaders };
  }
  if (p === "/fabric/install") {
    return await fabricInstall(q);
  }

  // ---- Java ----
  if (p === "/java/cache/scan") {
    const javaScan = require("./java_scan.js");
    const list = await javaScan.scanJavaInstallations();
    const data = { time: Math.floor(Date.now() / 1000), list };
    cfgMod.safeSaveJson(P.JAVA_CACHE, data);
    xgmclLog.writeLog("INFO", `扫描 Java: 找到 ${list.length} 个`);
    return { code: 200, data };
  }
  if (p === "/java/cache/get") {
    const data = cfgMod.safeLoadJson(P.JAVA_CACHE);
    if (!data || !data.list) return { code: 200, data: null };
    return { code: 200, data };
  }
  if (p === "/java/deep_scan/start") return javaDeepScanMod.startDeepScan();
  if (p === "/java/deep_scan/cancel") return javaDeepScanMod.cancelDeepScan();
  if (p === "/java/deep_scan/status") return { code: 200, data: javaDeepScanMod.getScanState() };

  // ---- 全局设置 ----
  if (p === "/setting/get") {
    return { code: 200, data: cfgMod.loadGlobalConfig() };
  }
  if (p === "/setting/save") {
    return settingSave(q);
  }

  // ---- JVM ----
  if (p === "/jvm/get") {
    return { code: 200, data: cfgMod.loadJvmConfig() };
  }
  if (p === "/jvm/save") {
    cfgMod.saveJvmConfig({ jvm_args: q.args || "" });
    xgmclLog.writeLog("INFO", `保存 JVM 参数: ${q.args || ""}`);
    return { code: 200, msg: "JVM参数保存成功" };
  }

  // ---- 主题 ----
  if (p === "/theme/get") {
    return { code: 200, data: cfgMod.loadTheme() };
  }
  if (p === "/theme/save") {
    return themeSave(q);
  }
  if (p === "/theme/export") return await themeExport(q);
  if (p === "/theme/import") return await themeImport();
  if (p === "/theme/list") return { code: 200, themes: cfgMod.listThemes(), active: cfgMod.getActiveThemeName() };
  if (p === "/theme/create") return themeCreate(q);
  if (p === "/theme/apply") return themeApply(q);
  if (p === "/theme/delete") return themeDelete(q);
  if (p === "/theme/rename") return themeRename(q);

  // ---- 外观 ----
  if (p === "/appearance/get") {
    return { code: 200, data: cfgMod.loadAppearance() };
  }
  if (p === "/appearance/save") {
    return appearanceSave(q);
  }
  // ---- 动态壁纸 ----
  if (p === "/appearance/browse_bg_folder") {
    const dir = await pickDirectory("选择壁纸文件夹（图片或 mp4）");
    if (!dir) return { code: 400, msg: "未选择文件夹" };
    return { code: 200, path: dir };
  }

  if (p === "/appearance/browse_bg_single") {
    const filePath = await pickFile("选择视频文件", [
      { name: "视频", extensions: ["mp4", "webm", "mkv", "mov"] },
      { name: "所有文件", extensions: ["*"] },
    ]);
    if (!filePath) return { code: 400, msg: "未选择文件" };
    return { code: 200, path: filePath };
  }

  if (p === "/appearance/bg_list") {
    return appearanceBgList();
  }

  if (p === "/appearance/browse_bg") {
    const filePath = await pickFile("选择全局背景图片", [
      { name: "图片", extensions: ["png", "jpg", "jpeg", "bmp", "webp", "gif", "ico"] },
      { name: "所有文件", extensions: ["*"] },
    ]);
    if (!filePath) return { code: 400, msg: "未选择文件" };
    return { code: 200, path: filePath };
  }
  if (p === "/appearance/bg_file") {
    const cfg = cfgMod.loadAppearance();
    const img = cfg.global_bg_image || "";
    if (!img || !fs.existsSync(img)) {
      return { code: 404, msg: "背景图不存在" };
    }
    const buf = fs.readFileSync(img);
    const ext = path.extname(img).slice(1).toLowerCase() || "png";
    const mime = ext === "jpg" ? "jpeg" : ext;
    return { code: 200, data_url: `data:image/${mime};base64,${buf.toString("base64")}` };
  }

  // ---- 根目录 ----
  if (p === "/roots/list") return rootsList();
  if (p === "/roots/add") return await rootsAdd();
  if (p === "/roots/switch") return rootsSwitch(q.root_id || "");
  if (p === "/roots/remove") return rootsRemove(q.root_id || "");
  if (p === "/roots/versions") return rootsVersions(q.root_id || "");

  // ---- 版本详情 / 配置 ----
  if (p === "/version/detail") return versionDetail(q.version_name || "", q.root_id || "");
  if (p === "/version/config/get") return versionConfigGet(q);
  if (p === "/version/config/save") return versionConfigSave(q);
  if (p === "/version/config/reset") return versionConfigReset(q);
  if (p === "/version/open_folder") return await versionOpenFolder(q);
  if (p === "/version/rename") return versionRename(q);
  if (p === "/version/delete") return versionDelete(q);
  if (p === "/version/isolate/toggle") return versionIsolateToggle(q);

  // ---- LittleSkin ----
  if (p === "/littleskin/start_login") return await littleskinMod.startLogin();
  if (p === "/littleskin/poll") return await littleskinMod.poll();
  if (p === "/littleskin/complete") return littleskinMod.complete(q.profile_name || "", q.profile_id || "");


  // ---- 一键升级 ----
  if (p === "/version/upversion/start") return await upversionStart(q);
  if (p === "/version/upversion/result") return upversionResult(q);

  // ---- Modpack 导入 / 导出 ----
  if (p === "/modpack/detect") return modpackDetect(q);
  if (p === "/modpack/import") return await modpackImport(q);
  if (p === "/modpack/export") return await modpackExport(q);
  if (p === "/modpack/pick_file") return await modpackPickFile();
  if (p === "/modpack/pick_save") return await modpackPickSave(q);

  // ---- 版本 mods ----
  if (p === "/version/mods/list") return versionModsList(q);
  if (p === "/version/mods/toggle") return versionModsToggle(q);
  if (p === "/version/mods/delete") return versionModsDelete(q);
  if (p === "/version/mods/open_folder") return await versionModsOpenFolder(q);
  if (p === "/version/mods/import") return versionModsImport(q);
  if (p === "/version/mods/read_file") return versionModsReadFile(q);
  if (p === "/version/mods/meta_list") return versionModsMetaList(q);
  if (p === "/version/mods/meta_save") return versionModsMetaSave(body);

  // ---- 游戏启动 ----
  if (p === "/game/launch") return await gameLaunch(q.version_name || "", q.root_id || "");
  if (p === "/game/launch_progress") return { code: 200, data: launcherMod.getLaunchState() };
  if (p === "/game/is_alive") {
    const pid = parseInt(q.pid || "0", 10) || 0;
    return { code: 200, alive: launcherMod.isProcessAlive(pid) };
  }
  if (p === "/game/kill") {
    return await launcherMod.killGame(parseInt(q.pid || "0", 10) || 0);
  }
  if (p === "/game/last_launch") return gameLastLaunch();

  // ---- 游戏日志 ----
  if (p === "/logs/tail") return logsTail(q);
  if (p === "/logs/since") return logsSince(q);
  if (p === "/logs/full") return logsFull(q);
  if (p === "/logs/open_folder") return await logsOpenFolder(q);

  // ---- 通用日志（其他 Tab）----
  if (p === "/logs/browse_any") {
    const filePath = await pickFile("选择日志文件", [
      { name: "日志文件", extensions: ["log", "txt"] },
      { name: "所有文件", extensions: ["*"] },
    ]);
    if (!filePath) return { code: 400, msg: "未选择文件" };
    return { code: 200, path: filePath };
  }
  if (p === "/logs/read_any") return logsReadAny(q, false);
  if (p === "/logs/read_any_full") return logsReadAny(q, true);

  // ---- 账户 ----
  if (p === "/account/list") return accountList();
  if (p === "/account/add") return accountAdd(q);
  if (p === "/account/remove") return accountRemove(q);
  if (p === "/account/select") return accountSelect(q);
  if (p === "/account/detail") return accountDetail(q);
  if (p === "/account/refresh_token") return await accountRefreshToken(q);
  if (p === "/account/avatar") return await accountAvatar(q);
  if (p === "/account/skin") return await accountSkin(q);

  // ---- 主页 ----
  if (p === "/home/get") return { code: 200, data: cfgMod.loadHomeConfig() };
  if (p === "/home/save") return homeSave(q);
  if (p === "/home/browse_content") {
    const filePath = await pickFile("选择主页内容文件", [
      { name: "支持的文件", extensions: ["md", "txt", "json", "log", "html", "htm"] },
      { name: "所有文件", extensions: ["*"] },
    ]);
    if (!filePath) return { code: 400, msg: "未选择文件" };
    return { code: 200, path: filePath };
  }
  if (p === "/home/browse_css") {
    const filePath = await pickFile("选择 CSS 文件", [
      { name: "CSS 文件", extensions: ["css"] },
      { name: "所有文件", extensions: ["*"] },
    ]);
    if (!filePath) return { code: 400, msg: "未选择文件" };
    return { code: 200, path: filePath };
  }
  if (p === "/home/read_file") return homeReadFile(q);
  if (p === "/home/css/read") return homeCssRead(q);
  if (p === "/home/web/set_url") return homeWebSetUrl(q);
  if (p === "/home/web/history/clear") return homeWebHistoryClear();
  if (p === "/home/web/history/remove") return homeWebHistoryRemove(q);
  if (p === "/home/web/favorite/add") return homeWebFavoriteAdd(q);
  if (p === "/home/web/favorite/remove") return homeWebFavoriteRemove(q);
  if (p === "/home/is_trusted") return homeIsTrusted(q);
  if (p === "/home/trust") return homeTrust(q);
  if (p === "/home/untrust") return homeUntrust(q);

  // ---- 下载配置 / 历史 ----
  if (p === "/download/config/get") return { code: 200, data: cfgMod.loadDownloadConfig() };
  if (p === "/download/config/save") return downloadConfigSave(q);
  if (p === "/download/history") return { code: 200, history: cfgMod.loadDownloadHistory() };
  if (p === "/download/history/clear") {
    cfgMod.clearDownloadHistory();
    return { code: 200, msg: "已清空" };
  }

  // ---- 下载任务 ----
  if (p === "/download/tasks") {
    const tasks = dlMod.listTasks().map((t) => ({ ...t }));
    tasks.sort((a, b) => (b.start_time || 0) - (a.start_time || 0));
    return { code: 200, tasks };
  }
  if (p === "/download/task") {
    const t = dlMod.getTask(q.task_id || "");
    if (!t) return { code: 404, msg: "任务不存在" };
    return { code: 200, task: { ...t } };
  }
  if (p === "/download/cancel") {
    dlMod.setTaskField(q.task_id || "", "cancel", true);
    xgmclLog.writeLog("INFO", `取消下载任务: ${q.task_id}`);
    return { code: 200, msg: "已发送取消信号" };
  }
  if (p === "/download/remove") {
    const t = dlMod.getTask(q.task_id || "");
    if (!t) return { code: 404, msg: "任务不存在" };
    if (t.active) return { code: 400, msg: "任务还在进行中，先取消" };
    dlMod.removeTask(q.task_id);
    return { code: 200, msg: "已移除" };
  }
  if (p === "/download/active_count") {
    const n = dlMod.listTasks().filter((t) => t.active).length;
    return { code: 200, count: n };
  }

  // ---- Mojang ----
  if (p === "/mojang/manifest") return await mojangManifest(q);
  if (p === "/mojang/check_exists") return mojangCheckExists(q);
  if (p === "/mojang/start") return await mojangStart(q);
  if (p === "/mojang/progress") return mojangProgress();

  // ---- Modrinth ----
  if (p === "/modrinth/search") return await modrinthSearch(q);
  if (p === "/modrinth/project") return await modrinthProject(q);
  if (p === "/modrinth/versions") return await modrinthVersions(q);
  if (p === "/modrinth/install") return await modrinthInstall(q);
  if (p === "/modrinth/install_by_type") return await modrinthInstallByType(q);
  if (p === "/modrinth/dep_tree") return await modrinthDepTree(body);
  if (p === "/modrinth/version_from_hash") return await modrinthVersionFromHash(body);

  if (p === "/modrinth/oauth/status") return modrinthMod.oauthStatus();
  if (p === "/modrinth/oauth/login") return await modrinthMod.oauthLogin();
  if (p === "/modrinth/oauth/logout") return modrinthMod.oauthLogout();
  if (p === "/modrinth/user/projects") return await modrinthUserProjects();
  if (p === "/modrinth/user/follows") return await modrinthUserFollows();
  if (p === "/modrinth/user/collections") return await modrinthUserCollections();

  // ---- 服务端 ----
  if (p === "/server/config/get") return { code: 200, data: cfgMod.loadServerConfig() };
  if (p === "/server/config/save") return serverConfigSave(q);
  if (p === "/server/browse_dir") {
    const dir = await pickDirectory("选择服务端根目录");
    if (!dir) return { code: 400, msg: "未选择目录" };
    return { code: 200, path: dir };
  }
  if (p === "/server/detect") return serverDetect(q);
  if (p === "/server/properties/get") return serverPropertiesGet(q);
  if (p === "/server/properties/save") return serverPropertiesSave(q);
  if (p === "/server/whitelist/get") return serverWhitelistGet(q);
  if (p === "/server/whitelist/save") return serverWhitelistSave(q);
  if (p === "/server/ops/get") return serverOpsGet(q);
  if (p === "/server/ops/save") return serverOpsSave(q);
  if (p === "/server/start") return serverStart(q);
  if (p === "/server/stop") return await serverStop();
  if (p === "/server/status") return serverStatus();
  if (p === "/server/console/tail") return serverConsoleTail(q);
  if (p === "/server/console/command") return serverConsoleCommand(q);
  if (p === "/server/plugins/list") return serverPluginsList(q);
  if (p === "/server/plugins/delete") return serverPluginsDelete(q);
  if (p === "/server/plugins/open_folder") return await serverPluginsOpenFolder(q);
  if (p === "/server/plugins/search") return await serverPluginsSearch(q);
  if (p === "/server/plugins/install") return await serverPluginsInstall(q);
  if (p === "/server/install_fabric") return await serverInstallFabric(q);
  if (p === "/server/check_ip") return await serverCheckIp();
  if (p === "/treasure/links") {
    const p1 = path.join(path.dirname(app.getPath("exe")), "XGMCL", "data", "treasure_links.json");
    const p2 = path.join(P.BASE, "XGMCL", "data", "treasure_links.json");
    const filePath = fs.existsSync(p1) ? p1 : p2;
    if (!fs.existsSync(filePath)) return { code: 404, msg: "treasure_links.json 不存在" };
    try {
      return { code: 200, data: JSON.parse(fs.readFileSync(filePath, "utf-8")) };
    } catch (e) {
      return { code: 500, msg: "解析失败: " + e.message };
    }
  }

  if (p === "/open_external") {
    const url = q.url || "";
    if (!url || !/^https?:\/\//i.test(url)) return { code: 400, msg: "URL 不合法" };
    await shell.openExternal(url);
    return { code: 200, msg: "已打开" };
  }

  // ---- 测试版提示 ----
  if (p === "/beta/check") {
    const flagPath = path.join(P.SETTING_ROOT, ".beta_seen");
    const shouldShow = !fs.existsSync(flagPath);
    return { code: 200, show: shouldShow };
  }
  if (p === "/beta/mark_seen") {
    const flagPath = path.join(P.SETTING_ROOT, ".beta_seen");
    try {
      fs.writeFileSync(flagPath, String(Date.now()));
      return { code: 200, msg: "已记录" };
    } catch (e) {
      return { code: 500, msg: e.message };
    }
  }

  // ---- XGstudio 账号 ----
  // ---- 软件设置 ----
  if (p === "/software/config/get") {
    return { code: 200, data: cfgMod.loadSoftwareConfig() };
  }
  if (p === "/software/config/save") {
    const cfg = cfgMod.loadSoftwareConfig();
    if (q.nav_show_terminal !== undefined) {
      cfg.nav_show_terminal = q.nav_show_terminal === "1";
    }
    if (q.terminal_default_shell !== undefined) {
      cfg.terminal_default_shell = q.terminal_default_shell || "powershell";
    }
    cfgMod.saveSoftwareConfig(cfg);
    xgmclLog.writeLog("INFO",
      `[Software] 保存: nav_show_terminal=${cfg.nav_show_terminal}, default_shell=${cfg.terminal_default_shell}`
    );
    return { code: 200, msg: "已保存", data: cfg };
  }

  // ---- 内置终端 ----
  if (p === "/terminal/shells") {
    return { code: 200, shells: terminalMod.detectShells() };
  }
  if (p === "/terminal/start") {
    return terminalMod.startSession(q.shell || "powershell");
  }
  if (p === "/terminal/input") {
    return terminalMod.writeInput(body.session_id || "", body.data || "");
  }
  if (p === "/terminal/output") {
    return terminalMod.readOutput(q.session_id || "", q.offset || "0");
  }
  if (p === "/terminal/stop") {
    return terminalMod.stopSession(body.session_id || q.session_id || "");
  }
  if (p === "/terminal/list") {
    return { code: 200, sessions: terminalMod.listSessions() };
  }

  if (p === "/xg/status") return await xgMod.status();
  if (p === "/xg/login") return await xgMod.login(q.username || "", q.password || "");
  if (p === "/xg/logout") return await xgMod.logout();
  if (p === "/xg/devmode") {
    const s = xgMod.getSession();
    return { code: 200, devmode: Boolean(s.logged_in) };
  }

  // ---- XG-Boot 配置 ----
  if (p === "/boot/config/get") return { code: 200, data: cfgMod.loadBootConfig() };
  if (p === "/boot/config/save") {
    const cfg = { skip_verify: q.skip_verify === "1" };
    cfgMod.saveBootConfig(cfg);
    xgmclLog.writeLog("INFO", `保存 XG-Boot 配置: skip_verify=${cfg.skip_verify}`);
    return { code: 200, msg: "已保存", data: cfg };
  }

  return { code: 404, msg: `未实现的接口: ${p} (method=${method})` };
}

// ====================================================
// 业务函数
// ====================================================

// ---- 设置 ----

// 扫 i18n 目录，返回语言列表
// 每一项：{ code, name, flag, fallback, order }
function i18nList() {
  const dir = path.join(P.BASE, "XGMCL", "data", "i18n");

  if (!fs.existsSync(dir)) {
    return { code: 200, list: [] };
  }

  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    xgmclLog.writeLog("WARN", `[i18n] 读目录失败 ${dir}: ${e.message}`);
    return { code: 200, list: [] };
  }

  const list = [];
  for (const fn of names) {
    if (!fn.toLowerCase().endsWith(".json")) continue;
    const code = fn.slice(0, -5);   // 去掉 .json

    // 跳过 index.json / 非语言文件
    if (code === "index") continue;

    const full = path.join(dir, fn);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(full, "utf-8"));
    } catch (e) {
      xgmclLog.writeLog("WARN", `[i18n] 解析失败 ${fn}: ${e.message}`);
      continue;
    }

    // 从 _meta 里读元信息，没有就给默认值
    const meta = data["_meta.name"] !== undefined
      ? {
          name: data["_meta.name"] || code,
          flag: data["_meta.flag"] || "",
          fallback: Array.isArray(data["_meta.fallback"]) ? data["_meta.fallback"] : ["en-US"],
          order: typeof data["_meta.order"] === "number" ? data["_meta.order"] : 9999,
        }
      : {
          // 老文件没 _meta → 用文件名兜底
          name: code,
          flag: "",
          fallback: ["en-US"],
          order: 9999,
        };

    list.push({
      code,
      name: meta.name,
      flag: meta.flag,
      fallback: meta.fallback,
      order: meta.order,
    });
  }

  // 排序：先按 order 升序，order 相同按 name 字母序
  list.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.name.localeCompare(b.name, "zh");
  });

  xgmclLog.writeLog("INFO", `[i18n] 扫描到 ${list.length} 种语言: ${list.map(x => x.code).join(", ")}`);
  return { code: 200, list };
}

function settingSave(q) {
  let threads = parseInt(q.download_threads || "32", 10);
  threads = Math.max(4, Math.min(threads, 256));
  const data = {
    global_ram: parseInt(q.ram || "2048", 10),
    global_java_path: q.java_path || "",
    process_priority: q.priority || "正常",
    download_source: q.download_source || "bmclapi",
    download_threads: threads,
    default_isolated: q.default_isolated === "1",
    download_mode: q.download_mode || "save_dialog",
    modpack_mode: q.modpack_mode || "download_only",
  };
  cfgMod.saveGlobalConfig(data);
  xgmclLog.writeLog("INFO",
    `保存全局设置: RAM=${data.global_ram}MB, Java=${data.global_java_path || "(默认)"}, ` +
    `优先级=${data.process_priority}, 源=${data.download_source}, 线程=${threads}, ` +
    `默认隔离=${data.default_isolated}`
  );
  return { code: 200, msg: "全局设置保存成功", data };
}

function themeSave(q) {
  let parsed = {};
  try {
    parsed = JSON.parse(q.data || "{}");
  } catch (e) {
    return { code: 400, msg: `data 不是合法 JSON: ${e.message}` };
  }
  if (!parsed || typeof parsed !== "object") {
    return { code: 400, msg: "data 必须是 JSON 对象" };
  }
  const merged = cfgMod.saveTheme(parsed);
  xgmclLog.writeLog("INFO", `保存主题色: accent=${merged.accent}, bg=${merged.bg}`);
  return { code: 200, msg: "主题已保存", data: merged };
}

function themeCreate(q) {
  const name = (q.name || "").trim();
  if (!name) return { code: 400, msg: "名字不能为空" };
  if (name === "默认") return { code: 400, msg: "名字不合法" };
  const r = cfgMod.createTheme(name, null);
  if (!r.ok) return { code: 400, msg: r.msg };
  cfgMod.setActiveThemeName(name);
  xgmclLog.writeLog("INFO", `创建主题方案: ${name}`);
  return { code: 200, msg: "已创建", name };
}

function themeApply(q) {
  const name = (q.name || "").trim();
  if (!name || name === "默认") {
    cfgMod.setActiveThemeName("");
    const theme = cfgMod.loadTheme();
    xgmclLog.writeLog("INFO", "切换到默认主题");
    return { code: 200, msg: "已切到默认", data: theme, active: "" };
  }
  const fp = cfgMod.themeFilePath(name);
  if (!fp || !fs.existsSync(fp)) {
    return { code: 404, msg: `方案不存在: ${name}` };
  }
  cfgMod.setActiveThemeName(name);
  const theme = cfgMod.loadThemeByName(name);
  xgmclLog.writeLog("INFO", `切换主题: ${name}`);
  return { code: 200, msg: "已切换", data: theme, active: name };
}

function themeDelete(q) {
  const name = (q.name || "").trim();
  const r = cfgMod.deleteTheme(name);
  if (!r.ok) return { code: 400, msg: r.msg };
  xgmclLog.writeLog("INFO", `删除主题方案: ${name}`);
  return { code: 200, msg: "已删除" };
}

function themeRename(q) {
  const oldName = (q.old || "").trim();
  const newName = (q.new || "").trim();
  const r = cfgMod.renameTheme(oldName, newName);
  if (!r.ok) return { code: 400, msg: r.msg };
  xgmclLog.writeLog("INFO", `重命名主题: ${oldName} → ${newName}`);
  return { code: 200, msg: "已重命名" };
}

async function themeExport(q) {
  const name = (q && q.name) ? q.name.trim() : "";
  const theme = name ? cfgMod.loadThemeByName(name) : cfgMod.loadTheme();

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const defaultName = `${name || "xgmcl-theme"}-${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}.json`;

  const saved = await pickSaveFile("导出主题", defaultName, [
    { name: "XGMCL 主题", extensions: ["json"] },
    { name: "所有文件", extensions: ["*"] },
  ]);
  if (!saved) return { code: 400, msg: "用户取消" };

  try {
    fs.writeFileSync(saved, JSON.stringify(theme, null, 2), "utf-8");
    xgmclLog.writeLog("INFO", `主题已导出: ${saved}`);
    return { code: 200, msg: "导出成功", path: saved };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `导出主题失败: ${e.message}`);
    return { code: 500, msg: `导出失败: ${e.message}` };
  }
}

async function themeImport() {
  const filePath = await pickFile("选择主题文件", [
    { name: "XGMCL 主题", extensions: ["json"] },
    { name: "所有文件", extensions: ["*"] },
  ]);
  if (!filePath) return { code: 400, msg: "用户取消" };

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    return { code: 400, msg: `文件不是合法 JSON: ${e.message}` };
  }

  const merged = cfgMod.importTheme(raw);
  if (!merged) return { code: 400, msg: "文件格式不对，或没有有效字段" };

  let baseName = path.basename(filePath, ".json").replace(/\.xgmcltheme$/i, "");
  if (!baseName) baseName = "导入的主题";

  let finalName = baseName;
  let n = 1;
  while (cfgMod.themeFilePath(finalName) && fs.existsSync(cfgMod.themeFilePath(finalName))) {
    finalName = `${baseName}-copy${n > 1 ? n : ""}`;
    n++;
    if (n > 100) break;
  }

  const r = cfgMod.createTheme(finalName, merged);
  if (!r.ok) return { code: 500, msg: `创建方案失败: ${r.msg}` };

  cfgMod.setActiveThemeName(finalName);
  xgmclLog.writeLog("INFO", `主题已导入为方案: ${finalName}`);
  return { code: 200, msg: `已导入为方案「${finalName}」`, data: merged, name: finalName };
}

// 列出背景文件夹里的所有图片 / 视频（按文件名排序）
function appearanceBgList() {
  const cfg = cfgMod.loadAppearance();
  const src = cfg.bg_source || "";
  if (!src || !fs.existsSync(src)) {
    return { code: 200, items: [], mode: cfg.bg_mode || "static" };
  }

  const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".bmp", ".webp", ".gif"]);
  const VID_EXT = new Set([".mp4", ".webm", ".mkv", ".mov"]);

  // 单文件模式：就返回那一个
  if (cfg.bg_mode === "single_video") {
    const ext = path.extname(src).toLowerCase();
    if (!VID_EXT.has(ext)) {
      return { code: 200, items: [], mode: cfg.bg_mode };
    }
    return {
      code: 200,
      mode: cfg.bg_mode,
      items: [{
        path: src,
        name: path.basename(src),
        type: "video",
        url: `${P.BG_PROTOCOL}://local/${encodeURIComponent(src.replace(/\\/g, "/"))}`,
      }],
    };
  }

  // 文件夹模式：扫所有
  if (!fs.statSync(src).isDirectory()) {
    return { code: 200, items: [], mode: cfg.bg_mode };
  }

  let names = [];
  try {
    names = fs.readdirSync(src);
  } catch (e) {
    xgmclLog.writeLog("WARN", `[bg] 读目录失败 ${src}: ${e.message}`);
    return { code: 200, items: [], mode: cfg.bg_mode };
  }

  // 自然排序（1,2,10 而不是 1,10,2）
  names.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
  );

  const items = [];
  for (const name of names) {
    const full = path.join(src, name);
    let st;
    try {
      st = fs.statSync(full);
      if (!st.isFile()) continue;
    } catch (_) { continue; }

    const ext = path.extname(name).toLowerCase();
    let type = "";
    if (IMG_EXT.has(ext)) type = "image";
    else if (VID_EXT.has(ext)) type = "video";
    else continue;

    items.push({
      path: full,
      name,
      type,
      url: `${P.BG_PROTOCOL}://local/${encodeURIComponent(full.replace(/\\/g, "/"))}`,
    });
  }

  return {
    code: 200,
    mode: cfg.bg_mode,
    items,
    count: items.length,
  };
}

function appearanceSave(q) {
  const cfg = cfgMod.loadAppearance();

  function setCat(key, val) {
    if (val === "__keep__") return;
    if (val === "__null__" || val === "") {
      cfg[key] = null;
    } else {
      const n = parseInt(val, 10);
      if (!isNaN(n)) cfg[key] = Math.max(0, Math.min(100, n));
    }
  }

  const intOr = (v, def) => {
    if (v === undefined || v === "") return def;
    const n = parseInt(v, 10);
    return isNaN(n) ? def : n;
  };

  if (q.glass !== undefined) cfg.glass = q.glass === "1";
  if (q.liquid !== undefined) cfg.liquid = q.liquid === "1";

  // ---- 动态壁纸 ----
  if (q.bg_mode !== undefined && q.bg_mode !== "__keep__") {
    const allowed = new Set(["static", "slideshow_folder", "single_video", "video_folder"]);
    cfg.bg_mode = allowed.has(q.bg_mode) ? q.bg_mode : "static";
  }
  if (q.bg_source !== undefined && q.bg_source !== "__keep__") {
    cfg.bg_source = q.bg_source || "";
  }
  if (q.bg_slideshow_interval !== undefined && q.bg_slideshow_interval !== "") {
    const n = parseInt(q.bg_slideshow_interval, 10);
    if (!isNaN(n)) cfg.bg_slideshow_interval = Math.max(3, Math.min(600, n));
  }
  if (q.bg_video_muted !== undefined) cfg.bg_video_muted = q.bg_video_muted === "1";
  if (q.bg_video_loop !== undefined) cfg.bg_video_loop = q.bg_video_loop === "1";
  if (q.btn_alpha !== undefined) cfg.btn_alpha = Math.max(0, Math.min(100, intOr(q.btn_alpha, 100)));
  if (q.blur_sidebar !== undefined) cfg.blur_sidebar = Math.max(0, Math.min(30, intOr(q.blur_sidebar, 3)));
  if (q.blur_card !== undefined) cfg.blur_card = Math.max(0, Math.min(30, intOr(q.blur_card, 8)));
  if (q.global_bg_dim !== undefined) cfg.global_bg_dim = Math.max(0, Math.min(100, intOr(q.global_bg_dim, 20)));
  if (q.global_bg_blur !== undefined) cfg.global_bg_blur = Math.max(0, Math.min(30, intOr(q.global_bg_blur, 0)));
  if (q.global_bg_image !== undefined && q.global_bg_image !== "__keep__") {
    cfg.global_bg_image = q.global_bg_image || "";
  }
  if (q.card_alpha !== undefined) cfg.card_alpha = Math.max(0, Math.min(100, intOr(q.card_alpha, 100)));
  if (q.card_dim !== undefined) cfg.card_dim = Math.max(0, Math.min(100, intOr(q.card_dim, 20)));
  if (q.show_quickbar !== undefined) cfg.show_quickbar = q.show_quickbar === "1";
  if (q.show_quickbar !== undefined) cfg.show_quickbar = q.show_quickbar === "1";

  // ★ 标题栏
  if (q.titlebar_style !== undefined && q.titlebar_style !== "__keep__") {
    const allowed = new Set(["windows", "mac", "custom"]);
    cfg.titlebar_style = allowed.has(q.titlebar_style) ? q.titlebar_style : "windows";
  }
  if (q.titlebar_custom_size !== undefined && q.titlebar_custom_size !== "") {
    let n = parseInt(q.titlebar_custom_size, 10);
    if (!isNaN(n)) cfg.titlebar_custom_size = Math.max(8, Math.min(128, n));
  }
  if (q.titlebar_custom_gap !== undefined && q.titlebar_custom_gap !== "") {
    let n = parseInt(q.titlebar_custom_gap, 10);
    if (!isNaN(n)) cfg.titlebar_custom_gap = Math.max(0, Math.min(100, n));
  }
  if (q.titlebar_custom_offset_x !== undefined && q.titlebar_custom_offset_x !== "") {
    let n = parseInt(q.titlebar_custom_offset_x, 10);
    if (!isNaN(n)) cfg.titlebar_custom_offset_x = n;
  }
  if (q.titlebar_custom_anchor !== undefined && q.titlebar_custom_anchor !== "") {
    const allowed = new Set(["left", "center", "right"]);
    cfg.titlebar_custom_anchor = allowed.has(q.titlebar_custom_anchor) ? q.titlebar_custom_anchor : "center";
  }
  if (q.titlebar_custom_min !== undefined) cfg.titlebar_custom_min = q.titlebar_custom_min || "";
  if (q.titlebar_custom_max !== undefined) cfg.titlebar_custom_max = q.titlebar_custom_max || "";
  if (q.titlebar_custom_restore !== undefined) cfg.titlebar_custom_restore = q.titlebar_custom_restore || "";
  if (q.titlebar_custom_close !== undefined) cfg.titlebar_custom_close = q.titlebar_custom_close || "";

  if (q.nav_icon_color !== undefined && q.nav_icon_color !== "__keep__") {
    cfg.nav_icon_color = q.nav_icon_color || "";
  }
  if (q.nav_icon_active_color !== undefined && q.nav_icon_active_color !== "__keep__") {
    cfg.nav_icon_active_color = q.nav_icon_active_color || "";
  }
  if (q.nav_icon_hover_color !== undefined && q.nav_icon_hover_color !== "__keep__") {
    cfg.nav_icon_hover_color = q.nav_icon_hover_color || "";
  }

  setCat("btn_alpha_primary", q.btn_alpha_primary);
  setCat("btn_alpha_secondary", q.btn_alpha_secondary);
  setCat("btn_alpha_danger", q.btn_alpha_danger);
  setCat("btn_alpha_small", q.btn_alpha_small);

  cfgMod.saveAppearance(cfg);
  xgmclLog.writeLog("INFO", `保存外观: glass=${cfg.glass}, liquid=${cfg.liquid}, btn_alpha=${cfg.btn_alpha}`);
  return { code: 200, msg: "已保存", data: cfg };
}

// ---- 根目录 ----

function rootsList() {
  const db = cfgMod.safeLoadJson(P.ROOTS_DB);
  const roots = db.roots || [];
  const activeId = db.active_id || "";

  for (const r of roots) {
    r.valid = verMod.checkRootValid(r.path || "");
    r.active = r.id === activeId;
    r.version_count = r.valid ? verMod.scanVersionsOfRoot(r.path).length : 0;
    // 内置目录标记（前端据此禁用"移除"按钮）
    r.builtin = Boolean(r.builtin);
  }
  return { code: 200, roots, active_id: activeId };
}

async function rootsAdd() {
  const dir = await pickDirectory("选择 Minecraft 游戏根目录");
  if (!dir) {
    xgmclLog.writeLog("WARN", "添加目录: 用户取消");
    return { code: 400, msg: "未选择文件夹" };
  }
  if (!verMod.checkRootValid(dir)) {
    xgmclLog.writeLog("WARN", `添加目录失败: ${dir} 不是合法 MC 根目录`);
    return { code: 400, msg: "该目录不是合法的 MC 根目录（需含 versions 和 libraries）" };
  }

  const db = cfgMod.safeLoadJson(P.ROOTS_DB);
  const roots = db.roots || [];

  for (const r of roots) {
    if ((r.path || "").toLowerCase() === dir.toLowerCase()) {
      return { code: 400, msg: "该目录已经添加过" };
    }
  }

  const newId = require("crypto").randomUUID();
  const newRoot = { id: newId, name: path.basename(dir) || dir, path: dir };
  roots.push(newRoot);
  db.roots = roots;
  if (!db.active_id) db.active_id = newId;

  cfgMod.safeSaveJson(P.ROOTS_DB, db);
  xgmclLog.writeLog("INFO", `添加目录成功: ${newRoot.name} (${dir})`);
  return { code: 200, msg: "目录添加成功", root: newRoot };
}

function rootsSwitch(rootId) {
  const db = cfgMod.safeLoadJson(P.ROOTS_DB);
  const roots = db.roots || [];
  const found = roots.find((r) => r.id === rootId);
  if (!found) {
    xgmclLog.writeLog("ERROR", `切换目录失败: 目录不存在 (${rootId})`);
    return { code: 400, msg: "目录不存在" };
  }
  if (!verMod.checkRootValid(found.path)) {
    xgmclLog.writeLog("ERROR", `切换目录失败: 目录已失效 (${found.path})`);
    return { code: 400, msg: "该目录已失效" };
  }
  db.active_id = rootId;
  cfgMod.safeSaveJson(P.ROOTS_DB, db);
  xgmclLog.writeLog("INFO", `切换目录: ${found.name}`);
  return { code: 200, msg: "已切换", root: found };
}

function rootsRemove(rootId) {
  const db = cfgMod.safeLoadJson(P.ROOTS_DB);
  const roots = db.roots || [];
  const removed = roots.find((r) => r.id === rootId);
  if (!removed) return { code: 400, msg: "目录不存在" };

  // 内置目录不允许删除
  if (removed.builtin) {
    return { code: 400, msg: "内置目录不可移除" };
  }

  const newRoots = roots.filter((r) => r.id !== rootId);
  db.roots = newRoots;
  if (db.active_id === rootId) db.active_id = newRoots.length ? newRoots[0].id : "";
  cfgMod.safeSaveJson(P.ROOTS_DB, db);
  xgmclLog.writeLog("INFO", `移除目录: ${removed.name}`);
  return { code: 200, msg: "已移除" };
}

function rootsVersions(rootId) {
  const target = verMod.getRootById(rootId);
  if (!target) return { code: 400, msg: "没有可用的游戏目录", versions: [] };
  if (!verMod.checkRootValid(target.path)) return { code: 400, msg: "目录已失效", versions: [] };

  const rootPath = target.path;
  const verList = verMod.scanVersionsOfRoot(rootPath);
  const allCfg = cfgMod.safeLoadJson(P.VERSION_CFG);

  for (const v of verList) {
    const key = cfgMod.versionCfgKey(rootPath, v.full_name);
    v.has_custom_config = key in allCfg;
    v.isolated = cfgMod.getVersionIsolated(rootPath, v.full_name);

    try {
      const verDir = path.join(rootPath, "versions", v.full_name);
      const modsDir = v.isolated ? path.join(verDir, "mods") : path.join(rootPath, "mods");
      let modCount = 0;
      if (fs.existsSync(modsDir)) {
        for (const fn of fs.readdirSync(modsDir)) {
          if (fn.endsWith(".jar") || fn.endsWith(".jar.disabled")) modCount++;
        }
      }
      v.mod_count = modCount;
      v.mtime = fs.existsSync(verDir) ? Math.floor(fs.statSync(verDir).mtimeMs / 1000) : 0;
    } catch (_) {
      v.mod_count = 0;
      v.mtime = 0;
    }
  }
  return { code: 200, root: target, versions: verList };
}

// ---- 版本详情 / 配置 ----

function versionDetail(versionName, rootId) {
  const target = verMod.getRootById(rootId);
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  if (!verMod.checkRootValid(target.path)) return { code: 400, msg: "目录已失效" };

  const verDir = path.join(target.path, "versions", versionName);
  if (!fs.existsSync(verDir)) return { code: 404, msg: `版本不存在: ${versionName}` };

  const info = verMod.parseVersionInfo(versionName, verDir);
  const jsonPath = path.join(verDir, `${versionName}.json`);

  const detail = {
    full_name: info.full_name,
    show_name: info.show_name,
    game_version: info.game_version,
    loader_type: info.loader_type,
    version_dir: verDir,
    json_path: jsonPath,
    jar_exists: fs.existsSync(path.join(verDir, `${versionName}.jar`)),
    json_exists: fs.existsSync(jsonPath),
    isolated: cfgMod.getVersionIsolated(target.path, versionName),
    game_dir: cfgMod.getVersionGameDir(target.path, versionName),
    mc_version_id: "",
  };

  if (fs.existsSync(jsonPath)) {
    try {
      const vj = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      detail.mc_version_id = vj.clientVersion || vj.inheritsFrom || info.game_version;
      detail.main_class = vj.mainClass || "";
      detail.asset_index = (vj.assetIndex || {}).id || "";
    } catch (e) {
      console.warn(`[version] 读取 ${jsonPath} 失败:`, e.message);
    }
  }

  const key = cfgMod.versionCfgKey(target.path, versionName);
  const allCfg = cfgMod.safeLoadJson(P.VERSION_CFG);
  detail.has_custom_config = key in allCfg;

  return { code: 200, data: detail, root: target };
}

function versionConfigGet(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  const c = cfgMod.loadVersionConfig(target.path, q.version_name || "");
  return { code: 200, data: c };
}

function versionConfigSave(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };

  const ram = parseInt(q.ram || "0", 10) || 2048;
  const c = {
    ram: ram > 0 ? ram : 2048,
    java_path: q.java_path || "",
    priority: q.priority || "正常",
    jvm_args: q.jvm_args || "",
    width: parseInt(q.width || "1280", 10) || 1280,
    height: parseInt(q.height || "720", 10) || 720,
  };
  cfgMod.saveVersionConfig(target.path, q.version_name || "", c);
  xgmclLog.writeLog("INFO", `保存版本配置: ${q.version_name} (RAM=${ram}MB)`);
  return { code: 200, msg: "版本配置已保存", data: c };
}

function versionConfigReset(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  const ok = cfgMod.resetVersionConfig(target.path, q.version_name || "");
  if (ok) {
    xgmclLog.writeLog("INFO", `重置版本配置: ${q.version_name}`);
    return { code: 200, msg: "已恢复继承全局设置" };
  }
  return { code: 200, msg: "本来就没有专属配置" };
}

async function versionOpenFolder(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  const verDir = path.join(target.path, "versions", q.version_name || "");
  if (!fs.existsSync(verDir)) return { code: 404, msg: `版本目录不存在: ${verDir}` };
  await shell.openPath(verDir);
  return { code: 200, msg: "已打开", path: verDir };
}

// ---- 版本重命名 / 删除 / 隔离 ----

function versionRename(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  if (!verMod.checkRootValid(target.path)) return { code: 400, msg: "目录已失效" };

  const oldName = (q.version_name || "").trim();
  const newName = (q.new_name || "").trim();

  if (!newName) return { code: 400, msg: "新名字不能为空" };
  if (oldName === newName) return { code: 400, msg: "新名字跟旧名字一样" };

  const badChars = ["<", ">", ":", '"', "/", "\\", "|", "?", "*"];
  for (const c of badChars) {
    if (newName.includes(c)) return { code: 400, msg: `新名字含有非法字符: ${c}` };
  }

  const versionsRoot = path.join(target.path, "versions");
  const oldDir = path.join(versionsRoot, oldName);
  const newDir = path.join(versionsRoot, newName);

  if (!fs.existsSync(oldDir)) return { code: 404, msg: `旧版本不存在: ${oldName}` };
  if (fs.existsSync(newDir)) return { code: 400, msg: `新名字已被占用: ${newName}` };

  const last = cfgMod.safeLoadJson(P.LAST_LAUNCH);
  if (last.version_name === oldName && last.root_id === target.id) {
    if (last.pid && launcherMod.isProcessAlive(last.pid)) {
      return { code: 400, msg: "游戏正在运行，请关闭游戏后重试" };
    }
  }

  const renamedItems = [];
  try {
    fs.renameSync(oldDir, newDir);
    renamedItems.push(`目录: ${oldName}/ → ${newName}/`);

    const targets = [
      [`${oldName}.json`, `${newName}.json`],
      [`${oldName}.jar`, `${newName}.jar`],
      [`${oldName}-natives`, `${newName}-natives`],
    ];
    for (const [oldItem, newItem] of targets) {
      const oldPath = path.join(newDir, oldItem);
      const newPath = path.join(newDir, newItem);
      if (fs.existsSync(oldPath)) {
        fs.renameSync(oldPath, newPath);
        renamedItems.push(`${oldItem} → ${newItem}`);
      }
    }

    const allCfg = cfgMod.safeLoadJson(P.VERSION_CFG);
    const oldKey = cfgMod.versionCfgKey(target.path, oldName);
    const newKey = cfgMod.versionCfgKey(target.path, newName);
    let cfgMoved = false;
    if (oldKey in allCfg) {
      allCfg[newKey] = allCfg[oldKey];
      delete allCfg[oldKey];
      cfgMod.safeSaveJson(P.VERSION_CFG, allCfg);
      cfgMoved = true;
    }

    if (last.version_name === oldName && last.root_id === target.id) {
      last.version_name = newName;
      cfgMod.safeSaveJson(P.LAST_LAUNCH, last);
    }

    const cpCache = path.join(newDir, ".xgmcl_cp_cache");
    if (fs.existsSync(cpCache)) {
      try {
        fs.unlinkSync(cpCache);
        renamedItems.push("清空 classpath 缓存");
      } catch (_) {}
    }

    xgmclLog.writeLog("INFO", `重命名版本: ${oldName} → ${newName}, 改动 ${renamedItems.length} 项`);
    return {
      code: 200, msg: "重命名成功",
      old_name: oldName, new_name: newName,
      changes: renamedItems, config_moved: cfgMoved,
    };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `重命名版本失败: ${oldName} → ${newName} - ${e.message}`);
    try {
      if (fs.existsSync(newDir) && !fs.existsSync(oldDir)) fs.renameSync(newDir, oldDir);
    } catch (_) {}
    return { code: 500, msg: `重命名失败: ${e.message}` };
  }
}

function versionDelete(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  if (!verMod.checkRootValid(target.path)) return { code: 400, msg: "目录已失效" };

  const versionName = (q.version_name || "").trim();
  if (!versionName) return { code: 400, msg: "版本名不能为空" };

  const verDir = path.join(target.path, "versions", versionName);
  if (!fs.existsSync(verDir)) return { code: 404, msg: `版本不存在: ${versionName}` };

  const last = cfgMod.safeLoadJson(P.LAST_LAUNCH);
  if (last.version_name === versionName && last.root_id === target.id) {
    if (last.pid && launcherMod.isProcessAlive(last.pid)) {
      return { code: 400, msg: "游戏正在运行，请先关闭游戏" };
    }
  }

  const size = dirSize(verDir);

  try {
    fs.rmSync(verDir, { recursive: true, force: true });
  } catch (e) {
    xgmclLog.writeLog("ERROR", `删除版本目录失败 ${verDir}: ${e.message}`);
    return { code: 500, msg: `删除失败: ${e.message}` };
  }

  const key = cfgMod.versionCfgKey(target.path, versionName);
  const allCfg = cfgMod.safeLoadJson(P.VERSION_CFG);
  if (key in allCfg) {
    delete allCfg[key];
    cfgMod.safeSaveJson(P.VERSION_CFG, allCfg);
  }

  if (last.version_name === versionName && last.root_id === target.id) {
    cfgMod.safeSaveJson(P.LAST_LAUNCH, {});
  }

  xgmclLog.writeLog("INFO", `删除版本: ${versionName}（释放 ${formatSize(size)}）`);
  return { code: 200, msg: "版本已删除", freed_bytes: size };
}

function dirSize(dir) {
  let total = 0;
  try {
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      for (const name of fs.readdirSync(cur)) {
        const full = path.join(cur, name);
        try {
          const st = fs.statSync(full);
          if (st.isDirectory()) stack.push(full);
          else total += st.size;
        } catch (_) {}
      }
    }
  } catch (_) {}
  return total;
}

function formatSize(n) {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(2)} ${units[i]}`;
}

function versionIsolateToggle(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  if (!verMod.checkRootValid(target.path)) return { code: 400, msg: "目录已失效" };

  const versionName = q.version_name || "";
  const verDir = path.join(target.path, "versions", versionName);
  if (!fs.existsSync(verDir)) return { code: 404, msg: `版本不存在: ${versionName}` };

  const last = cfgMod.safeLoadJson(P.LAST_LAUNCH);
  if (last.version_name === versionName && last.root_id === target.id) {
    if (last.pid && launcherMod.isProcessAlive(last.pid)) {
      return { code: 400, msg: "游戏正在运行，请关闭游戏后重试" };
    }
  }

  const wantIso = q.enable === "1";
  const key = cfgMod.versionCfgKey(target.path, versionName);
  const allCfg = cfgMod.safeLoadJson(P.VERSION_CFG);
  const c = allCfg[key] || {};
  const oldIso = cfgMod.getVersionIsolated(target.path, versionName);

  c.isolated = wantIso;
  allCfg[key] = c;
  cfgMod.safeSaveJson(P.VERSION_CFG, allCfg);

  if (wantIso) {
    for (const sub of ["saves", "mods", "config", "resourcepacks", "shaderpacks"]) {
      try {
        fs.mkdirSync(path.join(verDir, sub), { recursive: true });
      } catch (e) {
        xgmclLog.writeLog("WARN", `创建隔离目录失败 ${sub}: ${e.message}`);
      }
    }
  }

  const cpCache = path.join(verDir, ".xgmcl_cp_cache");
  if (fs.existsSync(cpCache)) {
    try { fs.unlinkSync(cpCache); } catch (_) {}
  }

  const gameDir = cfgMod.getVersionGameDir(target.path, versionName, wantIso);
  xgmclLog.writeLog("INFO",
    `版本隔离: ${versionName} ${wantIso ? "开启" : "关闭"}（${oldIso} → ${wantIso}），gameDir=${gameDir}`
  );
  return {
    code: 200,
    msg: wantIso ? "已开启版本隔离" : "已关闭版本隔离",
    isolated: wantIso,
    game_dir: gameDir,
  };
}

// ---- 版本 mods ----

function versionModsList(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  if (!verMod.checkRootValid(target.path)) return { code: 400, msg: "目录已失效" };
  try {
    const r = modsMod.listMods(target.path, q.version_name || "");
    return { code: 200, ...r };
  } catch (e) {
    return { code: 500, msg: e.message };
  }
}

function versionModsToggle(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  if (!verMod.checkRootValid(target.path)) return { code: 400, msg: "目录已失效" };
  return modsMod.toggleMod(target.path, q.version_name || "", q.filename || "", q.enable === "1");
}

function versionModsDelete(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  if (!verMod.checkRootValid(target.path)) return { code: 400, msg: "目录已失效" };

  const filenames = (q.filenames || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!filenames.length) return { code: 400, msg: "没有有效的文件名" };

  return modsMod.deleteMods(target.path, q.version_name || "", filenames);
}

async function versionModsOpenFolder(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  if (!verMod.checkRootValid(target.path)) return { code: 400, msg: "目录已失效" };

  const isolated = cfgMod.getVersionIsolated(target.path, q.version_name || "");
  const modsDir = isolated
    ? path.join(target.path, "versions", q.version_name, "mods")
    : path.join(target.path, "mods");

  if (!fs.existsSync(modsDir)) {
    try { fs.mkdirSync(modsDir, { recursive: true }); }
    catch (e) { return { code: 500, msg: `创建目录失败: ${e.message}` }; }
  }

  await shell.openPath(modsDir);
  return { code: 200, msg: "已打开", path: modsDir };
}

function versionModsImport(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  if (!verMod.checkRootValid(target.path)) return { code: 400, msg: "目录已失效" };

  const paths = (q.paths || "").split("|").map((s) => s.trim()).filter(Boolean);
  if (!paths.length) return { code: 400, msg: "没有有效路径" };

  return modsMod.importMods(target.path, q.version_name || "", paths, q.overwrite === "1");
}

function versionModsReadFile(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  if (!verMod.checkRootValid(target.path)) return { code: 400, msg: "目录已失效" };

  const filename = q.filename || "";
  if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return { code: 400, msg: "非法文件名" };
  }

  const isolated = cfgMod.getVersionIsolated(target.path, q.version_name || "");
  const modsDir = isolated
    ? path.join(target.path, "versions", q.version_name, "mods")
    : path.join(target.path, "mods");

  const full = path.join(modsDir, filename);
  if (!fs.existsSync(full)) return { code: 404, msg: `文件不存在: ${filename}` };

  try {
    const buf = fs.readFileSync(full);
    return { code: 200, data_base64: buf.toString("base64"), size: buf.length };
  } catch (e) {
    return { code: 500, msg: e.message };
  }
}

function versionModsMetaList(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  if (!verMod.checkRootValid(target.path)) return { code: 400, msg: "目录已失效" };
  const data = modsMod.listMeta(target.path, q.version_name || "");
  return { code: 200, data };
}

function versionModsMetaSave(body) {
  const versionName = body.version_name || "";
  const rootId = body.root_id || "";
  const metas = body.metas || {};

  if (!versionName) return { code: 400, msg: "version_name 不能为空" };
  if (!metas || typeof metas !== "object") return { code: 400, msg: "metas 必须是对象" };

  const target = verMod.getRootById(rootId);
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  if (!verMod.checkRootValid(target.path)) return { code: 400, msg: "目录已失效" };

  return modsMod.saveMeta(target.path, versionName, metas);
}

// ---- 游戏启动 ----

async function gameLaunch(versionName, rootId) {
  const accounts = cfgMod.safeLoadJson(P.ACCOUNT_PATH);
  let currentAcc = null;
  for (const aid in accounts) {
    if (accounts[aid].selected) { currentAcc = accounts[aid]; break; }
  }
  if (!currentAcc) {
    xgmclLog.writeLog("WARN", "启动游戏失败: 未选择账户");
    return { code: 400, msg: "请先选择登录账户" };
  }

  const target = verMod.getRootById(rootId);
  if (!target) {
    xgmclLog.writeLog("ERROR", "启动游戏失败: 没有可用的游戏目录");
    return { code: 400, msg: "没有可用的游戏目录，请先添加" };
  }
  if (!verMod.checkRootValid(target.path)) return { code: 400, msg: "当前游戏目录已失效" };

  const vcfg = cfgMod.loadVersionConfig(target.path, versionName);
  const ram = vcfg.ram || 2048;
  const java = vcfg.java_path || "java";
  const jvmArgs = vcfg.jvm_args || "";
  const priority = vcfg.priority || "正常";
  const inherited = vcfg._inherited !== false;
  const isolated = cfgMod.getVersionIsolated(target.path, versionName);
  const gameDir = cfgMod.getVersionGameDir(target.path, versionName, isolated);

  xgmclLog.writeLog("INFO", `启动游戏: ${versionName}`);
  xgmclLog.writeLog("INFO", `   目录: ${target.name}`);
  xgmclLog.writeLog("INFO", `   账户: ${currentAcc.username}`);
  xgmclLog.writeLog("INFO", `   内存: ${ram}MB, Java: ${java}, 优先级: ${priority}`);
  xgmclLog.writeLog("INFO", `   配置来源: ${inherited ? "继承全局" : "版本专属"}`);
  xgmclLog.writeLog("INFO", `   版本隔离: ${isolated ? "开启" : "关闭"}，gameDir=${gameDir}`);

  (async () => {
    try {
      const result = await launcherMod.launchGame({
        gameRoot: target.path,
        versionName,
        username: currentAcc.username,
        ramMb: ram,
        javaPath: java,
        jvmArgsExtra: jvmArgs,
        priority,
        isolated,
        gameDir,
      });

      if (result.code === 200) {
        cfgMod.safeSaveJson(P.LAST_LAUNCH, {
          root_id: target.id,
          root_path: target.path,
          version_name: versionName,
          pid: result.pid || 0,
        });
        xgmclLog.writeLog("INFO", `游戏启动成功 (PID=${result.pid})`);
      } else {
        xgmclLog.writeLog("ERROR", `游戏启动失败: ${result.msg}`);
      }
    } catch (e) {
      xgmclLog.writeLog("FATAL", `_launch_worker 未捕获异常: ${e.message}`);
      xgmclLog.writeLog("FATAL", e.stack || "");
    }
  })();

  return { code: 200, msg: "启动已开始" };
}

function gameLastLaunch() {
  const data = cfgMod.safeLoadJson(P.LAST_LAUNCH);
  if (!data || !data.pid) return { code: 200, data: null };
  const alive = launcherMod.isProcessAlive(data.pid);
  return { code: 200, data: { ...data, alive } };
}

// ---- 游戏日志 ----

function logsTail(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  const logPath = logsMod.getLogPath(target.path, q.version_name || "");
  const n = parseInt(q.n || "20", 10) || 20;
  const r = logsMod.readTailLines(logPath, n);
  if (r.err === "not_found") {
    return { code: 404, msg: "读取失败，请先启动游戏或检查路径是否存在", path: logPath };
  }
  if (r.err) return { code: 500, msg: `读取失败: ${r.err}` };
  return { code: 200, lines: r.lines, offset: r.offset, path: logPath };
}

function logsSince(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  const logPath = logsMod.getLogPath(target.path, q.version_name || "");
  const offset = parseInt(q.offset || "0", 10) || 0;
  const maxLines = parseInt(q.max_lines || "500", 10) || 500;
  const r = logsMod.readFromOffset(logPath, offset, maxLines);
  if (r.err === "not_found") return { code: 404, msg: "日志文件不存在", path: logPath };
  if (r.err) return { code: 500, msg: `读取失败: ${r.err}` };
  return { code: 200, lines: r.lines, next_offset: r.next_offset, path: logPath };
}

function logsFull(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  const logPath = logsMod.getLogPath(target.path, q.version_name || "");
  const maxLines = parseInt(q.max_lines || "10000", 10) || 10000;
  const r = logsMod.readFullLog(logPath, maxLines);
  if (r.err === "not_found") {
    return { code: 404, msg: "读取失败，请先启动游戏或检查路径是否存在", path: logPath };
  }
  if (r.err) return { code: 500, msg: `读取失败: ${r.err}` };
  return { code: 200, lines: r.lines, offset: r.size, total: r.total, truncated: r.truncated, path: logPath };
}

async function logsOpenFolder(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  const logPath = logsMod.getLogPath(target.path, q.version_name || "");
  const logDir = path.dirname(logPath);
  if (!fs.existsSync(logDir)) {
    try { fs.mkdirSync(logDir, { recursive: true }); }
    catch (e) { return { code: 400, msg: `目录不存在且无法创建: ${e.message}` }; }
  }
  await shell.openPath(logDir);
  return { code: 200, msg: "已打开文件夹", path: logDir };
}

function logsReadAny(q, full) {
  const filePath = q.path || "";
  if (!filePath || !fs.existsSync(filePath)) return { code: 404, msg: "文件不存在" };
  try {
    const buf = fs.readFileSync(filePath);
    const text = buf.toString("utf-8");
    let lines = text.split(/\r?\n/);
    const total = lines.length;
    let truncated = false;
    if (!full) {
      const maxLines = parseInt(q.max_lines || "5000", 10) || 5000;
      if (total > maxLines) {
        lines = lines.slice(-maxLines);
        truncated = true;
      }
    }
    return { code: 200, lines, total, truncated, path: filePath };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `读通用日志失败 ${filePath}: ${e.message}`);
    return { code: 500, msg: `读取失败: ${e.message}` };
  }
}

// ---- 账户 ----

function offlineMcUuid(username) {
  // offlineUuid 现在直接返回带横杠的标准 UUID
  return verMod.offlineUuid(username);
}

function accountList() {
  const accounts = cfgMod.safeLoadJson(P.ACCOUNT_PATH);

  let changed = false;
  for (const aid in accounts) {
    const acc = accounts[aid];
    if (acc.type === "offline" && !acc.mc_uuid) {
      acc.mc_uuid = offlineMcUuid(acc.username || "");
      changed = true;
    }
  }
  if (changed) cfgMod.safeSaveJson(P.ACCOUNT_PATH, accounts);

  // 排序
  const typePriority = { mojang: 0, littleskin: 1, offline: 2 };
  const sortedIds = Object.keys(accounts).sort((a, b) => {
    const aa = accounts[a], bb = accounts[b];
    const sa = aa.selected ? 0 : 1;
    const sb = bb.selected ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const ta = typePriority[aa.type || "offline"] ?? 9;
    const tb = typePriority[bb.type || "offline"] ?? 9;
    if (ta !== tb) return ta - tb;
    return (aa.username || "").toLowerCase().localeCompare((bb.username || "").toLowerCase());
  });

  const ordered = {};
  for (const id of sortedIds) ordered[id] = accounts[id];
  return { code: 200, accounts: ordered };
}

function accountAdd(q) {
  const username = q.username || "";
  if (!username) return { code: 400, msg: "用户名为空" };

  const accounts = cfgMod.safeLoadJson(P.ACCOUNT_PATH);
  for (const aid in accounts) {
    if (accounts[aid].username === username) {
      return { code: 400, msg: "用户名已存在" };
    }
  }
  const accUuid = require("crypto").randomUUID();
  accounts[accUuid] = {
    username,
    uuid: accUuid,
    type: "offline",
    mc_uuid: offlineMcUuid(username),
    selected: false,
  };
  cfgMod.safeSaveJson(P.ACCOUNT_PATH, accounts);
  xgmclLog.writeLog("INFO", `添加账户: ${username}`);
  return { code: 200, msg: "账户添加成功", account: accounts[accUuid] };
}

function accountRemove(q) {
  const accUuid = q.acc_uuid || "";
  const accounts = cfgMod.safeLoadJson(P.ACCOUNT_PATH);
  if (!(accUuid in accounts)) return { code: 400, msg: "账户不存在" };
  const removed = accounts[accUuid];
  delete accounts[accUuid];
  cfgMod.safeSaveJson(P.ACCOUNT_PATH, accounts);
  xgmclLog.writeLog("INFO", `删除账户: ${removed.username} (${removed.type})`);
  return { code: 200, msg: "账户已删除", username: removed.username || "" };
}

function accountSelect(q) {
  const accUuid = q.acc_uuid || "";
  const accounts = cfgMod.safeLoadJson(P.ACCOUNT_PATH);
  if (!(accUuid in accounts)) return { code: 400, msg: "账户不存在" };
  for (const k in accounts) accounts[k].selected = false;
  accounts[accUuid].selected = true;
  cfgMod.safeSaveJson(P.ACCOUNT_PATH, accounts);
  xgmclLog.writeLog("INFO", `切换账户: ${accounts[accUuid].username}`);
  return { code: 200, msg: "账户切换成功", current: accounts[accUuid] };
}

function accountDetail(q) {
  const accUuid = q.acc_uuid || "";
  const accounts = cfgMod.safeLoadJson(P.ACCOUNT_PATH);
  const acc = accounts[accUuid];
  if (!acc) return { code: 400, msg: "账户不存在" };

  const accType = acc.type || "offline";
  const detail = {
    uuid: accUuid,
    username: acc.username || "",
    type: accType,
    mc_uuid: acc.mc_uuid || "",
    selected: Boolean(acc.selected),
    has_avatar: fs.existsSync(path.join(P.AVATAR_CACHE_DIR, `${accUuid}.png`)),
  };

  if (accType === "littleskin") {
    detail.has_token = Boolean(acc.access_token);
    detail.has_refresh = Boolean(acc.refresh_token);
    detail.expires_at = acc.expires_at || 0;
    detail.token_expired = detail.expires_at > 0 && Date.now() / 1000 > detail.expires_at;
  } else if (accType === "mojang") {
    detail.has_token = Boolean(acc.access_token);
  }
  return { code: 200, data: detail };
}

async function accountRefreshToken(q) {
  const accUuid = q.acc_uuid || "";
  const accounts = cfgMod.safeLoadJson(P.ACCOUNT_PATH);
  const acc = accounts[accUuid];
  if (!acc) return { code: 400, msg: "账户不存在" };
  if (acc.type !== "littleskin") return { code: 400, msg: "仅 LittleSkin 账户支持刷新" };

  const refreshToken = acc.refresh_token || "";
  if (!refreshToken) return { code: 400, msg: "无 refresh_token，需重新登录", need_relogin: true };

  try {
    const body = new URLSearchParams({
      client_id: "client_id",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const res = await fetch("https://open.littleskin.cn/oauth/token", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      xgmclLog.writeLog("WARN", `LittleSkin token 刷新失败: HTTP ${res.status}`);
      return { code: 400, msg: `刷新失败: HTTP ${res.status}`, need_relogin: true };
    }
    const d = await res.json();
    acc.access_token = d.access_token || acc.access_token || "";
    if (d.refresh_token) acc.refresh_token = d.refresh_token;
    const expiresIn = parseInt(d.expires_in || "0", 10);
    if (expiresIn > 0) acc.expires_at = Math.floor(Date.now() / 1000) + expiresIn;
    cfgMod.safeSaveJson(P.ACCOUNT_PATH, accounts);
    xgmclLog.writeLog("INFO", `LittleSkin token 已刷新: ${acc.username}`);
    return { code: 200, msg: "刷新成功", expires_at: acc.expires_at || 0 };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `LittleSkin token 刷新异常: ${e.message}`);
    return { code: 500, msg: `刷新异常: ${e.message}`, need_relogin: true };
  }
}

async function accountAvatar(q) {
  const accUuid = q.acc_uuid || "";
  const accounts = cfgMod.safeLoadJson(P.ACCOUNT_PATH);
  const acc = accounts[accUuid];
  if (!acc) return { code: 404, msg: "账户不存在" };

  const cache = path.join(P.AVATAR_CACHE_DIR, `${accUuid}.png`);
  if (fs.existsSync(cache)) {
    return { code: 200, data_url: `data:image/png;base64,${fs.readFileSync(cache).toString("base64")}` };
  }

  // 离线账户：用原版皮肤生成
  const accType = acc.type || "offline";
  if (accType === "offline" || accType === "mojang") {
    const username = acc.username || accUuid;
    const p = await avatarMod.buildVanillaAvatar(username, accUuid);
    if (p && fs.existsSync(p)) {
      return { code: 200, data_url: `data:image/png;base64,${fs.readFileSync(p).toString("base64")}` };
    }
  }

  return { code: 404, msg: "头像未生成" };
}

async function accountSkin(q) {
  const accUuid = q.acc_uuid || "";
  const accounts = cfgMod.safeLoadJson(P.ACCOUNT_PATH);
  const acc = accounts[accUuid];
  if (!acc) return { code: 404, msg: "账户不存在" };

  const cache = path.join(P.AVATAR_CACHE_DIR, `${accUuid}_full.png`);
  if (fs.existsSync(cache)) {
    return { code: 200, data_url: `data:image/png;base64,${fs.readFileSync(cache).toString("base64")}` };
  }
  return { code: 404, msg: "皮肤未生成" };
}

// ---- 主页 ----

function homeSave(q) {
  const cfg = cfgMod.loadHomeConfig();

  // content_type：__keep__ = 不动
  if (q.content_type !== undefined && q.content_type !== "__keep__") {
    const allowed = new Set(["default", "md", "txt", "log", "html", "web"]);
    let contentType = q.content_type || "default";
    if (!allowed.has(contentType)) contentType = "default";
    cfg.content_type = contentType;
  }

  // content_path：__keep__ = 不动
  if (q.content_path !== undefined && q.content_path !== "__keep__") {
    cfg.content_path = q.content_path || "";
  }

  // content_opacity：__keep__ = 不动
  if (q.content_opacity !== undefined && q.content_opacity !== "__keep__") {
    cfg.content_opacity = parseInt(q.content_opacity || "100", 10) || 100;
  }

  if (q.global_css !== undefined && q.global_css !== "__keep__") {
    cfg.global_css = q.global_css || "";
  }
  if (q.home_css !== undefined && q.home_css !== "__keep__") {
    cfg.home_css = q.home_css || "";
  }

  if (q.web_url && q.web_url !== "__keep__") {
    cfg.web_url = q.web_url || "https://modrinth.com/";
  }

  cfgMod.saveHomeConfig(cfg);
  xgmclLog.writeLog("INFO", `保存主页设置: 内容类型=${contentType}`);
  return { code: 200, msg: "主页设置已保存", data: cfg };
}

function homeCssRead(q) {
  const cfg = cfgMod.loadHomeConfig();
  const scope = (q && q.scope) || "global";
  const cssPath = scope === "home"
    ? (cfg.home_css || "")
    : (cfg.global_css || "");

  if (!cssPath) return { code: 200, content: "", path: "" };
  if (!fs.existsSync(cssPath)) {
    return { code: 404, msg: `CSS 文件不存在: ${cssPath}` };
  }
  try {
    const content = fs.readFileSync(cssPath, "utf-8");
    return { code: 200, content, path: cssPath };
  } catch (e) {
    return { code: 500, msg: `读取失败: ${e.message}` };
  }
}

function homeReadFile(q) {
  let realPath = q.path || "";
  if (!realPath) return { code: 400, msg: "path 为空" };
  if (!path.isAbsolute(realPath)) {
    const target = verMod.getRootById("");
    realPath = target ? path.join(target.path, realPath) : path.resolve(realPath);
  }
  if (!fs.existsSync(realPath)) {
    return { code: 404, msg: `文件不存在: ${realPath}` };
  }
  try {
    const content = fs.readFileSync(realPath, "utf-8");
    return { code: 200, content, path: realPath };
  } catch (e) {
    return { code: 500, msg: `读取失败: ${e.message}` };
  }
}

function homeWebSetUrl(q) {
  let url = (q.url || "").trim();
  if (!url) return { code: 400, msg: "URL 不能为空" };
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  const cfg = cfgMod.loadHomeConfig();
  cfg.web_url = url;

  const history = (cfg.web_history || []).filter((h) => h.url !== url);
  history.unshift({ url, time: Math.floor(Date.now() / 1000) });
  cfg.web_history = history.slice(0, 50);

  cfgMod.saveHomeConfig(cfg);
  xgmclLog.writeLog("INFO", `主页网页: ${url}`);
  return { code: 200, msg: "已设置", data: cfg };
}

function homeWebHistoryClear() {
  const cfg = cfgMod.loadHomeConfig();
  cfg.web_history = [];
  cfgMod.saveHomeConfig(cfg);
  return { code: 200, msg: "历史已清空" };
}

function homeWebHistoryRemove(q) {
  const cfg = cfgMod.loadHomeConfig();
  cfg.web_history = (cfg.web_history || []).filter((h) => h.url !== q.url);
  cfgMod.saveHomeConfig(cfg);
  return { code: 200, msg: "已删除" };
}

function homeWebFavoriteAdd(q) {
  let url = (q.url || "").trim();
  if (!url) return { code: 400, msg: "URL 不能为空" };
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  const cfg = cfgMod.loadHomeConfig();
  const favorites = cfg.web_favorites || [];
  if (favorites.some((f) => f.url === url)) {
    return { code: 400, msg: "已在收藏中" };
  }

  let name = q.name || "";
  if (!name) {
    try { name = new URL(url).host || url; } catch (_) { name = url; }
  }

  favorites.push({ name, url });
  cfg.web_favorites = favorites;
  cfgMod.saveHomeConfig(cfg);
  return { code: 200, msg: "已收藏", data: cfg };
}

function homeWebFavoriteRemove(q) {
  const cfg = cfgMod.loadHomeConfig();
  cfg.web_favorites = (cfg.web_favorites || []).filter((f) => f.url !== q.url);
  cfgMod.saveHomeConfig(cfg);
  return { code: 200, msg: "已移除" };
}

function resolveHomePath(pathStr) {
  if (!pathStr) return "";
  if (path.isAbsolute(pathStr)) return pathStr;
  const target = verMod.getRootById("");
  if (target) return path.join(target.path, pathStr);
  return path.resolve(pathStr);
}

function homeIsTrusted(q) {
  const realPath = resolveHomePath(q.path || "");
  const db = cfgMod.safeLoadJson(P.TRUSTED);
  const trusted = db.trusted || [];
  const norm = path.normalize(realPath).toLowerCase();
  for (const t of trusted) {
    if (path.normalize(t).toLowerCase() === norm) {
      return { code: 200, trusted: true };
    }
  }
  return { code: 200, trusted: false };
}

function homeTrust(q) {
  const realPath = resolveHomePath(q.path || "");
  if (!fs.existsSync(realPath)) return { code: 404, msg: "文件不存在" };

  const db = cfgMod.safeLoadJson(P.TRUSTED);
  const trusted = db.trusted || [];
  const norm = path.normalize(realPath).toLowerCase();
  if (!trusted.some((t) => path.normalize(t).toLowerCase() === norm)) {
    trusted.push(realPath);
  }
  db.trusted = trusted;
  cfgMod.safeSaveJson(P.TRUSTED, db);
  xgmclLog.writeLog("WARN", `信任 HTML 文件: ${realPath}`);
  return { code: 200, msg: "已信任" };
}

function homeUntrust(q) {
  const realPath = resolveHomePath(q.path || "");
  const db = cfgMod.safeLoadJson(P.TRUSTED);
  const norm = path.normalize(realPath).toLowerCase();
  db.trusted = (db.trusted || []).filter((t) => path.normalize(t).toLowerCase() !== norm);
  cfgMod.safeSaveJson(P.TRUSTED, db);
  return { code: 200, msg: "已取消信任" };
}

// ---- 下载配置 ----

function downloadConfigSave(q) {
  const cfg = cfgMod.loadDownloadConfig();
  if (q.max_parallel !== undefined && q.max_parallel !== "") {
    const mp = parseInt(q.max_parallel, 10);
    if (!isNaN(mp)) cfg.max_parallel = Math.max(1, Math.min(16, mp));
  }
  if (q.warn_on_close !== undefined && q.warn_on_close !== "") {
    cfg.warn_on_close = q.warn_on_close === "1";
  }
  cfgMod.saveDownloadConfig(cfg);
  return { code: 200, msg: "已保存", data: cfg };
}

// ---- Mojang ----

async function mojangManifest(q) {
  const source = q.source || "official";
  try {
    const mf = await mojangMod.fetchManifest(source);
    const versions = [];
    for (const v of mf.versions || []) {
      const t = v.type || "";
      if (t === "release" || t === "snapshot") {
        versions.push({ id: v.id, type: t, releaseTime: v.releaseTime, url: v.url });
      }
    }
    xgmclLog.writeLog("INFO", `获取 Mojang 版本列表: ${versions.length} 个 (源=${source})`);
    return { code: 200, versions, latest: mf.latest || {} };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `获取 Mojang 版本列表失败: ${e.message}`);
    return { code: 500, msg: `获取版本列表失败: ${e.message}` };
  }
}

function mojangCheckExists(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  const verDir = path.join(target.path, "versions", q.version_name || "");
  return { code: 200, exists: fs.existsSync(verDir), path: verDir };
}

async function mojangStart(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };

  const dlCfg = cfgMod.loadDownloadConfig();
  const maxParallel = dlCfg.max_parallel || 16;
  const activeCount = dlMod.listTasks().filter((t) => t.active).length;
  if (maxParallel < 16 && activeCount >= maxParallel) {
    return { code: 400, msg: `已达到最大并行任务数 (${maxParallel})，请等待其他任务完成` };
  }

  const versionName = (q.version_name || "").trim();
  if (!versionName) return { code: 400, msg: "版本名不能为空" };

  const verDir = path.join(target.path, "versions", versionName);
  if (fs.existsSync(verDir)) {
    xgmclLog.writeLog("WARN", `下载失败: 版本 ${versionName} 已存在`);
    return { code: 400, msg: `版本 ${versionName} 已存在，请换个名字` };
  }

  const g = cfgMod.loadGlobalConfig();
  const source = q.source || g.download_source || "bmclapi";
  let threads = parseInt(q.threads || "0", 10) || g.download_threads || 32;
  threads = Math.max(4, Math.min(threads, 256));

  const installLoader = q.install_loader === "1";
  const loaderType = (q.loader_type || "").toLowerCase();
  const loaderVersion = q.loader_version || "";
  const downloadFabricApi = q.download_fabric_api === "1";

  const taskType = installLoader ? `combined_${loaderType}` : "vanilla";
  const stageTotal = installLoader ? (downloadFabricApi ? 3 : 2) : 1;

  const taskId = dlMod.createTask({
    task_name: versionName,
    task_type: taskType,
    root_path: target.path,
    mc_version: q.mc_version_id || "",
    source,
    threads,
  });

  Object.assign(dlMod.getTask(taskId), {
    stage_total: stageTotal,
    install_loader: installLoader,
    loader_type: loaderType,
    loader_version: loaderVersion,
    version_name: versionName,
  });

  xgmclLog.writeLog("INFO",
    `开始下载: ${versionName} (MC=${q.mc_version_id}, 源=${source}, ` +
    `线程=${threads}, Loader=${installLoader ? loaderType : "无"}, task_id=${taskId})`
  );

  downloadWorker(taskId, target.path, versionName, q.mc_version_id, q.mc_version_url,
                 source, threads, installLoader, loaderType, loaderVersion, downloadFabricApi)
    .catch((e) => xgmclLog.writeLog("ERROR", `downloadWorker 异常: ${e.message}`));

  return { code: 200, msg: "下载已开始", task_id: taskId };
}

function mojangProgress() {
  const tasks = dlMod.listTasks();
  if (!tasks.length) {
    return {
      code: 200,
      data: { active: false, done: false, total_bytes: 0, downloaded_bytes: 0, files_downloaded: 0, files_skipped: 0 },
    };
  }
  const latest = tasks.reduce((a, b) => (a.start_time > b.start_time ? a : b));
  return { code: 200, data: { ...latest } };
}

async function downloadWorker(taskId, rootPath, versionName, mcVersionId,
                              mcVersionUrl, source, threads,
                              installLoader, loaderType, loaderVersion, downloadFabricApi) {
  try {
    // 阶段 1：原版
    Object.assign(dlMod.getTask(taskId), { stage: 1 });
    await mojangMod.startDownload(rootPath, versionName, mcVersionId, mcVersionUrl,
                                  source, threads, taskId);

    const t1 = dlMod.getTask(taskId);
    if (!t1 || !t1.done || t1.error || t1.cancel) {
      finalizeTaskHistory(taskId);
      return;
    }

    // 阶段 2：loader
    if (installLoader && loaderType && loaderVersion) {
      resetTaskStageProgress(taskId);
      Object.assign(dlMod.getTask(taskId), { stage: 2 });

      const loader = loadersMod.getLoader(loaderType);
      if (!loader) throw new Error(`不支持的 loader: ${loaderType}`);

      await loader.install(
        taskId, rootPath, versionName, mcVersionId,
        loaderVersion, source, threads
      );

      const t2 = dlMod.getTask(taskId);
      if (!t2 || !t2.done || t2.error || t2.cancel) {
        finalizeTaskHistory(taskId);
        return;
      }

      // 阶段 3：Fabric API（仅 Fabric）
      if (downloadFabricApi && loaderType === "fabric") {
        resetTaskStageProgress(taskId);
        Object.assign(dlMod.getTask(taskId), { stage: 3 });
        await fabricApiDownloadWorker(taskId, rootPath, versionName, mcVersionId);
      }
    }

    finalizeTaskHistory(taskId);
  } catch (e) {
    xgmclLog.writeLog("ERROR", `下载 worker 异常: ${e.message}`);
    const t = dlMod.getTask(taskId);
    if (t) { t.error = e.message; t.active = false; }
    finalizeTaskHistory(taskId);
  }
}

function resetTaskStageProgress(taskId) {
  const t = dlMod.getTask(taskId);
  if (!t) return;
  Object.assign(t, {
    active: true, done: false, error: null,
    total_bytes: 0, downloaded_bytes: 0, actual_downloaded_bytes: 0, skipped_bytes: 0,
    files_total: 0, files_done: 0, files_skipped: 0, files_downloaded: 0,
    current_files: [], failed_count: 0, failed_files: [],
  });
}

async function fabricApiDownloadWorker(taskId, rootPath, versionName, mcVersionId) {
  const t = dlMod.getTask(taskId);
  if (!t) return;

  function set(key, val) {
    const tt = dlMod.getTask(taskId);
    if (tt) tt[key] = val;
  }

  try {
    set("current_files", ["查询 Fabric API 版本..."]);
    const info = await modrinthMod.findFabricApiVersion(mcVersionId);
    if (!info) {
      xgmclLog.writeLog("WARN", `未找到匹配 MC ${mcVersionId} 的 Fabric API`);
      set("done", true);
      set("active", false);
      return;
    }

    const isolated = cfgMod.getVersionIsolated(rootPath, versionName);
    const modsDir = isolated
      ? path.join(rootPath, "versions", versionName, "mods")
      : path.join(rootPath, "mods");
    fs.mkdirSync(modsDir, { recursive: true });

    const target = path.join(modsDir, info.filename);

    if (fs.existsSync(target) && info.size && fs.statSync(target).size === info.size) {
      set("done", true); set("active", false);
      set("files_total", 1); set("files_done", 1); set("files_skipped", 1);
      set("total_bytes", info.size); set("downloaded_bytes", info.size); set("skipped_bytes", info.size);
      return;
    }

    set("current_files", [`下载 Fabric API: ${info.filename}`]);
    set("files_total", 1);
    set("total_bytes", info.size || 0);

    await dlMod.downloadOneFile({
      url: info.url, target, sha1: info.sha1 || "", size: info.size || 0, important: true,
    }, "official", 5, taskId);

    set("files_done", 1);
    set("done", true);
    set("active", false);
    xgmclLog.writeLog("INFO", `Fabric API 下载完成: ${target}`);
  } catch (e) {
    xgmclLog.writeLog("ERROR", `Fabric API 下载失败: ${e.message}`);
    set("error", `Fabric API 下载失败: ${e.message}`);
    set("active", false);
  }
}

function finalizeTaskHistory(taskId) {
  try {
    const t = dlMod.getTask(taskId);
    if (!t) return;
    cfgMod.appendDownloadHistory({
      task_name: t.task_name || "",
      task_type: t.task_type || "vanilla",
      result: t.done ? "success" : (t.cancel ? "cancelled" : "failed"),
      downloaded_bytes: t.actual_downloaded_bytes || 0,
      total_bytes: t.total_bytes || 0,
      skipped_bytes: t.skipped_bytes || 0,
      error: t.error || "",
      root_path: t.root_path || "",
      mc_version: t.mc_version || "",
      finish_time: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    xgmclLog.writeLog("ERROR", `写下载历史失败: ${e.message}`);
  }
}

// ---- Modpack 导入 / 导出 ----

async function modpackPickFile() {
  const filePath = await pickFile("选择整合包", [
    { name: "整合包", extensions: ["mrpack", "zip"] },
    { name: "所有文件", extensions: ["*"] },
  ]);
  if (!filePath) return { code: 400, msg: "未选择文件" };
  return { code: 200, path: filePath };
}

async function modpackPickSave(q) {
  const format = q.format || "mrpack";
  const defaultName = q.default_name || "modpack";
  const ext = format === "mrpack" ? "mrpack" : "zip";

  const filePath = await pickSaveFile("导出整合包", `${defaultName}.${ext}`, [
    { name: "整合包", extensions: [ext] },
    { name: "所有文件", extensions: ["*"] },
  ]);
  if (!filePath) return { code: 400, msg: "用户取消" };
  return { code: 200, path: filePath };
}

function modpackDetect(q) {
  const filePath = q.path || "";
  if (!filePath || !fs.existsSync(filePath)) {
    return { code: 400, msg: `文件不存在: ${filePath}` };
  }
  try {
    const r = modpackMod.detectFormat(filePath);
    return { code: 200, format: r.format, meta: r.meta };
  } catch (e) {
    return { code: 500, msg: e.message };
  }
}

async function modpackImport(q) {
  const filePath = q.path || "";
  const rootId = q.root_id || "";
  const overrideName = q.version_name || "";

  if (!filePath || !fs.existsSync(filePath)) {
    return { code: 400, msg: `文件不存在: ${filePath}` };
  }

  const target = verMod.getRootById(rootId);
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  if (!verMod.checkRootValid(target.path)) {
    return { code: 400, msg: "目录已失效" };
  }

  // 并行上限
  const dlCfg = cfgMod.loadDownloadConfig();
  const maxParallel = dlCfg.max_parallel || 16;
  const activeCount = dlMod.listTasks().filter((t) => t.active).length;
  if (maxParallel < 16 && activeCount >= maxParallel) {
    return { code: 400, msg: `已达到最大并行任务数 (${maxParallel})` };
  }

  const taskId = dlMod.createTask({
    task_name: `[整合包] ${path.basename(filePath)}`,
    task_type: "modpack",
    root_path: target.path,
    mc_version: "",
    source: "bmclapi",
    threads: 8,
  });

  xgmclLog.writeLog("INFO",
    `开始导入整合包: ${filePath} → ${target.path} (task_id=${taskId})`
  );

  (async () => {
    try {
      const t = dlMod.getTask(taskId);
      Object.assign(t, {
        active: true, done: false, error: null, cancel: false,
        total_bytes: 0, downloaded_bytes: 0, actual_downloaded_bytes: 0, skipped_bytes: 0,
        files_total: 0, files_done: 0, files_skipped: 0, files_downloaded: 0,
        current_files: ["解析整合包..."],
      });

      const result = await modpackMod.importModpack(
        taskId, filePath, target.path, overrideName
      );

      xgmclLog.writeLog("INFO",
        `整合包导入完成: ${result.versionName} ` +
        `(MC=${result.mcVersion}, loader=${result.loaderType || "无"})`
      );

      finalizeTaskHistory(taskId);
    } catch (e) {
      xgmclLog.writeLog("ERROR", `整合包导入失败: ${e.message}`);
      const t = dlMod.getTask(taskId);
      if (t) { t.error = e.message; t.active = false; }
      finalizeTaskHistory(taskId);
    }
  })();

  return { code: 200, msg: "导入已开始", task_id: taskId };
}

async function modpackExport(q) {
  const versionName = q.version_name || "";
  const rootId = q.root_id || "";
  const outputPath = q.output_path || "";
  const format = q.format || "mrpack";
  const includeResourcepacks = q.include_resourcepacks === "1";
  const includeShaderpacks = q.include_shaderpacks === "1";

  if (!versionName) return { code: 400, msg: "version_name 不能为空" };
  if (!outputPath) return { code: 400, msg: "output_path 不能为空" };

  const target = verMod.getRootById(rootId);
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  if (!verMod.checkRootValid(target.path)) {
    return { code: 400, msg: "目录已失效" };
  }

  const verDir = path.join(target.path, "versions", versionName);
  if (!fs.existsSync(verDir)) {
    return { code: 404, msg: `版本不存在: ${versionName}` };
  }

  // 读版本的 XGMCL_* 字段
  const jsonPath = path.join(verDir, `${versionName}.json`);
  let mcVersion = "";
  let loaderType = "";
  let loaderVersion = "";
  try {
    const vj = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    mcVersion = vj.XGMCL_MC_VERSION || vj.clientVersion || "";
    loaderType = vj.XGMCL_LOADER || "";
    loaderVersion = vj.XGMCL_LOADER_VERSION || "";
  } catch (e) {
    return { code: 400, msg: `读取版本 json 失败: ${e.message}` };
  }

  if (!mcVersion) {
    return { code: 400, msg: "无法确定 MC 版本" };
  }

  const taskId = dlMod.createTask({
    task_name: `[导出] ${versionName}`,
    task_type: "modpack",
    root_path: target.path,
    mc_version: mcVersion,
    source: "official",
    threads: 4,
  });

  xgmclLog.writeLog("INFO",
    `开始导出整合包: ${versionName} → ${outputPath} (format=${format}, task_id=${taskId})`
  );

  (async () => {
    try {
      const t = dlMod.getTask(taskId);
      Object.assign(t, {
        active: true, done: false, error: null, cancel: false,
        current_files: ["扫描 mods..."],
      });

      await modpackMod.exportModpack(
        taskId, verDir, versionName, mcVersion,
        loaderType, loaderVersion, outputPath,
        { includeResourcepacks, includeShaderpacks }
      );

      xgmclLog.writeLog("INFO", `整合包导出完成: ${outputPath}`);
      finalizeTaskHistory(taskId);
    } catch (e) {
      xgmclLog.writeLog("ERROR", `整合包导出失败: ${e.message}`);
      const t = dlMod.getTask(taskId);
      if (t) { t.error = e.message; t.active = false; }
      finalizeTaskHistory(taskId);
    }
  })();

  return { code: 200, msg: "导出已开始", task_id: taskId };
}

// ---- Fabric 安装（已有版本）----

async function fabricInstall(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };

  const dlCfg = cfgMod.loadDownloadConfig();
  const maxParallel = dlCfg.max_parallel || 16;
  const activeCount = dlMod.listTasks().filter((t) => t.active).length;
  if (maxParallel < 16 && activeCount >= maxParallel) {
    return { code: 400, msg: `已达到最大并行任务数 (${maxParallel})，请等待其他任务完成` };
  }

  if (!verMod.checkRootValid(target.path)) return { code: 400, msg: "目录已失效" };

  const versionName = q.version_name || "";
  const mcVersionId = q.mc_version_id || "";
  const loaderVersion = q.loader_version || "";
  if (!versionName || !mcVersionId || !loaderVersion) {
    return { code: 400, msg: "参数不完整" };
  }

  const g = cfgMod.loadGlobalConfig();
  const source = q.source || g.download_source || "bmclapi";
  let threads = parseInt(q.threads || "0", 10) || g.download_threads || 32;
  threads = Math.max(4, Math.min(threads, 256));

  const jsonPath = path.join(target.path, "versions", versionName, `${versionName}.json`);
  if (!fs.existsSync(jsonPath)) return { code: 404, msg: `版本 JSON 不存在: ${jsonPath}` };

  const taskId = dlMod.createTask({
    task_name: versionName + " (Fabric)",
    task_type: "fabric",
    root_path: target.path,
    mc_version: mcVersionId,
    source,
    threads,
  });

  xgmclLog.writeLog("INFO",
    `开始安装 Fabric: ${versionName} (MC=${mcVersionId}, loader=${loaderVersion}, task_id=${taskId})`
  );

  (async () => {
    try {
      const t = dlMod.getTask(taskId);
      Object.assign(t, {
        active: true, done: false, error: null, cancel: false,
        total_bytes: 0, downloaded_bytes: 0, actual_downloaded_bytes: 0, skipped_bytes: 0,
        files_total: 0, files_done: 0, files_skipped: 0, files_downloaded: 0,
        current_files: ["获取 Fabric profile..."],
      });

      await fabricInstallMod.fabricInstallInner(
        taskId, target.path, versionName, mcVersionId,
        loaderVersion, source, threads
      );
      finalizeTaskHistory(taskId);
    } catch (e) {
      xgmclLog.writeLog("ERROR", `Fabric 任务异常: ${e.message}`);
      const t = dlMod.getTask(taskId);
      if (t) { t.error = e.message; t.active = false; }
      finalizeTaskHistory(taskId);
    }
  })();

  return { code: 200, msg: "Fabric 安装已开始", task_id: taskId };
}

// ---- 多 loader ----

async function loaderFetchLoaders(q) {
  const loaderId = (q.loader || "").toLowerCase();
  const mcVersion = q.mc_version || "";
  if (!loaderId || !mcVersion) {
    return { code: 400, msg: "loader / mc_version 不能为空" };
  }

  const loader = loadersMod.getLoader(loaderId);
  if (!loader) {
    return { code: 400, msg: `不支持的 loader: ${loaderId}` };
  }

  try {
    const loaders = await loader.fetchLoaders(mcVersion);
    xgmclLog.writeLog("INFO", `获取 ${loader.name} loader 列表: MC=${mcVersion}, 返回 ${loaders.length} 个`);
    return { code: 200, loaders };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `获取 ${loader.name} loader 失败: ${e.message}`);
    return { code: 500, msg: e.message };
  }
}

async function loaderInstall(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };

  const dlCfg = cfgMod.loadDownloadConfig();
  const maxParallel = dlCfg.max_parallel || 16;
  const activeCount = dlMod.listTasks().filter((t) => t.active).length;
  if (maxParallel < 16 && activeCount >= maxParallel) {
    return { code: 400, msg: `已达到最大并行任务数 (${maxParallel})` };
  }
  if (!verMod.checkRootValid(target.path)) return { code: 400, msg: "目录已失效" };

  const loaderId = (q.loader || "fabric").toLowerCase();
  const versionName = q.version_name || "";
  const mcVersionId = q.mc_version_id || "";
  const loaderVersion = q.loader_version || "";

  if (!versionName || !mcVersionId || !loaderVersion) {
    return { code: 400, msg: "参数不完整" };
  }

  const loader = loadersMod.getLoader(loaderId);
  if (!loader) return { code: 400, msg: `不支持的 loader: ${loaderId}` };

  const g = cfgMod.loadGlobalConfig();
  const source = q.source || g.download_source || "bmclapi";
  let threads = parseInt(q.threads || "0", 10) || g.download_threads || 32;
  threads = Math.max(4, Math.min(threads, 256));

  const jsonPath = path.join(target.path, "versions", versionName, `${versionName}.json`);
  if (!fs.existsSync(jsonPath)) {
    return { code: 404, msg: `版本 JSON 不存在: ${jsonPath}` };
  }

  const taskId = dlMod.createTask({
    task_name: `${versionName} (${loader.name})`,
    task_type: loaderId,
    root_path: target.path,
    mc_version: mcVersionId,
    source,
    threads,
  });

  xgmclLog.writeLog("INFO",
    `开始安装 ${loader.name}: ${versionName} (MC=${mcVersionId}, loader=${loaderVersion}, task_id=${taskId})`
  );

  (async () => {
    try {
      const t = dlMod.getTask(taskId);
      Object.assign(t, {
        active: true, done: false, error: null, cancel: false,
        total_bytes: 0, downloaded_bytes: 0, actual_downloaded_bytes: 0, skipped_bytes: 0,
        files_total: 0, files_done: 0, files_skipped: 0, files_downloaded: 0,
        current_files: [`获取 ${loader.name} profile...`],
      });

      await loader.install(
        taskId, target.path, versionName, mcVersionId,
        loaderVersion, source, threads
      );
      finalizeTaskHistory(taskId);
    } catch (e) {
      xgmclLog.writeLog("ERROR", `${loader.name} 安装任务异常: ${e.message}`);
      const t = dlMod.getTask(taskId);
      if (t) { t.error = e.message; t.active = false; }
      finalizeTaskHistory(taskId);
    }
  })();

  return { code: 200, msg: `${loader.name} 安装已开始`, task_id: taskId };
}

// ---- Modrinth ----

async function modrinthSearch(q) {
  try {
    const limit = parseInt(q.limit || "20", 10) || 20;
    const offset = parseInt(q.offset || "0", 10) || 0;
    const d = await modrinthMod.search(
      q.query || "", limit, offset,
      q.game_version || "", q.loader || "", q.index || "relevance",
      q.project_type || "mod"
    );
    const wiki = modrinthMod.loadWikiEntries();

    const hits = [];
    for (const h of d.hits || []) {
      const slug = (h.slug || "").toLowerCase();
      hits.push({
        project_id: h.project_id || "",
        slug: h.slug || "",
        title: h.title || "",
        description: h.description || "",
        icon_url: h.icon_url || "",
        downloads: h.downloads || 0,
        follows: h.follows || 0,
        author: h.author || "",
        categories: h.categories || [],
        versions: h.versions || [],
        project_type: h.project_type || "",
        date_modified: h.date_modified || "",
        title_cn: wiki[slug] || "",
      });
    }

    return {
      code: 200, hits,
      total_hits: d.total_hits || 0,
      offset: d.offset || offset,
      limit: d.limit || limit,
      index: q.index || "relevance",
    };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `Modrinth 搜索失败: ${e.message}`);
    return { code: 500, msg: e.message };
  }
}

async function modrinthProject(q) {
  try {
    const d = await modrinthMod.getProject(q.project_id || "");
    return {
      code: 200,
      data: {
        project_id: d.id || "",
        slug: d.slug || "",
        title: d.title || "",
        description: d.description || "",
        body: d.body || "",
        icon_url: d.icon_url || "",
        downloads: d.downloads || 0,
        follows: d.follows || 0,
        categories: d.categories || [],
        loaders: d.loaders || [],
        game_versions: d.game_versions || [],
        versions: d.versions || [],
        project_type: d.project_type || "",
        date_modified: d.updated || "",
      },
    };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `Modrinth 项目查询失败: ${e.message}`);
    return { code: 500, msg: e.message };
  }
}

async function modrinthVersions(q) {
  try {
    const versions = await modrinthMod.getProjectVersions(
      q.project_id || "", q.game_version || "", q.loader || ""
    );
    const out = [];
    for (const v of versions) {
      const f = modrinthMod.pickPrimaryFile(v.files || []);
      if (!f) continue;
      out.push({
        version_id: v.id || "",
        name: v.name || "",
        version_number: v.version_number || "",
        game_versions: v.game_versions || [],
        loaders: v.loaders || [],
        date_published: v.date_published || "",
        downloads: v.downloads || 0,
        file: {
          filename: f.filename || "",
          url: f.url || "",
          size: f.size || 0,
          sha1: (f.hashes || {}).sha1 || "",
        },
        dependencies: v.dependencies || [],
      });
    }
    return { code: 200, versions: out };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `Modrinth 版本列表失败: ${e.message}`);
    return { code: 500, msg: e.message };
  }
}

// 按资源类型落盘：resourcepack / shader / datapack / modpack
// mod 走原有 modrinthInstall（弹保存框）
async function modrinthInstallByType(q) {
  const type = (q.type || "").toLowerCase();
  const url = q.url || "";
  const filename = q.filename || "";
  const sha1 = q.sha1 || "";
  const size = parseInt(q.size || "0", 10) || 0;
  const projectId = q.project_id || "";
  const versionId = q.version_id || "";

  if (!url) return { code: 400, msg: "url 为空" };
  if (!type) return { code: 400, msg: "type 为空" };

  const g = cfgMod.loadGlobalConfig();
  const downloadMode = g.download_mode || "save_dialog";

  // modpack 特殊：走整合包流程
  if (type === "modpack") {
    return await modrinthInstallModpack(q);
  }

  // resourcepack / shader / datapack：先下载到临时文件
  // 然后按 download_mode 决定弹保存框还是直接落盘
  let target = "";

  if (downloadMode === "save_dialog") {
    // 弹保存框，用户选到哪就是哪
    const subDir = {
      resourcepack: "resourcepacks",
      shader: "shaderpacks",
      datapack: "datapacks",
    }[type] || "";

    const defaultName = filename || `${type}.zip`;
    const saved = await pickSaveFile("保存文件", defaultName, [
      { name: "压缩包", extensions: ["zip"] },
      { name: "所有文件", extensions: ["*"] },
    ]);
    if (!saved) return { code: 400, msg: "用户取消" };
    target = saved;
  } else {
    // version_dialog：直接落到当前选中版本对应目录
    const target_root = verMod.getRootById(q.root_id || "");
    if (!target_root) return { code: 400, msg: "没有可用的游戏目录" };
    if (!verMod.checkRootValid(target_root.path)) {
      return { code: 400, msg: "目录已失效" };
    }
    const versionName = q.version_name || "";
    if (!versionName) return { code: 400, msg: "未选择版本" };

    const isolated = cfgMod.getVersionIsolated(target_root.path, versionName);
    const gameDir = isolated
      ? path.join(target_root.path, "versions", versionName)
      : target_root.path;

    const subDir = {
      resourcepack: "resourcepacks",
      shader: "shaderpacks",
      datapack: "datapacks",
    }[type] || "";

    const dir = path.join(gameDir, subDir);
    fs.mkdirSync(dir, { recursive: true });
    target = path.join(dir, filename || `${type}.zip`);
  }

  // 起任务下载
  const taskId = dlMod.createTask({
    task_name: `[${type}] ${path.basename(target)}`,
    task_type: type,
    root_path: path.dirname(target),
    mc_version: "",
    source: "official",
    threads: 1,
  });

  (async () => {
    const t = dlMod.getTask(taskId);
    Object.assign(t, {
      active: true, done: false, error: null, cancel: false,
      files_total: 1, total_bytes: size,
      current_files: [path.basename(target)],
    });
    dlMod.startSpeedUpdater(taskId);
    try {
      await dlMod.downloadOneFile({
        url, target, sha1, size, important: false,
      }, "official", 3, taskId);
      const tt = dlMod.getTask(taskId);
      if (tt.cancel) {
        tt.active = false;
      } else {
        tt.files_done = 1;
        tt.done = true;
        tt.active = false;
        xgmclLog.writeLog("INFO", `下载完成 [${type}]: ${target}`);
      }
    } catch (e) {
      const tt = dlMod.getTask(taskId);
      if (tt) { tt.error = e.message; tt.active = false; }
      xgmclLog.writeLog("ERROR", `下载失败 [${type}]: ${e.message}`);
    }
  })();

  return { code: 200, msg: "下载已开始", task_id: taskId, target };
}

// 整合包：从 Modrinth 下载 .mrpack
// modpack_mode = "download_only" → 弹保存框只下 zip
// modpack_mode = "import_directly" → 下载到临时目录后走 modpackImport
async function modrinthInstallModpack(q) {
  const url = q.url || "";
  const filename = q.filename || "modpack.mrpack";
  const sha1 = q.sha1 || "";
  const size = parseInt(q.size || "0", 10) || 0;

  if (!url) return { code: 400, msg: "url 为空" };

  const g = cfgMod.loadGlobalConfig();
  const mpMode = g.modpack_mode || "download_only";

  if (mpMode === "download_only") {
    // 弹保存框只下 zip
    const saved = await pickSaveFile("保存整合包", filename, [
      { name: "整合包", extensions: ["mrpack", "zip"] },
      { name: "所有文件", extensions: ["*"] },
    ]);
    if (!saved) return { code: 400, msg: "用户取消" };

    const taskId = dlMod.createTask({
      task_name: `[整合包] ${path.basename(saved)}`,
      task_type: "modpack",
      root_path: path.dirname(saved),
      mc_version: "",
      source: "official",
      threads: 1,
    });

    (async () => {
      const t = dlMod.getTask(taskId);
      Object.assign(t, {
        active: true, done: false, error: null, cancel: false,
        files_total: 1, total_bytes: size,
        current_files: [path.basename(saved)],
      });
      dlMod.startSpeedUpdater(taskId);
      try {
        await dlMod.downloadOneFile({
          url, target: saved, sha1, size, important: false,
        }, "official", 3, taskId);
        const tt = dlMod.getTask(taskId);
        if (tt.cancel) {
          tt.active = false;
        } else {
          tt.files_done = 1;
          tt.done = true;
          tt.active = false;
          xgmclLog.writeLog("INFO", `整合包下载完成: ${saved}`);
        }
      } catch (e) {
        const tt = dlMod.getTask(taskId);
        if (tt) { tt.error = e.message; tt.active = false; }
        xgmclLog.writeLog("ERROR", `整合包下载失败: ${e.message}`);
      }
    })();

    return { code: 200, msg: "下载已开始", task_id: taskId, target: saved };
  }

  // import_directly：下到临时目录再导入
  const target_root = verMod.getRootById(q.root_id || "");
  if (!target_root) return { code: 400, msg: "没有可用的游戏目录" };
  if (!verMod.checkRootValid(target_root.path)) {
    return { code: 400, msg: "目录已失效" };
  }

  const tmpDir = path.join(P.DOWNLOAD_DATA_DIR, "tmp_modpack");
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `${Date.now()}_${filename}`);

  const taskId = dlMod.createTask({
    task_name: `[整合包] ${filename}`,
    task_type: "modpack",
    root_path: target_root.path,
    mc_version: "",
    source: "official",
    threads: 1,
  });

  Object.assign(dlMod.getTask(taskId), {
    stage_total: 2,
    stage: 1,
  });

  (async () => {
    const t = dlMod.getTask(taskId);
    Object.assign(t, {
      active: true, done: false, error: null, cancel: false,
      files_total: 1, total_bytes: size,
      current_files: [filename],
    });
    dlMod.startSpeedUpdater(taskId);

    try {
      // 阶段 1：下载
      await dlMod.downloadOneFile({
        url, target: tmpFile, sha1, size, important: false,
      }, "official", 3, taskId);

      const tt = dlMod.getTask(taskId);
      if (tt.cancel) { tt.active = false; return; }

      // 阶段 2：导入
      Object.assign(tt, {
        stage: 2,
        current_files: ["导入整合包..."],
        files_total: 1, files_done: 0,
        total_bytes: 0, downloaded_bytes: 0,
      });

      const result = await modpackMod.importModpack(
        taskId, tmpFile, target_root.path, ""
      );

      // 清理临时文件
      try { fs.unlinkSync(tmpFile); } catch (_) {}

      const tt2 = dlMod.getTask(taskId);
      if (tt2) {
        tt2.done = true;
        tt2.active = false;
        tt2.current_files = [];
      }
      xgmclLog.writeLog("INFO",
        `整合包导入完成: ${result.versionName} ` +
        `(MC=${result.mcVersion}, loader=${result.loaderType || "无"})`
      );
      finalizeTaskHistory(taskId);
    } catch (e) {
      const tt = dlMod.getTask(taskId);
      if (tt) { tt.error = e.message; tt.active = false; }
      xgmclLog.writeLog("ERROR", `整合包下载/导入失败: ${e.message}`);
      finalizeTaskHistory(taskId);
    }
  })();

  return { code: 200, msg: "下载并导入已开始", task_id: taskId };
}

async function modrinthUserProjects() {
  const st = modrinthMod.oauthStatus();
  if (!st.logged_in || !st.user || !st.user.id) {
    return { code: 401, msg: "未登录 Modrinth" };
  }
  try {
    const list = await modrinthMod.getUserProjects(st.user.id);
    const wiki = modrinthMod.loadWikiEntries();
    const out = [];
    for (const p of list || []) {
      const slug = (p.slug || "").toLowerCase();
      out.push({
        project_id: p.id || "",
        slug: p.slug || "",
        title: p.title || "",
        title_cn: wiki[slug] || "",
        description: p.description || "",
        icon_url: p.icon_url || "",
        downloads: p.downloads || 0,
        follows: p.follows || 0,
        project_type: p.project_type || "",
      });
    }
    return { code: 200, projects: out };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `拉 Modrinth 我的作品失败: ${e.message}`);
    return { code: 500, msg: e.message };
  }
}

async function modrinthUserFollows() {
  const st = modrinthMod.oauthStatus();
  if (!st.logged_in || !st.user || !st.user.id) {
    return { code: 401, msg: "未登录 Modrinth" };
  }
  try {
    const list = await modrinthMod.getUserFollows(st.user.id);
    const wiki = modrinthMod.loadWikiEntries();
    const out = [];
    for (const p of list || []) {
      const slug = (p.slug || "").toLowerCase();
      out.push({
        project_id: p.id || "",
        slug: p.slug || "",
        title: p.title || "",
        title_cn: wiki[slug] || "",
        description: p.description || "",
        icon_url: p.icon_url || "",
        downloads: p.downloads || 0,
        follows: p.follows || 0,
        project_type: p.project_type || "",
      });
    }
    return { code: 200, follows: out };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `拉 Modrinth 我的关注失败: ${e.message}`);
    return { code: 500, msg: e.message };
  }
}

async function modrinthUserCollections() {
  const st = modrinthMod.oauthStatus();
  if (!st.logged_in || !st.user || !st.user.id) {
    return { code: 401, msg: "未登录 Modrinth" };
  }
  try {
    const list = await modrinthMod.getUserCollections(st.user.id);
    // 收藏夹返回的是 [{id, name, description, projects: [...]}, ...]
    const out = [];
    for (const c of list || []) {
      out.push({
        id: c.id || "",
        name: c.name || "",
        description: c.description || "",
        icon_url: c.icon_url || "",
        project_count: (c.projects || []).length,
        projects: (c.projects || []).map((p) => ({
          project_id: p.id || "",
          slug: p.slug || "",
          title: p.title || "",
          icon_url: p.icon_url || "",
          project_type: p.project_type || "",
        })),
      });
    }
    return { code: 200, collections: out };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `拉 Modrinth 我的收藏夹失败: ${e.message}`);
    return { code: 500, msg: e.message };
  }
}

async function modrinthInstall(q) {

  const url = q.url || "";
  if (!url) return { code: 400, msg: "url 为空" };

  let filename = q.filename || "";
  if (!filename) {
    try { filename = path.basename(new URL(url).pathname) || "mod.jar"; }
    catch (_) { filename = "mod.jar"; }
  }

  const target = await pickSaveFile("选择保存位置", filename, [
    { name: "所有文件", extensions: ["*"] },
  ]);
  if (!target) return { code: 400, msg: "用户取消" };

  let finalTarget = target;
  if (!finalTarget.toLowerCase().endsWith(".jar")) finalTarget += ".jar";

  const taskName = path.basename(finalTarget);
  const taskId = dlMod.createTask({
    task_name: `[Mod] ${taskName}`,
    task_type: "mod",
    root_path: path.dirname(finalTarget),
    mc_version: "",
    source: "official",
    threads: 1,
  });

  const sha1 = q.sha1 || "";
  const size = parseInt(q.size || "0", 10) || 0;

  (async () => {
    const t = dlMod.getTask(taskId);
    Object.assign(t, {
      active: true, done: false, error: null, cancel: false,
      files_total: 1, total_bytes: size,
      current_files: [path.basename(finalTarget)],
    });
    dlMod.startSpeedUpdater(taskId);

    try {
      await dlMod.downloadOneFile({
        url, target: finalTarget, sha1, size, important: false,
      }, "official", 3, taskId);

      const tt = dlMod.getTask(taskId);
      if (tt.cancel) {
        tt.active = false;
      } else {
        tt.files_done = 1;
        tt.done = true;
        tt.active = false;
        xgmclLog.writeLog("INFO", `Modrinth 下载完成: ${finalTarget}`);
        try { await modsMod.autoWriteMetaAfterDownload(finalTarget); }
        catch (e) { xgmclLog.writeLog("WARN", `自动写元数据失败: ${e.message}`); }
      }
    } catch (e) {
      const tt = dlMod.getTask(taskId);
      if (tt) { tt.error = e.message; tt.active = false; }
      xgmclLog.writeLog("ERROR", `Modrinth 下载失败: ${e.message}`);
    }
  })();

  xgmclLog.writeLog("INFO", `Modrinth 下载: ${filename} → ${finalTarget} (task_id=${taskId})`);
  return { code: 200, msg: "下载已开始", task_id: taskId, target: finalTarget };
}

async function modrinthDepTree(body) {
  const rootIds = body.project_ids || [];
  const maxDepth = parseInt(body.max_depth || "3", 10) || 3;
  if (!Array.isArray(rootIds) || !rootIds.length) {
    return { code: 200, nodes: {}, edges: {}, missing: [] };
  }
  try {
    const r = await modrinthMod.dependencyTree(rootIds, maxDepth);
    return { code: 200, ...r };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `依赖树查询失败: ${e.message}`);
    return { code: 500, msg: e.message };
  }
}

async function modrinthVersionFromHash(body) {
  const hashes = body.hashes || [];
  if (!Array.isArray(hashes) || !hashes.length) {
    return { code: 200, data: {} };
  }

  const valid = [...new Set(hashes.filter((h) => typeof h === "string" && h.length === 128).map((h) => h.toLowerCase()))];
  if (!valid.length) return { code: 200, data: {} };

  let raw;
  try { raw = await modrinthMod.versionsFromHashes(valid); }
  catch (e) {
    xgmclLog.writeLog("WARN", `哈希反查失败: ${e.message}`);
    return { code: 200, data: {} };
  }

  const pids = [];
  for (const v of Object.values(raw)) {
    if (v.project_id) pids.push(v.project_id);
  }

  const projInfo = {};
  if (pids.length) {
    try {
      const params = new URLSearchParams({ ids: JSON.stringify([...new Set(pids)]) });
      const res = await fetch(`${modrinthMod.API}/projects?${params}`, {
        headers: modrinthMod.headers(),
      });
      if (res.ok) {
        const list = await res.json();
        for (const p of list) projInfo[p.id || ""] = p;
      }
    } catch (e) {
      xgmclLog.writeLog("WARN", `批量查项目信息失败: ${e.message}`);
    }
  }

  const wiki = modrinthMod.loadWikiEntries();
  const result = {};

  for (const [hash, v] of Object.entries(raw)) {
    const pid = v.project_id || "";
    const p = projInfo[pid] || {};
    const slug = (p.slug || "").toLowerCase();
    const files = v.files || [];
    let primary = null;
    for (const f of files) { if (f.primary) { primary = f; break; } }
    if (!primary && files.length) primary = files[0];

    result[hash] = {
      project_id: pid,
      slug: p.slug || "",
      title: p.title || "",
      title_cn: wiki[slug] || "",
      icon_url: p.icon_url || "",
      description: p.description || "",
      version_id: v.id || "",
      version_number: v.version_number || "",
      download_url: (primary || {}).url || "",
      filename: (primary || {}).filename || "",
      dependencies: v.dependencies || [],
    };
  }

  return { code: 200, data: result };
}

// ---- 一键升级 ----

async function upversionStart(q) {
  const target = verMod.getRootById(q.root_id || "");
  if (!target) return { code: 400, msg: "没有可用的游戏目录" };
  if (!verMod.checkRootValid(target.path)) return { code: 400, msg: "目录已失效" };

  const sourceVersion = q.source_version || "";
  const targetMc = q.target_mc || "";
  if (!sourceVersion || !targetMc) {
    return { code: 400, msg: "source_version / target_mc 不能为空" };
  }

  const srcVerDir = path.join(target.path, "versions", sourceVersion);
  if (!fs.existsSync(srcVerDir)) {
    return { code: 404, msg: `源版本不存在: ${sourceVersion}` };
  }

  let targetName = q.target_name || "";
  if (!targetName) targetName = `${sourceVersion}_--upversionto-${targetMc}`;

  const badChars = ["<", ">", ":", '"', "/", "\\", "|", "?", "*"];
  for (const c of badChars) {
    if (targetName.includes(c)) {
      return { code: 400, msg: `目标版本名含非法字符: ${c}` };
    }
  }

  if (fs.existsSync(path.join(target.path, "versions", targetName))) {
    return { code: 400, msg: `目标版本名已被占用: ${targetName}` };
  }

  let targetLoader = (q.target_loader || "fabric").toLowerCase();
  if (targetLoader !== "fabric") {
    return { code: 400, msg: `暂只支持 Fabric，收到: ${targetLoader}` };
  }

  const fabricLoader = q.fabric_loader || "";
  if (!fabricLoader) return { code: 400, msg: "请指定 Fabric loader 版本" };

  const g = cfgMod.loadGlobalConfig();
  const source = g.download_source || "bmclapi";
  const threads = Math.max(4, Math.min(g.download_threads || 32, 256));

  const taskId = dlMod.createTask({
    task_name: `升级: ${sourceVersion} → ${targetMc}`,
    task_type: "upversion",
    root_path: target.path,
    mc_version: targetMc,
    source,
    threads,
  });

  Object.assign(dlMod.getTask(taskId), {
    stage_total: 4,
    stage: 1,
    source_version: sourceVersion,
    target_name: targetName,
    target_mc: targetMc,
    target_loader: targetLoader,
  });

  const copyOptions = {
    copy_mods: q.copy_mods === "1",
    copy_config: q.copy_config === "1",
    copy_resourcepacks: q.copy_resourcepacks === "1",
    copy_shaderpacks: q.copy_shaderpacks === "1",
  };

  xgmclLog.writeLog("INFO",
    `开始升级: ${sourceVersion} → ${targetMc} ` +
    `(目标名=${targetName}, loader=${fabricLoader}, task_id=${taskId})`
  );

  upversionMod.upversionWorker(
    taskId, target.path, sourceVersion, targetMc,
    targetLoader, targetName, fabricLoader,
    source, threads, copyOptions
  ).catch((e) => xgmclLog.writeLog("ERROR", `upversionWorker 异常: ${e.message}`));

  return {
    code: 200,
    msg: "升级任务已开始",
    task_id: taskId,
    target_name: targetName,
  };
}

function upversionResult(q) {
  const t = dlMod.getTask(q.task_id || "");
  if (!t) return { code: 404, msg: "任务不存在" };
  return {
    code: 200,
    done: Boolean(t.done),
    active: Boolean(t.active),
    error: t.error || null,
    result: t.upgrade_result || null,
  };
}

// ---- 服务端配置 ----

function serverConfigSave(q) {
  const cfg = cfgMod.loadServerConfig();

  if (q.java_path !== undefined && q.java_path !== "__keep__") cfg.java_path = q.java_path || "";
  if (q.ram_mb !== undefined && q.ram_mb !== "") {
    const n = parseInt(q.ram_mb, 10);
    if (!isNaN(n)) cfg.ram_mb = Math.max(512, Math.min(65536, n));
  }
  if (q.jvm_args !== undefined && q.jvm_args !== "__keep__") cfg.jvm_args = q.jvm_args || "";
  if (q.last_dir !== undefined && q.last_dir !== "__keep__") cfg.last_dir = q.last_dir || "";

  cfgMod.saveServerConfig(cfg);
  xgmclLog.writeLog("INFO",
    `保存服务端配置: RAM=${cfg.ram_mb}MB, Java=${cfg.java_path || "(默认)"}`
  );
  return { code: 200, msg: "已保存", data: cfg };
}

function serverDetect(q) {
  const dir = q.dir || "";
  xgmclLog.writeLog("INFO", `[server] detect dir=${JSON.stringify(dir)}, exists=${fs.existsSync(dir)}`);
  if (!dir || !fs.existsSync(dir)) {
    return { code: 400, msg: `目录不存在: ${dir}` };
  }
  const info = serverMod.detectServer(dir);
  xgmclLog.writeLog("INFO", `[server] detect 结果: ${JSON.stringify(info)}`);
  return { code: 200, data: info };
}

function serverPropertiesGet(q) {
  const dir = q.dir || "";
  if (!dir || !fs.existsSync(dir)) return { code: 400, msg: "目录不存在" };
  return { code: 200, data: serverMod.readProperties(dir) };
}

function serverPropertiesSave(q) {
  const dir = q.dir || "";
  if (!dir || !fs.existsSync(dir)) return { code: 400, msg: "目录不存在" };
  let parsed = {};
  try { parsed = JSON.parse(q.data || "{}"); }
  catch (e) { return { code: 400, msg: `data 不是合法 JSON: ${e.message}` }; }
  if (!parsed || typeof parsed !== "object") {
    return { code: 400, msg: "data 必须是 JSON 对象" };
  }
  const changed = serverMod.saveProperties(dir, parsed);
  return { code: 200, msg: `已保存 ${changed} 个字段`, changed };
}

function serverWhitelistGet(q) {
  const dir = q.dir || "";
  if (!dir || !fs.existsSync(dir)) return { code: 400, msg: "目录不存在" };
  return { code: 200, data: serverMod.readWhitelist(dir) };
}

function serverWhitelistSave(q) {
  const dir = q.dir || "";
  if (!dir || !fs.existsSync(dir)) return { code: 400, msg: "目录不存在" };
  let arr = [];
  try { arr = JSON.parse(q.data || "[]"); }
  catch (e) { return { code: 400, msg: `data 不是合法 JSON: ${e.message}` }; }
  if (!Array.isArray(arr)) return { code: 400, msg: "data 必须是 JSON 数组" };
  serverMod.saveWhitelist(dir, arr);
  return { code: 200, msg: `已保存 ${arr.length} 条` };
}

function serverOpsGet(q) {
  const dir = q.dir || "";
  if (!dir || !fs.existsSync(dir)) return { code: 400, msg: "目录不存在" };
  return { code: 200, data: serverMod.readOps(dir) };
}

function serverOpsSave(q) {
  const dir = q.dir || "";
  if (!dir || !fs.existsSync(dir)) return { code: 400, msg: "目录不存在" };
  let arr = [];
  try { arr = JSON.parse(q.data || "[]"); }
  catch (e) { return { code: 400, msg: `data 不是合法 JSON: ${e.message}` }; }
  if (!Array.isArray(arr)) return { code: 400, msg: "data 必须是 JSON 数组" };
  serverMod.saveOps(dir, arr);
  return { code: 200, msg: `已保存 ${arr.length} 条` };
}

function serverStart(q) {
  const dir = q.dir || "";
  if (!dir || !fs.existsSync(dir)) return { code: 400, msg: "目录不存在" };

  const info = serverMod.detectServer(dir);
  if (!info.valid) {
    return { code: 400, msg: "不是合法的服务端目录（缺 server.properties 或 jar）" };
  }

  let jar = q.jar || "";
  if (!jar) jar = info.preferred_jar;
  if (!jar || !fs.existsSync(jar)) return { code: 400, msg: `jar 不存在: ${jar}` };

  const cfg = cfgMod.loadServerConfig();

  let ramMb = parseInt(q.ram_mb || "-1", 10);
  if (isNaN(ramMb) || ramMb < 0) ramMb = cfg.ram_mb || 3072;

  let jvmArgs = q.jvm_args;
  if (jvmArgs === undefined || jvmArgs === "__keep__") jvmArgs = cfg.jvm_args || "";

  let javaPath = q.java_path;
  if (javaPath === undefined || javaPath === "__keep__") {
    javaPath = cfg.java_path || "";
    if (!javaPath) {
      const g = cfgMod.loadGlobalConfig();
      javaPath = g.global_java_path || "";
    }
  }

  cfg.last_dir = dir;
  cfgMod.saveServerConfig(cfg);

  return serverMod.startServer(dir, jar, ramMb, jvmArgs, javaPath);
}

async function serverStop() {
  return await serverMod.stopServer();
}

function serverStatus() {
  const running = serverMod.isRunning();
  return { code: 200, running, data: { ...serverMod.SERVER_STATE } };
}

function serverConsoleTail(q) {
  const dir = q.dir || "";
  if (!dir) return { code: 400, msg: "dir 为空" };

  const offset = parseInt(q.offset || "0", 10) || 0;
  const running = serverMod.isRunning();

  if (!running && offset === 0) {
    const r = serverMod.readConsoleFromStart(dir);
    return { code: 200, lines: r.lines, next_offset: r.next_offset, exists: r.next_offset > 0, running: false };
  }

  const r = serverMod.tailConsole(dir, offset);
  return { code: 200, lines: r.lines, next_offset: r.next_offset, exists: r.exists, running };
}

function serverConsoleCommand(q) {
  const cmd = q.cmd || "";
  if (!cmd) return { code: 400, msg: "命令为空" };
  return serverMod.sendCommand(cmd);
}

// ---- 服务端：一键安装 Fabric + IP 检测 ----

async function serverInstallFabric(q) {
  const dir = q.dir || "";
  if (!dir || !fs.existsSync(dir)) return { code: 400, msg: "目录不存在" };

  const mcVersion = q.mc_version || "";
  if (!mcVersion) return { code: 400, msg: "MC 版本不能为空" };

  const loaderVersion = q.loader_version || "";

  try {
    const r = await serverMod.installFabricServer(dir, mcVersion, loaderVersion);
    if (r.code !== 200) return r;

    // 安装完成后自动检测 IP
    const publicIp = await serverMod.getPublicIPv4();
    const probeOk = Boolean(publicIp);
    const isPrivate = probeOk ? serverMod.isPrivateIPv4(publicIp) : null;

    xgmclLog.writeLog("INFO", `[Fabric服务端] 安装完成，公网IP=${publicIp || "(未获取)"}，内网=${isPrivate}`);

    return {
      code: 200,
      msg: r.msg,
      path: r.path,
      loader_version: r.loader_version,
      public_ip: publicIp,
      is_private: isPrivate,
      probe_ok: probeOk,
    };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `[Fabric服务端] 安装失败: ${e.message}`);
    return { code: 500, msg: e.message };
  }
}

async function serverCheckIp() {
  try {
    const publicIp = await serverMod.getPublicIPv4();
    const probeOk = Boolean(publicIp);
    const isPrivate = probeOk ? serverMod.isPrivateIPv4(publicIp) : null;
    return {
      code: 200,
      public_ip: publicIp,
      is_private: isPrivate,
      probe_ok: probeOk,
    };
  } catch (e) {
    return { code: 500, msg: e.message };
  }
}

// ---- 服务端插件 ----

function serverPluginsList(q) {
  const dir = q.dir || "";
  if (!dir || !fs.existsSync(dir)) return { code: 400, msg: "目录不存在" };
  return { code: 200, plugins: serverMod.scanPlugins(dir), plugins_dir: serverMod.getPluginsDir(dir) };
}

function serverPluginsDelete(q) {
  const dir = q.dir || "";
  const filenames = (q.filenames || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!dir || !fs.existsSync(dir)) return { code: 400, msg: "目录不存在" };
  if (!filenames.length) return { code: 400, msg: "没有有效的文件名" };

  const pluginsDir = serverMod.getPluginsDir(dir);
  const deleted = [];
  const failed = [];
  for (const fn of filenames) {
    if (fn.includes("/") || fn.includes("\\") || fn.includes("..")) {
      failed.push({ filename: fn, error: "非法文件名" });
      continue;
    }
    const full = path.join(pluginsDir, fn);
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
  xgmclLog.writeLog("INFO", `删除插件: 成功 ${deleted.length}，失败 ${failed.length}`);
  return { code: 200, msg: `已删除 ${deleted.length} 个`, deleted, failed };
}

async function serverPluginsOpenFolder(q) {
  const dir = q.dir || "";
  if (!dir || !fs.existsSync(dir)) return { code: 400, msg: "目录不存在" };
  const pluginsDir = serverMod.ensurePluginsDir(dir);
  await shell.openPath(pluginsDir);
  return { code: 200, msg: "已打开", path: pluginsDir };
}

async function serverPluginsSearch(q) {
  try {
    const limit = parseInt(q.limit || "20", 10) || 20;
    const offset = parseInt(q.offset || "0", 10) || 0;
    // Modrinth 的 plugin 是 project_type=plugin
    const d = await modrinthMod.search(
      q.query || "", limit, offset,
      q.game_version || "", q.loader || "", q.index || "relevance",
      "plugin"
    );
    const wiki = modrinthMod.loadWikiEntries();
    const hits = [];
    for (const h of d.hits || []) {
      const slug = (h.slug || "").toLowerCase();
      hits.push({
        project_id: h.project_id || "",
        slug: h.slug || "",
        title: h.title || "",
        description: h.description || "",
        icon_url: h.icon_url || "",
        downloads: h.downloads || 0,
        follows: h.follows || 0,
        author: h.author || "",
        categories: h.categories || [],
        versions: h.versions || [],
        title_cn: wiki[slug] || "",
      });
    }
    return {
      code: 200, hits,
      total_hits: d.total_hits || 0,
      offset: d.offset || offset,
      limit: d.limit || limit,
    };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `Modrinth 插件搜索失败: ${e.message}`);
    return { code: 500, msg: e.message };
  }
}

async function serverPluginsInstall(q) {
  const dir = q.dir || "";
  const url = q.url || "";
  const filename = q.filename || "";
  const sha1 = q.sha1 || "";
  const size = parseInt(q.size || "0", 10) || 0;

  if (!dir || !fs.existsSync(dir)) return { code: 400, msg: "目录不存在" };
  if (!url) return { code: 400, msg: "url 为空" };
  if (!filename) return { code: 400, msg: "filename 为空" };

  const pluginsDir = serverMod.ensurePluginsDir(dir);
  const target = path.join(pluginsDir, filename);

  const taskId = dlMod.createTask({
    task_name: `[插件] ${filename}`,
    task_type: "plugin",
    root_path: pluginsDir,
    mc_version: "",
    source: "official",
    threads: 1,
  });

  (async () => {
    const t = dlMod.getTask(taskId);
    Object.assign(t, {
      active: true, done: false, error: null, cancel: false,
      files_total: 1, total_bytes: size,
      current_files: [filename],
    });
    dlMod.startSpeedUpdater(taskId);
    try {
      await dlMod.downloadOneFile({
        url, target, sha1, size, important: false,
      }, "official", 3, taskId);
      const tt = dlMod.getTask(taskId);
      if (tt.cancel) {
        tt.active = false;
      } else {
        tt.files_done = 1;
        tt.done = true;
        tt.active = false;
        xgmclLog.writeLog("INFO", `插件下载完成: ${target}`);
      }
    } catch (e) {
      const tt = dlMod.getTask(taskId);
      if (tt) { tt.error = e.message; tt.active = false; }
      xgmclLog.writeLog("ERROR", `插件下载失败: ${e.message}`);
    }
  })();

  return { code: 200, msg: "下载已开始", task_id: taskId, target };
}

// ============ 窗口 ============

function createMainWindow(show) {
  const win = new BrowserWindow({
    width: 1280, height: 800,
    minWidth: 1000, minHeight: 640,
    backgroundColor: "#1f1f1f",
    autoHideMenuBar: true,
    show: show !== false,
    paintWhenInitiallyHidden: true,
    frame: false,
    titleBarStyle: "hidden",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // ★ 窗口焦点变化 → 通知渲染进程（mac 风格红绿灯失焦变灰用）
  win.on("focus", () => {
    if (!win.isDestroyed()) win.webContents.send("win:focus-changed", true);
  });
  win.on("blur", () => {
    if (!win.isDestroyed()) win.webContents.send("win:focus-changed", false);
  });

  win.webContents.on("did-attach-webview", (event, wc) => {
    wc.setWindowOpenHandler(({ url }) => {
      setTimeout(() => {
        if (wc && !wc.isDestroyed()) {
          wc.loadURL(url).catch((e) => console.warn("[webview] 内跳转失败:", e.message));
        }
      }, 50);
      return { action: "deny" };
    });

    wc.on("will-navigate", (e, url) => console.log("[webview] 将导航到:", url));

    wc.session.webRequest.onBeforeRequest((details, callback) => {
      const url = details.url || "";
      if (url.startsWith("http://127.0.0.1:8000") || url.startsWith("http://localhost:8000")) {
        console.warn("[webview] 拦截本地接口请求:", url);
        return callback({ cancel: true });
      }
      callback({ cancel: false });
    });

    wc.on("did-fail-load", (e, errorCode, errorDescription, validatedURL) => {
      if (errorCode === -3) return;
      console.warn("[webview] 加载失败:", errorCode, errorDescription, validatedURL);
    });
  });

  return win;
}

async function splashCall(splashWin, fnName) {
  if (!splashWin || splashWin.isDestroyed()) return;
  try {
    await splashWin.webContents.executeJavaScript(
      `(async () => { await window.${fnName}(); })()`
    );
  } catch (e) {
    console.warn(`[splash] 调用 ${fnName} 失败:`, e.message);
  }
}

// ============ 生命周期 ============

app.whenReady().then(async () => {
  const betaSeenKey = path.join(P.SETTING_ROOT, ".beta_seen");
  if (!fs.existsSync(betaSeenKey)) {
    dialog.showMessageBox({
      type: "info",
      title: "测试版提示",
      message: "这是 XGMCL 测试版",
      detail: "功能可能不稳定，遇到问题请到 QQ 群 903815517 反馈。",
      buttons: ["我知道了"],
    }).then(() => {
      try { fs.writeFileSync(betaSeenKey, Date.now().toString()); } catch (_) {}
    });
  }
  if (!gotTheLock) return;
  const T0 = Date.now();

  // 注册背景协议 handler：把 xgmcl-bg:///C:/xxx.mp4 转成真实文件流
  protocol.handle(P.BG_PROTOCOL, (request) => {
    try {
      const url = new URL(request.url);
      // xgmcl-bg://local/C:/xxx/yyy.mp4 → pathname = /C:/xxx/yyy.mp4
      let filePath = decodeURIComponent(url.pathname || "");
      // 去掉开头的斜杠（Windows 盘符会被解析成 /C:/...）
      if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1);
      // 安全检查：只允许已配置的壁纸目录 / 文件下的路径
      const cfg = cfgMod.loadAppearance();
      const src = cfg.bg_source || "";
      if (!src) {
        return new Response("no bg_source", { status: 404 });
      }
      const normFile = path.normalize(filePath).toLowerCase();
      const normSrc = path.normalize(src).toLowerCase();
      // 单文件模式：必须等于 bg_source
      // 文件夹模式：必须以 bg_source + sep 开头
      const isSingle = (cfg.bg_mode === "single_video");
      let allowed = false;
      if (isSingle) {
        allowed = (normFile === normSrc);
      } else {
        allowed = normFile.startsWith(normSrc + path.sep) ||
                  normFile === normSrc;
      }
      if (!allowed) {
        xgmclLog.writeLog("WARN", `[bg] 拒绝越权访问: ${filePath}`);
        return new Response("forbidden", { status: 403 });
      }
      if (!fs.existsSync(filePath)) {
        return new Response("not found", { status: 404 });
      }
      // 用 net.fetch 直接转发文件
      const { net } = require("electron");
      return net.fetch("file://" + filePath.replace(/\\/g, "/"), {
        bypassCustomProtocolHandlers: true,
      });
    } catch (e) {
      xgmclLog.writeLog("ERROR", `[bg] 协议处理失败: ${e.message}`);
      return new Response("error", { status: 500 });
    }
  });

  cfgMod.initAllConfigs();
  console.log(`[TIME] +${Date.now() - T0}ms initAllConfigs`);

  ensureBuiltinInstance();
  console.log(`[TIME] +${Date.now() - T0}ms ensureBuiltinInstance`);

  xgmclLog.initLog();
  xgmclLog.writeLog("INFO", "Electron 主进程启动");

  xgMod.restoreSession().catch((e) => {
    xgmclLog.writeLog("WARN", `恢复 XGstudio 会话失败: ${e.message}`);
  });

  console.log(`[TIME] +${Date.now() - T0}ms initLog`);

  if (modrinthMod.oauthLoad()) {
    const st = modrinthMod.oauthStatus();
    xgmclLog.writeLog("INFO", `已恢复 Modrinth 登录态: ${st.user ? st.user.username : "?"}`);
  }

  ensureResources();
  console.log(`[TIME] +${Date.now() - T0}ms ensureResources`);

  const splashWin = new BrowserWindow({
    width: 1280, height: 800,
    minWidth: 1000, minHeight: 640,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    backgroundColor: "#1f1f1f",
    autoHideMenuBar: true,
    show: true,
    frame: false,
    transparent: false,
    hasShadow: false,
    skipTaskbar: false,
    icon: path.join(__dirname, "icon.png"),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWin.loadFile("splash.html");
  console.log(`[TIME] +${Date.now() - T0}ms splash created`);

  mainWindow = createMainWindow(false);
  console.log(`[TIME] +${Date.now() - T0}ms main window created`);

  await new Promise((r) => {
    if (splashWin.webContents.isLoading()) splashWin.webContents.once("did-finish-load", r);
    else r();
  });
  console.log(`[TIME] +${Date.now() - T0}ms splash loaded`);

  await splashCall(splashWin, "__splashRunCore");
  console.log(`[TIME] +${Date.now() - T0}ms core detected`);

  const indexPromise = new Promise((r) => {
    mainWindow.webContents.once("did-finish-load", r);
    mainWindow.loadFile("index.html");
  });
  console.log(`[TIME] +${Date.now() - T0}ms index loading started`);

  await splashCall(splashWin, "__splashRunData");
  await splashCall(splashWin, "__splashRunUi");

  await indexPromise;
  console.log(`[TIME] +${Date.now() - T0}ms index loaded`);

  await mainWindow.webContents.executeJavaScript(`
    new Promise(resolve => {
      if (document.readyState === 'complete') return resolve();
      window.addEventListener('load', () => resolve(), { once: true });
    })
  `);
  await new Promise((r) => setTimeout(r, 300));
  console.log(`[TIME] +${Date.now() - T0}ms appearance applied`);

  await splashCall(splashWin, "__splashDone");
  console.log(`[TIME] +${Date.now() - T0}ms done`);

  // ★ 硬兜底：不管后面怎么卡，最多再等 8 秒就销毁 splash
  const splashKillTimer = setTimeout(() => {
    if (splashWin && !splashWin.isDestroyed()) {
      console.warn("[splash] 超时未关闭，强制销毁");
      splashWin.destroy();
    }
  }, 8000);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    await new Promise((r) => {
      let done = false;
      const finish = () => { if (!done) { done = true; r(); } };
      mainWindow.webContents.once("did-finish-load", finish);
      setTimeout(finish, 250);
    });
    await mainWindow.webContents.executeJavaScript(
      `new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)))`
    );
  }

  clearTimeout(splashKillTimer);
  if (splashWin && !splashWin.isDestroyed()) splashWin.destroy();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow(true);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  xgmclLog.writeLog("INFO", "启动器退出");
});