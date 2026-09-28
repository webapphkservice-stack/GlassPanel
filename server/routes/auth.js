const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('../utils/jwt');
const store = require('../models/store');
const logger = require('../utils/logger');
const authMiddleware = require('../middleware/auth');
const totpService = require('../services/totpService');

const router = express.Router();

const TOTP_TEMP_TOKEN_EXPIRES_IN = '5m';

// 验证用户名/密码，TOTP 用户返回临时令牌
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }

    const user = store.getUserByUsername(username);
    if (!user) {
      store.addLog(username, 'login_failed', '用户不存在');
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      store.addLog(username, 'login_failed', '密码错误');
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    // 已启用 TOTP 的用户进入第二步
    if (user.totpEnabled) {
      const tempToken = jwt.sign(
        { username: user.username, role: user.role, purpose: 'totp' },
        { expiresIn: TOTP_TEMP_TOKEN_EXPIRES_IN }
      );
      store.addLog(username, 'totp_challenge', '');
      return res.json({ requiresTotp: true, tempToken });
    }

    // 未启用 TOTP，直接签发访问令牌
    const token = jwt.sign({
      username: user.username,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });
    store.addLog(username, 'login_success', '');
    logger.info('User logged in', { username });

    res.json({
      token,
      user: { username: user.username, role: user.role, totpEnabled: false },
    });
  } catch (err) {
    next(err);
  }
});

// TOTP 第二步验证
router.post('/totp', async (req, res, next) => {
  try {
    const { tempToken, code } = req.body || {};
    if (!tempToken || !code) {
      return res.status(400).json({ error: '缺少临时令牌或验证码' });
    }

    let decoded;
    try {
      decoded = jwt.verify(tempToken);
    } catch (err) {
      return res.status(401).json({ error: '临时令牌无效或已过期' });
    }

    if (decoded.purpose !== 'totp' || !decoded.username) {
      return res.status(401).json({ error: '临时令牌用途无效' });
    }

    const user = store.getUserByUsername(decoded.username);
    if (!user || !user.totpEnabled) {
      return res.status(401).json({ error: '用户不存在或未启用 TOTP' });
    }

    const encryptedSecret = JSON.parse(user.totpSecret);
    const totpValid = totpService.verifyToken(encryptedSecret, code);
    let recoveryUsed = false;

    if (!totpValid && user.recoveryCodes) {
      const hashedCodes = JSON.parse(user.recoveryCodes);
      const idx = totpService.verifyRecoveryCode(code, hashedCodes);
      if (idx >= 0) {
        recoveryUsed = true;
        hashedCodes.splice(idx, 1);
        store.updateUserTotp(user.username, {
          recoveryCodes: hashedCodes,
        });
      }
    }

    if (!totpValid && !recoveryUsed) {
      store.addLog(user.username, 'totp_failed', '验证码错误');
      return res.status(401).json({ error: '验证码错误' });
    }

    const token = jwt.sign({
      username: user.username,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });

    store.addLog(user.username, recoveryUsed ? 'recovery_code_used' : 'login_success', '');
    logger.info('User logged in via TOTP', { username: user.username, recoveryUsed });

    res.json({
      token,
      user: { username: user.username, role: user.role, totpEnabled: true },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', authMiddleware, (req, res) => {
  const user = store.getUserByUsername(req.user.username);
  res.json({
    user: {
      username: user.username,
      role: user.role,
      totpEnabled: !!user.totpEnabled,
    },
  });
});

router.post('/logout', authMiddleware, (req, res) => {
  if (req.tokenJti && req.tokenExp) {
    store.addTokenToBlocklist(req.tokenJti, req.tokenExp);
  }
  store.addLog(req.user.username, 'logout', '');
  res.json({ success: true });
});

// 开始绑定 TOTP：生成密钥和恢复码，但未启用
router.post('/totp/setup', authMiddleware, async (req, res, next) => {
  try {
    const username = req.user.username;
    const user = store.getUserByUsername(username);

    if (user.totpEnabled) {
      return res.status(400).json({ error: 'TOTP 已启用，请先重置' });
    }

    const { base32, qrUrl } = totpService.generateSecret(username);
    const recoveryCodes = totpService.generateRecoveryCodes();
    const hashedRecoveryCodes = recoveryCodes.map((c) => totpService.hashRecoveryCode(c));

    store.updateUserTotp(username, {
      totpSecret: totpService.encryptSecret(base32),
      totpEnabled: 0,
      totpVerified: 0,
      recoveryCodes: hashedRecoveryCodes,
    });

    store.addLog(username, 'totp_setup', '');
    logger.info('TOTP setup initiated', { username });

    res.json({ qrUrl, recoveryCodes });
  } catch (err) {
    next(err);
  }
});

// 确认绑定：验证密码 + 当前 TOTP 码后启用
router.post('/totp/confirm', authMiddleware, async (req, res, next) => {
  try {
    const { password, code } = req.body || {};
    if (!password || !code) {
      return res.status(400).json({ error: '缺少密码或验证码' });
    }

    const username = req.user.username;
    const user = store.getUserByUsername(username);

    if (!user.totpSecret) {
      return res.status(400).json({ error: '未找到 TOTP 绑定信息，请先开始绑定' });
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      store.addLog(username, 'totp_confirm_failed', '密码错误');
      return res.status(401).json({ error: '密码错误' });
    }

    const encryptedSecret = JSON.parse(user.totpSecret);
    if (!totpService.verifyToken(encryptedSecret, code)) {
      store.addLog(username, 'totp_confirm_failed', '验证码错误');
      return res.status(401).json({ error: '验证码错误' });
    }

    store.updateUserTotp(username, { totpEnabled: 1, totpVerified: 1 });
    store.addLog(username, 'totp_confirmed', '');
    logger.info('TOTP enabled', { username });

    res.json({ success: true, totpEnabled: true });
  } catch (err) {
    next(err);
  }
});

// 关闭 TOTP：验证密码 + 当前动态码后清除
router.post('/totp/disable', authMiddleware, async (req, res, next) => {
  try {
    const { password, code } = req.body || {};
    if (!password || !code) {
      return res.status(400).json({ error: '缺少密码或验证码' });
    }

    const username = req.user.username;
    const user = store.getUserByUsername(username);

    if (!user.totpEnabled) {
      return res.status(400).json({ error: 'TOTP 未启用' });
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      store.addLog(username, 'totp_disable_failed', '密码错误');
      return res.status(401).json({ error: '密码错误' });
    }

    const encryptedSecret = JSON.parse(user.totpSecret);
    if (!totpService.verifyToken(encryptedSecret, code)) {
      store.addLog(username, 'totp_disable_failed', '验证码错误');
      return res.status(401).json({ error: '验证码错误' });
    }

    store.clearUserTotp(username);
    store.incrementTokenVersion(username);
    store.addLog(username, 'totp_disabled', '');
    logger.info('TOTP disabled', { username });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// 重置 TOTP：验证密码 + 当前动态码后重新生成密钥和恢复码
router.post('/totp/reset', authMiddleware, async (req, res, next) => {
  try {
    const { password, code } = req.body || {};
    if (!password || !code) {
      return res.status(400).json({ error: '缺少密码或验证码' });
    }

    const username = req.user.username;
    const user = store.getUserByUsername(username);

    if (!user.totpEnabled) {
      return res.status(400).json({ error: 'TOTP 未启用' });
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      store.addLog(username, 'totp_reset_failed', '密码错误');
      return res.status(401).json({ error: '密码错误' });
    }

    const encryptedSecret = JSON.parse(user.totpSecret);
    if (!totpService.verifyToken(encryptedSecret, code)) {
      store.addLog(username, 'totp_reset_failed', '验证码错误');
      return res.status(401).json({ error: '验证码错误' });
    }

    const { base32, qrUrl } = totpService.generateSecret(username);
    const recoveryCodes = totpService.generateRecoveryCodes();
    const hashedRecoveryCodes = recoveryCodes.map((c) => totpService.hashRecoveryCode(c));

    store.updateUserTotp(username, {
      totpSecret: totpService.encryptSecret(base32),
      totpEnabled: 0,
      totpVerified: 0,
      recoveryCodes: hashedRecoveryCodes,
    });

    store.incrementTokenVersion(username);
    store.addLog(username, 'totp_reset', '');
    logger.info('TOTP reset initiated', { username });

    res.json({ qrUrl, recoveryCodes });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
