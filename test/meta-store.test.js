import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Each test runs against a fresh temp dir by overriding META_PATH
async function withTempStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gtd-meta-test-'));
  const metaPath = path.join(dir, 'meta.json');
  const origMetaPath = process.env.META_PATH;
  const origDataDir = process.env.DATA_DIR;
  process.env.META_PATH = metaPath;
  process.env.DATA_DIR = dir;
  try {
    // Re-import with fresh env — we isolate via the file path env vars
    const { loadMetaByKind, saveMetaRecord, loadFeatureFlags } = await import('../lib/meta-store.js');
    await fn({ loadMetaByKind, saveMetaRecord, loadFeatureFlags, dir, metaPath });
  } finally {
    if (origMetaPath === undefined) delete process.env.META_PATH;
    else process.env.META_PATH = origMetaPath;
    if (origDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = origDataDir;
    await rm(dir, { recursive: true, force: true });
  }
}

// Since meta-store.js reads env at module load time (top-level), we need a different approach.
// We test the local (non-Supabase) code path directly using a shared import with isolated file paths.
// Because USE_SUPABASE is false (not set in test env), all tests use local JSON.

const { loadMetaByKind, saveMetaRecord, loadFeatureFlags } = await (async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gtd-meta-main-'));
  process.env.META_PATH = path.join(dir, 'meta.json');
  process.env.DATA_DIR = dir;
  // Clean up dir on process exit
  process.on('exit', () => {
    try {
      import('node:fs').then(fs => fs.rmSync(dir, { recursive: true, force: true }));
    } catch {}
  });
  return import('../lib/meta-store.js');
})();

test('loadMetaByKind returns [] when no records exist', async () => {
  const result = await loadMetaByKind('context', { owner: 'user-test-empty' });
  assert.deepEqual(result, []);
});

test('saveMetaRecord upserts correctly by id — second save overwrites', async () => {
  const owner = 'user-test-upsert';

  await saveMetaRecord({ id: 'r1', name: 'First' }, 'context', { owner });
  const first = await loadMetaByKind('context', { owner });
  assert.equal(first.length, 1);
  assert.equal(first[0].name, 'First');

  // Upsert same id with updated name
  await saveMetaRecord({ id: 'r1', name: 'Updated' }, 'context', { owner });
  const second = await loadMetaByKind('context', { owner });
  assert.equal(second.length, 1);
  assert.equal(second[0].name, 'Updated');
});

test('loadMetaByKind filters by owner — no cross-user data', async () => {
  await saveMetaRecord({ id: 'c1', name: 'User A Context' }, 'context', { owner: 'user-a' });
  await saveMetaRecord({ id: 'c2', name: 'User B Context' }, 'context', { owner: 'user-b' });

  const forA = await loadMetaByKind('context', { owner: 'user-a' });
  const forB = await loadMetaByKind('context', { owner: 'user-b' });

  assert.ok(forA.every(r => r.name.includes('User A')), 'user-a should not see user-b data');
  assert.ok(forB.every(r => r.name.includes('User B')), 'user-b should not see user-a data');
});

test('loadFeatureFlags returns all-true defaults when no record exists', async () => {
  const flags = await loadFeatureFlags({ owner: 'user-no-flags' });
  assert.equal(flags.weekly_review, true);
  assert.equal(flags.custom_contexts, true);
  assert.equal(flags.custom_areas, true);
  assert.equal(flags.command_palette, true);
});
