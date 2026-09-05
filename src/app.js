const express = require('express');
const cors = require('cors');
const compression = require('compression');
const apiRoutes = require('./routes');
const { requireAuth } = require('./middleware/requireAuth');
const { resolveCorsOrigin } = require('./utils/corsOrigin');

const app = express();

// Needed so login rate-limit sees the real client IP behind ALB / reverse proxy.
app.set('trust proxy', 1);

app.use(cors({ origin: resolveCorsOrigin() }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use('/api', requireAuth, apiRoutes);

module.exports = app;
