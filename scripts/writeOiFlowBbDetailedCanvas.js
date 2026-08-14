const fs = require('fs');
const path = require('path');
const data = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', 'data', 'OI-Flow-BB-vs-4TF-Detailed-12-14-Aug-2026.json'),
    'utf8',
  ),
);

function fmtSpot(n) {
  if (!Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function tableRows(hits) {
  return hits
    .map((h) => {
      const cells = [
        h.time,
        fmtSpot(h.spot),
        h.bbZone,
        fmtSpot(h.bbLower),
        fmtSpot(h.bbUpper),
        String(h.pctB),
        h.tf15,
        h.tf5,
        h.tf3,
        h.tf1,
        h.tfPack,
        h.candle,
        h.callOiL,
        h.putOiL,
        h.oiDecision,
        h.stackedRule,
        h.note,
      ];
      return `          ${JSON.stringify(cells)},`;
    })
    .join('\n');
}

const parts = data.days
  .map((d) => {
    const top = d.hits.filter((h) => h.bbZone === 'TOP').length;
    const bot = d.hits.filter((h) => h.bbZone === 'BOTTOM').length;
    const t4b = d.hits.filter((h) => h.bbZone === 'TOP' && h.tfPack === '4Bull').length;
    const t4e = d.hits.filter((h) => h.bbZone === 'TOP' && h.tfPack === '4Bear').length;
    const tM = d.hits.filter((h) => h.bbZone === 'TOP' && h.tfPack === 'Mixed').length;
    const b4b = d.hits.filter((h) => h.bbZone === 'BOTTOM' && h.tfPack === '4Bull').length;
    const b4e = d.hits.filter((h) => h.bbZone === 'BOTTOM' && h.tfPack === '4Bear').length;
    const bM = d.hits.filter((h) => h.bbZone === 'BOTTOM' && h.tfPack === 'Mixed').length;
    return `
      <H2>${d.dateKey} · ${d.first}–${d.last} · ${d.hits.length} BB hits</H2>
      <Text tone="secondary">
        Tape ${d.bars} bars · BB-ready ${d.ready} · mid-band ${d.mid}
      </Text>
      <Table
        striped
        headers={["Zone", "Times", "4 Bull", "4 Bear", "Mixed", "Stacked YES"]}
        columnAlign={["left", "right", "right", "right", "right", "right"]}
        rows={[
          ["Top", "${top}", "${t4b}", "${t4e}", "${tM}", "0"],
          ["Bottom", "${bot}", "${b4b}", "${b4e}", "${bM}", "0"],
        ]}
      />
      <H3>Minute log (walk-forward, no future)</H3>
      <Table
        striped
        stickyHeader
        headers={["Time", "Spot", "BB", "Lower", "Upper", "%B", "15M", "5M", "3M", "1M", "TF pack", "Candle", "Call ΔOI", "Put ΔOI", "OI only", "Stacked", "Note"]}
        rows={[
${tableRows(d.hits)}
        ]}
      />`;
  })
  .join('\n');

const v = data.verdict;
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

export default function OiFlowBbVs4TfDetailedReport() {
  return (
    <Stack gap={24}>
      <Stack gap={6}>
        <H1>OI Flow × BB — detailed report</H1>
        <Text tone="secondary">
          12–14 Aug 2026 · BB 20 SMA ± 2σ · at band = touch / outside / within 5 pts
          · each bar T uses only minutes ≤ T (no future OI, candle, TF, or BB).
        </Text>
      </Stack>

      <Callout tone="warning">
        Stacked rule (4 Bull at BB bottom for CE, 4 Bear at BB top for PE) never
        met: 0 / ${v.bbWithoutRule} BB top+bottom minutes.
      </Callout>

      <Grid columns={4} gap={16}>
        <Stat value="0" label="Stacked rule met" tone="warning" />
        <Stat value="${v.bbWithoutRule}" label="BB hits without stacked rule" />
        <Stat value="${v.top4bull}" label="4 Bull at BB top (opposite)" />
        <Stat value="${v.bot4bear}" label="4 Bear at BB bottom (opposite)" />
      </Grid>

      <H2>All 3 days</H2>
      <Table
        striped
        headers={["BB zone", "Times", "4 Bull", "4 Bear", "Mixed", "Stacked rule"]}
        columnAlign={["left", "right", "right", "right", "right", "left"]}
        rows={[
          ["Top", "${v.top}", "${v.top4bull}", "${v.top4bear}", "${v.topMix}", "4 Bear @ top = 0"],
          ["Bottom", "${v.bot}", "${v.bot4bull}", "${v.bot4bear}", "${v.botMix}", "4 Bull @ bottom = 0"],
          ["Total", "${v.top + v.bot}", "${v.top4bull + v.bot4bull}", "${v.top4bear + v.bot4bear}", "${v.topMix + v.botMix}", "Met = 0"],
        ]}
        rowTone={[undefined, undefined, "warning"]}
      />
      <Text>
        4 Bull lines up with BB top. 4 Bear lines up with BB bottom. Columns
        OI only = Put ΔOI + candle on that bar (no 4TF/BB). Stacked = 4TF + BB
        extra rule.
      </Text>
      <Divider />
${parts}
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
  'oi-flow-bb-vs-4tf-detailed-report.canvas.tsx',
);
fs.writeFileSync(out, tsx);
console.log('Wrote', out, tsx.length);
