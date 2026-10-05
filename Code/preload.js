const { contextBridge, ipcRenderer } = require('electron');

// 同步读启动参数（主进程启动时通过 process.argv 或 additionalArguments 传进来）
// 简化处理：同步读环境变量
let initialAppearance = null;
try {
  initialAppearance = JSON.parse(process.env.XGMCL_INITIAL_APPEARANCE || "null");
} catch (_) {}

contextBridge.exposeInMainWorld('electronAPI', {
  apiCall: (path, options) => ipcRenderer.invoke('api:call', path, options),
  initialAppearance: initialAppearance,

  // ★ 窗口焦点变化订阅（mac 红绿灯失焦变灰）
  onWindowFocusChange: (cb) => {
    const handler = (_e, focused) => cb(focused);
    ipcRenderer.on('win:focus-changed', handler);
    return () => ipcRenderer.removeListener('win:focus-changed', handler);
  },

  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winMaximize: () => ipcRenderer.invoke('win:maximize'),
  winClose: () => ipcRenderer.invoke('win:close'),
  winIsMaximized: () => ipcRenderer.invoke('win:is-maximized'),

  titlebarPickSvg: () => ipcRenderer.invoke('titlebar:pick_svg'),
  titlebarReadSvg: (p) => ipcRenderer.invoke('titlebar:read_svg', p),
});