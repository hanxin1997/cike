'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 packaging must run on a Windows x64 host.');
// Calling Node avoids .cmd interpreting regex pipes, and explicit ASAR mode matches verification.
const cli = path.resolve('node_modules/electron-packager/bin/electron-packager.mjs');
const result = spawnSync(process.execPath, [cli, '.', 'CIKE', '--platform=win32', '--arch=x64', '--out=dist', '--overwrite', '--prune', '--no-asar',
  '--ignore=^/(test|tests|scripts|\\.ci-runtime|\\.workflow[^/]*|browsers|Downloads|data|dist|\\.git|\\.github)(/|$)'], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
