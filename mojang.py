# mojang.py —— Minecraft 版本下载核心（带自动切源 + 失败统计 + 准确进度）
import os
import json
import time
import hashlib
import threading
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from xgmcl_log import write_log, write_download_log

# ====================== 多任务全局状态 ======================
import uuid as _uuid_mod

TASKS = {}                    # { task_id: task_state_dict }
TASKS_LOCK = threading.Lock() # 保护 TASKS 字典结构
TASK_LOCKS = {}               # { task_id: threading.Lock() }  任务内部状态锁


def _new_task_state(task_id, task_name, task_type, root_path, mc_version,
                    source, threads, history_record=None):
    """创建一个新任务的状态字典"""
    return {
        "task_id": task_id,
        "task_name": task_name,       # UI 显示名
        "task_type": task_type,       # "vanilla" | "fabric" | "combined"
        "stage": 1,                   # combined 时：1=原版 2=Fabric
        "stage_total": 1,             # combined 时 = 2
        "active": False,
        "cancel": False,
        "version": task_name,         # 兼容旧字段
        "mc_version": mc_version,
        "root_path": root_path,
        "source": source,
        "threads": threads,
        "total_bytes": 0,
        "downloaded_bytes": 0,
        "actual_downloaded_bytes": 0,
        "skipped_bytes": 0,
        "speed": 0,
        "current_files": [],
        "files_total": 0,
        "files_done": 0,
        "files_skipped": 0,
        "files_downloaded": 0,
        "error": None,
        "done": False,
        "start_time": time.time(),
        "last_bytes": 0,
        "retry_log": [],
        "failed_count": 0,
        "failed_files": [],
        "history_record": history_record,
    }


def create_task(task_name, task_type, root_path, mc_version,
                source="bmclapi", threads=16, history_record=None):
    """创建一个新任务，返回 task_id"""
    task_id = str(_uuid_mod.uuid4())
    with TASKS_LOCK:
        TASKS[task_id] = _new_task_state(
            task_id, task_name, task_type, root_path,
            mc_version, source, threads, history_record
        )
        TASK_LOCKS[task_id] = threading.Lock()
    return task_id


def get_task(task_id):
    with TASKS_LOCK:
        return TASKS.get(task_id)


def list_tasks():
    with TASKS_LOCK:
        return list(TASKS.values())


def remove_task(task_id):
    with TASKS_LOCK:
        TASKS.pop(task_id, None)
        TASK_LOCKS.pop(task_id, None)

# 重要文件（要 SHA1 校验）
IMPORTANT_PATTERNS = [
    "client.jar",
    "/libraries/",
]

# 源优先级（用于自动切源）
SOURCE_ORDER = ["bmclapi", "official", "mcbbbs"]

# 各源对应的 URL 转换规则
SOURCE_MAP = {
    "bmclapi": {
        "piston-meta.mojang.com": "bmclapi2.bangbang93.com",
        "piston-data.mojang.com": "bmclapi2.bangbang93.com",
        "libraries.minecraft.net": "bmclapi2.bangbang93.com/maven",
        "resources.download.minecraft.net": "bmclapi2.bangbang93.com/assets",
    },
    "official": {},  # 官方，不改
    "mcbbbs": {  # MCBBS 已关，但按要求写
        "piston-meta.mojang.com": "download.mcbbs.net",
        "piston-data.mojang.com": "download.mcbbs.net",
        "libraries.minecraft.net": "download.mcbbs.net/maven",
        "resources.download.minecraft.net": "download.mcbbs.net/assets",
    },
}


# ====================== 工具 ======================
def rewrite_url(url, source):
    """按源转换 URL"""
    rules = SOURCE_MAP.get(source, {})
    for old, new in rules.items():
        url = url.replace(old, new)
    return url


def reverse_rewrite_url(url):
    """反查：把镜像 URL 还原成官方 URL（用于切源）"""
    for src, rules in SOURCE_MAP.items():
        if src == "official":
            continue
        for official, mirror in rules.items():
            if mirror in url:
                return url.replace(mirror, official)
    return url


def compute_sha1(path, chunk_size=65536):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        while True:
            data = f.read(chunk_size)
            if not data:
                break
            h.update(data)
    return h.hexdigest()


def is_important_file(target_path):
    norm = target_path.replace("\\", "/").lower()
    for pat in IMPORTANT_PATTERNS:
        if pat in norm:
            return True
    return False


def format_size(n):
    for unit in ["B", "KB", "MB", "GB"]:
        if n < 1024:
            return f"{n:.2f} {unit}"
        n /= 1024
    return f"{n:.2f} TB"


def _url_host(url):
    """
    从 URL 里提取 host（域名）。
    失败返回 "?"。
    """
    try:
        from urllib.parse import urlsplit
        return urlsplit(url).netloc or "?"
    except Exception:
        return "?"


def _short_url(url, max_len=120):
    """
    URL 太长时截断中间，保留头尾。
    """
    if not url:
        return ""
    if len(url) <= max_len:
        return url
    head = max_len // 2 - 3
    tail = max_len - head - 3
    return url[:head] + "..." + url[-tail:]


# ====================== 获取版本列表 ======================
def fetch_manifest(source="bmclapi"):
    url = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
    url = rewrite_url(url, source)
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    return r.json()


def fetch_version_json(version_url, source="bmclapi"):
    url = rewrite_url(version_url, source)
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    return r.json()


# ====================== 解析文件列表 ======================
def rules_allow(rules, os_name="windows", os_arch="x86_64"):
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


def collect_files(version_json, version_dir, root_path, source):
    """收集所有要下载的文件"""
    files = []

    # 1. client.jar → <版本名>.jar
    version_name = os.path.basename(version_dir)
    client = version_json.get("downloads", {}).get("client", {})
    if client.get("url"):
        files.append({
            "url": rewrite_url(client["url"], source),
            "target": os.path.join(version_dir, f"{version_name}.jar"),
            "sha1": client.get("sha1", ""),
            "size": client.get("size", 0),
            "important": True,
        })

    # 2. libraries
    libs_root = os.path.join(root_path, "libraries")
    for lib in version_json.get("libraries", []):
        if not rules_allow(lib.get("rules")):
            continue
        artifact = lib.get("downloads", {}).get("artifact")
        if artifact and artifact.get("path"):
            url = artifact.get("url")
            if not url:
                continue
            files.append({
                "url": rewrite_url(url, source),
                "target": os.path.join(libs_root, artifact["path"].replace("/", os.sep)),
                "sha1": artifact.get("sha1", ""),
                "size": artifact.get("size", 0),
                "important": True,
            })

    # 3. assetIndex
    asset_index_info = version_json.get("assetIndex", {})
    asset_index_id = asset_index_info.get("id", "")
    if asset_index_id and asset_index_info.get("url"):
        assets_root = os.path.join(root_path, "assets")
        indexes_dir = os.path.join(assets_root, "indexes")
        index_target = os.path.join(indexes_dir, f"{asset_index_id}.json")
        files.append({
            "url": rewrite_url(asset_index_info["url"], source),
            "target": index_target,
            "sha1": asset_index_info.get("sha1", ""),
            "size": asset_index_info.get("size", 0),
            "important": True,
        })

    return files


def collect_asset_objects(asset_index, assets_root, source):
    files = []
    objects = asset_index.get("objects", {})
    for name, info in objects.items():
        h = info.get("hash", "")
        if not h:
            continue
        sub = h[:2]
        url = f"https://resources.download.minecraft.net/{sub}/{h}"
        url = rewrite_url(url, source)
        target = os.path.join(assets_root, "objects", sub, h)
        files.append({
            "url": url,
            "target": target,
            "sha1": h,
            "size": info.get("size", 0),
            "important": False,
        })
    return files


def download_one_file(file_info, base_source="bmclapi", max_retries=5, task_id=None):
    """
    下载一个文件，失败后自动切换源
    返回值: (状态, 字节数)
    task_id: 关联的任务 ID（用于进度统计）
    """
    # ★ 进函数先检查一次是否已取消
    if _is_task_cancelled(task_id):
        return ("cancelled", 0)

    original_url = file_info["url"]
    target = file_info["target"]
    sha1 = file_info.get("sha1", "")
    important = file_info.get("important", False)
    expected_size = file_info.get("size", 0)

    # ============ 日志：短路径 ============
    rel_path = target
    try:
        if "objects" in target:
            rel_path = "assets/" + os.path.basename(target)[:16]
        elif "libraries" in target:
            rel_path = "libs/" + os.path.basename(target)
        else:
            rel_path = os.path.basename(target)
    except Exception:
        pass

    write_download_log(f"[开始] {rel_path}")

    official_url = reverse_rewrite_url(original_url)
    temp = target + ".part"

    # ============ 已存在且大小对 → 跳过 ============
    if os.path.exists(target):
        if expected_size and os.path.getsize(target) == expected_size:
            if important and sha1:
                if compute_sha1(target) == sha1:
                    write_download_log(f"[跳过] {rel_path} (已存在)")
                    mark_skipped(expected_size, task_id)
                    return ("skipped", expected_size)
            else:
                write_download_log(f"[跳过] {rel_path} (已存在)")
                mark_skipped(expected_size, task_id)
                return ("skipped", expected_size)

    os.makedirs(os.path.dirname(target), exist_ok=True)

    last_error = None

    # ★ 源序列
    source_seq = [base_source]
    for s in SOURCE_ORDER:
        if s != base_source and s not in source_seq:
            source_seq.append(s)

    # ★ 如果是 Modrinth CDN，额外加一个域名切换
    #    cdn.modrinth.com ←→ cdn-raw.modrinth.com
    _extra_cdn_urls = []
    if "cdn.modrinth.com" in original_url:
        _extra_cdn_urls.append(original_url.replace("cdn.modrinth.com", "cdn-raw.modrinth.com"))

    from urllib.parse import urlsplit, urlunsplit, quote

    def _encode_path_plus(u):
        """
        只对 URL 的 path 部分做 + → %2B 编码，不动 query/fragment。
        """
        try:
            parts = urlsplit(u)
            # quote path，但保留 / 和已编码的 %
            new_path = quote(parts.path, safe="/%")
            return urlunsplit((parts.scheme, parts.netloc, new_path, parts.query, parts.fragment))
        except Exception:
            return u

    for attempt in range(max_retries):
        # ★ 每 2 次尝试换一次 CDN 域名
        use_raw_cdn = (attempt // 2) % 2 == 1 and _extra_cdn_urls

        current_source = source_seq[attempt % len(source_seq)]
        if use_raw_cdn:
            current_url = _extra_cdn_urls[0]
        else:
            current_url = rewrite_url(official_url, current_source)
        # ★ 修正路径里的 + 编码
        current_url = _encode_path_plus(current_url)
        # ★ 修正 + 编码
        # 这里用更保守的策略：把路径里的 + 替换成 %2B
        # （URL 结构里的 + 极罕见，替换掉不影响）
        current_url = current_url.replace("+", "%2B")

        # 续传
        resume = 0
        if os.path.exists(temp):
            resume = os.path.getsize(temp)
            if expected_size and resume == expected_size:
                if os.path.exists(target):
                    os.remove(target)
                os.rename(temp, target)
                _fsync_file(target)
                write_download_log(f"[完成] {rel_path} (从 .part 移正)")
                mark_downloaded(expected_size, task_id)
                return ("done", expected_size)

        try:
            headers = {}
            if resume > 0:
                headers["Range"] = f"bytes={resume}-"

            with requests.get(current_url, headers=headers, stream=True, timeout=30) as r:
                if r.status_code == 416:
                    resume = 0
                    if os.path.exists(temp):
                        os.remove(temp)
                    raise Exception("Range 416")

                if r.status_code == 404:
                    raise Exception("404 Not Found")

                r.raise_for_status()

                mode = "ab" if resume > 0 else "wb"
                with open(temp, mode) as f:
                    for chunk in r.iter_content(16384):
                        if _is_task_cancelled(task_id):
                            write_download_log(f"[取消] {rel_path}")
                            # ★ 立刻删临时文件
                            try:
                                f.close()
                            except Exception:
                                pass
                            try:
                                if os.path.exists(temp):
                                    os.remove(temp)
                            except Exception:
                                pass
                            return ("cancelled", 0)
                        f.write(chunk)
                        add_progress(len(chunk), task_id)

            # SHA1 校验
            if important and sha1:
                actual = compute_sha1(temp)
                if actual != sha1:
                    if os.path.exists(temp):
                        os.remove(temp)
                    raise Exception(f"SHA1 不符")

            # 移正
            if os.path.exists(target):
                os.remove(target)
            os.rename(temp, target)
            _fsync_file(target)  # ★ 强制刷盘，防止"刚成功却读不到"
            # ★ 成功也显示真实源
            real_host = _url_host(current_url)
            write_download_log(f"[完成] {rel_path} (真实源={real_host})")

            mark_downloaded(expected_size, task_id)
            return ("done", expected_size)

        except Exception as e:
            last_error = str(e)
            # ★ 显示真实源（host）+ 完整 URL
            real_host = _url_host(current_url)
            write_download_log(
                f"[失败] {rel_path} (真实源={real_host}, 基源={current_source}) - {last_error[:120]}"
            )
            write_download_log(f"       URL: {_short_url(current_url)}")
            if task_id:
                with _task_lock(task_id):
                    t = TASKS.get(task_id)
                    if t is not None:
                        t["retry_log"].append(
                            f"重试 {attempt+1}/{max_retries} ({real_host}): {rel_path} - {last_error[:60]}"
                        )
            time.sleep(1)

    write_download_log(f"[彻底失败] {rel_path} - 已重试 {max_retries} 次")
    raise Exception(f"下载失败（已重试 {max_retries} 次）: {last_error}")


def _fsync_file(path):
    """强制把文件刷到磁盘，确保启动器立刻读也能读到完整内容"""
    try:
        with open(path, "rb+") as f:
            os.fsync(f.fileno())
    except Exception:
        pass


# ====================== 任务锁辅助 ======================
def _task_lock(task_id):
    """拿任务锁（如果任务不存在，返回一个空锁，不崩）"""
    with TASKS_LOCK:
        lock = TASK_LOCKS.get(task_id)
    if lock is None:
        lock = threading.Lock()
    return lock


def _is_task_cancelled(task_id):
    if not task_id:
        return False
    with TASKS_LOCK:
        t = TASKS.get(task_id)
    if t is None:
        return True   # 任务被删了当取消
    return bool(t.get("cancel"))


# ====================== 进度累加 ======================
def add_progress(bytes_added, task_id=None):
    """只累加本次真实下载的字节（用于算速度）"""
    if not task_id:
        return
    with _task_lock(task_id):
        t = TASKS.get(task_id)
        if t is None:
            return
        t["actual_downloaded_bytes"] += bytes_added
        t["downloaded_bytes"] += bytes_added


def mark_skipped(size, task_id=None):
    """跳过的文件：计入进度，但不计入速度"""
    if not task_id:
        return
    with _task_lock(task_id):
        t = TASKS.get(task_id)
        if t is None:
            return
        t["skipped_bytes"] += size
        t["downloaded_bytes"] += size
        t["files_skipped"] += 1


def mark_downloaded(size, task_id=None):
    """真正下载完成的文件：只统计数量（字节已由 add_progress 累加）"""
    if not task_id:
        return
    with _task_lock(task_id):
        t = TASKS.get(task_id)
        if t is None:
            return
        t["files_downloaded"] += 1


# ====================== 速度更新线程 ======================
def speed_updater(task_id):
    """每个任务一个速度线程"""
    while True:
        time.sleep(1)
        with _task_lock(task_id):
            t = TASKS.get(task_id)
            if t is None or not t["active"]:
                return
            now = t["actual_downloaded_bytes"]
            last = t.get("last_bytes", 0)
            t["speed"] = now - last
            t["last_bytes"] = now


# ====================== 主下载流程 ======================
def start_download(root_path, version_name, mc_version_id, mc_version_url,
                   source="bmclapi", threads=4, task_id=None):
    """
    主下载流程。
    task_id 为 None 时自动创建一个新任务（兼容旧调用）。
    """
    if task_id is None:
        task_id = create_task(
            task_name=version_name,
            task_type="vanilla",
            root_path=root_path,
            mc_version=mc_version_id,
            source=source,
            threads=threads,
        )

    with _task_lock(task_id):
        t = TASKS.get(task_id)
        if t is None:
            write_download_log(f"[主流程] ❌ 任务不存在: {task_id}")
            return
        t.update({
            "active": True,
            "cancel": False,
            "version": version_name,
            "mc_version": mc_version_id,
            "root_path": root_path,
            "total_bytes": 0,
            "downloaded_bytes": 0,
            "actual_downloaded_bytes": 0,
            "skipped_bytes": 0,
            "speed": 0,
            "current_files": [],
            "files_total": 0,
            "files_done": 0,
            "files_skipped": 0,
            "files_downloaded": 0,
            "error": None,
            "done": False,
            "start_time": time.time(),
            "last_bytes": 0,
            "retry_log": [],
            "failed_count": 0,
            "failed_files": [],
        })

    try:
        # 1. 获取版本 json
        _task_set(task_id, "current_files", ["获取版本信息..."])
        write_download_log(f"[主流程] 开始下载 {version_name} (源={source})")
        write_download_log(f"[主流程] 获取版本信息...")
        version_json = fetch_version_json(mc_version_url, source)

        # 2. 目标目录
        version_dir = os.path.join(root_path, "versions", version_name)
        os.makedirs(version_dir, exist_ok=True)

        # 3. 收集文件
        _task_set(task_id, "current_files", ["解析文件列表..."])
        write_download_log("[主流程] 解析 client / libraries ...")
        files = collect_files(version_json, version_dir, root_path, source)
        write_download_log(f"[主流程] client + libraries: {len(files)} 个文件")

        # 4. 收集 assets
        asset_index_info = version_json.get("assetIndex", {})
        asset_index_id = asset_index_info.get("id", "")
        if asset_index_id:
            write_download_log(f"[主流程] 资源索引 ID: {asset_index_id}")
            assets_root = os.path.join(root_path, "assets")
            indexes_dir = os.path.join(assets_root, "indexes")
            index_file = os.path.join(indexes_dir, f"{asset_index_id}.json")

            if not os.path.exists(index_file):
                _task_set(task_id, "current_files", ["下载资源索引..."])
                write_download_log("[主流程] 资源索引不存在，开始下载...")
                try:
                    download_one_file({
                        "url": rewrite_url(asset_index_info["url"], source),
                        "target": index_file,
                        "sha1": asset_index_info.get("sha1", ""),
                        "size": asset_index_info.get("size", 0),
                        "important": True,
                    }, base_source=source, task_id=task_id)
                except Exception as e:
                    write_download_log(f"[主流程] 资源索引下载失败: {e}")
            else:
                write_download_log("[主流程] 资源索引已存在")

            if os.path.exists(index_file):
                try:
                    with open(index_file, "r", encoding="utf-8") as f:
                        asset_index = json.load(f)
                    asset_files = collect_asset_objects(asset_index, assets_root, source)
                    files.extend(asset_files)
                    write_download_log(f"[主流程] assets objects: {len(asset_files)} 个文件")
                except Exception as e:
                    write_download_log(f"[主流程] 解析资源索引失败: {e}")
            else:
                write_download_log(f"[主流程] 资源索引不存在，跳过 assets")

        # 5. 统计总大小
        total = sum(f.get("size", 0) for f in files)
        print(f"准备下载 {len(files)} 个文件，总大小 {format_size(total)}")
        write_download_log(f"[主流程] 总计 {len(files)} 个文件，总大小 {format_size(total)}")
        with _task_lock(task_id):
            t = TASKS.get(task_id)
            if t is not None:
                t["total_bytes"] = total
                t["files_total"] = len(files)
                t["current_files"] = []

        # 6. 速度线程
        threading.Thread(target=speed_updater, args=(task_id,), daemon=True).start()

        # 7. 并发下载
        failed_files = []
        with ThreadPoolExecutor(max_workers=threads) as pool:
            futures = {pool.submit(download_one_file, f, source, 5, task_id): f for f in files}

            # ★ 用一个标志，取消后不再处理任何 future
            cancelled = False
            for fut in as_completed(futures):
                if _is_task_cancelled(task_id):
                    cancelled = True
                    # ★ 取消所有还没跑的 future
                    for f2 in futures:
                        f2.cancel()
                    # 清掉剩余未完成的，跳出循环
                    break

                f_info = futures[fut]
                try:
                    fut.result()
                except Exception as e:
                    failed_files.append({
                        "path": f_info["target"],
                        "error": str(e)[:200],
                    })
                    with _task_lock(task_id):
                        t = TASKS.get(task_id)
                        if t is not None:
                            t["failed_count"] += 1
                            if len(t["failed_files"]) < 50:
                                t["failed_files"].append(os.path.basename(f_info["target"]))
                with _task_lock(task_id):
                    t = TASKS.get(task_id)
                    if t is not None:
                        t["files_done"] += 1

            # ★ 取消后，等正在跑的线程收到取消信号自己退出
            # （最多等 3 秒，之后强行继续）
            if cancelled:
                import time as _t
                deadline = _t.time() + 3
                while _t.time() < deadline:
                    pending = [f2 for f2 in futures if not f2.done()]
                    if not pending:
                        break
                    _t.sleep(0.1)

        # ★ 等所有文件句柄真正释放（防止启动时读不到 jar）
        time.sleep(0.5)

        # ★ 下载完成统计
        with _task_lock(task_id):
            t = TASKS.get(task_id) or {}
            skipped = t.get("skipped_bytes", 0)
            actual = t.get("actual_downloaded_bytes", 0)
            total_bytes = t.get("total_bytes", 0)
            f_done = t.get("files_done", 0)
            f_total = t.get("files_total", 0)
            f_skip = t.get("files_skipped", 0)
            f_dl = t.get("files_downloaded", 0)

        pct = (actual + skipped) / max(total_bytes, 1) * 100

        write_download_log("=" * 60)
        write_download_log(f"[统计] 总文件数: {f_total}")
        write_download_log(f"[统计] 失败文件数: {len(failed_files)}")
        write_download_log(f"[统计] 本次下载: {format_size(actual)} ({f_dl} 个文件)")
        write_download_log(f"[统计] 已跳过:   {format_size(skipped)} ({f_skip} 个文件)")
        write_download_log(f"[统计] 总大小:   {format_size(total_bytes)}")
        write_download_log(f"[统计] 进度:     {pct:.1f}% ({f_done}/{f_total})")
        if failed_files:
            write_download_log("[统计] 失败列表（前 100 个）:")
            for ff in failed_files[:100]:
                write_download_log(f"  - {ff['path']} : {ff['error'][:100]}")
        write_download_log("=" * 60)

        write_log("INFO", f"下载完成: {version_name}, 失败 {len(failed_files)} 个文件")

        # 8. 写版本 json
        if not _is_task_cancelled(task_id):
            with open(os.path.join(version_dir, f"{version_name}.json"),
                      "w", encoding="utf-8") as f:
                json.dump(version_json, f, ensure_ascii=False, indent=2)

            # 9. 解压 natives
            try:
                from launcher import extract_natives
                libs_root = os.path.join(root_path, "libraries")
                natives_dir = os.path.join(version_dir, f"{version_name}-natives")
                extract_natives(version_json, libs_root, natives_dir)
            except Exception as e:
                print(f"[WARN]natives 解压失败: {e}")

            # 10. 判断是否真的完成
            with _task_lock(task_id):
                t = TASKS.get(task_id)
                if t is not None:
                    if t["failed_count"] == 0:
                        t["done"] = True
                    else:
                        t["error"] = f"[ERROR]{t['failed_count']} 个文件下载失败"
                    t["active"] = False
        else:
            # ★ 取消：清理已下载的文件
            write_download_log(f"[取消] 任务 {task_id} 被取消，开始清理...")

            # 1. 删所有 .part 临时文件
            cleaned = 0
            for f in files:
                temp = f["target"] + ".part"
                try:
                    if os.path.exists(temp):
                        os.remove(temp)
                        cleaned += 1
                except Exception:
                    pass

            # 2. 删已下载完成的文件（本次任务下的）
            removed = 0
            for f in files:
                try:
                    if os.path.exists(f["target"]):
                        os.remove(f["target"])
                        removed += 1
                except Exception:
                    pass

            # 3. 删版本目录本身（如果它只有本次任务下载的内容）
            #    —— 如果目录里还有用户自己的东西，就不要删
            try:
                if os.path.isdir(version_dir):
                    # 只剩空目录的话就删掉
                    remaining = os.listdir(version_dir)
                    if not remaining:
                        os.rmdir(version_dir)
                        write_download_log(f"[取消] 版本目录已清空并删除: {version_dir}")
            except Exception:
                pass

            write_download_log(f"[取消] 清理完成：删了 {cleaned} 个 .part，{removed} 个已下文件")

            with _task_lock(task_id):
                t = TASKS.get(task_id)
                if t is not None:
                    t["cancel"] = True       # ★ 标记为"已取消"
                    t["active"] = False

    except Exception as e:
        with _task_lock(task_id):
            t = TASKS.get(task_id)
            if t is not None:
                t["error"] = str(e)
                t["active"] = False
        write_download_log(f"[主流程][ERROR]致命错误: {e}")
        print(f"[ERROR]下载失败: {e}")


def _task_set(task_id, key, val):
    """给任务设置单个字段（辅助）"""
    if not task_id:
        return
    with _task_lock(task_id):
        t = TASKS.get(task_id)
        if t is not None:
            t[key] = val


def get_progress(task_id=None):
    """
    兼容旧 API：
    - task_id 为空 → 返回最近创建的任务状态（没有则返回空状态）
    """
    with TASKS_LOCK:
        if task_id:
            t = TASKS.get(task_id)
        else:
            # 取最近 start_time 最大的
            if TASKS:
                t = max(TASKS.values(), key=lambda x: x.get("start_time", 0))
            else:
                t = None
    if t is None:
        return {
            "active": False, "cancel": False, "version": "",
            "mc_version": "", "root_path": "",
            "total_bytes": 0, "downloaded_bytes": 0,
            "actual_downloaded_bytes": 0, "skipped_bytes": 0,
            "speed": 0, "current_files": [],
            "files_total": 0, "files_done": 0,
            "files_skipped": 0, "files_downloaded": 0,
            "error": None, "done": False, "start_time": 0,
            "last_bytes": 0, "retry_log": [], "failed_count": 0,
            "failed_files": [],
        }
    return dict(t)


def cancel_download(task_id=None):
    """
    兼容旧 API：
    - task_id 为空 → 取消所有活跃任务
    """
    with TASKS_LOCK:
        if task_id:
            ids = [task_id]
        else:
            ids = [tid for tid, t in TASKS.items() if t.get("active")]
    for tid in ids:
        _task_set(tid, "cancel", True)