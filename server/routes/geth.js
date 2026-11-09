const express = require('express');
const geth = require('../services/gethService');
const store = require('../models/store');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    res.json(await geth.getOverview());
  } catch (err) {
    next(err);
  }
});

router.get('/logs', async (req, res, next) => {
  try {
    res.json({ logs: await geth.getLogs(req.query.lines) });
  } catch (err) {
    next(err);
  }
});

router.post('/control/:action', async (req, res, next) => {
  try {
    const action = String(req.params.action || '');
    const data = await geth.control(action);
    store.addLog(req.user.username, `geth_${action}`, '');
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
