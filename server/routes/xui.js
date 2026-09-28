const express = require('express');
const { run } = require('../services/commandRunner');
const appService = require('../services/appService');

const router = express.Router();

// 获取 3x-ui 状态：端口、版本、服务运行状态
router.get('/status', async (req, res, next) => {
  try {
    // 复用 appService 中的端口读取逻辑
    const port = appService.readXuiPort || (() => {
      const fs = require('fs');
      try {
        const env = fs.readFileSync('/etc/x-ui/install-result.env', 'utf8');
        const m = env.match(/^XUI_PANEL_PORT=(\S+)/m);
        if (m) return m[1].trim();
      } catch (e) { /* ignore */ }
      try {
        const p = fs.readFileSync('/opt/glass-panel/data/3xui-port', 'utf8').trim();
        if (p) return p;
      } catch (e) { /* ignore */ }
      return '2255';
    })();
    const portStr = typeof port === 'function' ? port() : String(port);

    // 版本（从标记文件读取）
    let version = '';
    const fs = require('fs');
    try {
      version = fs.readFileSync('/opt/glass-panel/data/3xui-version', 'utf8').trim();
    } catch (e) { /* ignore */ }

    // 服务状态
    let status = 'inactive';
    try {
      const result = await run('systemctl', ['is-active', 'x-ui']);
      status = result.exitCode === 0 ? result.stdout.trim() : 'inactive';
    } catch (e) { /* ignore */ }

    // 安装状态
    const installed = !!version || (() => {
      try { require('fs').accessSync('/usr/local/x-ui/x-ui'); return true; } catch (e) { return false; }
    })();

    res.json({ port: portStr, version, status, installed });
  } catch (err) {
    next(err);
  }
});

module.exports = router;