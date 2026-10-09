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

// server.js —— Fabric 服务端管理（启动 / 停止 / 配置 / 控制台）

const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const xgmclLog = require("./xgmcl_log.js");

// 全局状态
const SERVER_STATE = {
  running: false,
  pid: 0,
  dir: "",
  jar: "",
  start_time: 0,
};

let SERVER_PROC = null;

// ---- 插件目录 ----

function getPluginsDir(serverDir) {
  return path.join(serverDir, "plugins");
}

function ensurePluginsDir(serverDir) {
  const dir = getPluginsDir(serverDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 扫 plugins 目录里的 .jar
function scanPlugins(serverDir) {
  const dir = getPluginsDir(serverDir);
  const result = [];
  if (!fs.existsSync(dir)) return result;
  try {
    for (const fn of fs.readdirSync(dir)) {
      if (!fn.toLowerCase().endsWith(".jar")) continue;
      const full = path.join(dir, fn);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        result.push({ filename: fn, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
      } catch (_) {}
    }
  } catch (e) {
    xgmclLog.writeLog("WARN", `扫插件失败: ${e.message}`);
  }
  result.sort((a, b) => a.filename.localeCompare(b.filename));
  return result;
}

// ---- IPv4 检测 ----

// 判断是否内网 IPv4（RFC1918 + 100.64/10 运营商大内网）
function isPrivateIPv4(ip) {
  if (!ip || typeof ip !== "string") return true;
  const parts = ip.split(".").map((x) => parseInt(x, 10));
  if (parts.length !== 4 || parts.some((n) => isNaN(n) || n < 0 || n > 255)) {
    return true; // 不合法当内网处理
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  // 运营商大内网（CGNAT）
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

// 探测本机公网 IPv4
// 探测本机公网 IPv4
function getPublicIPv4() {
  // 多个备选源（含国内可访问的），谁先返回用谁
  const sources = [
    { url: "https://ipv4.icanhazip.com", parse: (t) => t.trim() },
    { url: "https://ipinfo.io/json", parse: (j) => j.ip },
    { url: "https://api.ip.sb/ip", parse: (t) => t.trim() },
    { url: "https://api.ipify.org?format=json", parse: (j) => j.ip },
  ];

  return new Promise((resolve) => {
    let done = false;
    let pending = sources.length;

    function finish(ip) {
      if (done) return;
      if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        done = true;
        resolve(ip);
      } else {
        pending--;
        if (pending <= 0) {
          done = true;
          resolve("");
        }
      }
    }

    for (const src of sources) {
      let req;
      try {
        req = require("https").get(src.url, { timeout: 4000 }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              let ip = "";
              if (src.url.endsWith("/json")) {
                ip = src.parse(JSON.parse(data));
              } else {
                ip = src.parse(data);
              }
              finish(ip);
            } catch (_) {
              finish("");
            }
          });
        });
      } catch (_) {
        finish("");
        continue;
      }
      req.on("error", () => finish(""));
      req.on("timeout", () => {
        try { req.destroy(); } catch (_) {}
        finish("");
      });
    }
  });
}

// ---- Fabric 服务端安装 ----

const FABRIC_META = "https://meta.fabricmc.net/v2";
const FABRIC_META_MIRROR = "https://bmclapi2.bangbang93.com/fabric-meta/v2";

// 获取 Fabric loader 最新版本
async function getLatestFabricLoader(mcVersion) {
  const urls = [
    `${FABRIC_META}/versions/loader/${mcVersion}`,
    `${FABRIC_META_MIRROR}/versions/loader/${mcVersion}`,
  ];
  for (const url of urls) {
    try {
      xgmclLog.writeLog("INFO", `[Fabric] 拉 loader 列表: ${url}`);
      const res = await fetch(url);
      if (!res.ok) {
        xgmclLog.writeLog("WARN", `[Fabric] HTTP ${res.status}`);
        continue;
      }
      const list = await res.json();
      if (!Array.isArray(list) || list.length === 0) {
        xgmclLog.writeLog("WARN", `[Fabric] 空列表`);
        continue;
      }

      // 优先稳定版
      let pick = null;
      for (const item of list) {
        const isStable = item.loader && item.loader.stable;
        if (isStable) { pick = item; break; }
      }
      if (!pick) pick = list[0];

      // 兼容两种返回结构
      let ver = "";
      if (pick && pick.loader && pick.loader.version) {
        ver = pick.loader.version;
      } else if (pick && pick.version) {
        ver = pick.version;
      }

      if (ver) {
        xgmclLog.writeLog("INFO", `[Fabric] 选中 loader=${ver}`);
        return ver;
      }
    } catch (e) {
      xgmclLog.writeLog("WARN", `[Fabric] 拉失败: ${e.message}`);
    }
  }
  return "";
}

// 从 BMCLAPI 下原版服务端 jar
async function downloadVanillaServerJar(serverDir, mcVersion) {
  const target = path.join(serverDir, "server.jar");
  if (fs.existsSync(target)) {
    xgmclLog.writeLog("INFO", `[Fabric] server.jar 已存在，跳过`);
    return { code: 200, path: target };
  }

  // BMCLAPI 的 version manifest
  const manifestUrls = [
    "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json",
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
  ];

  let versionUrl = "";
  for (const murl of manifestUrls) {
    try {
      xgmclLog.writeLog("INFO", `[Fabric] 拉 manifest: ${murl}`);
      const res = await fetch(murl);
      if (!res.ok) continue;
      const mf = await res.json();
      for (const v of mf.versions || []) {
        if (v.id === mcVersion) {
          versionUrl = v.url || "";
          break;
        }
      }
      if (versionUrl) {
        // 替换成 BMCLAPI 的 version json
        versionUrl = versionUrl.replace(
          "piston-meta.mojang.com",
          "bmclapi2.bangbang93.com"
        );
        break;
      }
    } catch (e) {
      xgmclLog.writeLog("WARN", `[Fabric] manifest 失败: ${e.message}`);
    }
  }

  if (!versionUrl) {
    return { code: 500, msg: `找不到 MC ${mcVersion} 的 manifest` };
  }

  // 拉 version json
  let vj;
  try {
    const res = await fetch(versionUrl);
    if (!res.ok) return { code: 500, msg: `HTTP ${res.status}` };
    vj = await res.json();
  } catch (e) {
    return { code: 500, msg: `拉 version json 失败: ${e.message}` };
  }

  // downloads.server
  const serverInfo = (vj.downloads || {}).server;
  if (!serverInfo || !serverInfo.url) {
    return { code: 500, msg: `MC ${mcVersion} 没有服务端 jar` };
  }

  // 走 BMCLAPI
  const serverUrl = serverInfo.url.replace(
    "piston-data.mojang.com",
    "bmclapi2.bangbang93.com"
  );
  xgmclLog.writeLog("INFO", `[Fabric] 下原版服务端: ${serverUrl}`);

  try {
    const res = await fetch(serverUrl);
    if (!res.ok) return { code: 500, msg: `下载失败 HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(target, buf);
    xgmclLog.writeLog("INFO", `[Fabric] 原版 server.jar 完成 (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
    return { code: 200, path: target };
  } catch (e) {
    return { code: 500, msg: `下载异常: ${e.message}` };
  }
}

// 下载 Fabric 服务端 jar
async function installFabricServer(serverDir, mcVersion, loaderVersion) {
  if (!serverDir || !fs.existsSync(serverDir)) return { code: 400, msg: "服务端目录不存在" };
  if (!mcVersion) return { code: 400, msg: "MC 版本不能为空" };

  let loader = loaderVersion || (await getLatestFabricLoader(mcVersion));
  if (!loader) return { code: 400, msg: `无法获取 MC ${mcVersion} 的 Fabric loader 版本` };

  // 1. 先用 BMCLAPI 下原版 server.jar
  const vanilla = await downloadVanillaServerJar(serverDir, mcVersion);
  if (vanilla.code !== 200) {
    return { code: 500, msg: `原版服务端下载失败: ${vanilla.msg}` };
  }

  // 2. 下 Fabric Installer
  const installerUrl = "https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.1.2/fabric-installer-1.1.2.jar";
  const installerPath = path.join(serverDir, "fabric-installer.jar");

  try {
    xgmclLog.writeLog("INFO", `[Fabric] 下 Installer: ${installerUrl}`);
    const res = await fetch(installerUrl);
    if (!res.ok) return { code: 500, msg: `下载 Installer 失败: HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(installerPath, buf);

    // 3. 执行安装（不加 -downloadMinecraft，复用已下好的 server.jar）
    return new Promise((resolve) => {
      const args = [
        "-jar", installerPath,
        "server",
        "-dir", serverDir,
        "-mcversion", mcVersion,
        "-loader", loader
      ];

      let javaExe = "java";
      try {
        const cfg = require("./config.js").loadServerConfig();
        if (cfg.java_path) javaExe = cfg.java_path;
        else {
          const g = require("./config.js").loadGlobalConfig();
          if (g.global_java_path) javaExe = g.global_java_path;
        }
      } catch (_) {}

      xgmclLog.writeLog("INFO", `[Fabric] 执行: ${javaExe} ${args.join(" ")}`);
      const proc = spawn(javaExe, args, { cwd: serverDir });

      let stdout = "", stderr = "";
      proc.stdout.on("data", (d) => {
        stdout += d.toString();
        xgmclLog.writeLog("INFO", `[Fabric] ${d.toString().trim()}`);
      });
      proc.stderr.on("data", (d) => {
        stderr += d.toString();
        xgmclLog.writeLog("WARN", `[Fabric] ${d.toString().trim()}`);
      });

      proc.on("error", (e) => {
        resolve({ code: 500, msg: `spawn 失败: ${e.message}` });
      });

      proc.on("close", (code) => {
        try { fs.unlinkSync(installerPath); } catch (_) {}

        if (code === 0) {
          resolve({
            code: 200,
            msg: `Fabric ${loader} 服务端安装成功`,
            loader_version: loader
          });
        } else {
          resolve({ code: 500, msg: `安装失败(code=${code}): ${stderr || stdout}` });
        }
      });
    });
  } catch (e) {
    return { code: 500, msg: `安装异常: ${e.message}` };
  }
}

// ---- 扫 jar ----

function scanJars(serverDir) {
  const result = [];
  if (!serverDir || !fs.existsSync(serverDir)) return result;

  try {
    for (const fn of fs.readdirSync(serverDir)) {
      if (!fn.toLowerCase().endsWith(".jar")) continue;
      const full = path.join(serverDir, fn);
      try {
        if (!fs.statSync(full).isFile()) continue;
      } catch (_) { continue; }
      result.push({
        name: fn,
        path: full,
        preferred: fn.toLowerCase() === "fabric-server-launch.jar",
      });
    }
  } catch (e) {
    xgmclLog.writeLog("WARN", `扫 jar 失败: ${e.message}`);
  }

  result.sort((a, b) => {
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return result;
}

// ---- 目录检测 ----

function detectServer(serverDir) {
  const result = {
    valid: false,
    dir: serverDir,
    has_properties: false,
    has_eula: false,
    has_logs: false,
    jars: [],
    preferred_jar: "",
  };
  if (!serverDir || !fs.existsSync(serverDir)) return result;

  result.has_properties = fs.existsSync(path.join(serverDir, "server.properties"));
  result.has_eula = fs.existsSync(path.join(serverDir, "eula.txt"));
  result.has_logs = fs.existsSync(path.join(serverDir, "logs"));

  result.jars = scanJars(serverDir);
  for (const j of result.jars) {
    if (j.preferred) { result.preferred_jar = j.path; break; }
  }
  if (!result.preferred_jar && result.jars.length) {
    result.preferred_jar = result.jars[0].path;
  }

  result.valid = result.has_properties && result.jars.length > 0;
  return result;
}

// ---- server.properties 读写 ----

function readPropertiesLines(serverDir) {
  const p = path.join(serverDir, "server.properties");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf-8").split(/\r?\n/);
}

function readProperties(serverDir) {
  const result = {};
  for (const line of readPropertiesLines(serverDir)) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const idx = s.indexOf("=");
    result[s.slice(0, idx).trim()] = s.slice(idx + 1);
  }
  return result;
}

function saveProperties(serverDir, data) {
  const lines = readPropertiesLines(serverDir);
  let changed = 0;
  const out = [];

  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) {
      out.push(line);
      continue;
    }
    const k = s.slice(0, s.indexOf("=")).trim();
    if (k in data) {
      out.push(`${k}=${String(data[k])}`);
      changed++;
    } else {
      out.push(line);
    }
  }

  const p = path.join(serverDir, "server.properties");
  fs.writeFileSync(p, out.join("\n") + (out.length ? "\n" : ""), "utf-8");
  xgmclLog.writeLog("INFO", `保存 server.properties: ${changed} 个字段改动`);
  return changed;
}

// ---- whitelist.json / ops.json ----

function readWhitelist(serverDir) {
  const p = path.join(serverDir, "whitelist.json");
  if (!fs.existsSync(p)) return [];
  try {
    const d = JSON.parse(fs.readFileSync(p, "utf-8"));
    return Array.isArray(d) ? d : [];
  } catch (e) {
    xgmclLog.writeLog("WARN", `读 whitelist.json 失败: ${e.message}`);
    return [];
  }
}

function saveWhitelist(serverDir, arr) {
  const p = path.join(serverDir, "whitelist.json");
  fs.writeFileSync(p, JSON.stringify(arr, null, 2), "utf-8");
  xgmclLog.writeLog("INFO", `保存 whitelist.json: ${arr.length} 条`);
  return true;
}

function readOps(serverDir) {
  const p = path.join(serverDir, "ops.json");
  if (!fs.existsSync(p)) return [];
  try {
    const d = JSON.parse(fs.readFileSync(p, "utf-8"));
    return Array.isArray(d) ? d : [];
  } catch (e) {
    xgmclLog.writeLog("WARN", `读 ops.json 失败: ${e.message}`);
    return [];
  }
}

function saveOps(serverDir, arr) {
  const p = path.join(serverDir, "ops.json");
  fs.writeFileSync(p, JSON.stringify(arr, null, 2), "utf-8");
  xgmclLog.writeLog("INFO", `保存 ops.json: ${arr.length} 条`);
  return true;
}

// ---- eula ----

function forceEula(serverDir) {
  const p = path.join(serverDir, "eula.txt");
  fs.writeFileSync(
    p,
    "#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n" +
    "eula=true\n",
    "utf-8"
  );
  xgmclLog.writeLog("INFO", "已同意 EULA（eula.txt → eula=true）");
  return true;
}

// ---- 日志路径 ----

function getLogPath(serverDir) {
  return path.join(serverDir, "logs", "latest.log");
}

// ---- 启动 / 停止 ----

function startServer(serverDir, jarPath, ramMb, jvmArgs, javaPath) {
  if (SERVER_STATE.running) return { code: 400, msg: "服务端已在运行" };

  if (!fs.existsSync(serverDir)) {
    return { code: 400, msg: `服务端目录不存在: ${serverDir}` };
  }
  if (!fs.existsSync(jarPath)) {
    return { code: 400, msg: `jar 不存在: ${jarPath}` };
  }

  const javaExe = (javaPath || "").trim() || "java";
  if (javaExe !== "java" && !fs.existsSync(javaExe)) {
    return { code: 400, msg: `找不到 Java: ${javaExe}` };
  }

  try {
    forceEula(serverDir);
  } catch (e) {
    return { code: 500, msg: `写 eula.txt 失败: ${e.message}` };
  }

  const args = [];
  if (jvmArgs) {
    args.push(...jvmArgs.split(/\s+/).filter(Boolean));
  } else {
    args.push("-Xmx4G", "-Xms2G");
  }
  args.push("-jar", path.basename(jarPath), "nogui");

  xgmclLog.writeLog("INFO", `启动服务端: ${jarPath} (RAM=${ramMb}MB, dir=${serverDir})`);

  let proc;
  try {
    proc = spawn(javaExe, args, {
      cwd: serverDir,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
  } catch (e) {
    xgmclLog.writeLog("ERROR", `服务端启动失败: ${e.message}`);
    return { code: 500, msg: `启动失败: ${e.message}` };
  }

  proc.on("error", (e) => {
    xgmclLog.writeLog("ERROR", `服务端进程错误: ${e.message}`);
  });
  proc.on("exit", (code) => {
    xgmclLog.writeLog("INFO", `服务端进程已退出 (code=${code})`);
    SERVER_STATE.running = false;
    SERVER_STATE.pid = 0;
    SERVER_PROC = null;
  });

  SERVER_PROC = proc;
  SERVER_STATE.running = true;
  SERVER_STATE.pid = proc.pid;
  SERVER_STATE.dir = serverDir;
  SERVER_STATE.jar = path.basename(jarPath);
  SERVER_STATE.start_time = Math.floor(Date.now() / 1000);

  xgmclLog.writeLog("INFO", `服务端已启动 (PID=${proc.pid})`);
  return { code: 200, msg: "服务端已启动", pid: proc.pid };
}

function stopServer() {
  return new Promise((resolve) => {
    if (!SERVER_STATE.running || !SERVER_PROC) {
      return resolve({ code: 400, msg: "服务端未运行" });
    }
    const proc = SERVER_PROC;

    try {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write("stop\n");
      }
    } catch (e) {
      xgmclLog.writeLog("WARN", `发 stop 失败: ${e.message}`);
    }

    let finished = false;
    const onExit = () => {
      if (finished) return;
      finished = true;
      SERVER_STATE.running = false;
      SERVER_STATE.pid = 0;
      SERVER_PROC = null;
      resolve({ code: 200, msg: "服务端已停止" });
    };

    proc.once("exit", onExit);

    setTimeout(() => {
      if (finished) return;
      try {
        if (process.platform === "win32") {
          execFile("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { windowsHide: true }, () => {});
        } else {
          proc.kill("SIGKILL");
        }
      } catch (_) {}
      setTimeout(onExit, 500);
    }, 3000);
  });
}

function isRunning() {
  if (!SERVER_STATE.running) return false;
  if (!SERVER_PROC) {
    SERVER_STATE.running = false;
    return false;
  }
  if (SERVER_PROC.exitCode !== null) {
    SERVER_STATE.running = false;
    SERVER_PROC = null;
    return false;
  }
  return true;
}

// ---- 控制台读取 ----

function tailConsole(serverDir, offset, maxLines = 500) {
  const p = getLogPath(serverDir);
  if (!fs.existsSync(p)) return { lines: [], next_offset: offset, exists: false };

  try {
    const curSize = fs.statSync(p).size;
    if (curSize < offset) offset = 0;

    const fd = fs.openSync(p, "r");
    const bufSize = curSize - offset;
    if (bufSize <= 0) {
      fs.closeSync(fd);
      return { lines: [], next_offset: curSize, exists: true };
    }
    const buf = Buffer.alloc(bufSize);
    fs.readSync(fd, buf, 0, bufSize, offset);
    fs.closeSync(fd);

    const text = buf.toString("utf-8");
    let lines = text.split(/\r?\n/);
    if (lines.length > maxLines) lines = lines.slice(-maxLines);
    return { lines, next_offset: curSize, exists: true };
  } catch (e) {
    xgmclLog.writeLog("WARN", `读服务端日志失败: ${e.message}`);
    return { lines: [], next_offset: offset, exists: false };
  }
}

function readConsoleFromStart(serverDir, maxLines = 2000) {
  const p = getLogPath(serverDir);
  if (!fs.existsSync(p)) return { lines: [], next_offset: 0 };

  try {
    const buf = fs.readFileSync(p);
    const text = buf.toString("utf-8");
    let lines = text.split(/\r?\n/);
    if (lines.length > maxLines) lines = lines.slice(-maxLines);
    return { lines, next_offset: buf.length };
  } catch (e) {
    xgmclLog.writeLog("WARN", `读服务端日志失败: ${e.message}`);
    return { lines: [], next_offset: 0 };
  }
}

// ---- 发命令 ----

function sendCommand(cmd) {
  if (!SERVER_STATE.running || !SERVER_PROC) {
    return { code: 400, msg: "服务端未运行" };
  }
  try {
    if (SERVER_PROC.stdin && !SERVER_PROC.stdin.destroyed) {
      SERVER_PROC.stdin.write(cmd + "\n");
    }
    xgmclLog.writeLog("INFO", `发送服务端命令: ${cmd}`);
    return { code: 200, msg: "已发送" };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `发送命令失败: ${e.message}`);
    return { code: 500, msg: `发送失败: ${e.message}` };
  }
}

module.exports = {
  SERVER_STATE,
  scanJars,
  scanPlugins,
  getPluginsDir,
  ensurePluginsDir,
  isPrivateIPv4,
  getPublicIPv4,
  getLatestFabricLoader,
  downloadVanillaServerJar,
  installFabricServer,
  detectServer,
  readProperties,
  saveProperties,
  readWhitelist,
  saveWhitelist,
  readOps,
  saveOps,
  forceEula,
  getLogPath,
  startServer,
  stopServer,
  isRunning,
  tailConsole,
  readConsoleFromStart,
  sendCommand,
};