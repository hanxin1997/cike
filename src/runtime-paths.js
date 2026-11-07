'use strict';
const path = require('path');
const os = require('os');

function dataPaths(dataDir, baseDir, paths) {
  return {
    baseDir, dataDir,
    browserDir: paths.join(dataDir, 'browsers'), downloadsDir: paths.join(dataDir, 'Downloads'),
    tempDir: paths.join(dataDir, 'temp'), desktopDir: paths.join(dataDir, 'desktop'),
    sessionDir: paths.join(dataDir, 'desktop-session'), logsDir: paths.join(dataDir, 'logs'),
    crashDir: paths.join(dataDir, 'crashDumps'), updatesDir: paths.join(dataDir, 'updates'),
  };
}

// This module has no side effects: callers can choose paths before loading
// Electron sessions, Playwright, or backend modules with module-level defaults.
function resolveRuntimePaths(options = {}) {
  const { platform = process.platform, packaged = false, execPath = process.execPath,
    projectRoot = path.resolve(__dirname, '..'), env = process.env, homeDir = os.homedir() } = options;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const baseDir = paths.resolve(packaged ? paths.dirname(execPath) : projectRoot);
  const explicit = typeof env.LFB_DATA === 'string' && env.LFB_DATA.trim().length > 0;
  const dataDir = explicit ? paths.resolve(env.LFB_DATA) : platform === 'win32'
    ? paths.join(baseDir, 'data') : paths.join(homeDir, '.local-fingerprint-browser');
  const result = dataPaths(dataDir, baseDir, paths);
  if (!explicit) {
    if (platform === 'win32') {
      result.browserDir = paths.join(baseDir, 'browsers');
      result.downloadsDir = paths.join(baseDir, 'Downloads');
    } else {
      result.downloadsDir = paths.join(homeDir, 'Downloads');
      result.tempDir = os.tmpdir();
    }
  }
  // configurePortable publishes these only together with LFB_DATA. Matching
  // that root prevents another profile store from borrowing its directories.
  if (explicit) {
    for (const [field, key] of [['browserDir', 'LFB_BROWSER_DIR'], ['downloadsDir', 'LFB_DOWNLOADS_DIR'], ['tempDir', 'LFB_TEMP_DIR']]) {
      if (env[key]) result[field] = paths.resolve(env[key]);
    }
  }
  return result;
}

function pathsForData(dataDir, options = {}) {
  const paths = (options.platform || process.platform) === 'win32' ? path.win32 : path.posix;
  const resolved = paths.resolve(dataDir);
  const runtime = resolveRuntimePaths(options);
  const equal = (a, b) => paths === path.win32 ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (equal(resolved, runtime.dataDir)) return runtime;
  return dataPaths(resolved, resolved, paths);
}

module.exports = { resolveRuntimePaths, pathsForData };
