const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseMaxLossesPerSidePerDay,
  isOptionSideLocked,
  sideLockSkipReason,
  countStopLossesBySide,
  bothSidesLocked,
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
