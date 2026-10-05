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

// paths.js —— 所有配置/数据文件路径常量

const path = require("path");
const fs = require("fs");
const { app } = require("electron");

// BASE：打包后用 exe 所在目录，源码运行用项目根
let BASE;
if (app && app.isPackaged) {
  BASE = path.dirname(app.getPath("exe"));
} else {
  BASE = path.join(__dirname);
}

const XGMCL_ROOT = path.join(BASE, "XGMCL");
const SETTING_ROOT = path.join(XGMCL_ROOT, "setting");
const VERSION_SETTING_ROOT = path.join(SETTING_ROOT, "version");
const LOG_ROOT = path.join(XGMCL_ROOT, "xgmcllog");
const DOWNLOAD_DATA_DIR = path.join(XGMCL_ROOT, "data", "download_data");

const P = {
  BASE,
  XGMCL_ROOT,
  SETTING_ROOT,
  VERSION_SETTING_ROOT,
  LOG_ROOT,
  DOWNLOAD_DATA_DIR,
  THEME_DIR: path.join(SETTING_ROOT, "themes"),

  // 根目录数据库
  ROOTS_DB: path.join(SETTING_ROOT, "mxgversionsc.json"),
  // 全局设置
  GLOBAL_CONFIG: path.join(SETTING_ROOT, "config.json"),
  // JVM 参数
  JVM_CONFIG: path.join(SETTING_ROOT, "xgm1.json"),
  // 版本专属配置
  VERSION_CFG: path.join(VERSION_SETTING_ROOT, "versioncsetting.json"),
  // 上次启动
  LAST_LAUNCH: path.join(SETTING_ROOT, "lastlaunch.json"),
  // 主页自定义
  HOME_CONFIG: path.join(SETTING_ROOT, "home.json"),
  // HTML 信任列表
  TRUSTED: path.join(SETTING_ROOT, "trusted_html.json"),
  // Java 扫描缓存
  JAVA_CACHE: path.join(SETTING_ROOT, "java_list.json"),
  // 外观效果
  APPEARANCE: path.join(SETTING_ROOT, "appearance.json"),
  // 下载配置
  DOWNLOAD_CFG: path.join(SETTING_ROOT, "download.json"),
  // 下载历史
  DOWNLOAD_HIST: path.join(DOWNLOAD_DATA_DIR, "download.json"),
  // 服务端配置
  SERVER_CFG: path.join(SETTING_ROOT, "server.json"),
  // 软件设置
  SOFTWARE_CFG: path.join(SETTING_ROOT, "software.json"),
  // XG-Boot 配置
  BOOT_CONFIG: path.join(SETTING_ROOT, "boot.json"),
  // Modrinth OAuth
  MODRINTH_OAUTH: path.join(SETTING_ROOT, "modrinth_oauth.json"),
  // 账户数据
  ACCOUNT_PATH: path.join(XGMCL_ROOT, "data", "xgmclp", "p.json"),
  // 主题色
  COLOR_PATH: path.join(XGMCL_ROOT, "data", "color.json"),
  // 头像缓存
  AVATAR_CACHE_DIR: path.join(XGMCL_ROOT, "data", "avatar_cache"),
  // 原版皮肤
  VANILLA_SKIN_DIR: path.join(XGMCL_ROOT, "data", "skins", "vanilla"),
};

// 首次运行初始化所有目录 + 空配置
function initXgmclDir() {
  const dirs = [
    SETTING_ROOT,
    VERSION_SETTING_ROOT,
    LOG_ROOT,
    DOWNLOAD_DATA_DIR,
    P.THEME_DIR,
    path.dirname(P.ACCOUNT_PATH),
    P.AVATAR_CACHE_DIR,
  ];
  for (const d of dirs) {
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch (e) {
      console.error(`[paths] 创建目录失败 ${d}:`, e.message);
    }
  }
}

module.exports = { ...P, initXgmclDir };