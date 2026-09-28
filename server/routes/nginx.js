const express = require('express');
const nginx = require('../services/nginxService');
const siteFiles = require('../services/siteFileService');
const provision = require('../services/provisionTracker');
const siteTraffic = require('../services/siteTrafficService');
const siteBackups = require('../services/siteBackupService');
const fail2ban = require('../services/fail2banService');
const store = require('../models/store');
const logger = require('../utils/logger');

const router = express.Router();

// 开通进度标识：由前端生成并随创建请求带上来，需满足足够长度避免被猜测
const OP_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

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
  const { opId, ...payload } = req.body || {};
  // 带合法 opId 时启用开通进度跟踪，前端可轮询对应只读接口实时展示步骤
  const track = typeof opId === 'string' && OP_ID_RE.test(opId);
  let started = false;
  try {
    const options = {};
    if (track) {
      options.reporter = provision.begin(opId, {
        steps: nginx.PROVISION_STEPS,
        user: req.user?.username,
        name: payload.name,
        domain: payload.serverName,
      });
      started = true;
    }
    const result = await nginx.createSite(payload, options);
    if (started) provision.finish(opId, result, result.warnings);
    store.addLog(req.user.username, 'nginx_site_create', result.file);
    res.json({ success: true, output: result });
  } catch (err) {
    // createSite 内部已上报失败；这里只作兜底，避免进度停留在「进行中」
    if (started) provision.fail(opId, err.message);
    logger.error('Nginx create site failed', { error: err.message });
    next(err);
  }
});

// 开通进度查询：创建期间前端每秒轮询，只读且仅能读取自己发起的流程
router.get('/sites/provision/:opId', (req, res, next) => {
  try {
    const snapshot = provision.get(req.params.opId, req.user?.username);
    if (!snapshot) return res.status(404).json({ error: '开通进度不存在或已过期' });
    res.json({ provision: snapshot });
  } catch (err) {
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

// 解压站点内的压缩包（.zip / .tar / .tar.gz / .tar.bz2 / .tar.xz）
// dest 省略时解压到压缩包同目录下的同名文件夹；解压耗时可能较长，超时与上传保持一致
router.post('/sites/:name/files/extract', async (req, res, next) => {
  try {
    const result = await siteFiles.extractArchive(
      req.params.name,
      String(req.body?.path || ''),
      String(req.body?.dest || '')
    );
    store.addLog(
      req.user.username,
      'nginx_site_file_extract',
      `${req.params.name}:/${result.archive} -> /${result.path}`
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// —— 站点流量：读取站点独立访问日志，按小时聚合最近 24 小时 ——

router.get('/sites/:name/traffic', async (req, res, next) => {
  try {
    const result = await siteTraffic.getTraffic(req.params.name, req.query.hours);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// 存量站点启用独立访问日志（会写入站点配置并重载 Nginx），新建站点已自动写入
router.post('/sites/:name/traffic/log', async (req, res, next) => {
  try {
    const result = await nginx.enableSiteLog(req.params.name);
    store.addLog(req.user.username, 'nginx_site_enable_log', result.file);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('Nginx enable site log failed', { error: err.message });
    next(err);
  }
});

// —— 站点备份：网站目录 + 站点配置文件（恢复前会校验包内路径） ——

router.get('/sites/:name/backups', async (req, res, next) => {
  try {
    const result = await siteBackups.listBackups(req.params.name);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/sites/:name/backups', async (req, res, next) => {
  try {
    const result = await siteBackups.createBackup(req.params.name);
    store.addLog(req.user.username, 'nginx_site_backup_create', `${req.params.name}:${result.file}`);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.get('/sites/:name/backups/download', async (req, res, next) => {
  try {
    const { absPath, filename } = await siteBackups.resolveForDownload(
      req.params.name,
      String(req.query.file || '')
    );
    store.addLog(req.user.username, 'nginx_site_backup_download', `${req.params.name}:${filename}`);
    res.download(absPath, filename);
  } catch (err) {
    next(err);
  }
});

// 恢复会覆盖网站目录与站点配置，前端已做二次确认，这里再校验包内条目与配置语法
router.post('/sites/:name/backups/restore', async (req, res, next) => {
  try {
    const result = await siteBackups.restoreBackup(req.params.name, String(req.body?.file || ''));
    store.addLog(req.user.username, 'nginx_site_backup_restore', `${req.params.name}:${result.file}`);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.delete('/sites/:name/backups', async (req, res, next) => {
  try {
    const result = await siteBackups.deleteBackup(req.params.name, String(req.query.file || ''));
    store.addLog(req.user.username, 'nginx_site_backup_delete', `${req.params.name}:${result.file}`);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// 停止站点：配置移出 Nginx 加载范围并重载，站点立即下线（配置文件保留，可随时重启）
router.post('/sites/:name/stop', async (req, res, next) => {
  try {
    const result = await nginx.stopSite(req.params.name);
    store.addLog(req.user.username, 'nginx_site_stop', result.file);
    res.json({ success: true, output: result });
  } catch (err) {
    logger.error('Nginx stop site failed', { error: err.message });
    next(err);
  }
});

// 重启站点：已停止的恢复配置后重载；在线站点重载配置使其立即生效
router.post('/sites/:name/restart', async (req, res, next) => {
  try {
    const result = await nginx.restartSite(req.params.name);
    store.addLog(req.user.username, 'nginx_site_restart', result.file);
    res.json({ success: true, output: result });
  } catch (err) {
    logger.error('Nginx restart site failed', { error: err.message });
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
