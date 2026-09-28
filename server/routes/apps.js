const express = require('express');
const appService = require('../services/appService');
const store = require('../models/store');

const router = express.Router();

router.get('/apps', async (req, res, next) => {
  try {
    const data = await appService.listApps();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/versions/:key', async (req, res, next) => {
  try {
    const { key } = req.params;
    const data = await appService.listAppVersions(key);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.post('/install/:key', async (req, res, next) => {
  try {
    const { key } = req.params;
    const { version, config } = req.body || {};
    const job = await appService.startInstall(key, version, config || {});
    store.addLog(req.user.username, `app_install_${key}`, version || 'default');
    res.json({ success: true, job });
  } catch (err) {
    next(err);
  }
});

router.post('/update/:key', async (req, res, next) => {
  try {
    const { key } = req.params;
    const job = await appService.startUpdate(key);
    store.addLog(req.user.username, `app_update_${key}`, job.label);
    res.json({ success: true, job });
  } catch (err) {
    next(err);
  }
});

router.post('/uninstall/:key', async (req, res, next) => {
  try {
    const { key } = req.params;
    const job = await appService.startUninstall(key);
    store.addLog(req.user.username, `app_uninstall_${key}`, job.label);
    res.json({ success: true, job });
  } catch (err) {
    next(err);
  }
});

// 后台任务进度：前端轮询获取实时终端输出与结束状态
router.get('/job/:key', async (req, res, next) => {
  try {
    res.json({ job: appService.getJob(req.params.key) });
  } catch (err) {
    next(err);
  }
});

router.get('/jobs', async (req, res, next) => {
  try {
    res.json({ jobs: appService.getRunningJobs() });
  } catch (err) {
    next(err);
  }
});

// 3x-ui 面板集成：同步缓存包（从 GitHub 下载到本地）
router.post('/sync-xui', async (req, res, next) => {
  try {
    const { version } = req.body || {};
    if (!version) return res.status(400).json({ error: '缺少版本号' });
    const tag = version === 'latest' ? await appService.fetch3xuiLatest() : version;
    if (!tag) return res.status(400).json({ error: '无法获取 3x-ui 最新版本' });
    const result = await appService.sync3xuiPackage(tag);
    store.addLog(req.user.username, 'app_sync_xui', tag);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// 3x-ui 面板集成：一键同步最近 5 个版本（已缓存的跳过，单个失败的记录原因）
router.post('/sync-xui-latest', async (req, res, next) => {
  try {
    const result = await appService.sync3xuiLatest();
    store.addLog(req.user.username, 'app_sync_xui_latest', (result.synced || []).join(','));
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
