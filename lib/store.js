import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_DATA_DIR = process.env.VERCEL
  ? '/tmp/gtd_neto_data'
  : new URL('../data', import.meta.url).pathname;

const DATA_DIR = process.env.DATA_DIR || DEFAULT_DATA_DIR;
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'db.json');

function nowIso() {
  return new Date().toISOString();
}

async function ensureDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

export async function loadDb() {
  await ensureDir();
  try {
    const raw = await readFile(DB_PATH, 'utf8');
    const data = JSON.parse(raw);
    return {
      version: 1,
      items: [],
      ...data,
    };
  } catch {
    return {
      version: 1,
      items: [],
    };
  }
}

export async function saveDb(db) {
  await ensureDir();
  const tmp = `${DB_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2) + '\n', 'utf8');
  await writeFile(DB_PATH, await readFile(tmp), 'utf8');
}

export function newItem({ input }) {
  const id = cryptoRandomId();
  const t = nowIso();
  return {
    id,
    input,
    title: null,
    kind: null, // action|project|reference
    list: 'inbox', // inbox|next|projects|waiting|someday|calendar|reference
    context: null, // @casa, @pc...
    nextAction: null,
    notes: null,
    status: 'unprocessed', // unprocessed|processed|done
    createdAt: t,
    updatedAt: t,
  };
}

export function updateItem(item, patch) {
  return {
    ...item,
    ...patch,
    updatedAt: nowIso(),
  };
}

function cryptoRandomId() {
  // Node 22: global crypto is available.
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Buffer.from(bytes).toString('hex');
}
