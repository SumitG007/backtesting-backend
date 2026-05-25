/** Tracked weekly expiries for live option-chain archive (IST dates). */
const DEFAULT_ARCHIVE_EXPIRIES = ['2026-05-26', '2026-06-02'];

const DEFAULT_ARCHIVE_SYMBOL = 'NIFTY';

/** Dhan docs: 1 unique option-chain request per 3s — keep margin between expiries. */
const EXPIRY_FETCH_GAP_MS = 4000;

/** Pause between full capture cycles while inside a capture window. */
const RECORDER_CYCLE_PAUSE_MS = 5000;

/** Per-expiry fetch retries before marking a cycle failure. */
const FETCH_MAX_ATTEMPTS = 5;

/** Backoff after failed attempt (ms); last slot used for rate-limit cooldown. */
const FETCH_RETRY_DELAYS_MS = [0, 4000, 12000, 45000, 90000];

/** MongoDB write retries. */
const DB_SAVE_MAX_ATTEMPTS = 3;

/** IST capture windows — open (9:15–9:30) and day close (15:15–15:30) only. */
const OPEN_CAPTURE_START_MINUTES = 9 * 60 + 15;
const OPEN_CAPTURE_END_MINUTES = 9 * 60 + 30;
const CLOSE_CAPTURE_START_MINUTES = 15 * 60 + 15;
const CLOSE_CAPTURE_END_MINUTES = 15 * 60 + 30;

function formatIstTimeKey(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function formatIstTimeLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function buildMinuteRange(start, end) {
  const out = [];
  for (let m = start; m <= end; m += 1) out.push(m);
  return out;
}

const OPEN_CAPTURE_MINUTES = buildMinuteRange(OPEN_CAPTURE_START_MINUTES, OPEN_CAPTURE_END_MINUTES);
const CLOSE_CAPTURE_MINUTES = buildMinuteRange(CLOSE_CAPTURE_START_MINUTES, CLOSE_CAPTURE_END_MINUTES);

const ALLOWED_CAPTURE_MINUTES = [...OPEN_CAPTURE_MINUTES, ...CLOSE_CAPTURE_MINUTES];

const CAPTURE_TIME_SLOTS = [
  ...OPEN_CAPTURE_MINUTES.map((m) => ({
    value: formatIstTimeKey(m),
    label: formatIstTimeLabel(m),
    window: 'open',
    minutes: m,
  })),
  ...CLOSE_CAPTURE_MINUTES.map((m) => ({
    value: formatIstTimeKey(m),
    label: formatIstTimeLabel(m),
    window: 'close',
    minutes: m,
  })),
];

const ALLOWED_IST_TIME_KEYS = CAPTURE_TIME_SLOTS.map((s) => s.value);

function minutesFromIstTimeKey(timeKey) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(timeKey || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function isOutsideCaptureZones(minutes) {
  if (!Number.isFinite(minutes)) return true;
  if (minutes < OPEN_CAPTURE_START_MINUTES) return true;
  if (minutes > OPEN_CAPTURE_END_MINUTES && minutes < CLOSE_CAPTURE_START_MINUTES) return true;
  if (minutes > CLOSE_CAPTURE_END_MINUTES) return true;
  return false;
}

/** @deprecated Use capture-window helpers; kept for scripts that still import these names. */
const MARKET_OPEN_MINUTES = OPEN_CAPTURE_START_MINUTES;
const MARKET_CLOSE_MINUTES = CLOSE_CAPTURE_END_MINUTES;

module.exports = {
  DEFAULT_ARCHIVE_EXPIRIES,
  DEFAULT_ARCHIVE_SYMBOL,
  EXPIRY_FETCH_GAP_MS,
  RECORDER_CYCLE_PAUSE_MS,
  FETCH_MAX_ATTEMPTS,
  FETCH_RETRY_DELAYS_MS,
  DB_SAVE_MAX_ATTEMPTS,
  OPEN_CAPTURE_START_MINUTES,
  OPEN_CAPTURE_END_MINUTES,
  CLOSE_CAPTURE_START_MINUTES,
  CLOSE_CAPTURE_END_MINUTES,
  OPEN_CAPTURE_MINUTES,
  CLOSE_CAPTURE_MINUTES,
  ALLOWED_CAPTURE_MINUTES,
  CAPTURE_TIME_SLOTS,
  ALLOWED_IST_TIME_KEYS,
  formatIstTimeKey,
  formatIstTimeLabel,
  minutesFromIstTimeKey,
  isOutsideCaptureZones,
  MARKET_OPEN_MINUTES,
  MARKET_CLOSE_MINUTES,
};
