/**
 * Extract Aug 12 OI flow paste from agent transcript → JSON records.
 */
const fs = require('fs');
const path = require('path');

const transcript = path.join(
  process.env.USERPROFILE || '',
  '.cursor/projects/d-SaklaniSaab-Expinator-ID-backtesting-frontend/agent-transcripts',
  'c0a80289-ad3a-4ddd-b32e-37cde04a6bbd',
  'c0a80289-ad3a-4ddd-b32e-37cde04a6bbd.jsonl',
);

const raw = fs.readFileSync(transcript, 'utf8');
const lines = raw.split('\n').filter(Boolean);
let text = '';
for (const line of lines) {
  try {
    const obj = JSON.parse(line);
    const parts = obj?.message?.content;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (p?.type === 'text' && String(p.text).includes('Sr No\tTime\tSpot price')) {
        text = p.text;
        break;
      }
    }
  } catch (_) {}
  if (text) break;
}
if (!text) {
  console.error('Could not find OI paste in transcript');
  process.exit(1);
}

function parseIndianNum(s) {
  if (s == null) return null;
  const t = String(s).replace(/,/g, '').replace(/\s+/g, '').trim();
  if (!t) return null;
  const m = t.match(/^([+-]?)(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const n = Number(m[2]);
  if (!Number.isFinite(n)) return null;
  return m[1] === '-' ? -n : n;
}

function timeToMinutes(t) {
  const m = String(t).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

const start = text.indexOf('Sr No\tTime\tSpot price');
const body = text.slice(start);
const endAt = body.search(/\nnow this is 1 min data/i);
const dataText = (endAt > 0 ? body.slice(0, endAt) : body)
  .replace(/\r/g, '')
  .replace(/15:30last entry[^\n\t]*/g, '15:30');

// Normalize signed numbers that were split across lines: "+\n1,91,38,275" → "+1,91,38,275"
let flat = dataText.replace(/\n([+-])\n(?=[\d,])/g, '\n$1').replace(/([+-])\n([\d,]+)/g, '$1$2');

// Split rows by sr\ttime pattern
const rowRe = /(?:^|\n)(\d+)\t(\d{1,2}:\d{2})\t([\d,.]+)\t?/g;
const indices = [];
let m;
while ((m = rowRe.exec(flat)) !== null) {
  indices.push({
    index: m.index + (m[0].startsWith('\n') ? 1 : 0),
    sr: Number(m[1]),
    time: m[2],
    spot: parseIndianNum(m[3]),
    matchLen: m[0].startsWith('\n') ? m[0].length - 1 : m[0].length,
  });
}

const rows = [];
for (let i = 0; i < indices.length; i++) {
  const cur = indices[i];
  const end = i + 1 < indices.length ? indices[i + 1].index : flat.length;
  const chunk = flat.slice(cur.index + cur.matchLen, end).trim();
  const tokens = chunk
    .split(/[\n\t]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  // Expected tokens:
  // dayCall, callChg, dayPut, putChg, diff, dir, chng, sentiment
  // Sometimes dayCall == callChg for first minutes (single value pairs)
  const nums = [];
  const others = [];
  for (const t of tokens) {
    if (/^[↑↓→]$/.test(t)) {
      others.push({ type: 'dir', v: t });
    } else if (/^(Bull|Bear|Neutral)$/i.test(t)) {
      others.push({ type: 'sent', v: t });
    } else if (/^[+-]?[\d,]+(?:\.\d+)?$/.test(t) || t === '0') {
      nums.push(parseIndianNum(t));
    }
  }

  let dayCall = 0;
  let callChg = 0;
  let dayPut = 0;
  let putChg = 0;
  let diff = null;
  let chng = null;

  if (nums.length >= 6) {
    // full: dayCall, callChg, dayPut, putChg, diff, chng
    dayCall = nums[0];
    callChg = nums[1];
    dayPut = nums[2];
    putChg = nums[3];
    diff = nums[4];
    chng = nums[5];
  } else if (nums.length === 5) {
    // possibly missing one chg (open bar): dayCall, dayPut, diff, and maybe zeros
    dayCall = nums[0];
    callChg = nums[0];
    dayPut = nums[1];
    putChg = nums[1];
    diff = nums[2];
    chng = nums[3] ?? nums[2];
  } else if (nums.length === 4) {
    dayCall = nums[0];
    callChg = 0;
    dayPut = nums[1];
    putChg = 0;
    diff = nums[2];
    chng = nums[3];
  } else if (nums.length >= 3) {
    dayCall = nums[0];
    dayPut = nums[1];
    diff = nums[2];
    callChg = 0;
    putChg = 0;
    chng = nums[3] ?? 0;
  }

  const dirTok = others.find((o) => o.type === 'dir');
  const sentTok = others.find((o) => o.type === 'sent');
  const dir = dirTok?.v || (chng > 0 ? '↑' : chng < 0 ? '↓' : '→');
  let sentiment = sentTok?.v || 'Neutral';
  sentiment = String(sentiment).match(/Bull|Bear|Neutral/i)?.[0] || 'Neutral';

  // Prefer derived consistency if diff missing
  if (diff == null && dayCall != null && dayPut != null) {
    diff = dayPut - dayCall;
  }
  if (chng == null && callChg != null && putChg != null) {
    chng = putChg - callChg;
  }

  rows.push({
    sr: cur.sr,
    time: cur.time,
    minutes: timeToMinutes(cur.time),
    spot: cur.spot,
    dayCallChgOi: dayCall,
    dayPutChgOi: dayPut,
    callsChgOi: callChg,
    putsChgOi: putChg,
    diffInOi: diff,
    chngInDir: chng,
    dirOfChng: dir === '↑' ? 'up' : dir === '↓' ? 'down' : 'flat',
    sentiment,
  });
}

rows.sort((a, b) => a.minutes - b.minutes || a.sr - b.sr);
const byMin = new Map();
for (const r of rows) byMin.set(r.minutes, r);
const finalRows = [...byMin.values()].sort((a, b) => a.minutes - b.minutes);

const outDir = path.join(__dirname, 'data');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'oi-flow-2026-08-12.json');
fs.writeFileSync(outFile, JSON.stringify(finalRows, null, 2));

console.log('parsed', finalRows.length);
console.log('first', JSON.stringify(finalRows[0]));
console.log('mid', JSON.stringify(finalRows[Math.floor(finalRows.length / 2)]));
console.log('last', JSON.stringify(finalRows[finalRows.length - 1]));
console.log('wrote', outFile);

// sanity: spot path
const spots = finalRows.map((r) => r.spot).filter((n) => Number.isFinite(n));
console.log('spot range', Math.min(...spots), Math.max(...spots));
