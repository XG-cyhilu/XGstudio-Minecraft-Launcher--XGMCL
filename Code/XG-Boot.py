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




import subprocess
import time
import os
import psutil
import socket
import shutil
import hashlib

# ====================== 母版资源同步 ======================
BOOT_FILES_DIR = os.path.join(os.path.abspath("."), "boot_files")
SYNC_DIRS = ["i18n", "lib", "skins"]

# XG-Boot 自己的配置（由启动器写入，读取时不依赖 core.py）
BOOT_CONFIG_PATH = os.path.join(os.path.abspath("."), "XGMCL", "setting", "boot.json")


def load_skip_verify():
    """读 skip_verify。读不到返回 False（默认严格校验）"""
    try:
        import json as _json
        with open(BOOT_CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = _json.load(f)
        return bool(cfg.get("skip_verify", False))
    except Exception:
        return False


def _sha1_file(path):
    """算文件 SHA-1，文件不存在返回 None"""
    try:
        h = hashlib.sha1()
        with open(path, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None


def _sync_file(src, dst):
    """
    单文件同步：SHA-1 相同跳过，不同则拷贝。
    返回 True 表示拷贝了，False 表示跳过。
    """
    src_hash = _sha1_file(src)
    if src_hash is None:
        return False
    dst_hash = _sha1_file(dst)
    if src_hash == dst_hash:
        return False  # 一致，跳过
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    return True


def sync_boot_assets():
    """
    把 boot_files/{i18n,lib,skins} 同步到 XGMCL/data/。
    - 默认：逐文件 SHA-1 比对，一致跳过，不一致覆盖
    - skip_verify=True：只增不覆盖（文件已存在就跳过，让用户能改 i18n 做资源包）
    """
    if not os.path.isdir(BOOT_FILES_DIR):
        print(f"[XG-Boot] 母版目录不存在，跳过同步: {BOOT_FILES_DIR}")
        return

    skip_verify = load_skip_verify()
    if skip_verify:
        print("[XG-Boot] ⚠️ skip_verify 已开启：只增不覆盖")

    xgmcl_data = os.path.join(ROOT_XGMCL, "data")

    total_copied = 0
    total_skipped = 0
    total_kept = 0

    for sub in SYNC_DIRS:
        src_root = os.path.join(BOOT_FILES_DIR, sub)
        dst_root = os.path.join(xgmcl_data, sub)

        if not os.path.isdir(src_root):
            print(f"[XG-Boot] 跳过（母版无此目录）: {sub}")
            continue

        for dirpath, dirnames, filenames in os.walk(src_root):
            rel = os.path.relpath(dirpath, src_root)
            dst_dir = dst_root if rel == "." else os.path.join(dst_root, rel)

            for fname in filenames:
                src_file = os.path.join(dirpath, fname)
                dst_file = os.path.join(dst_dir, fname)

                # ★ skip_verify：目标已存在就保留不动
                if skip_verify and os.path.exists(dst_file):
                    total_kept += 1
                    continue

                try:
                    if _sync_file(src_file, dst_file):
                        total_copied += 1
                    else:
                        total_skipped += 1
                except Exception as e:
                    print(f"[XG-Boot] ⚠️ 同步失败 {src_file}: {e}")

    if skip_verify:
        print(f"[XG-Boot] 资源同步完成：拷贝 {total_copied} 个，"
              f"跳过（哈希一致）{total_skipped} 个，保留（用户改过）{total_kept} 个")
    else:
        print(f"[XG-Boot] 资源同步完成：拷贝 {total_copied} 个，跳过 {total_skipped} 个")

# ====================== 路径常量（固定架构） ======================
BASE_DIR = os.path.abspath(".")
ROOT_XGMCL = os.path.join(BASE_DIR, "XGMCL")

# 子目录完整定义（严格按照你规定的结构）
DIR_LIST = [
    os.path.join(ROOT_XGMCL, "Code"),
    os.path.join(ROOT_XGMCL, "data", "XGMCL"),
    os.path.join(ROOT_XGMCL, "data", "xgmclp"),
    os.path.join(ROOT_XGMCL, "mcversion_xgmcl", "assets"),
    os.path.join(ROOT_XGMCL, "mcversion_xgmcl", "libraries"),
    os.path.join(ROOT_XGMCL, "mcversion_xgmcl", "versions"),
]

# 可执行文件路径
CORE_EXE = os.path.join(BASE_DIR, "XG-Core.exe")
UI_EXE = os.path.join(BASE_DIR, "XG-UI.exe")
GAMELAUNCH_EXE = os.path.join(BASE_DIR, "XG-GameLaunch.exe")

# ====================== 工具函数 ======================
def init_dir():
    """首次运行初始化全套目录结构"""
    for d in DIR_LIST:
        os.makedirs(d, exist_ok=True)

    # 初始化空配置文件（不存在则创建）
    init_files = [
        os.path.join(ROOT_XGMCL, "config.json"),
        os.path.join(ROOT_XGMCL, "data", "XGMCL", "num.json"),
        os.path.join(ROOT_XGMCL, "data", "XGMCL", "c.json"),
        os.path.join(ROOT_XGMCL, "data", "XGMCL", "server.json"),
        os.path.join(ROOT_XGMCL, "data", "xgmclp", "p.json"),
        os.path.join(ROOT_XGMCL, "data", "datac.json"),
        os.path.join(ROOT_XGMCL, "data", "dataw.json"),
        os.path.join(ROOT_XGMCL, "data", "m.json"),
    ]
    for f in init_files:
        if not os.path.exists(f):
            with open(f, "w", encoding="utf-8") as wf:
                wf.write("{}")

def port_check(host="127.0.0.1", port=8000):
    """检测核心服务是否启动完成"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.5)
    try:
        s.connect((host, port))
        return True
    except:
        return False
    finally:
        s.close()

def kill_tree(proc):
    """彻底杀死进程树，无残留"""
    if not proc:
        return
    try:
        p = psutil.Process(proc.pid)
        for child in p.children(recursive=True):
            child.terminate()
        p.terminate()
    except Exception:
        pass

# ====================== 主启动逻辑 ======================
def main():
    # 1. 初始化全套目录+配置文件
    init_dir()

    # 2. 同步母版资源（SHA-1 比对，只拷贝变化的）
    sync_boot_assets()

    core_proc = None
    ui_proc = None

    try:
        # 2. 启动核心服务
        print("[XG-Boot] 正在启动核心服务 XG-Core ...")
        core_proc = subprocess.Popen(CORE_EXE, cwd=BASE_DIR)

        # 3. 等待服务就绪（最长10秒）
        ok = False
        for _ in range(20):
            if port_check():
                ok = True
                break
            time.sleep(0.5)
        if not ok:
            print("[XG-Boot] 核心服务启动超时！")
            return

        # 4. 启动UI界面
        print("[XG-Boot] 启动主界面 XG-UI ...")
        ui_proc = subprocess.Popen(UI_EXE, cwd=BASE_DIR)

        # 5. 监听UI关闭，自动销毁所有进程
        ui_proc.wait()

    finally:
        print("[XG-Boot] 关闭所有后台进程，准备退出...")
        kill_tree(core_proc)
        kill_tree(ui_proc)

if __name__ == "__main__":
    import sys
    if "--sync-only" in sys.argv:
        init_dir()
        sync_boot_assets()
        print("[XG-Boot] 仅同步模式完成")
    else:
        main()
