'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { curl } = require('../src/proxycheck');
const chromium = require('../electron/chromium');
const { extractZip, executableVersion, systemExecutable, systemEnvironment } = require('../src/platform');

test('system curl reaches the chosen proxy on Windows despite NO_PROXY', async () => {
  let authentication;
  const server = http.createServer((req, res) => {
    authentication = req.headers['proxy-authorization'];
    res.end('proxy fixture');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.NO_PROXY;
  process.env.NO_PROXY = '*';
  try {
    assert.equal(await curl({ type: 'http', host: '127.0.0.1', port: server.address().port,
      username: 'fixture', password: 'secret' }, 'http://unresolvable.invalid'), 'proxy fixture');
    assert.equal(authentication, 'Basic ' + Buffer.from('fixture:secret').toString('base64'));
  } finally {
    if (previous === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = previous;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('a relative Chromium marker survives moving the whole portable directory', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-move-'));
  const original = path.join(temporary, 'original');
  const moved = path.join(temporary, 'moved 中文');
  try {
    fs.mkdirSync(path.join(original, 'browsers', '123', 'chrome-win64'), { recursive: true });
    fs.writeFileSync(path.join(original, 'browsers', '123', 'chrome-win64', 'chrome.exe'), 'fixture');
    fs.writeFileSync(path.join(original, 'browsers', 'chromium-executable.txt'), '123/chrome-win64/chrome.exe\n');
    fs.renameSync(original, moved);
    assert.equal(chromium.readInstalledExecutable(moved), path.join(moved, 'browsers', '123', 'chrome-win64', 'chrome.exe'));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

// Stored ZIP fixtures avoid adding any archive package or external tooling.
function zipFixture(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = Buffer.from(entry.content || 'fixture');
    let crc = 0xffffffff;
    for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(content.length, 18); header.writeUInt32LE(content.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, content);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(content.length, 20); directory.writeUInt32LE(content.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(entry.attributes || 0, 38); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + content.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.reduce((n, item) => n + item.length, 0), 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

test('Windows helpers use absolute system tools and drop inherited proxy overrides', () => {
  const options = { platform: 'win32', env: { SystemRoot: 'C:\\Windows', PATH: 'D:\\attacker', HTTPS_PROXY: 'bad', NO_PROXY: '*' } };
  assert.equal(systemExecutable('curl', options), 'C:\\Windows\\System32\\curl.exe');
  assert.equal(systemExecutable('powershell', options), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const env = systemEnvironment(options);
  assert.equal(env.PATH, 'C:\\Windows\\System32');
  assert.equal(env.HTTPS_PROXY, undefined); assert.equal(env.NO_PROXY, undefined);
});

test('Windows helper environment retains account directories and starts module discovery at the OS', () => {
  const source = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\runneradmin',
    APPDATA: 'C:\\Users\\runneradmin\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\runneradmin\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files', ProgramData: 'C:\\ProgramData',
    HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\runneradmin', TEMP: 'D:\\CIKE\\data\\temp', TMP: 'D:\\CIKE\\data\\temp',
    PSModulePath: '\\\\unavailable.invalid\\modules', NODE_OPTIONS: '--require unwanted.js',
    POWERSHELL_TELEMETRY_OPTOUT: '0', HTTPS_PROXY: 'http://unwanted.invalid', CURL_HOME: 'D:\\unwanted' };
  const result = systemEnvironment({ platform: 'win32', env: source });
  for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramData', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP']) {
    assert.equal(result[key], source[key], `required Windows environment variable ${key} was lost`);
  }
  assert.equal(result.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  for (const key of ['NODE_OPTIONS', 'HTTPS_PROXY', 'CURL_HOME']) assert.equal(result[key], undefined);
});

test('Windows helper starts the actual system PowerShell with a bounded module path and usable account environment', { skip: process.platform !== 'win32' }, () => {
  const { execFileSync } = require('node:child_process');
  const environment = systemEnvironment({ env: { ...process.env, PSModulePath: '\\\\unavailable.invalid\\modules' } });
  const script = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSModuleAutoLoadingPreference = 'None'
Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1"
$command = Get-Command Get-Acl -ErrorAction Stop
[pscustomobject]@{ modulePath = $env:PSModulePath; moduleFile = $command.Module.Path; appdata = $env:APPDATA; localappdata = $env:LOCALAPPDATA; userprofile = $env:USERPROFILE } | ConvertTo-Json -Compress`;
  const result = JSON.parse(execFileSync(systemExecutable('powershell'), ['-NoLogo', '-NoProfile', '-NonInteractive',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  { env: environment, windowsHide: true, timeout: 15000, encoding: 'utf8' }));
  const systemModules = path.join(path.dirname(systemExecutable('powershell')), 'Modules');
  const modules = result.modulePath.split(';').filter(Boolean).map(value => path.resolve(value).toLowerCase());
  // PowerShell 5 itself can prepend its standard machine module directory.
  // Neither inherited UNC paths, user modules nor unexpanded environment
  // strings may be introduced into its effective discovery path.
  const allowed = [systemModules.toLowerCase(), path.join(process.env.ProgramFiles, 'WindowsPowerShell', 'Modules').toLowerCase()];
  assert.ok(modules.includes(systemModules.toLowerCase()));
  for (const modulePath of modules) assert.ok(allowed.includes(modulePath), `unexpected module search path: ${modulePath}`);
  assert.ok(path.resolve(result.moduleFile).toLowerCase().startsWith(systemModules.toLowerCase() + path.sep));
  assert.equal(result.appdata, process.env.APPDATA);
  assert.equal(result.localappdata, process.env.LOCALAPPDATA);
  assert.equal(result.userprofile, process.env.USERPROFILE);
});

test('Windows reads real PE versions without launching the executable', { skip: process.platform !== 'win32' }, async () => {
  const version = await executableVersion(process.execPath);
  assert.match(version, /^\d+\.\d+\.\d+\.\d+$/);
  assert.ok(version.startsWith(process.versions.node + '.'));
});

test('Windows runtime helper extracts ZIPs and reads PE versions with module auto-loading disabled', { skip: process.platform !== 'win32' }, () => {
  const { execFileSync } = require('node:child_process');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-modules-'));
  try {
    const archive = path.join(temporary, '内核 安装.zip');
    const destination = path.join(temporary, '解压 结果');
    const runner = path.join(temporary, 'runner.ps1');
    fs.writeFileSync(archive, zipFixture([{ name: 'chrome-win64/中文 文件.txt', content: 'valid contents' }]));
    // Both operations must work without discovering modules through inherited
    // user or network module paths, which can stall a clean Windows runner.
    fs.writeFileSync(runner, String.raw`param([string] $Helper, [string] $Archive, [string] $Destination, [string] $Executable)
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
& $Helper -Operation ExtractZip -Archive $Archive -Destination $Destination
& $Helper -Operation Version -Executable $Executable
`);
    const output = execFileSync(systemExecutable('powershell'), ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass', '-File', runner, '-Helper', path.resolve(__dirname, '../src/windows-runtime.ps1'),
      '-Archive', archive, '-Destination', destination, '-Executable', process.execPath],
    { env: { ...systemEnvironment(), PSModulePath: path.join(temporary, 'missing-modules') }, windowsHide: true, timeout: 15000, encoding: 'utf8' });
    assert.equal(fs.readFileSync(path.join(destination, 'chrome-win64', '中文 文件.txt'), 'utf8'), 'valid contents');
    assert.ok(output.trim().startsWith(process.versions.node + '.'));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('Windows ZIP extraction accepts a normal hidden ancestor without treating it as missing', { skip: process.platform !== 'win32' }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-hidden-'));
  const hidden = path.join(temporary, 'hidden-parent');
  fs.mkdirSync(hidden);
  try {
    const { execFileSync } = require('node:child_process');
    const script = '[IO.File]::SetAttributes($env:CIKE_HIDDEN_TARGET, [IO.FileAttributes]::Directory -bor [IO.FileAttributes]::Hidden)';
    execFileSync(systemExecutable('powershell'), ['-NoProfile','-NonInteractive','-Command',script], {
      env: { ...systemEnvironment(), CIKE_HIDDEN_TARGET: hidden }, windowsHide: true, timeout: 10000,
    });
    const archive = path.join(temporary, 'fixture.zip');
    fs.writeFileSync(archive, zipFixture([{ name: 'chrome-win64/test.txt', content: 'hidden-parent fixture' }]));
    const destination = path.join(hidden, 'extracted');
    await extractZip(archive, destination);
    assert.equal(fs.readFileSync(path.join(destination, 'chrome-win64/test.txt'), 'utf8'), 'hidden-parent fixture');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('Windows ZIP extraction supports spaces and Unicode and rejects unsafe entries before writing', { skip: process.platform !== 'win32' }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-zip-'));
  try {
    const archive = path.join(temporary, '内核 安装.zip');
    const destination = path.join(temporary, '解压 结果');
    fs.writeFileSync(archive, zipFixture([{ name: 'chrome-win64/中文 文件.txt', content: 'valid contents' }]));
    await extractZip(archive, destination);
    assert.equal(fs.readFileSync(path.join(destination, 'chrome-win64', '中文 文件.txt'), 'utf8'), 'valid contents');
    const invalid = [
      [{ name: '../outside.txt' }], [{ name: '/absolute.txt' }], [{ name: 'C:/absolute.txt' }],
      [{ name: 'chrome/evil:stream' }], [{ name: 'chrome/NUL.txt' }],
      [{ name: 'chrome/link', attributes: (0xa1ff * 65536) >>> 0 }],
      [{ name: 'chrome/one' }, { name: 'CHROME/ONE' }],
      [{ name: 'chrome' }, { name: 'chrome/nested' }],
    ];
    for (let index = 0; index < invalid.length; index++) {
      const blocked = path.join(temporary, `blocked-${index}`);
      fs.writeFileSync(archive, zipFixture([{ name: 'safe.txt' }, ...invalid[index]]));
      await assert.rejects(extractZip(archive, blocked), /Unsafe|forbidden|duplicated|Conflicting/);
      assert.equal(fs.existsSync(blocked), false, 'prevalidation wrote archive contents');
    }
    assert.equal(fs.existsSync(path.join(temporary, 'outside.txt')), false);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('marker rejects traversal and external absolute programs, while accepting old in-root absolute markers', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-marker-'));
  try {
    const browsers = path.join(temporary, 'browsers');
    fs.mkdirSync(browsers);
    const external = path.join(temporary, 'outside.exe'), internal = path.join(browsers, 'chrome.exe');
    fs.writeFileSync(external, 'outside'); fs.writeFileSync(internal, 'inside');
    const marker = path.join(browsers, 'chromium-executable.txt');
    for (const value of ['../outside.exe', external]) {
      fs.writeFileSync(marker, value);
      assert.equal(chromium.readInstalledExecutable(temporary), null);
    }
    fs.writeFileSync(marker, internal);
    assert.equal(chromium.readInstalledExecutable(temporary), internal);
    fs.unlinkSync(marker);
    assert.equal(chromium.readInstalledExecutable(temporary), null);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('explicit executable status is opt-in and uses the same exact version comparison', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-explicit-'));
  try {
    const executable = path.join(temporary, 'outside.exe');
    fs.writeFileSync(executable, 'fixture');
    const options = { version: '123.4.5.6', readVersion: async value => {
      assert.equal(value, executable); return '123.4.5.6';
    } };
    assert.equal((await chromium.chromiumStatus(temporary, options)).installed, false);
    const status = await chromium.chromiumStatus(temporary, { ...options, executable });
    assert.equal(status.installed, true);
    assert.equal(status.updateAvailable, false);
    assert.equal(status.executable, executable);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('Chromium installs on the browser volume, writes a relative marker and preserves old install on mismatch', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-install-'));
  try {
    const options = { platform: 'win32', arch: 'x64', version: '123.4.5.6',
      fetch: async () => new Response(Buffer.from('fixture archive')),
      extract: async (archive, destination) => {
        assert.ok(archive.startsWith(path.join(temporary, 'browsers') + path.sep));
        assert.ok(destination.startsWith(path.join(temporary, 'browsers') + path.sep));
        fs.writeFileSync(path.join(destination, 'chrome.exe'), '123.4.5.6');
      }, readVersion: async executable => fs.readFileSync(executable, 'utf8') };
    const installed = await chromium.downloadChromium(temporary, () => { throw new Error('renderer closed'); }, options);
    assert.equal(chromium.readInstalledExecutable(temporary), installed);
    const marker = fs.readFileSync(chromium.executableMarker(temporary), 'utf8');
    assert.equal(path.isAbsolute(marker.trim()), false);
    assert.equal((await chromium.chromiumStatus(temporary, options)).updateAvailable, false);
    assert.equal((await chromium.chromiumStatus(temporary, { ...options, version: '123.4.5.60' })).updateAvailable, true);
    await assert.rejects(chromium.downloadChromium(temporary, null, { ...options, version: '124.4.5.6' }), /版本不匹配/);
    assert.equal(fs.readFileSync(chromium.executableMarker(temporary), 'utf8'), marker);
    assert.equal(fs.existsSync(installed), true);
    assert.equal(fs.readdirSync(path.join(temporary, 'browsers')).some(name => name.startsWith('.install-')), false);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('Chromium download rejects insecure redirects, oversized/truncated streams, stream failures, and unwritable destinations', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-download-'));
  try {
    let index = 0;
    const run = options => chromium.downloadFile('https://fixture.invalid/kernel.zip', path.join(temporary, `${index++}.zip`), null, options);
    await assert.rejects(run({ fetch: async () => new Response(null, { status: 302, headers: { location: 'http://fixture.invalid/insecure.zip' } }) }), /HTTPS/);
    await assert.rejects(run({ maxBytes: 5, fetch: async () => new Response('123456') }), /过大/);
    await assert.rejects(run({ fetch: async () => new Response('123', { headers: { 'content-length': '9' } }) }), /不完整/);
    await assert.rejects(run({ fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream fixture failure')); } })) }), /stream fixture failure/);
    await assert.rejects(chromium.downloadFile('https://fixture.invalid/kernel.zip', path.join(temporary, 'missing', 'target'), null,
      { fetch: async () => new Response('valid body') }), /ENOENT/);
    await assert.rejects(run({ timeoutMs: 20, fetch: async () => new Response(new ReadableStream({ start() {} })) }), /aborted/i);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
