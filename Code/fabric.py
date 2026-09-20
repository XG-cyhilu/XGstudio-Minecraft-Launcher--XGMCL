# fabric.py —— Fabric loader 查询 + 版本 JSON 合并
import requests
import time

# Fabric Meta API 基础地址
FABRIC_META = "https://meta.fabricmc.net/v2"

# 缓存 loader 列表，避免频繁请求（key=mc_version, value=(时间戳, 列表)）
_LOADER_CACHE = {}
_CACHE_TTL = 300  # 5 分钟

# 镜像源（Fabric Meta 没有官方镜像，但 BMCLAPI 有代理）
FABRIC_META_MIRROR = "https://bmclapi2.bangbang93.com/fabric-meta/v2"


def _get(url, timeout=15):
    """统一的 GET 请求，带镜像回退"""
    try:
        r = requests.get(url, timeout=timeout)
        r.raise_for_status()
        return r.json()
    except Exception:
        return None


def fetch_fabric_loaders(mc_version):
    """
    获取指定 MC 版本可用的 Fabric loader 列表。
    只返回最新 5 个（按 Fabric Meta 默认顺序，最新的在前）。
    返回格式：
        [{"version": "0.19.5", "stable": true}, ...]
    """
    if not mc_version:
        raise ValueError("mc_version 不能为空")

    # 缓存命中
    now = time.time()
    if mc_version in _LOADER_CACHE:
        ts, data = _LOADER_CACHE[mc_version]
        if now - ts < _CACHE_TTL:
            return data

    # 官方源优先，失败切镜像
    urls = [
        f"{FABRIC_META}/versions/loader/{mc_version}",
        f"{FABRIC_META_MIRROR}/versions/loader/{mc_version}",
    ]

    raw = None
    last_err = None
    for url in urls:
        try:
            raw = _get(url)
            if raw is not None:
                break
        except Exception as e:
            last_err = e
            continue

    if raw is None:
        raise RuntimeError(f"无法获取 Fabric loader 列表（官方和镜像都失败）: {last_err}")

    # Fabric Meta 返回的是一个列表，每项包含 loader 信息
    # 结构：[{ "loader": {"version": "...", "stable": true}, "intermediary": {...}, "launcherMeta": {...} }, ...]
    # 但 /versions/loader/{mc} 返回的是：
    # [{ "loader": {"version": "0.19.5", "stable": true}, ... }]
    # 有些版本返回的是简化格式，做兼容处理。
    loaders = []
    for item in raw:
        loader_info = item.get("loader") if isinstance(item, dict) else None
        if loader_info and isinstance(loader_info, dict):
            loaders.append({
                "version": loader_info.get("version", ""),
                "stable": bool(loader_info.get("stable", False)),
            })
        elif isinstance(item, dict) and item.get("version"):
            # 兜底：可能是简化格式
            loaders.append({
                "version": item.get("version", ""),
                "stable": bool(item.get("stable", False)),
            })

    # 只取最新 5 个（Fabric Meta 默认最新在前）
    loaders = loaders[:5]

    # 写缓存
    _LOADER_CACHE[mc_version] = (now, loaders)
    return loaders


def fetch_fabric_profile(mc_version, loader_version):
    """
    获取 Fabric 的 profile JSON（包含 libraries、mainClass 等）。
    返回 dict，失败抛异常。
    """
    if not mc_version or not loader_version:
        raise ValueError("mc_version / loader_version 不能为空")

    urls = [
        f"{FABRIC_META}/versions/loader/{mc_version}/{loader_version}/profile/json",
        f"{FABRIC_META_MIRROR}/versions/loader/{mc_version}/{loader_version}/profile/json",
    ]

    last_err = None
    for url in urls:
        try:
            data = _get(url, timeout=20)
            if data is not None:
                return data
        except Exception as e:
            last_err = e
            continue

    raise RuntimeError(f"无法获取 Fabric profile: {last_err}")


def merge_fabric_json(vanilla_json, fabric_profile, loader_version, mc_version):
    """
    合并原版 version.json 和 Fabric profile.json，生成一个完整可启动的 JSON。
    - mainClass 用 Fabric 的
    - libraries = vanilla.libraries + fabric.libraries
    - 保留 vanilla 的 assetIndex / downloads / arguments
    - 加标识：XGMCL_LOADER = "fabric"
    """
    import copy
    merged = copy.deepcopy(vanilla_json)

    # 1. mainClass 用 Fabric 的
    merged["mainClass"] = fabric_profile.get("mainClass", merged.get("mainClass", ""))

    # 2. libraries 合并（Fabric 的在前，避免被原版覆盖）
    vanilla_libs = merged.get("libraries", []) or []
    fabric_libs = fabric_profile.get("libraries", []) or []
    merged["libraries"] = fabric_libs + vanilla_libs

    # 3. 保留原版 assetIndex / downloads / assets / arguments / complianceLevel
    #    （copy.deepcopy 已经保留了，这里不动）

    # 4. 记录 Fabric 标识（给启动器和 parse_version_info 识别用）
    merged["XGMCL_LOADER"] = "fabric"
    merged["XGMCL_FABRIC_VERSION"] = loader_version
    merged["XGMCL_MC_VERSION"] = mc_version

    # 5. 保留原版的 id 字段（PCL 靠它识别）
    #    但 Fabric profile 里可能有自己的 id，这里以原版的为准
    if "id" not in merged and "id" in fabric_profile:
        merged["id"] = fabric_profile["id"]

    # 6. arguments 合并：Fabric profile 通常不带 arguments，以原版为准
    #    如果 Fabric 带了 jvm/game 参数，可以追加（目前 Fabric 不带，先保留原版）
    if "arguments" not in merged:
        merged["arguments"] = vanilla_json.get("arguments", {})

    return merged


if __name__ == "__main__":
    # 自测
    print("测试 fetch_fabric_loaders('1.20.1'):")
    try:
        ls = fetch_fabric_loaders("1.20.1")
        for l in ls:
            print(f"  {l['version']}  stable={l['stable']}")
    except Exception as e:
        print(f"  失败: {e}")

    print("\n测试 fetch_fabric_profile('1.20.1', '0.15.11'):")
    try:
        p = fetch_fabric_profile("1.20.1", "0.15.11")
        print(f"  mainClass = {p.get('mainClass')}")
        print(f"  libraries 数量 = {len(p.get('libraries', []))}")
    except Exception as e:
        print(f"  失败: {e}")
