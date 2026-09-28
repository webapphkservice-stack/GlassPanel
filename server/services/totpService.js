// TOTP 双因素认证服务（兼容 Google Authenticator，RFC 6238）
const speakeasy = require('speakeasy');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config/default');

const ALGORITHM = 'aes-256-gcm';
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 10;

// 从 JWT_SECRET 派生 AES 密钥；若未设置则抛错，避免使用硬编码密钥
function deriveKey() {
  const secret = config.jwtSecret;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET 未设置或长度不足，无法安全加密 TOTP 密钥');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

// 加密 TOTP 密钥（base32 字符串）
function encryptSecret(secret) {
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    tag: authTag.toString('hex'),
    data: encrypted.toString('hex'),
  };
}

// 解密 TOTP 密钥
function decryptSecret(encrypted) {
  const key = deriveKey();
  const iv = Buffer.from(encrypted.iv, 'hex');
  const tag = Buffer.from(encrypted.tag, 'hex');
  const data = Buffer.from(encrypted.data, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// 生成新的 TOTP 密钥与 otpauth URL
function generateSecret(username) {
  const secret = speakeasy.generateSecret({
    name: `Glass Panel (${username})`,
    length: 32,
  });
  return {
    base32: secret.base32,
    qrUrl: secret.otpauth_url,
  };
}

// 验证 TOTP 动态码
function verifyToken(encryptedSecret, token) {
  if (!token || !/^\d{6}$/.test(token)) return false;
  try {
    const secret = decryptSecret(encryptedSecret);
    return speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token,
      window: 1,
    });
  } catch (err) {
    return false;
  }
}

// 生成一次性恢复码（大写字母+数字，便于阅读和输入）
function generateRecoveryCodes() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去除易混淆字符 0/O/1/I/L
  const codes = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    let code = '';
    for (let j = 0; j < RECOVERY_CODE_LENGTH; j++) {
      code += chars[crypto.randomInt(chars.length)];
    }
    codes.push(code);
  }
  return codes;
}

// 对单个恢复码做 bcrypt 哈希
function hashRecoveryCode(code) {
  return bcrypt.hashSync(code.toUpperCase(), 10);
}

// 验证恢复码是否在列表中；返回匹配索引，-1 表示未匹配
function verifyRecoveryCode(code, hashedCodes) {
  if (!code || !hashedCodes || !Array.isArray(hashedCodes)) return -1;
  const normalized = code.toUpperCase().replace(/\s+/g, '');
  for (let i = 0; i < hashedCodes.length; i++) {
    if (bcrypt.compareSync(normalized, hashedCodes[i])) return i;
  }
  return -1;
}

module.exports = {
  generateSecret,
  verifyToken,
  encryptSecret,
  decryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
};
