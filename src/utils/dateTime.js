function toIntradayDateTime(value, endOfDay = false) {
  if (!value) return '';
  if (value.includes(' ')) return value;
  return `${value} ${endOfDay ? '15:30:00' : '09:15:00'}`;
}

function parseDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return new Date(NaN);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDateOnly(value) {
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, '0');
  const d = String(value.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function differenceInDaysInclusive(fromDate, toDate) {
  const ms = parseDateOnly(toDate).getTime() - parseDateOnly(fromDate).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24)) + 1;
}

function normalizeTimestamp(value) {
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value);
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const num = Number(value);
    return new Date(num < 1e12 ? num * 1000 : num);
  }
  return new Date(value);
}

function getIstClock(isoValue) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(isoValue));

  const pick = (type) => parts.find((p) => p.type === type)?.value || '00';
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  const hour = Number(pick('hour'));
  const minute = Number(pick('minute'));
  return {
    dateKey: `${year}-${month}-${day}`,
    minutes: hour * 60 + minute,
  };
}

function getWeekdayFromDateKey(dateKey) {
  // dateKey format: YYYY-MM-DD (already in IST). Returns 0=Sunday ... 6=Saturday.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || '').trim());
  if (!match) return -1;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function parseClockMinutes(value, fallbackMinutes) {
  const raw = String(value || '').trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) return fallbackMinutes;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return fallbackMinutes;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return fallbackMinutes;
  return hh * 60 + mm;
}

/** Align IST minute to cash-session 15m grid anchored at 09:15 (minute 555). Same formula as live candle poll. */
function istCashSession15mBucketStart(minutes) {
  if (!Number.isFinite(minutes)) return minutes;
  if (minutes < 555 || minutes > 930) return minutes;
  return 555 + Math.floor((minutes - 555) / 15) * 15;
}

/** True once IST clock has reached the first minute AFTER this 15m bucket (bucket is fully closed). */
function ist15mBucketFullyClosed({ bucketStartMinutes, nowMinutes }) {
  if (!Number.isFinite(bucketStartMinutes) || !Number.isFinite(nowMinutes)) return false;
  return nowMinutes >= bucketStartMinutes + 15;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  toIntradayDateTime,
  parseDateOnly,
  formatDateOnly,
  addDays,
  differenceInDaysInclusive,
  normalizeTimestamp,
  getIstClock,
  getWeekdayFromDateKey,
  parseClockMinutes,
  istCashSession15mBucketStart,
  ist15mBucketFullyClosed,
  sleep,
};
