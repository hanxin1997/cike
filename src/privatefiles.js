'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

// Windows chmod only changes the read-only attribute. Cache verified ACLs by
// file identity and metadata so routine JSON saves do not spawn PowerShell.
const protectedPaths = new Map();
const signature = stat => [stat.dev, stat.ino, stat.birthtimeMs, stat.ctimeMs].join(':');
const cacheKey = target => path.resolve(target).toLowerCase();
function remember(target) {
  if (process.platform === 'win32') protectedPaths.set(cacheKey(target), signature(fs.lstatSync(target)));
}
function isProtected(target) {
  return protectedPaths.get(cacheKey(target)) === signature(fs.lstatSync(target));
}
function assertNoLinks(target) {
  // Inspect existing ancestors without modifying them. A junction in a parent
  // must not redirect a private write or an ACL change outside its data root.
  let current = path.resolve(target);
  while (true) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('数据路径不能包含符号链接或重解析点');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // macOS intentionally links system ancestors such as /var. Preserve the
    // POSIX final-target check; Windows additionally rejects parent junctions.
    if (process.platform !== 'win32') break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function protect(target, directory) {
  assertNoLinks(target);
  const stat = fs.lstatSync(target);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`不是普通${directory ? '目录' : '数据文件'}：${path.basename(target)}`);
  if (process.platform !== 'win32') return fs.chmodSync(target, directory ? 0o700 : 0o600);
  if (isProtected(target)) return;
  try {
    const { systemExecutable, systemEnvironment } = require('./platform');
    cp.execFileSync(systemExecutable('powershell'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'windows-permissions.ps1'), '-TargetPath', path.resolve(target),
      '-Kind', directory ? 'Directory' : 'File',
    ], { env: systemEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000 });
    remember(target);
  } catch (error) {
    protectedPaths.delete(cacheKey(target));
    throw new Error(`无法设置私有 Windows 权限：${path.basename(target)}；${String(error.stderr || error.message).trim()}`);
  }
}

function privateDirectory(directory) {
  if (process.platform === 'win32' && path.resolve(directory) === path.parse(path.resolve(directory)).root) {
    throw new Error('不能将磁盘根目录作为私有数据目录，请选择专用子目录');
  }
  assertNoLinks(directory);
  const parent = path.dirname(path.resolve(directory));
  const trustedParent = process.platform === 'win32' && fs.existsSync(parent) && isProtected(parent);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  protect(directory, true);
  // Creating a child can change the parent's metadata, but not its ACL.
  if (trustedParent) remember(parent);
}
function protectFile(file) { protect(file, false); }
function readJSON(file, fallback) {
  try {
    protectFile(file);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`无法读取 ${path.basename(file)}，请检查文件或恢复备份：${error.message}`);
  }
}
function writePrivate(file, contents) {
  privateDirectory(path.dirname(file));
  assertNoLinks(file);
  try { if (!fs.lstatSync(file).isFile()) throw new Error('数据文件必须是普通文件'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    // The new file inherits only trusted entries from the verified directory.
    // Creating it exclusively also prevents following a pre-existing link.
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    remember(file);
  } finally {
    fs.rmSync(temporary, { force: true });
    remember(path.dirname(file));
  }
}
function writeJSON(file, value) { writePrivate(file, JSON.stringify(value, null, 2)); }

// Electron supplies safeStorage on desktop. CLI never silently decrypts or
// downgrades an encrypted file; without that provider it uses OS-private files.
function credentials(provider) {
  return {
    protection: provider ? 'system-safe-storage' : 'private-file',
    encode(value) {
      if (!value) return '';
      if (typeof value !== 'string') throw new Error('密码格式无效');
      return provider ? { format: 'safe-storage-v1', data: provider.encrypt(value) } : value;
    },
    decode(value) {
      if (!value) return '';
      if (typeof value === 'string') return value;
      if (value.format !== 'safe-storage-v1' || typeof value.data !== 'string') throw new Error('凭据格式无效');
      if (!provider) throw new Error('此数据包含系统安全存储保护的凭据，请使用 CIKE 桌面版打开');
      return provider.decrypt(value.data);
    },
  };
}
module.exports = { privateDirectory, protectFile, readJSON, writePrivate, writeJSON, credentials };
