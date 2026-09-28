const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const config = require('./config/default');
const authMiddleware = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');

const authRouter = require('./routes/auth');
const systemRouter = require('./routes/system');
const nginxRouter = require('./routes/nginx');
const phpRouter = require('./routes/php');
const mysqlRouter = require('./routes/mysql');
const redisRouter = require('./routes/redis');
const supervisorRouter = require('./routes/supervisor');
const firewallRouter = require('./routes/firewall');
const sslRouter = require('./routes/ssl');
const appsRouter = require('./routes/apps');
const fail2banRouter = require('./routes/fail2ban');

const app = express();

app.use(helmet());
app.use(cors({ origin: config.clientUrl, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// 通用 API 限流：每 IP 15 分钟 300 次
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

// 登录专用限流：分别按 IP 与账号维度限制，防止暴力破解与审计日志膨胀
// - 同一 IP 无论尝试多少账号，累计 N 次即限制
// - 同一账号无论来自多少 IP，累计 N 次即限制
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  // 使用 express-rate-limit 默认的 IP key 生成方式，自动归一化 IPv6 地址
  skipSuccessfulRequests: true,
  message: { error: '当前 IP 登录尝试次数过多，请 15 分钟后再试' },
});

const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.body?.username || '').trim() || req.ip || req.connection.remoteAddress || 'unknown',
  skipSuccessfulRequests: true,
  message: { error: '该账号登录尝试次数过多，请 15 分钟后再试' },
});

// TOTP 验证码专用限流：防止暴力穷举 6 位动态码
const totpIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: '当前 IP 验证码尝试次数过多，请 15 分钟后再试' },
});

const totpAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    try {
      // tempToken 中包含 username，优先按账号维度限速
      const parts = String(req.body?.tempToken || '').split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        if (payload.username) return payload.username;
      }
    } catch (e) {
      // ignore
    }
    return req.ip || req.connection.remoteAddress || 'unknown';
  },
  skipSuccessfulRequests: true,
  message: { error: '该账号验证码尝试次数过多，请 15 分钟后再试' },
});

app.use('/api/', limiter);
app.use('/api/auth/login', loginIpLimiter, loginAccountLimiter);
// TOTP 验证接口限流：仅针对 /api/auth/totp（POST），不匹配 /totp/setup 等子路径
app.post('/api/auth/totp', totpIpLimiter, totpAccountLimiter);

// 静态资源（生产环境前端构建产物）
// index.html 禁止缓存：保证部署后浏览器总是拿到最新的入口文件（带哈希的资源文件仍可正常缓存）
app.use(
  express.static(path.join(__dirname, '../client/dist'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  })
);

// API 路由
app.use('/api/auth', authRouter);
app.use('/api/system', authMiddleware, systemRouter);
app.use('/api/nginx', authMiddleware, nginxRouter);
app.use('/api/php', authMiddleware, phpRouter);
app.use('/api/mysql', authMiddleware, mysqlRouter);
app.use('/api/redis', authMiddleware, redisRouter);
app.use('/api/supervisor', authMiddleware, supervisorRouter);
app.use('/api/firewall', authMiddleware, firewallRouter);
app.use('/api/ssl', authMiddleware, sslRouter);
app.use('/api/apps', authMiddleware, appsRouter);
app.use('/api/fail2ban', authMiddleware, fail2banRouter);

// 前端路由兜底
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});

app.use(errorHandler);

module.exports = app;
