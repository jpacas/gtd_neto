import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const IGNORE_DIRS = new Set(['node_modules', '.git', 'public/css']);
const EXTS = new Set(['.js', '.mjs', '.ejs', '.css', '.json', '.sql', '.md']);

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
const issues = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (text.includes('\t')) issues.push(`${path.relative(ROOT, file)}: contains tab characters`);
  if (/[ \t]+\n/.test(text)) issues.push(`${path.relative(ROOT, file)}: trailing whitespace found`);
}

if (issues.length) {
  console.error('Format check failed:');
  issues.forEach((i) => console.error(`- ${i}`));
  process.exit(1);
}

console.log(`Format check OK (${files.length} files checked)`);
