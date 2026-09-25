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



const { app, BrowserWindow } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let coreProc = null;

// ============ 单实例锁（防止重复开窗口） ============
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    console.log('[Single] 已有实例在运行，退出');
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        console.log('[Single] 检测到第二实例启动，聚焦到现有窗口');
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

// ============ 杀进程树 ============
function killTree(proc) {
    if (!proc || proc.killed) return;
    try {
        if (process.platform === 'win32') {
            execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
        } else {
            proc.kill('SIGKILL');
        }
    } catch (e) {
        try { proc.kill(); } catch (_) {}
    }
}

// ============ 资源就位：把 resources/ 里的东西铺到 exe 同级 ============
function ensureResources() {
    if (!app.isPackaged) return;  // 源码运行不用管

    const baseDir = path.dirname(app.getPath('exe'));   // win-unpacked\
    const resDir  = process.resourcesPath;              // win-unpacked\resources\

    // 1. XG-Core.exe：从 resources/ 拷到 exe 同级
    const coreSrc = path.join(resDir, 'XG-Core.exe');
    const coreDst = path.join(baseDir, 'XG-Core.exe');
    if (fs.existsSync(coreSrc) && !fs.existsSync(coreDst)) {
        try {
            fs.copyFileSync(coreSrc, coreDst);
            console.log('[ensure] XG-Core.exe 已铺到', coreDst);
        } catch (e) {
            console.error('[ensure] 拷 XG-Core.exe 失败:', e.message);
        }
    }

    // 2. wiki_entries.json：拷到 exe 同级
    const wikiSrc = path.join(resDir, 'wiki_entries.json');
    const wikiDst = path.join(baseDir, 'wiki_entries.json');
    if (fs.existsSync(wikiSrc) && !fs.existsSync(wikiDst)) {
        try {
            fs.copyFileSync(wikiSrc, wikiDst);
            console.log('[ensure] wiki_entries.json 已铺到', wikiDst);
        } catch (e) {
            console.error('[ensure] 拷 wiki_entries.json 失败:', e.message);
        }
    }

    // 3. boot_files/{i18n,lib,skins} → <baseDir>/XGMCL/data/
    const bootSrc = path.join(resDir, 'boot_files');
    const xgmclData = path.join(baseDir, 'XGMCL', 'data');
    for (const sub of ['i18n', 'lib', 'skins']) {
        const src = path.join(bootSrc, sub);
        const dst = path.join(xgmclData, sub);
        if (fs.existsSync(src)) {
            try {
                copyDirRecursive(src, dst);
                console.log(`[ensure] ${sub} 已铺到`, dst);
            } catch (e) {
                console.error(`[ensure] 拷 ${sub} 失败:`, e.message);
            }
        }
    }
}

function copyDirRecursive(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
        const s = path.join(src, name);
        const d = path.join(dst, name);
        const st = fs.statSync(s);
        if (st.isDirectory()) {
            copyDirRecursive(s, d);
        } else {
            // 已存在且大小一致 → 跳过
            if (fs.existsSync(d) && fs.statSync(d).size === st.size) continue;
            fs.copyFileSync(s, d);
        }
    }
}

// ============ 等待端口空闲 ============
function waitPortFree(port, maxWaitMs = 15000) {
    const net = require('net');
    return new Promise((resolve) => {
        const start = Date.now();
        const tryOnce = () => {
            const srv = net.createServer();
            srv.once('error', () => {
                srv.close();
                if (Date.now() - start > maxWaitMs) return resolve(false);
                setTimeout(tryOnce, 300);
            });
            srv.once('listening', () => {
                srv.close(() => resolve(true));
            });
            srv.listen(port, '127.0.0.1');
        };
        tryOnce();
    });
}

// ============ 启动 Python 后端 ============
async function startCore() {
    const T = Date.now();
    console.log('[TIME][startCore] begin');

    // 只等 2 秒，端口占用的话直接强杀
    const free = await waitPortFree(8000, 2000);
    console.log('[TIME][startCore] waitPortFree done +' + (Date.now() - T) + 'ms, free=' + free);
    if (!free) {
        console.warn('[WARN] 8000 端口被占用，清理残留进程...');
        try {
            execSync('taskkill /F /IM python.exe', { stdio: 'ignore' });
        } catch (_) {}
        try {
            execSync('taskkill /F /IM XG-Core.exe', { stdio: 'ignore' });
        } catch (_) {}
        await new Promise(r => setTimeout(r, 500));
    }

    const isPackaged = app.isPackaged;
    const baseDir = isPackaged ? path.dirname(app.getPath('exe')) : __dirname;

    const coreExe = path.join(baseDir, 'XG-Core.exe');
    const corePy  = path.join(baseDir, 'core.py');

    let cmd, args, cwd;

    if (isPackaged && fs.existsSync(coreExe)) {
        cmd = coreExe;
        args = [];
        cwd = baseDir;
    } else if (fs.existsSync(corePy)) {
        cmd = 'python';
        args = [corePy];
        cwd = baseDir;
    } else {
        console.error('[ERROR] 找不到 core.py 或 XG-Core.exe');
        return;
    }

    console.log('[TIME][startCore] spawn ' + cmd);
    coreProc = spawn(cmd, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    coreProc.stdout.setEncoding('utf8');
    coreProc.stderr.setEncoding('utf8');

    coreProc.stdout.on('data', d => {
        process.stdout.write('[Core] ' + String(d).replace(/\s+$/, '') + '\n');
    });
    coreProc.stderr.on('data', d => {
        process.stderr.write('[Core ERR] ' + String(d).replace(/\s+$/, '') + '\n');
    });
    coreProc.on('exit', code => {
        console.log('[Core] 退出，code =', code);
        coreProc = null;
    });

    console.log('[TIME][startCore] spawn returned +' + (Date.now() - T) + 'ms');
}

// ============ 等待后端就绪 ============
function waitForCore(retries = 60) {
    const net = require('net');
    return new Promise(resolve => {
        const tryOnce = (n) => {
            const s = net.connect(8000, '127.0.0.1');
            s.once('connect', () => { s.destroy(); resolve(true); });
            s.once('error', () => {
                s.destroy();
                if (n <= 0) return resolve(false);
                setTimeout(() => tryOnce(n - 1), 250);
            });
        };
        tryOnce(retries);
    });
}

// ============ 窗口 ============
function createWindow() {
    if (mainWindow) {
        mainWindow.focus();
        return;
    }
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1000,
        minHeight: 640,
        backgroundColor: '#1f1f1f',
        autoHideMenuBar: true,
        show: true,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile('index.html');

    mainWindow.on('closed', () => { mainWindow = null; });
}

async function splashCall(fnName) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
        await mainWindow.webContents.executeJavaScript(
            `(async () => { await window.${fnName}(); })()`
        );
    } catch (e) {
        console.warn(`[splash] 调用 ${fnName} 失败:`, e.message);
    }
}

// ============ 生命周期 ============
app.whenReady().then(async () => {
    if (!gotTheLock) return;
    const T0 = Date.now();
    console.log('[TIME] +' + (Date.now() - T0) + 'ms app ready');

    // ★ 先把 resources/ 里的东西铺到 exe 同级
    ensureResources();
    console.log('[TIME] +' + (Date.now() - T0) + 'ms ensureResources done');

    // ★ 两个窗口：splash 先显示，main 后台加载
    const splashWin = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1000,
        minHeight: 640,
        backgroundColor: '#1f1f1f',
        autoHideMenuBar: true,
        show: true,
        frame: true,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    splashWin.loadFile('splash.html');
    console.log('[TIME] +' + (Date.now() - T0) + 'ms splash window created');

    // ★ 主窗口：提前创建，但先不显示
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1000,
        minHeight: 640,
        backgroundColor: '#1f1f1f',
        autoHideMenuBar: true,
        show: false,
        paintWhenInitiallyHidden: true,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: true   // ★ 开启 <webview> 标签
        }
    });

    // ★ 处理 webview 事件
    mainWindow.webContents.on("did-attach-webview", (event, wc) => {
        // 1. target="_blank" / window.open 的链接 → 在当前 webview 内导航
        wc.setWindowOpenHandler(({ url }) => {
            console.log('[webview] setWindowOpenHandler 触发，目标 URL:', url);
            // 用 loadURL 让当前 webview 导航（这是 Electron 官方推荐写法）
            // 用 setTimeout 避开"取消当前加载"的时序冲突
            setTimeout(() => {
                if (wc && !wc.isDestroyed()) {
                    wc.loadURL(url).catch(e => {
                        console.warn('[webview] 内跳转失败:', e.message);
                    });
                }
            }, 50);
            return { action: 'deny' };
        });
            // 1.5 普通链接跳转（`<a href>` 不带 target，或者 location.href）→ 也拦一下
        wc.on('will-navigate', (e, url) => {
            // 允许导航（默认行为），只记录日志
            console.log('[webview] 将导航到:', url);
        });

        // 2. 拦截 webview 对本地 core 接口的请求（安全）
        wc.session.webRequest.onBeforeRequest((details, callback) => {
            const url = details.url || "";
            if (url.startsWith("http://127.0.0.1:8000") ||
                url.startsWith("http://localhost:8000")) {
                console.warn('[webview] 拦截本地接口请求:', url);
                return callback({ cancel: true });
            }
            callback({ cancel: false });
        });

        console.log('[webview] 已附加:', wc.getURL());
                // 忽略 ERR_ABORTED
        wc.on('did-fail-load', (e, errorCode, errorDescription, validatedURL) => {
            if (errorCode === -3) return;   // ERR_ABORTED
            console.warn('[webview] 加载失败:', errorCode, errorDescription, validatedURL);
        });

        console.log('[webview] 已附加:', wc.getURL());
    });

    // ★ 等 splash 加载完
    await new Promise(r => {
        if (splashWin.webContents.isLoading()) {
            splashWin.webContents.once('did-finish-load', r);
        } else {
            r();
        }
    });
    console.log('[TIME] +' + (Date.now() - T0) + 'ms splash loaded');

    // ★ 后台启动 core
    const corePromise = (async () => {
        console.log('[TIME] +' + (Date.now() - T0) + 'ms startCore begin');
        await startCore();
        console.log('[TIME] +' + (Date.now() - T0) + 'ms startCore done');
        await waitForCore();
        console.log('[TIME] +' + (Date.now() - T0) + 'ms waitForCore done');
    })();

    // ★ splash 通过 executeJavaScript 控制（splashWin 而不是 mainWindow）
    async function splashCallWin(fnName) {
        if (!splashWin || splashWin.isDestroyed()) return;
        try {
            await splashWin.webContents.executeJavaScript(
                `(async () => { await window.${fnName}(); })()`
            );
        } catch (e) {
            console.warn(`[splash] 调用 ${fnName} 失败:`, e.message);
        }
    }

    await splashCallWin("__splashRunCore");
    console.log('[TIME] +' + (Date.now() - T0) + 'ms splash core detected');

    await corePromise;
    console.log('[TIME] +' + (Date.now() - T0) + 'ms corePromise resolved');

    // ★ core 就绪后，后台开始加载 index.html（用户还在看 splash）
    const indexPromise = new Promise(r => {
        mainWindow.webContents.once('did-finish-load', r);
        mainWindow.loadFile('index.html');
    });
    console.log('[TIME] +' + (Date.now() - T0) + 'ms index loading started');

    await splashCallWin("__splashRunData");
    console.log('[TIME] +' + (Date.now() - T0) + 'ms data done');

    await splashCallWin("__splashRunUi");
    console.log('[TIME] +' + (Date.now() - T0) + 'ms ui done');

    // ★ 等 index 加载完（可能已经好了，可能还在加载）
    await indexPromise;
    console.log('[TIME] +' + (Date.now() - T0) + 'ms index loaded');

    // ★ 等 index 的 window.onload 跑完（外观已应用）
    //   用一个轮询：检查 body 上有没有 aesthetic-* 类 或 全局背景层是否 show
    await mainWindow.webContents.executeJavaScript(`
        new Promise(resolve => {
            if (document.readyState === 'complete') return resolve();
            window.addEventListener('load', () => resolve(), { once: true });
        })
    `);
    // 再等一小会儿，让 loadAppearance() 的 fetch 落地
    await new Promise(r => setTimeout(r, 300));
    console.log('[TIME] +' + (Date.now() - T0) + 'ms index appearance applied');

    await splashCallWin("__splashDone");
    console.log('[TIME] +' + (Date.now() - T0) + 'ms done');

    // ★ 切窗口：先 show main + 等渲染一帧，再关 splash
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        // 轮询等 main 窗口真正"画出来"
        await new Promise(r => {
            let done = false;
            const finish = () => { if (!done) { done = true; r(); } };
            mainWindow.webContents.once('did-finish-load', finish);
            setTimeout(finish, 250);
        });
        // 再等两帧，确保第一帧已经上屏
        await mainWindow.webContents.executeJavaScript(
            `new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)))`
        );
    }
    if (splashWin && !splashWin.isDestroyed()) {
        splashWin.close();
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    killTree(coreProc);
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    killTree(coreProc);
});
