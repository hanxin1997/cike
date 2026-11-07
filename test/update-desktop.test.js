'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { _electron } = require('playwright');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('packaged updater hands off to the real Windows helper, restarts and preserves portable data', {
  skip: process.platform !== 'win32' || !process.env.CIKE_TEST_APP, timeout: 300000,
}, async () => {
  const version = require('../package.json').version;
  const fixtureParent = path.resolve('.ci-runtime', 'update desktop 中文');
  fs.mkdirSync(fixtureParent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(fixtureParent, 'CIKE '));
  fs.cpSync(path.dirname(path.resolve(process.env.CIKE_TEST_APP)), directory, { recursive: true });
  assert.ok(fs.existsSync(path.join(directory, 'CIKE.exe')), `Copied update fixture missing EXE: ${JSON.stringify(fs.readdirSync(directory))}`);
  const env = { ...process.env };
  for (const key of ['LFB_DATA','LFB_BROWSER_DIR','LFB_DOWNLOADS_DIR','LFB_TEMP_DIR','LFB_CHROMIUM_EXECUTABLE','CIKE_UPDATE_TOKEN']) delete env[key];
  let app, restartedPid;
  try {
    assert.ok(fs.statSync(path.join(directory, 'CIKE.exe')).isFile());
    app = await _electron.launch({ executablePath: '.\\CIKE.exe', cwd: directory, args: [], env, timeout: 60000 });
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.lfb?.apiBase);
    const portable = await page.evaluate(() => window.lfb.paths);
    for (const folder of ['data','browsers','Downloads']) fs.writeFileSync(path.join(directory, folder, 'preserved-fixture.txt'), folder);
    const result = await app.evaluate(async ({ app }, fixture) => {
      const load = process.mainModule.require.bind(process.mainModule);
      const fs = load('fs'), path = load('path');
      const { installUpdate } = load(path.join(app.getAppPath(), 'electron/updater.js'));
      const assetName = `CIKE-${fixture.version}-win-x64.zip`;
      const base = `https://github.com/hanxin1997/cike/releases/download/v${fixture.version}/`;
      const release = { tag_name: `v${fixture.version}`, html_url: `https://github.com/hanxin1997/cike/releases/tag/v${fixture.version}`,
        draft: false, prerelease: false, assets: [assetName, 'SHA256SUMS-win-x64.txt'].map(name => ({ name, browser_download_url: base + name })) };
      // Use the actual built ZIP with controlled HTTP responses. All validation,
      // extraction, process handoff and startup confirmation remain production code.
      const fetch = async url => {
        if (url === 'https://api.github.com/repos/hanxin1997/cike/releases/latest') return new Response(JSON.stringify(release));
        if (url === base + 'SHA256SUMS-win-x64.txt') return new Response(fs.readFileSync(fixture.sums));
        if (url === base + assetName) return { status: 200, headers: new Headers({ 'content-length': String(fs.statSync(fixture.zip).size) }), body: fs.createReadStream(fixture.zip) };
        throw new Error('Unexpected update request: ' + url);
      };
      const update = await installUpdate({ paths: fixture.paths, fetch, app: { getVersion: () => '0.0.0', isPackaged: true }, beforeQuit: async () => {} });
      if (update.handoff) setTimeout(() => app.exit(0), 200);
      return update;
    }, { version, paths: portable, zip: path.resolve('artifacts', `CIKE-${version}-win-x64.zip`), sums: path.resolve('artifacts/SHA256SUMS-win-x64.txt') });
    assert.equal(result.handoff, true);
    const transaction = path.join(portable.updatesDir, result.transactionId);
    let status;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      try { status = JSON.parse(fs.readFileSync(path.join(transaction, 'status.json'), 'utf8').replace(/^\uFEFF/, '')); } catch {}
      if (status?.phase === 'completed') break;
      if (['rolled-back','failed','recovery-required'].includes(status?.phase)) throw new Error(JSON.stringify(status));
      await delay(500);
    }
    assert.equal(status?.phase, 'completed', JSON.stringify(status));
    const confirmation = JSON.parse(fs.readFileSync(path.join(transaction, 'confirmed.json'), 'utf8'));
    restartedPid = confirmation.pid;
    assert.equal(confirmation.version, version);
    assert.equal(fs.existsSync(path.join(transaction, 'backup')), false);
    assert.equal(fs.existsSync(path.join(portable.updatesDir, 'pending.json')), false);
    for (const folder of ['data','browsers','Downloads']) assert.equal(fs.readFileSync(path.join(directory, folder, 'preserved-fixture.txt'), 'utf8'), folder);
    assert.equal(fs.existsSync(path.join(directory, 'data/browsers')), false);
    assert.equal(fs.existsSync(path.join(directory, 'data/Downloads')), false);
  } catch (error) {
    // Keep the original transaction error visible even if a rollback relaunch
    // leaves files open while the fixture is being cleaned up.
    try {
      for (const name of fs.readdirSync(path.join(directory, 'data/updates'))) {
        for (const log of ['status.json','helper.log','preparation-error.json']) {
          const file = path.join(directory, 'data/updates', name, log);
          if (fs.existsSync(file)) console.error(`${log}: ${fs.readFileSync(file, 'utf8')}`);
        }
      }
    } catch {}
    throw error;
  } finally {
    await app?.close().catch(() => {});
    if (!restartedPid) {
      try {
        const dirs = fs.readdirSync(path.join(directory, 'data/updates'));
        for (const name of dirs) {
          const file = path.join(directory, 'data/updates', name, 'confirmed.json');
          if (fs.existsSync(file)) restartedPid = JSON.parse(fs.readFileSync(file, 'utf8')).pid;
        }
      } catch {}
    }
    // Only the exact test-owned process identified by its startup confirmation is stopped.
    if (Number.isInteger(restartedPid) && restartedPid !== process.pid) { try { process.kill(restartedPid); } catch {} }
    assert.ok(directory.startsWith(fixtureParent + path.sep));
    // A failed transaction can relaunch the old app without confirmed.json.
    // Match the exact test executable path, including any renderer children.
    try {
      const { systemExecutable, systemEnvironment } = require('../src/platform');
      execFileSync(systemExecutable('powershell'), ['-NoLogo','-NoProfile','-NonInteractive','-Command',
        '$PSModuleAutoLoadingPreference="None"; Import-Module ($PSHOME + "/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1"); Import-Module ($PSHOME + "/Modules/CimCmdlets/CimCmdlets.psd1"); foreach ($item in (Get-CimInstance Win32_Process)) { if ($item.ExecutablePath -eq $env:CIKE_TEST_EXECUTABLE) { try { [Diagnostics.Process]::GetProcessById($item.ProcessId).Kill() } catch {} } }'],
      { env: { ...systemEnvironment(), CIKE_TEST_EXECUTABLE: path.join(directory, 'CIKE.exe') }, timeout: 30000, windowsHide: true, stdio: 'ignore' });
    } catch {}
    await delay(1000);
    assert.ok(directory.startsWith(fixtureParent + path.sep));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
});
