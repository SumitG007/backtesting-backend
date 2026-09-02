const reactionEngine = require('../services/oiWallReactionEngine');

async function getOiWallReactionStatus(_req, res) {
  try {
    const data = await reactionEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiWallReactionBook(_req, res) {
  try {
    const data = await reactionEngine.getBookSummary();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiWallReactionTrades(req, res) {
  try {
    const data = await reactionEngine.listTrades({
      status: req.query?.status,
      page: req.query?.page,
      pageSize: req.query?.pageSize,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function postOiWallReactionEnabled(req, res) {
  try {
    const enabled = Boolean(req.body?.enabled);
    const data = await reactionEngine.setEnabled(enabled);
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function patchOiWallReactionSettings(req, res) {
  try {
    const data = await reactionEngine.updateSettings(req.body || {});
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postOiWallReactionClose(_req, res) {
  try {
    const trade = await reactionEngine.closeOpenTradeManual('MANUAL_CLOSE');
    return res.json({ ok: true, trade });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getOiWallReactionStatus,
  getOiWallReactionBook,
  getOiWallReactionTrades,
  postOiWallReactionEnabled,
  patchOiWallReactionSettings,
  postOiWallReactionClose,
};
