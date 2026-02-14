import test from 'node:test';
import assert from 'node:assert/strict';

import { upsertWithConflictFallbackForClient } from '../lib/store.js';

function makeClient(results) {
  const calls = [];
  return {
    calls,
    from() {
      return {
        upsert(_rows, options) {
          calls.push(options.onConflict);
          return Promise.resolve(results[calls.length - 1] || { error: null });
        },
      };
    },
  };
}

test('upsertWithConflictFallbackForClient retries from id,owner to id on 42P10', async () => {
  const client = makeClient([
    { error: { code: '42P10', message: 'no unique or exclusion constraint matching the ON CONFLICT specification' } },
    { error: null },
  ]);

  await upsertWithConflictFallbackForClient(client, { id: 'a' });

  assert.deepEqual(client.calls, ['id,owner', 'id']);
});

test('upsertWithConflictFallbackForClient does not retry on non-conflict errors', async () => {
  const client = makeClient([
    { error: { code: '42501', message: 'permission denied' } },
  ]);

  await assert.rejects(
    () => upsertWithConflictFallbackForClient(client, { id: 'a' }),
    (err) => err?.code === '42501'
  );
  assert.deepEqual(client.calls, ['id,owner']);
});

test('upsertWithConflictFallbackForClient keeps original order when first target succeeds', async () => {
  const client = makeClient([
    { error: null },
  ]);

  await upsertWithConflictFallbackForClient(client, [{ id: 'a' }, { id: 'b' }]);

  assert.deepEqual(client.calls, ['id,owner']);
});

test('upsertWithConflictFallbackForClient bubbles last conflict error if all targets fail', async () => {
  const lastError = { code: '42P10', message: 'no unique or exclusion constraint matching the ON CONFLICT specification' };
  const client = makeClient([
    { error: { code: '42P10', message: 'no unique or exclusion constraint matching the ON CONFLICT specification' } },
    { error: lastError },
  ]);

  await assert.rejects(
    () => upsertWithConflictFallbackForClient(client, { id: 'a' }),
    (err) => err === lastError
  );
  assert.deepEqual(client.calls, ['id,owner', 'id']);
});
