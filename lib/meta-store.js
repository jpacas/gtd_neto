import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const DEFAULT_DATA_DIR = process.env.VERCEL
  ? '/tmp/gtd_neto_data'
  : new URL('../data', import.meta.url).pathname;

const DATA_DIR = process.env.DATA_DIR || DEFAULT_DATA_DIR;
const META_PATH = process.env.META_PATH || path.join(DATA_DIR, 'meta.json');

const USE_SUPABASE = String(process.env.USE_SUPABASE || '').toLowerCase() === 'true';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_OWNER = process.env.SUPABASE_OWNER || 'default';

// Reuse resolveOwner logic (matching lib/store.js)
function resolveOwner(options) {
  if (typeof options === 'string' && options.trim()) return options.trim();
  if (options && typeof options === 'object' && typeof options.owner === 'string' && options.owner.trim()) {
    return options.owner.trim();
  }
  return SUPABASE_OWNER;
}

const supabase = (USE_SUPABASE && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

async function ensureDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

// Load all meta records for a given kind and owner
export async function loadMetaByKind(kind, options = {}) {
  const owner = resolveOwner(options);
  const targetKind = String(kind || '').trim();
  if (!targetKind) return [];

  if (supabase) {
    const { data, error } = await supabase
      .from('gtd_meta')
      .select('id, payload')
      .eq('owner', owner)
      .eq('kind', targetKind)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return (data || []).map(r => ({ id: r.id, ...r.payload })).filter(Boolean);
  }

  const db = await loadMetaDb();
  return (db.records || []).filter(r => r.owner === owner && r.kind === targetKind).map(r => r.payload);
}

// Load a single meta record by id
export async function loadMetaById(id, options = {}) {
  const owner = resolveOwner(options);
  const itemId = String(id || '').trim();
  if (!itemId) return null;

  if (supabase) {
    const { data, error } = await supabase
      .from('gtd_meta')
      .select('id, payload')
      .eq('owner', owner)
      .eq('id', itemId)
      .maybeSingle();

    if (error) throw error;
    if (!data?.payload) return null;
    return { id: data.id, ...data.payload };
  }

  const db = await loadMetaDb();
  const record = (db.records || []).find(r => r.owner === owner && r.payload?.id === itemId);
  return record ? record.payload : null;
}

// Save (upsert) a meta record
export async function saveMetaRecord(record, kind, options = {}) {
  if (!record || typeof record !== 'object' || !record.id) {
    throw new Error('saveMetaRecord requires a record with id');
  }

  const owner = resolveOwner(options);
  const now = nowIso();
  const payload = { ...record, updatedAt: now };

  if (supabase) {
    const { error } = await supabase
      .from('gtd_meta')
      .upsert({
        id: record.id,
        owner,
        kind,
        payload,
        updated_at: now,
      }, { onConflict: 'id,owner' });

    if (error) {
      // Fallback: try with just id if (id,owner) unique constraint doesn't exist
      const { error: error2 } = await supabase
        .from('gtd_meta')
        .upsert({ id: record.id, owner, kind, payload, updated_at: now }, { onConflict: 'id' });
      if (error2) throw error2;
    }
    return;
  }

  const db = await loadMetaDb();
  const records = db.records || [];
  const idx = records.findIndex(r => r.owner === owner && r.payload?.id === record.id);
  const entry = { owner, kind, payload };
  if (idx === -1) {
    db.records = [entry, ...records];
  } else {
    records[idx] = entry;
    db.records = records;
  }
  await saveMetaDb(db);
}

// Delete a meta record by id
export async function deleteMetaRecord(id, options = {}) {
  const owner = resolveOwner(options);

  if (supabase) {
    const { error } = await supabase
      .from('gtd_meta')
      .delete()
      .eq('owner', owner)
      .eq('id', id);
    if (error) throw error;
    return;
  }

  const db = await loadMetaDb();
  db.records = (db.records || []).filter(r => !(r.owner === owner && r.payload?.id === id));
  await saveMetaDb(db);
}

// Load feature flags for an owner (returns defaults if none stored)
export async function loadFeatureFlags(options = {}) {
  const defaults = {
    weekly_review: true,
    custom_contexts: true,
    custom_areas: true,
    command_palette: true,
  };

  try {
    const records = await loadMetaByKind('feature_flags', options);
    if (!records.length) return defaults;
    return { ...defaults, ...records[0] };
  } catch {
    // CRITICAL: fallback to defaults if DB fails
    return defaults;
  }
}

// Local JSON helpers
async function loadMetaDb() {
  await ensureDir();
  try {
    const raw = await readFile(META_PATH, 'utf8');
    const data = JSON.parse(raw);
    return { version: 1, ...data, records: data.records || [] };
  } catch {
    return { version: 1, records: [] };
  }
}

async function saveMetaDb(db) {
  await ensureDir();
  const tmp = `${META_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2) + '\n', 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, META_PATH);
}
