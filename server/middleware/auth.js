const jwt = require('../utils/jwt');
const store = require('../models/store');

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录或 Token 格式错误' });
  }
  try {
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token);

    // 检查 token 是否被显式吊销（登出）
    if (decoded.jti && store.isTokenBlocklisted(decoded.jti)) {
      return res.status(401).json({ error: 'Token 已失效，请重新登录' });
    }

    // 检查 tokenVersion：用户禁用/重置 TOTP 后，旧令牌立即失效
    const user = store.getUserByUsername(decoded.username);
    if (!user) {
      return res.status(401).json({ error: '用户不存在' });
    }
    if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
      return res.status(401).json({ error: 'Token 版本已过期，请重新登录' });
    }

    req.user = decoded;
    req.tokenJti = decoded.jti;
    req.tokenExp = decoded.exp * 1000;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token 无效或已过期' });
  }
}

module.exports = authMiddleware;
