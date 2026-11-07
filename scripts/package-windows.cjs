'use strict';
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 packaging must run on a Windows x64 host.');
// Calling Node avoids .cmd interpreting regex pipes, and explicit ASAR mode matches verification.
const cli = path.resolve('node_modules/electron-packager/bin/electron-packager.mjs');
const version = require('../package.json').version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable three-part version.');
const result = spawnSync(process.execPath, [cli, '.', 'CIKE', '--platform=win32', '--arch=x64', '--out=dist', '--overwrite', '--prune', '--no-asar', `--app-version=${version}`, `--build-version=${version}.0`,
  '--ignore=^/(test|tests|scripts|artifacts|\\.ci-runtime|\\.workflow[^/]*|browsers|Downloads|data|dist|\\.git|\\.github)(/|$)'], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (result.status === 0) {
  const bundle = path.resolve('dist/CIKE-win32-x64');
  const entries = fs.readdirSync(bundle);
  console.log('Packaged root entries:', JSON.stringify(entries));
  if (!fs.existsSync(path.join(bundle, 'CIKE.exe'))) throw new Error('Packager succeeded but CIKE.exe is missing from its output.');
}
