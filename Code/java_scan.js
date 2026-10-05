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



// java_scan.js —— 从 PATH + 注册表读 Java，不扫全盘

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

// 跑 java -version，返回 {version, major, vendor, is64} 或 null
function probeJava(exe) {
  return new Promise((resolve) => {
    if (!fs.existsSync(exe)) return resolve(null);

    execFile(exe, ["-version"], { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      // java -version 输出在 stderr
      const out = (stderr || "") + (stdout || "");
      if (!out) return resolve(null);

      const m = out.match(/version "([^"]+)"/);
      if (!m) return resolve(null);
      const ver = m[1];

      let major = 0;
      try {
        if (ver.startsWith("1.")) {
          major = parseInt(ver.split(".")[1], 10);
        } else {
          major = parseInt(ver.split(".")[0], 10);
        }
      } catch (_) {
        major = 0;
      }
      if (isNaN(major)) major = 0;

      let vendor = "Unknown";
      const low = out.toLowerCase();
      if (low.includes("temurin")) vendor = "Adoptium Temurin";
      else if (low.includes("adoptium")) vendor = "Adoptium";
      else if (low.includes("zulu")) vendor = "Azul Zulu";
      else if (low.includes("corretto")) vendor = "Amazon Corretto";
      else if (low.includes("microsoft")) vendor = "Microsoft";
      else if (low.includes("oracle")) vendor = "Oracle";
      else if (low.includes("openjdk")) vendor = "OpenJDK";

      resolve({
        version: ver,
        major,
        vendor,
        is64: out.includes("64-bit"),
      });
    });
  });
}

// 遍历 PATH，收集含 java.exe / javaw.exe 的 bin 目录
function fromPath() {
  const bins = new Set();
  const pathEnv = process.env.PATH || "";
  const sep = process.platform === "win32" ? ";" : ":";

  for (const raw of pathEnv.split(sep)) {
    const entry = raw.trim().replace(/^"|"$/g, "");
    if (!entry || !fs.existsSync(entry)) continue;
    try {
      if (!fs.statSync(entry).isDirectory()) continue;
    } catch (_) {
      continue;
    }
    const hasJava = fs.existsSync(path.join(entry, "java.exe"));
    const hasJavaw = fs.existsSync(path.join(entry, "javaw.exe"));
    if (hasJava || hasJavaw) {
      bins.add(path.normalize(entry).toLowerCase());
    }
  }
  return bins;
}

// 从 Windows 注册表读 JavaHome
function fromRegistry() {
  return new Promise((resolve) => {
    const homes = new Set();
    if (process.platform !== "win32") return resolve(homes);

    // 用 reg.exe 查，比引入原生模块省事
    const regRoots = [
      "HKLM\\SOFTWARE\\JavaSoft",
      "HKLM\\SOFTWARE\\Eclipse Adoptium\\JDK",
      "HKLM\\SOFTWARE\\Eclipse Foundation\\JDK",
      "HKLM\\SOFTWARE\\Azul Systems\\Zulu",
      "HKLM\\SOFTWARE\\Microsoft\\JDK",
    ];

    let pending = regRoots.length;
    if (pending === 0) return resolve(homes);

    for (const root of regRoots) {
      execFile(
        "reg",
        ["query", root, "/s", "/v", "JavaHome"],
        { timeout: 5000, windowsHide: true },
        (err, stdout) => {
          if (!err && stdout) {
            // 每行形如 "    JavaHome    REG_SZ    C:\xxx\jdk\bin"
            for (const line of stdout.split(/\r?\n/)) {
              const m = line.match(/JavaHome\s+REG_SZ\s+(.+)$/);
              if (m) {
                const jh = m[1].trim();
                const bin = path.join(jh, "bin");
                if (fs.existsSync(bin)) {
                  homes.add(path.normalize(bin).toLowerCase());
                }
              }
            }
          }
          pending--;
          if (pending === 0) resolve(homes);
        }
      );
    }
  });
}

// 扫描所有 Java 安装，返回排序后的列表
async function scanJavaInstallations() {
  const bins = new Set();
  for (const b of fromPath()) bins.add(b);
  for (const b of await fromRegistry()) bins.add(b);

  const results = [];
  const seen = new Set();

  for (const bindir of bins) {
    // 优先 javaw.exe（不弹黑框）
    let exe = path.join(bindir, "javaw.exe");
    if (!fs.existsSync(exe)) {
      exe = path.join(bindir, "java.exe");
    }
    if (!fs.existsSync(exe)) continue;
    if (seen.has(exe)) continue;
    seen.add(exe);

    const info = await probeJava(exe);
    if (info) {
      info.path = exe;
      results.push(info);
    }
  }

  // 按 major 降序、vendor、path 排
  results.sort((a, b) => {
    if (a.major !== b.major) return b.major - a.major;
    if (a.vendor !== b.vendor) return a.vendor.localeCompare(b.vendor);
    return a.path.localeCompare(b.path);
  });

  return results;
}

module.exports = {
  scanJavaInstallations,
};