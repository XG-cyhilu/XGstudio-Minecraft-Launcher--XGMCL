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

// systeminfo.js —— 系统信息采集 + 硬件评价
//
// 设计原则：
// 1. 所有 WMI / 子进程查询都带超时，任何一块失败都不阻塞整体
// 2. si.xxx() 老机器上可能极慢，用 Promise.race + 超时兜底
// 3. 能不用 execFile 就不用，减少杀软误报和进程堆积
// 4. 采集结果缓存 10 秒，反复刷新不重复采

const os = require("os");
const { app } = require("electron");
const { execFile } = require("child_process");
const si = require("systeminformation");
const xgmclLog = require("./xgmcl_log.js");

// ============================================================
// 工具
// ============================================================

function bytesToGB(n) {
  if (!n || n <= 0) return "0.0";
  return (n / 1024 / 1024 / 1024).toFixed(1);
}

// 给 Promise 加超时，超时/异常都返回 fallback
function withTimeout(promise, ms, fallback, name) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        xgmclLog.writeLog("WARN", `[SysInfo] ${name} 超时 ${ms}ms，用兜底值`);
        resolve(fallback);
      }
    }, ms);

    Promise.resolve(promise)
      .then((v) => {
        if (!done) { done = true; clearTimeout(timer); resolve(v); }
      })
      .catch((e) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          xgmclLog.writeLog("WARN", `[SysInfo] ${name} 异常: ${e.message}`);
          resolve(fallback);
        }
      });
  });
}

// 给 si.xxx() 加超时（返回 null 表示失败）
function siWithTimeout(promise, ms, name) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        xgmclLog.writeLog("WARN", `[SysInfo] ${name} 超时 ${ms}ms`);
        resolve(null);
      }
    }, ms);
    Promise.resolve(promise)
      .then((v) => {
        if (!done) { done = true; clearTimeout(timer); resolve(v); }
      })
      .catch((e) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          xgmclLog.writeLog("WARN", `[SysInfo] ${name} 异常: ${e.message}`);
          resolve(null);
        }
      });
  });
}

// ============================================================
// 显卡厂商判定
// ============================================================

function isNvidia(vendor, model) {
  const s = `${vendor} ${model}`.toLowerCase();
  return s.includes("nvidia") || s.includes("geforce") || s.includes("rtx") || s.includes("gtx");
}

function isAmd(vendor, model) {
  const s = `${vendor} ${model}`.toLowerCase();
  return s.includes("amd") || s.includes("radeon") || s.includes("rx ");
}

function isIntel(vendor, model) {
  const s = `${vendor} ${model}`.toLowerCase();
  return s.includes("intel") || s.includes("uhd") || s.includes("iris");
}

// ============================================================
// 子进程兜底查询（都带超时）
// ============================================================

// 查 N 卡显存 used / total（MB）
function queryNvidiaSmi() {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 3000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        const result = [];
        for (const line of lines) {
          const parts = line.split(",").map((s) => parseInt(s.trim(), 10));
          if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            result.push({ usedMB: parts[0], totalMB: parts[1] });
          }
        }
        resolve(result.length ? result : null);
      }
    );
  });
}

// 用 wmic 查 CPU（型号 + 核数 + 最大频率）
function queryWmicCpu() {
  return new Promise((resolve) => {
    execFile(
      "wmic",
      ["cpu", "get", "Name,NumberOfCores,MaxClockSpeed,CurrentClockSpeed", "/format:list"],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);

        const blocks = [];
        let cur = {};
        for (const line of stdout.split(/\r?\n/)) {
          const t = line.trim();
          if (!t) {
            if (cur.Name) { blocks.push(cur); cur = {}; }
            continue;
          }
          const idx = t.indexOf("=");
          if (idx < 0) continue;
          const k = t.slice(0, idx);
          const v = t.slice(idx + 1);
          if (k === "Name") cur.Name = v;
          else if (k === "NumberOfCores") cur.NumberOfCores = parseInt(v, 10) || 0;
          else if (k === "MaxClockSpeed") cur.MaxClockSpeed = parseInt(v, 10) || 0;
          else if (k === "CurrentClockSpeed") cur.CurrentClockSpeed = parseInt(v, 10) || 0;
        }
        if (cur.Name) blocks.push(cur);

        if (blocks.length === 0) return resolve(null);
        const b = blocks[0];

        resolve({
          name: b.Name || "",
          cores: b.NumberOfCores || 0,
          baseGHz: 0,
          boostGHz: b.MaxClockSpeed ? b.MaxClockSpeed / 1000 : 0,
          nowGHz: b.CurrentClockSpeed ? b.CurrentClockSpeed / 1000 : 0,
        });
      }
    );
  });
}

// 用 wmic 查显卡
function queryWmicGpu() {
  return new Promise((resolve) => {
    execFile(
      "wmic",
      ["path", "win32_VideoController", "get",
       "Name,AdapterRAM,DriverVersion,DriverDate", "/format:list"],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);

        const blocks = [];
        let cur = {};
        for (const line of stdout.split(/\r?\n/)) {
          const t = line.trim();
          if (!t) {
            if (cur.Name) { blocks.push(cur); cur = {}; }
            continue;
          }
          const idx = t.indexOf("=");
          if (idx < 0) continue;
          const k = t.slice(0, idx);
          const v = t.slice(idx + 1);
          if (k === "Name") cur.Name = v;
          else if (k === "AdapterRAM") cur.AdapterRAM = parseInt(v, 10) || 0;
          else if (k === "DriverVersion") cur.DriverVersion = v;
          else if (k === "DriverDate") cur.DriverDate = v;
        }
        if (cur.Name) blocks.push(cur);

        const result = [];
        for (const b of blocks) {
          if (!b.Name) continue;
          const model = b.Name;
          const vendor = isNvidia("", model) ? "NVIDIA"
                       : isAmd("", model) ? "AMD"
                       : isIntel("", model) ? "Intel"
                       : "";
          result.push({
            vendor,
            model,
            vramTotalMB: b.AdapterRAM ? Math.floor(b.AdapterRAM / 1024 / 1024) : 0,
            driver: b.DriverVersion || "",
            driverDate: b.DriverDate || "",
            isNvidia: isNvidia("", model),
            isAmd: isAmd("", model),
            isIntel: isIntel("", model),
            vramUsedMB: 0,
            vramReadable: false,
          });
        }
        resolve(result);
      }
    );
  });
}

// 从 Electron 拿 GPU / OpenGL 信息
async function getOpenGLInfo() {
  try {
    // basic 级别：快，含 glVersion / glRenderer 等
    const info = await app.getGPUInfo("complete");
    xgmclLog.writeLog("INFO", `[SysInfo] getGPUInfo 原始返回: ${JSON.stringify(info).slice(0, 2000)}`);
    const aux = (info && info.auxAttributes) || {};

    return {
      glVersion: aux.glVersion || "",
      glRenderer: aux.glRenderer || "",
      glVendor: aux.glVendor || "",
      glDriverVersion: aux.glDriverVersion || "",
      // 有些平台上 gpuDevice 里有更直接的字段
      gpuDevice: (info && info.gpuDevice) || [],
    };
  } catch (e) {
    xgmclLog.writeLog("WARN", `[SysInfo] getGPUInfo 失败: ${e.message}`);
    return null;
  }
}

// 用 wmic 查逻辑盘（盘符 + 容量）
function queryWmicDisks() {
  return new Promise((resolve) => {
    execFile(
      "wmic",
      ["logicaldisk", "get", "DeviceID,Size,FreeSpace,FileSystem,DriveType", "/format:list"],
      { timeout: 6000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) {
          xgmclLog.writeLog("WARN", `[SysInfo] wmic 磁盘失败: ${err ? err.message : "无输出"}`);
          return resolve([]);
        }

        // 遇到 DeviceID 就开新块，不依赖空行
        const drives = [];
        let cur = {};

        function flush() {
          if (!cur.DeviceID) return;
          if (cur.DriveType === 3 || cur.DriveType === 2) {
            if (cur.Size) {
              const free = cur.FreeSpace || 0;
              const used = cur.Size - free;
              const usePct = cur.Size > 0 ? (used / cur.Size * 100) : 0;
              drives.push({
                mount: cur.DeviceID + "\\",
                fs: cur.DeviceID,
                type: cur.FileSystem || "",
                sizeBytes: cur.Size,
                usedBytes: used,
                freeBytes: free,
                sizeGB: bytesToGB(cur.Size),
                usedGB: bytesToGB(used),
                freeGB: bytesToGB(free),
                usedPercent: usePct.toFixed(0),
              });
            }
          }
          cur = {};
        }

        for (const line of stdout.split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;

          const idx = t.indexOf("=");
          if (idx < 0) continue;
          const k = t.slice(0, idx);
          const v = t.slice(idx + 1);

          if (k === "DeviceID") {
            flush();
            cur.DeviceID = v;
          } else if (k === "Size") {
            cur.Size = parseInt(v, 10) || 0;
          } else if (k === "FreeSpace") {
            cur.FreeSpace = parseInt(v, 10) || 0;
          } else if (k === "FileSystem") {
            cur.FileSystem = v;
          } else if (k === "DriveType") {
            cur.DriveType = parseInt(v, 10) || 0;
          }
        }
        flush();

        xgmclLog.writeLog("INFO", `[SysInfo] wmic 磁盘解析出 ${drives.length} 个: ${JSON.stringify(drives.map(d => d.mount))}`);
        resolve(drives);
      }
    );
  });
}


// 采集


async function getCpu() {
  const _t0 = Date.now();
  let cpu = await siWithTimeout(si.cpu(), 2000, "si.cpu");
  xgmclLog.writeLog("INFO", `[SysInfo] si.cpu 返回: ${cpu ? JSON.stringify({ brand: cpu.brand, speed: cpu.speed, speedMax: cpu.speedMax, physicalCores: cpu.physicalCores }) : "null"} (${Date.now() - _t0}ms)`);

  // si 失败 → wmic 兜底
  if (!cpu) {
    xgmclLog.writeLog("INFO", "[SysInfo] si.cpu 失败，调 wmic 兜底");
    const w = await queryWmicCpu();
    xgmclLog.writeLog("INFO", `[SysInfo] wmic 返回: ${w ? JSON.stringify(w) : "null"}`);
    if (w) {
      return {
        manufacturer: "",
        brand: w.name,
        physicalCores: w.cores,
        cores: w.cores,
        baseGHz: w.baseGHz,
        boostGHz: w.boostGHz,
        nowGHz: w.nowGHz,
      };
    }
    return {
      manufacturer: "",
      brand: "未知处理器（采集超时）",
      physicalCores: 0, cores: 0,
      baseGHz: 0, boostGHz: 0, nowGHz: 0,
    };
  }

  // 睿频：优先 speedMax
  let boostGHz = 0;
  if (cpu.speedMax && cpu.speedMax > 0) boostGHz = cpu.speedMax;

  let baseGHz = cpu.speed || 0;
  let nowGHz = 0;

  // 全 0 → wmic 兜底
  if (baseGHz === 0 && boostGHz === 0 && nowGHz === 0) {
    xgmclLog.writeLog("INFO", "[SysInfo] si 频率全 0，调 wmic 兜底");
    const w = await queryWmicCpu();
    xgmclLog.writeLog("INFO", `[SysInfo] wmic 返回: ${w ? JSON.stringify(w) : "null"}`);
    if (w) {
      boostGHz = w.boostGHz;
      nowGHz = w.nowGHz;
      xgmclLog.writeLog("INFO", `[SysInfo] si 频率全 0，用 wmic: boost=${boostGHz}, now=${nowGHz}`);
    }
  }

  return {
    manufacturer: cpu.manufacturer || "",
    brand: (cpu.brand || "").trim(),
    physicalCores: cpu.physicalCores || 0,
    cores: cpu.cores || 0,
    baseGHz,
    boostGHz,
    nowGHz,
  };
}

async function getGpu() {
  // ★ 老机器上 si.graphics 极慢且经常超时，直接用 wmic
  let controllers = await queryWmicGpu();

  // wmic 也失败才试 si（这时 si 是最后希望）
  if (!controllers || controllers.length === 0) {
    xgmclLog.writeLog("INFO", "[SysInfo] wmic 显卡失败，试 si.graphics");
    const g = await siWithTimeout(si.graphics(), 5000, "si.graphics");
    if (g && g.controllers && g.controllers.length) {
      controllers = g.controllers.map((c) => ({
        vendor: c.vendor || "",
        model: (c.model || "").trim(),
        vramTotalMB: c.vram || 0,
        driver: c.driverVersion || "",
        driverDate: c.driverDate || "",
        isNvidia: isNvidia(c.vendor, c.model),
        isAmd: isAmd(c.vendor, c.model),
        isIntel: isIntel(c.vendor, c.model),
        vramUsedMB: 0,
        vramReadable: false,
      }));
    }
  }

  // N 卡显存实时数据
  const hasNvidia = controllers.some((c) => c.isNvidia);
  if (hasNvidia) {
    const nvSmi = await queryNvidiaSmi();
    if (nvSmi) {
      let idx = 0;
      for (const c of controllers) {
        if (c.isNvidia && idx < nvSmi.length) {
          c.vramUsedMB = nvSmi[idx].usedMB;
          if (nvSmi[idx].totalMB) c.vramTotalMB = nvSmi[idx].totalMB;
          c.vramReadable = true;
          idx++;
        }
      }
    }
  }

  return controllers;
}

async function getMemory() {
  // ★ os 模块同步读取，微秒级，不走 si（si.mem 老机器超时）
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;

  return {
    totalBytes: total,
    usedBytes: used,
    freeBytes: free,
    totalGB: bytesToGB(total),
    usedGB: bytesToGB(used),
  };
}

async function getDisks() {
  // ★ 优先 wmic（快），失败才试 si.fsSize
  let drives = await queryWmicDisks();

  if (drives.length === 0) {
    xgmclLog.writeLog("INFO", "[SysInfo] wmic 磁盘失败，试 si.fsSize");
    const fsSize = await siWithTimeout(si.fsSize(), 5000, "si.fsSize");
    for (const f of fsSize || []) {
      const mount = f.mount || "";
      const fs = (f.fs || "").toLowerCase();
      if (fs.startsWith("tmpfs") || fs.startsWith("devfs") || fs.startsWith("overlay")) continue;
      if (mount.startsWith("/System") || mount.startsWith("/private")) continue;
      drives.push({
        mount,
        fs: f.fs || "",
        type: f.type || "",
        sizeBytes: f.size || 0,
        usedBytes: f.used || 0,
        freeBytes: (f.size || 0) - (f.used || 0),
        sizeGB: bytesToGB(f.size),
        usedGB: bytesToGB(f.used),
        freeGB: bytesToGB((f.size || 0) - (f.used || 0)),
        usedPercent: (f.use || 0).toFixed(0),
      });
    }
  }

  return { physicalDisks: [], drives };
}


// 评价


function rateCpu(cpu) {
  const cores = cpu.physicalCores || 0;
  const base = cpu.baseGHz || 0;
  const boost = cpu.boostGHz || 0;
  const boostKnown = boost > 0;

  let text = "";
  let note = boostKnown ? "" : "（睿频未读到，仅按基频判）";

  if (cores >= 8 && boostKnown && boost > 4.8 && base > 3.4) {
    text = "超强，整合包随便玩";
  } else if (cores >= 4 && boostKnown && boost > 4.5 && base > 3.2) {
    text = "强，推荐 350 mod 以下（如果其他硬件允许）";
  } else if (cores >= 4 && ((boostKnown && boost >= 3.6) || base > 2.9)) {
    text = "够用，300 mod 能玩但不会非常流畅（150FPS 以下）";
  } else if (cores === 2 && ((boostKnown && boost >= 3.6) || base > 2.9)) {
    text = "能玩 300 mod 的包但估计只有 30~60FPS，TPS 大部分时间在 14~18";
  } else if (cores === 2 && boostKnown && boost < 3.6) {
    text = "拉了，建议玩 150 mod 以下的包";
  } else {
    if (cores >= 4) {
      text = "够用，300 mod 能玩但不会非常流畅（150FPS 以下）";
    } else {
      text = "偏弱，建议玩 150 mod 以下的包";
    }
    if (!boostKnown) note = "（睿频未读到，按核数与基频估判）";
  }

  return text + note;
}

function rateGpu(g) {
  if (g.isAmd) return "驱动可能有问题";
  if (!g.isNvidia) return "";

  const m = (g.model || "").toUpperCase().replace(/\s+/g, "");

  if (
    m.includes("RTX4090") || m.includes("RTX4080") ||
    m.includes("RTX4070TI") ||
    m.includes("RTX5070") || m.includes("RTX5080") || m.includes("RTX5090") ||
    m.includes("RTX3090")
  ) {
    return "随便开光影或材质包";
  }

  if (
    m.includes("RTX5060") || m.includes("RTX5050") ||
    m.includes("RTX4060") || (m.includes("RTX4070") && !m.includes("4070TI")) ||
    m.includes("RTX3080")
  ) {
    return "能流畅玩大部分光影和材质包，不推荐 4K 或高配光追";
  }

  if (/RTX30[0-7]0/.test(m) || m.includes("RTX3070") || m.includes("RTX3060") ||
      m.includes("RTX3050") || /RTX20[0-9]0/.test(m)) {
    return "能开光追，但不推荐，推荐中配及以下的光栅化光影";
  }

  return "不推荐开光影，或选择低配光栅化光影";
}

function rateRam(mem) {
  const gb = parseFloat(mem.totalGB) || 0;

  if (gb >= 16) return "充裕，可以最高分配给 Minecraft 13GB，但如果 CPU 够用的话日常分配 8GB 足矣";
  if (gb >= 8)  return "能用，可以最高分配 6GB，CPU 够用的话推荐 4~5GB";
  if (gb >= 4)  return "紧张，只能分配 2~3GB，推荐 2GB 玩玩原版轻量优化包";
  if (gb >= 2)  return "只能玩原版，不建议玩 Minecraft";
  return "内存过低，不建议运行 Minecraft";
}

function rateDisk(disks) {
  const drives = disks.drives || [];
  if (drives.length === 0) {
    return { text: "未检测到磁盘", tip: "" };
  }

  let cDrive = drives.find((d) => /^C:\\?$/i.test(d.mount));
  if (!cDrive) cDrive = drives.find((d) => d.mount === "/");

  const cFreeGB = cDrive ? parseFloat(cDrive.freeGB) : -1;

  const bigDrives = drives.filter((d) => parseFloat(d.freeGB) >= 50);
  const okDrives  = drives.filter((d) => parseFloat(d.freeGB) >= 10);
  const midDrives = drives.filter((d) => {
    const g = parseFloat(d.freeGB);
    return g >= 10 && g < 50;
  });

  let text = "";
  if (bigDrives.length > 0 && cFreeGB > 20) {
    text = "充足";
  } else if ((bigDrives.length > 0 || midDrives.length > 0) && cFreeGB > 20) {
    text = "够用";
  } else if (okDrives.length === 0) {
    text = "赶紧清理";
  } else if (cFreeGB >= 0 && cFreeGB <= 20) {
    text = "C 盘空间紧张，建议清理";
  } else {
    text = "够用";
  }

  let tip = "";
  if (bigDrives.length === 1) {
    tip = `建议把版本 / 存档放到 ${bigDrives[0].mount}（剩余 ${bigDrives[0].freeGB} GB）`;
  }

  return { text, tip };
}

// ============================================================
// 采集 + 组装
// ============================================================

// 缓存：10 秒内重复请求直接返回
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 10000;

async function collectAll(force) {
  const now = Date.now();
  if (!force && _cache && now - _cacheTime < CACHE_TTL) {
    xgmclLog.writeLog("INFO", "[SysInfo] 命中缓存");
    return _cache;
  }

  const t0 = Date.now();

  try {
    const [cpu, gpu, memory, disks, glInfo] = await Promise.all([
      withTimeout(getCpu(),       8000, null, "CPU"),
      withTimeout(getGpu(),       12000, [],   "GPU"),
      withTimeout(getMemory(),    3000, null, "Memory"),
      withTimeout(getDisks(),     6000, { physicalDisks: [], drives: [] }, "Disks"),
      withTimeout(getOpenGLInfo(), 8000, null, "OpenGL"),
    ]);

    // 兜底
    const safeCpu = cpu || {
      manufacturer: "", brand: "采集超时",
      physicalCores: 0, cores: 0,
      baseGHz: 0, boostGHz: 0, nowGHz: 0,
    };
    const safeMem = memory || {
      totalBytes: 0, usedBytes: 0, freeBytes: 0,
      totalGB: "0.0", usedGB: "0.0",
    };
    const safeDisks = disks || { physicalDisks: [], drives: [] };

    // 给每张显卡加评价
    for (const g of gpu) {
      g.verdict = rateGpu(g);
    }

    const cpuVerdict  = rateCpu(safeCpu);
    const ramVerdict  = rateRam(safeMem);
    const diskVerdict = rateDisk(safeDisks);

    const result = {
      code: 200,
      data: {
        cpu: { ...safeCpu, verdict: cpuVerdict },
        gpu,
        memory: { ...safeMem, verdict: ramVerdict },
        disks: { ...safeDisks, verdict: diskVerdict },
        gl: glInfo || { glVersion: "", glRenderer: "", glVendor: "", glDriverVersion: "" },
      },
    };

    _cache = result;
    _cacheTime = now;
    xgmclLog.writeLog("INFO", `[SysInfo] 采集完成，总耗时 ${Date.now() - t0}ms`);

    return result;
  } catch (e) {
    xgmclLog.writeLog("ERROR", `[SysInfo] 采集失败（${Date.now() - t0}ms）: ${e.message}`);
    return { code: 500, msg: e.message };
  }
}

module.exports = { collectAll };