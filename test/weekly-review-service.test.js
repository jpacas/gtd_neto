import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateStreak, runStepCheck } from '../src/services/weekly-review-service.js';

// Helper: build a completed review N days ago
function reviewDaysAgo(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return { completedAt: d.toISOString() };
}

// --- calculateStreak ---

test('calculateStreak is 0 when no completed reviews', () => {
  assert.equal(calculateStreak([]), 0);
  assert.equal(calculateStreak(null), 0);
});

test('calculateStreak is 1 when last review completed this week', () => {
  const reviews = [reviewDaysAgo(3)];
  assert.equal(calculateStreak(reviews), 1);
});

test('calculateStreak is 0 when last review is older than 14 days', () => {
  const reviews = [reviewDaysAgo(15)];
  assert.equal(calculateStreak(reviews), 0);
});

test('calculateStreak counts consecutive reviews (gap <= 14 days each)', () => {
  const reviews = [
    reviewDaysAgo(3),   // most recent
    reviewDaysAgo(10),  // 7-day gap from first — consecutive
    reviewDaysAgo(20),  // 10-day gap from second — consecutive
  ];
  assert.equal(calculateStreak(reviews), 3);
});

test('calculateStreak stops counting after a gap > 14 days', () => {
  const reviews = [
    reviewDaysAgo(3),   // most recent
    reviewDaysAgo(10),  // consecutive
    reviewDaysAgo(30),  // 20-day gap — breaks streak
    reviewDaysAgo(37),  // not counted
  ];
  assert.equal(calculateStreak(reviews), 2);
});

// --- runStepCheck ---

test('runStepCheck step 1 returns ok:false when collect has items', async () => {
  const loadItemsForList = async (list) => {
    if (list === 'collect') return [{ id: '1', input: 'foo' }, { id: '2', input: 'bar' }];
    return [];
  };
  const result = await runStepCheck(1, { loadItemsForList, owner: 'default' });
  assert.equal(result.ok, false);
  assert.equal(result.count, 2);
  assert.ok(result.message.includes('2'));
});

test('runStepCheck step 1 returns ok:true when collect is empty', async () => {
  const loadItemsForList = async () => [];
  const result = await runStepCheck(1, { loadItemsForList, owner: 'default' });
  assert.equal(result.ok, true);
  assert.equal(result.count, 0);
  assert.ok(result.message.toLowerCase().includes('vac'));
});

test('runStepCheck step 5 always returns ok:true (manual capture step)', async () => {
  const loadItemsForList = async () => [{ id: '1' }]; // data doesn't affect step 5
  const result = await runStepCheck(5, { loadItemsForList, owner: 'default' });
  assert.equal(result.ok, true);
});

test('runStepCheck does not throw when loadItemsForList rejects', async () => {
  const loadItemsForList = async () => { throw new Error('DB error'); };
  const result = await runStepCheck(1, { loadItemsForList, owner: 'default' });
  // Falls back to ok:true on error (no blocking behavior on transient failures)
  assert.equal(result.ok, true);
});
