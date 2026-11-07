'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { resolveRuntimePaths } = require('../src/runtime-paths');
const { privateDirectory } = require('../src/privatefiles');

function configurePortable(app, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const paths = resolveRuntimePaths({ ...options, platform, env, packaged: options.packaged ?? app.isPackaged });
  if (platform !== 'win32' && !env.LFB_DATA) return paths;
  if (app.isReady?.()) throw new Error('便携路径必须在 Electron ready 之前初始化');
  try {
    // Apply private ACLs only to dedicated application directories, never to
    // the installation root, its parents, or a whole drive.
    privateDirectory(paths.dataDir);
    privateDirectory(paths.browserDir);
    for (const directory of new Set(Object.entries(paths).filter(([name]) => name !== 'baseDir').map(([, value]) => value))) {
      fs.mkdirSync(directory, { recursive: true });
      if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error(`目录不是普通文件夹：${directory}`);
      const probe = path.join(directory, `.cike-write-${crypto.randomBytes(8).toString('hex')}`);
      try { fs.writeFileSync(probe, '', { flag: 'wx', mode: 0o600 }); }
      finally { fs.rmSync(probe, { force: true }); }
    }
    for (const [name, directory] of Object.entries({ userData: paths.desktopDir, sessionData: paths.sessionDir,
      temp: paths.tempDir, downloads: paths.downloadsDir, crashDumps: paths.crashDir })) app.setPath(name, directory);
    if (typeof app.setAppLogsPath === 'function') app.setAppLogsPath(paths.logsDir);
    else app.setPath('logs', paths.logsDir);
  } catch (error) {
    throw new Error(`CIKE 便携目录不可写或无法保护，请将完整程序目录放到当前账户可写的位置：${paths.baseDir}\n${error.message}`, { cause: error });
  }
  Object.assign(env, { LFB_DATA: paths.dataDir, LFB_BROWSER_DIR: paths.browserDir,
    LFB_DOWNLOADS_DIR: paths.downloadsDir, LFB_TEMP_DIR: paths.tempDir, TEMP: paths.tempDir, TMP: paths.tempDir, TMPDIR: paths.tempDir });
  const oldData = path.join(options.homeDir || os.homedir(), '.local-fingerprint-browser');
  if (platform === 'win32' && path.resolve(oldData).toLowerCase() !== path.resolve(paths.dataDir).toLowerCase() && fs.existsSync(oldData)) {
    paths.legacyDataDir = oldData;
  }
  return paths;
}

module.exports = { configurePortable };
