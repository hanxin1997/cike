'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { checkUpdate, confirmUpdateStartup, _test: updater } = require('../electron/updater');

const assetName = 'CIKE-0.7.1-win-x64.zip';
const assetURL = `https://github.com/hanxin1997/cike/releases/download/v0.7.1/${assetName}`;
const release = () => ({ tag_name: 'v0.7.1', draft: false, prerelease: false,
  html_url: 'https://github.com/hanxin1997/cike/releases/tag/v0.7.1',
  assets: [assetName, 'SHA256SUMS-win-x64.txt', 'CIKE-0.7.1-mac-arm64.dmg', 'SHA256SUMS.txt'].map(name => ({ name, browser_download_url: `https://github.com/hanxin1997/cike/releases/download/v0.7.1/${name}` })),
});
const selection = { current: '0.7.0', platform: 'win32', arch: 'x64', packaged: true };
const temp = () => fs.mkdtempSync(path.join(__dirname, '.updater-中文 空格-'));
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
function makeFixture() {
  const root = temp(), transactionId = crypto.randomUUID();
  const paths = { baseDir: root, dataDir: path.join(root, 'data'), browserDir: path.join(root, 'browsers'), downloadsDir: path.join(root, 'Downloads'), updatesDir: path.join(root, 'data', 'updates') };
  const transaction = path.join(paths.updatesDir, transactionId), stage = path.join(transaction, 'stage');
  for (const name of ['data', 'browsers', 'Downloads', '自定义数据']) write(path.join(root, name, 'preserve.txt'), name);
  write(path.join(root, 'CIKE.exe'), 'old executable');
  write(path.join(root, 'resources', 'app', 'package.json'), '{"version":"0.7.0"}');
  write(path.join(root, 'obsolete.dll'), 'old obsolete dll');
  write(path.join(stage, 'CIKE.exe'), 'new executable');
  write(path.join(stage, 'resources', 'app', 'package.json'), '{"version":"0.7.1"}');
  write(path.join(stage, 'fresh.dll'), 'new dll');
  const listing = updater.validatePackage(stage, paths);
  const state = { schema: 1, transactionId, version: '0.7.1', parentPid: 2147483647, root, transaction, stage, backup: path.join(transaction, 'backup'), entries: ['CIKE.exe', 'fresh.dll', 'obsolete.dll', 'resources'], files: listing.files,
    protectedPaths: [...listing.protectedPaths, path.join(root, '自定义数据')], confirmationToken: 'a'.repeat(64) };
  const manifest = path.join(transaction, 'manifest.json');
  write(manifest, JSON.stringify(state));
  return { root, paths, state, manifest };
}
function preserved(fixture) {
  for (const name of ['data', 'browsers', 'Downloads', '自定义数据']) assert.equal(fs.readFileSync(path.join(fixture.root, name, 'preserve.txt'), 'utf8'), name);
}

test('an aborted update response rejects instead of leaving the install pending', async () => {
  // Reproduce the old response-aborted hang without a real network connection.
  const filename = path.resolve(__dirname, '../electron/updater.js');
  const fakeHttps = { get(_url, _options, callback) {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      response.emit('aborted');
    });
    return request;
  } };
  const exports = { exports: {} };
  vm.runInNewContext(`${fs.readFileSync(filename, 'utf8')}\nmodule.exports.regressionGet = get;`, {
    require: name => name === 'electron' ? { app: {} } : name === 'https' ? fakeHttps : require(name),
    module: exports, process, Buffer, queueMicrotask, setTimeout, clearTimeout, URL, AbortController,
  }, { filename });
  const result = await Promise.race([
    exports.exports.regressionGet('https://api.github.com/repos/hanxin1997/cike/releases/latest').then(() => 'resolved', () => 'rejected'),
    new Promise(resolve => setTimeout(() => resolve('timed-out'), 100)),
  ]);
  assert.equal(result, 'rejected');
});

test('release selection uses our formal platform assets and reports unavailable installs', async () => {
  const chosen = updater.selectRelease(release(), selection);
  assert.equal(chosen.available, true);
  assert.equal(chosen.supportsInstall, true);
  assert.equal(chosen.downloadUrl, assetURL);
  assert.equal(updater.selectRelease(release(), { ...selection, current: '0.7.1' }).available, false);
  assert.equal(updater.selectRelease(release(), { ...selection, current: '0.8.0' }).available, false);
  assert.equal(updater.selectRelease(release(), { ...selection, packaged: false }).supportsInstall, false);
  assert.equal(updater.selectRelease(release(), { ...selection, arch: 'arm64' }).supportsInstall, false);
  assert.equal(updater.selectRelease({ ...release(), assets: [] }, selection).supportsInstall, false);
  assert.equal(updater.selectRelease(release(), { ...selection, platform: 'darwin', arch: 'arm64' }).assetName, 'CIKE-0.7.1-mac-arm64.dmg');
  assert.throws(() => updater.selectRelease({ ...release(), prerelease: true }, selection), /正式/);
  assert.throws(() => updater.selectRelease({ ...release(), html_url: 'https://github.com/chainfix/cike/releases/tag/v0.7.1' }, selection), /本仓库/);
  const wrong = release(); wrong.assets[0].browser_download_url = assetURL.replace('v0.7.1', 'v0.6.0');
  assert.throws(() => updater.selectRelease(wrong, selection), /不匹配/);
  const info = await checkUpdate({ app: { getVersion: () => '0.7.0', isPackaged: true }, platform: 'win32', arch: 'x64', fetch: async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/hanxin1997/cike/releases/latest');
    assert.equal(options.redirect, 'manual');
    return new Response(JSON.stringify(release()));
  } });
  assert.equal(info.latest, '0.7.1');
});

test('SHA256 matches exactly one asset, rejects wrong versions, duplicates and tampering', async () => {
  const root = temp();
  try {
    const archive = path.join(root, 'update.zip'), body = Buffer.from('verified fixture');
    fs.writeFileSync(archive, body);
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    assert.equal(updater.checksumFor(`${'b'.repeat(64)}  CIKE-0.7.0-win-x64.zip\r\n${hash.toUpperCase()} *${assetName}\r\n`, assetName), hash);
    assert.throws(() => updater.checksumFor(`${hash}  CIKE-0.7.0-win-x64.zip`, assetName), /唯一/);
    assert.throws(() => updater.checksumFor(`${hash}  ${assetName}\n${hash}  ${assetName}`, assetName), /唯一/);
    await updater.verifyChecksum(archive, hash);
    await assert.rejects(updater.verifyChecksum(archive, '0'.repeat(64)), /SHA256/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('downloads validate redirects, bounded sizes, stream errors and partial cleanup', async () => {
  const root = temp();
  try {
    let requests = 0;
    const text = await updater.get(assetURL, null, { fetch: async url => {
      if (!requests++) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset' } });
      assert.equal(url, 'https://release-assets.githubusercontent.com/asset');
      return new Response('complete');
    } });
    assert.equal(text, 'complete');
    for (const location of ['http://github.com/hanxin1997/cike/releases/download/v0.7.1/x', 'https://evil.example/asset', 'https://github.com/chainfix/cike/releases/download/v0.7.1/x']) {
      await assert.rejects(updater.get(assetURL, null, { fetch: async () => new Response(null, { status: 302, headers: { location } }) }), /HTTPS|本仓库/);
    }
    await assert.rejects(updater.get(assetURL, null, { fetch: async () => new Response(null, { status: 302, headers: { location: assetURL } }) }), /重定向/);
    await assert.rejects(updater.get(assetURL, null, { maxBytes: 3, fetch: async () => new Response('oversize') }), /大小/);
    await assert.rejects(updater.get(assetURL, null, { maxBytes: 3, fetch: async () => new Response('x', { headers: { 'content-length': '4' } }) }), /大小/);
    const partial = path.join(root, 'partial.zip');
    await assert.rejects(updater.get(assetURL, partial, { fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); setTimeout(() => controller.error(new Error('fixture broken stream')), 5); } })) }), /broken stream/);
    assert.equal(fs.existsSync(partial), false);
    await assert.rejects(updater.get(assetURL, null, { fetch: async () => new Response('short', { headers: { 'content-length': '99' } }) }), /不完整/);
    await assert.rejects(updater.get(assetURL, null, { timeout: 20, fetch: async () => new Response(new ReadableStream({ start() {} })) }), /超时/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('package validation excludes data, custom data, unlisted roots and links', () => {
  const fixture = makeFixture();
  try {
    assert.equal(updater.validatePackage(fixture.state.stage, fixture.paths).files.length, 3);
    for (const name of ['data', 'browsers', 'Downloads', 'foreign']) {
      const bad = path.join(fixture.state.stage, name);
      write(path.join(bad, 'payload'), 'bad');
      assert.throws(() => updater.validatePackage(fixture.state.stage, fixture.paths), /非程序|数据/);
      fs.rmSync(bad, { recursive: true, force: true });
    }
    assert.throws(() => updater.validatePackage(fixture.state.stage, { ...fixture.paths, dataDir: path.join(fixture.root, 'resources', 'private') }), /数据/);
    assert.throws(() => updater.validatePackage(fixture.state.stage, { ...fixture.paths, dataDir: fixture.root }), /重合/);
    const linked = path.join(fixture.state.stage, 'resources', 'linked');
    fs.symlinkSync(path.join(fixture.root, 'data'), linked, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => updater.validatePackage(fixture.state.stage, fixture.paths), /链接/);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

const helperRunner = String.raw`param([string] $Helper, [string] $ManifestFile, [string] $Scenario)
$ErrorActionPreference = 'Stop'
. $Helper -LibraryOnly
$state = Read-UpdateManifest $ManifestFile
if ($Scenario -eq 'tamper') {
  [IO.File]::WriteAllText((Join-Path $state.stage 'CIKE.exe'), 'tampered')
  try { Invoke-ReplaceProgram $state; throw 'EXPECTED_REJECTION' } catch { if ($_.Exception.Message -eq 'EXPECTED_REJECTION') { throw }; if ($_.Exception.Message -notmatch 'integrity') { throw } }
  exit 0
}
if ($Scenario -eq 'locked') {
  $lock = [IO.File]::Open((Join-Path $state.root 'obsolete.dll'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try { try { Invoke-ReplaceProgram $state; throw 'EXPECTED_REJECTION' } catch { if ($_.Exception.Message -eq 'EXPECTED_REJECTION') { throw }; if (-not (Test-Path -LiteralPath (Join-Path $state.backup 'CIKE.exe'))) { throw 'Lock test did not reach partial backup' } }; Invoke-Rollback $state }
  finally { $lock.Dispose() }
  exit 0
}
if ($Scenario -eq 'copy-failure') {
  $originalMove = (Get-Item Function:Move-ProgramEntry).ScriptBlock
  function Move-ProgramEntry([string] $Source, [string] $Destination) {
    if ($Source -eq (Join-Path $state.stage 'resources')) { throw 'fixture replacement failure' }
    & $originalMove $Source $Destination
  }
  try { Invoke-ReplaceProgram $state; throw 'EXPECTED_REJECTION' } catch { if ($_.Exception.Message -ne 'fixture replacement failure') { throw } }
  Invoke-Rollback $state
  exit 0
}
if ($Scenario -eq 'success' -or $Scenario -eq 'startup-failure') {
  function Start-UpdatedApp($State, [bool] $Confirm) {
    if (-not $Confirm) { [IO.File]::WriteAllText((Join-Path $State.transaction 'restarted-old'), 'yes'); return $null }
    if ($Scenario -eq 'success') {
      Write-Json (Join-Path $State.transaction 'confirmed.json') @{ transactionId = $State.transactionId; token = $State.confirmationToken; pid = $PID; version = $State.version }
    }
    return [pscustomobject]@{ Id = $PID; HasExited = ($Scenario -eq 'startup-failure') }
  }
  [IO.File]::WriteAllText((Join-Path $state.transaction 'apply.ready'), $state.transactionId)
  $code = Invoke-Update $ManifestFile
  if ($Scenario -eq 'success' -and $code -ne 0) { throw 'Success scenario failed' }
  if ($Scenario -eq 'startup-failure' -and $code -ne 1) { throw 'Startup failure was not rolled back' }
  exit 0
}
throw 'Unknown scenario'
`;

for (const scenario of ['success', 'copy-failure', 'locked', 'startup-failure', 'tamper']) {
  test(`Windows helper ${scenario}: program transaction preserves every data directory`, { skip: process.platform !== 'win32' }, () => {
    const fixture = makeFixture();
    try {
      const runner = path.join(fixture.state.transaction, 'runner.ps1');
      write(runner, helperRunner);
      const powershell = require('../src/platform').systemExecutable('powershell');
      execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner, '-Helper', path.resolve(__dirname, '../electron/windows-update.ps1'), '-ManifestFile', fixture.manifest, '-Scenario', scenario], { windowsHide: true, timeout: 30000, encoding: 'utf8' });
      preserved(fixture);
      assert.equal(fs.readFileSync(path.join(fixture.root, 'CIKE.exe'), 'utf8'), scenario === 'success' ? 'new executable' : 'old executable');
      assert.equal(fs.existsSync(path.join(fixture.root, 'fresh.dll')), scenario === 'success');
      assert.equal(fs.existsSync(path.join(fixture.root, 'obsolete.dll')), scenario !== 'success');
      if (scenario === 'success') {
        assert.equal(fs.existsSync(fixture.state.backup), false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.state.transaction, 'status.json'))).phase, 'completed');
      }
      if (scenario === 'startup-failure') {
        assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.state.transaction, 'status.json'))).phase, 'rolled-back');
        assert.equal(fs.existsSync(path.join(fixture.state.transaction, 'restarted-old')), true);
      }
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });
}

test('startup confirmation requires the intended version and handoff token; rollback permits retry', async () => {
  const fixture = makeFixture(), previousToken = process.env.CIKE_UPDATE_TOKEN;
  try {
    const pending = path.join(fixture.paths.updatesDir, 'pending.json');
    write(pending, JSON.stringify({ transactionId: fixture.state.transactionId, version: '0.7.1', root: fixture.root, confirmationToken: fixture.state.confirmationToken }));
    write(path.join(fixture.state.transaction, 'status.json'), '{"phase":"awaiting-confirmation"}');
    const options = { platform: 'win32', app: { getVersion: () => '0.7.1' } };
    delete process.env.CIKE_UPDATE_TOKEN;
    await assert.rejects(confirmUpdateStartup(fixture.paths, options), /令牌/);
    process.env.CIKE_UPDATE_TOKEN = fixture.state.confirmationToken;
    assert.equal((await confirmUpdateStartup(fixture.paths, options)).confirmed, true);
    assert.equal(fs.existsSync(pending), true, 'the helper owns cleanup after checking confirmation');
    write(path.join(fixture.state.transaction, 'status.json'), '{"phase":"rolled-back","error":"fixture failure"}');
    assert.equal((await confirmUpdateStartup(fixture.paths, options)).phase, 'rolled-back');
    assert.equal(fs.existsSync(pending), false);
  } finally {
    if (previousToken === undefined) delete process.env.CIKE_UPDATE_TOKEN; else process.env.CIKE_UPDATE_TOKEN = previousToken;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('update restart preserves the complete portable directory configuration', () => {
  const env = { LFB_DATA: 'D:\\CIKE\\data', LFB_BROWSER_DIR: 'D:\\CIKE\\browsers', LFB_DOWNLOADS_DIR: 'D:\\CIKE\\Downloads', LFB_TEMP_DIR: 'D:\\CIKE\\data\\temp', NODE_OPTIONS: '--require untrusted.js', ELECTRON_RUN_AS_NODE: '1' };
  const inherited = updater.restartEnvironment({ PATH: 'system-only' }, env);
  for (const name of ['LFB_DATA', 'LFB_BROWSER_DIR', 'LFB_DOWNLOADS_DIR', 'LFB_TEMP_DIR']) assert.equal(inherited[name], env[name]);
  assert.equal(inherited.NODE_OPTIONS, undefined);
  assert.equal(inherited.ELECTRON_RUN_AS_NODE, undefined);
});

test('confirmed update survives interrupted cleanup without locking future installs', async () => {
  const fixture = makeFixture();
  try {
    const pending = path.join(fixture.paths.updatesDir, 'pending.json');
    write(pending, JSON.stringify({ transactionId: fixture.state.transactionId, version: '0.7.1', root: fixture.root, confirmationToken: fixture.state.confirmationToken }));
    write(path.join(fixture.state.transaction, 'status.json'), '{"phase":"confirmed"}');
    write(path.join(fixture.state.transaction, 'confirmed.json'), JSON.stringify({ transactionId: fixture.state.transactionId, version: '0.7.1', token: fixture.state.confirmationToken }));
    const result = await confirmUpdateStartup(fixture.paths, { platform: 'win32', app: { getVersion: () => '0.7.1' } });
    assert.equal(result.confirmed, true);
    assert.equal(fs.existsSync(pending), false);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('failed HTTP response bodies cannot emit an unhandled stream error', async () => {
  const filename = path.resolve(__dirname, '../electron/updater.js');
  let uncaught = null;
  const fakeHttps = { get(_url, _options, callback) {
    const request = new EventEmitter(); request.setTimeout = () => request;
    queueMicrotask(() => {
      const response = new EventEmitter(); response.statusCode = 503; response.resume = () => {};
      callback(response);
      try { response.emit('error', new Error('fixture HTTP reset')); } catch (error) { uncaught = error; }
    });
    return request;
  } };
  const exports = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: name => name === 'https' ? fakeHttps : require(name), module: exports, process, Buffer, queueMicrotask, setTimeout, clearTimeout, URL, AbortController,
  }, { filename });
  await assert.rejects(exports.exports._test.get(assetURL), /503/);
  assert.equal(uncaught, null);
});
