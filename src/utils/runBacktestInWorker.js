const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_SCRIPT = path.join(__dirname, '../workers/runBacktestWorker.js');
const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;

/**
 * @param {string} strategyKey
 * @param {Record<string, unknown>} payload
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ trades: unknown[], summary: unknown }>}
 */
function runBacktestInWorker(strategyKey, payload, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    let worker;
    const timer = setTimeout(() => {
      if (worker) worker.terminate().catch(() => {});
      finish(reject, new Error(`Backtest timed out after ${Math.round(timeoutMs / 60000)} minutes`));
    }, timeoutMs);

    worker = new Worker(WORKER_SCRIPT, {
      workerData: { strategyKey, payload },
    });

    worker.on('message', (msg) => {
      if (msg?.ok) finish(resolve, msg.result);
      else finish(reject, new Error(msg?.error || 'Backtest worker failed'));
    });
    worker.on('error', (err) => {
      finish(reject, err);
    });
    worker.on('exit', (code) => {
      if (!settled) {
        finish(
          reject,
          new Error(
            code === 0
              ? 'Backtest worker stopped without returning results'
              : `Backtest worker exited with code ${code}`,
          ),
        );
      }
    });
  });
}

module.exports = {
  runBacktestInWorker,
};
