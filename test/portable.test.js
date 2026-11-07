'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveRuntimePaths, pathsForData } = require('../src/runtime-paths');
const { configurePortable } = require('../electron/portable');

test('packaged Windows places every large application directory beside CIKE.exe', () => {
  const result = resolveRuntimePaths({ platform: 'win32', packaged: true,
    execPath: 'D:\\软件 空格\\CIKE\\CIKE.exe', projectRoot: 'C:\\source', env: {}, homeDir: 'C:\\Users\\fixture' });
  assert.equal(result.baseDir, 'D:\\软件 空格\\CIKE');
  assert.equal(result.dataDir, 'D:\\软件 空格\\CIKE\\data');
  assert.equal(result.browserDir, 'D:\\软件 空格\\CIKE\\browsers');
  assert.equal(result.downloadsDir, 'D:\\软件 空格\\CIKE\\Downloads');
  for (const [name, value] of Object.entries(result)) {
    assert.ok(value.startsWith(result.baseDir), `${name} escaped the portable root`);
  }
  assert.equal(result.tempDir, path.win32.join(result.dataDir, 'temp'));
  assert.equal(result.sessionDir, path.win32.join(result.dataDir, 'desktop-session'));
});

test('development uses project root and explicit LFB_DATA contains all data subdirectories', () => {
  const defaults = { platform: 'win32', packaged: false, execPath: 'C:\\node_modules\\electron\\electron.exe',
    projectRoot: 'D:\\source', env: {}, homeDir: 'C:\\Users\\fixture' };
  assert.equal(resolveRuntimePaths(defaults).dataDir, 'D:\\source\\data');
  const explicit = resolveRuntimePaths({ ...defaults, env: { LFB_DATA: 'E:\\用户 数据' } });
  for (const [name, value] of Object.entries(explicit)) {
    if (name !== 'baseDir') assert.ok(value.startsWith('E:\\用户 数据'), name);
  }
});

test('backend and Chromium reuse initialized sibling directories without contaminating other stores', () => {
  const env = { LFB_DATA: 'D:\\CIKE\\data', LFB_BROWSER_DIR: 'D:\\CIKE\\browsers',
    LFB_DOWNLOADS_DIR: 'D:\\CIKE\\Downloads', LFB_TEMP_DIR: 'D:\\CIKE\\data\\temp' };
  const options = { platform: 'win32', env, projectRoot: 'C:\\ignored' };
  assert.equal(pathsForData('D:\\CIKE\\data', options).browserDir, env.LFB_BROWSER_DIR);
  assert.equal(pathsForData('D:\\other', options).browserDir, 'D:\\other\\browsers');
  assert.equal(pathsForData('D:\\other', options).downloadsDir, 'D:\\other\\Downloads');
});

test('ordinary macOS paths retain the previous user home defaults', () => {
  const result = resolveRuntimePaths({ platform: 'darwin', homeDir: '/Users/fixture', projectRoot: '/Applications/CIKE', env: {} });
  assert.equal(result.dataDir, '/Users/fixture/.local-fingerprint-browser');
  assert.equal(result.downloadsDir, '/Users/fixture/Downloads');
  const calls = [];
  configurePortable({ setPath: (...args) => calls.push(args) }, { platform: 'darwin', env: {}, homeDir: '/Users/fixture', projectRoot: '/Applications/CIKE' });
  assert.deepEqual(calls, []);
});

test('portable initialization configures Electron before ready, preserves HOME and only reports legacy data', { skip: process.platform !== 'win32' }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-portable-'));
  try {
    const base = path.join(temporary, '软件 空格');
    const oldHome = path.join(temporary, 'old-home');
    const oldData = path.join(oldHome, '.local-fingerprint-browser');
    fs.mkdirSync(oldData, { recursive: true });
    fs.writeFileSync(path.join(oldData, 'profiles.json'), '["legacy"]');
    const env = { HOME: 'do-not-change', SystemRoot: process.env.SystemRoot };
    const configured = {};
    const result = configurePortable({ isPackaged: true, isReady: () => false,
      setPath: (name, value) => { configured[name] = value; }, setAppLogsPath: value => { configured.logs = value; } },
    { execPath: path.join(base, 'CIKE.exe'), homeDir: oldHome, env });
    assert.equal(result.baseDir, base);
    assert.equal(configured.userData, result.desktopDir);
    assert.equal(configured.sessionData, result.sessionDir);
    assert.equal(configured.temp, result.tempDir);
    assert.equal(configured.downloads, result.downloadsDir);
    assert.equal(configured.logs, result.logsDir);
    assert.equal(configured.crashDumps, result.crashDir);
    assert.equal(env.TEMP, result.tempDir);
    assert.equal(env.TMP, result.tempDir);
    assert.equal(env.HOME, 'do-not-change');
    assert.equal(env.LFB_DATA, result.dataDir);
    assert.equal(pathsForData(result.dataDir, { env }).browserDir, result.browserDir);
    assert.equal(result.legacyDataDir, oldData);
    assert.equal(fs.readFileSync(path.join(oldData, 'profiles.json'), 'utf8'), '["legacy"]');
    assert.equal(fs.existsSync(path.join(result.dataDir, 'profiles.json')), false);
    assert.throws(() => configurePortable({ isReady: () => true }, { env }), /ready/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('unusable portable directory fails explicitly and never falls back to home', { skip: process.platform !== 'win32' }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-portable-error-'));
  try {
    const blocked = path.join(temporary, 'data');
    fs.writeFileSync(blocked, 'file blocks the data directory');
    const env = {};
    assert.throws(() => configurePortable({ isPackaged: true, isReady: () => false, setPath() {} },
      { execPath: path.join(temporary, 'CIKE.exe'), env }), /便携目录不可写或无法保护/);
    assert.equal(env.LFB_DATA, undefined);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
