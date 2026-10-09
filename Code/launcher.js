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

// launcher.js —— Minecraft 启动核心

const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const verMod = require("./version.js");
const xgmclLog = require("./xgmcl_log.js");

// 启动状态（单例）
const LAUNCH_STATE = {
  active: false,
  stage: "",
  progress: 0,
  error: null,
  done: false,
  pid: 0,
  start_time: 0,
};

function setStage(stage, progress) {
  LAUNCH_STATE.stage = stage;
  LAUNCH_STATE.progress = progress;
}

function getLaunchState() {
  return { ...LAUNCH_STATE };
}

// 如果传进来 java.exe，优先换成 javaw.exe（不弹黑框）
function preferJavaw(javaPath) {
  if (!javaPath) return javaPath;
  if (javaPath.toLowerCase().endsWith("java.exe")) {
    const javaw = javaPath.slice(0, -"java.exe".length) + "javaw.exe";
    if (fs.existsSync(javaw)) return javaw;
  }
  return javaPath;
}

// 设置进程优先级（Windows）
function setProcessPriority(pid, priorityName) {
  if (process.platform !== "win32") return;

  // Windows 优先级常量
  const priorityMap = {
    "极低": "Idle",
    "低与正常": "BelowNormal",
    "正常": "Normal",
    "高于正常": "AboveNormal",
    "高": "High",
    "实时": "Realtime",
  };
  const level = priorityMap[priorityName] || "Normal";

  // 用 wmic 改优先级
  execFile(
    "wmic",
    ["process", "where", `ProcessId=${pid}`, "call", "setpriority", level],
    { timeout: 5000, windowsHide: true },
    (err) => {
      if (err) {
        xgmclLog.writeLog("WARN", `设置进程优先级失败: ${err.message}`);
      } else {
        xgmclLog.writeLog("INFO", `进程优先级已设为: ${priorityName}`);
      }
    }
  );
}

// 写 options.txt 强制简体中文
function ensureDefaultLanguage(gameDir) {
  try {
    const optionsFile = path.join(gameDir, "options.txt");
    let lines = [];
    if (fs.existsSync(optionsFile)) {
      lines = fs.readFileSync(optionsFile, "utf-8").split(/\r?\n/);
    }

    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("lang:")) {
        lines[i] = "lang:zh_cn";
        found = true;
        break;
      }
    }
    if (!found) lines.push("lang:zh_cn");

    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(optionsFile, lines.join("\n") + "\n", "utf-8");
  } catch (e) {
    console.log(`[默认语言] 写入失败: ${e.message}`);
  }
}

// 启动游戏（异步）
// 返回 {code, msg, pid}
async function launchGame(opts) {
  const {
    gameRoot,
    versionName,
    username,
    ramMb = 2048,
    javaPath = "java",
    jvmArgsExtra = "",
    priority = "正常",
    isolated = false,
    gameDir = null,
  } = opts;

  Object.assign(LAUNCH_STATE, {
    active: true,
    stage: "准备中...",
    progress: 0,
    error: null,
    done: false,
    pid: 0,
    start_time: Date.now(),
  });

  const verDir = path.join(gameRoot, "versions", versionName);
  const jsonPath = path.join(verDir, `${versionName}.json`);

  let finalGameDir = gameDir;
  if (!finalGameDir) {
    finalGameDir = isolated
      ? path.join(verDir, ".minecraft")
      : gameRoot;
  }
  if (isolated) {
    fs.mkdirSync(finalGameDir, { recursive: true });
  }

  try {
    // 阶段 1: 检查 Java
    setStage("检查 Java...", 0);
    const javaExe = preferJavaw(javaPath);
    setStage("检查 Java...", 5);
    if (javaExe !== "java" && !fs.existsSync(javaExe)) {
      throw new Error(`找不到 Java: ${javaExe}`);
    }
    setStage("检查 Java...", 15);

    // 阶段 2: 检查 json
    setStage("检查版本 JSON...", 15);
    if (!fs.existsSync(jsonPath)) {
      throw new Error(`找不到版本 JSON: ${jsonPath}`);
    }
    const vj = verMod.loadVersionJsonWithInherit(gameRoot, versionName);
    setStage("检查版本 JSON...", 30);

    const libsRoot = path.join(gameRoot, "libraries");
    const assetsRoot = path.join(gameRoot, "assets");
    const nativesDir = path.join(verDir, `${versionName}-natives`);
    const clientJar = path.join(verDir, `${versionName}.jar`);

    // 阶段 3: 检查 jar
    setStage("检查客户端 jar...", 30);
    if (!fs.existsSync(clientJar)) {
      throw new Error(`找不到客户端 jar: ${clientJar}`);
    }
    setStage("检查客户端 jar...", 45);

    // 阶段 4: classpath + natives
    setStage("构建 classpath...", 45);
    const classpath = verMod.buildClasspath(vj, libsRoot, clientJar);
    setStage("解压 natives...", 65);
    verMod.extractNatives(vj, libsRoot, nativesDir);
    setStage("依赖库就绪", 80);

    // 强制中文
    ensureDefaultLanguage(finalGameDir);

    const accUuid = verMod.offlineUuid(username);

    const varMap = {
      auth_player_name: username,
      version_name: versionName,
      game_directory: finalGameDir,
      assets_root: assetsRoot,
      assets_index_name: (vj.assetIndex || {}).id || "29",
      auth_uuid: accUuid,
      auth_access_token: "0",
      clientid: "",
      auth_xuid: "",
      version_type: vj.type || "release",
      natives_directory: nativesDir,
      classpath: classpath,
      launcher_name: "XGLauncher",
      launcher_version: "2.0.0",
      resolution_width: "1280",
      resolution_height: "720",

      // NeoForge / Forge 需要的额外变量
      library_directory: libsRoot,
      classpath_separator: ";",
      user_type: "msa",   // 或者 "legacy"，先用 msa
      auth_session: "",
      auth_access_token: "0",
      user_properties: "{}",
      profile_name: "XGLauncher",
    };

    // 拼命令
    const cmd = [javaExe];
    const jvmLower = (jvmArgsExtra || "").toLowerCase();
    const hasXmx = jvmLower.includes("-xmx");
    const hasXms = jvmLower.includes("-xms");

    if (!hasXmx) cmd.push(`-Xmx${ramMb}M`);
    if (!hasXms) cmd.push(`-Xms${Math.floor(ramMb / 2)}M`);

    if (jvmArgsExtra) {
      cmd.push(...jvmArgsExtra.split(/\s+/).filter(Boolean));
    }

    const jvmArgs = verMod.replaceVars((vj.arguments || {}).jvm || [], varMap);
    cmd.push(...jvmArgs);

    const mainClass = vj.mainClass || "net.minecraft.client.main.Main";
    const joined = jvmArgs.join(" ");
    if (!joined.includes(mainClass)) {
      cmd.push(mainClass);
    }

    const gameArgs = verMod.replaceVars((vj.arguments || {}).game || [], varMap);
    cmd.push(...gameArgs);

    console.log("=".repeat(70));
    console.log(`   启动 ${versionName}`);
    console.log(`   Java: ${javaExe}`);
    console.log(`   内存: ${ramMb}MB`);
    console.log(`   优先级: ${priority}`);
    console.log(`   隔离: ${isolated ? "开启" : "关闭"}`);
    console.log(`   工作目录: ${finalGameDir}`);
    console.log("=".repeat(70));

    // 阶段 5: 启动进程
    setStage("启动进程...", 80);

    // 把 Java 的 stdout/stderr 写文件，方便调试
    const launchLogPath = path.join(verDir, "xgmcl_launch.log");
    const launchLogFd = fs.openSync(launchLogPath, "w");

    // 把完整命令写进日志头，方便对照
    fs.writeSync(launchLogFd, "=== 启动命令 ===\n");
    fs.writeSync(launchLogFd, `${javaExe} ${cmd.slice(1).join(" ")}\n\n`);
    fs.writeSync(launchLogFd, "=== Java 输出 ===\n");

    const proc = spawn(javaExe, cmd.slice(1), {
      cwd: finalGameDir,
      stdio: ["ignore", launchLogFd, launchLogFd],
      windowsHide: true,
      detached: false,
    });

    proc.on("exit", (code) => {
      try { fs.closeSync(launchLogFd); } catch (_) {}
      xgmclLog.writeLog("INFO", `游戏进程退出 (code=${code}), 日志: ${launchLogPath}`);
    });

    proc.on("error", (e) => {
      xgmclLog.writeLog("ERROR", `进程启动失败: ${e.message}`);
    });

    // 0.5 秒后设优先级
    if (priority && priority !== "正常") {
      setTimeout(() => setProcessPriority(proc.pid, priority), 500);
    }

    setStage("启动完成", 100);

    Object.assign(LAUNCH_STATE, {
      done: true,
      active: false,
      pid: proc.pid,
    });

    xgmclLog.writeLog("INFO", `游戏进程已启动 (PID=${proc.pid})`);
    return { code: 200, msg: "启动成功", pid: proc.pid };

  } catch (e) {
    xgmclLog.writeLog("ERROR", `启动失败: ${e.message}`);
    Object.assign(LAUNCH_STATE, {
      error: e.message,
      active: false,
    });
    return { code: 500, msg: `启动失败: ${e.message}` };
  }
}

// 检查进程是否存活
function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    // 用 process.kill(pid, 0) 探测
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

// 杀游戏进程（只允许杀 java/javaw）
function killGame(pid) {
  return new Promise((resolve) => {
    if (!pid) {
      return resolve({ code: 400, msg: "pid 为空" });
    }

    // 校验是不是 java 进程
    execFile(
      "wmic",
      ["process", "where", `ProcessId=${pid}`, "get", "Name", "/value"],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) {
          return resolve({ code: 200, msg: "进程已不存在" });
        }
        const m = stdout.match(/Name=(\S+)/);
        const name = m ? m[1].toLowerCase() : "";
        if (!name.includes("java")) {
          return resolve({ code: 400, msg: "该 PID 不是 Java 进程，拒绝操作" });
        }

        // 杀进程树
        execFile(
          "taskkill",
          ["/F", "/T", "/PID", String(pid)],
          { timeout: 5000, windowsHide: true },
          (killErr) => {
            if (killErr) {
              xgmclLog.writeLog("ERROR", `关闭游戏失败 PID=${pid}: ${killErr.message}`);
              return resolve({ code: 500, msg: `关闭失败: ${killErr.message}` });
            }
            xgmclLog.writeLog("INFO", `用户强制关闭游戏进程 PID=${pid}`);
            resolve({ code: 200, msg: "已关闭游戏" });
          }
        );
      }
    );
  });
}

module.exports = {
  launchGame,
  isProcessAlive,
  killGame,
  getLaunchState,
};