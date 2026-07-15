/**
 * After server boot (with token) or when a fresh Dhan JWT is saved, re-sync paper-live
 * engines with MongoDB open trades and re-run exit/entry checks on real Dhan marks.
 */
async function notifyDhanConnectivityRestored() {
  const strategyFour = require('./liveShortStraddleEngine');
  const strategySix = require('./liveShortStraddleEngineStrategy6');
  const strategySeven = require('./livePutBuyEngine');
  const strategyNine = require('./liveOneSideCandleScalpEngine');
  const strategyEleven = require('./liveSlFlipEngine');
  const results = await Promise.allSettled([
    strategyFour.resumeOpenPositionFromDb(),
    strategySix.resumeOpenPositionFromDb(),
    strategySeven.resumeOpenPositionFromDb(),
    strategyNine.resumeOpenPositionFromDb(),
    strategyEleven.resumeOpenPositionFromDb(),
  ]);
  return {
    strategy4: results[0].status === 'fulfilled' ? results[0].value : { ok: false, error: results[0].reason?.message },
    strategy6: results[1].status === 'fulfilled' ? results[1].value : { ok: false, error: results[1].reason?.message },
    strategy7: results[2].status === 'fulfilled' ? results[2].value : { ok: false, error: results[2].reason?.message },
    strategy9: results[3].status === 'fulfilled' ? results[3].value : { ok: false, error: results[3].reason?.message },
    strategy11: results[4].status === 'fulfilled' ? results[4].value : { ok: false, error: results[4].reason?.message },
  };
}

module.exports = { notifyDhanConnectivityRestored };
