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

test('parseMaxLossesPerSidePerDay defaults to 2 and disables at 0', () => {
  assert.equal(parseMaxLossesPerSidePerDay({}), 2);
  assert.equal(parseMaxLossesPerSidePerDay({ maxLossesPerSidePerDay: 0 }), null);
  assert.equal(parseMaxLossesPerSidePerDay({ maxLossesPerSidePerDay: 3 }), 3);
});

test('only STOP_LOSS rows count toward side lockout', () => {
  const counts = countStopLossesBySide([
    { optionType: 'PE', reason: 'STOP_LOSS' },
    { optionType: 'PE', reason: 'TRAIL_STOP' },
    { optionType: 'PE', reason: 'STOP_LOSS' },
    { optionType: 'CE', reason: 'DAY_CLOSE' },
    { optionType: 'CE', reason: 'STOP_LOSS' },
  ]);
  assert.deepEqual(counts, { peSlCount: 2, ceSlCount: 1 });
});

test('PE locks independently from CE', () => {
  const state = { peSlCount: 2, ceSlCount: 0, maxLossesPerSidePerDay: 2 };
  assert.equal(isOptionSideLocked('PE', state), true);
  assert.equal(isOptionSideLocked('CE', state), false);
  assert.equal(sideLockSkipReason('PE', state), 'PE_SIDE_LOCKED');
  assert.equal(sideLockSkipReason('CE', state), null);
  assert.equal(bothSidesLocked(state), false);
});

test('both sides lock when each hits cap', () => {
  const state = { peSlCount: 2, ceSlCount: 2, maxLossesPerSidePerDay: 2 };
  assert.equal(bothSidesLocked(state), true);
});

test('filterTradesByMaxLossesPerSidePerDay drops same-side entries after N STOP_LOSS', () => {
  const day = '2026-07-13';
  const trades = [
    { type: 'CE', reason: 'TRAIL_STOP', entryTime: `${day}T04:25:00.000Z` }, // 09:55 IST
    { type: 'CE', reason: 'STOP_LOSS', entryTime: `${day}T05:45:00.000Z` }, // 11:15
    { type: 'CE', reason: 'TRAIL_STOP', entryTime: `${day}T06:00:00.000Z` }, // 11:30
    { type: 'CE', reason: 'STOP_LOSS', entryTime: `${day}T06:25:00.000Z` }, // 11:55 — 2nd SL
    { type: 'CE', reason: 'TRAIL_STOP', entryTime: `${day}T06:40:00.000Z` }, // 12:10 — must drop
    { type: 'CE', reason: 'STOP_LOSS', entryTime: `${day}T07:30:00.000Z` }, // 13:00 — must drop
    { type: 'PE', reason: 'TRAIL_STOP', entryTime: `${day}T06:50:00.000Z` }, // PE still allowed
  ];

  const kept = filterTradesByMaxLossesPerSidePerDay(trades, { maxLossesPerSidePerDay: 2 });
  assert.equal(kept.length, 5);
  assert.deepEqual(
    kept.map((t) => `${t.type}:${t.reason}`),
    [
      'CE:TRAIL_STOP',
      'CE:STOP_LOSS',
      'CE:TRAIL_STOP',
      'CE:STOP_LOSS',
      'PE:TRAIL_STOP',
    ],
  );
});

test('filter keeps all trades when maxLossesPerSidePerDay is 0 (disabled)', () => {
  const trades = [
    { type: 'CE', reason: 'STOP_LOSS', entryTime: '2026-07-13T05:00:00.000Z' },
    { type: 'CE', reason: 'STOP_LOSS', entryTime: '2026-07-13T06:00:00.000Z' },
    { type: 'CE', reason: 'STOP_LOSS', entryTime: '2026-07-13T07:00:00.000Z' },
  ];
  const kept = filterTradesByMaxLossesPerSidePerDay(trades, { maxLossesPerSidePerDay: 0 });
  assert.equal(kept.length, 3);
});
