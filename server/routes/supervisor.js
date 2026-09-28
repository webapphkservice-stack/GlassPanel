const express = require('express');
const supervisor = require('../services/supervisorService');
const store = require('../models/store');

const router = express.Router();

router.get('/status', async (req, res, next) => {
  try {
    const status = await supervisor.getStatus();
    res.json({ status });
  } catch (err) {
    next(err);
  }
});

router.get('/processes', async (req, res, next) => {
  try {
    const processes = await supervisor.listProcesses();
    res.json(processes);
  } catch (err) {
    next(err);
  }
});

router.post('/control/:type/:action', async (req, res, next) => {
  try {
    const { type, action } = req.params;
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: '缺少 name 参数' });
    let result;
    if (type === 'supervisor') {
      result = await supervisor.controlSupervisor(action, name);
    } else if (type === 'pm2') {
      result = await supervisor.controlPm2(action, name);
    } else {
      return res.status(400).json({ error: '非法类型' });
    }
    store.addLog(req.user.username, `supervisor_${type}_${action}`, name);
    res.json({ success: result.exitCode === 0, output: result });
  } catch (err) {
    next(err);
  }
});

router.post('/program', async (req, res, next) => {
  try {
    const payload = req.body || {};
    const result = await supervisor.addProgram(payload);
    store.addLog(req.user.username, 'supervisor_add_program', payload.name);
    res.json({ success: true, output: result });
  } catch (err) {
    next(err);
  }
});

router.delete('/program/:name', async (req, res, next) => {
  try {
    const { name } = req.params;
    const result = await supervisor.removeProgram(name);
    store.addLog(req.user.username, 'supervisor_remove_program', name);
    res.json({ success: true, output: result });
  } catch (err) {
    next(err);
  }
});

router.post('/pm2', async (req, res, next) => {
  try {
    const payload = req.body || {};
    const result = await supervisor.addPm2Process(payload);
    store.addLog(req.user.username, 'pm2_add_process', payload.name);
    res.json({ success: result.exitCode === 0, output: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
