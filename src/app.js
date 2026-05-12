const express = require('express');
const cors = require('cors');
const apiRoutes = require('./routes');

const app = express();

function normalizeCorsOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return true;
  const origins = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      try {
        return new URL(item).origin;
      } catch {
        return item.replace(/\/+$/, '');
      }
    });
  return origins.length <= 1 ? origins[0] : origins;
}

app.use(cors({ origin: normalizeCorsOrigin(process.env.CORS_ORIGIN) }));
app.use(express.json());
app.use('/api', apiRoutes);

module.exports = app;
