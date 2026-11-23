import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dependencyRoot = resolve(root, 'node_modules/@lifo-sh/core');
const patchPath = resolve(root, 'patches/@lifo-sh__core@0.10.18.patch');
const checkOnly = process.argv.includes('--check');
const checksums = {
  'dist/index-DjPOCNff.js': {
    original: '27fc0988c10b973df559da8e6fe7a95ab6ffa2483a7065ee5a2fb34fcdb167ff',
    patched: '37f5aee922631be8d0292c886f33bc2b057662360bc409de37b7dccec2254025',
  },
  'dist/printf-Cc2o7KZx.js': {
    original: '0d88faa858325187c9b89e6f0b0d5381f9a82b46cb455677e8bef8d81a0fbd9a',
    patched: '72c42df81c09ab0ad0b3a9c287af6d48b785155793c43b6c1c63e12377053e68',
  },
};

const fail = (message) => {
  throw new Error(`Lifo compatibility patch: ${message}`);
};

function parsePatch(source) {
  const files = [];
  let file;
  let hunk;

  for (const line of source.split('\n')) {
    const diff = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (diff) {
      file = { oldPath: diff[1], newPath: diff[2], hunks: [] };
      files.push(file);
      hunk = undefined;
      continue;
    }

    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      if (!file) fail('encountered a hunk before a file header');
      hunk = { oldStart: Number(header[1]), newStart: Number(header[2]), old: [], next: [] };
      file.hunks.push(hunk);
      continue;
    }

    if (!hunk || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ')) {
      continue;
    }
    if (line.startsWith('\\ No newline at end of file')) continue;
    if (line.startsWith(' ') || line.startsWith('-')) hunk.old.push(line.slice(1));
    if (line.startsWith(' ') || line.startsWith('+')) hunk.next.push(line.slice(1));
  }

  if (files.length === 0 || files.some(entry => entry.hunks.length === 0)) {
    fail('patch file is empty or malformed');
  }
  return files;
}

const matchesAt = (lines, start, expected) =>
  expected.every((line, index) => lines[start + index] === line);
const digest = source => createHash('sha256').update(source).digest('hex');

async function applyFilePatch(entry) {
  if (entry.oldPath !== entry.newPath || entry.oldPath.includes('..')) {
    fail(`unsafe patch target ${entry.newPath}`);
  }
  const target = resolve(dependencyRoot, entry.newPath);
  if (!target.startsWith(`${dependencyRoot}/`)) fail(`unsafe patch target ${entry.newPath}`);

  const source = await readFile(target, 'utf8');
  const expected = checksums[entry.newPath];
  if (!expected) fail(`patch target ${entry.newPath} has no locked checksums`);
  const sourceDigest = digest(source);
  if (sourceDigest === expected.patched) return false;
  if (sourceDigest !== expected.original) {
    fail(`${entry.newPath} matches neither the locked upstream file nor the patched file`);
  }
  if (checkOnly) fail(`${entry.newPath} is not patched`);

  const trailingNewline = source.endsWith('\n');
  const lines = source.split('\n');
  if (trailingNewline) lines.pop();

  const original = entry.hunks.every(item => matchesAt(lines, item.oldStart - 1, item.old));
  const patched = entry.hunks.every(item => matchesAt(lines, item.newStart - 1, item.next));

  if (patched || !original) fail(`${entry.newPath} does not match its patch hunks`);

  for (const item of [...entry.hunks].reverse()) {
    lines.splice(item.oldStart - 1, item.old.length, ...item.next);
  }
  const result = `${lines.join('\n')}${trailingNewline ? '\n' : ''}`;
  if (digest(result) !== expected.patched) fail(`${entry.newPath} produced an unexpected result`);
  await writeFile(target, result);
  return true;
}

const manifest = JSON.parse(await readFile(resolve(dependencyRoot, 'package.json'), 'utf8'));
if (manifest.version !== '0.10.18') {
  fail(`expected @lifo-sh/core 0.10.18, found ${manifest.version ?? 'unknown'}`);
}

const entries = parsePatch(await readFile(patchPath, 'utf8'));
const changed = [];
for (const entry of entries) {
  if (await applyFilePatch(entry)) changed.push(entry.newPath);
}

if (!checkOnly) {
  console.log(changed.length > 0
    ? `Applied Lifo compatibility patch to ${changed.length} file(s).`
    : 'Lifo compatibility patch already applied.');
}
