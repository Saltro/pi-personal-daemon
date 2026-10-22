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
// PATH-callable copies for agent subprocesses and manual dist-on-PATH usage.
for (const helper of ['dist/retriever', 'dist/retr']) {
  fs.copyFileSync('dist/index.js', helper);
  fs.chmodSync(helper, 0o755);
}
