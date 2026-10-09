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

// java_deep_scan.js —— 全盘扫描 javaw.exe / java.exe

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const xgmclLog = require("./xgmcl_log.js");

// 全局扫描状态（同时只允许一个扫描）
const SCAN_STATE = {
  active: false,
  cancel: false,
  current_dir: "",
  dirs_scanned: 0,
  dirs_total: 0,
  found: [],       // 已找到的 Java 信息
  error: null,
  done: false,
  start_time: 0,
  end_time: 0,
};

// 跳过这些目录（避免死循环 / 权限 / 无意义的系统目录）
const SKIP_DIR_NAMES = new Set([
  "$recycle.bin",
  "system volume information",
  "windows",
  "winsxs",
  "recovery",
  "perflogs",
  "config.msi",
  "msocache",
  "boot",
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "temp",
  "tmp",
  "cache",
  "caches",
]);

// 跳过的绝对路径前缀（小写）
const SKIP_ABS_PREFIXES = [
  "c:\\windows",
  "c:\\program files\\windows",
  "c:\\programdata\\microsoft",
  "c:\\$recycle.bin",
];

function shouldSkipDir(dirName, absPath) {
  const lower = dirName.toLowerCase();
  if (SKIP_DIR_NAMES.has(lower)) return true;

  const absLower = absPath.toLowerCase();
  for (const p of SKIP_ABS_PREFIXES) {
    if (absLower === p || absLower.startsWith(p + "\\")) return true;
  }
  return false;
}

// 拿所有本地盘符
function listDrives() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve([]);
    execFile(
      "wmic",
      ["logicaldisk", "get", "name", "/value"],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const drives = [];
        for (const line of stdout.split(/\r?\n/)) {
          const m = line.match(/Name=([A-Z]:)/);
          if (m) drives.push(m[1] + "\\");
        }
        resolve(drives);
      }
    );
  });
}

// 探测一个 java 可执行文件
function probeJava(exe) {
  return new Promise((resolve) => {
    execFile(exe, ["-version"], { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      const out = (stderr || "") + (stdout || "");
      if (!out) return resolve(null);

      const m = out.match(/version "([^"]+)"/);
      if (!m) return resolve(null);
      const ver = m[1];

      let major = 0;
      try {
        major = ver.startsWith("1.")
          ? parseInt(ver.split(".")[1], 10)
          : parseInt(ver.split(".")[0], 10);
      } catch (_) { major = 0; }
      if (isNaN(major)) major = 0;

      let vendor = "Unknown";
      const low = out.toLowerCase();
      if (low.includes("temurin")) vendor = "Adoptium Temurin";
      else if (low.includes("adoptium")) vendor = "Adoptium";
      else if (low.includes("zulu")) vendor = "Azul Zulu";
      else if (low.includes("corretto")) vendor = "Amazon Corretto";
      else if (low.includes("microsoft")) vendor = "Microsoft";
      else if (low.includes("oracle")) vendor = "Oracle";
      else if (low.includes("openjdk")) vendor = "OpenJDK";

      resolve({ version: ver, major, vendor, is64: out.includes("64-bit") });
    });
  });
}

// 深扫一个根目录
async function scanRoot(root) {
  const stack = [root];

  while (stack.length > 0) {
    if (SCAN_STATE.cancel) return;

    const cur = stack.pop();
    SCAN_STATE.current_dir = cur;
    SCAN_STATE.dirs_scanned++;

    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      // 权限 / 文件被锁 / 路径太长，跳过
      continue;
    }

    for (const ent of entries) {
      if (SCAN_STATE.cancel) return;

      const abs = path.join(cur, ent.name);

      if (ent.isDirectory()) {
        if (shouldSkipDir(ent.name, abs)) continue;
        stack.push(abs);
      } else if (ent.isFile()) {
        const nameLower = ent.name.toLowerCase();
        if (nameLower === "javaw.exe" || nameLower === "java.exe") {
          // 检查是否已经找到同目录的
          const dirLower = cur.toLowerCase();
          const exists = SCAN_STATE.found.some(
            (j) => path.dirname(j.path).toLowerCase() === dirLower
          );
          if (exists) continue;

          const info = await probeJava(abs);
          if (info) {
            info.path = abs;
            SCAN_STATE.found.push(info);
            xgmclLog.writeLog("INFO", `[JavaScan] 找到 Java: ${info.path} (v${info.version})`);
          }
        }
      }
    }
  }
}

// 主入口：启动扫描（异步，不阻塞）
function startDeepScan() {
  if (SCAN_STATE.active) {
    return { code: 400, msg: "扫描已在进行中" };
  }

  Object.assign(SCAN_STATE, {
    active: true,
    cancel: false,
    current_dir: "",
    dirs_scanned: 0,
    dirs_total: 0,
    found: [],
    error: null,
    done: false,
    start_time: Math.floor(Date.now() / 1000),
    end_time: 0,
  });

  // 后台跑
  (async () => {
    try {
      const drives = await listDrives();
      xgmclLog.writeLog("INFO", `[JavaScan] 开始深扫，盘符: ${drives.join(", ")}`);

      for (const drive of drives) {
        if (SCAN_STATE.cancel) break;
        xgmclLog.writeLog("INFO", `[JavaScan] 扫描 ${drive}`);
        await scanRoot(drive);
      }

      // 去重 + 排序
      const seen = new Set();
      const unique = [];
      for (const j of SCAN_STATE.found) {
        const key = path.normalize(j.path).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(j);
      }
      unique.sort((a, b) => {
        if (a.major !== b.major) return b.major - a.major;
        if (a.vendor !== b.vendor) return a.vendor.localeCompare(b.vendor);
        return a.path.localeCompare(b.path);
      });

      SCAN_STATE.found = unique;
      SCAN_STATE.done = true;
      SCAN_STATE.active = false;
      SCAN_STATE.end_time = Math.floor(Date.now() / 1000);

      xgmclLog.writeLog("INFO",
        `[JavaScan] 扫描完成，共找到 ${unique.length} 个 Java，扫描 ${SCAN_STATE.dirs_scanned} 个目录`
      );
    } catch (e) {
      SCAN_STATE.error = e.message;
      SCAN_STATE.active = false;
      SCAN_STATE.done = true;
      xgmclLog.writeLog("ERROR", `[JavaScan] 扫描失败: ${e.message}`);
    }
  })();

  return { code: 200, msg: "扫描已开始" };
}

// 取消
function cancelDeepScan() {
  if (!SCAN_STATE.active) return { code: 400, msg: "没有正在进行的扫描" };
  SCAN_STATE.cancel = true;
  return { code: 200, msg: "已发送取消信号" };
}

// 查进度
function getScanState() {
  return {
    active: SCAN_STATE.active,
    cancel: SCAN_STATE.cancel,
    current_dir: SCAN_STATE.current_dir,
    dirs_scanned: SCAN_STATE.dirs_scanned,
    found_count: SCAN_STATE.found.length,
    found: SCAN_STATE.found.map((j) => ({
      path: j.path,
      version: j.version,
      major: j.major,
      vendor: j.vendor,
      is64: j.is64,
    })),
    error: SCAN_STATE.error,
    done: SCAN_STATE.done,
    start_time: SCAN_STATE.start_time,
    end_time: SCAN_STATE.end_time,
  };
}

module.exports = {
  startDeepScan,
  cancelDeepScan,
  getScanState,
};