# server.py —— Fabric 服务端管理（启动/停止/配置/控制台）
import os
import json
import time
import subprocess
import threading
import tkinter
import tkinter.filedialog

from xgmcl_log import write_log

# ====================== 全局状态 ======================
SERVER_STATE = {
    "running": False,
    "pid": 0,
    "dir": "",
    "jar": "",
    "start_time": 0,
}
SERVER_PROC = None
SERVER_LOCK = threading.Lock()


# ====================== 选目录 ======================
def select_server_dir():
    """弹目录选择框，选服务端根目录"""
    try:
        root = tkinter.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        path = tkinter.filedialog.askdirectory(title="选择服务端根目录")
        root.destroy()
        return path or ""
    except Exception as e:
        write_log("ERROR", f"选择服务端目录失败: {e}")
        return ""


# ====================== 扫 jar ======================
def scan_jars(server_dir):
    """
    扫目录里的所有 .jar，优先把 fabric-server-launch.jar 排前面。
    返回 [{"name": "xxx.jar", "path": "全路径", "preferred": bool}]
    """
    result = []
    if not server_dir or not os.path.isdir(server_dir):
        return result

    try:
        for fn in os.listdir(server_dir):
            if not fn.lower().endswith(".jar"):
                continue
            full = os.path.join(server_dir, fn)
            if not os.path.isfile(full):
                continue
            preferred = (fn.lower() == "fabric-server-launch.jar")
            result.append({
                "name": fn,
                "path": full,
                "preferred": preferred,
            })
    except Exception as e:
        write_log("WARN", f"扫 jar 失败: {e}")

    result.sort(key=lambda x: (0 if x["preferred"] else 1, x["name"].lower()))
    return result


# ====================== 目录合法性检测 ======================
def detect_server(server_dir):
    """
    检查目录是否像一个 Fabric 服务端。
    返回 dict：
      {valid, dir, has_properties, has_eula, has_logs, jars, preferred_jar}
    """
    result = {
        "valid": False,
        "dir": server_dir,
        "has_properties": False,
        "has_eula": False,
        "has_logs": False,
        "jars": [],
        "preferred_jar": "",
    }
    if not server_dir or not os.path.isdir(server_dir):
        return result

    result["has_properties"] = os.path.exists(os.path.join(server_dir, "server.properties"))
    result["has_eula"] = os.path.exists(os.path.join(server_dir, "eula.txt"))
    result["has_logs"] = os.path.isdir(os.path.join(server_dir, "logs"))

    result["jars"] = scan_jars(server_dir)
    for j in result["jars"]:
        if j["preferred"]:
            result["preferred_jar"] = j["path"]
            break
    if not result["preferred_jar"] and result["jars"]:
        result["preferred_jar"] = result["jars"][0]["path"]

    result["valid"] = result["has_properties"] and len(result["jars"]) > 0
    return result


# ====================== server.properties 读写 ======================
def _read_properties_lines(server_dir):
    path = os.path.join(server_dir, "server.properties")
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read().splitlines()


def read_properties(server_dir):
    """读 server.properties → dict，忽略注释和空行"""
    result = {}
    for line in _read_properties_lines(server_dir):
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if "=" not in s:
            continue
        k, v = s.split("=", 1)
        result[k.strip()] = v
    return result


def save_properties(server_dir, data: dict):
    """
    逐行改，不重排、不删注释、不删空行。
    已存在的 key 改值；不存在的不加。
    """
    lines = _read_properties_lines(server_dir)
    changed = 0

    out = []
    for line in lines:
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            out.append(line)
            continue
        k = s.split("=", 1)[0].strip()
        if k in data:
            out.append(f"{k}={str(data[k])}")
            changed += 1
        else:
            out.append(line)

    path = os.path.join(server_dir, "server.properties")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(out))
        if out:
            f.write("\n")

    write_log("INFO", f"保存 server.properties: {changed} 个字段改动")
    return changed


# ====================== whitelist.json / ops.json ======================
def read_whitelist(server_dir):
    path = os.path.join(server_dir, "whitelist.json")
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, list) else []
    except Exception as e:
        write_log("WARN", f"读 whitelist.json 失败: {e}")
        return []


def save_whitelist(server_dir, arr):
    path = os.path.join(server_dir, "whitelist.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(arr, f, ensure_ascii=False, indent=2)
    write_log("INFO", f"保存 whitelist.json: {len(arr)} 条")
    return True


def read_ops(server_dir):
    path = os.path.join(server_dir, "ops.json")
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, list) else []
    except Exception as e:
        write_log("WARN", f"读 ops.json 失败: {e}")
        return []


def save_ops(server_dir, arr):
    path = os.path.join(server_dir, "ops.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(arr, f, ensure_ascii=False, indent=2)
    write_log("INFO", f"保存 ops.json: {len(arr)} 条")
    return True


# ====================== eula.txt 强制同意 ======================
def force_eula(server_dir):
    """把 eula.txt 写成 eula=true（不存在就创建）"""
    path = os.path.join(server_dir, "eula.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write("#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n")
        f.write("eula=true\n")
    write_log("INFO", "已同意 EULA（eula.txt → eula=true）")
    return True


# ====================== 日志路径 ======================
def get_log_path(server_dir):
    return os.path.join(server_dir, "logs", "latest.log")


# ====================== 启动 / 停止 ======================
def start_server(server_dir, jar_path, ram_mb=3072, jvm_args="", java_path="java"):
    """
    启动 Fabric 服务端。
    - 强制写 eula=true
    - stdout/stderr 吞掉（Fabric 自己写 logs/latest.log）
    - stdin=PIPE，用于后续输命令
    - java_path：Java 可执行文件路径
    """
    global SERVER_PROC

    with SERVER_LOCK:
        if SERVER_STATE["running"]:
            return {"code": 400, "msg": "服务端已在运行"}

    if not os.path.isdir(server_dir):
        return {"code": 400, "msg": f"服务端目录不存在: {server_dir}"}
    if not os.path.exists(jar_path):
        return {"code": 400, "msg": f"jar 不存在: {jar_path}"}

    # Java 路径
    java_exe = (java_path or "").strip() or "java"
    if java_exe != "java" and not os.path.exists(java_exe):
        return {"code": 400, "msg": f"找不到 Java: {java_exe}"}

    # 强制 eula
    try:
        force_eula(server_dir)
    except Exception as e:
        write_log("ERROR", f"写 eula.txt 失败: {e}")
        return {"code": 500, "msg": f"写 eula.txt 失败: {e}"}

    # 构建命令
    cmd = [java_exe]
    if jvm_args:
        # 用户自定义参数：原样拼进去
        cmd.extend(jvm_args.split())
    else:
        # 默认参数：-Xmx4G -Xms2G
        cmd.extend(["-Xmx4G", "-Xms2G"])

    cmd.extend(["-jar", os.path.basename(jar_path), "nogui"])

    write_log("INFO", f"启动服务端: {jar_path} (RAM={ram_mb}MB, dir={server_dir})")

    # ★ 把 Java 的 stderr 写到临时文件，方便排查启动失败
    import tempfile
    _stderr_file = os.path.join(tempfile.gettempdir(), "xgmcl_server_stderr.log")
    _stderr_fp = open(_stderr_file, "w", encoding="utf-8", errors="replace")

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=server_dir,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=_stderr_fp,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        write_log("INFO", f"服务端进程已启动，stderr 写到: {_stderr_file}")
    except Exception as e:
        write_log("ERROR", f"服务端启动失败: {e}")
        try:
            _stderr_fp.close()
        except Exception:
            pass
        return {"code": 500, "msg": f"启动失败: {e}"}

    with SERVER_LOCK:
        SERVER_PROC = proc
        SERVER_STATE["running"] = True
        SERVER_STATE["pid"] = proc.pid
        SERVER_STATE["dir"] = server_dir
        SERVER_STATE["jar"] = os.path.basename(jar_path)
        SERVER_STATE["start_time"] = int(time.time())

    write_log("INFO", f"服务端已启动 (PID={proc.pid})")
    return {"code": 200, "msg": "服务端已启动", "pid": proc.pid}


def stop_server():
    """往 stdin 发 stop，3 秒不退强杀"""
    global SERVER_PROC

    with SERVER_LOCK:
        if not SERVER_STATE["running"] or SERVER_PROC is None:
            return {"code": 400, "msg": "服务端未运行"}
        proc = SERVER_PROC

    try:
        if proc.stdin:
            proc.stdin.write(b"stop\n")
            proc.stdin.flush()
    except Exception as e:
        write_log("WARN", f"发 stop 失败: {e}")

    try:
        proc.wait(timeout=3)
        msg = "服务端已停止"
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
            msg = "服务端强杀成功"
        except Exception as e:
            msg = f"强杀失败: {e}"

    _cleanup_after_exit()
    return {"code": 200, "msg": msg}


def _cleanup_after_exit():
    global SERVER_PROC
    with SERVER_LOCK:
        SERVER_STATE["running"] = False
        SERVER_STATE["pid"] = 0
        SERVER_PROC = None


def is_running():
    """检查服务端是否在跑（顺便清理死进程状态）"""
    with SERVER_LOCK:
        if not SERVER_STATE["running"]:
            return False
        proc = SERVER_PROC

    if proc is None:
        _cleanup_after_exit()
        return False

    if proc.poll() is not None:
        write_log("INFO", f"服务端进程已退出 (code={proc.returncode})")
        _cleanup_after_exit()
        return False
    return True


# ====================== 控制台读取 ======================
def tail_console(server_dir, offset, max_lines=500):
    """
    读 logs/latest.log 从 offset 开始的新增内容。
    返回 (lines, next_offset, exists)
    """
    path = get_log_path(server_dir)
    if not os.path.exists(path):
        return [], offset, False

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
            return lines, cur_size, True
    except Exception as e:
        write_log("WARN", f"读服务端日志失败: {e}")
        return [], offset, False


def read_console_from_start(server_dir, max_lines=2000):
    """读整个 latest.log（服务端没在跑时用）"""
    path = get_log_path(server_dir)
    if not os.path.exists(path):
        return [], 0
    try:
        with open(path, "rb") as f:
            data = f.read()
        text = data.decode("utf-8", errors="replace")
        lines = text.splitlines()
        if len(lines) > max_lines:
            lines = lines[-max_lines:]
        return lines, len(data)
    except Exception as e:
        write_log("WARN", f"读服务端日志失败: {e}")
        return [], 0


# ====================== 输命令 ======================
def send_command(cmd: str):
    """往服务端进程 stdin 写一行"""
    with SERVER_LOCK:
        if not SERVER_STATE["running"] or SERVER_PROC is None:
            return {"code": 400, "msg": "服务端未运行"}
        proc = SERVER_PROC

    try:
        if proc.stdin:
            proc.stdin.write((cmd + "\n").encode("utf-8"))
            proc.stdin.flush()
        write_log("INFO", f"发送服务端命令: {cmd}")
        return {"code": 200, "msg": "已发送"}
    except Exception as e:
        write_log("ERROR", f"发送命令失败: {e}")
        return {"code": 500, "msg": f"发送失败: {e}"}
