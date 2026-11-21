const express = require('express');
const appService = require('../services/appService');
const store = require('../models/store');

const router = express.Router();

router.get('/apps', async (req, res, next) => {
  try {
    const data = await appService.listApps();
    // 应用中心排序：已安装的按安装时间先后排在前面，未安装的保持默认顺序在后；
    // 「系统更新」不是具体软件，固定放最后
    const originalOrder = new Map(data.apps.map((app, i) => [app.key, i]));
    const rankOf = (app) => {
      if (app.systemUpdate) return 3;
      if (!app.installed) return 2;
      return app.installedAt ? 0 : 1;
    };
    data.apps.sort((a, b) => {
      const ra = rankOf(a);
      const rb = rankOf(b);
      if (ra !== rb) return ra - rb;
      if (ra === 0) return a.installedAt - b.installedAt;
      return originalOrder.get(a.key) - originalOrder.get(b.key);
    });
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

// 忽略当前版本的升级提醒（上游发布更高版本后会重新提醒）
router.post('/ignore-update/:key', async (req, res, next) => {
  try {
    const { version } = req.body || {};
    if (!version) return res.status(400).json({ error: '缺少版本号' });
    appService.ignoreAppUpdate(req.params.key, version);
    store.addLog(req.user.username, `app_ignore_update_${req.params.key}`, String(version));
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// 恢复被忽略的升级提醒
router.post('/resume-update/:key', async (req, res, next) => {
  try {
    appService.resumeAppUpdate(req.params.key);
    store.addLog(req.user.username, `app_resume_update_${req.params.key}`, '');
    res.json({ success: true });
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
