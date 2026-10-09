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

// logs.js —— 游戏日志读取（tail / since / full）

const fs = require("fs");
const path = require("path");
const cfgMod = require("./config.js");

// 按隔离状态决定日志路径
function getLogPath(rootPath, versionName) {
  const pNew = path.join(rootPath, "versions", versionName, "logs", "latest.log");
  if (fs.existsSync(pNew)) return pNew;

  const pOld = path.join(rootPath, "versions", versionName, ".minecraft", "logs", "latest.log");
  if (fs.existsSync(pOld)) return pOld;

  const pGlobal = path.join(rootPath, "logs", "latest.log");
  if (fs.existsSync(pGlobal)) return pGlobal;

  // 都不存在时按当前隔离状态返回
  if (cfgMod.getVersionIsolated(rootPath, versionName)) return pNew;
  return pGlobal;
}

// 读末尾 n 行，返回 {lines, offset, err}
function readTailLines(filePath, n) {
  if (!fs.existsSync(filePath)) {
    return { lines: [], offset: 0, err: "not_found" };
  }
  try {
    const buf = fs.readFileSync(filePath);
    const text = buf.toString("utf-8");
    const lines = text.split(/\r?\n/);
    return {
      lines: lines.slice(-n),
      offset: buf.length,
      err: null,
    };
  } catch (e) {
    return { lines: [], offset: 0, err: e.message };
  }
}

// 从 offset 开始读，返回 {lines, next_offset, err}
function readFromOffset(filePath, offset, maxLines = 500) {
  if (!fs.existsSync(filePath)) {
    return { lines: [], next_offset: offset, err: "not_found" };
  }
  try {
    const st = fs.statSync(filePath);
    const curSize = st.size;
    if (curSize < offset) offset = 0;

    const fd = fs.openSync(filePath, "r");
    const bufSize = curSize - offset;
    const buf = Buffer.alloc(bufSize);
    fs.readSync(fd, buf, 0, bufSize, offset);
    fs.closeSync(fd);

    const text = buf.toString("utf-8");
    let lines = text.split(/\r?\n/);
    if (lines.length > maxLines) {
      lines = lines.slice(-maxLines);
    }
    return { lines, next_offset: curSize, err: null };
  } catch (e) {
    return { lines: [], next_offset: offset, err: e.message };
  }
}

// 读整个文件，返回 {lines, size, total, truncated, err}
function readFullLog(filePath, maxLines = 10000) {
  if (!fs.existsSync(filePath)) {
    return { lines: [], size: 0, total: 0, truncated: false, err: "not_found" };
  }
  try {
    const buf = fs.readFileSync(filePath);
    const text = buf.toString("utf-8");
    let lines = text.split(/\r?\n/);
    const total = lines.length;
    let truncated = false;
    if (total > maxLines) {
      lines = lines.slice(-maxLines);
      truncated = true;
    }
    return { lines, size: buf.length, total, truncated, err: null };
  } catch (e) {
    return { lines: [], size: 0, total: 0, truncated: false, err: e.message };
  }
}

module.exports = {
  getLogPath,
  readTailLines,
  readFromOffset,
  readFullLog,
};