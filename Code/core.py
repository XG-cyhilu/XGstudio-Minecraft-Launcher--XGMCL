"""
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
"""



from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
import uvicorn
import os
import json
import uuid
import time
import subprocess
import threading
import base64
import tkinter
import tkinter.filedialog
from fabric import fetch_fabric_loaders
import requests

import sys as _sys_init
try:
    _sys_init.stdout.reconfigure(encoding="utf-8")
    _sys_init.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

try:
    import bcrypt
    HAS_BCRYPT = True
except ImportError:
    HAS_BCRYPT = False
    print("bcrypt 未安装，XGstudio 登录将不可用")

from launcher import launch_game
from java_scan import scan_java_installations
from upversion import upversion_task_worker
from server import (
    select_server_dir, scan_jars, detect_server,
    read_properties, save_properties,
    read_whitelist, save_whitelist,
    read_ops, save_ops,
    start_server, stop_server, is_running,
    tail_console, read_console_from_start,
    send_command,
)
from mojang import (
    fetch_manifest, start_download, get_progress, cancel_download,
    create_task, get_task, list_tasks, remove_task,
    TASKS, TASKS_LOCK, TASK_LOCKS,
    speed_updater, download_one_file, rewrite_url, format_size,
    collect_files, collect_asset_objects, fetch_version_json,
)
from xgmcl_log import (
    init_log, write_log, write_download_log, list_log_files, read_log_file,
    get_log_dir, install_excepthook,
)
try:
    import winreg
    HAS_WINREG = True
except ImportError:
    HAS_WINREG = False
from fabric import fetch_fabric_loaders
import requests
import zipfile

# ====================== 路径常量 ======================
import sys as _sys

if getattr(_sys, 'frozen', False):
    # PyInstaller 打包后：用 exe 所在目录
    BASE = os.path.dirname(_sys.executable)
else:
    # 源码运行：用 .py 所在目录
    BASE = os.path.dirname(os.path.abspath(__file__))
XGMCL_ROOT = os.path.join(BASE, "XGMCL")
SETTING_ROOT = os.path.join(XGMCL_ROOT, "setting")
VERSION_SETTING_ROOT = os.path.join(SETTING_ROOT, "version")
LOG_ROOT = os.path.join(XGMCL_ROOT, "xgmcllog")

PATH_ROOTS_DB      = os.path.join(SETTING_ROOT, "mxgversionsc.json")
PATH_GLOBAL_CONFIG = os.path.join(SETTING_ROOT, "config.json")
PATH_JVM_CONFIG    = os.path.join(SETTING_ROOT, "xgm1.json")
PATH_VERSION_CFG   = os.path.join(VERSION_SETTING_ROOT, "versioncsetting.json")
PATH_LAST_LAUNCH   = os.path.join(SETTING_ROOT, "lastlaunch.json")
PATH_HOME_CONFIG   = os.path.join(SETTING_ROOT, "home.json")
PATH_TRUSTED       = os.path.join(SETTING_ROOT, "trusted_html.json")
PATH_JAVA_CACHE    = os.path.join(SETTING_ROOT, "java_list.json")
PATH_APPEARANCE    = os.path.join(SETTING_ROOT, "appearance.json")
DOWNLOAD_DATA_DIR  = os.path.join(XGMCL_ROOT, "data", "download_data")
PATH_DOWNLOAD_CFG  = os.path.join(SETTING_ROOT, "download.json")
PATH_DOWNLOAD_HIST = os.path.join(DOWNLOAD_DATA_DIR, "download.json")
PATH_SERVER_CFG    = os.path.join(SETTING_ROOT, "server.json")
ACCOUNT_PATH       = os.path.join(XGMCL_ROOT, "data", "xgmclp", "p.json")
COLOR_PATH         = os.path.join(XGMCL_ROOT, "data", "color.json")

# ====================== XGstudio 账号（注册表） ======================
XG_REG_ROOT = None
XG_REG_BASE = r"Software\XGstudio"
XG_REG_YON = r"Software\XGstudio\YON_ON"
XG_BCRYPT_ROUNDS = 12

XG_REG_SESSION = r"Software\XGstudio\session"

XG_SESSION = {
    "logged_in": False,
    "username": "",
    "role": "",
    "login_time": 0,
}
XG_SESSION_LOCK = threading.Lock()


def xg_session_save(username: str, role: str, login_time: int):
    if not HAS_WINREG:
        return
    import winreg as _wr
    try:
        key = _wr.CreateKey(_wr.HKEY_CURRENT_USER, XG_REG_SESSION)
        val = f"{login_time}:{username}:{role or ''}"
        _wr.SetValueEx(key, "", 0, _wr.REG_SZ, val)
        _wr.CloseKey(key)
    except Exception as e:
        write_log("WARN", f"保存 XGstudio session 失败: {e}")


def xg_session_load():
    if not HAS_WINREG:
        return None
    import winreg as _wr
    try:
        key = _wr.OpenKey(_wr.HKEY_CURRENT_USER, XG_REG_SESSION)
        val, _ = _wr.QueryValueEx(key, "")
        _wr.CloseKey(key)
        parts = str(val).split(":", 2)
        if len(parts) != 3:
            return None
        ts = int(parts[0])
        username = parts[1]
        role = parts[2]
        if not username or ts <= 0:
            return None
        return (username, role, ts)
    except Exception:
        return None


def xg_session_clear():
    if not HAS_WINREG:
        return
    import winreg as _wr
    try:
        key = _wr.OpenKey(_wr.HKEY_CURRENT_USER, XG_REG_SESSION,
                         0, _wr.KEY_SET_VALUE)
        _wr.DeleteValue(key, "")
        _wr.CloseKey(key)
    except Exception:
        pass


def xg_read_account():
    if not HAS_WINREG:
        return None
    import winreg as _wr
    try:
        key = _wr.OpenKey(_wr.HKEY_CURRENT_USER, XG_REG_BASE)
    except OSError:
        return None

    try:
        username, _ = _wr.QueryValueEx(key, "用户名")
        bcrypt_hash, _ = _wr.QueryValueEx(key, "bcrypt_hash")
        try:
            raw_mac, _ = _wr.QueryValueEx(key, "raw_mac")
        except OSError:
            raw_mac = ""
        try:
            role, _ = _wr.QueryValueEx(key, "XGstu职位")
        except OSError:
            role = None
        _wr.CloseKey(key)
        return {
            "username": str(username).strip(),
            "hash": str(bcrypt_hash).encode("utf-8"),
            "role": role,
            "raw_mac": raw_mac,
        }
    except Exception:
        try:
            _wr.CloseKey(key)
        except Exception:
            pass
        return None


def xg_yon_on():
    if not HAS_WINREG:
        return False
    import winreg as _wr
    try:
        key = _wr.OpenKey(_wr.HKEY_CURRENT_USER, XG_REG_YON)
        val, _ = _wr.QueryValueEx(key, "")
        _wr.CloseKey(key)
        return str(val).strip().lower() == "yes"
    except OSError:
        return False


# ====================== FastAPI App ======================
app = FastAPI(title="XGMCL Core Service")


# ====================== 日志中间件（拦截所有请求） ======================
class LogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        start = time.time()
        try:
            response = await call_next(request)
            elapsed = (time.time() - start) * 1000
            write_log("INFO", f"{request.method} {request.url.path} → {response.status_code} ({elapsed:.0f}ms)")
            return response
        except Exception as e:
            elapsed = (time.time() - start) * 1000
            write_log("ERROR", f"{request.method} {request.url.path} → 异常: {e} ({elapsed:.0f}ms)")
            raise


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(LogMiddleware)


# ====================== 工具 ======================
def safe_load_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def safe_save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def check_root_valid(root_path):
    if not os.path.isdir(root_path):
        return False
    return (
        os.path.exists(os.path.join(root_path, "versions"))
        and os.path.exists(os.path.join(root_path, "libraries"))
    )


def select_folder_dialog():
    try:
        root = tkinter.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        path = tkinter.filedialog.askdirectory(title="选择 Minecraft 游戏根目录")
        root.destroy()
        return path
    except Exception:
        return ""


def select_file_dialog(title, filetypes):
    try:
        root = tkinter.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        path = tkinter.filedialog.askopenfilename(title=title, filetypes=filetypes)
        root.destroy()
        return path
    except Exception:
        return ""


def parse_version_info(ver_name, ver_dir):
    import re
    json_path = os.path.join(ver_dir, f"{ver_name}.json")
    game_ver = "未知"
    loader = "Vanilla"

    if os.path.exists(json_path):
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            client_ver = data.get("clientVersion", "")
            if client_ver:
                game_ver = client_ver
            else:
                m = re.search(r"\d+\.\d+(?:\.\d+)?", ver_name)
                game_ver = m.group() if m else "未知"

            main_class = (data.get("mainClass") or "").lower()
            if "fabric" in main_class or "fabricmc" in main_class:
                loader = "Fabric"
            elif "neoforge" in main_class:
                loader = "NeoForge"
            elif "forge" in main_class and "neoforge" not in main_class:
                loader = "Forge"
            else:
                lib_names = " ".join(
                    l.get("name", "").lower()
                    for l in data.get("libraries", [])
                )
                if "fabric-loader" in lib_names:
                    loader = "Fabric"
                elif "neoforge" in lib_names:
                    loader = "NeoForge"
                elif "forge" in lib_names and "minecraftforge" in lib_names:
                    loader = "Forge"
                elif "optifine" in lib_names:
                    loader = "OptiFine"
                else:
                    loader = "Vanilla"
        except Exception as e:
            print(f"[WARN]解析 {json_path} 失败: {e}")
            m = re.search(r"\d+\.\d+(?:\.\d+)?", ver_name)
            game_ver = m.group() if m else "未知"
    else:
        m = re.search(r"\d+\.\d+(?:\.\d+)?", ver_name)
        game_ver = m.group() if m else "未知"
        lower = ver_name.lower()
        if "fabric" in lower:
            loader = "Fabric"
        elif "neoforge" in lower:
            loader = "NeoForge"
        elif "forge" in lower:
            loader = "Forge"

    show_name = ver_name if len(ver_name) <= 20 else ver_name[:20] + "……"
    return {
        "full_name": ver_name,
        "show_name": show_name,
        "game_version": game_ver,
        "loader_type": loader,
    }


def scan_versions_of_root(root_path):
    ver_list = []
    ver_dir = os.path.join(root_path, "versions")
    if not os.path.exists(ver_dir):
        return ver_list
    for v in os.listdir(ver_dir):
        v_full = os.path.join(ver_dir, v)
        if os.path.isdir(v_full):
            ver_list.append(parse_version_info(v, v_full))
    return ver_list


def get_root_by_id(root_id=""):
    db = safe_load_json(PATH_ROOTS_DB)
    roots = db.get("roots", [])
    if root_id:
        for r in roots:
            if r.get("id") == root_id:
                return r
        return None
    active_id = db.get("active_id", "")
    for r in roots:
        if r.get("id") == active_id:
            return r
    return None


# ====================== 版本专属配置 ======================
def version_cfg_key(root_path, version_name):
    return f"{root_path}|{version_name}"


def get_version_isolated(root_path, version_name):
    """
    读某版本是否开启隔离。三级优先级：
    1. 版本配置里有 isolated 字段 → 用它
    2. 没有 → 全局 default_isolated
    3. 都没有 → False
    """
    key = version_cfg_key(root_path, version_name)
    all_cfg = safe_load_json(PATH_VERSION_CFG)
    cfg = all_cfg.get(key, {})
    if "isolated" in cfg:
        return bool(cfg["isolated"])
    g = safe_load_json(PATH_GLOBAL_CONFIG)
    return bool(g.get("default_isolated", False))


def get_version_game_dir(root_path, version_name, isolated=None):
    """
    返回该版本的游戏工作目录（gameDir）。
    跟 PCL 兼容：
    isolated=True  → <根>/versions/<版本>   （PCL 结构，没有 .minecraft 层）
    isolated=False → <根>
    isolated=None  → 自动读配置
    """
    if isolated is None:
        isolated = get_version_isolated(root_path, version_name)
    if isolated:
        ver_dir = os.path.join(root_path, "versions", version_name)
        # ★ 老实例迁移：如果还有 .minecraft/，把内容挪上来
        _migrate_old_isolated_dir(ver_dir)
        return ver_dir
    return root_path


def _migrate_old_isolated_dir(ver_dir):
    """
    把 <版本>/.minecraft/ 里的内容挪到 <版本>/，然后删掉空的 .minecraft/。
    只在 .minecraft/ 存在时执行一次。
    """
    old_dir = os.path.join(ver_dir, ".minecraft")
    if not os.path.isdir(old_dir):
        return

    write_log("INFO", f"检测到老隔离结构，开始迁移: {old_dir}")

    import shutil
    moved = 0
    skipped = 0
    try:
        for name in os.listdir(old_dir):
            src = os.path.join(old_dir, name)
            dst = os.path.join(ver_dir, name)

            # 目标已存在 → 跳过（不动用户数据）
            if os.path.exists(dst):
                skipped += 1
                write_log("WARN", f"迁移跳过（目标已存在）: {name}")
                continue

            try:
                shutil.move(src, dst)
                moved += 1
            except Exception as e:
                skipped += 1
                write_log("WARN", f"迁移失败 {name}: {e}")

        # 挪完检查 .minecraft/ 空了没
        remaining = os.listdir(old_dir)
        if not remaining:
            try:
                os.rmdir(old_dir)
                write_log("INFO", f"老隔离结构迁移完成：挪了 {moved} 项，跳过 {skipped} 项，已删除空 .minecraft/")
            except Exception as e:
                write_log("WARN", f"删 .minecraft/ 失败: {e}")
        else:
            write_log("INFO", f"迁移完成：挪了 {moved} 项，跳过 {skipped} 项，.minecraft/ 还有 {len(remaining)} 项未处理")
    except Exception as e:
        write_log("ERROR", f"迁移老隔离结构失败: {e}")


def get_global_defaults():
    g = safe_load_json(PATH_GLOBAL_CONFIG)
    j = safe_load_json(PATH_JVM_CONFIG)
    return {
        "ram": g.get("global_ram", 2048),
        "java_path": g.get("global_java_path", ""),
        "priority": g.get("process_priority", "正常"),
        "jvm_args": j.get("jvm_args", "-XX:+UseG1GC -XX:MaxGCPauseMillis=200"),
        "width": 1280,
        "height": 720,
        "isolated": bool(g.get("default_isolated", False)),
    }


def load_version_config(root_path, version_name):
    defaults = get_global_defaults()
    key = version_cfg_key(root_path, version_name)
    all_cfg = safe_load_json(PATH_VERSION_CFG)
    if key in all_cfg:
        merged = {**defaults, **all_cfg[key]}
        merged["_inherited"] = False
        return merged
    else:
        defaults["_inherited"] = True
        return defaults


def save_version_config(root_path, version_name, cfg):
    key = version_cfg_key(root_path, version_name)
    all_cfg = safe_load_json(PATH_VERSION_CFG)
    all_cfg[key] = cfg
    safe_save_json(PATH_VERSION_CFG, all_cfg)


def reset_version_config(root_path, version_name):
    key = version_cfg_key(root_path, version_name)
    all_cfg = safe_load_json(PATH_VERSION_CFG)
    if key in all_cfg:
        del all_cfg[key]
        safe_save_json(PATH_VERSION_CFG, all_cfg)
        return True
    return False


# ====================== 日志读取（游戏日志） ======================
def get_log_path(root_path, version_name):
    # ★ 新结构优先：<版本>/logs/latest.log（PCL 结构）
    p_new = os.path.join(root_path, "versions", version_name, "logs", "latest.log")
    if os.path.exists(p_new):
        return p_new
    # 老结构兜底：<版本>/.minecraft/logs/latest.log
    p_old = os.path.join(root_path, "versions", version_name, ".minecraft", "logs", "latest.log")
    if os.path.exists(p_old):
        return p_old
    # 最后：全局 <根>/logs/latest.log
    p_global = os.path.join(root_path, "logs", "latest.log")
    if os.path.exists(p_global):
        return p_global
    # 都不存在时，按当前隔离状态决定返回哪个（给 UI 显示路径用）
    if get_version_isolated(root_path, version_name):
        return p_new
    return p_global


def read_tail_lines(path, n):
    if not os.path.exists(path):
        return [], 0, "not_found"
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            block = 8192
            data = b""
            while size > 0 and data.count(b"\n") <= n:
                read_size = min(block, size)
                size -= read_size
                f.seek(size)
                data = f.read(read_size) + data
            text = data.decode("utf-8", errors="replace")
            lines = text.splitlines()
            return lines[-n:], os.path.getsize(path), None
    except Exception as e:
        return [], 0, str(e)


def read_from_offset(path, offset, max_lines=500):
    if not os.path.exists(path):
        return [], 0, "not_found"
    try:
        cur_size = os.path.getsize(path)
        if cur_size < offset:
            offset = 0
        with open(path, "rb") as f:
            f.seek(offset)
            data = f.read()
            text = data.decode("utf-8", errors="replace")
            lines = text.splitlines()
            if len(lines) > max_lines:
                lines = lines[-max_lines:]
            return lines, cur_size, None
    except Exception as e:
        return [], offset, str(e)


def read_full_log(path, max_lines=10000):
    if not os.path.exists(path):
        return [], 0, 0, False, "not_found"
    try:
        with open(path, "rb") as f:
            data = f.read()
            text = data.decode("utf-8", errors="replace")
            lines = text.splitlines()
            total = len(lines)
            truncated = False
            if total > max_lines:
                lines = lines[-max_lines:]
                truncated = True
            return lines, len(data), total, truncated, None
    except Exception as e:
        return [], 0, 0, False, str(e)


# ====================== 主题色 ======================
DEFAULT_THEME = {
    "accent": "#4FC3F7",
    "accent2": "#444444",
    "danger": "#c0392b",
    "bg": "#1f1f1f",
    "text": "#ffffff",
    "accent_hover": "",
    "accent2_hover": "",
    "danger_hover": "",
}


def load_theme():
    """读 color.json，缺字段用默认补全"""
    data = safe_load_json(COLOR_PATH)
    theme = dict(DEFAULT_THEME)
    if isinstance(data, dict):
        for k in DEFAULT_THEME:
            if k in data and isinstance(data[k], str):
                theme[k] = data[k]
    return theme


def save_theme(theme):
    merged = dict(DEFAULT_THEME)
    if isinstance(theme, dict):
        for k in DEFAULT_THEME:
            if k in theme and isinstance(theme[k], str):
                merged[k] = theme[k]
    safe_save_json(COLOR_PATH, merged)
    return merged

# ====================== 初始化 ======================
def init_xgmcl_dir():
    try:
        os.makedirs(SETTING_ROOT, exist_ok=True)
        os.makedirs(VERSION_SETTING_ROOT, exist_ok=True)
        os.makedirs(LOG_ROOT, exist_ok=True)
        os.makedirs(os.path.dirname(ACCOUNT_PATH), exist_ok=True)
        os.makedirs(DOWNLOAD_DATA_DIR, exist_ok=True)

        if not os.path.exists(PATH_ROOTS_DB):
            safe_save_json(PATH_ROOTS_DB, {"roots": [], "active_id": ""})

        if not os.path.exists(PATH_GLOBAL_CONFIG):
            safe_save_json(PATH_GLOBAL_CONFIG, {
                "global_ram": 2048,
                "global_java_path": "",
                "process_priority": "正常",
                "download_source": "bmclapi",
                "download_threads": 32,
                "default_isolated": False,
            })

        if not os.path.exists(PATH_JVM_CONFIG):
            safe_save_json(PATH_JVM_CONFIG, {
                "jvm_args": "-XX:+UseG1GC -XX:MaxGCPauseMillis=200",
            })
        if not os.path.exists(PATH_VERSION_CFG):
            safe_save_json(PATH_VERSION_CFG, {})
        if not os.path.exists(PATH_LAST_LAUNCH):
            safe_save_json(PATH_LAST_LAUNCH, {})
        if not os.path.exists(PATH_HOME_CONFIG):
            safe_save_json(PATH_HOME_CONFIG, {
                "content_type": "default",
                "content_path": "",
                "content_opacity": 100,
                "web_url": "https://modrinth.com/",
                "web_history": [],
                "web_favorites": [
                    {"name": "Modrinth", "url": "https://modrinth.com/"},
                ],
            })
        if not os.path.exists(PATH_TRUSTED):
            safe_save_json(PATH_TRUSTED, {"trusted": []})
        if not os.path.exists(PATH_DOWNLOAD_CFG):
            safe_save_json(PATH_DOWNLOAD_CFG, {
                "max_parallel": 16,
                "warn_on_close": True,
            })
        if not os.path.exists(PATH_SERVER_CFG):
            safe_save_json(PATH_SERVER_CFG, {
                "java_path": "",
                "ram_mb": 3072,
                "jvm_args": "",
                "last_dir": "",
            })
        if not os.path.exists(COLOR_PATH):
            safe_save_json(COLOR_PATH, DEFAULT_THEME)
        print("✅ XGMCL目录 & 配置文件初始化成功！")
    except Exception as e:
        print(f"❌ 目录创建失败：{e}")


# ====================== API: 根目录 ======================
@app.get("/api/roots/list")
def roots_list():
    db = safe_load_json(PATH_ROOTS_DB)
    roots = db.get("roots", [])
    active_id = db.get("active_id", "")

    for r in roots:
        r["valid"] = check_root_valid(r.get("path", ""))
        r["active"] = (r.get("id") == active_id)
        if r["valid"]:
            r["version_count"] = len(scan_versions_of_root(r["path"]))
        else:
            r["version_count"] = 0

    return {"code": 200, "roots": roots, "active_id": active_id}


@app.get("/api/roots/add")
def roots_add():
    path = select_folder_dialog()
    if not path:
        write_log("WARN", "添加目录: 用户取消")
        return {"code": 400, "msg": "未选择文件夹"}
    if not check_root_valid(path):
        write_log("WARN", f"添加目录失败: {path} 不是合法 MC 根目录")
        return {"code": 400, "msg": "该目录不是合法的 MC 根目录（需含 versions 和 libraries）"}

    db = safe_load_json(PATH_ROOTS_DB)
    roots = db.get("roots", [])

    for r in roots:
        if os.path.normcase(r.get("path", "")) == os.path.normcase(path):
            return {"code": 400, "msg": "该目录已经添加过"}

    new_id = str(uuid.uuid4())
    new_root = {
        "id": new_id,
        "name": os.path.basename(path) or path,
        "path": path,
    }
    roots.append(new_root)
    db["roots"] = roots

    if not db.get("active_id"):
        db["active_id"] = new_id

    safe_save_json(PATH_ROOTS_DB, db)
    write_log("INFO", f"添加目录成功: {new_root['name']} ({path})")
    return {"code": 200, "msg": "目录添加成功", "root": new_root}


@app.get("/api/roots/switch")
def roots_switch(root_id: str):
    db = safe_load_json(PATH_ROOTS_DB)
    roots = db.get("roots", [])
    found = None
    for r in roots:
        if r.get("id") == root_id:
            found = r
            break
    if not found:
        write_log("ERROR", f"切换目录失败: 目录不存在 ({root_id})")
        return {"code": 400, "msg": "目录不存在"}
    if not check_root_valid(found["path"]):
        write_log("ERROR", f"切换目录失败: 目录已失效 ({found['path']})")
        return {"code": 400, "msg": "该目录已失效"}

    db["active_id"] = root_id
    safe_save_json(PATH_ROOTS_DB, db)
    write_log("INFO", f"切换目录: {found['name']}")
    return {"code": 200, "msg": "已切换", "root": found}


@app.get("/api/roots/remove")
def roots_remove(root_id: str):
    db = safe_load_json(PATH_ROOTS_DB)
    roots = db.get("roots", [])
    new_roots = [r for r in roots if r.get("id") != root_id]

    if len(new_roots) == len(roots):
        return {"code": 400, "msg": "目录不存在"}

    removed = None
    for r in roots:
        if r.get("id") == root_id:
            removed = r
            break

    db["roots"] = new_roots
    if db.get("active_id") == root_id:
        db["active_id"] = new_roots[0]["id"] if new_roots else ""

    safe_save_json(PATH_ROOTS_DB, db)
    if removed:
        write_log("INFO", f"移除目录: {removed['name']}")
    return {"code": 200, "msg": "已移除"}


@app.get("/api/roots/versions")
def roots_versions(root_id: str = ""):
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录", "versions": []}
    if not check_root_valid(target["path"]):
        return {"code": 400, "msg": "目录已失效", "versions": []}

    root_path = target["path"]
    ver_list = scan_versions_of_root(root_path)

    all_cfg = safe_load_json(PATH_VERSION_CFG)
    for v in ver_list:
        key = version_cfg_key(root_path, v["full_name"])
        v["has_custom_config"] = key in all_cfg

        # ★ 新增：隔离状态
        try:
            v["isolated"] = get_version_isolated(root_path, v["full_name"])
        except Exception:
            v["isolated"] = False

        # ★ 新增：mod 数量 + 版本目录修改时间
        try:
            if v["isolated"]:
                ver_dir = os.path.join(root_path, "versions", v["full_name"])
                mods_dir = os.path.join(ver_dir, "mods")
            else:
                ver_dir = os.path.join(root_path, "versions", v["full_name"])
                mods_dir = os.path.join(root_path, "mods")

            # mod 数量（只数文件名，不读内容）
            mod_count = 0
            if os.path.isdir(mods_dir):
                for fn in os.listdir(mods_dir):
                    if fn.endswith(".jar") or fn.endswith(".jar.disabled"):
                        mod_count += 1
            v["mod_count"] = mod_count

            # 版本目录修改时间
            if os.path.isdir(ver_dir):
                v["mtime"] = int(os.path.getmtime(ver_dir))
            else:
                v["mtime"] = 0
        except Exception:
            v["mod_count"] = 0
            v["mtime"] = 0

    return {"code": 200, "root": target, "versions": ver_list}


# ====================== API: 版本专属配置 ======================
@app.get("/api/version/config/get")
def get_version_config(version_name: str, root_id: str = ""):
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    cfg = load_version_config(target["path"], version_name)
    return {"code": 200, "data": cfg}


@app.get("/api/version/config/save")
def save_version_config_api(version_name: str, root_id: str = "",
                            ram: int = 0, java_path: str = "",
                            priority: str = "", jvm_args: str = "",
                            width: int = 1280, height: int = 720):
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}

    cfg = {
        "ram": ram if ram > 0 else 2048,
        "java_path": java_path,
        "priority": priority or "正常",
        "jvm_args": jvm_args,
        "width": width,
        "height": height,
    }
    save_version_config(target["path"], version_name, cfg)
    write_log("INFO", f"保存版本配置: {version_name} (RAM={ram}MB)")
    return {"code": 200, "msg": "版本配置已保存", "data": cfg}


@app.get("/api/version/config/reset")
def reset_version_config_api(version_name: str, root_id: str = ""):
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    ok = reset_version_config(target["path"], version_name)
    if ok:
        write_log("INFO", f"重置版本配置: {version_name}")
        return {"code": 200, "msg": "已恢复继承全局设置"}
    else:
        return {"code": 200, "msg": "本来就没有专属配置"}


# ====================== API: 全局设置 ======================
@app.get("/api/setting/get")
def get_global_setting():
    d = safe_load_json(PATH_GLOBAL_CONFIG)
    d.setdefault("download_source", "bmclapi")
    d.setdefault("download_threads", 32)
    d.setdefault("default_isolated", False)
    return {"code": 200, "data": d}


@app.get("/api/setting/save")
def save_global_setting(ram: int, java_path: str, priority: str,
                        download_source: str = "bmclapi",
                        download_threads: int = 32,
                        default_isolated: int = 0):
    download_threads = max(4, min(int(download_threads), 256))
    data = {
        "global_ram": ram,
        "global_java_path": java_path,
        "process_priority": priority,
        "download_source": download_source,
        "download_threads": download_threads,
        "default_isolated": bool(default_isolated),
    }
    safe_save_json(PATH_GLOBAL_CONFIG, data)
    write_log("INFO", f"保存全局设置: RAM={ram}MB, Java={java_path or '(默认)'}, "
                      f"优先级={priority}, 源={download_source}, 线程={download_threads}, "
                      f"默认隔离={bool(default_isolated)}")
    return {"code": 200, "msg": "全局设置保存成功", "data": data}


@app.get("/api/jvm/get")
def get_jvm_args():
    return {"code": 200, "data": safe_load_json(PATH_JVM_CONFIG)}


@app.get("/api/jvm/save")
def save_jvm_args(args: str):
    safe_save_json(PATH_JVM_CONFIG, {"jvm_args": args})
    write_log("INFO", f"保存 JVM 参数: {args}")
    return {"code": 200, "msg": "JVM参数保存成功"}


# ====================== API: Java ======================
@app.get("/api/java/list")
def java_list():
    try:
        javas = scan_java_installations()
        return {"code": 200, "data": javas}
    except Exception as e:
        write_log("ERROR", f"扫描 Java 失败: {e}")
        return {"code": 500, "msg": f"扫描失败: {e}"}


@app.get("/api/java/cache/get")
def java_cache_get():
    data = safe_load_json(PATH_JAVA_CACHE)
    if not data or "list" not in data:
        return {"code": 200, "data": None}
    return {"code": 200, "data": data}


@app.get("/api/java/cache/scan")
def java_cache_scan():
    try:
        javas = scan_java_installations()
        data = {
            "time": int(time.time()),
            "list": javas,
        }
        safe_save_json(PATH_JAVA_CACHE, data)
        write_log("INFO", f"扫描 Java: 找到 {len(javas)} 个")
        return {"code": 200, "data": data}
    except Exception as e:
        write_log("ERROR", f"扫描 Java 失败: {e}")
        return {"code": 500, "msg": f"扫描失败: {e}"}


# ====================== API: 账户 ======================
# ---- 头像相关 ----
VANILLA_SKIN_DIR = os.path.join(XGMCL_ROOT, "data", "skins", "vanilla")
VANILLA_SKINS = ["steve", "alex", "ari", "efe", "kai",
                 "makena", "noor", "sunny", "zuri"]
AVATAR_CACHE_DIR = os.path.join(XGMCL_ROOT, "data", "avatar_cache")
LITTLESKIN_SESSION_BASE = "https://littleskin.cn/api/yggdrasil/sessionserver"


def _pick_vanilla_skin(username: str) -> str:
    """按 username 确定性挑一个原版皮肤名"""
    import hashlib as _hl
    h = _hl.md5(username.encode("utf-8")).digest()
    idx = h[0] % len(VANILLA_SKINS)
    return VANILLA_SKINS[idx]


def _crop_face_png(src_path: str, dst_path: str) -> bool:
    """
    从 64x64 皮肤 PNG 里裁出正面脸（8,8,8x8）+ 帽层（40,8,8x8），
    合成 8x8 的最终头像，放大 16 倍保存为 dst_path。
    需要 Pillow。
    """
    try:
        from PIL import Image
    except ImportError:
        write_log("ERROR", "未安装 Pillow，无法裁切头像。请 pip install Pillow")
        return False
    try:
        img = Image.open(src_path).convert("RGBA")
        if img.width != 64 or img.height != 64:
            # 非标准皮肤，直接原样拷贝（尽量不崩）
            img.save(dst_path, "PNG")
            return True
        face = img.crop((8, 8, 16, 16))
        hat = img.crop((40, 8, 48, 16))
        merged = Image.alpha_composite(face, hat)
        merged = merged.resize((128, 128), Image.NEAREST)
        os.makedirs(os.path.dirname(dst_path), exist_ok=True)
        merged.save(dst_path, "PNG")
        return True
    except Exception as e:
        write_log("ERROR", f"裁切头像失败 {src_path}: {e}")
        return False


def _build_vanilla_avatar(username: str, acc_uuid: str) -> str:
    """离线账户头像：确定性挑皮肤 → 裁 8x8 → 返回缓存路径"""
    skin_name = _pick_vanilla_skin(username)
    src = os.path.join(VANILLA_SKIN_DIR, f"{skin_name}.png")
    dst = os.path.join(AVATAR_CACHE_DIR, f"{acc_uuid}.png")

    if os.path.exists(dst):
        return dst
    if not os.path.exists(src):
        write_log("WARN", f"原版皮肤不存在: {src}")
        return ""
    if _crop_face_png(src, dst):
        return dst
    return ""


def _fetch_littleskin_textures(mc_uuid: str, access_token: str = "") -> dict:
    """
    调 LittleSkin session server 拿 textures。
    返回 {"skin_url": "...", "model": "default/slim"} 或空 dict。
    """
    url = f"{LITTLESKIN_SESSION_BASE}/session/minecraft/profile/{mc_uuid}"
    headers = {"Accept": "application/json"}
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    try:
        r = requests.get(url, headers=headers, timeout=15)
        if r.status_code != 200:
            write_log("WARN", f"LittleSkin textures 拉取失败: HTTP {r.status_code}")
            return {}
        data = r.json()
        props = data.get("properties", [])
        for p in props:
            if p.get("name") == "textures":
                raw = base64.b64decode(p.get("value", ""))
                tex = json.loads(raw.decode("utf-8"))
                skin_info = tex.get("textures", {}).get("SKIN", {})
                skin_url = skin_info.get("url", "")
                model = tex.get("textures", {}).get("SKIN", {}).get("metadata", {}).get("model", "default")
                return {"skin_url": skin_url, "model": model}
        return {}
    except Exception as e:
        write_log("ERROR", f"LittleSkin textures 解析失败: {e}")
        return {}


def _download_littleskin_avatar(skin_url: str, acc_uuid: str) -> str:
    """下载 LittleSkin 皮肤并裁成头像，返回缓存路径"""
    if not skin_url:
        return ""
    dst = os.path.join(AVATAR_CACHE_DIR, f"{acc_uuid}.png")
    if os.path.exists(dst):
        return dst
    tmp = os.path.join(AVATAR_CACHE_DIR, f"{acc_uuid}_raw.png")
    try:
        os.makedirs(AVATAR_CACHE_DIR, exist_ok=True)
        r = requests.get(skin_url, timeout=20)
        if r.status_code != 200:
            return ""
        with open(tmp, "wb") as f:
            f.write(r.content)
        ok = _crop_face_png(tmp, dst)
        try:
            os.remove(tmp)
        except Exception:
            pass
        return dst if ok else ""
    except Exception as e:
        write_log("ERROR", f"下载 LittleSkin 皮肤失败: {e}")
        return ""


def _offline_mc_uuid(username: str) -> str:
    """离线模式的 MC UUID：MD5('OfflinePlayer:<name>')，跟 launcher 里一致"""
    import hashlib as _hl
    digest = _hl.md5(("OfflinePlayer:" + username).encode("utf-8")).digest()
    b = bytearray(digest)
    b[6] = (b[6] & 0x0F) | 0x30
    b[8] = (b[8] & 0x3F) | 0x80
    # 转成标准 UUID 字符串
    import uuid as _uuid
    return str(_uuid.UUID(bytes=bytes(b)))


@app.get("/api/account/add")
def add_account(username: str):
    os.makedirs(os.path.dirname(ACCOUNT_PATH), exist_ok=True)
    accounts = safe_load_json(ACCOUNT_PATH)
    acc_uuid = str(uuid.uuid4())
    for aid in accounts:
        if accounts[aid].get("username") == username:
            return {"code": 400, "msg": "用户名已存在"}
    accounts[acc_uuid] = {
        "username": username,
        "uuid": acc_uuid,
        "type": "offline",
        "mc_uuid": _offline_mc_uuid(username),
        "selected": False,
    }
    safe_save_json(ACCOUNT_PATH, accounts)
    write_log("INFO", f"添加账户: {username}")
    return {"code": 200, "msg": "账户添加成功", "account": accounts[acc_uuid]}


def _account_sort_key(acc):
    """
    排序规则：
    1. 选中排最前（selected=True 排 0，否则排 1）
    2. 类型优先级：mojang > littleskin > offline
    3. 用户名
    """
    type_priority = {"mojang": 0, "littleskin": 1, "offline": 2}
    return (
        0 if acc.get("selected") else 1,
        type_priority.get(acc.get("type", "offline"), 9),
        (acc.get("username") or "").lower(),
    )


@app.get("/api/account/list")
def list_account():
    os.makedirs(os.path.dirname(ACCOUNT_PATH), exist_ok=True)
    accounts = safe_load_json(ACCOUNT_PATH)

    # 给老离线账户补 mc_uuid
    changed = False
    for aid in accounts:
        acc = accounts[aid]
        if acc.get("type") == "offline" and not acc.get("mc_uuid"):
            acc["mc_uuid"] = _offline_mc_uuid(acc.get("username", ""))
            changed = True
    if changed:
        safe_save_json(ACCOUNT_PATH, accounts)

    # 排序
    sorted_ids = sorted(accounts.keys(), key=lambda k: _account_sort_key(accounts[k]))
    ordered = {aid: accounts[aid] for aid in sorted_ids}

    return {"code": 200, "accounts": ordered}


@app.get("/api/account/avatar")
def get_account_avatar(acc_uuid: str):
    """
    返回账户头像 PNG 文件。
    离线 → 用 username 挑原版皮肤裁 8x8
    LittleSkin → 拉 textures 裁 8x8（带缓存）
    """
    from fastapi.responses import FileResponse, Response
    accounts = safe_load_json(ACCOUNT_PATH)
    acc = accounts.get(acc_uuid)
    if not acc:
        return Response(status_code=404)

    acc_type = acc.get("type", "offline")
    username = acc.get("username", "")

    # 离线：用原版皮肤
    if acc_type == "offline":
        path = _build_vanilla_avatar(username, acc_uuid)
        if path and os.path.exists(path):
            return FileResponse(path, media_type="image/png")
        return Response(status_code=404)

    # LittleSkin：拉真皮肤
    if acc_type == "littleskin":
        # 先看缓存
        cache = os.path.join(AVATAR_CACHE_DIR, f"{acc_uuid}.png")
        if os.path.exists(cache):
            return FileResponse(cache, media_type="image/png")

        mc_uuid = acc.get("mc_uuid", "")
        access_token = acc.get("access_token", "")
        if not mc_uuid:
            return Response(status_code=404)

        tex = _fetch_littleskin_textures(mc_uuid, access_token)
        skin_url = tex.get("skin_url", "")
        if not skin_url:
            return Response(status_code=404)

        path = _download_littleskin_avatar(skin_url, acc_uuid)
        if path and os.path.exists(path):
            return FileResponse(path, media_type="image/png")
        return Response(status_code=404)

    # Mojang（未开发）：暂时用离线兜底
    if acc_type == "mojang":
        path = _build_vanilla_avatar(username or acc_uuid, acc_uuid)
        if path and os.path.exists(path):
            return FileResponse(path, media_type="image/png")

    return Response(status_code=404)


@app.get("/api/account/skin")
def get_account_skin(acc_uuid: str):
    """
    返回完整 64x64 皮肤 PNG（给 3D 渲染用）。
    离线 → 用 username 挑原版皮肤原图
    LittleSkin → 下载真皮肤原图
    """
    from fastapi.responses import FileResponse, Response
    accounts = safe_load_json(ACCOUNT_PATH)
    acc = accounts.get(acc_uuid)
    if not acc:
        return Response(status_code=404)

    acc_type = acc.get("type", "offline")
    username = acc.get("username", "")

    # 缓存完整皮肤
    skin_cache = os.path.join(AVATAR_CACHE_DIR, f"{acc_uuid}_full.png")
    if os.path.exists(skin_cache):
        return FileResponse(skin_cache, media_type="image/png")

    # 离线：直接返回原版皮肤
    if acc_type == "offline":
        skin_name = _pick_vanilla_skin(username)
        src = os.path.join(VANILLA_SKIN_DIR, f"{skin_name}.png")
        if os.path.exists(src):
            return FileResponse(src, media_type="image/png")
        return Response(status_code=404)

    # LittleSkin：拉真皮肤
    if acc_type == "littleskin":
        mc_uuid = acc.get("mc_uuid", "")
        access_token = acc.get("access_token", "")
        if not mc_uuid:
            return Response(status_code=404)

        tex = _fetch_littleskin_textures(mc_uuid, access_token)
        skin_url = tex.get("skin_url", "")
        if not skin_url:
            return Response(status_code=404)

        try:
            os.makedirs(AVATAR_CACHE_DIR, exist_ok=True)
            r = requests.get(skin_url, timeout=20)
            if r.status_code == 200:
                with open(skin_cache, "wb") as f:
                    f.write(r.content)
                return FileResponse(skin_cache, media_type="image/png")
        except Exception as e:
            write_log("ERROR", f"下载完整皮肤失败: {e}")
        return Response(status_code=404)

    # Mojang 未开发，用离线兜底
    if acc_type == "mojang":
        skin_name = _pick_vanilla_skin(username or acc_uuid)
        src = os.path.join(VANILLA_SKIN_DIR, f"{skin_name}.png")
        if os.path.exists(src):
            return FileResponse(src, media_type="image/png")

    return Response(status_code=404)


@app.get("/api/account/detail")
def get_account_detail(acc_uuid: str):
    """账户详情：完整信息 + 头像状态"""
    accounts = safe_load_json(ACCOUNT_PATH)
    acc = accounts.get(acc_uuid)
    if not acc:
        return {"code": 400, "msg": "账户不存在"}

    acc_type = acc.get("type", "offline")
    username = acc.get("username", "")

    detail = {
        "uuid": acc_uuid,
        "username": username,
        "type": acc_type,
        "mc_uuid": acc.get("mc_uuid", ""),
        "selected": bool(acc.get("selected")),
        "has_avatar": False,
    }

    if acc_type == "littleskin":
        detail["has_token"] = bool(acc.get("access_token"))
        detail["has_refresh"] = bool(acc.get("refresh_token"))
        detail["expires_at"] = acc.get("expires_at", 0)
        detail["token_expired"] = (
            detail["expires_at"] > 0 and time.time() > detail["expires_at"]
        )
    elif acc_type == "offline":
        pass
    elif acc_type == "mojang":
        detail["has_token"] = bool(acc.get("access_token"))

    # 探测头像是否已缓存
    avatar_cache = os.path.join(AVATAR_CACHE_DIR, f"{acc_uuid}.png")
    detail["has_avatar"] = os.path.exists(avatar_cache)

    return {"code": 200, "data": detail}


@app.get("/api/account/remove")
def remove_account(acc_uuid: str):
    os.makedirs(os.path.dirname(ACCOUNT_PATH), exist_ok=True)
    accounts = safe_load_json(ACCOUNT_PATH)
    if acc_uuid not in accounts:
        return {"code": 400, "msg": "账户不存在"}
    removed = accounts.pop(acc_uuid)
    safe_save_json(ACCOUNT_PATH, accounts)
    write_log("INFO", f"删除账户: {removed.get('username', '?')} ({removed.get('type', '?')})")
    return {"code": 200, "msg": "账户已删除", "username": removed.get("username", "")}


@app.get("/api/account/select")
def select_account(acc_uuid: str):
    os.makedirs(os.path.dirname(ACCOUNT_PATH), exist_ok=True)
    accounts = safe_load_json(ACCOUNT_PATH)
    if acc_uuid not in accounts:
        return {"code": 400, "msg": "账户不存在"}
    for k in accounts:
        accounts[k]["selected"] = False
    accounts[acc_uuid]["selected"] = True
    safe_save_json(ACCOUNT_PATH, accounts)
    write_log("INFO", f"切换账户: {accounts[acc_uuid]['username']}")
    return {"code": 200, "msg": "账户切换成功", "current": accounts[acc_uuid]}


@app.get("/api/account/refresh_token")
def refresh_account_token(acc_uuid: str):
    """
    LittleSkin token 刷新。
    检查 expires_at，过期或快过期时调 /oauth/token 刷新。
    """
    accounts = safe_load_json(ACCOUNT_PATH)
    acc = accounts.get(acc_uuid)
    if not acc:
        return {"code": 400, "msg": "账户不存在"}
    if acc.get("type") != "littleskin":
        return {"code": 400, "msg": "仅 LittleSkin 账户支持刷新"}

    refresh_token = acc.get("refresh_token", "")
    if not refresh_token:
        return {"code": 400, "msg": "无 refresh_token，需重新登录", "need_relogin": True}

    try:
        r = requests.post(
            f"{LITTLESKIN_OAUTH_BASE}/oauth/token",
            data={
                "client_id": LITTLESKIN_CLIENT_ID,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            },
            headers={"Accept": "application/json"},
            timeout=15,
        )
        if r.status_code != 200:
            write_log("WARN", f"LittleSkin token 刷新失败: HTTP {r.status_code}")
            return {"code": 400, "msg": f"刷新失败: HTTP {r.status_code}", "need_relogin": True}

        d = r.json()
        acc["access_token"] = d.get("access_token", acc.get("access_token", ""))
        if d.get("refresh_token"):
            acc["refresh_token"] = d["refresh_token"]
        expires_in = int(d.get("expires_in", 0))
        if expires_in > 0:
            acc["expires_at"] = int(time.time()) + expires_in
        safe_save_json(ACCOUNT_PATH, accounts)
        write_log("INFO", f"LittleSkin token 已刷新: {acc.get('username')}")
        return {"code": 200, "msg": "刷新成功", "expires_at": acc.get("expires_at", 0)}

    except Exception as e:
        write_log("ERROR", f"LittleSkin token 刷新异常: {e}")
        return {"code": 500, "msg": f"刷新异常: {e}", "need_relogin": True}


# ====================== API: 启动游戏 ======================
@app.get("/api/game/launch")
def game_launch(version_name: str, root_id: str = ""):
    accounts = safe_load_json(ACCOUNT_PATH)
    current_acc = None
    current_acc_id = None
    for aid in accounts:
        if accounts[aid].get("selected"):
            current_acc = accounts[aid]
            current_acc_id = aid
            break
    if not current_acc:
        write_log("WARN", "启动游戏失败: 未选择账户")
        return {"code": 400, "msg": "请先选择登录账户"}

    # LittleSkin token 检查（快过期就刷新）
    if current_acc.get("type") == "littleskin":
        expires_at = current_acc.get("expires_at", 0)
        # 剩余不足 5 分钟就刷新
        if expires_at > 0 and time.time() > (expires_at - 300):
            try:
                r = requests.post(
                    f"{LITTLESKIN_OAUTH_BASE}/oauth/token",
                    data={
                        "client_id": LITTLESKIN_CLIENT_ID,
                        "grant_type": "refresh_token",
                        "refresh_token": current_acc.get("refresh_token", ""),
                    },
                    headers={"Accept": "application/json"},
                    timeout=15,
                )
                if r.status_code == 200:
                    d = r.json()
                    current_acc["access_token"] = d.get("access_token", current_acc.get("access_token", ""))
                    if d.get("refresh_token"):
                        current_acc["refresh_token"] = d["refresh_token"]
                    expires_in = int(d.get("expires_in", 0))
                    if expires_in > 0:
                        current_acc["expires_at"] = int(time.time()) + expires_in
                    accounts[current_acc_id] = current_acc
                    safe_save_json(ACCOUNT_PATH, accounts)
                    write_log("INFO", f"启动前刷新 LittleSkin token 成功: {current_acc.get('username')}")
                else:
                    write_log("WARN", f"启动前刷新 LittleSkin token 失败: HTTP {r.status_code}")
            except Exception as e:
                write_log("WARN", f"启动前刷新 LittleSkin token 异常: {e}")

    target = get_root_by_id(root_id)
    if not target:
        write_log("ERROR", "启动游戏失败: 没有可用的游戏目录")
        return {"code": 400, "msg": "没有可用的游戏目录，请先添加"}
    if not check_root_valid(target["path"]):
        write_log("ERROR", "启动游戏失败: 游戏目录已失效")
        return {"code": 400, "msg": "当前游戏目录已失效"}

    vcfg = load_version_config(target["path"], version_name)
    ram      = vcfg.get("ram", 2048)
    java     = vcfg.get("java_path") or "java"
    jvm_args = vcfg.get("jvm_args", "")
    priority = vcfg.get("priority", "正常")
    inherited = vcfg.get("_inherited", True)
    isolated = get_version_isolated(target["path"], version_name)
    game_dir = get_version_game_dir(target["path"], version_name, isolated)

    write_log("INFO", f"🎮 启动游戏: {version_name}")
    write_log("INFO", f"   目录: {target['name']}")
    write_log("INFO", f"   账户: {current_acc['username']}")
    write_log("INFO", f"   内存: {ram}MB, Java: {java}, 优先级: {priority}")
    write_log("INFO", f"   配置来源: {'继承全局' if inherited else '版本专属'}")
    write_log("INFO", f"   版本隔离: {'开启' if isolated else '关闭'}，gameDir={game_dir}")

    print(f"🎮 从 [{target['name']}] 启动版本: {version_name} (isolated={isolated})")

    t = threading.Thread(
        target=_launch_worker,
        args=(target, version_name, current_acc["username"],
              ram, java, jvm_args, priority, isolated, game_dir),
        daemon=True,
    )
    t.start()
    return {"code": 200, "msg": "启动已开始"}


def _launch_worker(target, version_name, username, ram, java, jvm_args, priority,
                   isolated=False, game_dir=None):
    try:
        result = launch_game(
            game_root=target["path"],
            version_name=version_name,
            username=username,
            ram_mb=ram,
            java_path=java,
            jvm_args_extra=jvm_args,
            priority=priority,
            isolated=isolated,
            game_dir=game_dir,
        )

        if result.get("code") == 200:
            safe_save_json(PATH_LAST_LAUNCH, {
                "root_id": target["id"],
                "root_path": target["path"],
                "version_name": version_name,
                "pid": result.get("pid", 0),
            })
            write_log("INFO", f"游戏启动成功 (PID={result.get('pid')})")
        else:
            write_log("ERROR", f"游戏启动失败: {result.get('msg')}")
    except BaseException as e:
        import traceback
        write_log("FATAL", f"_launch_worker 未捕获异常: {e}")
        write_log("FATAL", traceback.format_exc())

@app.get("/api/game/launch_progress")
def game_launch_progress():
    from launcher import LAUNCH_STATE, LAUNCH_LOCK
    with LAUNCH_LOCK:
        return {"code": 200, "data": dict(LAUNCH_STATE)}


@app.get("/api/game/kill")
def game_kill(pid: int = 0):
    if not pid:
        return {"code": 400, "msg": "pid 为空"}
    try:
        import psutil
        p = psutil.Process(pid)
        name = (p.name() or "").lower()
        is_java = ("java" in name) or ("javaw" in name)
        if not is_java:
            return {"code": 400, "msg": "该 PID 不是 Java 进程，拒绝操作"}
        p.terminate()
        # 给 3 秒优雅退出，超时强杀
        try:
            p.wait(timeout=3)
        except psutil.TimeoutExpired:
            p.kill()
        write_log("INFO", f"用户强制关闭游戏进程 PID={pid}")
        return {"code": 200, "msg": "已关闭游戏"}
    except psutil.NoSuchProcess:
        return {"code": 200, "msg": "进程已不存在"}
    except Exception as e:
        write_log("ERROR", f"关闭游戏失败 PID={pid}: {e}")
        return {"code": 500, "msg": f"关闭失败: {e}"}
    

@app.get("/api/game/is_alive")
def game_is_alive(pid: int = 0):
    if not pid:
        return {"code": 200, "alive": False}
    try:
        import psutil
        p = psutil.Process(pid)
        name = (p.name() or "").lower()
        is_java = ("java" in name) or ("javaw" in name)
        running = (
            p.is_running()
            and p.status() != psutil.STATUS_ZOMBIE
            and is_java
        )
        write_log("INFO", f"is_alive pid={pid} name={name!r} is_java={is_java} running={running}")
        return {"code": 200, "alive": running}
    except Exception as e:
        write_log("WARN", f"is_alive pid={pid} 异常: {e}")
        return {"code": 200, "alive": False}


@app.get("/api/game/last_launch")
def game_last_launch():
    data = safe_load_json(PATH_LAST_LAUNCH)
    if not data:
        return {"code": 200, "data": None}
    pid = data.get("pid", 0)
    alive = False
    if pid:
        try:
            import psutil
            p = psutil.Process(pid)
            name = (p.name() or "").lower()
            is_java = ("java" in name) or ("javaw" in name)
            alive = (
                p.is_running()
                and p.status() != psutil.STATUS_ZOMBIE
                and is_java
            )
        except Exception:
            alive = False
    data["alive"] = alive
    return {"code": 200, "data": data}




# ====================== API: 游戏日志 ======================
@app.get("/api/logs/tail")
def logs_tail(version_name: str, root_id: str = "", n: int = 20):
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    log_path = get_log_path(target["path"], version_name)
    lines, size, err = read_tail_lines(log_path, n)
    if err == "not_found":
        return {"code": 404, "msg": "读取失败，请先启动游戏或检查路径是否存在", "path": log_path}
    if err:
        return {"code": 500, "msg": f"读取失败: {err}"}
    return {"code": 200, "lines": lines, "offset": size, "path": log_path}


@app.get("/api/logs/since")
def logs_since(version_name: str, root_id: str = "", offset: int = 0, max_lines: int = 500):
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    log_path = get_log_path(target["path"], version_name)
    lines, next_offset, err = read_from_offset(log_path, offset, max_lines)
    if err == "not_found":
        return {"code": 404, "msg": "日志文件不存在", "path": log_path}
    if err:
        return {"code": 500, "msg": f"读取失败: {err}"}
    return {"code": 200, "lines": lines, "next_offset": next_offset, "path": log_path}


@app.get("/api/logs/full")
def logs_full(version_name: str, root_id: str = "", max_lines: int = 10000):
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    log_path = get_log_path(target["path"], version_name)
    lines, size, total, truncated, err = read_full_log(log_path, max_lines)
    if err == "not_found":
        return {"code": 404, "msg": "读取失败，请先启动游戏或检查路径是否存在", "path": log_path}
    if err:
        return {"code": 500, "msg": f"读取失败: {err}"}
    return {"code": 200, "lines": lines, "offset": size,
            "total": total, "truncated": truncated, "path": log_path}


@app.get("/api/logs/open_folder")
def logs_open_folder(version_name: str, root_id: str = ""):
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    log_path = get_log_path(target["path"], version_name)
    log_dir = os.path.dirname(log_path)
    if not os.path.isdir(log_dir):
        try:
            os.makedirs(log_dir, exist_ok=True)
        except Exception as e:
            return {"code": 400, "msg": f"目录不存在且无法创建: {e}"}
    try:
        os.startfile(log_dir)
        return {"code": 200, "msg": "已打开文件夹", "path": log_dir}
    except Exception as e:
        return {"code": 500, "msg": f"打开失败: {e}"}

# ====================== API: 通用日志文件 ======================
@app.get("/api/logs/browse_any")
def logs_browse_any():
    """选任意日志文件（.log / .txt）"""
    path = select_file_dialog(
        "选择日志文件",
        [("日志文件", "*.log *.txt"), ("所有文件", "*.*")]
    )
    if not path:
        return {"code": 400, "msg": "未选择文件"}
    return {"code": 200, "path": path}


@app.get("/api/logs/read_any")
def logs_read_any(path: str, max_lines: int = 5000):
    """读任意日志文件的尾部 max_lines 行"""
    if not path or not os.path.isfile(path):
        return {"code": 404, "msg": "文件不存在"}
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            block = 65536
            data = b""
            # 倒着读，凑够 max_lines 行或多读几块
            target_newlines = max_lines
            while size > 0 and data.count(b"\n") <= target_newlines:
                read_size = min(block, size)
                size -= read_size
                f.seek(size)
                data = f.read(read_size) + data
            text = data.decode("utf-8", errors="replace")
            lines = text.splitlines()
            total = len(lines)
            truncated = False
            if total > max_lines:
                lines = lines[-max_lines:]
                truncated = True
            return {
                "code": 200,
                "lines": lines,
                "total": total,
                "truncated": truncated,
                "path": path,
            }
    except Exception as e:
        write_log("ERROR", f"读通用日志失败 {path}: {e}")
        return {"code": 500, "msg": f"读取失败: {e}"}


@app.get("/api/logs/read_any_full")
def logs_read_any_full(path: str):
    """读整个日志文件"""
    if not path or not os.path.isfile(path):
        return {"code": 404, "msg": "文件不存在"}
    try:
        with open(path, "rb") as f:
            data = f.read()
        text = data.decode("utf-8", errors="replace")
        lines = text.splitlines()
        return {
            "code": 200,
            "lines": lines,
            "total": len(lines),
            "path": path,
        }
    except Exception as e:
        write_log("ERROR", f"读通用日志全文失败 {path}: {e}")
        return {"code": 500, "msg": f"读取失败: {e}"}


# ====================== API: 启动器日志 ======================
@app.get("/api/launcher_log/list")
def launcher_log_list():
    files = list_log_files()
    return {"code": 200, "files": files}


@app.get("/api/launcher_log/read")
def launcher_log_read(filename: str, max_lines: int = 5000):
    lines, err = read_log_file(filename, max_lines)
    if err:
        return {"code": 404, "msg": err}
    return {"code": 200, "lines": lines}


@app.get("/api/launcher_log/open_folder")
def launcher_log_open_folder():
    try:
        log_dir = get_log_dir()
        os.makedirs(log_dir, exist_ok=True)
        os.startfile(log_dir)
        return {"code": 200, "msg": "已打开文件夹", "path": log_dir}
    except Exception as e:
        return {"code": 500, "msg": f"打开失败: {e}"}


# ====================== API: 外观效果 ======================
APPEARANCE_DEFAULTS = {
    "glass": False,
    "liquid": False,
    "btn_alpha": 100,
    "btn_alpha_primary": None,
    "btn_alpha_secondary": None,
    "btn_alpha_danger": None,
    "btn_alpha_small": None,
    "blur_sidebar": 3,
    "blur_card": 8,
    "global_bg_image": "",
    "global_bg_dim": 20,
    "global_bg_blur": 0,
    "card_alpha": 100,
    "card_dim": 20,
    "show_quickbar": True,
    "nav_icon_color": "",
    "nav_icon_active_color": "",
    "nav_icon_hover_color": "",
}

def load_appearance():
    cfg = safe_load_json(PATH_APPEARANCE)
    if not isinstance(cfg, dict):
        cfg = {}
    for k, v in APPEARANCE_DEFAULTS.items():
        if k not in cfg:
            cfg[k] = v
    return cfg


@app.get("/api/appearance/get")
def appearance_get():
    return {"code": 200, "data": load_appearance()}


@app.get("/api/appearance/save")
def appearance_save(glass: int = -1, liquid: int = -1,
                    btn_alpha: int = -1,
                    btn_alpha_primary: str = "__keep__",
                    btn_alpha_secondary: str = "__keep__",
                    btn_alpha_danger: str = "__keep__",
                    btn_alpha_small: str = "__keep__",
                    blur_sidebar: int = -1,
                    blur_card: int = -1,
                    global_bg_image: str = "__keep__",
                    global_bg_dim: int = -1,
                    global_bg_blur: int = -1,
                    card_alpha: int = -1,
                    card_dim: int = -1,
                    show_quickbar: int = -1,
                    nav_icon_color: str = "__keep__",
                    nav_icon_active_color: str = "__keep__",
                    nav_icon_hover_color: str = "__keep__"):
    """
    保存外观设置。
    - 用 -1 / "__keep__" 做哨兵
    - 分类 alpha 传 "__null__" 表示清空（变回跟随全局）
    """
    cfg = load_appearance()

    def _set_cat(key, val):
        if val == "__keep__":
            return
        if val == "__null__" or val == "":
            cfg[key] = None
        else:
            try:
                cfg[key] = max(0, min(100, int(val)))
            except Exception:
                pass

    if glass >= 0:          cfg["glass"] = bool(glass)
    if liquid >= 0:         cfg["liquid"] = bool(liquid)
    if btn_alpha >= 0:      cfg["btn_alpha"] = max(0, min(100, btn_alpha))
    if blur_sidebar >= 0:   cfg["blur_sidebar"] = max(0, min(30, blur_sidebar))
    if blur_card >= 0:      cfg["blur_card"] = max(0, min(30, blur_card))
    if global_bg_dim >= 0:  cfg["global_bg_dim"] = max(0, min(100, global_bg_dim))
    if global_bg_blur >= 0: cfg["global_bg_blur"] = max(0, min(30, global_bg_blur))
    if global_bg_image != "__keep__":
        cfg["global_bg_image"] = global_bg_image or ""
    if card_alpha >= 0:     cfg["card_alpha"] = max(0, min(100, card_alpha))
    if card_dim >= 0:       cfg["card_dim"] = max(0, min(100, card_dim))
    if show_quickbar >= 0:  cfg["show_quickbar"] = bool(show_quickbar)

    if nav_icon_color != "__keep__":
        cfg["nav_icon_color"] = nav_icon_color or ""
    if nav_icon_active_color != "__keep__":
        cfg["nav_icon_active_color"] = nav_icon_active_color or ""
    if nav_icon_hover_color != "__keep__":
        cfg["nav_icon_hover_color"] = nav_icon_hover_color or ""

    _set_cat("btn_alpha_primary",   btn_alpha_primary)
    _set_cat("btn_alpha_secondary", btn_alpha_secondary)
    _set_cat("btn_alpha_danger",    btn_alpha_danger)
    _set_cat("btn_alpha_small",     btn_alpha_small)

    safe_save_json(PATH_APPEARANCE, cfg)
    write_log("INFO", f"保存外观: glass={cfg.get('glass')}, liquid={cfg.get('liquid')}, "
                      f"btn_alpha={cfg.get('btn_alpha')}")
    return {"code": 200, "msg": "已保存", "data": cfg}


@app.get("/api/appearance/browse_bg")
def appearance_browse_bg():
    path = select_file_dialog(
        "选择全局背景图片",
        [("图片", "*.png *.jpg *.jpeg *.bmp *.webp *.gif *.ico"), ("所有文件", "*.*")]
    )
    if not path:
        return {"code": 400, "msg": "未选择文件"}
    return {"code": 200, "path": path}


@app.get("/api/appearance/bg_file")
def appearance_bg_file():
    """直接返回背景图文件（绕过 Electron 的 file:// 限制）"""
    from fastapi.responses import FileResponse, Response
    cfg = load_appearance()
    img = cfg.get("global_bg_image", "")
    if not img or not os.path.exists(img):
        return Response(status_code=404)
    return FileResponse(img)


# ====================== API: 主题色 ======================
@app.get("/api/theme/get")
def theme_get():
    return {"code": 200, "data": load_theme()}


@app.get("/api/theme/save")
def theme_save(data: str = "{}"):
    """data 是 JSON 字符串，包含要保存的主题字段"""
    try:
        parsed = json.loads(data) if data else {}
    except Exception as e:
        return {"code": 400, "msg": f"data 不是合法 JSON: {e}"}
    if not isinstance(parsed, dict):
        return {"code": 400, "msg": "data 必须是 JSON 对象"}
    merged = save_theme(parsed)
    write_log("INFO", f"保存主题色: accent={merged['accent']}, "
                      f"accent2={merged['accent2']}, danger={merged['danger']}, "
                      f"bg={merged['bg']}, text={merged['text']}")
    return {"code": 200, "msg": "主题已保存", "data": merged}


# ====================== API: 主页自定义 ======================
def resolve_home_path(path_str):
    if not path_str:
        return ""
    if os.path.isabs(path_str):
        return path_str
    target = get_root_by_id("")
    if target:
        return os.path.join(target["path"], path_str)
    return os.path.abspath(path_str)


@app.get("/api/home/get")
def home_get():
    cfg = safe_load_json(PATH_HOME_CONFIG)
    defaults = {
        "content_type": "default",
        "content_path": "",
        "content_opacity": 100,
        "web_url": "https://modrinth.com/",
        "web_history": [],
        "web_favorites": [
            {"name": "Modrinth", "url": "https://modrinth.com/"},
        ],
    }
    for k, v in defaults.items():
        cfg.setdefault(k, v)
    return {"code": 200, "data": cfg}

ALLOWED_HOME_CONTENT_TYPES = {"default", "md", "txt", "log", "html", "web"}


@app.get("/api/home/save")
def home_save(content_type: str = "default", content_path: str = "",
              content_opacity: int = 100, web_url: str = "__keep__"):
    # XAML 已废弃，非法值一律降级为 default
    if content_type not in ALLOWED_HOME_CONTENT_TYPES:
        content_type = "default"

    # ★ 读现有配置，保留 web_history / web_favorites
    cfg = safe_load_json(PATH_HOME_CONFIG)
    cfg["content_type"] = content_type
    cfg["content_path"] = content_path
    cfg["content_opacity"] = content_opacity

    if web_url != "__keep__":
        cfg["web_url"] = web_url or "https://modrinth.com/"

    # 补默认值
    cfg.setdefault("web_url", "https://modrinth.com/")
    cfg.setdefault("web_history", [])
    cfg.setdefault("web_favorites", [
        {"name": "Modrinth", "url": "https://modrinth.com/"},
    ])

    safe_save_json(PATH_HOME_CONFIG, cfg)
    write_log("INFO", f"保存主页设置: 内容类型={content_type}")
    return {"code": 200, "msg": "主页设置已保存", "data": cfg}

@app.get("/api/home/web/set_url")
def home_web_set_url(url: str):
    """设置当前主页网页 URL，并自动记入历史"""
    if not url or not url.strip():
        return {"code": 400, "msg": "URL 不能为空"}
    url = url.strip()
    # 没有协议头就补 https://
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    cfg = safe_load_json(PATH_HOME_CONFIG)
    cfg.setdefault("web_history", [])
    cfg.setdefault("web_favorites", [
        {"name": "Modrinth", "url": "https://modrinth.com/"},
    ])

    cfg["web_url"] = url

    # 记入历史（去重，最新的放前面，最多 50 条）
    history = [h for h in cfg["web_history"] if h.get("url") != url]
    history.insert(0, {
        "url": url,
        "time": int(time.time()),
    })
    cfg["web_history"] = history[:50]

    safe_save_json(PATH_HOME_CONFIG, cfg)
    write_log("INFO", f"主页网页: {url}")
    return {"code": 200, "msg": "已设置", "data": cfg}


@app.get("/api/home/web/history/clear")
def home_web_history_clear():
    """清空网页历史"""
    cfg = safe_load_json(PATH_HOME_CONFIG)
    cfg["web_history"] = []
    safe_save_json(PATH_HOME_CONFIG, cfg)
    return {"code": 200, "msg": "历史已清空"}


@app.get("/api/home/web/history/remove")
def home_web_history_remove(url: str):
    """删一条历史"""
    cfg = safe_load_json(PATH_HOME_CONFIG)
    history = cfg.get("web_history", [])
    cfg["web_history"] = [h for h in history if h.get("url") != url]
    safe_save_json(PATH_HOME_CONFIG, cfg)
    return {"code": 200, "msg": "已删除"}


@app.get("/api/home/web/favorite/add")
def home_web_favorite_add(url: str, name: str = ""):
    """加收藏"""
    if not url or not url.strip():
        return {"code": 400, "msg": "URL 不能为空"}
    url = url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    cfg = safe_load_json(PATH_HOME_CONFIG)
    favorites = cfg.get("web_favorites", [])

    # 已存在 → 不重复加
    if any(f.get("url") == url for f in favorites):
        return {"code": 400, "msg": "已在收藏中"}

    # 没传名字 → 用域名
    if not name:
        try:
            from urllib.parse import urlparse
            name = urlparse(url).netloc or url
        except Exception:
            name = url

    favorites.append({"name": name, "url": url})
    cfg["web_favorites"] = favorites
    safe_save_json(PATH_HOME_CONFIG, cfg)
    return {"code": 200, "msg": "已收藏", "data": cfg}


@app.get("/api/home/web/favorite/remove")
def home_web_favorite_remove(url: str):
    """删收藏"""
    cfg = safe_load_json(PATH_HOME_CONFIG)
    favorites = cfg.get("web_favorites", [])
    cfg["web_favorites"] = [f for f in favorites if f.get("url") != url]
    safe_save_json(PATH_HOME_CONFIG, cfg)
    return {"code": 200, "msg": "已移除"}


@app.get("/api/home/browse_content")
def home_browse_content():
    path = select_file_dialog(
        "选择主页内容文件",
        [("支持的文件", "*.md *.txt *.json *.log *.html *.htm"),
         ("所有文件", "*.*")]
    )
    if not path:
        return {"code": 400, "msg": "未选择文件"}
    return {"code": 200, "path": path}


@app.get("/api/home/read_file")
def home_read_file(path: str):
    real_path = resolve_home_path(path)
    if not os.path.exists(real_path):
        return {"code": 404, "msg": f"文件不存在: {real_path}"}
    try:
        with open(real_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        return {"code": 200, "content": content, "path": real_path}
    except Exception as e:
        return {"code": 500, "msg": f"读取失败: {e}"}

# ====================== API: HTML 信任管理 ======================
@app.get("/api/home/is_trusted")
def is_trusted(path: str):
    real_path = resolve_home_path(path)
    db = safe_load_json(PATH_TRUSTED)
    trusted = db.get("trusted", [])
    norm = os.path.normcase(real_path)
    for t in trusted:
        if os.path.normcase(t) == norm:
            return {"code": 200, "trusted": True}
    return {"code": 200, "trusted": False}

@app.get("/api/home/trust")
def trust_html(path: str):
    real_path = resolve_home_path(path)
    if not os.path.exists(real_path):
        return {"code": 404, "msg": "文件不存在"}
    db = safe_load_json(PATH_TRUSTED)
    trusted = db.get("trusted", [])
    norm = os.path.normcase(real_path)
    if not any(os.path.normcase(t) == norm for t in trusted):
        trusted.append(real_path)
    db["trusted"] = trusted
    safe_save_json(PATH_TRUSTED, db)
    write_log("WARN", f"信任 HTML 文件: {real_path}")
    return {"code": 200, "msg": "已信任"}


@app.get("/api/home/untrust")
def untrust_html(path: str):
    real_path = resolve_home_path(path)
    db = safe_load_json(PATH_TRUSTED)
    trusted = db.get("trusted", [])
    norm = os.path.normcase(real_path)
    trusted = [t for t in trusted if os.path.normcase(t) != norm]
    db["trusted"] = trusted
    safe_save_json(PATH_TRUSTED, db)
    return {"code": 200, "msg": "已取消信任"}


# ====================== API: 系统操作 ======================
@app.get("/api/system/open")
def system_open(target: str):
    if not target:
        return {"code": 400, "msg": "target 为空"}
    resolved = resolve_home_path(target)
    try:
        if os.path.exists(resolved):
            os.startfile(resolved)
            write_log("INFO", f"打开文件/文件夹: {resolved}")
            return {"code": 200, "msg": "已打开", "path": resolved}
        subprocess.Popen(target, shell=True)
        write_log("INFO", f"启动程序: {target}")
        return {"code": 200, "msg": "已启动", "cmd": target}
    except Exception as e:
        write_log("ERROR", f"执行失败: {target} → {e}")
        return {"code": 500, "msg": f"执行失败: {e}"}

def _download_worker(task_id, root_path, version_name, mc_version_id,
                     mc_version_url, source, threads,
                     install_fabric=False, fabric_loader="",
                     download_fabric_api=False):
    """下载 worker：原版 → Fabric loader → Fabric API。串行多阶段。"""
    try:
        # 算总阶段数
        stage_total = 1
        if install_fabric and fabric_loader:
            stage_total = 2
            if download_fabric_api:
                stage_total = 3
        with TASK_LOCKS[task_id]:
            TASKS[task_id]["stage_total"] = stage_total

        # ===== 阶段 1：原版 =====
        with TASK_LOCKS[task_id]:
            TASKS[task_id]["stage"] = 1
        start_download(
            root_path, version_name, mc_version_id, mc_version_url,
            source, threads, task_id=task_id,
        )

        # 检查阶段 1 结果
        with TASK_LOCKS[task_id]:
            t = TASKS[task_id]
            stage1_ok = t.get("done") and not t.get("error")
            cancelled = t.get("cancel")

        if not stage1_ok or cancelled:
            _finalize_task_history(task_id)
            return

        # ===== 阶段 2：Fabric loader（可选）=====
        if install_fabric and fabric_loader:
            with TASK_LOCKS[task_id]:
                TASKS[task_id]["stage"] = 2
                _reset_task_stage_progress(task_id)

            _fabric_install_worker_inner(
                task_id, root_path, version_name, mc_version_id,
                fabric_loader, source, threads,
            )

            # 检查阶段 2
            with TASK_LOCKS[task_id]:
                t = TASKS[task_id]
                stage2_ok = t.get("done") and not t.get("error")
                cancelled = t.get("cancel")
            if not stage2_ok or cancelled:
                _finalize_task_history(task_id)
                return

            # ===== 阶段 3：Fabric API（可选）=====
            if download_fabric_api:
                with TASK_LOCKS[task_id]:
                    TASKS[task_id]["stage"] = 3
                    _reset_task_stage_progress(task_id)

                _fabric_api_download_worker(
                    task_id, root_path, version_name, mc_version_id,
                )

        _finalize_task_history(task_id)

    except Exception as e:
        write_log("ERROR", f"下载 worker 异常: {e}")
        with TASK_LOCKS[task_id]:
            if task_id in TASKS:
                TASKS[task_id]["error"] = str(e)
                TASKS[task_id]["active"] = False
        _finalize_task_history(task_id)


def _reset_task_stage_progress(task_id):
    """切阶段时重置进度字段"""
    with TASK_LOCKS[task_id]:
        t = TASKS.get(task_id)
        if t is None:
            return
        t["active"] = True
        t["done"] = False
        t["error"] = None
        t["total_bytes"] = 0
        t["downloaded_bytes"] = 0
        t["actual_downloaded_bytes"] = 0
        t["skipped_bytes"] = 0
        t["files_total"] = 0
        t["files_done"] = 0
        t["files_skipped"] = 0
        t["files_downloaded"] = 0
        t["current_files"] = []
        t["failed_count"] = 0
        t["failed_files"] = []


def _fabric_api_download_worker(task_id, root_path, version_name, mc_version_id):
    """下 Fabric API（一个 jar）到 mods/ 目录"""
    def _set(key, val):
        with TASK_LOCKS[task_id]:
            t = TASKS.get(task_id)
            if t is not None:
                t[key] = val

    def _cancelled():
        with TASK_LOCKS[task_id]:
            t = TASKS.get(task_id)
            return t is None or t.get("cancel")

    try:
        _set("current_files", ["查询 Fabric API 版本..."])
        info = find_fabric_api_version(mc_version_id)
        if not info:
            # 找不到就不算失败，只是跳过
            write_log("WARN", f"未找到匹配 MC {mc_version_id} 的 Fabric API")
            _set("done", True)
            _set("active", False)
            return

        # 判断 mods 目录（跟 PCL 兼容：隔离时直接在版本目录下）
        isolated = get_version_isolated(root_path, version_name)
        if isolated:
            mods_dir = os.path.join(root_path, "versions", version_name, "mods")
        else:
            mods_dir = os.path.join(root_path, "mods")
        os.makedirs(mods_dir, exist_ok=True)

        filename = info["filename"]
        target = os.path.join(mods_dir, filename)

        # 已存在且大小对 → 跳过
        if os.path.exists(target) and info.get("size") and \
                os.path.getsize(target) == info["size"]:
            write_log("INFO", f"Fabric API 已存在: {target}")
            _set("done", True)
            _set("active", False)
            _set("files_total", 1)
            _set("files_done", 1)
            _set("files_skipped", 1)
            _set("total_bytes", info["size"])
            _set("downloaded_bytes", info["size"])
            _set("skipped_bytes", info["size"])
            return

        _set("current_files", [f"下载 Fabric API: {filename}"])
        _set("files_total", 1)
        _set("total_bytes", info.get("size", 0))

        # 单文件下载
        file_info = {
            "url": info["url"],
            "target": target,
            "sha1": info.get("sha1", ""),
            "size": info.get("size", 0),
            "important": True,
        }
        # 用全局下载函数（会走 task_id 累加进度）
        result = download_one_file(file_info, "official", 5, task_id)
        _set("files_done", 1)

        if _cancelled():
            _set("error", "已取消")
            _set("active", False)
            return

        _set("done", True)
        _set("active", False)
        write_log("INFO", f"Fabric API 下载完成: {target}")

    except Exception as e:
        write_log("ERROR", f"Fabric API 下载失败: {e}")
        _set("error", f"Fabric API 下载失败: {e}")
        _set("active", False)


def _finalize_task_history(task_id):
    """任务结束时，写一条历史记录"""
    try:
        with TASK_LOCKS[task_id]:
            t = TASKS.get(task_id)
            if t is None:
                return
            record = {
                "task_name": t.get("task_name", ""),
                "task_type": t.get("task_type", "vanilla"),
                "result": "success" if t.get("done") else ("cancelled" if t.get("cancel") else "failed"),
                "downloaded_bytes": t.get("actual_downloaded_bytes", 0),
                "total_bytes": t.get("total_bytes", 0),
                "skipped_bytes": t.get("skipped_bytes", 0),
                "error": t.get("error") or "",
                "root_path": t.get("root_path", ""),
                "mc_version": t.get("mc_version", ""),
                "finish_time": int(time.time()),
            }
        _append_history(record)
    except Exception as e:
        write_log("ERROR", f"写下载历史失败: {e}")


@app.get("/api/fabric/install")
def fabric_install(version_name: str, mc_version_id: str, loader_version: str,
                   source: str = "", threads: int = 0, root_id: str = ""):
    """
    给已有版本装 Fabric：
    1. 读原版 version.json（在 versions/<版本名>/<版本名>.json）
    2. 拿 Fabric profile
    3. 合并 JSON
    4. 收集 Fabric 的 libraries 文件
    5. 并发下载
    6. 写回合并后的 JSON
    """
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    if not check_root_valid(target["path"]):
        return {"code": 400, "msg": "目录已失效"}

    if not version_name or not mc_version_id or not loader_version:
        return {"code": 400, "msg": "参数不完整"}

    # 没传就取全局配置
    g = safe_load_json(PATH_GLOBAL_CONFIG)
    if not source:
        source = g.get("download_source", "bmclapi")
    if not threads or threads <= 0:
        threads = g.get("download_threads", 32)
    threads = max(4, min(threads, 256))

    ver_dir = os.path.join(target["path"], "versions", version_name)
    json_path = os.path.join(ver_dir, f"{version_name}.json")
    if not os.path.exists(json_path):
        return {"code": 404, "msg": f"版本 JSON 不存在: {json_path}"}

    # 创建任务
    task_id = create_task(
        task_name=version_name + " (Fabric)",
        task_type="fabric",
        root_path=target["path"],
        mc_version=mc_version_id,
        source=source,
        threads=threads,
    )

    t = threading.Thread(
        target=_fabric_install_task_worker,
        args=(task_id, target["path"], version_name, mc_version_id,
              loader_version, source, threads),
        daemon=True,
    )
    t.start()
    write_log("INFO", f"开始安装 Fabric: {version_name} (MC={mc_version_id}, "
                      f"loader={loader_version}, task_id={task_id})")
    return {"code": 200, "msg": "Fabric 安装已开始", "task_id": task_id}



def _fabric_install_task_worker(task_id, root_path, version_name, mc_version_id,
                                loader_version, source, threads):
    """Fabric 安装（任务版）：状态写进 TASKS[task_id]"""
    try:
        with TASK_LOCKS[task_id]:
            t = TASKS[task_id]
            t["active"] = True
            t["done"] = False
            t["error"] = None
            t["cancel"] = False
            t["total_bytes"] = 0
            t["downloaded_bytes"] = 0
            t["actual_downloaded_bytes"] = 0
            t["skipped_bytes"] = 0
            t["files_total"] = 0
            t["files_done"] = 0
            t["files_skipped"] = 0
            t["files_downloaded"] = 0
            t["current_files"] = ["获取 Fabric profile..."]

        _fabric_install_worker_inner(
            task_id, root_path, version_name, mc_version_id,
            loader_version, source, threads,
        )
        _finalize_task_history(task_id)
    except Exception as e:
        write_log("ERROR", f"Fabric 任务异常: {e}")
        with TASK_LOCKS[task_id]:
            if task_id in TASKS:
                TASKS[task_id]["error"] = str(e)
                TASKS[task_id]["active"] = False
        _finalize_task_history(task_id)


def _fabric_install_worker_inner(task_id, root_path, version_name, mc_version_id,
                                 loader_version, source, threads):
    """Fabric 安装的核心逻辑（任务内调用），状态写 TASKS[task_id]"""
    from fabric import fetch_fabric_profile, merge_fabric_json
    from mojang import download_one_file as _dl_one
    from concurrent.futures import ThreadPoolExecutor, as_completed

    # 更新状态辅助
    def _set(key, val):
        with TASK_LOCKS[task_id]:
            t = TASKS.get(task_id)
            if t is not None:
                t[key] = val

    def _incr(key, delta):
        with TASK_LOCKS[task_id]:
            t = TASKS.get(task_id)
            if t is not None:
                t[key] = t.get(key, 0) + delta

    def _cancelled():
        with TASK_LOCKS[task_id]:
            t = TASKS.get(task_id)
            return t is None or t.get("cancel")

    try:
        ver_dir = os.path.join(root_path, "versions", version_name)
        json_path = os.path.join(ver_dir, f"{version_name}.json")

        # 1. 读原版 json
        with open(json_path, "r", encoding="utf-8") as f:
            vanilla_json = json.load(f)

        # 剥离旧 Fabric layer
        if vanilla_json.get("XGMCL_LOADER") == "fabric":
            write_download_log(f"[Fabric] 检测到已有 Fabric，剥离旧 layer")
            libs = vanilla_json.get("libraries", [])
            vanilla_json["libraries"] = [
                l for l in libs
                if "fabric" not in (l.get("name", "").lower())
            ]
            vanilla_json.pop("XGMCL_LOADER", None)
            vanilla_json.pop("XGMCL_FABRIC_VERSION", None)
            vanilla_json.pop("XGMCL_MC_VERSION", None)
            if "mainClass" not in vanilla_json:
                vanilla_json["mainClass"] = "net.minecraft.client.main.Main"

        # 2. 获取 Fabric profile
        _set("current_files", ["获取 Fabric profile..."])
        write_download_log(f"[Fabric] 获取 profile: MC={mc_version_id}, loader={loader_version}")
        fabric_profile = fetch_fabric_profile(mc_version_id, loader_version)

        # 3. 合并 JSON
        write_download_log("[Fabric] 合并 JSON")
        merged = merge_fabric_json(vanilla_json, fabric_profile, loader_version, mc_version_id)

        # 4. 收集文件
        from mojang import rewrite_url as _rw
        libs_root = os.path.join(root_path, "libraries")
        fabric_files = []
        for lib in fabric_profile.get("libraries", []):
            artifact = lib.get("downloads", {}).get("artifact")
            if not artifact:
                name = lib.get("name", "")
                if not name or ":" not in name:
                    continue
                parts = name.split(":")
                if len(parts) < 3:
                    continue
                group, aname, ver = parts[0], parts[1], parts[2]
                path = f"{group.replace('.', '/')}/{aname}/{ver}/{aname}-{ver}.jar"
                url = f"https://maven.fabricmc.net/{path}"
                fabric_files.append({
                    "url": _rw(url, source),
                    "target": os.path.join(libs_root, path.replace("/", os.sep)),
                    "sha1": "",
                    "size": 0,
                    "important": False,
                })
            else:
                path = artifact.get("path", "")
                url = artifact.get("url", "")
                if not path or not url:
                    continue
                fabric_files.append({
                    "url": _rw(url, source),
                    "target": os.path.join(libs_root, path.replace("/", os.sep)),
                    "sha1": artifact.get("sha1", ""),
                    "size": artifact.get("size", 0),
                    "important": True,
                })

        write_download_log(f"[Fabric] 需下载 {len(fabric_files)} 个 Fabric 库")

        # 5. 统计
        total = sum(f.get("size", 0) for f in fabric_files)
        _set("total_bytes", total)
        _set("files_total", len(fabric_files))
        _set("current_files", [])

        # 6. 速度线程
        import threading as _th
        _th.Thread(target=speed_updater, args=(task_id,), daemon=True).start()

        # 7. 并发下载
        failed_files = []
        with ThreadPoolExecutor(max_workers=threads) as pool:
            futures = {pool.submit(_dl_one, f, source, 5, task_id): f for f in fabric_files}
            for fut in as_completed(futures):
                if _cancelled():
                    break
                f_info = futures[fut]
                try:
                    fut.result()
                except Exception as e:
                    failed_files.append({
                        "path": f_info["target"],
                        "error": str(e)[:200],
                    })
                    _incr("failed_count", 1)
                _incr("files_done", 1)

        # 8. 写回合并 JSON
        if not _cancelled() and not failed_files:
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(merged, f, ensure_ascii=False, indent=2)
            write_download_log(f"[Fabric] 合并 JSON 已写回: {json_path}")

        # 9. 完成 / 取消
        with TASK_LOCKS[task_id]:
            t = TASKS.get(task_id)
            if t is not None:
                if t.get("cancel"):
                    # ★ 取消：删已下载的 Fabric 库 + .part
                    write_download_log(f"[Fabric] 任务被取消，开始清理...")
                    cleaned = 0
                    removed = 0
                    for f in fabric_files:
                        # 删 .part
                        try:
                            temp = f["target"] + ".part"
                            if os.path.exists(temp):
                                os.remove(temp)
                                cleaned += 1
                        except Exception:
                            pass
                        # 删已下的
                        try:
                            if os.path.exists(f["target"]):
                                os.remove(f["target"])
                                removed += 1
                        except Exception:
                            pass
                    write_download_log(f"[Fabric] 清理完成：删了 {cleaned} 个 .part，{removed} 个已下文件")
                    t["active"] = False
                elif failed_files:
                    t["error"] = f"[ERROR] {len(failed_files)} 个 Fabric 库下载失败"
                    t["active"] = False
                else:
                    t["done"] = True
                    t["active"] = False

    except Exception as e:
        with TASK_LOCKS[task_id]:
            t = TASKS.get(task_id)
            if t is not None:
                t["error"] = str(e)
                t["active"] = False
        write_download_log(f"[Fabric] ❌ 失败: {e}")
        write_log("ERROR", f"Fabric 安装失败: {version_name} - {e}")
        
@app.get("/api/fabric/loaders")
def fabric_loaders(mc_version: str):
    """拿指定 MC 版本可用的 Fabric loader，只返回最新 5 个"""
    try:
        loaders = fetch_fabric_loaders(mc_version)
        write_log("INFO", f"获取 Fabric loader 列表: MC={mc_version}, 返回 {len(loaders)} 个")
        return {"code": 200, "loaders": loaders}
    except Exception as e:
        write_log("ERROR", f"获取 Fabric loader 失败: {e}")
        return {"code": 500, "msg": f"获取 Fabric loader 失败: {e}"}


# ====================== API: Mod 管理 ======================
@app.get("/api/version/mods/list")
def version_mods_list(version_name: str, root_id: str = ""):
    """列出该版本的 mods 目录里的文件"""
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    if not check_root_valid(target["path"]):
        return {"code": 400, "msg": "目录已失效"}

    # mods 目录：隔离开启 → <根>/versions/<版本名>/mods/
    #            隔离关闭 → <根>/mods/
    isolated = get_version_isolated(target["path"], version_name)
    if isolated:
        ver_dir = os.path.join(target["path"], "versions", version_name)
        mods_dir = os.path.join(ver_dir, "mods")
    else:
        ver_dir = target["path"]
        mods_dir = os.path.join(target["path"], "mods")

    if not os.path.isdir(ver_dir):
        return {"code": 404, "msg": f"版本目录不存在: {ver_dir}"}

    if not os.path.isdir(mods_dir):
        return {"code": 200, "mods": [], "mods_dir": mods_dir, "exists": False}

    wiki = load_wiki_entries()
    cache = _load_mod_cache(ver_dir)
    new_cache = {}
    mods = []

    try:
        names = os.listdir(mods_dir)
    except Exception as e:
        return {"code": 500, "msg": f"读取 mods 目录失败: {e}"}

    for fn in names:
        if fn.endswith(".jar.disabled"):
            enabled = False
        elif fn.endswith(".jar"):
            enabled = True
        else:
            continue

        full = os.path.join(mods_dir, fn)
        if not os.path.isfile(full):
            continue

        try:
            st = os.stat(full)
        except Exception:
            continue

        cache_key = f"{fn}|{int(st.st_mtime)}|{st.st_size}"

        if cache_key in cache:
            mod_id = cache[cache_key].get("mod_id", "")
            slug   = cache[cache_key].get("slug", "")
            mr_url = cache[cache_key].get("modrinth_url", "")
            title_cn = cache[cache_key].get("title_cn", "")
            # 老缓存没 slug 字段：如果 mod_id 有但 slug 空，重读一次
            if mod_id and not slug:
                meta = _read_jar_meta(full)
                slug   = meta["slug"]
                mr_url = meta["modrinth_url"]
        else:
            meta = _read_jar_meta(full)
            mod_id = meta["mod_id"]
            slug   = meta["slug"]
            mr_url = meta["modrinth_url"]
            title_cn = wiki.get(mod_id.lower(), "") if mod_id else ""

        new_cache[cache_key] = {
            "mod_id": mod_id,
            "slug": slug,
            "modrinth_url": mr_url,
            "title_cn": title_cn,
        }

        mods.append({
            "filename": fn,
            "size": st.st_size,
            "mtime": int(st.st_mtime),
            "enabled": enabled,
            "mod_id": mod_id,
            "slug": slug,
            "modrinth_url": mr_url,
            "title_cn": title_cn,
        })

    _save_mod_cache(ver_dir, new_cache)
    return {"code": 200, "mods": mods, "mods_dir": mods_dir, "exists": True}


@app.get("/api/version/mods/toggle")
def version_mods_toggle(version_name: str, filename: str,
                        enable: int = 1, root_id: str = ""):
    """启用/禁用：.jar ↔ .jar.disabled"""
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    if not check_root_valid(target["path"]):
        return {"code": 400, "msg": "目录已失效"}

    if not filename or ("/" in filename) or ("\\" in filename) or (".." in filename):
        return {"code": 400, "msg": "非法文件名"}

    isolated = get_version_isolated(target["path"], version_name)
    if isolated:
        mods_dir = os.path.join(target["path"], "versions", version_name, "mods")
    else:
        mods_dir = os.path.join(target["path"], "mods")

    src_path = os.path.join(mods_dir, filename)
    if not os.path.isfile(src_path):
        return {"code": 404, "msg": f"文件不存在: {filename}"}

    want_enable = bool(enable)

    try:
        if want_enable:
            # .jar.disabled → .jar
            if filename.endswith(".jar.disabled"):
                new_name = filename[:-len(".disabled")]
                dst_path = os.path.join(mods_dir, new_name)
                if os.path.exists(dst_path):
                    return {"code": 400, "msg": f"目标文件已存在: {new_name}"}
                os.rename(src_path, dst_path)
                write_log("INFO", f"启用 Mod: {filename} → {new_name}")
                return {"code": 200, "msg": "已启用", "filename": new_name}
            elif filename.endswith(".jar"):
                return {"code": 200, "msg": "已经是启用状态", "filename": filename}
            else:
                return {"code": 400, "msg": "不是 .jar / .jar.disabled 文件"}
        else:
            # .jar → .jar.disabled
            if filename.endswith(".jar"):
                new_name = filename + ".disabled"
                dst_path = os.path.join(mods_dir, new_name)
                if os.path.exists(dst_path):
                    return {"code": 400, "msg": f"目标文件已存在: {new_name}"}
                os.rename(src_path, dst_path)
                write_log("INFO", f"禁用 Mod: {filename} → {new_name}")
                return {"code": 200, "msg": "已禁用", "filename": new_name}
            elif filename.endswith(".jar.disabled"):
                return {"code": 200, "msg": "已经是禁用状态", "filename": filename}
            else:
                return {"code": 400, "msg": "不是 .jar / .jar.disabled 文件"}
    except Exception as e:
        write_log("ERROR", f"切换 Mod 状态失败: {filename} - {e}")
        return {"code": 500, "msg": f"操作失败: {e}"}


@app.get("/api/version/mods/delete")
def version_mods_delete(version_name: str, filenames: str = "",
                        root_id: str = ""):
    """批量删除，filenames 逗号分隔"""
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    if not check_root_valid(target["path"]):
        return {"code": 400, "msg": "目录已失效"}

    if not filenames:
        return {"code": 400, "msg": "filenames 为空"}

    isolated = get_version_isolated(target["path"], version_name)
    if isolated:
        mods_dir = os.path.join(target["path"], "versions", version_name, "mods")
    else:
        mods_dir = os.path.join(target["path"], "mods")

    if not os.path.isdir(mods_dir):
        return {"code": 404, "msg": f"mods 目录不存在: {mods_dir}"}

    name_list = [n.strip() for n in filenames.split(",") if n.strip()]
    if not name_list:
        return {"code": 400, "msg": "没有有效的文件名"}

    deleted = []
    failed = []

    for fn in name_list:
        if ("/" in fn) or ("\\" in fn) or (".." in fn):
            failed.append({"filename": fn, "error": "非法文件名"})
            continue
        full = os.path.join(mods_dir, fn)
        if not os.path.isfile(full):
            failed.append({"filename": fn, "error": "文件不存在"})
            continue
        try:
            os.remove(full)
            deleted.append(fn)
        except Exception as e:
            failed.append({"filename": fn, "error": str(e)})

    write_log("INFO", f"删除 Mod: 成功 {len(deleted)} 个，失败 {len(failed)} 个")

    return {
        "code": 200,
        "msg": f"已删除 {len(deleted)} 个文件",
        "deleted": deleted,
        "failed": failed,
    }


@app.get("/api/version/mods/open_folder")
def version_mods_open_folder(version_name: str, root_id: str = ""):
    """打开 mods 目录（不存在就创建）"""
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    if not check_root_valid(target["path"]):
        return {"code": 400, "msg": "目录已失效"}

    isolated = get_version_isolated(target["path"], version_name)
    if isolated:
        mods_dir = os.path.join(target["path"], "versions", version_name, "mods")
    else:
        mods_dir = os.path.join(target["path"], "mods")

    if not os.path.isdir(mods_dir):
        try:
            os.makedirs(mods_dir, exist_ok=True)
        except Exception as e:
            return {"code": 500, "msg": f"创建目录失败: {e}"}

    try:
        os.startfile(mods_dir)
        return {"code": 200, "msg": "已打开", "path": mods_dir}
    except Exception as e:
        return {"code": 500, "msg": f"打开失败: {e}"}


@app.get("/api/version/open_folder")
def version_open_folder(version_name: str, root_id: str = ""):
    """打开版本目录（<根>/versions/<版本名>/）"""
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    if not check_root_valid(target["path"]):
        return {"code": 400, "msg": "目录已失效"}

    ver_dir = os.path.join(target["path"], "versions", version_name)
    if not os.path.isdir(ver_dir):
        return {"code": 404, "msg": f"版本目录不存在: {ver_dir}"}

    try:
        os.startfile(ver_dir)
        return {"code": 200, "msg": "已打开", "path": ver_dir}
    except Exception as e:
        return {"code": 500, "msg": f"打开失败: {e}"}


@app.get("/api/version/mods/read_file")
def version_mods_read_file(version_name: str, filename: str, root_id: str = ""):
    """读 mods 目录下某个文件的二进制内容（给前端算 hash 用）"""
    from fastapi.responses import FileResponse
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    if not check_root_valid(target["path"]):
        return {"code": 400, "msg": "目录已失效"}

    if not filename or ("/" in filename) or ("\\" in filename) or (".." in filename):
        return {"code": 400, "msg": "非法文件名"}

    isolated = get_version_isolated(target["path"], version_name)
    if isolated:
        mods_dir = os.path.join(target["path"], "versions", version_name, "mods")
    else:
        mods_dir = os.path.join(target["path"], "mods")

    full = os.path.join(mods_dir, filename)
    if not os.path.isfile(full):
        return {"code": 404, "msg": f"文件不存在: {filename}"}

    return FileResponse(full, media_type="application/octet-stream")


@app.get("/api/version/mods/import")
def version_mods_import(version_name: str, paths: str = "",
                        overwrite: int = 0, root_id: str = ""):
    """
    拖拽导入 Mod。paths 是逗号分隔的源文件绝对路径。
    - 只接受 .jar / .jar.disabled
    - 重名时：overwrite=1 覆盖，overwrite=0 跳过并在 failed 里返回
    """
    import shutil

    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    if not check_root_valid(target["path"]):
        return {"code": 400, "msg": "目录已失效"}

    if not paths:
        return {"code": 400, "msg": "paths 为空"}

    isolated = get_version_isolated(target["path"], version_name)
    if isolated:
        mods_dir = os.path.join(target["path"], "versions", version_name, "mods")
    else:
        mods_dir = os.path.join(target["path"], "mods")

    try:
        os.makedirs(mods_dir, exist_ok=True)
    except Exception as e:
        return {"code": 500, "msg": f"创建 mods 目录失败: {e}"}

    # 用 | 分隔避免路径里的逗号被误切（前端用 |）
    src_list = [p.strip() for p in paths.split("|") if p.strip()]
    if not src_list:
        return {"code": 400, "msg": "没有有效路径"}

    imported = []
    skipped = []
    failed = []

    for src in src_list:
        # 校验
        if not os.path.isfile(src):
            failed.append({"src": src, "error": "源文件不存在"})
            continue

        fn = os.path.basename(src)
        if not (fn.endswith(".jar") or fn.endswith(".jar.disabled")):
            failed.append({"src": src, "error": "只支持 .jar / .jar.disabled"})
            continue

        dst = os.path.join(mods_dir, fn)

        if os.path.exists(dst):
            if overwrite:
                try:
                    os.remove(dst)
                except Exception as e:
                    failed.append({"src": src, "error": f"删除旧文件失败: {e}"})
                    continue
            else:
                skipped.append(fn)
                continue

        # 同名（同一个源文件）？跳过
        try:
            if os.path.exists(dst) and os.path.samefile(src, dst):
                skipped.append(fn)
                continue
        except Exception:
            pass

        try:
            shutil.copy2(src, dst)
            imported.append(fn)
        except Exception as e:
            failed.append({"src": src, "error": str(e)})

    write_log("INFO", f"导入 Mod: 成功 {len(imported)}，跳过 {len(skipped)}，失败 {len(failed)}")
    return {
        "code": 200,
        "msg": f"导入 {len(imported)} 个",
        "imported": imported,
        "skipped": skipped,
        "failed": failed,
    }


# ====================== API: 一键升级版本 ======================
@app.get("/api/version/upversion/start")
def version_upversion_start(
    source_version: str,
    target_mc: str,
    target_loader: str = "fabric",
    target_name: str = "",
    fabric_loader: str = "",
    copy_mods: int = 1,
    copy_config: int = 1,
    copy_resourcepacks: int = 0,
    copy_shaderpacks: int = 0,
    root_id: str = "",
):
    """
    一键升级：新建目标版本，把源版本的 mod 尽量升级到目标 MC 版本。
    """
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    if not check_root_valid(target["path"]):
        return {"code": 400, "msg": "目录已失效"}

    if not source_version or not target_mc:
        return {"code": 400, "msg": "source_version / target_mc 不能为空"}

    # 源版本必须存在
    src_ver_dir = os.path.join(target["path"], "versions", source_version)
    if not os.path.isdir(src_ver_dir):
        return {"code": 404, "msg": f"源版本不存在: {source_version}"}

    # 目标版本名
    if not target_name:
        target_name = f"{source_version}_--upversionto-{target_mc}"

    # 非法字符检查
    bad_chars = ['<', '>', ':', '"', '/', '\\', '|', '?', '*']
    for c in bad_chars:
        if c in target_name:
            return {"code": 400, "msg": f"目标版本名含非法字符: {c}"}

    # 已存在检查
    if os.path.exists(os.path.join(target["path"], "versions", target_name)):
        return {"code": 400, "msg": f"目标版本名已被占用: {target_name}"}

    # 目标加载器只支持 fabric（先做 Fabric 的）
    target_loader = (target_loader or "fabric").lower()
    if target_loader not in ("fabric",):
        return {"code": 400, "msg": f"暂只支持 Fabric，收到: {target_loader}"}

    # Fabric loader 必填
    if not fabric_loader:
        return {"code": 400, "msg": "请指定 Fabric loader 版本"}

    # 全局配置
    g = safe_load_json(PATH_GLOBAL_CONFIG)
    source = g.get("download_source", "bmclapi")
    threads = max(4, min(g.get("download_threads", 32), 256))

    # 创建任务
    task_id = create_task(
        task_name=f"升级: {source_version} → {target_mc}",
        task_type="upversion",
        root_path=target["path"],
        mc_version=target_mc,
        source=source,
        threads=threads,
    )
    with TASK_LOCKS[task_id]:
        TASKS[task_id]["stage_total"] = 4
        TASKS[task_id]["stage"] = 1
        TASKS[task_id]["source_version"] = source_version
        TASKS[task_id]["target_name"] = target_name
        TASKS[task_id]["target_mc"] = target_mc
        TASKS[task_id]["target_loader"] = target_loader

    copy_options = {
        "copy_mods": bool(copy_mods),
        "copy_config": bool(copy_config),
        "copy_resourcepacks": bool(copy_resourcepacks),
        "copy_shaderpacks": bool(copy_shaderpacks),
    }

    t = threading.Thread(
        target=upversion_task_worker,
        args=(task_id, target["path"], source_version, target_mc,
              target_loader, target_name, fabric_loader,
              source, threads, copy_options),
        daemon=True,
    )
    t.start()

    write_log("INFO", f"开始升级: {source_version} → {target_mc} "
                      f"(目标名={target_name}, loader={fabric_loader}, task_id={task_id})")
    return {
        "code": 200,
        "msg": "升级任务已开始",
        "task_id": task_id,
        "target_name": target_name,
    }


@app.get("/api/version/upversion/result")
def version_upversion_result(task_id: str):
    """拿升级任务的结果。任务跑完后 TASKS[task_id]["upgrade_result"] 才有值。"""
    t = get_task(task_id)
    if t is None:
        return {"code": 404, "msg": "任务不存在"}
    result = t.get("upgrade_result")
    return {
        "code": 200,
        "done": bool(t.get("done")),
        "active": bool(t.get("active")),
        "error": t.get("error"),
        "result": result,
    }


# ====================== API: 版本详情 ======================
@app.get("/api/version/detail")
def version_detail(version_name: str, root_id: str = ""):
    """返回单个版本的详细信息（用于详情页）"""
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    if not check_root_valid(target["path"]):
        return {"code": 400, "msg": "目录已失效"}

    ver_dir = os.path.join(target["path"], "versions", version_name)
    if not os.path.isdir(ver_dir):
        return {"code": 404, "msg": f"版本不存在: {version_name}"}

    info = parse_version_info(version_name, ver_dir)

    # 读版本 json 拿更详细的字段
    json_path = os.path.join(ver_dir, f"{version_name}.json")
    detail = {
        "full_name": info["full_name"],
        "show_name": info["show_name"],
        "game_version": info["game_version"],
        "loader_type": info["loader_type"],
        "version_dir": ver_dir,
        "json_path": json_path,
        "jar_exists": os.path.exists(os.path.join(ver_dir, f"{version_name}.jar")),
        "json_exists": os.path.exists(json_path),
        "isolated": get_version_isolated(target["path"], version_name),
        "game_dir": get_version_game_dir(target["path"], version_name),
        "mc_version_id": "", # 原版 MC 版本号（用于查 Fabric loader）
    }

    if os.path.exists(json_path):
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                vj = json.load(f)
            detail["mc_version_id"] = (
                vj.get("clientVersion")
                or vj.get("inheritsFrom")
                or info["game_version"]
            )
            detail["main_class"] = vj.get("mainClass", "")
            detail["asset_index"] = vj.get("assetIndex", {}).get("id", "")
        except Exception as e:
            write_log("WARN", f"读取版本 json 失败: {json_path} - {e}")

    # 是否已有专属配置
    key = version_cfg_key(target["path"], version_name)
    all_cfg = safe_load_json(PATH_VERSION_CFG)
    detail["has_custom_config"] = key in all_cfg

    return {"code": 200, "data": detail, "root": target}


# ====================== API: 版本重命名 ======================
@app.get("/api/version/rename")
def version_rename(version_name: str, new_name: str, root_id: str = ""):
    """
    重命名版本，全改：
    - 文件夹名
    - <name>.json
    - <name>.jar
    - <name>-natives
    - versioncsetting.json 里的 key
    """
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    if not check_root_valid(target["path"]):
        return {"code": 400, "msg": "目录已失效"}

    old_name = version_name.strip()
    new_name = new_name.strip()

    if not new_name:
        return {"code": 400, "msg": "新名字不能为空"}
    if old_name == new_name:
        return {"code": 400, "msg": "新名字跟旧名字一样"}

    # 非法字符检查（Windows 文件系统）
    bad_chars = ['<', '>', ':', '"', '/', '\\', '|', '?', '*']
    for c in bad_chars:
        if c in new_name:
            return {"code": 400, "msg": f"新名字含有非法字符: {c}"}

    versions_root = os.path.join(target["path"], "versions")
    old_dir = os.path.join(versions_root, old_name)
    new_dir = os.path.join(versions_root, new_name)

    if not os.path.isdir(old_dir):
        return {"code": 404, "msg": f"旧版本不存在: {old_name}"}
    if os.path.exists(new_dir):
        return {"code": 400, "msg": f"新名字已被占用: {new_name}"}

    # 游戏运行中不允许重命名
    last = safe_load_json(PATH_LAST_LAUNCH)
    if last.get("version_name") == old_name and last.get("root_id") == target["id"]:
        pid = last.get("pid", 0)
        if pid:
            try:
                import psutil
                p = psutil.Process(pid)
                if p.is_running() and p.status() != psutil.STATUS_ZOMBIE:
                    return {"code": 400, "msg": "游戏正在运行，请关闭游戏后重试"}
            except Exception:
                pass

    renamed_items = []

    try:
        # 1. 文件夹本身
        os.rename(old_dir, new_dir)
        renamed_items.append(f"目录: {old_name}/ → {new_name}/")

        # 2. 里面跟着改名字的文件
        targets = [
            (f"{old_name}.json",     f"{new_name}.json"),
            (f"{old_name}.jar",      f"{new_name}.jar"),
            (f"{old_name}-natives",  f"{new_name}-natives"),
        ]
        for old_item, new_item in targets:
            old_path = os.path.join(new_dir, old_item)
            new_path = os.path.join(new_dir, new_item)
            if os.path.exists(old_path):
                os.rename(old_path, new_path)
                renamed_items.append(f"{old_item} → {new_item}")

        # 3. config key 迁移
        all_cfg = safe_load_json(PATH_VERSION_CFG)
        old_key = version_cfg_key(target["path"], old_name)
        new_key = version_cfg_key(target["path"], new_name)
        cfg_moved = False
        if old_key in all_cfg:
            all_cfg[new_key] = all_cfg.pop(old_key)
            safe_save_json(PATH_VERSION_CFG, all_cfg)
            cfg_moved = True

        # 4. 如果这个版本是上次启动的，更新记录
        if last.get("version_name") == old_name and last.get("root_id") == target["id"]:
            last["version_name"] = new_name
            safe_save_json(PATH_LAST_LAUNCH, last)

        # 5. 清掉 launcher 的 classpath 缓存（因为路径变了）
        cp_cache = os.path.join(new_dir, ".xgmcl_cp_cache")
        if os.path.exists(cp_cache):
            try:
                os.remove(cp_cache)
                renamed_items.append("清空 classpath 缓存")
            except Exception:
                pass

        write_log("INFO", f"重命名版本: {old_name} → {new_name}, 改动 {len(renamed_items)} 项")
        for item in renamed_items:
            write_log("INFO", f"  - {item}")

        return {
            "code": 200,
            "msg": "重命名成功",
            "old_name": old_name,
            "new_name": new_name,
            "changes": renamed_items,
            "config_moved": cfg_moved,
        }

    except Exception as e:
        write_log("ERROR", f"重命名版本失败: {old_name} → {new_name} - {e}")
        # 尝试回滚（如果目录已经改了，改回去）
        try:
            if os.path.isdir(new_dir) and not os.path.isdir(old_dir):
                os.rename(new_dir, old_dir)
        except Exception:
            pass
        return {"code": 500, "msg": f"重命名失败: {e}"}


# ====================== API: 版本隔离 ======================
@app.get("/api/version/isolate/toggle")
def version_isolate_toggle(version_name: str, enable: int = 1, root_id: str = ""):
    """
    单个版本的隔离开关（覆盖全局默认）。
    切换时只改配置，不搬文件。
    - 开 → 存档/Mod/配置读写 <版本>/.minecraft/
    - 关 → 读写 <根>/
    """
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    if not check_root_valid(target["path"]):
        return {"code": 400, "msg": "目录已失效"}

    ver_dir = os.path.join(target["path"], "versions", version_name)
    if not os.path.isdir(ver_dir):
        return {"code": 404, "msg": f"版本不存在: {version_name}"}

    # 游戏运行中不允许切换
    last = safe_load_json(PATH_LAST_LAUNCH)
    if last.get("version_name") == version_name and last.get("root_id") == target["id"]:
        pid = last.get("pid", 0)
        if pid:
            try:
                import psutil
                p = psutil.Process(pid)
                if p.is_running() and p.status() != psutil.STATUS_ZOMBIE:
                    return {"code": 400, "msg": "游戏正在运行，请关闭游戏后重试"}
            except Exception:
                pass

    want_iso = bool(enable)

    key = version_cfg_key(target["path"], version_name)
    all_cfg = safe_load_json(PATH_VERSION_CFG)
    cfg = all_cfg.get(key, {})
    old_iso = get_version_isolated(target["path"], version_name)

    cfg["isolated"] = want_iso
    all_cfg[key] = cfg
    safe_save_json(PATH_VERSION_CFG, all_cfg)

    # 开启隔离时预建目录（PCL 结构：直接在版本目录下）
    if want_iso:
        for sub in ["saves", "mods", "config", "resourcepacks", "shaderpacks"]:
            try:
                os.makedirs(os.path.join(ver_dir, sub), exist_ok=True)
            except Exception as e:
                write_log("WARN", f"创建隔离目录失败 {sub}: {e}")

    # 清 classpath 缓存（路径可能变）
    cp_cache = os.path.join(ver_dir, ".xgmcl_cp_cache")
    if os.path.exists(cp_cache):
        try:
            os.remove(cp_cache)
        except Exception:
            pass

    game_dir = get_version_game_dir(target["path"], version_name, want_iso)
    write_log("INFO", f"版本隔离: {version_name} {'开启' if want_iso else '关闭'}（{old_iso} → {want_iso}），gameDir={game_dir}")
    return {
        "code": 200,
        "msg": "已开启版本隔离" if want_iso else "已关闭版本隔离",
        "isolated": want_iso,
        "game_dir": game_dir,
    }

# ====================== API: 删除版本 ======================
@app.get("/api/version/delete")
def version_delete(version_name: str, root_id: str = ""):
    """
    删除一个版本：
    - <根>/versions/<版本名>/ 整个目录（含 json/jar/natives/隔离的 .minecraft）
    - versioncsetting.json 里该版本的配置
    """
    import shutil

    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    if not check_root_valid(target["path"]):
        return {"code": 400, "msg": "目录已失效"}

    version_name = version_name.strip()
    if not version_name:
        return {"code": 400, "msg": "版本名不能为空"}

    ver_dir = os.path.join(target["path"], "versions", version_name)
    if not os.path.isdir(ver_dir):
        return {"code": 404, "msg": f"版本不存在: {version_name}"}

    # 游戏运行中不允许删除
    last = safe_load_json(PATH_LAST_LAUNCH)
    if last.get("version_name") == version_name and last.get("root_id") == target["id"]:
        pid = last.get("pid", 0)
        if pid:
            try:
                import psutil
                p = psutil.Process(pid)
                if p.is_running() and p.status() != psutil.STATUS_ZOMBIE:
                    return {"code": 400, "msg": "游戏正在运行，请先关闭游戏"}
            except Exception:
                pass

    # 统计大小（删除前算，删了就没了）
    def dir_size(path):
        total = 0
        try:
            for dirpath, _, filenames in os.walk(path):
                for f in filenames:
                    fp = os.path.join(dirpath, f)
                    try:
                        total += os.path.getsize(fp)
                    except Exception:
                        pass
        except Exception:
            pass
        return total

    size = dir_size(ver_dir)

    try:
        shutil.rmtree(ver_dir, ignore_errors=False)
    except Exception as e:
        write_log("ERROR", f"删除版本目录失败 {ver_dir}: {e}")
        return {"code": 500, "msg": f"删除失败: {e}"}

    # 清版本专属配置
    key = version_cfg_key(target["path"], version_name)
    all_cfg = safe_load_json(PATH_VERSION_CFG)
    if key in all_cfg:
        del all_cfg[key]
        safe_save_json(PATH_VERSION_CFG, all_cfg)

    # 如果这个版本是"上次启动"的，清掉记录
    if last.get("version_name") == version_name and last.get("root_id") == target["id"]:
        safe_save_json(PATH_LAST_LAUNCH, {})

    write_log("INFO", f"删除版本: {version_name}（释放 {format_size(size)}）")
    return {
        "code": 200,
        "msg": "版本已删除",
        "freed_bytes": size,
    }


# ====================== API: 服务端（直接开服） ======================
def load_server_cfg():
    cfg = safe_load_json(PATH_SERVER_CFG)
    cfg.setdefault("java_path", "")
    cfg.setdefault("ram_mb", 3072)
    cfg.setdefault("jvm_args", "")
    cfg.setdefault("last_dir", "")
    return cfg


@app.get("/api/server/config/get")
def server_config_get():
    return {"code": 200, "data": load_server_cfg()}


@app.get("/api/server/config/save")
def server_config_save(java_path: str = "__keep__",
                       ram_mb: int = -1,
                       jvm_args: str = "__keep__",
                       last_dir: str = "__keep__"):
    cfg = load_server_cfg()
    if java_path != "__keep__":
        cfg["java_path"] = java_path or ""
    if ram_mb >= 0:
        cfg["ram_mb"] = max(512, min(65536, ram_mb))
    if jvm_args != "__keep__":
        cfg["jvm_args"] = jvm_args
    if last_dir != "__keep__":
        cfg["last_dir"] = last_dir or ""
    safe_save_json(PATH_SERVER_CFG, cfg)
    write_log("INFO", f"保存服务端配置: RAM={cfg['ram_mb']}MB, Java={cfg['java_path'] or '(默认)'}")
    return {"code": 200, "msg": "已保存", "data": cfg}


@app.get("/api/server/browse_dir")
def server_browse_dir():
    """弹目录选择框"""
    path = select_server_dir()
    if not path:
        return {"code": 400, "msg": "未选择目录"}
    return {"code": 200, "path": path}


@app.get("/api/server/detect")
def server_detect(dir: str):
    """检查目录是否是合法的服务端目录"""
    if not dir or not os.path.isdir(dir):
        return {"code": 400, "msg": "目录不存在"}
    info = detect_server(dir)
    return {"code": 200, "data": info}


@app.get("/api/server/properties/get")
def server_properties_get(dir: str):
    if not dir or not os.path.isdir(dir):
        return {"code": 400, "msg": "目录不存在"}
    props = read_properties(dir)
    return {"code": 200, "data": props}


@app.get("/api/server/properties/save")
def server_properties_save(dir: str, data: str = "{}"):
    """
    data 是 JSON 字符串，包含要改的字段。
    只改已有字段，不新增。
    """
    if not dir or not os.path.isdir(dir):
        return {"code": 400, "msg": "目录不存在"}
    try:
        parsed = json.loads(data) if data else {}
    except Exception as e:
        return {"code": 400, "msg": f"data 不是合法 JSON: {e}"}
    if not isinstance(parsed, dict):
        return {"code": 400, "msg": "data 必须是 JSON 对象"}
    changed = save_properties(dir, parsed)
    return {"code": 200, "msg": f"已保存 {changed} 个字段", "changed": changed}


@app.get("/api/server/whitelist/get")
def server_whitelist_get(dir: str):
    if not dir or not os.path.isdir(dir):
        return {"code": 400, "msg": "目录不存在"}
    return {"code": 200, "data": read_whitelist(dir)}


@app.get("/api/server/whitelist/save")
def server_whitelist_save(dir: str, data: str = "[]"):
    if not dir or not os.path.isdir(dir):
        return {"code": 400, "msg": "目录不存在"}
    try:
        arr = json.loads(data) if data else []
    except Exception as e:
        return {"code": 400, "msg": f"data 不是合法 JSON: {e}"}
    if not isinstance(arr, list):
        return {"code": 400, "msg": "data 必须是 JSON 数组"}
    save_whitelist(dir, arr)
    return {"code": 200, "msg": f"已保存 {len(arr)} 条"}


@app.get("/api/server/ops/get")
def server_ops_get(dir: str):
    if not dir or not os.path.isdir(dir):
        return {"code": 400, "msg": "目录不存在"}
    return {"code": 200, "data": read_ops(dir)}


@app.get("/api/server/ops/save")
def server_ops_save(dir: str, data: str = "[]"):
    if not dir or not os.path.isdir(dir):
        return {"code": 400, "msg": "目录不存在"}
    try:
        arr = json.loads(data) if data else []
    except Exception as e:
        return {"code": 400, "msg": f"data 不是合法 JSON: {e}"}
    if not isinstance(arr, list):
        return {"code": 400, "msg": "data 必须是 JSON 数组"}
    save_ops(dir, arr)
    return {"code": 200, "msg": f"已保存 {len(arr)} 条"}


@app.get("/api/server/start")
def server_start(dir: str, jar: str = "", ram_mb: int = -1,
                 jvm_args: str = "__keep__", java_path: str = "__keep__"):
    """
    启动服务端。
    - jar 为空 → 自动选 preferred_jar
    - ram_mb / jvm_args / java_path 不传 → 从 server.json 读
    """
    if not dir or not os.path.isdir(dir):
        return {"code": 400, "msg": "目录不存在"}

    info = detect_server(dir)
    if not info["valid"]:
        return {"code": 400, "msg": "不是合法的服务端目录（缺 server.properties 或 jar）"}

    # 决定用哪个 jar
    if not jar:
        jar = info["preferred_jar"]
    if not jar or not os.path.exists(jar):
        return {"code": 400, "msg": f"jar 不存在: {jar}"}

    cfg = load_server_cfg()

    if ram_mb < 0:
        ram_mb = cfg.get("ram_mb", 3072)
    if jvm_args == "__keep__":
        jvm_args = cfg.get("jvm_args", "")
    if java_path == "__keep__":
        java_path = cfg.get("java_path", "")
        # server.json 里没设 → 回退全局设置的 Java
        if not java_path:
            g = safe_load_json(PATH_GLOBAL_CONFIG)
            java_path = g.get("global_java_path", "")

    # 记 last_dir
    cfg["last_dir"] = dir
    safe_save_json(PATH_SERVER_CFG, cfg)

    return start_server(
        server_dir=dir,
        jar_path=jar,
        ram_mb=ram_mb,
        jvm_args=jvm_args,
        java_path=java_path,
    )


@app.get("/api/server/stop")
def server_stop():
    return stop_server()


@app.get("/api/server/status")
def server_status():
    """返回服务端运行状态"""
    running = is_running()
    with __import__("server").SERVER_LOCK:
        st = dict(__import__("server").SERVER_STATE)
    return {"code": 200, "running": running, "data": st}


@app.get("/api/server/console/tail")
def server_console_tail(dir: str, offset: int = 0):
    """
    读服务端日志从 offset 开始的新增内容。
    - 服务端在跑 → 传 offset，只读新增
    - 不在跑 → 传 offset=0 读全部
    """
    if not dir:
        return {"code": 400, "msg": "dir 为空"}

    running = is_running()
    if not running and offset == 0:
        # 没跑，读全量
        lines, next_off = read_console_from_start(dir)
        return {"code": 200, "lines": lines, "next_offset": next_off,
                "exists": next_off > 0, "running": False}

    lines, next_off, exists = tail_console(dir, offset)
    return {"code": 200, "lines": lines, "next_offset": next_off,
            "exists": exists, "running": running}


@app.get("/api/server/console/command")
def server_console_command(cmd: str):
    """往服务端 stdin 写一行命令"""
    if not cmd:
        return {"code": 400, "msg": "命令为空"}
    return send_command(cmd)


# ====================== API: XG-Boot 配置 ======================
PATH_BOOT_CONFIG = os.path.join(SETTING_ROOT, "boot.json")


def load_boot_config():
    cfg = safe_load_json(PATH_BOOT_CONFIG)
    return {"skip_verify": bool(cfg.get("skip_verify", False))}


@app.get("/api/boot/config/get")
def boot_config_get():
    return {"code": 200, "data": load_boot_config()}


@app.get("/api/boot/config/save")
def boot_config_save(skip_verify: int = 0):
    cfg = {"skip_verify": bool(skip_verify)}
    safe_save_json(PATH_BOOT_CONFIG, cfg)
    write_log("INFO", f"保存 XG-Boot 配置: skip_verify={cfg['skip_verify']}")
    return {"code": 200, "msg": "已保存", "data": cfg}

# ====================== Modrinth 工具 ======================
MODRINTH_API = "https://api.modrinth.com/v2"
MODRINTH_UA = "XGstudio-XGMCL/2.0 (contact: xgstudio)"


# ====================== Wiki 中文名映射 ======================
_WIKI_ENTRIES = None


def load_wiki_entries():
    """
    加载 wiki_entries.json（slug → 中文名）。
    全局缓存，第一次调用读文件，之后不再读。
    文件不存在 / 解析失败 → 返回空 dict（不崩）。
    """
    global _WIKI_ENTRIES
    if _WIKI_ENTRIES is not None:
        return _WIKI_ENTRIES

    path = os.path.join(BASE, "wiki_entries.json")
    if not os.path.exists(path):
        write_log("WARN", f"wiki_entries.json 不存在: {path}")
        _WIKI_ENTRIES = {}
        return _WIKI_ENTRIES

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            write_log("WARN", f"wiki_entries.json 不是 JSON 对象，忽略")
            _WIKI_ENTRIES = {}
            return _WIKI_ENTRIES
        _WIKI_ENTRIES = data
        write_log("INFO", f"加载 wiki_entries.json: {len(_WIKI_ENTRIES)} 条")
    except Exception as e:
        write_log("ERROR", f"加载 wiki_entries.json 失败: {e}")
        _WIKI_ENTRIES = {}

    return _WIKI_ENTRIES


# ====================== Mod 管理：jar 元数据 + 缓存 ======================
def _read_jar_meta(jar_path):
    """
    从 jar 里读 mod 元数据。
    返回 {"mod_id": "", "slug": "", "modrinth_url": ""}
    slug 从 contact / displayURL 里抽 modrinth.com/mod/<slug>
    """
    import re as _re
    result = {"mod_id": "", "slug": "", "modrinth_url": ""}

    def _extract_slug(*urls):
        for u in urls:
            if not u or not isinstance(u, str):
                continue
            m = _re.search(r"modrinth\.com/mod/([A-Za-z0-9_\-]+)", u)
            if m:
                return m.group(1)
        return ""

    try:
        with zipfile.ZipFile(jar_path, "r") as zf:
            names = zf.namelist()

            # Fabric
            if "fabric.mod.json" in names:
                try:
                    with zf.open("fabric.mod.json") as f:
                        d = json.load(f)
                        if isinstance(d, dict):
                            result["mod_id"] = (d.get("id") or "").strip()
                            contact = d.get("contact") or {}
                            slug = _extract_slug(
                                contact.get("sources"),
                                contact.get("homepage"),
                                contact.get("issues"),
                            )
                            if slug:
                                result["slug"] = slug
                                result["modrinth_url"] = f"https://modrinth.com/mod/{slug}"
                                return result
                except Exception:
                    pass

            # Quilt
            if "quilt.mod.json" in names:
                try:
                    with zf.open("quilt.mod.json") as f:
                        d = json.load(f)
                        if isinstance(d, dict):
                            ql = d.get("quilt_loader", {}) or {}
                            result["mod_id"] = (ql.get("id") or "").strip()
                            meta = ql.get("metadata") or {}
                            slug = _extract_slug(meta.get("homepage"))
                            if slug:
                                result["slug"] = slug
                                result["modrinth_url"] = f"https://modrinth.com/mod/{slug}"
                                return result
                except Exception:
                    pass

            # Forge / NeoForge 1.13+
            if "META-INF/mods.toml" in names:
                try:
                    with zf.open("META-INF/mods.toml") as f:
                        text = f.read().decode("utf-8", errors="ignore")
                    m = _re.search(r'modId\s*=\s*"([^"]+)"', text)
                    if m:
                        result["mod_id"] = m.group(1).strip()
                    u = _re.search(r'displayURL\s*=\s*"([^"]+)"', text)
                    if u:
                        slug = _extract_slug(u.group(1))
                        if slug:
                            result["slug"] = slug
                            result["modrinth_url"] = f"https://modrinth.com/mod/{slug}"
                            return result
                except Exception:
                    pass

            # 老 Forge
            if "mcmod.info" in names:
                try:
                    with zf.open("mcmod.info") as f:
                        d = json.load(f)
                        if isinstance(d, list) and d:
                            result["mod_id"] = (d[0].get("modid") or "").strip()
                            slug = _extract_slug(d[0].get("url"))
                            if slug:
                                result["slug"] = slug
                                result["modrinth_url"] = f"https://modrinth.com/mod/{slug}"
                                return result
                        elif isinstance(d, dict):
                            result["mod_id"] = (d.get("modid") or "").strip()
                except Exception:
                    pass

    except Exception as e:
        write_log("WARN", f"读 jar 元数据失败 {jar_path}: {e}")

    return result


def _load_mod_cache(ver_dir):
    """读 <版本目录>/.xgmcl_mod_cache.json"""
    p = os.path.join(ver_dir, ".xgmcl_mod_cache.json")
    if not os.path.exists(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _save_mod_cache(ver_dir, cache):
    """写 <版本目录>/.xgmcl_mod_cache.json"""
    try:
        p = os.path.join(ver_dir, ".xgmcl_mod_cache.json")
        os.makedirs(ver_dir, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
    except Exception as e:
        write_log("WARN", f"写 mod 缓存失败 {ver_dir}: {e}")


# ====================== Modrinth OAuth 配置 ======================
MODRINTH_CLIENT_ID = "MODRINTH_CLIENT_ID"
MODRINTH_CLIENT_SECRET = "MODRINTH_CLIENT_SECRET = "

MODRINTH_REDIRECT_URI = "http://127.0.0.1:8000/api/modrinth/oauth/callback"

MODRINTH_OAUTH_AUTHORIZE = "https://modrinth.com/auth/authorize"
MODRINTH_OAUTH_TOKEN     = "https://api.modrinth.com/_internal/oauth/token"

MODRINTH_SCOPES = [
    "USER_READ",
    "PROJECT_READ", "PROJECT_CREATE", "PROJECT_WRITE",
    "VERSION_READ", "VERSION_CREATE",
    "COLLECTION_READ", "COLLECTION_CREATE", "COLLECTION_WRITE",
]

MODRINTH_OAUTH_STATE = {
    "active": False,
    "state": "",
    "access_token": "",
    "refresh_token": "",
    "expires_at": 0,
    "user": None,
}
MODRINTH_OAUTH_LOCK = threading.Lock()

PATH_MODRINTH_OAUTH = os.path.join(SETTING_ROOT, "modrinth_oauth.json")


def modrinth_oauth_save():
    """把 OAuth token 存盘"""
    with MODRINTH_OAUTH_LOCK:
        data = {
            "access_token": MODRINTH_OAUTH_STATE["access_token"],
            "refresh_token": MODRINTH_OAUTH_STATE["refresh_token"],
            "expires_at": MODRINTH_OAUTH_STATE["expires_at"],
            "user": MODRINTH_OAUTH_STATE["user"],
        }
    safe_save_json(PATH_MODRINTH_OAUTH, data)


def modrinth_oauth_load():
    """从磁盘恢复 OAuth token"""
    data = safe_load_json(PATH_MODRINTH_OAUTH)
    if not data or not data.get("access_token"):
        return False
    with MODRINTH_OAUTH_LOCK:
        MODRINTH_OAUTH_STATE["access_token"] = data.get("access_token", "")
        MODRINTH_OAUTH_STATE["refresh_token"] = data.get("refresh_token", "")
        MODRINTH_OAUTH_STATE["expires_at"] = data.get("expires_at", 0)
        MODRINTH_OAUTH_STATE["user"] = data.get("user")
    return True


def modrinth_oauth_clear():
    """清空 OAuth 状态 + 删文件"""
    with MODRINTH_OAUTH_LOCK:
        MODRINTH_OAUTH_STATE.update({
            "active": False,
            "state": "",
            "access_token": "",
            "refresh_token": "",
            "expires_at": 0,
            "user": None,
        })
    try:
        if os.path.exists(PATH_MODRINTH_OAUTH):
            os.remove(PATH_MODRINTH_OAUTH)
    except Exception:
        pass


def _modrinth_headers():
    return {
        "User-Agent": MODRINTH_UA,
        "Accept": "application/json",
    }


def modrinth_search(query: str, limit: int = 20, offset: int = 0,
                    game_version: str = "", loader: str = "",
                    index: str = "relevance"):
    """
    搜 Modrinth 项目。
    只搜 Mod（project_type:mod），排除整合包/资源包/光影/数据包。
    facets 规则：数组内 OR，数组间 AND。
    index 排序：relevance / downloads / follows / newest / updated
    """
    # 白名单校验，防止传非法值
    if index not in ("relevance", "downloads", "follows", "newest", "updated"):
        index = "relevance"

    facets = [["project_type:mod"]]
    if game_version:
        facets.append([f"versions:{game_version}"])
    if loader:
        facets.append([f"categories:{loader}"])
    params = {
        "query": query,
        "limit": limit,
        "offset": offset,
        "index": index,
        "facets": json.dumps(facets),
    }
    r = requests.get(f"{MODRINTH_API}/search", params=params,
                     headers=_modrinth_headers(), timeout=20)
    r.raise_for_status()
    return r.json()


def modrinth_project_versions(project_id: str,
                              game_version: str = "",
                              loader: str = ""):
    """
    拉一个项目的所有版本（可按 MC 版本 / loader 筛）。
    返回原始数组（不瘦身，因为 find_fabric_api_version 也要用）。
    """
    params = {}
    if game_version:
        params["game_versions"] = json.dumps([game_version])
    if loader:
        params["loaders"] = json.dumps([loader])
    r = requests.get(f"{MODRINTH_API}/project/{project_id}/version",
                     params=params, headers=_modrinth_headers(), timeout=20)
    r.raise_for_status()
    return r.json()


def _pick_primary_file(files):
    """从 version.files 里挑 primary 文件，没 primary 就取第一个"""
    if not files:
        return None
    for f in files:
        if f.get("primary"):
            return f
    return files[0]


def find_fabric_api_version(mc_version: str):
    """
    找 Fabric API 匹配 mc_version 的最新版本。
    返回 {"url": ..., "filename": ..., "version": ...} 或 None。
    """
    try:
        # Fabric API 的 Modrinth project id 是 "fabric-api"
        versions = modrinth_project_versions("fabric-api",
                                              game_version=mc_version,
                                              loader="fabric")
        if not versions:
            return None
        # versions 已按发布日期倒序，取第一个有文件的
        for v in versions:
            files = v.get("files", [])
            if not files:
                continue
            primary = next((f for f in files if f.get("primary")), files[0])
            return {
                "url": primary.get("url", ""),
                "filename": primary.get("filename", ""),
                "version": v.get("version_number", ""),
                "size": primary.get("size", 0),
                "sha1": (primary.get("hashes", {}) or {}).get("sha1", ""),
            }
        return None
    except Exception as e:
        write_log("ERROR", f"查 Fabric API 版本失败: {e}")
        return None


# ====================== API: 下载任务 ======================
@app.get("/api/download/tasks")
def download_tasks():
    """列出所有任务（含历史）"""
    with TASKS_LOCK:
        tasks = [dict(t) for t in TASKS.values()]
    # 按 start_time 倒序
    tasks.sort(key=lambda x: x.get("start_time", 0), reverse=True)
    return {"code": 200, "tasks": tasks}


@app.get("/api/download/task")
def download_task(task_id: str):
    t = get_task(task_id)
    if t is None:
        return {"code": 404, "msg": "任务不存在"}
    return {"code": 200, "task": dict(t)}


@app.get("/api/download/cancel")
def download_cancel(task_id: str):
    cancel_download(task_id)
    write_log("INFO", f"取消下载任务: {task_id}")
    return {"code": 200, "msg": "已发送取消信号"}


@app.get("/api/download/remove")
def download_remove(task_id: str):
    """从任务列表移除（不取消，只移除已完成/失败/取消的）"""
    t = get_task(task_id)
    if t is None:
        return {"code": 404, "msg": "任务不存在"}
    if t.get("active"):
        return {"code": 400, "msg": "任务还在进行中，先取消"}
    remove_task(task_id)
    return {"code": 200, "msg": "已移除"}


@app.get("/api/download/active_count")
def download_active_count():
    with TASKS_LOCK:
        n = sum(1 for t in TASKS.values() if t.get("active"))
    return {"code": 200, "count": n}


# ====================== API: Modrinth 搜索 ======================
def _slim_search_hit(h):
    """搜索结果瘦身：只保留前端要用的字段"""
    return {
        "project_id":   h.get("project_id", ""),
        "slug":         h.get("slug", ""),
        "title":        h.get("title", ""),
        "description":  h.get("description", ""),
        "icon_url":     h.get("icon_url", ""),
        "downloads":    h.get("downloads", 0),
        "follows":      h.get("follows", 0),
        "author":       h.get("author", ""),
        "categories":   h.get("categories", []),
        "versions":     h.get("versions", []),
        "project_type": h.get("project_type", ""),
        "date_modified": h.get("date_modified", ""),
    }


@app.get("/api/modrinth/search")
def modrinth_search_api(query: str, limit: int = 20, offset: int = 0,
                        game_version: str = "", loader: str = "",
                        index: str = "relevance"):
    try:
        d = modrinth_search(query, limit, offset, game_version, loader, index)
        wiki = load_wiki_entries()
        hits = []
        for h in d.get("hits", []):
            slug = (h.get("slug") or "").lower()
            cn = wiki.get(slug, "")
            hit = _slim_search_hit(h)
            hit["title_cn"] = cn
            hits.append(hit)
        return {
            "code": 200,
            "hits": hits,
            "total_hits": d.get("total_hits", 0),
            "offset": d.get("offset", offset),
            "limit": d.get("limit", limit),
            "index": index,
        }
    except Exception as e:
        write_log("ERROR", f"Modrinth 搜索失败: {e}")
        return {"code": 500, "msg": str(e)}


@app.get("/api/modrinth/project")
def modrinth_project_api(project_id: str):
    try:
        r = requests.get(f"{MODRINTH_API}/project/{project_id}",
                         headers=_modrinth_headers(), timeout=20)
        r.raise_for_status()
        d = r.json()
        return {
            "code": 200,
            "data": {
                "project_id":   d.get("id", ""),
                "slug":         d.get("slug", ""),
                "title":        d.get("title", ""),
                "description":  d.get("description", ""),
                "body":         d.get("body", ""),
                "icon_url":     d.get("icon_url", ""),
                "downloads":    d.get("downloads", 0),
                "follows":      d.get("follows", 0),
                "categories":   d.get("categories", []),
                "loaders":      d.get("loaders", []),
                "game_versions": d.get("game_versions", []),
                "versions":     d.get("versions", []),
                "project_type": d.get("project_type", ""),
                "date_modified": d.get("updated", ""),
            },
        }
    except Exception as e:
        write_log("ERROR", f"Modrinth 项目查询失败: {e}")
        return {"code": 500, "msg": str(e)}


@app.get("/api/modrinth/versions")
def modrinth_versions_api(project_id: str,
                          game_version: str = "", loader: str = ""):
    """拿某项目的版本列表（详情页用）"""
    try:
        versions = modrinth_project_versions(project_id, game_version, loader)
        out = []
        for v in versions:
            f = _pick_primary_file(v.get("files", []))
            if not f:
                continue
            out.append({
                "version_id":   v.get("id", ""),
                "name":         v.get("name", ""),
                "version_number": v.get("version_number", ""),
                "game_versions": v.get("game_versions", []),
                "loaders":      v.get("loaders", []),
                "date_published": v.get("date_published", ""),
                "downloads":    v.get("downloads", 0),
                "file": {
                    "filename": f.get("filename", ""),
                    "url":      f.get("url", ""),
                    "size":     f.get("size", 0),
                    "sha1":     (f.get("hashes", {}) or {}).get("sha1", ""),
                },
                "dependencies": v.get("dependencies", []),
            })
        return {"code": 200, "versions": out}
    except Exception as e:
        write_log("ERROR", f"Modrinth 版本列表失败: {e}")
        return {"code": 500, "msg": str(e)}


@app.get("/api/modrinth/install")
def modrinth_install_api(url: str, filename: str = "", sha1: str = "",
                         size: int = 0, project_id: str = ""):
    """
    下载 Modrinth 的 jar。
    流程：同步弹保存框 → 拿到路径 → 起异步任务下载。
    """
    if not url:
        return {"code": 400, "msg": "url 为空"}

    if not filename:
        try:
            from urllib.parse import urlparse
            filename = os.path.basename(urlparse(url).path) or "mod.jar"
        except Exception:
            filename = "mod.jar"

    # 同步弹保存框（跟 browse_bg 一致的 tkinter 用法）
    try:
        import tkinter
        import tkinter.filedialog
        root = tkinter.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        target = tkinter.filedialog.asksaveasfilename(
            title="选择 Mod 保存位置",
            initialdir=BASE,
            initialfile=filename,
            filetypes=[("Mod 文件", "*.jar"), ("所有文件", "*.*")],
        )
        root.destroy()
    except Exception as e:
        write_log("ERROR", f"Modrinth 弹保存框失败: {e}")
        return {"code": 500, "msg": f"保存框失败: {e}"}

    if not target:
        return {"code": 400, "msg": "用户取消"}

    if not target.lower().endswith(".jar"):
        target += ".jar"

    task_name = os.path.basename(target)
    task_id = create_task(
        task_name=f"[Mod] {task_name}",
        task_type="mod",
        root_path=os.path.dirname(target),
        mc_version="",
        source="official",
        threads=1,
    )

    # ★ 从请求里拿 project_id 等信息（前端要传）
    #   为了兼容旧调用，这里做成可选
    t = threading.Thread(
        target=_modrinth_install_worker,
        args=(task_id, url, target, sha1, size),
        daemon=True,
    )
    t.start()

    write_log("INFO", f"Modrinth 下载: {filename} → {target} (task_id={task_id})")
    return {"code": 200, "msg": "下载已开始", "task_id": task_id, "target": target}


def _write_mod_meta(version_dir, project_id, slug, title, title_cn,
                    version_id, version_number, download_url, filename,
                    dependencies=None, source="modrinth"):
    """
    写单个 mod 的元数据到 <version_dir>/.xgmcl/mods/<project_id>.json
    """
    if not version_dir or not project_id:
        return
    try:
        meta_dir = os.path.join(version_dir, ".xgmcl", "mods")
        os.makedirs(meta_dir, exist_ok=True)
        meta_path = os.path.join(meta_dir, f"{project_id}.json")
        meta = {
            "project_id":     project_id,
            "slug":           slug or "",
            "title":          title or "",
            "title_cn":       title_cn or "",
            "version_id":     version_id or "",
            "version_number": version_number or "",
            "download_url":   download_url or "",
            "filename":       filename or "",
            "dependencies":   dependencies or [],
            "source":         source,
            "updated_at":     int(time.time()),
        }
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
    except Exception as e:
        write_log("WARN", f"写 mod 元数据失败 {project_id}: {e}")


def _auto_write_meta_after_download(target):
    """
    下载完成后，用 SHA-512 反查 Modrinth 拿信息，写元数据。
    放在 <mods 目录>/.xgmcl/mods/<project_id>.json
    """
    if not target or not os.path.exists(target):
        return

    # 算 SHA-512
    import hashlib as _hl
    h = _hl.sha512()
    with open(target, "rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            h.update(chunk)
    sha512 = h.hexdigest()

    # 查 Modrinth
    try:
        r = requests.get(
            f"{MODRINTH_API}/version_file/{sha512}",
            params={"algorithm": "sha512"},
            headers=_modrinth_headers(),
            timeout=20,
        )
        if r.status_code != 200:
            write_log("INFO", f"哈希反查无结果（可能是非 Modrinth 文件）: {os.path.basename(target)}")
            return
        v = r.json()
    except Exception as e:
        write_log("WARN", f"哈希反查请求失败: {e}")
        return

    pid = v.get("project_id", "")
    if not pid:
        return

    # 查项目信息拿 title / icon / slug
    title = slug = icon_url = ""
    try:
        pr = requests.get(
            f"{MODRINTH_API}/project/{pid}",
            headers=_modrinth_headers(),
            timeout=15,
        )
        if pr.status_code == 200:
            p = pr.json()
            title = p.get("title", "")
            slug = p.get("slug", "")
            icon_url = p.get("icon_url", "")
    except Exception:
        pass

    wiki = load_wiki_entries()
    title_cn = wiki.get((slug or "").lower(), "")

    files = v.get("files", []) or []
    primary = None
    for f in files:
        if f.get("primary"):
            primary = f
            break
    if primary is None and files:
        primary = files[0]

    # 目标 mods 目录 = target 所在目录
    mods_dir = os.path.dirname(target)
    # version_dir = mods 目录的父目录
    version_dir = os.path.dirname(mods_dir)

    _write_mod_meta(
        version_dir=version_dir,
        project_id=pid,
        slug=slug,
        title=title,
        title_cn=title_cn,
        version_id=v.get("id", ""),
        version_number=v.get("version_number", ""),
        download_url=(primary or {}).get("url", ""),
        filename=os.path.basename(target),
        dependencies=v.get("dependencies", []) or [],
    )
    write_log("INFO", f"已写入 mod 元数据: {title or pid} → .xgmcl/mods/{pid}.json")


def _modrinth_install_worker(task_id, url, target, sha1, size):
    """Modrinth 下载 worker：单文件，复用 download_one_file"""
    def _set(key, val):
        with TASK_LOCKS[task_id]:
            t = TASKS.get(task_id)
            if t is not None:
                t[key] = val

    try:
        with TASK_LOCKS[task_id]:
            t = TASKS.get(task_id)
            if t is None:
                return
            t["active"] = True
            t["done"] = False
            t["error"] = None
            t["cancel"] = False
            t["files_total"] = 1
            t["total_bytes"] = size or 0
            t["current_files"] = [os.path.basename(target)]

        threading.Thread(target=speed_updater, args=(task_id,), daemon=True).start()

        file_info = {
            "url": url,
            "target": target,
            "sha1": sha1,
            "size": size,
            "important": False,
        }
        download_one_file(file_info, base_source="official", max_retries=3, task_id=task_id)

        with TASK_LOCKS[task_id]:
            t = TASKS.get(task_id)
            cancelled = t.get("cancel") if t else False

        if cancelled:
            _set("active", False)
            return

        _set("files_done", 1)
        _set("done", True)
        _set("active", False)
        write_log("INFO", f"Modrinth 下载完成: {target}")

        # ★ 下载完成后，用 SHA-512 反查 Modrinth，写元数据
        try:
            _auto_write_meta_after_download(target)
        except Exception as e:
            write_log("WARN", f"自动写元数据失败: {e}")

    except Exception as e:
        _set("error", str(e))
        _set("active", False)
        write_log("ERROR", f"Modrinth 下载失败: {e}")
    finally:
        _finalize_task_history(task_id)


# ====================== API: 依赖树查询 ======================
@app.post("/api/modrinth/dep_tree")
async def modrinth_dep_tree(request: Request):
    """
    批量递归查依赖树。
    请求体：{"project_ids": ["id1", ...], "max_depth": 3}
    返回：
    {
      "code": 200,
      "nodes": {project_id: {title, title_cn, icon_url, slug, ...}},
      "edges": {project_id: [{dep_project_id, dependency_type}, ...]},
      "missing": [project_id...]   # Modrinth 上查不到的
    }
    """
    try:
        body = await request.json()
    except Exception as e:
        return {"code": 400, "msg": f"请求体不是合法 JSON: {e}"}

    root_ids = body.get("project_ids", [])
    max_depth = int(body.get("max_depth", 3))
    if max_depth < 1:
        max_depth = 1
    if max_depth > 3:
        max_depth = 3

    if not isinstance(root_ids, list) or not root_ids:
        return {"code": 200, "nodes": {}, "edges": {}, "missing": []}

    # 去重
    root_ids = list({str(x) for x in root_ids if x})
    wiki = load_wiki_entries()

    nodes = {}        # project_id -> info
    edges = {}        # project_id -> [dep, ...]
    missing = set()   # 查不到的

    # BFS 按层查
    current_layer = set(root_ids)
    all_seen = set()
    for depth in range(max_depth):
        # 本层要查的（去掉已查过的）
        to_query = [pid for pid in current_layer if pid not in all_seen]
        all_seen.update(to_query)
        if not to_query:
            break

        # 批量查项目信息
        for i in range(0, len(to_query), 50):
            batch = to_query[i:i+50]
            try:
                pr = requests.get(
                    f"{MODRINTH_API}/projects",
                    params={"ids": json.dumps(batch)},
                    headers=_modrinth_headers(),
                    timeout=20,
                )
                if pr.status_code == 200:
                    for p in pr.json():
                        pid = p.get("id", "")
                        if not pid:
                            continue
                        slug = (p.get("slug") or "").lower()
                        nodes[pid] = {
                            "project_id":   pid,
                            "slug":         p.get("slug", ""),
                            "title":        p.get("title", ""),
                            "title_cn":     wiki.get(slug, ""),
                            "icon_url":     p.get("icon_url", ""),
                            "description":  p.get("description", ""),
                            "project_type": p.get("project_type", ""),
                        }
                else:
                    for pid in batch:
                        missing.add(pid)
            except Exception as e:
                write_log("WARN", f"查项目失败（批 {i}）: {e}")
                for pid in batch:
                    missing.add(pid)

        # 对每个 pid 拿最新版本的 dependencies
        # 用线程池并发查，不然 99 个串行要等几分钟
        from concurrent.futures import ThreadPoolExecutor, as_completed

        next_layer = set()

        def _fetch_one_project_versions(pid):
            """查一个项目的最新版本依赖，返回 (pid, [deps])"""
            try:
                vr = requests.get(
                    f"{MODRINTH_API}/project/{pid}/version",
                    headers=_modrinth_headers(),
                    timeout=20,
                )
                if vr.status_code != 200:
                    return (pid, [])
                versions = vr.json()
                if not versions:
                    return (pid, [])
                latest = versions[0]
                deps = latest.get("dependencies", []) or []
                out = []
                for d in deps:
                    dep_pid = d.get("project_id")
                    if not dep_pid:
                        continue
                    out.append({
                        "project_id":      dep_pid,
                        "dependency_type": d.get("dependency_type", "required"),
                    })
                return (pid, out)
            except Exception as e:
                write_log("WARN", f"查依赖失败 {pid}: {e}")
                return (pid, [])

        # 只查有 nodes 的
        query_pids = [p for p in to_query if p in nodes]
        if query_pids:
            with ThreadPoolExecutor(max_workers=16) as pool:
                futures = {pool.submit(_fetch_one_project_versions, pid): pid for pid in query_pids}
                for fut in as_completed(futures):
                    try:
                        pid, out = fut.result()
                    except Exception as e:
                        pid = futures[fut]
                        out = []
                    edges[pid] = out
                    for d in out:
                        if d["dependency_type"] in ("required", "embedded"):
                            next_layer.add(d["project_id"])

        current_layer = next_layer
        if not current_layer:
            break

    return {
        "code": 200,
        "nodes": nodes,
        "edges": edges,
        "missing": list(missing),
    }


# ====================== API: Mod 元数据读写 ======================
def _mod_meta_dir(root_path, version_name):
    """返回 <版本目录>/.xgmcl/mods/ 路径"""
    return os.path.join(root_path, "versions", version_name, ".xgmcl", "mods")


@app.get("/api/version/mods/meta_list")
def version_mods_meta_list(version_name: str, root_id: str = ""):
    """
    列出某个版本下所有 .xgmcl/mods/*.json 的内容。
    返回 {"code": 200, "data": {project_id: meta_dict}}
    """
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    if not check_root_valid(target["path"]):
        return {"code": 400, "msg": "目录已失效"}

    meta_dir = _mod_meta_dir(target["path"], version_name)
    result = {}
    if not os.path.isdir(meta_dir):
        return {"code": 200, "data": result}

    for fn in os.listdir(meta_dir):
        if not fn.endswith(".json"):
            continue
        full = os.path.join(meta_dir, fn)
        if not os.path.isfile(full):
            continue
        try:
            with open(full, "r", encoding="utf-8") as f:
                d = json.load(f)
            pid = d.get("project_id") or fn[:-5]
            result[pid] = d
        except Exception as e:
            write_log("WARN", f"读元数据失败 {fn}: {e}")
    return {"code": 200, "data": result}


@app.post("/api/version/mods/meta_save")
async def version_mods_meta_save(request: Request):
    """
    写入一批 mod 元数据。
    请求体：{"version_name": "...", "root_id": "...", "metas": {project_id: {...}}}
    """
    try:
        body = await request.json()
    except Exception as e:
        return {"code": 400, "msg": f"请求体不是合法 JSON: {e}"}

    version_name = body.get("version_name", "")
    root_id = body.get("root_id", "")
    metas = body.get("metas", {})

    if not version_name:
        return {"code": 400, "msg": "version_name 不能为空"}
    if not isinstance(metas, dict):
        return {"code": 400, "msg": "metas 必须是对象"}

    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    if not check_root_valid(target["path"]):
        return {"code": 400, "msg": "目录已失效"}

    meta_dir = _mod_meta_dir(target["path"], version_name)
    os.makedirs(meta_dir, exist_ok=True)

    saved = 0
    for pid, meta in metas.items():
        if not pid or not isinstance(meta, dict):
            continue
        try:
            path = os.path.join(meta_dir, f"{pid}.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
            saved += 1
        except Exception as e:
            write_log("WARN", f"写元数据失败 {pid}: {e}")

    write_log("INFO", f"写入 mod 元数据: {saved} 条 → {version_name}")
    return {"code": 200, "msg": f"已保存 {saved} 条", "saved": saved}


# ====================== API: Modrinth 哈希反查 ======================
@app.post("/api/modrinth/version_from_hash")
async def modrinth_version_from_hash(request: Request):
    """
    批量用 SHA-512 反查 Modrinth 版本信息。
    请求体：{"hashes": ["sha512_1", "sha512_2", ...]}
    返回：{"code": 200, "data": {hash: {project_id, slug, title, title_cn,
            icon_url, version_id, version_number, download_url,
            dependencies: [...]}}}
    查不到的 hash 不会出现在 data 里。
    """
    try:
        body = await request.json()
    except Exception as e:
        return {"code": 400, "msg": f"请求体不是合法 JSON: {e}"}

    hashes = body.get("hashes", [])
    if not isinstance(hashes, list) or not hashes:
        return {"code": 200, "data": {}}

    # 去重 + 限长
    hashes = list({h.lower() for h in hashes if isinstance(h, str) and len(h) == 128})
    if not hashes:
        return {"code": 200, "data": {}}

    # 分批查，每批 32 个
    BATCH = 32
    result_map = {}
    wiki = load_wiki_entries()

    for i in range(0, len(hashes), BATCH):
        batch = hashes[i:i + BATCH]
        try:
            r = requests.post(
                f"{MODRINTH_API}/version_files",
                json={
                    "hashes": batch,
                    "algorithm": "sha512",
                },
                headers=_modrinth_headers(),
                timeout=20,
            )
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            write_log("WARN", f"哈希反查失败（批 {i//BATCH}）: {e}")
            continue

        # data 是 {hash: version_obj}
        if not isinstance(data, dict):
            continue

        # 收集这批里所有 project_id，用于批量查项目信息
        pids = []
        for h, v in data.items():
            pid = v.get("project_id", "")
            if pid:
                pids.append(pid)

        proj_info = {}
        if pids:
            try:
                pr = requests.get(
                    f"{MODRINTH_API}/projects",
                    params={"ids": json.dumps(list(set(pids)))},
                    headers=_modrinth_headers(),
                    timeout=20,
                )
                if pr.status_code == 200:
                    for p in pr.json():
                        proj_info[p.get("id", "")] = p
            except Exception as e:
                write_log("WARN", f"批量查项目信息失败: {e}")

        for h, v in data.items():
            pid = v.get("project_id", "")
            p = proj_info.get(pid, {})
            slug = (p.get("slug") or "").lower()
            # 找主文件
            files = v.get("files", []) or []
            primary = None
            for f in files:
                if f.get("primary"):
                    primary = f
                    break
            if primary is None and files:
                primary = files[0]

            result_map[h] = {
                "project_id":     pid,
                "slug":           p.get("slug", ""),
                "title":          p.get("title", ""),
                "title_cn":       wiki.get(slug, ""),
                "icon_url":       p.get("icon_url", ""),
                "description":    p.get("description", ""),
                "version_id":     v.get("id", ""),
                "version_number": v.get("version_number", ""),
                "download_url":   (primary or {}).get("url", ""),
                "filename":       (primary or {}).get("filename", ""),
                "dependencies":   v.get("dependencies", []) or [],
            }

    return {"code": 200, "data": result_map}


# ====================== API: Modrinth OAuth ======================
@app.get("/api/modrinth/oauth/status")
def modrinth_oauth_status():
    """当前 Modrinth 登录状态"""
    with MODRINTH_OAUTH_LOCK:
        logged = bool(MODRINTH_OAUTH_STATE["access_token"])
        user = MODRINTH_OAUTH_STATE["user"]
    return {"code": 200, "logged_in": logged, "user": user}


@app.get("/api/modrinth/oauth/login")
def modrinth_oauth_login():
    """
    生成授权 URL，用系统默认浏览器打开。
    用户授权后，Modrinth 重定向到 /api/modrinth/oauth/callback。
    """
    import secrets as _secrets
    state = _secrets.token_urlsafe(24)

    with MODRINTH_OAUTH_LOCK:
        MODRINTH_OAUTH_STATE["active"] = True
        MODRINTH_OAUTH_STATE["state"] = state

    from urllib.parse import urlencode
    params = {
        "client_id": MODRINTH_CLIENT_ID,
        "redirect_uri": MODRINTH_REDIRECT_URI,
        "response_type": "code",
        "scope": "+".join(MODRINTH_SCOPES),
        "state": state,
    }
    # urllib.parse.urlencode 会把 "+" 转义成 %2B，Modrinth 不接受
    qs = urlencode(params)
    qs = qs.replace("%2B", "+")
    url = f"{MODRINTH_OAUTH_AUTHORIZE}?{qs}"

    try:
        import webbrowser
        webbrowser.open(url)
    except Exception as e:
        write_log("ERROR", f"打开浏览器失败: {e}")
        return {"code": 500, "msg": f"打开浏览器失败: {e}"}

    write_log("INFO", f"Modrinth OAuth 授权已启动")
    return {"code": 200, "msg": "已打开浏览器，请完成授权", "url": url}


@app.get("/api/modrinth/oauth/callback")
def modrinth_oauth_callback(code: str = "", state: str = "", error: str = ""):
    """OAuth 回调：用 code 换 access_token，拿用户信息，存盘"""
    from fastapi.responses import HTMLResponse

    if error:
        with MODRINTH_OAUTH_LOCK:
            MODRINTH_OAUTH_STATE["active"] = False
        return HTMLResponse(_oauth_result_page(False, f"授权失败：{error}"))

    if not code:
        return HTMLResponse(_oauth_result_page(False, "缺少 code 参数"))

    with MODRINTH_OAUTH_LOCK:
        expected = MODRINTH_OAUTH_STATE["state"]
        active = MODRINTH_OAUTH_STATE["active"]
    if not active or state != expected:
        write_log("WARN", "Modrinth OAuth state 不匹配")
        return HTMLResponse(_oauth_result_page(False, "state 校验失败，请重新登录"))

    try:
        r = requests.post(
            MODRINTH_OAUTH_TOKEN,
            data={
                "code": code,
                "client_id": MODRINTH_CLIENT_ID,
                "redirect_uri": MODRINTH_REDIRECT_URI,
                "grant_type": "authorization_code",
            },
            headers={
                "Authorization": MODRINTH_CLIENT_SECRET,
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
            timeout=20,
        )
        if r.status_code != 200:
            write_log("WARN", f"Modrinth token 交换失败: HTTP {r.status_code} - {r.text[:300]}")
            return HTMLResponse(_oauth_result_page(False, f"Token 交换失败：HTTP {r.status_code} - {r.text[:200]}"))

        d = r.json()
        access_token = d.get("access_token", "")
        refresh_token = d.get("refresh_token", "")
        expires_in = int(d.get("expires_in", 0))

        if not access_token:
            return HTMLResponse(_oauth_result_page(False, "响应里没有 access_token"))

        user = None
        try:
            ur = requests.get(
                f"{MODRINTH_API}/user",
                headers={
                    "Authorization": access_token,
                    "User-Agent": MODRINTH_UA,
                    "Accept": "application/json",
                },
                timeout=15,
            )
            if ur.status_code == 200:
                ud = ur.json()
                user = {
                    "id": ud.get("id", ""),
                    "username": ud.get("username", ""),
                    "avatar_url": ud.get("avatar_url", ""),
                    "name": ud.get("name", ""),
                    "email": ud.get("email", ""),
                }
        except Exception as e:
            write_log("WARN", f"拉 Modrinth 用户信息失败: {e}")

        with MODRINTH_OAUTH_LOCK:
            MODRINTH_OAUTH_STATE["access_token"] = access_token
            MODRINTH_OAUTH_STATE["refresh_token"] = refresh_token
            MODRINTH_OAUTH_STATE["expires_at"] = int(time.time()) + expires_in if expires_in > 0 else 0
            MODRINTH_OAUTH_STATE["user"] = user
            MODRINTH_OAUTH_STATE["active"] = False
            MODRINTH_OAUTH_STATE["state"] = ""

        modrinth_oauth_save()
        write_log("INFO", f"Modrinth 登录成功: {user.get('username') if user else '?'}")

        return HTMLResponse(_oauth_result_page(True, "登录成功，可以关闭此页面"))

    except Exception as e:
        write_log("ERROR", f"Modrinth OAuth 回调异常: {e}")
        return HTMLResponse(_oauth_result_page(False, f"异常：{e}"))


def _oauth_result_page(ok: bool, msg: str):
    """OAuth 回调后给用户看的结果页"""
    color = "#4ade80" if ok else "#ff4757"
    icon = "✓" if ok else "✗"
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Modrinth 授权</title>
<style>
body {{ background:#1f1f1f; color:#ddd; font-family:"Microsoft YaHei",sans-serif;
       display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }}
.box {{ text-align:center; }}
.icon {{ font-size:64px; color:{color}; }}
.msg {{ font-size:18px; margin-top:16px; }}
</style></head>
<body><div class="box">
<div class="icon">{icon}</div>
<div class="msg">{msg}</div>
</div></body></html>"""


@app.get("/api/modrinth/oauth/logout")
def modrinth_oauth_logout():
    modrinth_oauth_clear()
    write_log("INFO", "Modrinth 已登出")
    return {"code": 200, "msg": "已登出"}


# ====================== API: 下载配置 ======================
@app.get("/api/download/config/get")
def download_config_get():
    cfg = safe_load_json(PATH_DOWNLOAD_CFG)
    cfg.setdefault("max_parallel", 16)
    cfg.setdefault("warn_on_close", True)
    return {"code": 200, "data": cfg}


@app.get("/api/download/config/save")
def download_config_save(max_parallel: int = -1, warn_on_close: int = -1):
    cfg = safe_load_json(PATH_DOWNLOAD_CFG)
    if max_parallel >= 0:
        cfg["max_parallel"] = max(1, min(16, max_parallel))
    if warn_on_close >= 0:
        cfg["warn_on_close"] = bool(warn_on_close)
    safe_save_json(PATH_DOWNLOAD_CFG, cfg)
    write_log("INFO", f"保存下载配置: max_parallel={cfg['max_parallel']}, "
                      f"warn_on_close={cfg['warn_on_close']}")
    return {"code": 200, "msg": "已保存", "data": cfg}


# ====================== API: 下载历史 ======================
@app.get("/api/download/history")
def download_history():
    data = safe_load_json(PATH_DOWNLOAD_HIST)
    history = data.get("history", [])
    return {"code": 200, "history": history}


def _append_history(record):
    """追加一条历史记录（保留最近 200 条）"""
    data = safe_load_json(PATH_DOWNLOAD_HIST)
    history = data.get("history", [])
    history.append(record)
    if len(history) > 200:
        history = history[-200:]
    data["history"] = history
    safe_save_json(PATH_DOWNLOAD_HIST, data)


@app.get("/api/download/history/clear")
def download_history_clear():
    safe_save_json(PATH_DOWNLOAD_HIST, {"history": []})
    return {"code": 200, "msg": "已清空"}



@app.get("/api/mojang/manifest")
def mojang_manifest(source: str = "official"):
    try:
        mf = fetch_manifest(source)
        versions = []
        for v in mf.get("versions", []):
            t = v.get("type", "")
            if t in ("release", "snapshot"):
                versions.append({
                    "id": v.get("id"),
                    "type": t,
                    "releaseTime": v.get("releaseTime"),
                    "url": v.get("url"),
                })
        write_log("INFO", f"获取 Mojang 版本列表: {len(versions)} 个 (源={source})")
        return {"code": 200, "versions": versions, "latest": mf.get("latest", {})}
    except Exception as e:
        write_log("ERROR", f"获取 Mojang 版本列表失败: {e}")
        return {"code": 500, "msg": f"获取版本列表失败: {e}"}


@app.get("/api/mojang/check_exists")
def mojang_check_exists(version_name: str, root_id: str = ""):
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}
    ver_dir = os.path.join(target["path"], "versions", version_name)
    exists = os.path.exists(ver_dir)
    return {"code": 200, "exists": exists, "path": ver_dir}


@app.get("/api/mojang/start")
def mojang_start(version_name: str, mc_version_id: str, mc_version_url: str,
                 source: str = "", threads: int = 0, root_id: str = "",
                 install_fabric: int = 0, fabric_loader: str = "",
                 download_fabric_api: int = 0):
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}

    # ★ 检查并行上限
    dl_cfg = safe_load_json(PATH_DOWNLOAD_CFG)
    max_parallel = dl_cfg.get("max_parallel", 16)
    with TASKS_LOCK:
        active_count = sum(1 for t in TASKS.values() if t.get("active"))
    if max_parallel < 16 and active_count >= max_parallel:
        return {"code": 400, "msg": f"已达到最大并行任务数 ({max_parallel})，请等待其他任务完成"}

    if not version_name or not version_name.strip():
        return {"code": 400, "msg": "版本名不能为空"}

    ver_dir = os.path.join(target["path"], "versions", version_name)
    if os.path.exists(ver_dir):
        write_log("WARN", f"下载失败: 版本 {version_name} 已存在")
        return {"code": 400, "msg": f"版本 {version_name} 已存在，请换个名字"}

    # 没传就取全局配置
    g = safe_load_json(PATH_GLOBAL_CONFIG)
    if not source:
        source = g.get("download_source", "bmclapi")
    if not threads or threads <= 0:
        threads = g.get("download_threads", 32)
    threads = max(4, min(threads, 256))

    # 判断类型
    task_type = "combined" if install_fabric else "vanilla"
    stage_total = 2 if install_fabric else 1

    # 创建任务
    task_id = create_task(
        task_name=version_name,
        task_type=task_type,
        root_path=target["path"],
        mc_version=mc_version_id,
        source=source,
        threads=threads,
    )
    # 标记 stage_total
    with TASK_LOCKS[task_id]:
        TASKS[task_id]["stage_total"] = stage_total
        TASKS[task_id]["install_fabric"] = bool(install_fabric)
        TASKS[task_id]["fabric_loader"] = fabric_loader or ""
        TASKS[task_id]["version_name"] = version_name

    write_log("INFO", f"开始下载: {version_name} (MC={mc_version_id}, 源={source}, "
                      f"线程={threads}, Fabric={bool(install_fabric)}, task_id={task_id})")

    t = threading.Thread(
        target=_download_worker,
        args=(task_id, target["path"], version_name, mc_version_id,
              mc_version_url, source, threads, install_fabric, fabric_loader,
              bool(download_fabric_api)),
        daemon=True,
    )
    t.start()
    return {"code": 200, "msg": "下载已开始", "task_id": task_id}


@app.get("/api/fabric/install")
def fabric_install(version_name: str, mc_version_id: str, loader_version: str,
                   source: str = "", threads: int = 0, root_id: str = ""):
    """
    给已有版本装 Fabric。
    现在也走多任务系统：创建一个 task_id 单独跑。
    """
    target = get_root_by_id(root_id)
    if not target:
        return {"code": 400, "msg": "没有可用的游戏目录"}

    # ★ 检查并行上限
    dl_cfg = safe_load_json(PATH_DOWNLOAD_CFG)
    max_parallel = dl_cfg.get("max_parallel", 16)
    with TASKS_LOCK:
        active_count = sum(1 for t in TASKS.values() if t.get("active"))
    if max_parallel < 16 and active_count >= max_parallel:
        return {"code": 400, "msg": f"已达到最大并行任务数 ({max_parallel})，请等待其他任务完成"}
    if not check_root_valid(target["path"]):
        return {"code": 400, "msg": "目录已失效"}

    if not version_name or not mc_version_id or not loader_version:
        return {"code": 400, "msg": "参数不完整"}

    g = safe_load_json(PATH_GLOBAL_CONFIG)
    if not source:
        source = g.get("download_source", "bmclapi")
    if not threads or threads <= 0:
        threads = g.get("download_threads", 32)
    threads = max(4, min(threads, 256))

    ver_dir = os.path.join(target["path"], "versions", version_name)
    json_path = os.path.join(ver_dir, f"{version_name}.json")
    if not os.path.exists(json_path):
        return {"code": 404, "msg": f"版本 JSON 不存在: {json_path}"}

    # 创建任务
    task_id = create_task(
        task_name=version_name + " (Fabric)",
        task_type="fabric",
        root_path=target["path"],
        mc_version=mc_version_id,
        source=source,
        threads=threads,
    )

    t = threading.Thread(
        target=_fabric_install_task_worker,
        args=(task_id, target["path"], version_name, mc_version_id,
              loader_version, source, threads),
        daemon=True,
    )
    t.start()
    write_log("INFO", f"开始安装 Fabric: {version_name} (MC={mc_version_id}, "
                      f"loader={loader_version}, task_id={task_id})")
    return {"code": 200, "msg": "Fabric 安装已开始", "task_id": task_id}


# ====================== API: LittleSkin OAuth ======================
LITTLESKIN_CLIENT_ID = "LITTLESKIN_CLIENT_ID"
LITTLESKIN_OAUTH_BASE = "https://open.littleskin.cn"
LITTLESKIN_YGGDRASIL_BASE = "https://littleskin.cn/api/yggdrasil"

# 设备代码流轮询状态（全局，一次只允许一个登录流程）
LS_LOGIN_STATE = {
    "active": False,
    "device_code": "",
    "user_code": "",
    "verification_uri": "",
    "interval": 5,
    "expires_at": 0,
    "access_token": "",
    "refresh_token": "",
    "token_expires_at": 0,      # access_token 过期时间戳
    "id_token": "",
    "selected_profile": None,   # {"name": "...", "id": "..."}
    "error": None,
    "done": False,
}
LS_LOGIN_LOCK = threading.Lock()


def _parse_ls_selected_profile(id_token):
    """
    从 OAuth 的 id_token（JWT）里解出角色信息。
    返回 {"name": "...", "id": "...", "all": [...]} 或 None。
    - Select 模式：payload 里有 selectedProfile
    - Read   模式：payload 里有 availableProfiles（列表）
    """
    if not id_token:
        return None
    try:
        parts = id_token.split(".")
        if len(parts) < 2:
            return None
        payload_b64 = parts[1]
        padding = "=" * (-len(payload_b64) % 4)
        raw = base64.urlsafe_b64decode(payload_b64 + padding)
        payload = json.loads(raw.decode("utf-8"))

        # Select 模式：直接给一个选中的
        sp = payload.get("selectedProfile")
        if sp and sp.get("name"):
            return {
                "name": sp.get("name", ""),
                "id": sp.get("id", ""),
                "all": [{"name": sp.get("name", ""), "id": sp.get("id", "")}],
            }

        # Read 模式：给所有角色，需要前端选
        profiles = payload.get("availableProfiles") or []
        all_profiles = [
            {"name": p.get("name", ""), "id": p.get("id", "")}
            for p in profiles
            if p.get("name")
        ]
        if all_profiles:
            # 先默认第一个，前端可以覆盖
            return {
                "name": all_profiles[0]["name"],
                "id": all_profiles[0]["id"],
                "all": all_profiles,
            }
        return None
    except Exception as e:
        write_log("ERROR", f"解析 LittleSkin id_token 失败: {e}")
        return None


@app.get("/api/littleskin/start_login")
def littleskin_start_login():
    """向 LittleSkin 请求设备代码对"""
    try:
        r = requests.post(
            f"{LITTLESKIN_OAUTH_BASE}/oauth/device_code",
            data={
                "client_id": LITTLESKIN_CLIENT_ID,
                "scope": "openid Yggdrasil.PlayerProfiles.Read Yggdrasil.MinecraftToken.Create offline_access",
            },
            headers={"Accept": "application/json"},
            timeout=15,
        )
        r.raise_for_status()
        d = r.json()

        with LS_LOGIN_LOCK:
            LS_LOGIN_STATE.update({
                "active": True,
                "device_code": d["device_code"],
                "user_code": d["user_code"],
                "verification_uri": d.get("verification_uri", f"{LITTLESKIN_OAUTH_BASE}/oauth/device"),
                "interval": int(d.get("interval", 5)),
                "expires_at": time.time() + int(d.get("expires_in", 600)),
                "access_token": "",
                "error": None,
                "done": False,
            })

        write_log("INFO", f"LittleSkin 设备代码流已启动，user_code={d['user_code']}")
        return {
            "code": 200,
            "user_code": d["user_code"],
            "verification_uri": d.get("verification_uri", f"{LITTLESKIN_OAUTH_BASE}/oauth/device"),
            "verification_uri_complete": d.get("verification_uri_complete", ""),
            "interval": int(d.get("interval", 5)),
            "expires_in": int(d.get("expires_in", 600)),
        }
    except Exception as e:
        write_log("ERROR", f"LittleSkin 请求设备代码失败: {e}")
        return {"code": 500, "msg": f"请求失败: {e}"}


@app.get("/api/littleskin/poll")
def littleskin_poll():
    """前端轮询：授权好了没"""
    with LS_LOGIN_LOCK:
        if not LS_LOGIN_STATE["active"]:
            return {"code": 400, "msg": "没有正在进行的登录"}
        if LS_LOGIN_STATE["done"]:
            return {"code": 200, "done": True, "user_code": LS_LOGIN_STATE["user_code"]}
        if LS_LOGIN_STATE["error"]:
            return {"code": 400, "error": LS_LOGIN_STATE["error"]}
        if time.time() > LS_LOGIN_STATE["expires_at"]:
            LS_LOGIN_STATE["active"] = False
            return {"code": 400, "error": "授权超时，请重新发起登录"}

        device_code = LS_LOGIN_STATE["device_code"]

    try:
        r = requests.post(
            f"{LITTLESKIN_OAUTH_BASE}/oauth/token",
            data={
                "client_id": LITTLESKIN_CLIENT_ID,
                "device_code": device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            },
            headers={"Accept": "application/json"},
            timeout=15,
        )

        if r.status_code == 200:
            d = r.json()

            # ★ 调试：把完整响应结构写进日志（去掉敏感字段值，只留 key 和结构）
            debug_keys = list(d.keys())
            write_log("INFO", f"LittleSkin /oauth/token 响应字段: {debug_keys}")
            write_log("INFO", f"LittleSkin token 响应(截断): {json.dumps(d, ensure_ascii=False)[:2000]}")

            id_token = d.get("id_token", "")
            profile = _parse_ls_selected_profile(id_token)
            expires_in = int(d.get("expires_in", 0))
            with LS_LOGIN_LOCK:
                LS_LOGIN_STATE["access_token"] = d.get("access_token", "")
                LS_LOGIN_STATE["refresh_token"] = d.get("refresh_token", "")
                LS_LOGIN_STATE["token_expires_at"] = (
                    int(time.time()) + expires_in if expires_in > 0 else 0
                )
                LS_LOGIN_STATE["id_token"] = id_token
                LS_LOGIN_STATE["selected_profile"] = profile
                LS_LOGIN_STATE["done"] = True
                LS_LOGIN_STATE["active"] = False
            if profile:
                write_log("INFO", f"LittleSkin 授权成功，角色数={len(profile.get('all', []))}")
            else:
                write_log("WARN", "LittleSkin 授权成功，但没解析出角色")
            return {
                "code": 200,
                "done": True,
                "user_code": LS_LOGIN_STATE["user_code"],
                "profiles": (profile or {}).get("all", []),
            }

        # 还没授权好
        try:
            err = r.json().get("error", "")
        except Exception:
            err = ""
        if err == "authorization_pending":
            return {"code": 200, "done": False}
        else:
            with LS_LOGIN_LOCK:
                LS_LOGIN_STATE["error"] = f"授权失败: {err}"
                LS_LOGIN_STATE["active"] = False
            write_log("ERROR", f"LittleSkin 轮询失败: {err}")
            return {"code": 400, "error": f"授权失败: {err}"}

    except Exception as e:
        write_log("ERROR", f"LittleSkin 轮询异常: {e}")
        return {"code": 500, "msg": str(e)}


@app.get("/api/littleskin/complete")
def littleskin_complete(profile_name: str = "", profile_id: str = ""):
    """
    授权完成后，把角色写进账户文件。
    - profile_name / profile_id：前端从 profiles 列表里选中的角色
    - 不传则用 id_token 里的第一个
    """
    with LS_LOGIN_LOCK:
        oauth_token = LS_LOGIN_STATE["access_token"]
        oauth_refresh = LS_LOGIN_STATE.get("refresh_token", "")
        oauth_expires_at = LS_LOGIN_STATE.get("expires_at", 0)
        profile = LS_LOGIN_STATE["selected_profile"]

    if not oauth_token:
        return {"code": 400, "msg": "尚未授权，请先调用 /api/littleskin/poll"}

    if not profile or not profile.get("all"):
        with LS_LOGIN_LOCK:
            LS_LOGIN_STATE.update({
                "active": False, "done": False,
                "access_token": "", "id_token": "", "selected_profile": None,
            })
        write_log("ERROR", "LittleSkin 授权成功但未拿到角色，请重试登录")
        return {"code": 400, "msg": "未拿到角色信息，请重新登录"}

    # 决定用哪个角色
    all_profiles = profile["all"]
    chosen = None
    if profile_name:
        for p in all_profiles:
            if p["name"] == profile_name:
                chosen = p
                break
    if not chosen:
        chosen = all_profiles[0]

    username = chosen["name"]
    mc_uuid = chosen["id"]

    try:
        os.makedirs(os.path.dirname(ACCOUNT_PATH), exist_ok=True)
        accounts = safe_load_json(ACCOUNT_PATH)

        # 已存在同 username 的 LittleSkin 账户 → 更新
        for aid in accounts:
            if accounts[aid].get("username") == username and accounts[aid].get("type") == "littleskin":
                accounts[aid]["mc_uuid"] = mc_uuid
                accounts[aid]["access_token"] = oauth_token
                accounts[aid]["refresh_token"] = oauth_refresh
                accounts[aid]["expires_at"] = oauth_expires_at
                safe_save_json(ACCOUNT_PATH, accounts)
                with LS_LOGIN_LOCK:
                    LS_LOGIN_STATE.update({
                        "active": False, "done": False,
                        "access_token": "", "id_token": "", "selected_profile": None,
                    })
                write_log("INFO", f"LittleSkin 账户已更新: {username} ({mc_uuid})")
                return {"code": 200, "msg": f"账户已更新: {username}",
                        "username": username, "mc_uuid": mc_uuid}

        acc_uuid = str(uuid.uuid4())
        accounts[acc_uuid] = {
            "username": username,
            "uuid": acc_uuid,
            "type": "littleskin",
            "mc_uuid": mc_uuid,
            "access_token": oauth_token,
            "refresh_token": oauth_refresh,
            "expires_at": oauth_expires_at,
            "selected": False,
        }
        safe_save_json(ACCOUNT_PATH, accounts)

        with LS_LOGIN_LOCK:
            LS_LOGIN_STATE.update({
                "active": False, "done": False,
                "access_token": "", "refresh_token": "",
                "token_expires_at": 0,
                "id_token": "", "selected_profile": None,
            })

        write_log("INFO", f"LittleSkin 登录成功: {username} ({mc_uuid})")
        return {"code": 200, "msg": f"登录成功: {username}",
                "username": username, "mc_uuid": mc_uuid}

    except Exception as e:
        write_log("ERROR", f"LittleSkin 保存账户失败: {e}")
        return {"code": 500, "msg": f"保存账户失败: {e}"}

# ====================== API: XGstudio 账号 ======================
@app.get("/api/xg/status")
def xg_status():
    with XG_SESSION_LOCK:
        logged = bool(XG_SESSION["logged_in"])
        username = XG_SESSION["username"] if logged else ""
        role = XG_SESSION["role"] if logged else ""

    acc = xg_read_account()
    return {
        "code": 200,
        "registered": acc is not None and xg_yon_on(),
        "logged_in": logged,
        "username": username,
        "role": role,
    }


@app.get("/api/xg/login")
def xg_login(username: str, password: str):
    with XG_SESSION_LOCK:
        if XG_SESSION["logged_in"]:
            return {"code": 400, "msg": "已登录，请先退出"}

    if not xg_yon_on():
        return {"code": 400, "msg": "本机未注册 XGstudio 账号"}

    acc = xg_read_account()
    if not acc:
        return {"code": 400, "msg": "读取注册表失败"}

    if username.strip() != acc["username"]:
        return {"code": 400, "msg": "用户名或密码错误"}

    if not HAS_BCRYPT:
        write_log("ERROR", "bcrypt 未安装，XGstudio 登录不可用")
        return {"code": 500, "msg": "服务端缺少 bcrypt 依赖"}
    try:
        ok = bcrypt.checkpw(password.encode("utf-8"), acc["hash"])
    except Exception as e:
        write_log("ERROR", f"bcrypt 校验异常: {e}")
        return {"code": 400, "msg": "用户名或密码错误"}

    if not ok:
        return {"code": 400, "msg": "用户名或密码错误"}

    _now = int(time.time())
    with XG_SESSION_LOCK:
        XG_SESSION["logged_in"] = True
        XG_SESSION["username"] = acc["username"]
        XG_SESSION["role"] = acc["role"] or ""
        XG_SESSION["login_time"] = _now

    xg_session_save(acc["username"], acc["role"] or "", _now)

    write_log("INFO", f"XGstudio 登录成功: {acc['username']} (职位={acc['role'] or '无'})")
    return {
        "code": 200,
        "msg": "登录成功",
        "username": acc["username"],
        "role": acc["role"] or "",
    }


@app.get("/api/xg/logout")
def xg_logout():
    with XG_SESSION_LOCK:
        old = XG_SESSION["username"]
        XG_SESSION["logged_in"] = False
        XG_SESSION["username"] = ""
        XG_SESSION["role"] = ""
        XG_SESSION["login_time"] = 0
    xg_session_clear()
    if old:
        write_log("INFO", f"XGstudio 退出登录: {old}")
    return {"code": 200, "msg": "已退出"}


@app.get("/api/xg/devmode")
def xg_devmode():
    with XG_SESSION_LOCK:
        ok = bool(XG_SESSION["logged_in"])
    return {"code": 200, "devmode": ok}


# ====================== 启动 ======================
init_xgmcl_dir()
init_log()                # ★ 初始化启动器日志
install_excepthook()      # ★ 安装全局异常钩子
write_log("INFO", "核心服务启动完成")

# ★ 恢复 Modrinth OAuth 登录态
if modrinth_oauth_load():
    _mu = MODRINTH_OAUTH_STATE.get("user")
    write_log("INFO", f"已恢复 Modrinth 登录态: {_mu.get('username') if _mu else '?'}")

# ★ 恢复上次 XGstudio 登录态（如果注册表里有）
_restored = xg_session_load()
if _restored:
    _u, _r, _t = _restored
    _acc = xg_read_account()
    if _acc and _acc["username"] == _u:
        with XG_SESSION_LOCK:
            XG_SESSION["logged_in"] = True
            XG_SESSION["username"] = _u
            XG_SESSION["role"] = _r
            XG_SESSION["login_time"] = _t
        write_log("INFO", f"已恢复 XGstudio 登录态: {_u}")
    else:
        xg_session_clear()
        write_log("WARN", "session 与注册表账号不匹配，已清除")

if __name__ == "__main__":
    import socket, sys

    # ★ PyInstaller --noconsole 模式下 stdout/stderr 是 None，
    #   而 uvicorn 日志要调 .isatty()，会崩。这里兜一个空 IO。
    if sys.stdout is None:
        import io
        sys.stdout = io.StringIO()
    if sys.stderr is None:
        import io
        sys.stderr = io.StringIO()

    def port_free(host, port):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False
        finally:
            s.close()

    for i in range(30):
        if port_free("127.0.0.1", 8000):
            break
        print(f"[等待] 8000 端口被占用，{i+1}/30 ……")
        write_log("WARN", f"8000 端口被占用，等待释放 ({i+1}/30)")
        time.sleep(0.5)
    else:
        print("[错误] 8000 端口 15 秒内未释放，退出")
        write_log("FATAL", "8000 端口 15 秒内未释放，退出")
        sys.exit(1)

    # 临时调试：把 uvicorn 的日志写到文件，同时捕获未处理异常
    import traceback as _tb
    _core_debug_log = os.path.join(LOG_ROOT, "core_debug.log")
    os.makedirs(LOG_ROOT, exist_ok=True)

    try:
        with open(_core_debug_log, "a", encoding="utf-8") as _f:
            _f.write(f"\n\n===== core.py 启动 {time.strftime('%Y.%m.%d.%H:%M:%S')} =====\n")
        uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
    except BaseException as _e:
        with open(_core_debug_log, "a", encoding="utf-8") as _f:
            _f.write(f"===== uvicorn 异常退出 =====\n")
            _f.write(_tb.format_exc())
        raise
    finally:
        with open(_core_debug_log, "a", encoding="utf-8") as _f:
            _f.write(f"===== core.py 退出 {time.strftime('%Y.%m.%d.%H:%M:%S')} =====\n")
