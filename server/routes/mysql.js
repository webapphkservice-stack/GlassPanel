const express = require('express');
const mysql = require('../services/mysqlService');
const mysqlBackups = require('../services/mysqlBackupService');
const nginx = require('../services/nginxService');
const store = require('../models/store');

const router = express.Router();

function clientError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

router.get('/status', async (req, res, next) => {
  try {
    // 面板只在建站时创建数据库，库名/用户名由站点主域名派生（abc.com → abc_com）。
    // 这里按站点集合过滤，只展示与站点对应的库，隐藏系统库与手工建的库；
    // 面板内「新增」创建的库会登记到 mysql_databases，一并放行
    const sites = await nginx.listSites();
    const credentials = new Map(store.listDatabaseCredentials().map((row) => [row.name, row]));
    const users = new Map();
    for (const row of credentials.values()) users.set(row.name, row.username || row.name);
    // 库名 → 归属站点：删除前提示该库正被哪个站点使用
    const siteByDb = new Map();
    for (const site of sites) {
      const primary = String(site.serverName || '').split(/\s+/)[0] || site.name;
      [primary, site.name].forEach((v) => {
        const name = mysql.normalizeName(v);
        if (!name) return;
        if (!users.has(name)) users.set(name, name);
        if (!siteByDb.has(name)) siteByDb.set(name, site.serverName || site.name);
      });
    }

    const [status, info, databases] = await Promise.all([
      mysql.getStatus(),
      mysql.getInfo(),
      mysql.listDatabases(),
    ]);
    res.json({
      status,
      info,
      databases: databases
        .filter((name) => users.has(name))
        .map((name) => {
          const row = credentials.get(name);
          return {
            name,
            user: users.get(name),
            // 建站时创建的库密码只在开通流程展示过一次，未记录时返回空串，由前端提示「未记录」
            password: row?.password || '',
            updatedAt: row?.updatedAt || '',
            // 非空表示该库由建站流程创建，删除会导致站点连不上库
            site: siteByDb.get(name) || '',
          };
        }),
    });
  } catch (err) {
    next(err);
  }
});

// 新增数据库：库名与用户名由主域名派生（与建站时的逻辑一致），密码自动生成且只在响应中返回一次
router.post('/databases', async (req, res, next) => {
  try {
    const domain = String(req.body?.domain || '').trim();
    if (!domain) throw clientError('请填写域名');
    const dbName = mysql.normalizeName(domain);
    if (!dbName) throw clientError('无法从该域名推导出合法的数据库名称');

    if (await mysql.databaseExists(dbName)) {
      throw clientError(`数据库 ${dbName} 已存在`, 409);
    }

    const password = mysql.generatePassword();
    const created = await mysql.createDatabase({ dbName, user: dbName, password });
    // 登记后才能出现在数据库列表中（该库没有对应站点），同时保存密码供列表展示
    store.saveDatabaseCredential(created.dbName, created.user, created.password);
    store.addLog(req.user.username, 'mysql_database_create', dbName);
    res.json({ success: true, ...created });
  } catch (err) {
    next(err);
  }
});

// 重置数据库用户密码：存量库密码未记录（MySQL 内仅有哈希），重置后写入凭据表并在列表中展示
router.post('/databases/:name/password', async (req, res, next) => {
  try {
    const name = String(req.params.name || '').trim();
    if (!(await mysql.databaseExists(name))) throw clientError('数据库不存在', 404);

    const existing = store.listDatabaseCredentials().find((row) => row.name === name);
    const result = await mysql.resetDatabasePassword({
      dbName: name,
      user: existing?.username || name,
      password: mysql.generatePassword(),
    });
    store.saveDatabaseCredential(result.dbName, result.user, result.password);
    store.addLog(req.user.username, 'mysql_database_reset_password', result.dbName);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// 删除数据库：连同同名用户一起删除（与站点删除时的清理语义一致），凭据记录一并清除
router.delete('/databases/:name', async (req, res, next) => {
  try {
    const name = String(req.params.name || '').trim();
    if (!(await mysql.databaseExists(name))) throw clientError('数据库不存在', 404);

    const existing = store.listDatabaseCredentials().find((row) => row.name === name);
    const result = await mysql.dropDatabase({
      dbName: name,
      user: existing?.username || name,
    });
    store.deleteManagedDatabase(name);
    store.addLog(req.user.username, 'mysql_database_delete', result.dbName);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// —— 数据库备份：mysqldump 导出为 .sql，恢复时导入同名库（同名表会被覆盖） ——

router.get('/databases/:name/backups', async (req, res, next) => {
  try {
    const result = await mysqlBackups.listBackups(req.params.name);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/databases/:name/backups', async (req, res, next) => {
  try {
    const result = await mysqlBackups.createBackup(req.params.name, {
      schemaOnly: Boolean(req.body?.schemaOnly),
    });
    store.addLog(req.user.username, 'mysql_database_backup_create', `${req.params.name}:${result.file}`);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.get('/databases/:name/backups/download', async (req, res, next) => {
  try {
    const { absPath, filename } = await mysqlBackups.resolveForDownload(
      req.params.name,
      String(req.query.file || '')
    );
    store.addLog(req.user.username, 'mysql_database_backup_download', `${req.params.name}:${filename}`);
    res.download(absPath, filename);
  } catch (err) {
    next(err);
  }
});

// 恢复会覆盖库内同名表，前端已做二次确认
router.post('/databases/:name/backups/restore', async (req, res, next) => {
  try {
    const result = await mysqlBackups.restoreBackup(req.params.name, String(req.body?.file || ''));
    store.addLog(req.user.username, 'mysql_database_backup_restore', `${req.params.name}:${result.file}`);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.delete('/databases/:name/backups', async (req, res, next) => {
  try {
    const result = await mysqlBackups.deleteBackup(req.params.name, String(req.query.file || ''));
    store.addLog(req.user.username, 'mysql_database_backup_delete', `${req.params.name}:${result.file}`);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.post('/control/:action', async (req, res, next) => {
  try {
    const { action } = req.params;
    const result = await mysql.control(action);
    store.addLog(req.user.username, `mysql_${action}`, '');
    res.json({ success: result.exitCode === 0, output: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;