import assert from 'node:assert/strict';
import path from 'node:path';
import { detectPackageManager, parseViewVersions, readSelfPackage } from '../src/cli/update.js';

const self = readSelfPackage();
assert.match(self.version, /^\d+\.\d+\.\d+/, 'reads the package version');
assert.equal(self.name, '@saltroping/retriever');

assert.equal(
  detectPackageManager(path.join('/usr/local/lib/node_modules/@saltroping/retriever/dist/index.js')),
  'npm',
  'plain node_modules layout is npm',
);
assert.equal(
  detectPackageManager(path.join('/Users/me/.local/share/pnpm/global/5/.pnpm/@saltroping+retriever@0.1.0/node_modules/@saltroping/retriever/dist/index.js')),
  'pnpm',
  '.pnpm virtual store is pnpm',
);
assert.equal(detectPackageManager(path.join('/home/me/dev/retriever/dist/index.js')), undefined, 'a source checkout is not a global install');

assert.equal(parseViewVersions('"0.1.0"\n'), '0.1.0', 'single resolved version');
assert.equal(parseViewVersions('["0.1.0","0.1.1","0.1.2"]'), '0.1.2', 'picks the highest of several matches');
assert.equal(parseViewVersions('["0.1.0", 3, "not-a-version", "0.2.0-rc.1"]'), '0.2.0-rc.1', 'keeps valid semver strings only');
assert.equal(parseViewVersions('npm blew up'), undefined, 'non-JSON output resolves to nothing');
assert.equal(parseViewVersions(''), undefined, 'empty output resolves to nothing');

console.log('update ok');
