# xgmcl_log.py —— 启动器日志核心
import os
import time
import threading
import gzip
import shutil

# ====================== 路径 ======================
import sys as _sys

if getattr(_sys, 'frozen', False):
    # PyInstaller 打包后：用 exe 所在目录
    BASE = os.path.dirname(_sys.executable)
else:
    # 源码运行：用 .py 所在目录
    BASE = os.path.dirname(os.path.abspath(__file__))

LOG_DIR = os.path.join(BASE, "XGMCL", "xgmcllog")

# ====================== 全局 ======================
CURRENT_LOG_PATH = None
LOG_LOCK = threading.Lock()


# ====================== 文件名生成 ======================
def _get_log_filename():
    now = time.localtime()
    base = f"XGMCL_{now.tm_year:04d}.{now.tm_mon:02d}.{now.tm_mday:02d}.{now.tm_hour:02d}"
    os.makedirs(LOG_DIR, exist_ok=True)
    n = 1
    prefix = base + "_["
    for f in os.listdir(LOG_DIR):
        if f.startswith(prefix) and f.endswith("]LOG.log"):
            try:
                idx = int(f[len(prefix):-len("]LOG.log")])
                n = max(n, idx + 1)
            except Exception:
                pass
    return os.path.join(LOG_DIR, f"{base}_[{n}]LOG.log")


# ====================== 初始化 ======================
def init_log():
    global CURRENT_LOG_PATH
    CURRENT_LOG_PATH = _get_log_filename()
    with LOG_LOCK:
        try:
            with open(CURRENT_LOG_PATH, "a", encoding="utf-8") as f:
                pass
        except Exception as e:
            print(f"⚠️ 无法创建日志文件: {e}")
    write_log("INFO", "========================================")
    write_log("INFO", "  XGMCL 启动器启动")
    write_log("INFO", f"  日志文件: {os.path.basename(CURRENT_LOG_PATH)}")
    write_log("INFO", "========================================")


# ====================== 写日志 ======================
def write_log(level: str, msg: str):
    global CURRENT_LOG_PATH
    if not CURRENT_LOG_PATH:
        return
    ts = time.strftime("%Y.%m.%d.%H:%M:%S")
    line = f"[{ts}] [{level}] {msg}\n"
    with LOG_LOCK:
        try:
            with open(CURRENT_LOG_PATH, "a", encoding="utf-8") as f:
                f.write(line)
        except Exception:
            pass


# ====================== ★ 下载专用日志 ======================
def write_download_log(msg: str):
    """下载专用日志（写到单独的文件，方便分析）"""
    global CURRENT_LOG_PATH
    if not CURRENT_LOG_PATH:
        return
    # 下载日志写在同目录，文件名带 _download
    base = os.path.basename(CURRENT_LOG_PATH)
    name, ext = os.path.splitext(base)
    dl_log = os.path.join(LOG_DIR, f"{name}_DOWNLOAD{ext}")
    ts = time.strftime("%H:%M:%S")
    line = f"[{ts}] {msg}\n"
    with LOG_LOCK:
        try:
            with open(dl_log, "a", encoding="utf-8") as f:
                f.write(line)
        except Exception:
            pass


# ====================== 工具函数 ======================
def get_log_dir():
    return LOG_DIR


def get_current_log_path():
    return CURRENT_LOG_PATH


def list_log_files():
    if not os.path.isdir(LOG_DIR):
        return []
    files = []
    for f in os.listdir(LOG_DIR):
        if f.endswith(".log") or f.endswith(".log.gz"):
            path = os.path.join(LOG_DIR, f)
            try:
                st = os.stat(path)
                files.append({
                    "name": f,
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                    "compressed": f.endswith(".gz"),
                })
            except Exception:
                pass
    files.sort(key=lambda x: x["mtime"], reverse=True)
    return files


def read_log_file(filename: str, max_lines: int = 5000):
    if ".." in filename or "/" in filename or "\\" in filename:
        return None, "非法文件名"
    path = os.path.join(LOG_DIR, filename)
    if not os.path.exists(path):
        return None, "文件不存在"
    try:
        if filename.endswith(".gz"):
            with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
                content = f.read()
        else:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        lines = content.splitlines()
        if len(lines) > max_lines:
            lines = lines[-max_lines:]
        return lines, None
    except Exception as e:
        return None, str(e)


def install_excepthook():
    import sys
    def _hook(exc_type, exc_value, exc_tb):
        write_log("FATAL", f"未处理异常: {exc_type.__name__}: {exc_value}")
        sys.__excepthook__(exc_type, exc_value, exc_tb)
    sys.excepthook = _hook
