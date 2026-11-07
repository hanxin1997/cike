'use strict';
const cp = require('child_process');
const path = require('path');

function processCommands() {
  if (process.platform !== 'win32') {
    return cp.execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n').filter(Boolean);
  }
  // Query actual Windows process command lines without a shell or localized
  // table formatting. Encoding both ends explicitly preserves Chinese paths.
  const script = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); @((Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | Select-Object -ExpandProperty CommandLine)) | ConvertTo-Json -Compress';
  const { systemExecutable, systemEnvironment } = require('../../src/platform');
  const output = cp.execFileSync(systemExecutable('powershell'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], { env: systemEnvironment(), encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }).trim();
  if (!output) return [];
  const commands = JSON.parse(output.replace(/^\uFEFF/, ''));
  return Array.isArray(commands) ? commands : [commands];
}

function profileProcesses(profileDir, commands = processCommands()) {
  const normalize = value => process.platform === 'win32' ? value.replaceAll('/', '\\').toLowerCase() : value;
  const escaped = normalize(path.resolve(profileDir)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Chromium may quote the complete option or only its value. Match the full
  // directory boundary so one profile cannot be mistaken for its neighbour.
  const match = new RegExp(`(?:^|[\\s"])--user-data-dir="?${escaped}(?=[\\s"]|$)`);
  return commands.filter(command => match.test(normalize(command)));
}

async function waitForProfileExit(profileDir, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do {
    if (!profileProcesses(profileDir).length) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`Browser processes remain after closing profile: ${profileDir}`);
}

module.exports = { processCommands, profileProcesses, waitForProfileExit };
