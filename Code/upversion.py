# upversion.py —— 一键升级版本（保留原版本，批量升级 Mod）
import os
import time
import shutil
import threading

# ★ Modrinth 查询结果缓存：{(mod_id_or_slug, mc_version, loader): info_or_None}
_RESOLVE_CACHE = {}
_RESOLVE_CACHE_LOCK = threading.Lock()


def upversion_task_worker(task_id, root_path, source_version, target_mc,
                          target_loader, target_name, fabric_loader,
                          source, threads, copy_options):
    """
    一键升级任务 worker。

    流程：
      1. 下载目标 MC 原版到 <root>/versions/<target_name>/
      2. 装 Fabric loader
      3. 读源版本 mods/ 里所有 jar，逐个查 Modrinth 目标版本
      4. 有版本 → 下到新版本 mods/；没版本 → 记进 failed
      5. 按 copy_options 复制 config / resourcepacks / shaderpacks
      6. 把结果写进 TASKS[task_id]["upgrade_result"]
    """
    import core  # ★ 延迟 import 避免循环

    def _set(key, val):
        with core.TASK_LOCKS[task_id]:
            t = core.TASKS.get(task_id)
            if t is not None:
                t[key] = val

    def _cancelled():
        with core.TASK_LOCKS[task_id]:
            t = core.TASKS.get(task_id)
            return t is None or t.get("cancel")

    try:
        # ===== 阶段 1：下载原版 =====
        _set("stage", 1)
        _set("stage_total", 4)
        _set("current_files", [f"下载原版 {target_mc}..."])
        _set("upgrade_result", None)

        core.write_download_log(f"[UpVersion] 获取 manifest 找 {target_mc}")
        mf = core.fetch_manifest(source)
        mc_version_url = ""
        for v in mf.get("versions", []):
            if v.get("id") == target_mc:
                mc_version_url = v.get("url", "")
                break
        if not mc_version_url:
            raise RuntimeError(f"未找到 MC {target_mc} 的版本信息")

        # 检查目标版本名是否已存在
        version_dir = os.path.join(root_path, "versions", target_name)
        if os.path.exists(version_dir):
            raise RuntimeError(f"目标版本名已存在: {target_name}")

        # 起子任务下原版
        sub_task_id = core.create_task(
            task_name=target_name,
            task_type="vanilla",
            root_path=root_path,
            mc_version=target_mc,
            source=source,
            threads=threads,
        )
        core.write_download_log(f"[UpVersion] 起子任务下原版: {sub_task_id}")

        sub_done = threading.Event()

        def _run_sub():
            try:
                core.start_download(
                    root_path, target_name, target_mc, mc_version_url,
                    source, threads, task_id=sub_task_id,
                )
            finally:
                sub_done.set()

        threading.Thread(target=_run_sub, daemon=True).start()

        # 轮询子任务，同步进度到主任务
        _poll_count = 0
        while not sub_done.is_set():
            if _cancelled():
                core.cancel_download(sub_task_id)
                sub_done.wait(timeout=10)
                _set("active", False)
                return
            sub = core.get_task(sub_task_id)
            if sub:
                with core.TASK_LOCKS[task_id]:
                    t = core.TASKS.get(task_id)
                    if t:
                        # ★ 子任务 total_bytes 还没算出来时，保留主任务的占位值
                        sub_tb = sub.get("total_bytes", 0)
                        if sub_tb > 0:
                            t["total_bytes"] = sub_tb
                        t["downloaded_bytes"] = sub.get("downloaded_bytes", 0)
                        t["speed"] = sub.get("speed", 0)
                        t["files_done"] = sub.get("files_done", 0)
                        t["files_total"] = sub.get("files_total", 0)
                        t["current_files"] = sub.get("current_files", [])
            # 每 10 秒（20 × 0.5s）打一条诊断日志
            _poll_count += 1
            if _poll_count % 20 == 0:
                sub = core.get_task(sub_task_id)
                if sub:
                    core.write_download_log(
                        f"[UpVersion] 轮询子任务: tb={sub.get('total_bytes',0)} "
                        f"db={sub.get('downloaded_bytes',0)} "
                        f"files={sub.get('files_done',0)}/{sub.get('files_total',0)} "
                        f"cur={sub.get('current_files',[])[:1]}"
                    )
            time.sleep(0.5)

        sub = core.get_task(sub_task_id)
        if not sub or not sub.get("done"):
            err = (sub or {}).get("error") or "原版下载失败"
            raise RuntimeError(err)

        core.write_download_log("[UpVersion] 原版下载完成")

        # ===== 阶段 2：装 Fabric =====
        _set("stage", 2)
        _set("current_files", [f"安装 Fabric {fabric_loader}..."])
        core.write_download_log(f"[UpVersion] 安装 Fabric {fabric_loader}")

        # 这里要把进度字段清一下，因为 fabric_install_inner 会重置
        with core.TASK_LOCKS[task_id]:
            t = core.TASKS.get(task_id)
            if t:
                t["total_bytes"] = 0
                t["downloaded_bytes"] = 0
                t["files_done"] = 0
                t["files_total"] = 0

        core._fabric_install_worker_inner(
            task_id, root_path, target_name, target_mc,
            fabric_loader, source, threads,
        )

        with core.TASK_LOCKS[task_id]:
            t = core.TASKS.get(task_id)
            fabric_ok = t and t.get("done") and not t.get("error")
        if not fabric_ok:
            raise RuntimeError("Fabric 安装失败")

        core.write_download_log("[UpVersion] Fabric 安装完成")

        # ===== 阶段 3：扫描源 mods =====
        _set("stage", 3)
        _set("done", False)
        _set("active", True)
        _set("current_files", ["扫描源版本 mods..."])

        src_isolated = core.get_version_isolated(root_path, source_version)
        if src_isolated:
            src_mods_dir = os.path.join(root_path, "versions", source_version, "mods")
            src_game_dir = os.path.join(root_path, "versions", source_version)
        else:
            src_mods_dir = os.path.join(root_path, "mods")
            src_game_dir = root_path

        new_ver_dir = os.path.join(root_path, "versions", target_name)
        new_mods_dir = os.path.join(new_ver_dir, "mods")
        os.makedirs(new_mods_dir, exist_ok=True)

        mod_files = []
        if os.path.isdir(src_mods_dir):
            for fn in os.listdir(src_mods_dir):
                if fn.endswith(".jar") or fn.endswith(".jar.disabled"):
                    full = os.path.join(src_mods_dir, fn)
                    if os.path.isfile(full):
                        mod_files.append(fn)

        core.write_download_log(f"[UpVersion] 源版本共 {len(mod_files)} 个 mod")

        wiki = core.load_wiki_entries()

        upgraded = []
        failed = []

        _set("files_total", len(mod_files))
        _set("files_done", 0)
        _set("total_bytes", len(mod_files) * 5 * 1024 * 1024)  # 粗略估算
        _set("downloaded_bytes", 0)

        # ===== 阶段 4：并行升级 =====
        _set("stage", 4)

        # ★ 并发数：Modrinth API 有速率限制，别开太多
        #    4~6 比较稳，超过容易 429
        MAX_WORKERS = 5

        import threading as _th
        _done_lock = _th.Lock()
        _done_count = [0]  # 用列表避免闭包重绑定

        def _incr_done():
            with _done_lock:
                _done_count[0] += 1
                cur = _done_count[0]
            with core.TASK_LOCKS[task_id]:
                t = core.TASKS.get(task_id)
                if t:
                    t["files_done"] = cur

        def _process_one(fn):
            """处理单个 mod：查 Modrinth → 下载 → 记录结果。"""
            if _cancelled():
                return

            src_path = os.path.join(src_mods_dir, fn)

            # 读元数据
            try:
                meta = core._read_jar_meta(src_path)
            except Exception as e:
                with _done_lock:
                    failed.append({
                        "filename": fn,
                        "mod_id": "",
                        "reason": f"读取 jar 失败: {str(e)[:60]}",
                    })
                _incr_done()
                return

            mod_id = meta.get("mod_id", "")
            slug = meta.get("slug", "")

            # 查 Modrinth（网络请求，并行化收益最大）
            info = _resolve_modrinth(core, mod_id, slug, target_mc, target_loader)

            if not info:
                with _done_lock:
                    failed.append({
                        "filename": fn,
                        "mod_id": mod_id,
                        "reason": "Modrinth 上没有对应版本" if (mod_id or slug) else "无法识别 Mod ID",
                    })
                _incr_done()
                return

            # 决定新文件名（保持 disabled 状态）
            was_disabled = fn.endswith(".jar.disabled")
            new_filename = info["filename"]
            if was_disabled and not new_filename.endswith(".disabled"):
                new_filename += ".disabled"

            target_path = os.path.join(new_mods_dir, new_filename)

            try:
                core.write_download_log(
                    f"[UpVersion] 下载 mod: {fn} → {new_filename} "
                    f"(Modrinth v{info.get('modrinth_version', '?')})"
                )
                core.download_one_file({
                    "url": info["url"],
                    "target": target_path,
                    "sha1": info["sha1"],
                    "size": info["size"],
                    "important": False,
                }, base_source=source, max_retries=3, task_id=task_id)

                with _done_lock:
                    upgraded.append({
                        "old_filename": fn,
                        "new_filename": new_filename,
                        "mod_id": mod_id,
                        "modrinth_version": info.get("modrinth_version", ""),
                        "title_cn": wiki.get(mod_id.lower(), "") if mod_id else "",
                    })
            except Exception as e:
                with _done_lock:
                    failed.append({
                        "filename": fn,
                        "mod_id": mod_id,
                        "reason": f"下载失败: {str(e)[:80]}",
                    })

            _incr_done()

        # ★ 用线程池并行处理
        from concurrent.futures import ThreadPoolExecutor, as_completed
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as _pool:
            _futures = {_pool.submit(_process_one, fn): fn for fn in mod_files}
            for _fut in as_completed(_futures):
                if _cancelled():
                    # 取消：不再处理新结果，但已提交的无法中止
                    core.write_download_log(f"[UpVersion] 用户取消，已处理 {_done_count[0]}/{len(mod_files)}")
                    # 清掉队列里还没跑的
                    for _f in _futures:
                        _f.cancel()
                    break
                try:
                    _fut.result()
                except Exception as _e:
                    core.write_download_log(f"[UpVersion] worker 异常: {_e}")

        core.write_download_log(
            f"[UpVersion] Mod 升级完成：成功 {len(upgraded)}，失败 {len(failed)}"
        )

        # ===== 阶段 5：可选复制 =====
        if copy_options.get("copy_config"):
            _set("current_files", ["复制 config..."])
            try:
                src_cfg = os.path.join(src_game_dir, "config")
                dst_cfg = os.path.join(new_ver_dir, "config")
                if os.path.isdir(src_cfg):
                    shutil.copytree(src_cfg, dst_cfg, dirs_exist_ok=True)
                    core.write_download_log("[UpVersion] config 复制完成")
            except Exception as e:
                core.write_log("WARN", f"复制 config 失败: {e}")

        if copy_options.get("copy_resourcepacks"):
            _set("current_files", ["复制 resourcepacks..."])
            try:
                src_rp = os.path.join(src_game_dir, "resourcepacks")
                dst_rp = os.path.join(new_ver_dir, "resourcepacks")
                if os.path.isdir(src_rp):
                    shutil.copytree(src_rp, dst_rp, dirs_exist_ok=True)
                    core.write_download_log("[UpVersion] resourcepacks 复制完成")
            except Exception as e:
                core.write_log("WARN", f"复制 resourcepacks 失败: {e}")

        if copy_options.get("copy_shaderpacks"):
            _set("current_files", ["复制 shaderpacks..."])
            try:
                src_sp = os.path.join(src_game_dir, "shaderpacks")
                dst_sp = os.path.join(new_ver_dir, "shaderpacks")
                if os.path.isdir(src_sp):
                    shutil.copytree(src_sp, dst_sp, dirs_exist_ok=True)
                    core.write_download_log("[UpVersion] shaderpacks 复制完成")
            except Exception as e:
                core.write_log("WARN", f"复制 shaderpacks 失败: {e}")

        # ===== 完成 =====
        with core.TASK_LOCKS[task_id]:
            t = core.TASKS.get(task_id)
            if t is not None:
                t["upgrade_result"] = {
                    "target_name": target_name,
                    "target_mc": target_mc,
                    "target_loader": target_loader,
                    "total": len(mod_files),
                    "upgraded": upgraded,
                    "failed": failed,
                }
                t["done"] = True
                t["active"] = False
                t["current_files"] = []

    except Exception as e:
        import traceback
        core.write_download_log(
            f"[UpVersion] [ERROR] 失败: {e}\n{traceback.format_exc()}"
        )
        core.write_log("ERROR", f"升级任务失败: {e}")
        with core.TASK_LOCKS[task_id]:
            t = core.TASKS.get(task_id)
            if t is not None:
                t["error"] = str(e)
                t["active"] = False


def _resolve_modrinth(core, mod_id, slug, mc_version, loader):
    """
    查一个 mod 在目标 MC + 加载器下有没有可用版本。
    返回 {"url", "filename", "sha1", "size", "modrinth_version"} 或 None
    ★ 带内存缓存，同一 (mod_id/slug, mc, loader) 只查一次
    """
    cache_key = (mod_id or slug or "", mc_version, loader)
    with _RESOLVE_CACHE_LOCK:
        if cache_key in _RESOLVE_CACHE:
            return _RESOLVE_CACHE[cache_key]

    result = None
    try:
        if not slug and mod_id:
            hits = core.modrinth_search(mod_id, limit=5, offset=0,
                                         game_version=mc_version, loader=loader)
            for h in hits.get("hits", []):
                title = (h.get("title") or "").lower()
                slug2 = (h.get("slug") or "").lower()
                if mod_id.lower() == slug2 or mod_id.lower() in title:
                    slug = h.get("slug", "")
                    break
            if not slug and hits.get("hits"):
                slug = hits["hits"][0].get("slug", "")

        if slug:
            versions = core.modrinth_project_versions(
                slug, game_version=mc_version, loader=loader
            )
            if versions:
                for v in versions:
                    f = core._pick_primary_file(v.get("files", []))
                    if not f:
                        continue
                    result = {
                        "url": f.get("url", ""),
                        "filename": f.get("filename", ""),
                        "sha1": (f.get("hashes", {}) or {}).get("sha1", ""),
                        "size": f.get("size", 0),
                        "modrinth_version": v.get("version_number", ""),
                    }
                    break
    except Exception as e:
        core.write_log("WARN", f"升级 mod 查询失败 {mod_id or slug}: {e}")
        result = None

    with _RESOLVE_CACHE_LOCK:
        _RESOLVE_CACHE[cache_key] = result
    return result
