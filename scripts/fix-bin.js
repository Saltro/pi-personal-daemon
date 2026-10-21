import fs from 'node:fs';

const shebang = '#!/usr/bin/env node\n';
for (const file of ['dist/index.js', 'dist/session-watcher.js']) {
  let content = fs.readFileSync(file, 'utf8');
  if (!content.startsWith(shebang)) {
    content = shebang + content;
    fs.writeFileSync(file, content);
  }
  fs.chmodSync(file, 0o755);
}
fs.copyFileSync('dist/index.js', 'dist/pi-personal-daemon');
fs.chmodSync('dist/pi-personal-daemon', 0o755);
