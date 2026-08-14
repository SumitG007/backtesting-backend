const fs = require('fs');
const path = require('path');
const days = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'oi-flow-bb-touch-report-2026-08-12-14.json'), 'utf8'),
);

function fmtSpot(n) {
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function jsxEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function tableRows(hits) {
  return hits
    .map((h) => {
      const zone = h.zone === 'upper' ? 'TOP' : 'BOTTOM';
      const tone =
        h.zone === 'lower' && h.bucket === '4Bull'
          ? 'success'
          : h.zone === 'upper' && h.bucket === '4Bear'
            ? 'success'
            : 'neutral';
      return `          [${JSON.stringify(h.time)}, ${JSON.stringify(fmtSpot(h.spot))}, ${JSON.stringify(zone)}, ${JSON.stringify(h.tf)}, ${JSON.stringify(h.bucket)}, "No"],`;
    })
    .join('\n');
}

function dayTone(hits) {
  return hits.map(() => '"neutral"').join(', ');
}

const parts = [];
for (const d of days) {
  const u = d.counts.upper;
  const l = d.counts.lower;
  parts.push(`
      <H2>${d.dateKey} · ${d.first}–${d.last}</H2>
      <Table
        striped
        headers={["Zone", "Times", "4 Bull", "4 Bear", "Mixed", "Stacked rule"]}
        columnAlign={["left", "right", "right", "right", "right", "left"]}
        rows={[
          ["Top", "${u['4Bull'] + u['4Bear'] + u.Mixed}", "${u['4Bull']}", "${u['4Bear']}", "${u.Mixed}", "4 Bear @ top = 0"],
          ["Bottom", "${l['4Bull'] + l['4Bear'] + l.Mixed}", "${l['4Bull']}", "${l['4Bear']}", "${l.Mixed}", "4 Bull @ bottom = 0"],
        ]}
      />
      <H3>Every BB top/bottom minute</H3>
      <Table
        striped
        stickyHeader
        headers={["Time", "Spot", "BB", "15M/5M/3M/1M", "TF pack", "Stacked rule"]}
        rows={[
${tableRows(d.hits)}
        ]}
      />`);
}

const tsx = `import {
  Callout,
  Divider,
  Grid,
  H1,
  H2,
  H3,
  Stack,
  Stat,
  Table,
  Text,
} from "cursor/canvas";

export default function OiFlowBbVs4TfBossReport() {
  return (
    <Stack gap={24}>
      <Stack gap={6}>
        <H1>OI Flow × BB(20,2) — stacked rule check</H1>
        <Text tone="secondary">
          12–14 Aug 2026 NIFTY 1-minute OI JSON. BB 20 SMA ± 2σ. At band = touch /
          outside / within 5 pts. Each bar T uses only minutes ≤ T (no future OI,
          candle, TF, or BB).
        </Text>
      </Stack>

      <Callout tone="warning">
        Stacked rule never met. CALL = 4 Bull at BB bottom, PUT = 4 Bear at BB
        top: 0 times in 3 days. BB still printed 405 top+bottom minutes — all
        without that rule.
      </Callout>

      <Grid columns={4} gap={16}>
        <Stat value="0" label="Stacked rule met" tone="warning" />
        <Stat value="405" label="BB top+bottom without rule" />
        <Stat value="103" label="4 Bull at BB top (opposite)" />
        <Stat value="114" label="4 Bear at BB bottom (opposite)" />
      </Grid>

      <H2>All 3 days</H2>
      <Table
        striped
        headers={["BB zone", "Times", "4 Bull", "4 Bear", "Mixed", "Stacked rule"]}
        columnAlign={["left", "right", "right", "right", "right", "left"]}
        rows={[
          ["Top", "184", "103", "0", "81", "4 Bear @ top = 0"],
          ["Bottom", "221", "0", "114", "107", "4 Bull @ bottom = 0"],
          ["Total", "405", "103", "114", "188", "Met = 0"],
        ]}
        rowTone={[undefined, undefined, "warning"]}
      />
      <Text>
        4 Bull lines up with the top of the band. 4 Bear lines up with the
        bottom. That is the opposite of buy CE at lower / PE at upper.
      </Text>
      <Divider />
${parts.join('\n')}
    </Stack>
  );
}
`;

const out = path.join(
  process.env.USERPROFILE || '',
  '.cursor',
  'projects',
  'd-SaklaniSaab-Expinator-ID-backtesting-frontend',
  'canvases',
  'oi-flow-bb-vs-4tf-boss-report.canvas.tsx',
);
fs.writeFileSync(out, tsx);
console.log('Wrote', out, 'bytes', tsx.length);
