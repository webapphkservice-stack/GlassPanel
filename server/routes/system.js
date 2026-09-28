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
