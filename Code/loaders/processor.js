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

// loaders/processor.js —— Forge / NeoForge 的 processor 执行器

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const AdmZip = require("adm-zip");
const dl = require("../download.js");
const cfgMod = require("../config.js");
const xgmclLog = require("../xgmcl_log.js");

// maven 坐标 → 本地路径
// "net.neoforged:neoform:20240613.152323@zip"
// "net.neoforged:JarJarFileSystems:0.4.1"
// "net.minecraft:client:1.21:srg"
function coordToRel(coord) {
  // 去掉 @zip 之类的 extension
  let ext = "jar";
  const atIdx = coord.indexOf("@");
  if (atIdx >= 0) {
    ext = coord.slice(atIdx + 1);
    coord = coord.slice(0, atIdx);
  }

  const parts = coord.split(":");
  if (parts.length < 3) return null;
  const [group, artifact, version] = parts;
  const classifier = parts.length >= 4 ? "-" + parts[3] : "";
  const rel = `${group.replace(/\./g, "/")}/${artifact}/${version}/${artifact}-${version}${classifier}.${ext}`;
  return rel;
}

// 拼 maven URL
function relToUrl(rel) {
  // NeoForge / Forge 的库大多在 neoforged / minecraftforge maven
  // 但我们从 install_profile 里拿到的坐标，通常已经有 maven 信息
  // 这里统一先试 neoforged maven，失败 fallback 到 central
  return {
    neoforged: "https://maven.neoforged.net/releases/" + rel,
    minecraftforge: "https://maven.minecraftforge.net/" + rel,
    central: "https://repo1.maven.org/maven2/" + rel,
  };
}

// 解析 install_profile.data
// 返回 { KEY: "绝对路径", ... }
function resolveData(installProfile, libsRoot) {
  const result = {};
  const data = installProfile.data || {};

  for (const [key, val] of Object.entries(data)) {
    let coord = null;
    if (typeof val === "string") {
      coord = val;
    } else if (val && typeof val === "object") {
      // {client: "...", server: "..."} → 优先 client
      coord = val.client || val.server || null;
    }
    if (!coord) continue;

    // 形如 "[net.minecraft:client:1.21:srg]"
    const m = coord.match(/^\[([^\]]+)\]$/);
    if (!m) continue;

    const rel = coordToRel(m[1]);
    if (!rel) continue;
    result[key] = path.join(libsRoot, rel.replace(/\//g, path.sep));
  }
  return result;
}

// 替换 args 里的 {VAR} 和 [coord]
function replaceArgs(args, data, libsRoot) {
  const out = [];
  for (const a of args) {
    let s = String(a);
    // {VAR}
    for (const [k, v] of Object.entries(data)) {
      s = s.split("{" + k + "}").join(v);
    }
    // [coord]（在 args 里直接写 maven 坐标的）
    s = s.replace(/\[([^\]]+)\]/g, (match, coord) => {
      const rel = coordToRel(coord);
      if (!rel) return match;
      return path.join(libsRoot, rel.replace(/\//g, path.sep));
    });

    // ★ 检查未替换的 {XXX}
    const unresolved = s.match(/\{[A-Z_]+\}/g);
    if (unresolved) {
      xgmclLog.writeLog("WARN", `[processor] 未替换的占位符: ${unresolved.join(", ")} in "${s}"`);
    }

    out.push(s);
  }
  return out;
}

// 从 jar 里读 Main-Class
function getProcessorMainClass(jarPath) {
  try {
    const zip = new AdmZip(jarPath);
    const mf = zip.readAsText("META-INF/MANIFEST.MF");
    const m = mf.match(/Main-Class:\s*(\S+)/i);
    if (m) return m[1].trim();
  } catch (e) {
    xgmclLog.writeLog("WARN", `读 processor Main-Class 失败: ${e.message}`);
  }
  // NeoForge 的处理器通常这个
  return "net.neoforged.installertools.ConsoleTool";
}

// 下载一个 maven 坐标的库
async function downloadCoord(coord, libsRoot, source, taskId) {
  const rel = coordToRel(coord);
  if (!rel) throw new Error(`非法 maven 坐标: ${coord}`);

  const target = path.join(libsRoot, rel.replace(/\//g, path.sep));
  if (fs.existsSync(target)) return target;  // 已有

  const urls = relToUrl(rel);

  // 优先 neoforged maven，再 minecraftforge，再 central
  const urlList = [urls.neoforged, urls.minecraftforge, urls.central];

  for (const url of urlList) {
    try {
      await dl.downloadOneFile({
        url,
        target,
        sha1: "",
        size: 0,
        important: false,
      }, source, 1, taskId);
      if (fs.existsSync(target)) return target;
    } catch (_) {
      // 继续下一个源
    }
  }

  throw new Error(`无法下载: ${coord}`);
}

// 跑一个 java 进程（异步）
function runJava(javaExe, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(javaExe, args, {
      cwd: cwd || undefined,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`java 退出 code=${code}\n${stderr.slice(-1000)}`));
      }
    });

    proc.on("error", (e) => reject(e));
  });
}

// 解析 java 路径
function pickJavaExe() {
  const g = cfgMod.loadGlobalConfig();
  let javaPath = g.global_java_path || "";
  if (javaPath && fs.existsSync(javaPath)) {
    // 优先 javaw.exe
    if (javaPath.toLowerCase().endsWith("java.exe")) {
      const javaw = javaPath.slice(0, -"java.exe".length) + "javaw.exe";
      if (fs.existsSync(javaw)) return javaw;
    }
    return javaPath;
  }
  return "java";  // fallback PATH
}

// 跑所有 processors
async function runProcessors(taskId, installProfile, libsRoot, source, opts) {
  const processors = installProfile.processors || [];
  if (!processors.length) {
    xgmclLog.writeLog("INFO", "[processor] 无 processor，跳过");
    return;
  }

  const data = resolveData(installProfile, libsRoot);

  // ★ 修正：把 MINECRAFT_JAR 指向我们下载的 client.jar
    // ★ 处理 installer 内部文件（值以 / 开头的，比如 /data/client.lzma）
  //   这些文件在 installer jar 里，需要解压出来
  if (opts && opts.installerJar && fs.existsSync(opts.installerJar)) {
    const extractDir = path.join(path.dirname(opts.installerJar), ".neoforge-extracted");
    fs.mkdirSync(extractDir, { recursive: true });

    const AdmZip = require("adm-zip");
    let installerZip = null;
    try {
      installerZip = new AdmZip(opts.installerJar);
    } catch (e) {
      xgmclLog.writeLog("WARN", `[processor] 打开 installer 失败: ${e.message}`);
    }

    if (installerZip) {
      const rawData = installProfile.data || {};
      for (const [key, val] of Object.entries(rawData)) {
        let coord = null;
        if (typeof val === "string") coord = val;
        else if (val && typeof val === "object") coord = val.client || val.server || null;
        if (!coord) continue;

        // 只处理 /xxx 形式的（installer 内部路径）
        if (!coord.startsWith("/")) continue;

        const innerPath = coord.slice(1);  // "data/client.lzma"
        const outPath = path.join(extractDir, innerPath.replace(/\//g, path.sep));

        // 解压
        try {
          const entry = installerZip.getEntry(innerPath);
          if (entry) {
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, entry.getData());
            data[key] = outPath;
            xgmclLog.writeLog("INFO", `[processor] 从 installer 解压 ${innerPath} → ${outPath}`);
          }
        } catch (e) {
          xgmclLog.writeLog("WARN", `[processor] 解压 ${innerPath} 失败: ${e.message}`);
        }
      }
    }
  }
  if (opts && opts.minecraftJar) {
    data.MINECRAFT_JAR = opts.minecraftJar;
    xgmclLog.writeLog("INFO", `[processor] MINECRAFT_JAR 改为: ${opts.minecraftJar}`);
  }

  // ★ 修正：把 INSTALLER 指向我们下载的 installer jar
  if (opts && opts.installerJar) {
    data.INSTALLER = opts.installerJar;
    xgmclLog.writeLog("INFO", `[processor] INSTALLER 改为: ${opts.installerJar}`);
  }

  // ★ 运行时变量
  data.SIDE = "client";
  data.MINECRAFT_VERSION = opts && opts.mcVersion ? opts.mcVersion : "";
  if (opts && opts.rootPath) {
    data.ROOT = opts.rootPath;
  }
  xgmclLog.writeLog("INFO", `[processor] SIDE=client, ROOT=${data.ROOT || "(未设置)"}`);
  xgmclLog.writeLog("INFO", `[processor] data 解析 ${Object.keys(data).length} 项`);
  for (const [k, v] of Object.entries(data)) {
    xgmclLog.writeLog("INFO", `[processor]   ${k} = ${v}`);
  }

  const javaExe = pickJavaExe();
  xgmclLog.writeLog("INFO", `[processor] 使用 Java: ${javaExe}`);

  let idx = 0;
  for (const proc of processors) {
    idx++;
    if (dl.isTaskCancelled(taskId)) {
      throw new Error("任务已取消");
    }

    // 跳过 BUNDLER_EXTRACT（我们从 installer 里已经手动解压了 maven/）
    if (proc.args && proc.args.includes("BUNDLER_EXTRACT")) {
      xgmclLog.writeLog("INFO", `[processor] 跳过第 ${idx}/${processors.length} 个（BUNDLER_EXTRACT）`);
      continue;
    }

    xgmclLog.writeLog("INFO", `[processor] 跑第 ${idx}/${processors.length} 个`);

    // 拿 processor jar
    let jarPath;
    try {
      jarPath = await downloadCoord(proc.jar, libsRoot, source, taskId);
    } catch (e) {
      throw new Error(`下载 processor jar 失败: ${proc.jar} - ${e.message}`);
    }

    // 拿 classpath
    const cpPaths = [];
    for (const cp of proc.classpath || []) {
      try {
        const p = await downloadCoord(cp, libsRoot, source, taskId);
        cpPaths.push(p);
      } catch (e) {
        xgmclLog.writeLog("WARN", `[processor] classpath 下载失败 ${cp}: ${e.message}`);
      }
    }
    cpPaths.push(jarPath);

    // 替换 args
    const args = replaceArgs(proc.args || [], data, libsRoot);

    // 拿 main class
    const mainClass = getProcessorMainClass(jarPath);

    // 拼命令
    const javaArgs = ["-cp", cpPaths.join(";"), mainClass, ...args];

    xgmclLog.writeLog("INFO", `[processor] java -cp ... ${mainClass} (${args.length} 个参数)`);
    xgmclLog.writeLog("INFO", `[processor] args: ${JSON.stringify(args)}`);

    try {
      const result = await runJava(javaExe, javaArgs);
      if (result.stdout) {
        xgmclLog.writeLog("INFO", `[processor] stdout: ${result.stdout.slice(-500)}`);
      }
      if (result.stderr) {
        xgmclLog.writeLog("WARN", `[processor] stderr: ${result.stderr.slice(-500)}`);
      }
    } catch (e) {
      xgmclLog.writeLog("ERROR", `[processor] 执行失败: ${e.message}`);
      throw e;
    }

    xgmclLog.writeLog("INFO", `[processor] 第 ${idx} 个完成`);
  }

  xgmclLog.writeLog("INFO", `[processor] 全部 ${processors.length} 个完成`);
}

module.exports = {
  runProcessors,
  coordToRel,
  resolveData,
  replaceArgs,
};