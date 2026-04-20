function toIntradayDateTime(value, endOfDay = false) {
  if (!value) return '';
  if (value.includes(' ')) return value;
  return `${value} ${endOfDay ? '15:30:00' : '09:15:00'}`;
}

function parseDateOnly(value) {
  return new Date(`${value}T00:00:00`);
}

function formatDateOnly(value) {
  return value.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
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
  parseClockMinutes,
  sleep,
};
