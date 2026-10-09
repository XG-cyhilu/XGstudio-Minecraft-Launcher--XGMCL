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

// littleskin.js —— LittleSkin 设备代码流登录

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cfgMod = require("./config.js");
const P = require("./paths.js");
const xgmclLog = require("./xgmcl_log.js");

const CLIENT_ID = "CLIENT_ID";
const OAUTH_BASE = "https://open.littleskin.cn";
const YGGDRASIL_BASE = "https://littleskin.cn/api/yggdrasil";

// 全局登录状态（一次只允许一个登录流程）
const LOGIN_STATE = {
  active: false,
  device_code: "",
  user_code: "",
  verification_uri: "",
  interval: 5,
  expires_at: 0,
  access_token: "",
  refresh_token: "",
  token_expires_at: 0,
  id_token: "",
  selected_profile: null,
  error: null,
  done: false,
};

// 从 id_token 里解出角色信息
function parseSelectedProfile(idToken) {
  if (!idToken) return null;
  try {
    const parts = idToken.split(".");
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));

    // Select 模式
    const sp = payload.selectedProfile;
    if (sp && sp.name) {
      return {
        name: sp.name,
        id: sp.id || "",
        all: [{ name: sp.name, id: sp.id || "" }],
      };
    }

    // Read 模式
    const profiles = payload.availableProfiles || [];
    const all = profiles
      .filter((p) => p.name)
      .map((p) => ({ name: p.name, id: p.id || "" }));

    if (all.length) {
      return { name: all[0].name, id: all[0].id, all };
    }
    return null;
  } catch (e) {
    xgmclLog.writeLog("ERROR", `解析 LittleSkin id_token 失败: ${e.message}`);
    return null;
  }
}

// 启动登录：请求设备代码对
async function startLogin() {
  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      scope: "openid Yggdrasil.PlayerProfiles.Read Yggdrasil.MinecraftToken.Create offline_access",
    });
    const res = await fetch(`${OAUTH_BASE}/oauth/device_code`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      let errText = "";
      try { errText = await res.text(); } catch (_) {}
      xgmclLog.writeLog("ERROR", `LittleSkin device_code 失败: HTTP ${res.status} - ${errText.slice(0, 500)}`);
      throw new Error(`HTTP ${res.status}`);
    }
    const d = await res.json();

    Object.assign(LOGIN_STATE, {
      active: true,
      device_code: d.device_code || "",
      user_code: d.user_code || "",
      verification_uri: d.verification_uri || `${OAUTH_BASE}/oauth/device`,
      interval: parseInt(d.interval || "5", 10),
      expires_at: Date.now() / 1000 + parseInt(d.expires_in || "600", 10),
      access_token: "",
      error: null,
      done: false,
    });

    xgmclLog.writeLog("INFO", `LittleSkin 设备代码流已启动，user_code=${d.user_code}`);
    return {
      code: 200,
      user_code: d.user_code,
      verification_uri: d.verification_uri || `${OAUTH_BASE}/oauth/device`,
      verification_uri_complete: d.verification_uri_complete || "",
      interval: parseInt(d.interval || "5", 10),
      expires_in: parseInt(d.expires_in || "600", 10),
    };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `LittleSkin 请求设备代码失败: ${e.message}`);
    return { code: 500, msg: `请求失败: ${e.message}` };
  }
}

// 轮询授权状态
async function poll() {
  if (!LOGIN_STATE.active) return { code: 400, msg: "没有正在进行的登录" };
  if (LOGIN_STATE.done) {
    return { code: 200, done: true, user_code: LOGIN_STATE.user_code };
  }
  if (LOGIN_STATE.error) {
    return { code: 400, error: LOGIN_STATE.error };
  }
  if (Date.now() / 1000 > LOGIN_STATE.expires_at) {
    LOGIN_STATE.active = false;
    return { code: 400, error: "授权超时，请重新发起登录" };
  }

  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      device_code: LOGIN_STATE.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const res = await fetch(`${OAUTH_BASE}/oauth/token`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (res.ok) {
      const d = await res.json();
      xgmclLog.writeLog("INFO", `LittleSkin /oauth/token 响应字段: ${Object.keys(d).join(",")}`);

      const idToken = d.id_token || "";
      const profile = parseSelectedProfile(idToken);
      const expiresIn = parseInt(d.expires_in || "0", 10);

      // ★ 调试：确认 refresh_token 有没有返回
      xgmclLog.writeLog("INFO",
        `LittleSkin token 响应: access=${!!d.access_token}, ` +
        `refresh=${!!d.refresh_token}, expires_in=${expiresIn}`
      );

      LOGIN_STATE.access_token = d.access_token || "";
      LOGIN_STATE.refresh_token = d.refresh_token || "";
      LOGIN_STATE.token_expires_at = expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : 0;
      LOGIN_STATE.id_token = idToken;
      LOGIN_STATE.selected_profile = profile;
      LOGIN_STATE.done = true;
      LOGIN_STATE.active = false;

      if (profile) {
        xgmclLog.writeLog("INFO", `LittleSkin 授权成功，角色数=${profile.all.length}`);
      } else {
        xgmclLog.writeLog("WARN", "LittleSkin 授权成功，但没解析出角色");
      }

      return {
        code: 200,
        done: true,
        user_code: LOGIN_STATE.user_code,
        profiles: (profile || {}).all || [],
      };
    }

    let err = "";
    try { err = (await res.json()).error || ""; } catch (_) {}

    if (err === "authorization_pending") {
      return { code: 200, done: false };
    }

    LOGIN_STATE.error = `授权失败: ${err}`;
    LOGIN_STATE.active = false;
    xgmclLog.writeLog("ERROR", `LittleSkin 轮询失败: ${err}`);
    return { code: 400, error: `授权失败: ${err}` };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `LittleSkin 轮询异常: ${e.message}`);
    return { code: 500, msg: e.message };
  }
}

// 完成登录：写账户
function complete(profileName, profileId) {
  const oauthToken = LOGIN_STATE.access_token;
  const oauthRefresh = LOGIN_STATE.refresh_token;
  const oauthExpiresAt = LOGIN_STATE.token_expires_at;
  const profile = LOGIN_STATE.selected_profile;

  if (!oauthToken) {
    return { code: 400, msg: "尚未授权，请先调用 poll" };
  }

  if (!profile || !profile.all || !profile.all.length) {
    Object.assign(LOGIN_STATE, {
      active: false, done: false,
      access_token: "", id_token: "", selected_profile: null,
    });
    return { code: 400, msg: "未拿到角色信息，请重新登录" };
  }

  let chosen = null;
  if (profileName) {
    chosen = profile.all.find((p) => p.name === profileName);
  }
  if (!chosen) chosen = profile.all[0];

  const username = chosen.name;
  const mcUuid = chosen.id;

  try {
    const accounts = cfgMod.safeLoadJson(P.ACCOUNT_PATH);

    // 同 username 的 LittleSkin 账户：更新
    for (const aid in accounts) {
      if (accounts[aid].username === username && accounts[aid].type === "littleskin") {
        accounts[aid].mc_uuid = mcUuid;
        accounts[aid].access_token = oauthToken;
        accounts[aid].refresh_token = oauthRefresh;
        accounts[aid].expires_at = oauthExpiresAt;
        cfgMod.safeSaveJson(P.ACCOUNT_PATH, accounts);
        Object.assign(LOGIN_STATE, {
          active: false, done: false,
          access_token: "", id_token: "", selected_profile: null,
        });
        xgmclLog.writeLog("INFO", `LittleSkin 账户已更新: ${username} (${mcUuid})`);
        return { code: 200, msg: `账户已更新: ${username}`, username, mc_uuid: mcUuid };
      }
    }

    const accUuid = crypto.randomUUID();
    accounts[accUuid] = {
      username,
      uuid: accUuid,
      type: "littleskin",
      mc_uuid: mcUuid,
      access_token: oauthToken,
      refresh_token: oauthRefresh,
      expires_at: oauthExpiresAt,
      selected: false,
    };
    cfgMod.safeSaveJson(P.ACCOUNT_PATH, accounts);

    Object.assign(LOGIN_STATE, {
      active: false, done: false,
      access_token: "", refresh_token: "",
      token_expires_at: 0,
      id_token: "", selected_profile: null,
    });

    xgmclLog.writeLog("INFO", `LittleSkin 登录成功: ${username} (${mcUuid})`);
    return { code: 200, msg: `登录成功: ${username}`, username, mc_uuid: mcUuid };
  } catch (e) {
    xgmclLog.writeLog("ERROR", `LittleSkin 保存账户失败: ${e.message}`);
    return { code: 500, msg: `保存账户失败: ${e.message}` };
  }
}

module.exports = {
  startLogin,
  poll,
  complete,
};