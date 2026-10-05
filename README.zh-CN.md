# XGstudio Minecraft Launcher

[English](./README.md) | **简体中文**

一个开源、现代化的 Minecraft 启动器。

使用 **Electron + Node.js** 构建。

由个人开发者（XG）开发。

目前处于 **Beta** 阶段。

---

## 目录

- [技术栈](#技术栈)
- [NT架构](#NT架构)
- [状态](#状态)
- [开源协议](#开源协议)
- [作者](#作者)
- [致谢](#致谢)

---

## 技术栈

| 层       | 技术                     |
|----------|--------------------------|
| 后端     | Node.js（主进程）         |
| 前端     | HTML / CSS / JavaScript  |
| 桌面框架 | Electron                 |
| 打包     | electron-builder         |

---

## NT架构
> 讲原本的XGstudioMinecraftLauncher - py-js架构转变为更快更稳定的NT架构

| \ | 原架构：    | NT架构     |
|------------|----------|----------|
| 后端 | Python | Node.js |
| 后端文件数 | 7 | 32 |
| 加载后端时间 | ≈9s | 0s | 
| 总启动（初始化）时间 | ≈ 16s | ≈ 8s |
| 调用后端时间 | ≈ 3s | ≈ 0.6s |
| 总启动（初始化）时间提升（NT架构时间为单位1） | 0% | 200% |
| 技术栈关联 | 小（FastAPI） | 极高 |

---

## 状态

> **Beta**公开测试版 —— 启动器仍在积极开发中，功能可能变动，可能存在 bug。

---

## 开源协议

AGPLv3.0

---

## 作者

**XG**

## 致谢

- Mod 中文名数据来源于 **Plain Craft Launcher**（作者：龙腾猫跃）。
- 感谢两个第三方库的作者。
- 感谢来自 mmmawa 的Bug测试（先天bug圣体）
- 感谢来自 Xiao_yugg_ 的标题栏意见
- 感谢来自 Sodium雷雳 的标题栏意见

- 感谢全体官方群成员！
