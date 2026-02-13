import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const IGNORE_DIRS = new Set(['node_modules', '.git', 'public/css']);
const EXTS = new Set(['.js', '.mjs']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(ROOT, full);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!IGNORE_DIRS.has(rel) && !IGNORE_DIRS.has(entry)) walk(full, out);
      continue;
    }
    const ext = path.extname(full);
    if (EXTS.has(ext)) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const failed = [];

for (const file of files) {
  try {
    execFileSync('node', ['--check', file], { stdio: 'pipe' });
  } catch {
    failed.push(path.relative(ROOT, file));
  }
}

if (failed.length) {
  console.error('Lint failed on:');
  failed.forEach((f) => console.error(`- ${f}`));
  process.exit(1);
}

console.log(`Lint OK (${files.length} files checked)`);
