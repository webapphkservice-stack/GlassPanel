const express = require('express');
const firewall = require('../services/firewallService');
const store = require('../models/store');

const router = express.Router();

router.get('/status', async (req, res, next) => {
  try {
    const status = await firewall.getStatus();
    res.json(status);
  } catch (err) {
    next(err);
  }
});

router.get('/rules', async (req, res, next) => {
  try {
    const rules = await firewall.listRules();
    res.json(rules);
  } catch (err) {
    next(err);
  }
});

router.post('/rules', async (req, res, next) => {
  try {
    const { port, protocol, action } = req.body || {};
    const result = await firewall.addRule({ port, protocol, action });
    store.addLog(req.user.username, 'firewall_add_rule', `${port}/${protocol || 'tcp'}`);
    res.json({ success: result.exitCode === 0, output: result });
  } catch (err) {
    next(err);
  }
});

router.delete('/rules/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await firewall.removeRule(parseInt(id, 10));
    store.addLog(req.user.username, 'firewall_remove_rule', id);
    res.json({ success: result.exitCode === 0, output: result });
  } catch (err) {
    next(err);
  }
});

router.post('/control/:action', async (req, res, next) => {
  try {
    const { action } = req.params;
    const result = await firewall.control(action);
    store.addLog(req.user.username, `firewall_${action}`, '');
    res.json({ success: result.exitCode === 0, output: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
