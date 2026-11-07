'use strict';
// CI exercises the application's downloader; playwright install would bypass that code.
const fs = require('fs');
const path = require('path');
const { downloadChromium, chromiumStatus } = require('../electron/chromium');
(async () => {
  const directory = path.resolve('.ci-runtime', 'kernel-data');
  const executable = await downloadChromium(directory);
  const status = await chromiumStatus(directory);
  if (!status.installed || status.version !== status.targetVersion) throw new Error('Application kernel installation did not verify.');
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `LFB_CHROMIUM_EXECUTABLE=${executable}\n`);
  console.log(`Verified application-installed Chromium ${status.version}: ${executable}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
