/**
 * After server boot (with token) or when a fresh Dhan JWT is saved, re-sync paper-live
 * engines with MongoDB open trades and re-run exit/entry checks on real Dhan marks.
 */
async function notifyDhanConnectivityRestored() {
  const strategyThree = require('./liveIvMeanReversionEngine');
  const strategyFour = require('./liveShortStraddleEngine');
  const strategySix = require('./liveShortStraddleEngineStrategy6');
  const strategySeven = require('./livePutBuyEngine');
  const results = await Promise.allSettled([
    strategyThree.resumeOpenPositionFromDb(),
    strategyFour.resumeOpenPositionFromDb(),
    strategySix.resumeOpenPositionFromDb(),
    strategySeven.resumeOpenPositionFromDb(),
  ]);
  return {
    strategy3: results[0].status === 'fulfilled' ? results[0].value : { ok: false, error: results[0].reason?.message },
    strategy4: results[1].status === 'fulfilled' ? results[1].value : { ok: false, error: results[1].reason?.message },
    strategy6: results[2].status === 'fulfilled' ? results[2].value : { ok: false, error: results[2].reason?.message },
    strategy7: results[3].status === 'fulfilled' ? results[3].value : { ok: false, error: results[3].reason?.message },
  };
}

module.exports = { notifyDhanConnectivityRestored };
