const express = require('express');
const cleanup = require('../services/cleanupService');
const store = require('../models/store');

const router = express.Router();

// 扫描四项可清理的体积与条目数：只读，供前端预览后再决定执行哪些
router.get('/scan', async (req, res, next) => {
  try {
    res.json(await cleanup.scan());
  } catch (err) {
    next(err);
  }
});

// 执行清理：只处理请求中列出的项，返回各项实际释放的体积与失败明细
router.post('/run', async (req, res, next) => {
  try {
    const keys = Array.isArray(req.body?.keys) ? req.body.keys : [];
    const result = await cleanup.clean(keys);
    store.addLog(req.user.username, 'system_cleanup', keys.join(','));
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;