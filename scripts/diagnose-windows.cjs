'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { systemExecutable, systemEnvironment } = require('../src/platform');
const exe = systemExecutable('powershell');
const commands = [
  'Write-Output "powershell started"; $PSVersionTable.PSVersion.ToString()',
  'Get-Command Get-Acl,Set-Acl | Select-Object Name,Source | ConvertTo-Json -Compress',
];
for (const [name, env] of [['system', systemEnvironment()], ['inherited', process.env]]) {
  for (const command of commands) {
    const start = Date.now();
    const result = cp.spawnSync(exe, ['-NoLogo','-NoProfile','-NonInteractive','-Command',command], {env, encoding:'utf8', timeout:45000, windowsHide:true});
    console.log(JSON.stringify({name,command,ms:Date.now()-start,status:result.status,error:result.error?.message,stdout:result.stdout,stderr:result.stderr}));
  }
}
const folder = path.resolve('.ci-runtime','acl-diagnostic');
fs.mkdirSync(folder,{recursive:true});
for (const [name,env] of [['system',systemEnvironment()],['inherited',process.env]]) {
 const start=Date.now(); const result=cp.spawnSync(exe,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('src/windows-permissions.ps1'),'-TargetPath',folder,'-Kind','Directory'],{env,encoding:'utf8',timeout:60000,windowsHide:true});
 console.log(JSON.stringify({name,operation:'permissions',ms:Date.now()-start,status:result.status,error:result.error?.message,stdout:result.stdout,stderr:result.stderr}));
}
