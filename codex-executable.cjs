const fs = require('node:fs');
const path = require('node:path');

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function latestCandidate(root) {
  if (!root || !fs.existsSync(root)) return null;
  let entries;
  try {
    entries = fs.readdirSync(root, {withFileTypes: true});
  } catch {
    return null;
  }
  const candidates = entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(root, entry.name, 'codex.exe'))
    .filter(isFile)
    .map(file => ({file, mtimeMs: fs.statSync(file).mtimeMs}));
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  return candidates[0]?.file || null;
}

function resolveCodexExecutable(configuredExe, installRoot) {
  if (isFile(configuredExe)) return configuredExe;
  const root = installRoot || path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
    'OpenAI',
    'Codex',
    'bin'
  );
  const resolved = latestCandidate(root);
  if (resolved) return resolved;
  throw new Error('找不到可用的 Codex 可执行文件：配置路径已失效，且未在 Codex 安装目录发现 codex.exe');
}

module.exports = {resolveCodexExecutable};
