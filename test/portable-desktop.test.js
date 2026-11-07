'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { _electron } = require('playwright');
const { copyBundle } = require('./helpers/copy-bundle');

test('packaged Windows app installs its own kernel beside the executable and survives directory relocation', {
  skip: process.platform !== 'win32' || !process.env.CIKE_TEST_APP, timeout: 600000,
}, async () => {
  const fixtureRoot = path.resolve('.ci-runtime', 'packaged-便携 test');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const original = path.dirname(path.resolve(process.env.CIKE_TEST_APP));
  assert.ok(fs.existsSync(path.join(original, 'CIKE.exe')), `Original package missing EXE: ${JSON.stringify(fs.readdirSync(original))}`);
  let directory = fs.mkdtempSync(path.join(fixtureRoot, 'CIKE '));
  assert.ok(copyBundle(original, directory) > 10, 'The test must copy the complete Electron distribution.');
  assert.ok(fs.existsSync(path.join(directory, 'CIKE.exe')), `Copied package missing EXE: ${JSON.stringify(fs.readdirSync(directory))}`);
  // Intentionally remove every override: old desktop tests only exercised LFB_DATA.
  const env = { ...process.env };
  for (const name of ['LFB_DATA','LFB_BROWSER_DIR','LFB_DOWNLOADS_DIR','LFB_TEMP_DIR','LFB_CHROMIUM_EXECUTABLE']) delete env[name];
  let app;
  const launch = async () => {
    assert.ok(fs.statSync(path.join(directory, 'CIKE.exe')).isFile());
    // Playwright launches Electron through cmd on Windows. Keep the executable
    // token simple while the OS cwd still exercises the full Unicode/space path.
    app = await _electron.launch({ executablePath: '.\\CIKE.exe', cwd: directory, args: [], env, timeout: 60000 });
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.lfb?.apiBase);
    await page.locator('[data-page="settings"]').click();
    const paths = await page.evaluate(() => window.lfb.paths);
    assert.equal(paths.dataDir, path.join(directory, 'data'));
    assert.equal(paths.browserDir, path.join(directory, 'browsers'));
    assert.equal(paths.downloadsDir, path.join(directory, 'Downloads'));
    const systemPaths = await app.evaluate(({ app }) => ({
      userData: app.getPath('userData'), sessionData: app.getPath('sessionData'),
      temp: app.getPath('temp'), logs: app.getPath('logs'), crashDumps: app.getPath('crashDumps'),
      processTemp: process.env.TEMP, processTmp: process.env.TMP,
    }));
    for (const actual of Object.values(systemPaths)) {
      assert.ok(actual.toLowerCase().startsWith((directory + path.sep).toLowerCase()), `Path escaped executable directory: ${actual}`);
    }
    await page.waitForFunction(expected => document.querySelector('#set-data-dir').value === expected, paths.dataDir);
    return page;
  };
  try {
    let page = await launch();
    await page.locator('#btn-download-browser').click();
    await page.waitForFunction(() => document.querySelector('#btn-download-browser').textContent === 'Chromium 已安装', null, { timeout: 300000 });
    const status = await page.evaluate(() => window.lfb.chromiumStatus());
    assert.ok(status.installed);
    assert.equal(status.version, status.targetVersion);
    assert.ok(status.executable.startsWith(path.join(directory, 'browsers') + path.sep));
    const marker = fs.readFileSync(path.join(directory, 'browsers/chromium-executable.txt'), 'utf8').trim();
    assert.equal(path.isAbsolute(marker), false);
    const profile = await page.evaluate(async () => {
      const response = await fetch(window.lfb.apiBase + 'api/profiles', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-token': window.lfb.token },
        body: JSON.stringify({ name: 'Portable fixture', locale: 'en-US', timezone: 'UTC' }),
      });
      const result = await response.json(); if (!result.ok) throw new Error(result.error);
      return result.profile;
    });
    const openAndClose = async () => page.evaluate(async id => {
      for (const action of ['openBrowser', 'closeBrowser']) {
        const response = await fetch(window.lfb.apiBase + 'api/' + action, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-token': window.lfb.token },
          body: JSON.stringify({ profile_id: id, headless: false }),
        });
        const result = await response.json(); if (!result.ok) throw new Error(result.error);
      }
    }, profile.id);
    await openAndClose();
    fs.writeFileSync(path.join(directory, 'Downloads/keep.txt'), 'user file');
    await app.close(); app = null;
    const relocated = directory + ' moved 中文';
    fs.renameSync(directory, relocated); directory = relocated;
    page = await launch();
    const afterMove = await page.evaluate(() => window.lfb.chromiumStatus());
    assert.equal(afterMove.installed, true);
    assert.ok(afterMove.executable.startsWith(path.join(directory, 'browsers') + path.sep));
    assert.equal(fs.readFileSync(path.join(directory, 'Downloads/keep.txt'), 'utf8'), 'user file');
    assert.ok(JSON.parse(fs.readFileSync(path.join(directory, 'data/profiles.json')))[profile.id]);
    await openAndClose();
  } finally {
    await app?.close();
    // This is a test-owned copy; never remove the application supplied through CIKE_TEST_APP.
    assert.ok(directory.startsWith(fixtureRoot + path.sep));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
