'use strict';
const fs = require('fs');
const path = require('path');

// Use explicit filesystem operations so the fixture never silently becomes an
// empty directory on a hosted Node version. Follow no links into external data.
function copyBundle(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) count += copyBundle(from, to);
    else if (entry.isFile()) { fs.copyFileSync(from, to); count++; }
    else throw new Error(`Unexpected link or special file in packaged fixture: ${from}`);
  }
  return count;
}
module.exports = { copyBundle };
