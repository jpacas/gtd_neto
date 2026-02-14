import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!url || !key) {
  console.error('[check-supabase-conflict-target] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}

const owner = `diag_owner_${Date.now()}`;
const id = `diag_${Math.random().toString(36).slice(2, 12)}`;
const now = new Date().toISOString();

const payload = {
  id,
  input: 'diagnostic conflict target',
  title: 'diagnostic conflict target',
  list: 'collect',
  status: 'unprocessed',
  createdAt: now,
  updatedAt: now,
};

const row = { id, owner, payload, updated_at: now };
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function tryConflictTarget(onConflict) {
  const { error } = await supabase
    .from('gtd_items')
    .upsert(row, { onConflict, ignoreDuplicates: false });
  return error || null;
}

let detectedTarget = '';
let errorIdOwner = null;
let errorId = null;

try {
  errorIdOwner = await tryConflictTarget('id,owner');
  if (!errorIdOwner) {
    detectedTarget = 'id,owner';
  } else {
    errorId = await tryConflictTarget('id');
    if (!errorId) detectedTarget = 'id';
  }
} finally {
  // Best-effort cleanup.
  await supabase.from('gtd_items').delete().eq('id', id).eq('owner', owner);
}

if (detectedTarget) {
  console.log(`[check-supabase-conflict-target] OK: compatible onConflict target = "${detectedTarget}"`);
  process.exit(0);
}

console.error('[check-supabase-conflict-target] FAIL: neither "id,owner" nor "id" worked.');
if (errorIdOwner) {
  console.error('[id,owner] ', errorIdOwner.code || '', errorIdOwner.message || '');
}
if (errorId) {
  console.error('[id]       ', errorId.code || '', errorId.message || '');
}
process.exit(1);
