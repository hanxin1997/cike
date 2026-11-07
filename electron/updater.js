'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { Readable } = require('stream');
const { execFile, spawn } = require('child_process');

const REPO = 'hanxin1997/cike';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const RESERVED = ['data', 'browsers', 'downloads'];
let installing = false;

function electronApp() { return require('electron').app; }
function compare(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b)) throw new Error('更新版本格式无效');
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

// Requests stay in this repository; only redirects may reach GitHub asset storage.
function validateURL(value, { redirect = false, metadata = false } = {}) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) throw new Error('更新地址必须是可信 GitHub HTTPS 地址');
  if (metadata && url.href === API_URL) return url.href;
  if (url.hostname === 'github.com' && url.pathname.startsWith(`/${REPO}/releases/download/`)) return url.href;
  if (redirect && ASSET_HOSTS.has(url.hostname)) return url.href;
  throw new Error('更新地址不属于本仓库的 GitHub Releases');
}

function consume(stream, file, { maxBytes, signal, onProgress, total }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0, ended = false, settled = false;
    const output = file ? fs.createWriteStream(file, { flags: 'wx' }) : null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) { output?.destroy(); stream.destroy?.(); reject(error); }
      else resolve(value);
    };
    const abort = () => finish(new Error('更新下载超时或已取消'));
    signal?.addEventListener('abort', abort, { once: true });
    output?.on('error', error => finish(error));
    stream.on('error', error => finish(error));
    stream.on('aborted', () => finish(new Error('更新下载连接中断')));
    stream.on('close', () => { if (!ended) finish(new Error('更新下载连接提前关闭')); });
    stream.on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) return finish(new Error('更新文件超过允许的大小'));
      if (output) {
        if (!output.write(chunk)) { stream.pause(); output.once('drain', () => stream.resume()); }
      } else chunks.push(chunk);
      try { onProgress?.({ phase: 'download', received: bytes, total: total || null }); } catch { /* UI observers do not control integrity checks. */ }
    });
    stream.on('end', () => {
      ended = true;
      if (settled) return;
      if (total != null && bytes !== total) return finish(new Error('更新文件下载不完整'));
      if (output) output.end(() => finish(null, file));
      else finish(null, Buffer.concat(chunks).toString('utf8'));
    });
    if (signal?.aborted) abort();
  });
}

async function get(url, file, options = {}) {
  const { fetch: fetcher, maxBytes = file ? MAX_ARCHIVE_BYTES : MAX_CONTENT_BYTES, onProgress, timeout = 120000 } = options;
  let current = validateURL(url, { metadata: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const headers = { 'User-Agent': 'CIKE', Accept: 'application/vnd.github+json', 'Accept-Encoding': 'identity' };
      let result;
      if (fetcher) {
        const response = await fetcher(current, { headers, redirect: 'manual', signal: controller.signal });
        if (response.redirected) throw new Error('更新下载器必须显式检查重定向');
        if (response.status >= 300 && response.status < 400) {
          result = { redirect: response.headers.get('location') };
          await response.body?.cancel();
        } else {
          if (response.status !== 200) { await response.body?.cancel(); throw new Error(`更新服务器返回 ${response.status}`); }
          const total = response.headers.get('content-length');
          const size = total == null ? null : Number(total);
          if (size != null && (!Number.isSafeInteger(size) || size < 0 || size > maxBytes)) { await response.body?.cancel(); throw new Error('更新文件大小无效或超过限制'); }
          if (!response.body) throw new Error('更新服务器返回空响应');
          const stream = typeof response.body.on === 'function' ? response.body : Readable.fromWeb(response.body);
          return await consume(stream, file, { maxBytes, signal: controller.signal, onProgress, total: size });
        }
      } else {
        // Attach stream error handlers immediately, before any asynchronous gap.
        result = await new Promise((resolve, reject) => {
          const request = https.get(current, { headers, signal: controller.signal }, response => {
            response.on('error', reject);
            if (response.statusCode >= 300 && response.statusCode < 400) { response.resume?.(); return resolve({ redirect: response.headers.location }); }
            if (response.statusCode !== 200) { response.resume?.(); return reject(new Error(`更新服务器返回 ${response.statusCode}`)); }
            const header = response.headers?.['content-length'];
            const total = header == null ? null : Number(header);
            if (total != null && (!Number.isSafeInteger(total) || total < 0 || total > maxBytes)) { response.destroy(); return reject(new Error('更新文件大小无效或超过限制')); }
            consume(response, file, { maxBytes, signal: controller.signal, onProgress, total }).then(data => resolve({ data }), reject);
          });
          request.on('error', reject);
          request.setTimeout(timeout, () => request.destroy(new Error('更新下载超时')));
        });
        if ('data' in result) return result.data;
      }
      if (!result.redirect || redirects === 5) throw new Error('更新下载重定向过多或地址无效');
      current = validateURL(new URL(result.redirect, current).href, { redirect: true, metadata: true });
    }
  } catch (error) {
    if (file) {
      // A destroyed writer may need a tick to release its Windows file handle.
      for (let retry = 0; retry < 5; retry++) {
        try { fs.rmSync(file, { force: true }); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
      }
    }
    throw error;
  } finally { clearTimeout(timer); }
}

function selectRelease(release, { current, platform = process.platform, arch = process.arch, packaged = true }) {
  const version = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
  if (!VERSION.test(version) || release.draft || release.prerelease) throw new Error('正式更新版本格式无效');
  const releaseURL = `https://github.com/${REPO}/releases/tag/${release.tag_name}`;
  if (release.html_url !== releaseURL) throw new Error('更新发布页面不属于本仓库');
  const supported = (platform === 'win32' && arch === 'x64') || (platform === 'darwin' && arch === 'arm64');
  const assetName = platform === 'win32' ? `CIKE-${version}-win-x64.zip` : `CIKE-${version}-mac-arm64.dmg`;
  const checksumName = platform === 'win32' ? 'SHA256SUMS-win-x64.txt' : 'SHA256SUMS.txt';
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const matches = assets.filter(asset => asset.name === assetName), checksums = assets.filter(asset => asset.name === checksumName);
  const info = { current, latest: version, available: compare(version, current) > 0, url: releaseURL, assetName, downloadUrl: null, checksumUrl: null, supportsInstall: false };
  if (!supported || matches.length !== 1 || checksums.length !== 1) return info;
  for (const asset of [matches[0], checksums[0]]) {
    const expected = `https://github.com/${REPO}/releases/download/${release.tag_name}/${asset.name}`;
    if (asset.browser_download_url !== expected) throw new Error('更新安装包地址与版本或文件名不匹配');
    validateURL(expected);
  }
  return { ...info, downloadUrl: matches[0].browser_download_url, dmgUrl: platform === 'darwin' ? matches[0].browser_download_url : undefined, checksumUrl: checksums[0].browser_download_url, supportsInstall: Boolean(packaged) };
}

async function checkUpdate(options = {}) {
  const app = options.app || electronApp();
  const release = JSON.parse(await get(API_URL, null, options));
  return selectRelease(release, { current: app.getVersion(), packaged: app.isPackaged, platform: options.platform || process.platform, arch: options.arch || process.arch });
}

function checksumFor(text, assetName) {
  const matches = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)$/.exec(line);
    if (match && match[2] === assetName) matches.push(match[1].toLowerCase());
  }
  if (matches.length !== 1) throw new Error('更新校验文件未唯一匹配安装包文件名');
  return matches[0];
}
async function verifyChecksum(file, expected) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error('更新文件 SHA256 校验失败');
}

function inside(root, candidate, allowRoot = false) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (allowRoot || relative !== '') && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function noLinks(candidate) {
  let current = path.resolve(candidate);
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`更新路径不能包含链接: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function programEntry(name) {
  return /^(CIKE\.exe|[^\\/:]+\.dll|icudtl\.dat|chrome_\d+_percent\.pak|resources\.pak|snapshot_blob\.bin|v8_context_snapshot\.bin|vk_swiftshader_icd\.json|LICENSE|LICENSES\.chromium\.html|BUILD-INFO\.txt|version|resources|locales|swiftshader)$/i.test(name);
}
function protectedPaths(paths) {
  const root = path.resolve(paths.baseDir);
  const dirs = [...RESERVED.map(name => path.join(root, name)), ...['dataDir', 'browserDir', 'downloadsDir', 'desktopDir', 'sessionDir', 'tempDir', 'logsDir', 'crashDir', 'updatesDir'].map(key => paths[key]).filter(Boolean)].map(value => path.resolve(value));
  if (dirs.some(value => value.toLowerCase() === root.toLowerCase())) throw new Error('自定义数据目录与安装根重合，无法安全自动更新');
  return [...new Set(dirs)];
}
function validatePackage(stage, paths) {
  const protectedDirs = protectedPaths(paths), names = fs.readdirSync(stage), folded = new Set(), files = [];
  if (!names.includes('CIKE.exe') || !names.includes('resources')) throw new Error('更新包缺少 CIKE.exe 或 resources');
  function walk(folder, relative = '') {
    for (const name of fs.readdirSync(folder)) {
      const rel = relative ? `${relative}/${name}` : name;
      if (name === '.' || name === '..' || /[\\/:\x00-\x1f]/.test(name) || /[ .]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('更新包包含不安全文件名');
      const key = rel.toLowerCase();
      if (folded.has(key)) throw new Error('更新包含重复文件名');
      folded.add(key);
      const source = path.join(folder, name), destination = path.join(paths.baseDir, rel), stat = fs.lstatSync(source);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('更新包不能包含链接或特殊文件');
      if (!relative && (!programEntry(name) || RESERVED.includes(name.toLowerCase()))) throw new Error(`更新包包含非程序目录或文件: ${name}`);
      if (protectedDirs.some(dir => inside(dir, destination, true) || inside(destination, dir, true))) throw new Error('更新包会覆盖保留的数据目录');
      if (stat.isDirectory()) walk(source, rel);
      else files.push({ path: rel, size: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex') });
    }
  }
  noLinks(stage); walk(stage);
  if (!fs.statSync(path.join(stage, 'CIKE.exe')).isFile() || !fs.existsSync(path.join(stage, 'resources', 'app', 'package.json'))) throw new Error('更新包缺少已展开的应用资源');
  return { entries: names.sort(), files, protectedPaths: protectedDirs };
}
function writeJSON(file, value) {
  const staging = `${file}.new`;
  fs.writeFileSync(staging, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(staging, file);
}
async function waitForHelper(transaction, child, timeout = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const status = JSON.parse(fs.readFileSync(path.join(transaction, 'status.json'), 'utf8').replace(/^\uFEFF/, ''));
      if (status.phase === 'waiting-for-exit') return;
      if (['failed', 'rolled-back', 'recovery-required'].includes(status.phase)) throw new Error(status.error || '更新助手启动失败');
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (child.exitCode !== null) throw new Error('更新助手提前退出');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('更新助手启动超时');
}

function restartEnvironment(base, source = process.env, paths) {
  const environment = { ...base };
  // portable.js exports all resolved paths; preserving only LFB_DATA would move
  // the browser/download roots on restart when it was originally the default.
  for (const key of ['LFB_DATA', 'LFB_BROWSER_DIR', 'LFB_DOWNLOADS_DIR', 'LFB_TEMP_DIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'COMPUTERNAME']) {
    if (source[key]) environment[key] = source[key];
  }
  if (paths) {
    for (const [variable, key] of [['LFB_DATA', 'dataDir'], ['LFB_BROWSER_DIR', 'browserDir'], ['LFB_DOWNLOADS_DIR', 'downloadsDir'], ['LFB_TEMP_DIR', 'tempDir'], ['TEMP', 'tempDir'], ['TMP', 'tempDir']]) {
      if (paths[key]) environment[variable] = path.resolve(paths[key]);
    }
  }
  return environment;
}

async function installWindows(info, options) {
  const { paths, beforeQuit, onProgress } = options;
  if (!paths?.baseDir || !paths?.updatesDir || !paths?.dataDir) throw new Error('Windows 更新缺少便携目录配置');
  const { extractZip, executableVersion, systemExecutable, systemEnvironment } = require('../src/platform');
  const root = path.resolve(paths.baseDir);
  if (path.dirname(process.execPath).toLowerCase() !== root.toLowerCase() && !options.app) throw new Error('更新目录与当前程序位置不一致');
  protectedPaths(paths); noLinks(root); noLinks(paths.updatesDir);
  if (!inside(paths.dataDir, paths.updatesDir)) throw new Error('更新暂存目录必须位于数据目录内');
  if (path.parse(root).root.toLowerCase() !== path.parse(path.resolve(paths.updatesDir)).root.toLowerCase()) throw new Error('更新备份与程序必须位于同一磁盘；当前自定义数据目录需要手动升级');
  fs.mkdirSync(paths.updatesDir, { recursive: true });
  const pending = path.join(paths.updatesDir, 'pending.json');
  if (fs.existsSync(pending)) throw new Error('已有未确认的更新，请先重启或检查更新恢复记录');
  const transactionId = crypto.randomUUID(), transaction = path.join(paths.updatesDir, transactionId);
  fs.mkdirSync(transaction);
  let handedOff = false, child;
  try {
    const archive = path.join(transaction, info.assetName);
    const checksum = checksumFor(await get(info.checksumUrl, null, { ...options, maxBytes: 1024 * 1024 }), info.assetName);
    await get(info.downloadUrl, archive, options);
    onProgress?.({ phase: 'verify' });
    await verifyChecksum(archive, checksum);
    const stage = path.join(transaction, 'stage');
    await extractZip(archive, stage);
    const listing = validatePackage(stage, paths), version = await executableVersion(path.join(stage, 'CIKE.exe'));
    if (version !== `${info.latest}.0`) throw new Error(`更新程序版本不匹配: ${version}`);
    if (JSON.parse(fs.readFileSync(path.join(stage, 'resources', 'app', 'package.json'), 'utf8')).version !== info.latest) throw new Error('更新应用版本与发布版本不一致');
    const entries = [...new Set([...fs.readdirSync(root).filter(programEntry), ...listing.entries])].sort();
    for (const name of entries) {
      const target = path.join(root, name);
      noLinks(target);
      if (listing.protectedPaths.some(dir => inside(target, dir, true) || inside(dir, target, true))) throw new Error('程序资源与自定义数据目录重叠，请手动升级');
    }
    const required = listing.files.reduce((sum, file) => sum + file.size, 0), disk = fs.statfsSync(root);
    if (disk.bavail * disk.bsize < required + 128 * 1024 * 1024) throw new Error('安装磁盘可用空间不足');
    const probe = path.join(root, `.cike-update-${transactionId}.tmp`);
    fs.writeFileSync(probe, 'write-check', { flag: 'wx' }); fs.unlinkSync(probe);
    const manifest = {
      schema: 1, transactionId, version: info.latest, parentPid: process.pid, root, transaction, stage,
      backup: path.join(transaction, 'backup'), entries, files: listing.files, protectedPaths: listing.protectedPaths,
      confirmationToken: crypto.randomBytes(32).toString('hex'),
    };
    writeJSON(path.join(transaction, 'manifest.json'), manifest);
    fs.copyFileSync(path.join(__dirname, 'windows-update.ps1'), path.join(transaction, 'windows-update.ps1'));
    const log = fs.openSync(path.join(transaction, 'helper.log'), 'a');
    try {
      const environment = restartEnvironment(systemEnvironment(), process.env, paths);
      child = spawn(systemExecutable('powershell'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(transaction, 'windows-update.ps1'), '-Manifest', path.join(transaction, 'manifest.json')], {
        cwd: transaction, env: environment, detached: true, windowsHide: true, stdio: ['ignore', log, log],
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      await waitForHelper(transaction, child);
    } finally { fs.closeSync(log); }
    // The helper has no authority to replace files until shutdown succeeds and this token is written.
    await beforeQuit?.();
    writeJSON(pending, { transactionId, version: info.latest, root, confirmationToken: manifest.confirmationToken });
    fs.writeFileSync(path.join(transaction, 'apply.ready'), transactionId, { flag: 'wx' });
    child.unref(); handedOff = true;
    onProgress?.({ phase: 'restart' });
    return { ...info, handoff: true, transactionId };
  } catch (error) {
    fs.writeFileSync(path.join(transaction, 'cancel'), 'cancel');
    writeJSON(path.join(transaction, 'preparation-error.json'), { error: error.message, time: new Date().toISOString() });
    throw error;
  } finally { if (!handedOff) child?.unref(); }
}

function exec(executable, args) {
  return new Promise((resolve, reject) => execFile(executable, args, { windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
function shellQuote(value) { return `'${value.replace(/'/g, `'\\''`)}'`; }
async function installMac(info, options) {
  const app = options.app || electronApp();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-update-'));
  const dmg = path.join(dir, info.assetName), mount = path.join(dir, 'mount');
  let mounted = false;
  try {
    const expected = checksumFor(await get(info.checksumUrl, null, options), info.assetName);
    await get(info.downloadUrl, dmg, options); await verifyChecksum(dmg, expected);
    fs.mkdirSync(mount);
    await exec('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]); mounted = true;
    const source = path.join(mount, 'CIKE.app');
    if (!fs.existsSync(source)) throw new Error('更新镜像中缺少 CIKE');
    const target = '/Applications/CIKE.app', staging = `/Applications/CIKE.app.update-${crypto.randomUUID()}`, backup = `/Applications/CIKE.app.backup-${crypto.randomUUID()}`;
    await options.beforeQuit?.();
    const command = `/bin/cp -R ${shellQuote(source)} ${shellQuote(staging)} && /bin/mv ${shellQuote(target)} ${shellQuote(backup)} && { /bin/mv ${shellQuote(staging)} ${shellQuote(target)} || { /bin/mv ${shellQuote(backup)} ${shellQuote(target)}; exit 1; }; }`;
    await exec('/usr/bin/osascript', ['-e', `do shell script ${JSON.stringify(command)} with administrator privileges`]);
    app.relaunch({ execPath: path.join(target, 'Contents/MacOS/CIKE') });
    return { ...info, handoff: true };
  } finally {
    if (mounted) await exec('/usr/bin/hdiutil', ['detach', mount]).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
async function installUpdate(options = {}) {
  if (installing) throw new Error('更新已在进行中');
  installing = true;
  try {
    const info = await checkUpdate(options);
    if (!info.available) return info;
    if (!info.supportsInstall) throw new Error('当前平台或发布版本没有可自动安装的更新包');
    return (options.platform || process.platform) === 'win32' ? await installWindows(info, options) : await installMac(info, options);
  } finally { installing = false; }
}

// Call after backend and window initialization. Only the helper deletes its backup.
async function confirmUpdateStartup(paths, options = {}) {
  if (!paths?.updatesDir || (options.platform || process.platform) !== 'win32') return null;
  const pendingFile = path.join(paths.updatesDir, 'pending.json');
  if (!fs.existsSync(pendingFile)) return null;
  noLinks(paths.updatesDir);
  const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8').replace(/^\uFEFF/, ''));
  if (!/^[a-f0-9-]{36}$/.test(pending.transactionId) || pending.root.toLowerCase() !== path.resolve(paths.baseDir).toLowerCase()) throw new Error('更新恢复记录目录无效');
  const transaction = path.join(paths.updatesDir, pending.transactionId);
  noLinks(transaction);
  const status = JSON.parse(fs.readFileSync(path.join(transaction, 'status.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (status.phase === 'awaiting-confirmation') {
    const app = options.app || electronApp();
    if (app.getVersion() !== pending.version || process.env.CIKE_UPDATE_TOKEN !== pending.confirmationToken) throw new Error('更新启动版本或确认令牌不匹配');
    writeJSON(path.join(transaction, 'confirmed.json'), { transactionId: pending.transactionId, token: pending.confirmationToken, pid: process.pid, version: app.getVersion() });
    return { confirmed: true, version: pending.version };
  }
  if (['confirmed', 'completed'].includes(status.phase)) {
    const confirmed = JSON.parse(fs.readFileSync(path.join(transaction, 'confirmed.json'), 'utf8').replace(/^\uFEFF/, ''));
    const app = options.app || electronApp();
    if (confirmed.transactionId !== pending.transactionId || confirmed.token !== pending.confirmationToken || confirmed.version !== pending.version || app.getVersion() !== pending.version) throw new Error('更新完成记录验证失败');
    fs.unlinkSync(pendingFile);
    return { confirmed: true, version: pending.version, recoveryDirectory: transaction };
  }
  if (['rolled-back', 'failed', 'recovery-required'].includes(status.phase)) {
    // A successful rollback can be retried. Incomplete recovery keeps the lock.
    if (status.phase !== 'recovery-required') fs.unlinkSync(pendingFile);
    return { confirmed: false, error: status.error, phase: status.phase, recoveryDirectory: transaction };
  }
  return { confirmed: false, phase: status.phase };
}

module.exports = { checkUpdate, installUpdate, confirmUpdateStartup, _test: { get, compare, selectRelease, validateURL, checksumFor, verifyChecksum, validatePackage, protectedPaths, inside, programEntry, restartEnvironment } };
