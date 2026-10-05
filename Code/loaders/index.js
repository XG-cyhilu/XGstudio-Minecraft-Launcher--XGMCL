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

// loaders/index.js —— 多 loader 统一入口

const fabric = require("./fabric.js");
const quilt = require("./quilt.js");
const forge = require("./forge.js");
const neoforge = require("./neoforge.js");

const LOADERS = {
  fabric,
  quilt,
  forge,
  neoforge,
};

// 所有支持的 loader 类型
function listLoaderTypes() {
  return [
    { id: "vanilla", name: "Vanilla（原版）", type: "vanilla" },
    { id: "fabric", name: "Fabric", type: "mod" },
    { id: "quilt", name: "Quilt", type: "mod" },
    { id: "forge", name: "Forge", type: "mod" },
    { id: "neoforge", name: "NeoForge", type: "mod" },
  ];
}

// 拿某 loader 的模块
function getLoader(id) {
  if (!id) return null;
  const lower = String(id).toLowerCase();
  return LOADERS[lower] || null;
}

module.exports = {
  listLoaderTypes,
  getLoader,
};