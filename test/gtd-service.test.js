import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateActionability, withHacerMeta } from '../src/services/gtd-service.js';

test('evaluateActionability returns high score for clear infinitive action', () => {
  const result = evaluateActionability('Llamar a proveedor');
  assert.equal(result.actionableOk, true);
  assert.ok(result.actionableScore >= 70);
});

test('evaluateActionability returns low score for vague action', () => {
  const result = evaluateActionability('pendiente');
  assert.equal(result.actionableOk, false);
  assert.ok(result.actionableScore < 70);
});

test('withHacerMeta caps estimateMin to 10 and calculates priority', () => {
  const result = withHacerMeta({ input: 'x' }, { title: 'Definir plan', urgency: 5, importance: 4, estimateMin: 25 });
  assert.equal(result.estimateMin, 10);
  assert.equal(result.priorityScore, 20);
  assert.ok(result.durationWarning);
});
