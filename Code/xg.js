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

// xg.js —— XGstudio 账号（读写 Windows 注册表）

const { execFile } = require("child_process");
const bcrypt = require("bcryptjs");
const iconv = require("iconv-lite");
const xgmclLog = require("./xgmcl_log.js");

const REG_BASE = "HKCU\\Software\\XGstudio";
const REG_YON = "HKCU\\Software\\XGstudio\\YON_ON";
const REG_SESSION = "HKCU\\Software\\XGstudio\\session";

// 会话状态（内存）
const SESSION = {
  logged_in: false,
  username: "",
  role: "",
  login_time: 0,
};

// ---- reg.exe 辅助 ----

function regQuery(key, valueName) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve(null);
    const args = ["query", key];
    if (valueName) args.push("/v", valueName);
    execFile(
      "reg",
      args,
      { timeout: 5000, windowsHide: true, encoding: "buffer" },
      (err, stdout) => {
        if (err) return resolve(null);
        if (!stdout) return resolve("");
        // Windows 中文版 reg.exe 输出是 GBK
        resolve(iconv.decode(Buffer.from(stdout), "gbk"));
      }
    );
  });
}

function regSet(key, valueName, data) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve(false);
    const args = ["add", key, "/v", valueName, "/t", "REG_SZ", "/d", String(data), "/f"];
    execFile("reg", args, { timeout: 5000, windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

function regDelete(key, valueName) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve(false);
    const args = ["delete", key, "/v", valueName, "/f"];
    execFile("reg", args, { timeout: 5000, windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

function extractValue(stdout) {
  if (!stdout) return null;
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/REG_SZ\s+(.*)$/);
    if (m) return m[1].trim();
  }
  return null;
}

// ---- 账号读取 ----

async function readAccount() {
  const out = await regQuery(REG_BASE);
  xgmclLog.writeLog("INFO", `[xg] reg query 输出长度: ${out ? out.length : 0}`);
  if (!out) return null;

  const result = { username: "", hash: "", role: null, raw_mac: "" };
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/\s+(\S+)\s+REG_SZ\s+(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim();
    if (key === "用户名") result.username = val;
    else if (key === "bcrypt_hash") result.hash = val;
    else if (key === "XGstu职位") result.role = val;
    else if (key === "raw_mac") result.raw_mac = val;
  }

  xgmclLog.writeLog("INFO", `[xg] 解析结果: username=${result.username || "(空)"}, hash=${result.hash ? "有" : "(空)"}, role=${result.role || "(空)"}`);

  if (!result.username) return null;
  return result;
}

async function yonOn() {
  const out = await regQuery(REG_YON);
  if (!out) return false;
  const v = extractValue(out);
  return v !== null && v.toLowerCase() === "yes";
}

// ---- 会话持久化 ----

async function sessionSave(username, role, loginTime) {
  const val = `${loginTime}:${username}:${role || ""}`;
  await regSet(REG_SESSION, "", val);
}

async function sessionLoad() {
  const out = await regQuery(REG_SESSION);
  if (!out) return null;
  const val = extractValue(out);
  if (!val) return null;
  const parts = val.split(":");
  if (parts.length < 3) return null;
  const ts = parseInt(parts[0], 10);
  const username = parts[1];
  const role = parts.slice(2).join(":");
  if (!username || !ts) return null;
  return { username, role, login_time: ts };
}

async function sessionClear() {
  await regDelete(REG_SESSION, "");
}

// ---- API ----

async function status() {
  const acc = await readAccount();
  const yon = await yonOn();
  return {
    code: 200,
    registered: acc !== null && yon,
    logged_in: SESSION.logged_in,
    username: SESSION.logged_in ? SESSION.username : "",
    role: SESSION.logged_in ? SESSION.role : "",
  };
}

async function login(username, password) {
  if (SESSION.logged_in) return { code: 400, msg: "已登录，请先退出" };

  const yon = await yonOn();
  xgmclLog.writeLog("INFO", `[xg] YON_ON = ${yon}`);
  if (!yon) {
    return { code: 400, msg: "本机未注册 XGstudio 账号（YON_ON 未开启）" };
  }

  const acc = await readAccount();
  if (!acc) return { code: 400, msg: "读取注册表失败" };

  xgmclLog.writeLog("INFO", `[xg] 注册表用户名 = ${acc.username}, 输入用户名 = ${username}`);

  if (username.trim() !== acc.username) {
    return { code: 400, msg: "用户名或密码错误" };
  }

  let ok = false;
  try {
    ok = await bcrypt.compare(password, acc.hash);
  } catch (e) {
    xgmclLog.writeLog("ERROR", `[xg] bcrypt 校验异常: ${e.message}`);
    return { code: 400, msg: "用户名或密码错误" };
  }

  xgmclLog.writeLog("INFO", `[xg] bcrypt 校验结果 = ${ok}`);

  if (!ok) return { code: 400, msg: "用户名或密码错误" };

  const now = Math.floor(Date.now() / 1000);
  SESSION.logged_in = true;
  SESSION.username = acc.username;
  SESSION.role = acc.role || "";
  SESSION.login_time = now;

  await sessionSave(acc.username, acc.role || "", now);

  xgmclLog.writeLog("INFO", `XGstudio 登录成功: ${acc.username} (职位=${acc.role || "无"})`);
  return { code: 200, msg: "登录成功", username: acc.username, role: acc.role || "" };
}

async function logout() {
  const old = SESSION.username;
  SESSION.logged_in = false;
  SESSION.username = "";
  SESSION.role = "";
  SESSION.login_time = 0;
  await sessionClear();
  if (old) xgmclLog.writeLog("INFO", `XGstudio 退出登录: ${old}`);
  return { code: 200, msg: "已退出" };
}

async function restoreSession() {
  const saved = await sessionLoad();
  if (!saved) return false;

  const acc = await readAccount();
  if (!acc || acc.username !== saved.username) {
    await sessionClear();
    xgmclLog.writeLog("WARN", "session 与注册表账号不匹配，已清除");
    return false;
  }

  SESSION.logged_in = true;
  SESSION.username = saved.username;
  SESSION.role = saved.role;
  SESSION.login_time = saved.login_time;
  xgmclLog.writeLog("INFO", `已恢复 XGstudio 登录态: ${saved.username}`);
  return true;
}

function getSession() {
  return { ...SESSION };
}

module.exports = {
  status,
  login,
  logout,
  restoreSession,
  getSession,
};