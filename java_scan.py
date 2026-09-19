# java_scan.py —— 从 PATH + 注册表读 Java，不扫全盘
import os
import re
import subprocess


def _probe(exe):
    """跑 java -version，返回 dict 或 None"""
    if not os.path.exists(exe):
        return None
    try:
        out = subprocess.check_output(
            [exe, "-version"],
            stderr=subprocess.STDOUT,
            timeout=5,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        ).decode("utf-8", errors="ignore")
    except Exception:
        return None

    m = re.search(r'version "([^"]+)"', out)
    if not m:
        return None
    ver = m.group(1)

    major = 0
    try:
        major = int(ver.split(".")[1]) if ver.startswith("1.") else int(ver.split(".")[0])
    except Exception:
        major = 0

    vendor = "Unknown"
    low = out.lower()
    if "temurin" in low: vendor = "Adoptium Temurin"
    elif "adoptium" in low: vendor = "Adoptium"
    elif "zulu" in low: vendor = "Azul Zulu"
    elif "corretto" in low: vendor = "Amazon Corretto"
    elif "microsoft" in low: vendor = "Microsoft"
    elif "oracle" in low: vendor = "Oracle"
    elif "openjdk" in low: vendor = "OpenJDK"

    return {"version": ver, "major": major, "vendor": vendor, "is64": "64-bit" in out}


def _from_path():
    """遍历 PATH，收集所有含 java.exe / javaw.exe 的 bin 目录"""
    bins = set()
    path_env = os.environ.get("PATH", "")
    sep = ";" if os.name == "nt" else ":"

    for entry in path_env.split(sep):
        entry = entry.strip().strip('"')
        if not entry or not os.path.isdir(entry):
            continue
        if os.path.exists(os.path.join(entry, "java.exe")) or \
           os.path.exists(os.path.join(entry, "javaw.exe")):
            bins.add(os.path.normcase(entry))
    return bins


def _from_registry():
    """从注册表读 JavaHome"""
    homes = set()
    try:
        import winreg
    except ImportError:
        return homes

    roots = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\JavaSoft"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Eclipse Adoptium\JDK"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Eclipse Foundation\JDK"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Azul Systems\Zulu"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\JDK"),
    ]

    def walk(hive, path, depth=0):
        if depth > 4:
            return
        try:
            key = winreg.OpenKey(hive, path)
        except OSError:
            return
        try:
            i = 0
            while True:
                try:
                    sub = winreg.EnumKey(key, i)
                    i += 1
                    sub_path = path + "\\" + sub
                    try:
                        sk = winreg.OpenKey(hive, sub_path)
                        try:
                            jh, _ = winreg.QueryValueEx(sk, "JavaHome")
                            if jh and os.path.isdir(jh):
                                homes.add(os.path.normcase(os.path.join(jh, "bin")))
                        except OSError:
                            pass
                        winreg.CloseKey(sk)
                    except OSError:
                        pass
                    walk(hive, sub_path, depth + 1)
                except OSError:
                    break
        finally:
            winreg.CloseKey(key)

    for hive, p in roots:
        walk(hive, p)
    return homes


def scan_java_installations():
    """只从 PATH + 注册表读，飞快"""
    bins = set()
    bins |= _from_path()
    bins |= _from_registry()

    results = []
    seen = set()
    print(f"🔍 找到 {len(bins)} 个候选目录，开始探测……")

    for bindir in bins:
        # 优先 javaw.exe（不弹黑框）
        exe = os.path.join(bindir, "javaw.exe")
        if not os.path.exists(exe):
            exe = os.path.join(bindir, "java.exe")
        if not os.path.exists(exe):
            continue
        if exe in seen:
            continue
        seen.add(exe)

        info = _probe(exe)
        if info:
            info["path"] = exe
            results.append(info)

    results.sort(key=lambda x: (-x["major"], x["vendor"], x["path"]))
    print(f"找到 {len(results)} 个 Java")
    return results


if __name__ == "__main__":
    js = scan_java_installations()
    for j in js:
        print(f"  [Java {j['major']}] {j['vendor']} ({j['version']})")
        print(f"      {j['path']}")