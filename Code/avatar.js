/*
XGstudio Minecraft Launcher (XGMCL)
Copyright (C) 2026 XG-cyhliu

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

// avatar.js —— 从 64x64 皮肤裁 8x8 头像

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const P = require("./paths.js");
const xgmclLog = require("./xgmcl_log.js");

// 尝试加载 sharp 或 jimp
let sharp = null;
let jimp = null;
try { sharp = require("sharp"); } catch (_) {}
if (!sharp) {
  try { jimp = require("jimp"); } catch (_) {}
}

const VANILLA_SKINS = ["steve", "alex", "ari", "efe", "kai", "makena", "noor", "sunny", "zuri"];

// 按用户名确定性挑一个原版皮肤
function pickVanillaSkin(username) {
  const h = crypto.createHash("md5").update(username, "utf-8").digest();
  const idx = h[0] % VANILLA_SKINS.length;
  return VANILLA_SKINS[idx];
}

// 从 64x64 皮肤裁 8x8 头像
async function cropFace(srcPath, dstPath) {
  if (!fs.existsSync(srcPath)) return false;
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });

  if (sharp) {
    try {
      const img = sharp(srcPath);
      const meta = await img.metadata();
      if (meta.width !== 64 || meta.height !== 64) {
        // 非标准，直接拷
        fs.copyFileSync(srcPath, dstPath);
        return true;
      }
      // 先裁 face 和 hat，合成后放大 16 倍
      const faceBuf = await sharp(srcPath).extract({ left: 8, top: 8, width: 8, height: 8 }).png().toBuffer();
      const hatBuf = await sharp(srcPath).extract({ left: 40, top: 8, width: 8, height: 8 }).png().toBuffer();
      await sharp({
        create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .composite([
          { input: faceBuf, top: 0, left: 0 },
          { input: hatBuf, top: 0, left: 0 },
        ])
        .resize(128, 128, { kernel: "nearest" })
        .png()
        .toFile(dstPath);
      return true;
    } catch (e) {
      xgmclLog.writeLog("ERROR", `sharp 裁头像失败: ${e.message}`);
      return false;
    }
  }

  if (jimp) {
    try {
      const img = await jimp.Jimp.read(srcPath);
      if (img.bitmap.width !== 64 || img.bitmap.height !== 64) {
        fs.copyFileSync(srcPath, dstPath);
        return true;
      }
      const face = img.clone().crop(8, 8, 8, 8);
      const hat = img.clone().crop(40, 8, 8, 8);
      face.composite(hat, 0, 0);
      face.resize({ w: 128, h: 128 });
      await face.write(dstPath);
      return true;
    } catch (e) {
      xgmclLog.writeLog("ERROR", `jimp 裁头像失败: ${e.message}`);
      return false;
    }
  }

  xgmclLog.writeLog("WARN", "既没有 sharp 也没有 jimp，无法裁头像");
  return false;
}

// 生成离线账户头像
async function buildVanillaAvatar(username, accUuid) {
  const skinName = pickVanillaSkin(username);
  const src = path.join(P.VANILLA_SKIN_DIR, `${skinName}.png`);
  const dst = path.join(P.AVATAR_CACHE_DIR, `${accUuid}.png`);

  if (fs.existsSync(dst)) return dst;
  if (!fs.existsSync(src)) {
    xgmclLog.writeLog("WARN", `原版皮肤不存在: ${src}`);
    return "";
  }
  return (await cropFace(src, dst)) ? dst : "";
}

module.exports = {
  pickVanillaSkin,
  cropFace,
  buildVanillaAvatar,
};