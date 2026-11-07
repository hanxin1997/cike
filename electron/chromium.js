'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { privateDirectory, writePrivate } = require('../src/privatefiles');
const { pathsForData } = require('../src/runtime-paths');
const { extractZip, executableVersion } = require('../src/platform');
const inProgress = new Map();
const MAX_DOWNLOAD = 1024 * 1024 * 1024;

function chromiumEntry() {
  const file = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'browsers.json');
  return JSON.parse(fs.readFileSync(file)).browsers.find(b => b.name === 'chromium');
}
function targetVersion(options) {
  const version = options.version || chromiumEntry().browserVersion;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error('内核目标版本无效');
  return version;
}
function cftPlatform(options = {}) {
  const platform = { 'darwin-arm64': 'mac-arm64', 'darwin-x64': 'mac-x64', 'linux-x64': 'linux64', 'win32-x64': 'win64' }[`${options.platform || process.platform}-${options.arch || process.arch}`];
  if (!platform) throw new Error('不支持此平台的 Chromium 下载');
  return platform;
}
function downloadUrl(options = {}) {
  const host = process.env.PLAYWRIGHT_DOWNLOAD_HOST || 'https://cdn.playwright.dev';
  const platform = cftPlatform(options);
  return `${host}/builds/cft/${targetVersion(options)}/${platform}/chrome-${platform}.zip`;
}
function browserRoot(dir) { return pathsForData(dir).browserDir; }
function executableMarker(dir) { return path.join(browserRoot(dir), 'chromium-executable.txt'); }
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function readInstalledExecutable(dir) {
  try {
    const root = path.resolve(browserRoot(dir));
    const marker = executableMarker(dir);
    if (!fs.lstatSync(marker).isFile() || fs.lstatSync(marker).isSymbolicLink() || fs.statSync(marker).size > 32768) return null;
    const stored = fs.readFileSync(marker, 'utf8').trim();
    if (!stored || stored.includes('\0') || /[\r\n]/.test(stored)) return null;
    // New markers are portable relative paths. Old absolute markers remain
    // valid only inside this same browser directory, never arbitrary programs.
    const executable = path.resolve(root, stored);
    if (!inside(root, executable) || !inside(fs.realpathSync(root), fs.realpathSync(executable))) return null;
    if (!fs.lstatSync(executable).isFile() || fs.lstatSync(executable).isSymbolicLink()) return null;
    return executable;
  } catch { return null; }
}
async function chromiumStatus(dir, options = {}) {
  const wanted = targetVersion(options);
  try {
    // Explicit developer/CLI overrides are opt-in at the call site. A marker
    // cannot authorize an external executable merely by containing its path.
    const executable = options.executable || readInstalledExecutable(dir);
    if (executable) {
      const version = await (options.readVersion || executableVersion)(executable, options);
      if (/^\d+\.\d+\.\d+\.\d+$/.test(version)) return { installed: true, executable, version, targetVersion: wanted, updateAvailable: version !== wanted };
    }
  } catch { /* A missing/corrupt executable is offered for repair. */ }
  return { installed: false, executable: null, version: null, targetVersion: wanted, updateAvailable: true };
}
function progress(callback, value) {
  // A window closing during installation must not invalidate a verified kernel.
  try { callback?.(value); } catch { /* renderer is no longer available */ }
}
async function downloadFile(url, destination, onProgress, options = {}, redirects = 0) {
  if (redirects > 5 || new URL(url).protocol !== 'https:') throw new Error('内核下载必须使用 HTTPS，且不能无限重定向');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('内核下载超时')), options.timeoutMs || 120000);
  let body;
  try {
    let status, location, length;
    if (options.fetch) {
      // The desktop transport follows the session's system proxy configuration.
      // Manual redirects let each destination retain the HTTPS requirement.
      const response = await options.fetch(url, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'CIKE' } });
      status = response.status;
      location = response.headers.get('location');
      length = response.headers.get('content-length');
      body = response.body ? (typeof response.body.getReader === 'function' ? Readable.fromWeb(response.body) : response.body) : null;
    } else {
      const response = await new Promise((resolve, reject) => {
        const request = https.get(url, { signal: controller.signal, headers: { 'User-Agent': 'CIKE' } }, resolve);
        request.once('error', reject);
      });
      status = response.statusCode;
      location = response.headers.location;
      length = response.headers['content-length'];
      body = response;
    }
    if ([301, 302, 303, 307, 308].includes(status) && location) {
      body?.destroy();
      clearTimeout(timer);
      return await downloadFile(new URL(location, url).href, destination, onProgress, options, redirects + 1);
    }
    if (status !== 200) throw new Error(`内核下载失败：HTTP ${status}`);
    if (!body) throw new Error('内核下载响应为空');
    const total = Number(length) || 0;
    const maximum = options.maxBytes || MAX_DOWNLOAD;
    if (!Number.isSafeInteger(total) || total < 0 || total > maximum) throw new Error('内核安装包异常过大');
    let done = 0;
    const counter = new Transform({ transform(chunk, encoding, callback) {
      done += chunk.length;
      if (done > maximum) return callback(new Error('内核安装包异常过大'));
      progress(onProgress, { done, total, pct: total ? Math.min(99, Math.round(done / total * 100)) : 0 });
      callback(null, chunk);
    } });
    await pipeline(body, counter, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
    if (!done || (total && done !== total)) throw new Error('内核安装包下载不完整');
  } finally {
    clearTimeout(timer);
    body?.destroy();
  }
}
function findExecutable(root, platform) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('内核安装包不能包含符号链接');
    if (entry.isDirectory()) {
      if (platform === 'darwin' && entry.name.endsWith('.app')) {
        const macos = path.join(full, 'Contents', 'MacOS');
        const binary = fs.readdirSync(macos).find(name => !name.startsWith('.'));
        if (binary) return path.join(macos, binary);
      }
      const found = findExecutable(full, platform);
      if (found) return found;
    } else if (entry.isFile() && ((platform === 'linux' && entry.name === 'chrome') || (platform === 'win32' && entry.name === 'chrome.exe'))) return full;
  }
  return null;
}
async function install(dir, onProgress, options) {
  const wanted = targetVersion(options);
  const status = await chromiumStatus(dir, { ...options, version: wanted });
  if (status.installed && !status.updateAvailable) return status.executable;
  privateDirectory(browserRoot(dir));
  // Both the archive and extraction remain beside the final browser. An
  // interrupted installation can never consume the system TEMP drive.
  const temporary = fs.mkdtempSync(path.join(browserRoot(dir), '.install-'));
  let destination, published = false;
  try {
    const zip = path.join(temporary, 'chromium.zip');
    const staging = path.join(temporary, 'extracted');
    fs.mkdirSync(staging);
    await downloadFile(downloadUrl({ ...options, version: wanted }), zip, onProgress, options);
    await (options.extract || extractZip)(zip, staging, options);
    const executable = findExecutable(staging, options.platform || process.platform);
    if (!executable) throw new Error('安装包中没有 Chromium');
    if (await (options.readVersion || executableVersion)(executable, options) !== wanted) throw new Error('下载的内核版本不匹配');
    destination = path.join(browserRoot(dir), `${wanted}-${path.basename(temporary).slice(9)}`);
    const relative = path.relative(staging, executable);
    fs.renameSync(staging, destination);
    const final = path.join(destination, relative);
    // writePrivate atomically replaces the marker after complete verification.
    // Earlier kernels remain intact until a later explicit maintenance action.
    writePrivate(executableMarker(dir), path.relative(browserRoot(dir), final).split(path.sep).join('/') + '\n');
    published = true;
    progress(onProgress, { done: 1, total: 1, pct: 100 });
    return final;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    if (destination && !published) fs.rmSync(destination, { recursive: true, force: true });
  }
}
async function downloadChromium(dir, onProgress, options = {}) {
  const key = path.resolve(browserRoot(dir));
  if (inProgress.has(key)) return inProgress.get(key);
  const promise = install(dir, onProgress, options);
  inProgress.set(key, promise);
  try { return await promise; } finally { inProgress.delete(key); }
}

module.exports = { chromiumStatus, downloadChromium, downloadUrl, executableMarker, browserRoot, readInstalledExecutable, downloadFile };
