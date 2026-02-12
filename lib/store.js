import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const DEFAULT_DATA_DIR = process.env.VERCEL
  ? '/tmp/gtd_neto_data'
  : new URL('../data', import.meta.url).pathname;

const DATA_DIR = process.env.DATA_DIR || DEFAULT_DATA_DIR;
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'db.json');

const USE_SUPABASE = String(process.env.USE_SUPABASE || '').toLowerCase() === 'true';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_OWNER = process.env.SUPABASE_OWNER || 'default';

const supabase = (USE_SUPABASE && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

function nowIso() {
  return new Date().toISOString();
}

async function ensureDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

export async function loadDb() {
  if (supabase) {
    const { data, error } = await supabase
      .from('gtd_items')
      .select('payload')
      .eq('owner', SUPABASE_OWNER)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    return {
      version: 1,
      items: (data || []).map(r => r.payload).filter(Boolean),
    };
  }

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
  if (supabase) {
    const items = Array.isArray(db?.items) ? db.items : [];

    const { error: delErr } = await supabase
      .from('gtd_items')
      .delete()
      .eq('owner', SUPABASE_OWNER);
    if (delErr) throw delErr;

    if (items.length) {
      const rows = items.map(item => ({
        id: item.id,
        owner: SUPABASE_OWNER,
        payload: item,
        updated_at: new Date(item.updatedAt || item.createdAt || nowIso()).toISOString(),
      }));

      const { error: insErr } = await supabase
        .from('gtd_items')
        .insert(rows);
      if (insErr) throw insErr;
    }
    return;
  }

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
