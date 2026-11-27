const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {resolveCodexExecutable} = require('./codex-executable.cjs');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-executable-'));
}

function writeExecutable(file) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, 'test', 'utf8');
}

const configured = tempRoot();
const configuredExe = path.join(configured, 'configured.exe');
writeExecutable(configuredExe);
assert.equal(resolveCodexExecutable(configuredExe, configured), configuredExe);

const versions = tempRoot();
const oldExe = path.join(versions, 'old-hash', 'codex.exe');
const newExe = path.join(versions, 'new-hash', 'codex.exe');
writeExecutable(oldExe);
writeExecutable(newExe);
const oldTime = new Date('2026-01-01T00:00:00Z');
const newTime = new Date('2026-02-01T00:00:00Z');
fs.utimesSync(oldExe, oldTime, oldTime);
fs.utimesSync(newExe, newTime, newTime);
assert.equal(resolveCodexExecutable(path.join(versions, 'missing', 'codex.exe'), versions), newExe);

assert.throws(
  () => resolveCodexExecutable(path.join(versions, 'missing', 'codex.exe'), tempRoot()),
  /找不到可用的 Codex 可执行文件/
);

console.log('codex-executable tests passed');
