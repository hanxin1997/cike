'use strict';
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);

function systemRoot(env) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.WINDIR || 'C:\\Windows';
  if (!/^[A-Za-z]:\\/.test(root) || root.includes('..')) throw new Error('Windows 系统目录无效');
  return path.win32.resolve(root);
}

function systemExecutable(name, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const system = path.win32.join(systemRoot(env), 'System32');
    if (name === 'powershell') return path.win32.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (name === 'curl') return path.win32.join(system, 'curl.exe');
    throw new Error(`Unsupported system executable: ${name}`);
  }
  if (name === 'curl' || name === 'unzip') return `/usr/bin/${name}`;
  throw new Error(`Unsupported system executable: ${name}`);
}

function systemEnvironment({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return { PATH: '/usr/bin:/bin', LANG: 'C', ...(env.HOME ? { HOME: env.HOME } : {}) };
  const root = systemRoot(env);
  const system = path.win32.join(root, 'System32');
  const result = { SystemRoot: root, WINDIR: root, ComSpec: path.win32.join(system, 'cmd.exe'), PATH: system,
    // Without an explicit module path, Windows PowerShell synthesizes user and
    // machine module search paths, including unresolved %ProgramFiles% when a
    // service launcher omitted it. Start with inbox modules; PowerShell 5 can
    // add its standard machine module directory, but not user search roots.
    PSModulePath: path.win32.join(system, 'WindowsPowerShell', 'v1.0', 'Modules') };
  // PowerShell/.NET use these known Windows folders during first-use setup.
  // Preserve the service account's real directories rather than inventing a
  // profile, while excluding proxy variables, curl config and process hooks.
  for (const key of ['TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
    'ProgramData', 'ALLUSERSPROFILE', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles', 'CommonProgramFiles(x86)']) {
    if (env[key]) result[key] = env[key];
  }
  return result;
}

async function windowsOperation(operation, args, options) {
  return exec(systemExecutable('powershell', options), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'windows-runtime.ps1'), '-Operation', operation, ...args], {
    env: systemEnvironment(options), windowsHide: true, timeout: 600000, maxBuffer: 1024 * 1024,
  });
}

async function extractZip(archive, destination, options = {}) {
  if ((options.platform || process.platform) === 'win32') {
    await windowsOperation('ExtractZip', ['-Archive', path.resolve(archive), '-Destination', path.resolve(destination)], options);
  } else {
    await exec(systemExecutable('unzip', options), ['-q', archive, '-d', destination], { timeout: 600000, maxBuffer: 1024 * 1024 });
  }
}

async function executableVersion(executable, options = {}) {
  const { stdout } = (options.platform || process.platform) === 'win32'
    ? await windowsOperation('Version', ['-Executable', path.resolve(executable)], options)
    : await exec(executable, ['--version'], { timeout: 10000, maxBuffer: 65536, windowsHide: true });
  const version = stdout.match(/\b\d+\.\d+\.\d+\.\d+\b/)?.[0];
  if (!version) throw new Error('无法读取可执行文件版本');
  return version;
}

module.exports = { systemExecutable, systemEnvironment, extractZip, executableVersion };
