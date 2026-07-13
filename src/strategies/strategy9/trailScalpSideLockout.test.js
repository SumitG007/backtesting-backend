const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseMaxLossesPerSidePerDay,
  isOptionSideLocked,
  sideLockSkipReason,
  countStopLossesBySide,
  bothSidesLocked,
  filterTradesByMaxLossesPerSidePerDay,
} = require('./trailScalpSideLockout');

test('parseMaxLossesPerSidePerDay always returns null (lockout disabled)', () => {
  assert.equal(parseMaxLossesPerSidePerDay({}), null);
  assert.equal(parseMaxLossesPerSidePerDay({ maxLossesPerSidePerDay: 0 }), null);
  assert.equal(parseMaxLossesPerSidePerDay({ maxLossesPerSidePerDay: 2 }), null);
  assert.equal(parseMaxLossesPerSidePerDay({ maxLossesPerSidePerDay: 3 }), null);
});

test('only STOP_LOSS rows count toward side stats (helper still works)', () => {
  const counts = countStopLossesBySide([
    { optionType: 'PE', reason: 'STOP_LOSS' },
    { optionType: 'PE', reason: 'TRAIL_STOP' },
    { optionType: 'PE', reason: 'STOP_LOSS' },
    { optionType: 'CE', reason: 'DAY_CLOSE' },
    { optionType: 'CE', reason: 'STOP_LOSS' },
  ]);
  assert.deepEqual(counts, { peSlCount: 2, ceSlCount: 1 });
});

test('side lockout never locks PE or CE', () => {
  const state = { peSlCount: 99, ceSlCount: 99, maxLossesPerSidePerDay: 2 };
  assert.equal(isOptionSideLocked('PE', state), false);
  assert.equal(isOptionSideLocked('CE', state), false);
  assert.equal(sideLockSkipReason('PE', state), null);
  assert.equal(sideLockSkipReason('CE', state), null);
  assert.equal(bothSidesLocked(state), false);
});

test('filterTradesByMaxLossesPerSidePerDay keeps all trades', () => {
  const day = '2026-07-13';
  const trades = [
    { type: 'CE', reason: 'STOP_LOSS', entryTime: `${day}T05:45:00.000Z` },
    { type: 'CE', reason: 'STOP_LOSS', entryTime: `${day}T06:25:00.000Z` },
    { type: 'CE', reason: 'STOP_LOSS', entryTime: `${day}T07:30:00.000Z` },
    { type: 'PE', reason: 'TRAIL_STOP', entryTime: `${day}T06:50:00.000Z` },
  ];
  const kept = filterTradesByMaxLossesPerSidePerDay(trades, { maxLossesPerSidePerDay: 2 });
  assert.equal(kept.length, 4);
});
