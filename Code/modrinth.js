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

// modrinth.js —— Modrinth API 客户端

const fs = require("fs");
const path = require("path");
const http = require("http");
const { shell } = require("electron");
const cfgMod = require("./config.js");
const P = require("./paths.js");
const xgmclLog = require("./xgmcl_log.js");

const API = "https://api.modrinth.com/v2";
const UA = "XGstudio-XGMCL/2.0 (contact: xgstudio)";

// OAuth 配置（从原core.py抄来）
const CLIENT_ID = "CLIENT_ID";
const CLIENT_SECRET = "CLIENT_SECRET";
const REDIRECT_URI = "http://127.0.0.1:8000/api/modrinth/oauth/callback";

const OAUTH_AUTHORIZE = "https://modrinth.com/auth/authorize";
const OAUTH_TOKEN = "https://api.modrinth.com/_internal/oauth/token";

const SCOPES = [
  "USER_READ",
  "PROJECT_READ", "PROJECT_CREATE", "PROJECT_WRITE",
  "VERSION_READ", "VERSION_CREATE",
  "COLLECTION_READ", "COLLECTION_CREATE", "COLLECTION_WRITE",
];

// 内存里的 OAuth 状态
const oauthState = {
  active: false,
  state: "",
  access_token: "",
  refresh_token: "",
  expires_at: 0,
  user: null,
};

// OAuth 回调用的本地 HTTP server
let callbackServer = null;

function headers(extra = {}) {
  return { "User-Agent": UA, Accept: "application/json", ...extra };
}

// ---- wiki 中文名 ----

let _wikiCache = null;

function loadWikiEntries() {
  if (_wikiCache !== null) return _wikiCache;
  const wikiPath = path.join(P.BASE, "wiki_entries.json");
  if (!fs.existsSync(wikiPath)) {
    _wikiCache = {};
    return _wikiCache;
  }
  try {
    const data = JSON.parse(fs.readFileSync(wikiPath, "utf-8"));
    _wikiCache = (data && typeof data === "object") ? data : {};
    xgmclLog.writeLog("INFO", `加载 wiki_entries.json: ${Object.keys(_wikiCache).length} 条`);
  } catch (e) {
    xgmclLog.writeLog("ERROR", `加载 wiki_entries.json 失败: ${e.message}`);
    _wikiCache = {};
  }
  return _wikiCache;
}

// ---- 搜索 ----

async function search(query, limit = 20, offset = 0, gameVersion = "", loader = "", index = "relevance", projectType = "mod") {
  const validIndex = ["relevance", "downloads", "follows", "newest", "updated"];
  if (!validIndex.includes(index)) index = "relevance";

  const validTypes = ["mod", "resourcepack", "shader", "modpack", "datapack", "plugin"];
  if (!validTypes.includes(projectType)) projectType = "mod";

  const facets = [[`project_type:${projectType}`]];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (loader) facets.push([`categories:${loader}`]);

  const params = new URLSearchParams({
    query: query || "",
    limit: String(limit),
    offset: String(offset),
    index,
    facets: JSON.stringify(facets),
  });

  const res = await fetch(`${API}/search?${params}`, { headers: headers() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// ---- 项目 / 版本 ----

async function getProject(projectId) {
  const res = await fetch(`${API}/project/${projectId}`, { headers: headers() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function getProjectVersions(projectId, gameVersion = "", loader = "") {
  const params = new URLSearchParams();
  if (gameVersion) params.set("game_versions", JSON.stringify([gameVersion]));
  if (loader) params.set("loaders", JSON.stringify([loader]));

  const qs = params.toString();
  const url = `${API}/project/${projectId}/version${qs ? "?" + qs : ""}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// 挑主文件
function pickPrimaryFile(files) {
  if (!files || !files.length) return null;
  for (const f of files) {
    if (f.primary) return f;
  }
  return files[0];
}

// ---- 批量 hash 反查 ----

async function versionsFromHashes(hashes) {
  if (!hashes || !hashes.length) return {};
  const result = {};

  // 分批，每批 32 个
  const BATCH = 32;
  for (let i = 0; i < hashes.length; i += BATCH) {
    const batch = hashes.slice(i, i + BATCH);
    try {
      const res = await fetch(`${API}/version_files`, {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ hashes: batch, algorithm: "sha512" }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && typeof data === "object") {
        Object.assign(result, data);
      }
    } catch (e) {
      xgmclLog.writeLog("WARN", `哈希反查失败（批 ${Math.floor(i / BATCH)}）: ${e.message}`);
    }
  }
  return result;
}

// ---- 依赖树 ----

async function dependencyTree(projectIds, maxDepth = 3) {
  if (!Array.isArray(projectIds) || !projectIds.length) {
    return { nodes: {}, edges: {}, missing: [] };
  }
  if (maxDepth < 1) maxDepth = 1;
  if (maxDepth > 3) maxDepth = 3;

  const unique = [...new Set(projectIds.filter(Boolean))];
  const wiki = loadWikiEntries();
  const nodes = {};
  const edges = {};
  const missing = new Set();

  let currentLayer = new Set(unique);
  const seen = new Set();

  for (let depth = 0; depth < maxDepth; depth++) {
    const toQuery = [...currentLayer].filter((pid) => !seen.has(pid));
    for (const pid of toQuery) seen.add(pid);
    if (!toQuery.length) break;

    // 批量查项目信息
    for (let i = 0; i < toQuery.length; i += 50) {
      const batch = toQuery.slice(i, i + 50);
      try {
        const params = new URLSearchParams({ ids: JSON.stringify(batch) });
        const res = await fetch(`${API}/projects?${params}`, { headers: headers() });
        if (res.ok) {
          const list = await res.json();
          for (const p of list) {
            const pid = p.id || "";
            if (!pid) continue;
            const slug = (p.slug || "").toLowerCase();
            nodes[pid] = {
              project_id: pid,
              slug: p.slug || "",
              title: p.title || "",
              title_cn: wiki[slug] || "",
              icon_url: p.icon_url || "",
              description: p.description || "",
              project_type: p.project_type || "",
            };
          }
        } else {
          for (const pid of batch) missing.add(pid);
        }
      } catch (e) {
        xgmclLog.writeLog("WARN", `查项目失败（批 ${i}）: ${e.message}`);
        for (const pid of batch) missing.add(pid);
      }
    }

    // 并发查每个项目的依赖
    const nextLayer = new Set();
    const queryPids = toQuery.filter((p) => p in nodes);

    await Promise.all(queryPids.map(async (pid) => {
      try {
        const res = await fetch(`${API}/project/${pid}/version`, { headers: headers() });
        if (!res.ok) {
          edges[pid] = [];
          return;
        }
        const versions = await res.json();
        if (!versions.length) {
          edges[pid] = [];
          return;
        }
        const latest = versions[0];
        const deps = [];
        for (const d of latest.dependencies || []) {
          if (!d.project_id) continue;
          deps.push({
            project_id: d.project_id,
            dependency_type: d.dependency_type || "required",
          });
          if (d.dependency_type === "required" || d.dependency_type === "embedded") {
            nextLayer.add(d.project_id);
          }
        }
        edges[pid] = deps;
      } catch (e) {
        xgmclLog.writeLog("WARN", `查依赖失败 ${pid}: ${e.message}`);
        edges[pid] = [];
      }
    }));

    currentLayer = nextLayer;
    if (!currentLayer.size) break;
  }

  return {
    nodes,
    edges,
    missing: [...missing],
  };
}

// ---- OAuth ----

function oauthSave() {
  cfgMod.safeSaveJson(P.MODRINTH_OAUTH, {
    access_token: oauthState.access_token,
    refresh_token: oauthState.refresh_token,
    expires_at: oauthState.expires_at,
    user: oauthState.user,
  });
}

function oauthLoad() {
  const data = cfgMod.safeLoadJson(P.MODRINTH_OAUTH);
  if (!data || !data.access_token) return false;
  oauthState.access_token = data.access_token || "";
  oauthState.refresh_token = data.refresh_token || "";
  oauthState.expires_at = data.expires_at || 0;
  oauthState.user = data.user || null;
  return true;
}

function oauthClear() {
  oauthState.active = false;
  oauthState.state = "";
  oauthState.access_token = "";
  oauthState.refresh_token = "";
  oauthState.expires_at = 0;
  oauthState.user = null;

  try {
    if (fs.existsSync(P.MODRINTH_OAUTH)) {
      fs.unlinkSync(P.MODRINTH_OAUTH);
    }
  } catch (_) {}
}

// 启动本地回调 server（OAuth 用）
function startCallbackServer() {
  if (callbackServer) return;

  callbackServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1:8000");
    if (url.pathname !== "/api/modrinth/oauth/callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const error = url.searchParams.get("error") || "";

    const html = (ok, msg) => {
      const color = ok ? "#4ade80" : "#ff4757";
      const icon = ok ? "✓" : "✗";
      return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Modrinth 授权</title>
<style>
body { background:#1f1f1f; color:#ddd; font-family:"Microsoft YaHei",sans-serif;
       display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
.box { text-align:center; }
.icon { font-size:64px; color:${color}; }
.msg { font-size:18px; margin-top:16px; }
</style></head>
<body><div class="box">
<div class="icon">${icon}</div>
<div class="msg">${msg}</div>
</div></body></html>`;
    };

    if (error) {
      oauthState.active = false;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html(false, `授权失败：${error}`));
      return;
    }

    if (!code) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html(false, "缺少 code 参数"));
      return;
    }

    if (!oauthState.active || state !== oauthState.state) {
      xgmclLog.writeLog("WARN", "Modrinth OAuth state 不匹配");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html(false, "state 校验失败，请重新登录"));
      return;
    }

    try {
      const body = new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      });

      const tokenRes = await fetch(OAUTH_TOKEN, {
        method: "POST",
        headers: {
          Authorization: CLIENT_SECRET,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      });

      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        xgmclLog.writeLog("WARN", `Modrinth token 交换失败: HTTP ${tokenRes.status} - ${text.slice(0, 300)}`);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html(false, `Token 交换失败：HTTP ${tokenRes.status}`));
        return;
      }

      const d = await tokenRes.json();
      oauthState.access_token = d.access_token || "";
      oauthState.refresh_token = d.refresh_token || "";
      const expiresIn = parseInt(d.expires_in || "0", 10);
      oauthState.expires_at = expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : 0;

      // 拉用户信息
      try {
        const userRes = await fetch(`${API}/user`, {
          headers: {
            Authorization: oauthState.access_token,
            "User-Agent": UA,
            Accept: "application/json",
          },
        });
        if (userRes.ok) {
          const ud = await userRes.json();
          oauthState.user = {
            id: ud.id || "",
            username: ud.username || "",
            avatar_url: ud.avatar_url || "",
            name: ud.name || "",
            email: ud.email || "",
          };
        }
      } catch (e) {
        xgmclLog.writeLog("WARN", `拉 Modrinth 用户信息失败: ${e.message}`);
      }

      oauthState.active = false;
      oauthState.state = "";
      oauthSave();
      xgmclLog.writeLog("INFO", `Modrinth 登录成功: ${oauthState.user?.username || "?"}`);

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html(true, "登录成功，可以关闭此页面"));
    } catch (e) {
      xgmclLog.writeLog("ERROR", `Modrinth OAuth 回调异常: ${e.message}`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html(false, `异常：${e.message}`));
    }
  });

  callbackServer.on("error", (e) => {
    xgmclLog.writeLog("WARN", `Modrinth OAuth 回调 server 错误: ${e.message}`);
    callbackServer = null;
  });

  callbackServer.listen(8000, "127.0.0.1", () => {
    xgmclLog.writeLog("INFO", "Modrinth OAuth 回调 server 已监听 127.0.0.1:8000");
  });
}

function stopCallbackServer() {
  if (callbackServer) {
    try { callbackServer.close(); } catch (_) {}
    callbackServer = null;
  }
}

async function oauthLogin() {
  const state = require("crypto").randomBytes(24).toString("base64url");
  oauthState.active = true;
  oauthState.state = state;

  startCallbackServer();
  // 等 server 起来
  await new Promise((r) => setTimeout(r, 200));

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join("+"),
    state,
  });
  // scope 里的 + 不能被编码
  let qs = params.toString().replace(/%2B/g, "+");
  const url = `${OAUTH_AUTHORIZE}?${qs}`;

  try {
    await shell.openExternal(url);
  } catch (e) {
    xgmclLog.writeLog("ERROR", `打开浏览器失败: ${e.message}`);
    return { code: 500, msg: `打开浏览器失败: ${e.message}` };
  }

  xgmclLog.writeLog("INFO", "Modrinth OAuth 授权已启动");
  return { code: 200, msg: "已打开浏览器，请完成授权", url };
}

function oauthStatus() {
  const logged = Boolean(oauthState.access_token);
  return { code: 200, logged_in: logged, user: oauthState.user };
}

function oauthLogout() {
  oauthClear();
  stopCallbackServer();
  xgmclLog.writeLog("INFO", "Modrinth 已登出");
  return { code: 200, msg: "已登出" };
}

// ---- 用户相关（需要 OAuth token） ----

async function apiGetWithAuth(path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Authorization: token || "",
    },
  });
  if (!res.ok) {
    let text = "";
    try { text = await res.text(); } catch (_) {}
    throw new Error(`HTTP ${res.status} - ${text.slice(0, 200)}`);
  }
  return await res.json();
}

// 我发布的项目
async function getUserProjects(userId) {
  if (!userId) throw new Error("userId 为空");
  return await apiGetWithAuth(`/user/${userId}/projects`, oauthState.access_token);
}

// 我关注的
async function getUserFollows(userId) {
  if (!userId) throw new Error("userId 为空");
  return await apiGetWithAuth(`/user/${userId}/follows`, oauthState.access_token);
}

// 我的收藏夹
// Modrinth 没有 GET /user/{id}/collections 这个公开接口。
// 官方 API 只有：
//   GET /collection?ids=[...]     按 id 查
//   GET /user/{id}/collections    文档里有，但实测返回 404
// 所以这里改用 OAuth 拿到的 username，去搜索 /user 的公开信息，
// 拿 collections 列表。（如果以后 Modrinth 修了再改回来）
async function getUserCollections(userId) {
  if (!userId) throw new Error("userId 为空");
  // 用 userId 当 fallback，先试文档里的路径
  try {
    return await apiGetWithAuth(`/user/${userId}/collections`, oauthState.access_token);
  } catch (e) {
    // 404 时返回空数组，让前端显示"还没有收藏夹"
    if (String(e.message).includes("404")) {
      xgmclLog.writeLog("WARN", "Modrinth /user/{id}/collections 返回 404，暂用空数组");
      return [];
    }
    throw e;
  }
}

// ---- Fabric API 查找 ----

async function findFabricApiVersion(mcVersion) {
  try {
    const versions = await getProjectVersions("fabric-api", mcVersion, "fabric");
    if (!versions.length) return null;
    for (const v of versions) {
      const files = v.files || [];
      if (!files.length) continue;
      const primary = files.find((f) => f.primary) || files[0];
      return {
        url: primary.url || "",
        filename: primary.filename || "",
        version: v.version_number || "",
        size: primary.size || 0,
        sha1: (primary.hashes || {}).sha1 || "",
      };
    }
    return null;
  } catch (e) {
    xgmclLog.writeLog("ERROR", `查 Fabric API 版本失败: ${e.message}`);
    return null;
  }
}

module.exports = {
  API,
  headers,
  loadWikiEntries,
  search,
  getProject,
  getProjectVersions,
  pickPrimaryFile,
  versionsFromHashes,
  dependencyTree,
  oauthSave,
  oauthLoad,
  oauthClear,
  oauthLogin,
  oauthStatus,
  oauthLogout,
  startCallbackServer,
  stopCallbackServer,
  findFabricApiVersion,
  getUserProjects,
  getUserFollows,
  getUserCollections,
};