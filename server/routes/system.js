const express = require('express');
const { getSystemInfo, getCpuUsage, getNetworkStats, restartPanel } = require('../services/systemService');
const { run } = require('../services/commandRunner');
const logger = require('../utils/logger');
const store = require('../models/store');

const router = express.Router();

router.get('/info', async (req, res, next) => {
  try {
    const info = await getSystemInfo();
    const [cpu, network] = await Promise.all([getCpuUsage(), getNetworkStats()]);
    res.json({ ...info, cpu, network });
  } catch (err) {
    next(err);
  }
});

router.get('/services', async (req, res, next) => {
  // 展示名 → 真实 systemd 单元名（MySQL 单元是 mysqld，Supervisor 是 supervisord）
  const services = [
    { name: 'nginx', unit: 'nginx' },
    { name: 'mysql', unit: 'mysqld' },
    { name: 'redis', unit: 'redis' },
    { name: 'supervisor', unit: 'supervisord' },
  ];
  try {
    const statuses = await Promise.all(
      services.map(async ({ name, unit }) => {
        const result = await run('systemctl', ['is-active', unit]);
        return { name, status: result.exitCode === 0 ? result.stdout.trim() : 'inactive' };
      })
    );
    res.json({ services: statuses });
  } catch (err) {
    logger.error('Get services status failed', { error: err.message });
    res.json({ services: services.map(({ name }) => ({ name, status: 'unknown' })) });
  }
});

// 面板设置：当前仅面板名称，未设置时由前端回退到默认品牌名
router.get('/settings', (req, res, next) => {
  try {
    res.json({ settings: store.getSettings() });
  } catch (err) {
    next(err);
  }
});

router.post('/settings', (req, res, next) => {
  try {
    const raw = req.body?.panelName;
    if (raw !== undefined) {
      const panelName = String(raw).trim();
      // 控制字符会破坏页面标题与日志，长度上限避免侧边栏溢出
      if (/[\u0000-\u001f\u007f]/.test(panelName)) {
        return res.status(400).json({ error: '面板名称不能包含换行或控制字符' });
      }
      if (panelName.length > 32) {
        return res.status(400).json({ error: '面板名称最多 32 个字符' });
      }
      store.setSetting('panelName', panelName);
      store.addLog(req.user.username, 'system_settings_update', `panelName=${panelName}`);
    }
    res.json({ success: true, settings: store.getSettings() });
  } catch (err) {
    next(err);
  }
});

router.post('/restart', async (req, res, next) => {
  try {
    store.addLog(req.user.username, 'system_restart', '');
    const result = await restartPanel();
    if (result.exitCode === 0) {
      res.json({ success: true, message: '面板服务正在重启，连接将在几秒后中断。' });
    } else {
      res.status(500).json({ error: `重启失败：${result.stderr || result.stdout}` });
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
