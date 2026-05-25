/**
 * Free MongoDB Atlas space when near/over quota.
 * Run: node scripts/freeMongoStorage.js
 * Options (env):
 *   PURGE_OPTION_CHAIN=1 — delete entire optionchainsnapshots collection (if it exists)
 *   PURGE_OLD_RUNS_DAYS=30 — delete strategy runs older than N days (0 = skip)
 */
require('dotenv').config();
const mongoose = require('mongoose');

const PURGE_OPTION_CHAIN = process.env.PURGE_OPTION_CHAIN === '1';
const PURGE_OLD_RUNS_DAYS = Number(process.env.PURGE_OLD_RUNS_DAYS) || 0;

async function collectionStats(db, name) {
  try {
    const s = await db.command({ collStats: name, scale: 1024 * 1024 });
    return {
      name,
      sizeMB: Number((s.size / (1024 * 1024)).toFixed(2)),
      storageMB: Number((s.storageSize / (1024 * 1024)).toFixed(2)),
      count: s.count,
    };
  } catch {
    return { name, sizeMB: null, storageMB: null, count: null };
  }
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI missing in .env');

  await mongoose.connect(uri);
  console.log('Connected to MongoDB\n');

  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();
  console.log('--- Before cleanup (approx MB) ---');
  for (const c of collections) {
    const st = await collectionStats(db, c.name);
    console.log(`  ${st.name}: ${st.count ?? '?'} docs, ~${st.storageMB ?? '?'} MB storage`);
  }

  if (PURGE_OPTION_CHAIN) {
    const name = 'optionchainsnapshots';
    console.log(`\nDeleting ALL documents in ${name}...`);
    const r = await db.collection(name).deleteMany({});
    console.log(`  deleted: ${r.deletedCount}`);
  }

  if (PURGE_OLD_RUNS_DAYS > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - PURGE_OLD_RUNS_DAYS);
    const runs = await db
      .collection('strategyruns')
      .find({ createdAt: { $lt: cutoff } })
      .project({ _id: 1 })
      .toArray();
    const runIds = runs.map((r) => r._id);
    if (runIds.length) {
      const tr = await db.collection('strategytrades').deleteMany({ runId: { $in: runIds } });
      const sr = await db.collection('strategyruns').deleteMany({ _id: { $in: runIds } });
      console.log(`\nDeleted old runs (>${PURGE_OLD_RUNS_DAYS}d): ${sr.deletedCount} runs, ${tr.deletedCount} trades`);
    }
  }

  console.log('\n--- After cleanup ---');
  for (const c of collections) {
    const st = await collectionStats(db, c.name);
    console.log(`  ${st.name}: ${st.count ?? '?'} docs, ~${st.storageMB ?? '?'} MB storage`);
  }

  console.log('\nDone. Restart backend: npm run dev');
  console.log('If Atlas still blocks writes, open MongoDB Atlas → Browse Collections → drop old collections, or upgrade tier.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Cleanup failed:', err.message);
  if (/space quota|over your space/i.test(err.message)) {
    console.error(
      '\nAtlas blocks writes while over quota. Use Atlas UI: Cluster → Browse Collections →',
      'delete/drop large collections (e.g. optionchainsnapshots, old strategyruns), then re-run this script.',
    );
  }
  process.exit(1);
});
