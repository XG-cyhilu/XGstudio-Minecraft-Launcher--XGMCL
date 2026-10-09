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

// terminal.js —— 内置终端（常驻会话 + 多编码支持）

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const { StringDecoder } = require("string_decoder");
const xgmclLog = require("./xgmcl_log.js");

// ---- 会话表 ----
const SESSIONS = new Map();

const MAX_BUFFER_CHARS = 2 * 1024 * 1024; // 2MB

// ---- shell 探测 ----

function which(cmd) {
  try {
    const checker = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(checker, [cmd], {
      timeout: 3000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.toString().trim().split(/\r?\n/)[0] || "";
  } catch (_) {
    return "";
  }
}

function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return "";
}

function detectShells() {
  const result = [];

  if (process.platform === "win32") {
    const sysRoot = process.env.SystemRoot || "C:\\Windows";

    // ---- PowerShell ----
    let psPath = firstExisting([
      path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      path.join(sysRoot, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ]);
    if (!psPath) psPath = which("powershell.exe") || which("powershell");

    if (psPath) {
      result.push({
        id: "powershell",
        name: "PowerShell",
        path: psPath,
        args: [
          "-NoLogo", "-NoProfile", "-NoExit",
          "-Command",
          "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
          "$OutputEncoding=[System.Text.Encoding]::UTF8; " +
          "chcp 65001 > $null; " +
          "-"
        ],
      });
    } else {
      let pwshPath = which("pwsh.exe") || which("pwsh");
      if (!pwshPath) {
        pwshPath = firstExisting([
          path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
          path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "PowerShell", "7", "pwsh.exe"),
        ]);
      }
      if (pwshPath) {
        result.push({
          id: "powershell",
          name: "PowerShell 7 (pwsh)",
          path: pwshPath,
          args: [
            "-NoLogo", "-NoProfile", "-NoExit",
            "-Command",
            "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
            "$OutputEncoding=[System.Text.Encoding]::UTF8; " +
            "-"
          ],
        });
      }
    }

    // ---- CMD ----
    let cmdPath = firstExisting([
      path.join(sysRoot, "System32", "cmd.exe"),
    ]);
    if (!cmdPath) cmdPath = which("cmd.exe") || which("cmd");

    if (cmdPath) {
      result.push({
        id: "cmd",
        name: "CMD",
        path: cmdPath,
        args: ["/Q", "/K", "chcp 65001 >nul"],
        // 让一些常见工具也输出 UTF-8
        env: {
          PYTHONIOENCODING: "utf-8",
        },
      });
    }


  } else {
    const bashPath = which("bash");
    if (bashPath) {
      result.push({
        id: "bash",
        name: "Bash",
        path: bashPath,
        args: ["-i"],
        env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
      });
    } else {
      const shPath = which("sh");
      if (shPath) {
        result.push({
          id: "bash",
          name: "sh",
          path: shPath,
          args: ["-i"],
          env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
        });
      }
    }
  }

  xgmclLog.writeLog(
    "INFO",
    `[Terminal] 探测到 ${result.length} 个 shell: ${result.map((s) => s.id).join(", ") || "(无)"}`
  );
  return result;
}

// ---- 会话管理 ----

function startSession(shellId) {
  if (!shellId) shellId = "powershell";

  const shells = detectShells();
  const target = shells.find((s) => s.id === shellId);
  if (!target) {
    return { code: 400, msg: `本机没有可用的 ${shellId}` };
  }

  const id = crypto.randomUUID();

  let proc;
  try {
    proc = spawn(target.path, target.args, {
      cwd: process.env.USERPROFILE || process.env.HOME || process.cwd(),
      env: {
        ...process.env,
        TERM: "xterm-256color",
        ...(target.env || {}),
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    xgmclLog.writeLog("ERROR", `[Terminal] spawn 失败: ${e.message}`);
    return { code: 500, msg: `启动失败: ${e.message}` };
  }

  const sess = {
    id,
    shell: shellId,
    shell_name: target.name,
    proc,
    alive: true,
    buffer: "",
    offset: 0,
    started_at: Math.floor(Date.now() / 1000),
    exit_code: null,
  };

  // ---- 输出解码 ----
  // 所有 shell 都强制输出 UTF-8，Node 侧用 StringDecoder 处理多字节字符跨 chunk
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  function append(text) {
    if (!text) return;
    sess.buffer += text;
    if (sess.buffer.length > MAX_BUFFER_CHARS) {
      const cut = sess.buffer.length - MAX_BUFFER_CHARS;
      sess.buffer = sess.buffer.slice(cut);
      sess.offset = Math.max(0, sess.offset - cut);
    }
  }

  function appendStdout(buf) {
    try { append(stdoutDecoder.write(buf)); } catch (_) {}
  }

  function appendStderr(buf) {
    try { append(stderrDecoder.write(buf)); } catch (_) {}
  }

  proc.stdout.on("data", appendStdout);
  proc.stderr.on("data", appendStderr);

  proc.on("error", (e) => {
    append(`\n[进程错误] ${e.message}\n`);
    sess.alive = false;
    xgmclLog.writeLog("ERROR", `[Terminal] ${id} 进程错误: ${e.message}`);
  });

  proc.on("exit", (code) => {
    sess.alive = false;
    sess.exit_code = code;
    try { append(stdoutDecoder.end()); } catch (_) {}
    try { append(stderrDecoder.end()); } catch (_) {}
    append(`\n[进程已退出，code=${code}]\n`);
    xgmclLog.writeLog("INFO", `[Terminal] 会话 ${id} 退出，code=${code}`);
  });

  SESSIONS.set(id, sess);

  xgmclLog.writeLog("INFO", `[Terminal] 新会话 ${id} (${target.name})`);

  return {
    code: 200,
    session_id: id,
    shell: shellId,
    shell_name: target.name,
  };
}

function getSession(id) {
  return SESSIONS.get(id) || null;
}

function writeInput(id, data) {
  const sess = SESSIONS.get(id);
  if (!sess) return { code: 404, msg: "会话不存在" };
  if (!sess.alive) return { code: 400, msg: "会话已退出" };

  try {
    if (sess.proc.stdin && !sess.proc.stdin.destroyed) {
      sess.proc.stdin.write(String(data || ""));
      return { code: 200, msg: "已发送" };
    }
    return { code: 400, msg: "stdin 不可用" };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `[Terminal] 写输入失败: ${e.message}`);
    return { code: 500, msg: e.message };
  }
}

function readOutput(id, offset) {
  const sess = SESSIONS.get(id);
  if (!sess) return { code: 404, msg: "会话不存在" };

  let off = parseInt(offset || "0", 10) || 0;
  if (off < 0) off = 0;
  if (off > sess.buffer.length) off = 0;

  const data = sess.buffer.slice(off);
  sess.offset = sess.buffer.length;

  return {
    code: 200,
    data,
    next_offset: sess.buffer.length,
    alive: sess.alive,
    exit_code: sess.exit_code,
  };
}

function stopSession(id) {
  const sess = SESSIONS.get(id);
  if (!sess) return { code: 404, msg: "会话不存在" };

  try {
    if (sess.alive && sess.proc) {
      try {
        if (sess.proc.stdin && !sess.proc.stdin.destroyed) {
          sess.proc.stdin.write("exit\n");
        }
      } catch (_) {}

      setTimeout(() => {
        try {
          if (sess.alive && sess.proc) sess.proc.kill();
        } catch (_) {}
      }, 1500);
    }
  } catch (e) {
    xgmclLog.writeLog("WARN", `[Terminal] 停止会话失败: ${e.message}`);
  }

  SESSIONS.delete(id);
  xgmclLog.writeLog("INFO", `[Terminal] 会话 ${id} 已移除`);
  return { code: 200, msg: "已停止" };
}

function listSessions() {
  return Array.from(SESSIONS.values()).map((s) => ({
    id: s.id,
    shell: s.shell,
    shell_name: s.shell_name,
    alive: s.alive,
    started_at: s.started_at,
    buffer_len: s.buffer.length,
  }));
}

module.exports = {
  detectShells,
  startSession,
  getSession,
  writeInput,
  readOutput,
  stopSession,
  listSessions,
};