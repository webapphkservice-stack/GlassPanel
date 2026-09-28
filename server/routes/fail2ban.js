const express = require('express');
const fail2ban = require('../services/fail2banService');
const store = require('../models/store');

const router = express.Router();

function sendError(res, err) {
  const code = err.statusCode || 500;
  if (code >= 500) return null;
  res.status(code).json({ error: err.message });
  return true;
}

router.get('/status', async (req, res, next) => {
  try {
    res.json(await fail2ban.getStatus());
  } catch (err) {
    next(err);
  }
});

router.post('/control/:action', async (req, res, next) => {
  try {
    const { action } = req.params;
    const result = await fail2ban.control(action);
    store.addLog(req.user.username, `fail2ban_${action}`, 'fail2ban');
    res.json(result);
  } catch (err) {
    if (sendError(res, err)) return;
    next(err);
  }
});

// 手动解封某个 jail 中的 IP
router.post('/unban', async (req, res, next) => {
  try {
    const { jail, ip } = req.body || {};
    if (!jail || !ip) return res.status(400).json({ error: '缺少 jail 或 ip 参数' });
    const result = await fail2ban.unbanFromJail(jail, ip);
    store.addLog(req.user.username, 'fail2ban_unban', `${jail}:${ip}`);
    res.json({ success: true, ...result });
  } catch (err) {
    if (sendError(res, err)) return;
    next(err);
  }
});

// ---- 服务保护 ----

router.get('/services', async (req, res, next) => {
  try {
    res.json(await fail2ban.listServices());
  } catch (err) {
    next(err);
  }
});

router.post('/services', async (req, res, next) => {
  try {
    const { services } = req.body || {};
    if (!services || typeof services !== 'object') {
      return res.status(400).json({ error: '缺少 services 参数' });
    }
    const result = await fail2ban.setServices(services);
    store.addLog(req.user.username, 'fail2ban_services', JSON.stringify(services));
    res.json({ success: true, ...result });
  } catch (err) {
    if (sendError(res, err)) return;
    next(err);
  }
});

// ---- 站点保护 ----

router.get('/sites', async (req, res, next) => {
  try {
    res.json(await fail2ban.listSites());
  } catch (err) {
    next(err);
  }
});

router.post('/sites', async (req, res, next) => {
  try {
    const { site, enabled, filters } = req.body || {};
    if (!site) return res.status(400).json({ error: '缺少 site 参数' });
    const result = await fail2ban.setSiteProtection(site, { enabled, filters });
    store.addLog(req.user.username, 'fail2ban_site', `${site}:${enabled ? 'on' : 'off'}`);
    res.json({ success: true, ...result });
  } catch (err) {
    if (sendError(res, err)) return;
    next(err);
  }
});

// ---- IP 白名单 ----

router.get('/whitelist', async (req, res, next) => {
  try {
    res.json(await fail2ban.listWhitelist());
  } catch (err) {
    next(err);
  }
});

router.post('/whitelist/add', async (req, res, next) => {
  try {
    const { ip, note } = req.body || {};
    if (!ip) return res.status(400).json({ error: '缺少 ip 参数' });
    const result = await fail2ban.addWhitelist(ip, note);
    store.addLog(req.user.username, 'fail2ban_whitelist_add', ip);
    res.json({ success: true, ...result });
  } catch (err) {
    if (sendError(res, err)) return;
    next(err);
  }
});

router.post('/whitelist/remove', async (req, res, next) => {
  try {
    const { ip } = req.body || {};
    if (!ip) return res.status(400).json({ error: '缺少 ip 参数' });
    const result = await fail2ban.removeWhitelist(ip);
    store.addLog(req.user.username, 'fail2ban_whitelist_remove', ip);
    res.json({ success: true, ...result });
  } catch (err) {
    if (sendError(res, err)) return;
    next(err);
  }
});

router.post('/whitelist/refresh', async (req, res, next) => {
  try {
    const result = await fail2ban.refreshAutoIps();
    store.addLog(req.user.username, 'fail2ban_whitelist_refresh', (result.autoIps || []).join(','));
    res.json({ success: true, ...result });
  } catch (err) {
    if (sendError(res, err)) return;
    next(err);
  }
});

// ---- IP 黑名单 ----

router.get('/blacklist', async (req, res, next) => {
  try {
    res.json(await fail2ban.listBlacklist());
  } catch (err) {
    next(err);
  }
});

router.post('/blacklist/add', async (req, res, next) => {
  try {
    const { ip, note } = req.body || {};
    if (!ip) return res.status(400).json({ error: '缺少 ip 参数' });
    const result = await fail2ban.addBlacklist(ip, note);
    store.addLog(req.user.username, 'fail2ban_blacklist_add', ip);
    res.json({ success: true, ...result });
  } catch (err) {
    if (sendError(res, err)) return;
    next(err);
  }
});

router.post('/blacklist/remove', async (req, res, next) => {
  try {
    const { ip } = req.body || {};
    if (!ip) return res.status(400).json({ error: '缺少 ip 参数' });
    const result = await fail2ban.removeBlacklist(ip);
    store.addLog(req.user.username, 'fail2ban_blacklist_remove', ip);
    res.json({ success: true, ...result });
  } catch (err) {
    if (sendError(res, err)) return;
    next(err);
  }
});

module.exports = router;