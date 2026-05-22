/** Tracked weekly expiries for live option-chain archive (IST dates). */
const DEFAULT_ARCHIVE_EXPIRIES = ['2026-05-26', '2026-06-02'];

const DEFAULT_ARCHIVE_SYMBOL = 'NIFTY';

/** Dhan docs: 1 unique option-chain request per 3s — keep margin between expiries. */
const EXPIRY_FETCH_GAP_MS = 4000;

/** Pause between full capture cycles (all expiries for one symbol). */
const RECORDER_CYCLE_PAUSE_MS = 6000;

/** Per-expiry fetch retries before marking a cycle failure. */
const FETCH_MAX_ATTEMPTS = 5;

/** Backoff after failed attempt (ms); last slot used for rate-limit cooldown. */
const FETCH_RETRY_DELAYS_MS = [0, 4000, 12000, 45000, 90000];

/** MongoDB write retries. */
const DB_SAVE_MAX_ATTEMPTS = 3;

const MARKET_OPEN_MINUTES = 9 * 60 + 15;
const MARKET_CLOSE_MINUTES = 15 * 60 + 30;

module.exports = {
  DEFAULT_ARCHIVE_EXPIRIES,
  DEFAULT_ARCHIVE_SYMBOL,
  EXPIRY_FETCH_GAP_MS,
  RECORDER_CYCLE_PAUSE_MS,
  FETCH_MAX_ATTEMPTS,
  FETCH_RETRY_DELAYS_MS,
  DB_SAVE_MAX_ATTEMPTS,
  MARKET_OPEN_MINUTES,
  MARKET_CLOSE_MINUTES,
};
