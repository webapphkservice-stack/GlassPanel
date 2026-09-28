const express = require('express');
const php = require('../services/phpService');
const store = require('../models/store');

const router = express.Router();

router.get('/status', async (req, res, next) => {
  try {
    const status = await php.getStatus();
    const versions = await php.listVersions();
    const defaultVersion = await php.getDefaultVersion();
    res.json({ status, versions, defaultVersion });
  } catch (err) {
    next(err);
  }
});

router.post('/control/:action', async (req, res, next) => {
  try {
    const { action } = req.params;
    const { version } = req.body || {};
    const result = await php.control(action, version);
    store.addLog(req.user.username, `php_${action}`, version || 'default');
    res.json({ success: result.exitCode === 0, output: result });
  } catch (err) {
    next(err);
  }
});

// 读取上传限制 / 禁用函数 / 常规配置（三个页签共用）
router.get('/settings', async (req, res, next) => {
  try {
    const data = await php.getSettings(req.query.version);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// 写入配置：仅允许白名单键，写前备份 php.ini，写后自动重载 php-fpm
router.post('/settings', async (req, res, next) => {
  try {
    const { version, settings } = req.body || {};
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: '缺少 settings 参数' });
    }
    const result = await php.updateSettings(version, settings);
    store.addLog(req.user.username, 'php_settings_update', result.changedKeys.join(','));
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// 扩展列表：标记已加载 / 已启用
router.get('/extensions', async (req, res, next) => {
  try {
    const data = await php.getExtensions(req.query.version);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// 安装扩展：编译耗时较长，转后台任务，前端轮询 /php/job/:key
router.post('/extensions/install', async (req, res, next) => {
  try {
    const { version, module } = req.body || {};
    if (!module) return res.status(400).json({ error: '缺少 module 参数' });
    const { job } = await php.installExtension(version, module);
    store.addLog(req.user.username, 'php_ext_install', `${version || 'default'}:${module}`);
    res.json({ success: true, job });
  } catch (err) {
    next(err);
  }
});

router.post('/extensions/uninstall', async (req, res, next) => {
  try {
    const { version, module } = req.body || {};
    if (!module) return res.status(400).json({ error: '缺少 module 参数' });
    const result = await php.uninstallExtension(version, module);
    store.addLog(req.user.username, 'php_ext_uninstall', `${version || 'default'}:${module}`);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.get('/logs', async (req, res, next) => {
  try {
    const { version, type, lines } = req.query;
    const data = await php.getLogs(version, type, lines);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.post('/logs/clear', async (req, res, next) => {
  try {
    const { version, type, keepLines } = req.body || {};
    const result = await php.clearLogs(version, type, keepLines);
    store.addLog(req.user.username, 'php_logs_clear', `${type || 'error'}:${result.path}`);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// 开启/关闭慢日志
router.post('/logs/slowlog', async (req, res, next) => {
  try {
    const { version, enabled, timeout } = req.body || {};
    const result = await php.setSlowlog(version, !!enabled, timeout);
    store.addLog(req.user.username, 'php_slowlog', `${enabled ? 'enable' : 'disable'}:${result.timeout}s`);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// 扩展安装任务进度
router.get('/job/:key', async (req, res, next) => {
  try {
    res.json({ job: php.getJob(req.params.key) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
