const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bsAPI', {
  // bs.html 完成流程后调用，通知主进程关闭窗口
  finish: () => ipcRenderer.invoke('bsod:finish'),
  // Esc 强制退出
  forceClose: () => ipcRenderer.invoke('bsod:force-close'),
  // ★ 同步通知主进程"准备关闭"，阻止 blur 抢焦点
  prepareClose: () => ipcRenderer.send('bsod:prepare-close'),
});