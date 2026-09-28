const express = require('express');
const nginx = require('../services/nginxService');
const siteFiles = require('../services/siteFileService');
const fail2ban = require('../services/fail2banService');
const store = require('../models/store');
const logger = require('../utils/logger');

const router = express.Router();

router.get('/status', async (req, res, next) => {
  try {
    const status = await nginx.getStatus();
    res.json({ status });
  } catch (err) {
    next(err);
  }
});

router.post('/control/:action', async (req, res, next) => {
  try {
    const { action } = req.params;
    const result = await nginx.control(action);
    store.addLog(req.user.username, `nginx_${action}`, result.stderr || result.stdout);
    res.json({ success: result.exitCode === 0, output: result });
  } catch (err) {
    logger.error('Nginx control failed', { error: err.message });
    next(err);
  }
});

router.post('/test', async (req, res, next) => {
  try {
    const result = await nginx.testConfig();
    res.json({ valid: result.exitCode === 0, output: result });
  } catch (err) {
    next(err);
  }
});

router.get('/sites', async (req, res, next) => {
  try {
    const sites = await nginx.listSites();
    res.json({ sites });
  } catch (err) {
    next(err);
  }
});

router.post('/sites', async (req, res, next) => {
  try {
    const result = await nginx.createSite(req.body || {});
    store.addLog(req.user.username, 'nginx_site_create', result.file);
    res.json({ success: true, output: result });
  } catch (err) {
    logger.error('Nginx create site failed', { error: err.message });
    next(err);
  }
});

// 删除前查询站点关联的数据库与证书，供前端确认弹窗展示
router.get('/sites/:name/relations', async (req, res, next) => {
  try {
    const relations = await nginx.getSiteRelations(req.params.name);
    res.json({ relations });
  } catch (err) {
    next(err);
  }
});

// —— 站点文件管理：所有路径由服务端解析到该站点 root 内，前端无法指定任意目录 ——

router.get('/sites/:name/files', async (req, res, next) => {
  try {
    const result = await siteFiles.listDirectory(req.params.name, req.query.dir || '');
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/sites/:name/files/dirs', async (req, res, next) => {
  try {
    const result = await siteFiles.createDirectory(req.params.name, String(req.body?.path || ''));
    store.addLog(req.user.username, 'nginx_site_file_mkdir', `${req.params.name}:/${result.path}`);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// 上传体为原始字节（application/octet-stream），单独放大到 500MB，避免引入 multer
router.post(
  '/sites/:name/files/upload',
  express.raw({ type: () => true, limit: `${Math.floor(siteFiles.MAX_UPLOAD_SIZE / 1024 / 1024)}mb` }),
  async (req, res, next) => {
    try {
      const overwrite = req.query.overwrite !== 'false';
      const result = await siteFiles.saveUpload(
        req.params.name,
        String(req.query.dir || ''),
        String(req.query.name || ''),
        req.body,
        overwrite
      );
      store.addLog(req.user.username, 'nginx_site_file_upload', `${req.params.name}:/${result.path}`);
      res.json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/sites/:name/files/download', async (req, res, next) => {
  try {
    const { absPath, filename } = await siteFiles.resolveForDownload(req.params.name, String(req.query.path || ''));
    store.addLog(req.user.username, 'nginx_site_file_download', `${req.params.name}:/${req.query.path}`);
    res.download(absPath, filename);
  } catch (err) {
    next(err);
  }
});

router.delete('/sites/:name/files', async (req, res, next) => {
  try {
    const result = await siteFiles.removeEntry(req.params.name, String(req.query.path || ''));
    store.addLog(req.user.username, 'nginx_site_file_delete', `${req.params.name}:/${result.path}`);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.delete('/sites/:name', async (req, res, next) => {
  try {
    const result = await nginx.deleteSite(req.params.name);
    // 站点已被保护时同步清掉 Fail2ban 状态，避免残留 jail 指向已删除的日志
    try {
      const forgotten = await fail2ban.forgetSite(req.params.name);
      if (forgotten.removed) result.warnings.push('已同步移除该站点的 Fail2ban 站点保护');
    } catch (err) {
      result.warnings.push(`Fail2ban 站点保护清理失败：${err.message}`);
    }
    store.addLog(req.user.username, 'nginx_site_delete', result.file);
    res.json({ success: true, output: result });
  } catch (err) {
    logger.error('Nginx delete site failed', { error: err.message });
    next(err);
  }
});

router.get('/config', async (req, res, next) => {
  try {
    const { path: filePath } = req.query;
    if (!filePath) return res.status(400).json({ error: '缺少 path 参数' });
    const content = await nginx.readConfig(filePath);
    res.json({ path: filePath, content });
  } catch (err) {
    next(err);
  }
});

router.post('/config', async (req, res, next) => {
  try {
    const { path: filePath, content, reload } = req.body;
    if (!filePath || content === undefined) {
      return res.status(400).json({ error: '缺少 path 或 content' });
    }
    const result = await nginx.writeConfig(filePath, content, reload === true || reload === 'true');
    store.addLog(req.user.username, 'nginx_config_write', filePath);
    res.json({ success: true, reloaded: result.reloaded, output: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
