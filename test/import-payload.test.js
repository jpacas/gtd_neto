import test from 'node:test';
import assert from 'node:assert/strict';

import { ImportValidationError, validateAndNormalizeImportPayload } from '../src/validators/import-payload.js';

const sanitizeInput = (value) => String(value || '').trim();

test('validateAndNormalizeImportPayload accepts valid payload', () => {
  const payload = {
    items: [{
      id: 'abc12345',
      input: 'Tarea',
      list: 'collect',
      status: 'unprocessed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
  };
  const items = validateAndNormalizeImportPayload(payload, sanitizeInput);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'abc12345');
});

test('validateAndNormalizeImportPayload rejects unknown keys', () => {
  const payload = {
    items: [{
      id: 'abc12345',
      input: 'Tarea',
      list: 'collect',
      status: 'unprocessed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      extra: true,
    }],
  };

  assert.throws(
    () => validateAndNormalizeImportPayload(payload, sanitizeInput),
    (err) => err instanceof ImportValidationError && err.details[0].includes('unsupported keys')
  );
});

test('validateAndNormalizeImportPayload rejects duplicate ids in payload', () => {
  const payload = {
    items: [
      {
        id: 'abc12345',
        input: 'Tarea 1',
        list: 'collect',
        status: 'unprocessed',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'abc12345',
        input: 'Tarea 2',
        list: 'collect',
        status: 'unprocessed',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };

  assert.throws(
    () => validateAndNormalizeImportPayload(payload, sanitizeInput),
    (err) => err instanceof ImportValidationError && err.details[0].includes('duplicate id')
  );
});
