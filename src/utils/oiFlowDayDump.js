const fs = require('fs');
const path = require('path');

/** Daily OI Flow minute dumps — keep tape JSON here, not mixed with research reports. */
const OI_FLOW_DUMP_DIR = path.join(__dirname, '../../data/oi-flow');

function oiFlowDayDumpPath(dateKey) {
  return path.join(OI_FLOW_DUMP_DIR, `oi-flow-${dateKey}.json`);
}

function ensureOiFlowDumpDir() {
  fs.mkdirSync(OI_FLOW_DUMP_DIR, { recursive: true });
  return OI_FLOW_DUMP_DIR;
}

function readOiFlowDayDump(dateKey) {
  const file = oiFlowDayDumpPath(dateKey);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.rows || [];
  return {
    file: `data/oi-flow/oi-flow-${dateKey}.json`,
    rows: list,
  };
}

module.exports = {
  OI_FLOW_DUMP_DIR,
  oiFlowDayDumpPath,
  ensureOiFlowDumpDir,
  readOiFlowDayDump,
};
