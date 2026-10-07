# XGstudio Minecraft Launcher

**English** | [简体中文](./README.zh-CN.md)

An open-source, modern Minecraft launcher.

Built with **Electron + Node.js**.

Created by an individual developer (XG).

Currently in **Beta**.

---

## Table of Contents

- [Tech Stack](#tech-stack)
- [NT Architecture](#nt-architecture)
- [Status](#status)
- [License](#license)
- [Author](#author)
- [Credits](#credits)

---

## Tech Stack

| Layer     | Technology              |
|-----------|-------------------------|
| Backend   | Node.js (main process)  |
| Frontend  | HTML / CSS / JavaScript |
| Desktop   | Electron                |
| Packaging | electron-builder        |

---

## NT Architecture

> Migrating the original XGstudioMinecraftLauncher (py + js architecture) to a faster and more stable NT architecture.

| Item | Old Architecture | NT Architecture |
|------|------------------|-----------------|
| Backend | Python | Node.js |
| Backend file count | 7 | 32 |
| Backend load time | ≈ 9s | 0s |
| Backend call time | ≈ 3s | ≈ 0.6s |
| Total startup (init) time | ≈ 16s | ≈ 8s |
| Total startup time improvement | — | 2× faster |
| Tech stack cohesion | Low (FastAPI) | Very high |

---

## Status

> **Beta (public test)** — the launcher is under active development. Features may change, bugs may exist.

---

## License

AGPLv3.0

---

## Author

**XG**

## Credits

- Mod Chinese name data is sourced from **Plain Craft Launcher** (by 龙腾猫跃).
- Thanks to all the open-source libraries and their contributors that this project depends on (see `package.json` for details).
- Thanks to **mmmawa** for bug testing (born bug magnet).
- Thanks to **Xiao_yugg_** for titlebar feedback.
- Thanks to **Sodium雷雳** for titlebar feedback.
- Thanks to CHLJH for pointing out the issue that the launcher's color presets were not clear enough. It has now been fixed.
- Thanks to all members of the official group!
