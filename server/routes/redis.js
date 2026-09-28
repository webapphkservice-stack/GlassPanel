const express = require('express');
const redis = require('../services/redisService');
const store = require('../models/store');

const router = express.Router();

router.get('/status', async (req, res, next) => {
  try {
    const [status, info] = await Promise.all([redis.getStatus(), redis.getInfo()]);
    res.json({ status, info });
  } catch (err) {
    next(err);
  }
});

router.post('/control/:action', async (req, res, next) => {
  try {
    const { action } = req.params;
    const result = await redis.control(action);
    store.addLog(req.user.username, `redis_${action}`, '');
    res.json({ success: result.exitCode === 0, output: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
