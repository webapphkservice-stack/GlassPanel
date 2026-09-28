const express = require('express');
const mysql = require('../services/mysqlService');
const nginx = require('../services/nginxService');
const store = require('../models/store');

const router = express.Router();

router.get('/status', async (req, res, next) => {
  try {
    // 面板只在建站时创建数据库，库名/用户名由站点主域名派生（abc.com → abc_com）。
    // 这里按站点集合过滤，只展示与站点对应的库，隐藏系统库与手工建的库
    const sites = await nginx.listSites();
    const allowed = new Set();
    for (const site of sites) {
      const primary = String(site.serverName || '').split(/\s+/)[0] || site.name;
      [primary, site.name].forEach((v) => {
        const name = mysql.normalizeName(v);
        if (name) allowed.add(name);
      });
    }

    const [status, info, databases] = await Promise.all([
      mysql.getStatus(),
      mysql.getInfo(),
      mysql.listDatabases(),
    ]);
    res.json({ status, info, databases: databases.filter((d) => allowed.has(d)) });
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
