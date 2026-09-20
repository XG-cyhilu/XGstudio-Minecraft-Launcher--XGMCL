# launcher.py —— Minecraft 启动核心（优化版）
import os
import json
import hashlib
import uuid as uuid_lib
import zipfile
import subprocess
import threading
import time

LAUNCH_STATE = {
    "active": False,
    "stage": "",       # 当前阶段文字
    "progress": 0,     # 0~100
    "error": None,
    "done": False,
    "pid": 0,
    "start_time": 0,
}
LAUNCH_LOCK = threading.Lock()


def rule_allows(rules, os_name="windows", os_arch="x86_64"):
    if not rules:
        return True
    allow = False
    for r in rules:
        action = r.get("action")
        os_rule = r.get("os", {})
        if "name" in os_rule and os_rule["name"] != os_name:
            continue
        if "arch" in os_rule and os_rule["arch"] not in (os_arch, "x86"):
            continue
        if action == "allow":
            allow = True
        elif action == "disallow":
            return False
    return allow


def lib_to_jar_path(lib, libs_root):
    name = lib.get("name", "")
    artifact = lib.get("downloads", {}).get("artifact")

    if artifact and artifact.get("path"):
        return os.path.join(libs_root, artifact["path"].replace("/", os.sep))

    if not name:
        return None
    parts = name.split(":")
    if len(parts) < 3:
        return None
    group, aname, version = parts[0], parts[1], parts[2]
    classifier = ""
    if len(parts) >= 4:
        classifier = "-" + parts[3]
    rel = f"{group.replace('.', '/')}/{aname}/{version}/{aname}-{version}{classifier}.jar"
    return os.path.join(libs_root, rel.replace("/", os.sep))


def build_classpath(version_json, libs_root, client_jar):
    """构建 classpath（带缓存，json 没改就复用）"""
    ver_dir = os.path.dirname(client_jar)
    cache_file = os.path.join(ver_dir, ".xgmcl_cp_cache")
    json_path = os.path.join(ver_dir, f"{os.path.basename(ver_dir)}.json")

    # 缓存有效？（json 没改过）
    if os.path.exists(cache_file) and os.path.exists(json_path):
        if os.path.getmtime(cache_file) > os.path.getmtime(json_path):
            try:
                with open(cache_file, "r", encoding="utf-8") as f:
                    cached = f.read()
                    if cached:
                        return cached
            except Exception:
                pass

    jars = []
    seen = set()
    for lib in version_json.get("libraries", []):
        if not rule_allows(lib.get("rules")):
            continue
        jar = lib_to_jar_path(lib, libs_root)
        if not jar or jar in seen:
            continue
        seen.add(jar)
        jars.append(jar)

    if client_jar and client_jar not in seen:
        jars.append(client_jar)

    classpath = ";".join(jars)
    try:
        with open(cache_file, "w", encoding="utf-8") as f:
            f.write(classpath)
    except Exception:
        pass
    return classpath


def extract_natives(version_json, libs_root, natives_dir):
    """只解压缺失的 dll，已有跳过"""
    os.makedirs(natives_dir, exist_ok=True)
    extracted = 0
    skipped = 0

    for lib in version_json.get("libraries", []):
        name = lib.get("name", "")
        if "natives" not in name or "windows" not in name:
            continue
        jar_path = lib_to_jar_path(lib, libs_root)
        if not jar_path or not os.path.exists(jar_path):
            continue
        try:
            with zipfile.ZipFile(jar_path, "r") as zf:
                for member in zf.namelist():
                    if not member.endswith((".dll", ".so", ".dylib")):
                        continue
                    target = os.path.join(natives_dir, os.path.basename(member))
                    if os.path.exists(target):
                        skipped += 1
                        continue
                    zf.extract(member, natives_dir)
                    extracted += 1
        except Exception as e:
            print(f"⚠️ 解压 {jar_path} 失败: {e}")

    if extracted or skipped:
        print(f"✅ natives: 新解压 {extracted} 个，跳过 {skipped} 个")


def offline_uuid(username):
    digest = hashlib.md5(("OfflinePlayer:" + username).encode("utf-8")).digest()
    b = bytearray(digest)
    b[6] = (b[6] & 0x0F) | 0x30
    b[8] = (b[8] & 0x3F) | 0x80
    return str(uuid_lib.UUID(bytes=bytes(b))).replace("-", "")

def load_version_json_with_inherit(game_root, version_name):
    """
    读版本 json，如果它用 inheritsFrom 继承父版本，就把父版本合并进来。
    - 没有 inheritsFrom：原样返回
    - 有 inheritsFrom：读父版本 json，合并（子覆盖父，libraries 相加，arguments 相加）
    - 父版本 json 不存在：原样返回（避免崩）
    """
    ver_dir = os.path.join(game_root, "versions", version_name)
    json_path = os.path.join(ver_dir, f"{version_name}.json")

    with open(json_path, "r", encoding="utf-8") as f:
        vj = json.load(f)

    inherits = vj.get("inheritsFrom")
    if not inherits:
        return vj

    # 读父版本
    parent_dir = os.path.join(game_root, "versions", inherits)
    parent_json = os.path.join(parent_dir, f"{inherits}.json")
    if not os.path.exists(parent_json):
        print(f"[inheritsFrom] 父版本 json 不存在: {parent_json}，按独立版本处理")
        return vj

    with open(parent_json, "r", encoding="utf-8") as f:
        pj = json.load(f)

    # ★ 父版本自身也可能继承（PCL 不会，但保险）
    # 递归把父版本也展平
    if pj.get("inheritsFrom"):
        # 临时写回再读，避免递归带参数
        pj = _flatten_version_json(game_root, inherits, pj)

    # 合并：以父为底，子覆盖
    merged = dict(pj)

    # 这些字段子版本有就用子的
    for k in [
        "id", "mainClass", "type", "assets", "assetIndex",
        "downloads", "javaVersion", "complianceLevel",
        "logging", "releaseTime", "time", "minimumLauncherVersion",
        "clientVersion",
    ]:
        if k in vj:
            merged[k] = vj[k]

    # libraries：父 + 子（子在后，覆盖前面同名库）
    parent_libs = pj.get("libraries", []) or []
    child_libs = vj.get("libraries", []) or []
    # 按 name 去重，子的优先
    lib_map = {}
    for lib in parent_libs:
        lib_map[lib.get("name", "")] = lib
    for lib in child_libs:
        lib_map[lib.get("name", "")] = lib
    merged["libraries"] = list(lib_map.values())

    # arguments：jvm / game 相加
    p_args = pj.get("arguments", {}) or {}
    c_args = vj.get("arguments", {}) or {}
    merged["arguments"] = {
        "jvm":  (p_args.get("jvm", []) or []) + (c_args.get("jvm", []) or []),
        "game": (p_args.get("game", []) or []) + (c_args.get("game", []) or []),
    }

    # 老格式 minecraftArguments（1.12 及以下）兼容
    if "minecraftArguments" in vj:
        merged["minecraftArguments"] = vj["minecraftArguments"]
    elif "minecraftArguments" in pj:
        merged["minecraftArguments"] = pj["minecraftArguments"]

    return merged


def _flatten_version_json(game_root, version_name, vj):
    """
    递归展平一个已读进来的 json（内部用）。
    从 vj 里查 inheritsFrom，读父，合并，返回展平后的 dict。
    """
    inherits = vj.get("inheritsFrom")
    if not inherits:
        return vj

    parent_dir = os.path.join(game_root, "versions", inherits)
    parent_json = os.path.join(parent_dir, f"{inherits}.json")
    if not os.path.exists(parent_json):
        return vj

    with open(parent_json, "r", encoding="utf-8") as f:
        pj = json.load(f)

    # 父版本还可能继承 → 递归
    if pj.get("inheritsFrom"):
        pj = _flatten_version_json(game_root, inherits, pj)

    merged = dict(pj)
    for k in [
        "id", "mainClass", "type", "assets", "assetIndex",
        "downloads", "javaVersion", "complianceLevel",
        "logging", "releaseTime", "time", "minimumLauncherVersion",
        "clientVersion",
    ]:
        if k in vj:
            merged[k] = vj[k]

    parent_libs = pj.get("libraries", []) or []
    child_libs = vj.get("libraries", []) or []
    lib_map = {}
    for lib in parent_libs:
        lib_map[lib.get("name", "")] = lib
    for lib in child_libs:
        lib_map[lib.get("name", "")] = lib
    merged["libraries"] = list(lib_map.values())

    p_args = pj.get("arguments", {}) or {}
    c_args = vj.get("arguments", {}) or {}
    merged["arguments"] = {
        "jvm":  (p_args.get("jvm", []) or []) + (c_args.get("jvm", []) or []),
        "game": (p_args.get("game", []) or []) + (c_args.get("game", []) or []),
    }

    if "minecraftArguments" in vj:
        merged["minecraftArguments"] = vj["minecraftArguments"]
    elif "minecraftArguments" in pj:
        merged["minecraftArguments"] = pj["minecraftArguments"]

    return merged

def replace_vars(items, var_map):
    result = []
    for item in items:
        if isinstance(item, str):
            s = item
            for k, v in var_map.items():
                s = s.replace("${" + k + "}", str(v))
            result.append(s)
        elif isinstance(item, dict):
            continue
        else:
            result.append(str(item))
    return result


def set_process_priority(pid, priority_name):
    """设置进程优先级"""
    try:
        import psutil
        priority_map = {
            "极低": psutil.IDLE_PRIORITY_CLASS,
            "低与正常": psutil.BELOW_NORMAL_PRIORITY_CLASS,
            "正常": psutil.NORMAL_PRIORITY_CLASS,
            "高于正常": psutil.ABOVE_NORMAL_PRIORITY_CLASS,
            "高": psutil.HIGH_PRIORITY_CLASS,
            "实时": psutil.REALTIME_PRIORITY_CLASS,
        }
        p = psutil.Process(pid)
        p.nice(priority_map.get(priority_name, psutil.NORMAL_PRIORITY_CLASS))
        print(f"✅ 进程优先级已设为: {priority_name}")
    except Exception as e:
        print(f"⚠️ 设置进程优先级失败: {e}")


def prefer_javaw(java_path):
    """如果传进来 java.exe，优先替换成 javaw.exe（不弹黑框）"""
    if not java_path:
        return java_path
    # 只在是 java.exe 且同目录有 javaw.exe 时替换
    if java_path.lower().endswith("java.exe"):
        javaw = java_path[:-len("java.exe")] + "javaw.exe"
        if os.path.exists(javaw):
            return javaw
    return java_path


def _set_stage(stage, progress):
    with LAUNCH_LOCK:
        LAUNCH_STATE["stage"] = stage
        LAUNCH_STATE["progress"] = progress


def launch_game(game_root, version_name, username,
                ram_mb=2048, java_path="java", jvm_args_extra="",
                priority="正常", isolated=False, game_dir=None):
    with LAUNCH_LOCK:
        LAUNCH_STATE.update({
            "active": True,
            "stage": "准备中...",
            "progress": 0,
            "error": None,
            "done": False,
            "pid": 0,
            "start_time": time.time(),
        })

    ver_dir = os.path.join(game_root, "versions", version_name)
    json_path = os.path.join(ver_dir, f"{version_name}.json")

    # 游戏工作目录：隔离时 <版本>/.minecraft，否则 <根>
    if game_dir is None:
        game_dir = os.path.join(ver_dir, ".minecraft") if isolated else game_root
    if isolated:
        os.makedirs(game_dir, exist_ok=True)

    try:
        # ---- 阶段 1: 检查 Java (0~15) ----
        _set_stage("检查 Java...", 0)
        java_exe = prefer_javaw(java_path)
        _set_stage("检查 Java...", 5)
        if java_exe != "java" and not os.path.exists(java_exe):
            raise RuntimeError(f"找不到 Java: {java_exe}")
        _set_stage("检查 Java...", 15)

        # ---- 阶段 2: 检查版本 JSON (15~30) ----
        _set_stage("检查版本 JSON...", 15)
        if not os.path.exists(json_path):
            raise RuntimeError(f"找不到版本 JSON: {json_path}")
        # ★ 支持 inheritsFrom（PCL 兼容）
        vj = load_version_json_with_inherit(game_root, version_name)
        _set_stage("检查版本 JSON...", 30)

        libs_root = os.path.join(game_root, "libraries")
        assets_root = os.path.join(game_root, "assets")
        natives_dir = os.path.join(ver_dir, f"{version_name}-natives")
        client_jar = os.path.join(ver_dir, f"{version_name}.jar")

        # ---- 阶段 3: 检查客户端 jar (30~45) ----
        _set_stage("检查客户端 jar...", 30)
        if not os.path.exists(client_jar):
            raise RuntimeError(f"找不到客户端 jar: {client_jar}")
        _set_stage("检查客户端 jar...", 45)

        # ---- 阶段 4: 检查依赖库 (45~80) ----
        _set_stage("构建 classpath...", 45)
        classpath = build_classpath(vj, libs_root, client_jar)
        _set_stage("解压 natives...", 65)
        extract_natives(vj, libs_root, natives_dir)
        _set_stage("依赖库就绪", 80)

        # ★ 默认语言：把 options.txt 的 lang 强制设为简体中文
        # 文件不存在 → 创建；有 lang 行 → 替换；没 lang 行 → 追加
        try:
            _options_file = os.path.join(game_dir, "options.txt")
            _lines = []
            _found = False

            if os.path.exists(_options_file):
                with open(_options_file, "r", encoding="utf-8", errors="ignore") as _f:
                    _lines = _f.read().splitlines()

            for _i, _line in enumerate(_lines):
                if _line.startswith("lang:"):
                    _lines[_i] = "lang:zh_cn"
                    _found = True
                    break
            if not _found:
                _lines.append("lang:zh_cn")

            os.makedirs(game_dir, exist_ok=True)
            with open(_options_file, "w", encoding="utf-8") as _f:
                _f.write("\n".join(_lines) + "\n")
        except Exception as _e:
            print(f"[默认语言] 写入失败: {_e}")

        acc_uuid = offline_uuid(username)

        var_map = {
            "auth_player_name": username,
            "version_name": version_name,
            "game_directory": game_dir,
            "assets_root": assets_root,
            "assets_index_name": vj.get("assetIndex", {}).get("id", "29"),
            "auth_uuid": acc_uuid,
            "auth_access_token": "0",
            "clientid": "",
            "auth_xuid": "",
            "version_type": vj.get("type", "release"),
            "natives_directory": natives_dir,
            "classpath": classpath,
            "launcher_name": "XGLauncher",
            "launcher_version": "2.0.0",
            "resolution_width": "1280",
            "resolution_height": "720",
        }

        # ★ 用户 JVM 参数里写了 -Xmx / -Xms 就用用户的，滑块不重复加
        cmd = [java_exe]
        _jvm_lower = (jvm_args_extra or "").lower()
        _has_xmx = "-xmx" in _jvm_lower
        _has_xms = "-xms" in _jvm_lower

        if not _has_xmx:
            cmd.append(f"-Xmx{ram_mb}M")
        if not _has_xms:
            cmd.append(f"-Xms{ram_mb // 2}M")

        if jvm_args_extra:
            cmd.extend(jvm_args_extra.split())

        jvm_args = replace_vars(vj.get("arguments", {}).get("jvm", []), var_map)
        cmd.extend(jvm_args)

        main_class = vj.get("mainClass", "net.minecraft.client.main.Main")
        joined = " ".join(jvm_args)
        if main_class not in joined:
            cmd.append(main_class)

        game_args = replace_vars(vj.get("arguments", {}).get("game", []), var_map)
        cmd.extend(game_args)

        print("=" * 70)
        print(f"   启动 {version_name}")
        print(f"   Java: {java_exe}")
        print(f"   内存: {ram_mb}MB")
        print(f"   优先级: {priority}")
        print(f"   隔离: {'开启' if isolated else '关闭'}")
        print(f"   工作目录: {game_dir}")
        print("=" * 70)

        # ---- 阶段 5: 启动进程 (80~100) ----
        _set_stage("启动进程...", 80)
        proc = subprocess.Popen(
            cmd,
            cwd=game_dir,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )

        if priority and priority != "正常":
            threading.Timer(
                0.5, lambda: set_process_priority(proc.pid, priority)
            ).start()

        _set_stage("启动完成", 100)
        with LAUNCH_LOCK:
            LAUNCH_STATE["done"] = True
            LAUNCH_STATE["active"] = False
            LAUNCH_STATE["pid"] = proc.pid

        return {"code": 200, "msg": "启动成功", "pid": proc.pid}

    except Exception as e:
        with LAUNCH_LOCK:
            LAUNCH_STATE["error"] = str(e)
            LAUNCH_STATE["active"] = False
        return {"code": 500, "msg": f"启动失败: {e}"}
