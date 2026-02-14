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

function resolveOwner(options) {
  if (typeof options === 'string' && options.trim()) return options.trim();
  if (options && typeof options === 'object' && typeof options.owner === 'string' && options.owner.trim()) {
    return options.owner.trim();
  }
  return SUPABASE_OWNER;
}

// IMPORTANT: Using SERVICE_ROLE_KEY bypasses RLS policies
// This is intentional for server-side operations where we trust the server
// to enforce authorization. The 'owner' field is manually managed by server logic.
//
// For client-side operations, use ANON_KEY (in server.js supabaseAuth)
// which respects RLS policies and automatically scopes to authenticated user.
const supabase = (USE_SUPABASE && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

export function isStoreSupabaseMode() {
  return Boolean(supabase);
}

function nowIso() {
  return new Date().toISOString();
}

async function ensureDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

export async function loadDb(options = {}) {
  const owner = resolveOwner(options);

  if (supabase) {
    const { data, error } = await supabase
      .from('gtd_items')
      .select('payload')
      .eq('owner', owner)
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
      ...data,
      items: data.items || [],
    };
  } catch {
    return {
      version: 1,
      items: [],
    };
  }
}

export async function saveDb(db, options = {}) {
  const owner = resolveOwner(options);

  if (supabase) {
    const items = Array.isArray(db?.items) ? db.items : [];

    if (items.length) {
      const rows = items.map(item => ({
        id: item.id,
        owner,
        payload: item,
        updated_at: new Date(item.updatedAt || item.createdAt || nowIso()).toISOString(),
      }));

      // Usar upsert en lugar de delete+insert para mejor performance y evitar race conditions
      const { error: upsertErr } = await supabase
        .from('gtd_items')
        .upsert(rows, {
          onConflict: 'id',  // PRIMARY KEY es solo 'id', no 'id,owner'
          ignoreDuplicates: false,
        });
      if (upsertErr) {
        console.error('[saveDb] Upsert error:', JSON.stringify(upsertErr, null, 2));
        throw upsertErr;
      }

      // Eliminar items que ya no están en la lista actual
      const currentIds = items.map(i => i.id);
      // Obtener todos los IDs actuales en Supabase para este owner
      const { data: existingData, error: fetchErr } = await supabase
        .from('gtd_items')
        .select('id')
        .eq('owner', owner);

      if (fetchErr) {
        console.error('[saveDb] Fetch existing IDs error:', JSON.stringify(fetchErr, null, 2));
        throw fetchErr;
      }

      // Identificar IDs a eliminar (los que están en Supabase pero no en la lista local)
      const existingIds = (existingData || []).map(row => row.id);
      const idsToDelete = existingIds.filter(id => !currentIds.includes(id));

      // Batch delete: eliminar todos los IDs obsoletos en una sola query
      if (idsToDelete.length > 0) {
        const { error: delErr } = await supabase
          .from('gtd_items')
          .delete()
          .eq('owner', owner)
          .in('id', idsToDelete);

        if (delErr) {
          console.error('[saveDb] Batch delete error:', JSON.stringify(delErr, null, 2));
          // Don't throw, just warn - deletion of old items is not critical
        }
      }
    } else {
      // Si no hay items, eliminar todos los items del owner
      const { error: delErr } = await supabase
        .from('gtd_items')
        .delete()
        .eq('owner', owner);
      if (delErr) throw delErr;
    }
    return;
  }

  await ensureDir();
  const tmp = `${DB_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2) + '\n', 'utf8');
  // Usar rename atómico en lugar de read+write
  const { rename } = await import('node:fs/promises');
  await rename(tmp, DB_PATH);
}

export async function saveItem(item, options = {}) {
  if (!item || typeof item !== 'object' || !item.id) {
    throw new Error('saveItem requires an item with id');
  }

  const owner = resolveOwner(options);

  if (supabase) {
    const row = {
      id: item.id,
      owner,
      payload: item,
      updated_at: new Date(item.updatedAt || item.createdAt || nowIso()).toISOString(),
    };
    const { error } = await supabase
      .from('gtd_items')
      .upsert(row, { onConflict: 'id,owner', ignoreDuplicates: false });
    if (error) throw error;
    return;
  }

  const db = await loadDb({ owner });
  const items = Array.isArray(db.items) ? db.items : [];
  const idx = items.findIndex(i => i.id === item.id);
  if (idx === -1) {
    db.items = [item, ...items];
  } else {
    items[idx] = item;
    db.items = items;
  }
  await saveDb(db, { owner });
}

export async function deleteItemById(id, options = {}) {
  const owner = resolveOwner(options);

  if (supabase) {
    const { error } = await supabase
      .from('gtd_items')
      .delete()
      .eq('owner', owner)
      .eq('id', id);
    if (error) throw error;
    return;
  }

  const db = await loadDb({ owner });
  db.items = (db.items || []).filter(i => i.id !== id);
  await saveDb(db, { owner });
}

export async function findRecentDuplicate(input, options = {}) {
  const owner = resolveOwner(options);
  const threeSecondsAgo = new Date(Date.now() - 3000).toISOString();
  const normalizedInput = String(input || '').trim().toLowerCase();

  if (supabase) {
    const { data, error } = await supabase
      .from('gtd_items')
      .select('id, payload')
      .eq('owner', owner)
      .gte('updated_at', threeSecondsAgo)
      .limit(20); // Solo verificar items muy recientes

    if (error) throw error;

    // Filtrar en memoria ya que no podemos hacer ILIKE en payload JSONB fácilmente
    const duplicate = (data || []).find(row => {
      const item = row.payload;
      return (
        item.list === 'collect' &&
        item.status !== 'done' &&
        String(item.input || '').trim().toLowerCase() === normalizedInput
      );
    });

    return duplicate ? duplicate.payload : null;
  }

  // Modo local: cargar toda la DB (no hay alternativa)
  const db = await loadDb({ owner });
  const now = Date.now();
  return (db.items || []).find(i =>
    i.list === 'collect' &&
    i.status !== 'done' &&
    String(i.input || '').trim().toLowerCase() === normalizedInput &&
    Math.abs(now - new Date(i.createdAt || 0).getTime()) < 3000
  ) || null;
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
