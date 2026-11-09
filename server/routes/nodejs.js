const express = require('express');
const nodejs = require('../services/nodejsService');
const store = require('../models/store');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    res.json(await nodejs.listVersions());
  } catch (err) {
    next(err);
  }
});

router.post('/current', async (req, res, next) => {
  try {
    const version = String(req.body?.version || '');
    const data = await nodejs.setCurrent(version);
    store.addLog(req.user.username, 'nodejs_switch_current', version);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.delete('/versions/:version', async (req, res, next) => {
  try {
    const version = String(req.params.version || '');
    const data = await nodejs.removeVersion(version);
    store.addLog(req.user.username, 'nodejs_remove_version', version);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
