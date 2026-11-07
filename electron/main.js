'use strict';
/** Establish portable paths before loading the backend or Playwright. */
const { app, BrowserWindow, ipcMain, shell, session, safeStorage, dialog, clipboard, net } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');

function bootstrap() {
  let paths;
  try { paths = require('./portable').configurePortable(app); }
  catch (error) {
    app.whenReady().then(() => { dialog.showErrorBox('CIKE 无法初始化数据目录', error.message); app.exit(1); });
    return;
  }
  const { startBackend } = require('../src/server');
  const { chromiumStatus, downloadChromium, readInstalledExecutable } = require('./chromium');
  const { checkUpdate, installUpdate, confirmUpdateStartup } = require('./updater');
  const desktopFetch = require('./network').createDesktopFetch(net);
  let backend = null, mainWindow = null, quitting = false, installing = false, downloadingKernel = false;
  const uiFile = path.join(__dirname, 'renderer', 'index.html');
  const uiURL = pathToFileURL(uiFile).href;
  if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
  });
  function trusted(event) {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== uiURL) throw new Error('Untrusted IPC sender');
  }
  function handle(channel, callback) {
    ipcMain.handle(channel, (event, ...args) => { trusted(event); return callback(event, ...args); });
  }
  ipcMain.on('connection-info', event => {
    try {
      trusted(event);
      event.returnValue = { apiBase: backend.url, token: backend.token, paths, platform: process.platform, packaged: app.isPackaged };
    } catch { event.returnValue = {}; }
  });
  async function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1240, height: 820, minWidth: 960, minHeight: 640, title: 'CIKE',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== uiURL) event.preventDefault(); });
    mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    await mainWindow.loadFile(uiFile);
  }
  app.whenReady().then(async () => {
    try {
      // Explicit overrides take priority; installed markers survive moving the folder.
      if (!process.env.LFB_CHROMIUM_EXECUTABLE) {
        const executable = readInstalledExecutable(paths.dataDir);
        if (executable) process.env.LFB_CHROMIUM_EXECUTABLE = executable;
      }
      const requireSafeStorage = () => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法安全读取或迁移代理凭据');
      };
      backend = await startBackend(paths.dataDir, {
        secretStorage: {
          encrypt: value => { requireSafeStorage(); return safeStorage.encryptString(value).toString('base64'); },
          decrypt: value => { requireSafeStorage(); return safeStorage.decryptString(Buffer.from(value, 'base64')); },
        },
        resolveSystemProxy: url => session.defaultSession.resolveProxy(url), downloadsDirectory: paths.downloadsDir,
      });
      await createWindow();
      // Confirm only after both the API and management window have started successfully.
      const updateResult = await confirmUpdateStartup(paths);
      if (updateResult?.error) {
        await dialog.showMessageBox(mainWindow, {
          type: 'warning', title: '上次更新未完成', buttons: ['知道了'],
          message: '已保留环境数据，请检查更新结果',
          detail: `${updateResult.error}\n${updateResult.recoveryDirectory ? `恢复文件：${updateResult.recoveryDirectory}` : ''}`,
        });
      }
      if (paths.legacyDataDir) {
        dialog.showMessageBox(mainWindow, {
          type: 'info', title: '发现旧版数据', buttons: ['知道了'], message: '新版使用程序文件夹内的数据目录',
          detail: `旧数据位于：${paths.legacyDataDir}\n当前数据目录：${paths.dataDir}\n旧数据未被移动或删除。需要保留旧环境时，请先退出程序并按 Windows 使用说明迁移；不要覆盖已有的新数据。`,
        }).catch(() => {});
      }
    } catch (error) {
      console.error('[CIKE] startup failed:', error.message);
      dialog.showErrorBox('CIKE 无法启动', error.message);
      await backend?.browsers.closeAll().catch(() => {});
      backend?.server.close();
      app.exit(1);
    }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && backend) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (quitting || !backend) return;
    event.preventDefault(); quitting = true;
    backend.browsers.shuttingDown = true;
    backend.browsers.closeAll().finally(() => { backend.server.close(); app.quit(); });
  });
  handle('chromium-status', () => chromiumStatus(paths.dataDir, { executable: process.env.LFB_CHROMIUM_EXECUTABLE }));
  handle('chromium-download', async event => {
    if (installing) throw new Error('软件正在更新，请稍后再下载内核');
    if (downloadingKernel) throw new Error('内核正在下载');
    if (backend.browsers.listOpen().length || backend.browsers.opening.size) throw new Error('请先关闭所有环境再更新内核');
    const send = progress => { if (!event.sender.isDestroyed()) event.sender.send('chromium-download-progress', progress); };
    downloadingKernel = true;
    try {
      const executable = await downloadChromium(paths.dataDir, send, { fetch: desktopFetch });
      process.env.LFB_CHROMIUM_EXECUTABLE = executable;
      return { ok: true, executable };
    } catch (error) { return { ok: false, error: error.message }; }
    finally { downloadingKernel = false; }
  });
  handle('open-data-dir', async () => {
    const error = await shell.openPath(paths.dataDir);
    if (error) throw new Error(error);
    return { ok: true };
  });
  handle('proxy-clipboard', async () => {
    try { return { ok: true, proxy: require('../src/proxyparse').parseProxyLine(await clipboard.readText()) }; }
    catch { return { ok: false }; }
  });
  handle('update-check', () => checkUpdate({ fetch: desktopFetch }));
  handle('update-install', async event => {
    if (installing) throw new Error('更新正在进行');
    if (downloadingKernel) throw new Error('请等待内核下载完成再更新软件');
    installing = true;
    try {
      const result = await installUpdate({
        paths, fetch: desktopFetch,
        onProgress: progress => { if (!event.sender.isDestroyed()) event.sender.send('update-progress', progress); },
        beforeQuit: async () => {
          backend.browsers.shuttingDown = true;
          await backend.browsers.closeAll();
        },
      });
      if (result.handoff) {
        quitting = true;
        backend.server.close();
        app.exit(0);
      }
      return result;
    } catch (error) {
      backend.browsers.shuttingDown = false;
      throw error;
    } finally { installing = false; }
  });
}
bootstrap();
