'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { ProfileStore } = require('../src/store');
const { ProxyStore } = require('../src/proxystore');
const { privateDirectory, protectFile, readJSON, writeJSON, writePrivate, credentials } = require('../src/privatefiles');
const { HOST_PLATFORM } = require('../src/fingerprint');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cike-security-'));
const provider = { encrypt: s => Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s, 'base64').toString() }; // codec fixture, not production encryption

function windowsFixture(script, target) {
  const { systemExecutable, systemEnvironment } = require('../src/platform');
  return cp.execFileSync(systemExecutable('powershell'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ' + script,
  ], { windowsHide: true, encoding: 'utf8', env: { ...systemEnvironment(), CIKE_ACL_TARGET: target }, timeout: 30000 }).trim();
}
function permissions(target) {
  return JSON.parse(windowsFixture('$acl = Get-Acl -LiteralPath $env:CIKE_ACL_TARGET; @{ owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; protected = $acl.AreAccessRulesProtected; rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { @{ sid = $_.IdentityReference.Value; allow = $_.AccessControlType -eq "Allow"; full = $_.FileSystemRights -eq "FullControl"; inherited = $_.IsInherited; inheritance = [int]$_.InheritanceFlags } }) } | ConvertTo-Json -Depth 4 -Compress', target));
}
function assertPrivate(target, directory = false) {
  if (process.platform !== 'win32') return assert.equal(fs.statSync(target).mode & 0o777, directory ? 0o700 : 0o600);
  const acl = permissions(target);
  const trusted = [acl.current, 'S-1-5-18', 'S-1-5-32-544'];
  // Elevated Windows creates inherited files with Administrators as owner.
  assert.ok(trusted.includes(acl.owner));
  assert.ok(acl.rules.length >= 3);
  assert.ok(acl.rules.every(rule => rule.allow && trusted.includes(rule.sid)));
  for (const sid of trusted) assert.ok(acl.rules.some(rule => rule.sid === sid && rule.full));
  if (directory) {
    assert.equal(acl.protected, true);
    assert.ok(acl.rules.every(rule => !rule.inherited && rule.inheritance === 3));
  }
}

test('legacy migration is explicit, credentials stay private, corrupt data fails closed', async () => {
  const { BrowserManager } = require('../src/browser');
  const dir = temp();
  try {
    const store = new ProfileStore(dir);
    const old = store.create({ name: 'old', proxy: { server: 'http://127.0.0.1:1234', password: 'test-secret' } });
    const records = JSON.parse(fs.readFileSync(store.file));
    delete records[old.id].fingerprintMode;
    Object.assign(records[old.id], { platform: 'win', hardwareConcurrency: 4, deviceMemory: 8, canvasNoise: true, webrtc: 'disabled' });
    fs.writeFileSync(store.file, JSON.stringify(records));
    fs.mkdirSync(store.profileDir(old.id));
    fs.writeFileSync(path.join(store.profileDir(old.id), 'session-fixture'), 'preserved');
    if (process.platform !== 'win32') { fs.chmodSync(store.file, 0o644); fs.chmodSync(dir, 0o755); }
    const loaded = new ProfileStore(dir, provider);
    assert.equal(loaded.get(old.id).fingerprintMode, 'legacy');
    await assert.rejects(new BrowserManager(loaded).open(old.id), /转换/);
    assertPrivate(dir, true);
    assertPrivate(store.file);
    assert.ok(!fs.readFileSync(store.file, 'utf8').includes('test-secret'));
    assert.equal(loaded.get(old.id).proxy.password, 'test-secret');
    assert.equal(loaded.public(loaded.get(old.id)).proxy.password, undefined);
    assert.throws(() => new ProfileStore(dir), /桌面版/);
    const migrated = loaded.update(old.id, { fingerprintMode: 'native' });
    assert.equal(migrated.platform, HOST_PLATFORM);
    assert.equal(migrated.previousFingerprint.platform, 'win');
    assert.equal(migrated.hardwareConcurrency, null);
    assert.equal(migrated.webrtc, 'restricted');
    assert.equal(fs.readFileSync(path.join(store.profileDir(old.id), 'session-fixture'), 'utf8'), 'preserved');
    assert.throws(() => loaded.create({ hardwareConcurrency: 4 }), /原生一致/);
    assert.throws(() => loaded.create({ proxy: { server: 'http://user:pass@localhost:80' } }), /认证/);
    assert.throws(() => loaded.profileDir('../escape'), /ID/);
    fs.writeFileSync(store.file, '{broken');
    assert.throws(() => new ProfileStore(dir), /恢复备份/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing, failed, stale and unknown-region proxies cannot launch or fall back', async () => {
  const { BrowserManager } = require('../src/browser');
  const dir = temp();
  let manager;
  try {
    const store = new ProfileStore(dir), proxies = new ProxyStore(dir, provider);
    const x = proxies.add({ type: 'http', host: '127.0.0.1', port: 9, password: 'test-secret' });
    const p = store.create({ proxyId: x.id });
    assert.ok(!fs.readFileSync(proxies.file, 'utf8').includes('test-secret'));
    let check = async () => ({ status: 'failed', error: 'fixture authentication rejected' });
    manager = new BrowserManager(store, proxies, null, { checkProxy: (...args) => check(...args) });
    await assert.rejects(manager.open(p.id), /authentication/);
    check = async () => ({ status: 'ok', exitIp: '192.0.2.1', countryCode: null, timezone: null });
    await assert.rejects(manager.open(p.id), /时区未知/);
    store.update(p.id, { timezone: 'UTC' });
    await assert.rejects(manager.open(p.id), /地区未知/);
    check = async () => { proxies.update(x.id, { port: 10 }); return { status: 'ok' }; };
    await assert.rejects(manager.open(p.id), /发生变化/);
    proxies.remove(x.id);
    await assert.rejects(manager.open(p.id), /阻止直连/);
    assert.equal(manager.sessions.size, 0);
  } finally { await manager?.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('API uses header auth, rejects foreign origins, protects proxy references and redacts inline passwords', async () => {
  const { buildBackend } = require('../src/server');
  const dir = temp(), b = buildBackend(dir);
  const server = http.createServer(b.app.callback());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  const request = (p, method = 'GET', body, headers = {}) => fetch(url + p, { method, headers: { 'x-api-token': b.token, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  try {
    // Koa routes are case insensitive by default: authentication must cover
    // every spelling that can reach the same route, including /API itself.
    for (const prefix of ['/api', '/API', '/Api']) {
      const endpoint = `http://127.0.0.1:${server.address().port}${prefix}/profiles`;
      assert.equal((await fetch(endpoint)).status, 401, `${prefix} without a token`);
      assert.equal((await fetch(endpoint, { headers: { 'x-api-token': 'invalid-token' } })).status, 401);
      assert.equal((await fetch(endpoint, { headers: { 'x-api-token': b.token, origin: 'https://example.com' } })).status, 403);
      assert.equal((await fetch(endpoint, { headers: { 'x-api-token': b.token } })).status, 200);
      const preflight = await fetch(endpoint, { method: 'OPTIONS', headers: { origin: 'null' } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), 'null');
    }
    assert.equal((await fetch(url + '/profiles?token=' + b.token)).status, 401);
    assert.equal((await request('/profiles', 'GET', null, { origin: 'https://example.com' })).status, 403);
    const preflight = await fetch(url + '/profiles', { method: 'OPTIONS', headers: { origin: 'null', 'Access-Control-Request-Headers': 'x-api-token,content-type' } });
    assert.equal(preflight.status, 204);
    const p = b.store.create({ proxy: { server: 'http://127.0.0.1:9', password: 'fixture-secret' } });
    assert.ok(!(await (await request('/profiles')).text()).includes('fixture-secret'));
    const x = b.proxyStore.add({ type: 'http', host: '127.0.0.1', port: 9 });
    b.store.update(p.id, { proxyId: x.id });
    assert.equal((await request('/proxies/' + x.id, 'DELETE')).status, 409);
    assert.equal((await request('/profiles/' + p.id, 'PATCH', { proxyId: null })).status, 200);
    assert.equal((await request('/proxies/' + x.id, 'DELETE')).status, 200);
  } finally { await b.browsers.closeAll(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('private files preserve encrypted credentials, reject damaged records and label OS storage accurately', () => {
  const dir = temp();
  try {
    privateDirectory(dir);
    const file = path.join(dir, 'proxy 密码.json');
    const codec = credentials(provider);
    assert.equal(codec.protection, 'system-safe-storage');
    writeJSON(file, { password: codec.encode('private-test-secret') });
    assert.ok(!fs.readFileSync(file, 'utf8').includes('private-test-secret'));
    assert.equal(codec.decode(readJSON(file).password), 'private-test-secret');
    assert.throws(() => credentials().decode(readJSON(file).password), /桌面版/);
    assertPrivate(dir, true); assertPrivate(file);
    fs.writeFileSync(file, '{damaged');
    assert.throws(() => readJSON(file), /恢复备份/);
    assert.equal(readJSON(path.join(dir, 'missing.json'), 'missing'), 'missing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('private writes reject symlinks and Windows junction parents without changing the target', () => {
  const dir = temp();
  const outside = path.join(dir, 'outside'), link = path.join(dir, 'link');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.json'), '{"unchanged":true}');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => privateDirectory(link), /符号链接|重解析点/);
    if (process.platform === 'win32') {
      assert.throws(() => writeJSON(path.join(link, 'secret.json'), { replaced: true }), /符号链接|重解析点/);
      assert.throws(() => readJSON(path.join(link, 'secret.json')), /符号链接|重解析点/);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outside, 'secret.json'))), { unchanged: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('POSIX private paths accept normal symlinked ancestors such as macOS /var', { skip: process.platform === 'win32' }, () => {
  const dir = temp(), real = path.join(dir, 'real'), alias = path.join(dir, 'alias');
  try {
    fs.mkdirSync(real); fs.symlinkSync(real, alias, 'dir');
    const nested = path.join(alias, 'data');
    privateDirectory(nested);
    writeJSON(path.join(nested, 'settings.json'), { retained: true });
    assert.deepEqual(readJSON(path.join(real, 'data', 'settings.json')), { retained: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Windows private ACL removes inherited and explicit public access without modifying parent permissions', { skip: process.platform !== 'win32' }, () => {
  const dir = temp(), data = path.join(dir, 'data 中文'), browsers = path.join(dir, 'browsers');
  fs.mkdirSync(data); fs.mkdirSync(browsers);
  try {
    // Add an explicit Everyone grant in addition to the inherited temp ACL.
    const grant = '$acl = Get-Acl -LiteralPath $env:CIKE_ACL_TARGET; $sid = New-Object Security.Principal.SecurityIdentifier("S-1-1-0"); $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow"); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:CIKE_ACL_TARGET -AclObject $acl';
    windowsFixture(grant, data);
    const parentBefore = windowsFixture('(Get-Acl -LiteralPath $env:CIKE_ACL_TARGET).Sddl', dir);
    privateDirectory(data); privateDirectory(browsers);
    assertPrivate(data, true); assertPrivate(browsers, true);
    windowsFixture(grant, data);
    privateDirectory(data); assertPrivate(data, true);
    assert.equal(windowsFixture('(Get-Acl -LiteralPath $env:CIKE_ACL_TARGET).Sddl', dir), parentBefore);
    const file = path.join(data, 'api_token.txt');
    fs.writeFileSync(file, 'fixture'); protectFile(file); assertPrivate(file);
    // A newly created directory within the same process must also be private.
    const child = path.join(data, 'profiles', 'new'); privateDirectory(child); assertPrivate(child, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Windows private-directory protection refuses a drive root', { skip: process.platform !== 'win32' }, () => {
  assert.throws(() => privateDirectory(path.parse(process.cwd()).root), /磁盘根目录/);
});

test('Windows private-file saves reuse verified ACLs and permission failures fail closed', { skip: process.platform !== 'win32' }, t => {
  const dir = temp(), data = path.join(dir, 'data');
  const original = cp.execFileSync;
  let calls = 0, fail = false;
  t.mock.method(cp, 'execFileSync', function (executable, args, options) {
    if (args.some(arg => String(arg).endsWith('windows-permissions.ps1'))) {
      calls += 1;
      if (fail) throw new Error('fixture ACL failure');
    }
    return original.call(this, executable, args, options);
  });
  try {
    privateDirectory(data);
    const initial = calls;
    for (let i = 0; i < 5; i++) {
      writeJSON(path.join(data, 'settings.json'), { value: i });
      assert.deepEqual(readJSON(path.join(data, 'settings.json')), { value: i });
    }
    assert.equal(calls, initial, 'ordinary atomic saves must not start PowerShell');
    privateDirectory(path.join(data, 'new-profile'));
    assert.equal(calls, initial + 1);
    fail = true;
    const blocked = path.join(dir, 'blocked', 'secret.txt');
    assert.throws(() => writePrivate(blocked, 'secret'), /私有 Windows 权限/);
    assert.equal(fs.existsSync(blocked), false);
  } finally { t.mock.restoreAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('process matching accepts quoted Windows-style options and rejects a different profile suffix', () => {
  const { profileProcesses } = require('./helpers/processes');
  const directory = path.resolve('fixture 中文 space');
  const commands = [
    `browser --user-data-dir=${directory} --site-per-process`,
    `"browser path" "--user-data-dir=${directory}" --site-per-process`,
    `browser --user-data-dir="${directory}" --site-per-process`,
    `browser --user-data-dir=${directory}-other --site-per-process`,
  ];
  assert.deepEqual(profileProcesses(directory, commands), commands.slice(0, 3));
});

test('process query observes and confirms exit of a real child with a Chinese space directory', { timeout: 30000 }, async () => {
  const { profileProcesses, waitForProfileExit } = require('./helpers/processes');
  const directory = path.resolve('process fixture 中文 space');
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--user-data-dir=${directory}`], { windowsHide: true, stdio: 'ignore' });
  const stopped = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    assert.equal(profileProcesses(directory).length, 1);
  } finally {
    child.kill(); await stopped;
  }
  await waitForProfileExit(directory);
});
