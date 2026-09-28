const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const jwtSecret = process.env.JWT_SECRET || '';
const defaultAdminUsername = process.env.DEFAULT_ADMIN_USERNAME || '';
const defaultAdminPassword = process.env.DEFAULT_ADMIN_PASSWORD || '';

// 生产环境禁止未设置 JWT_SECRET 或继续使用默认弱管理员密码启动面板
const isProduction = (process.env.NODE_ENV || 'development') === 'production';
if (isProduction) {
  if (!jwtSecret) {
    throw new Error('生产环境必须设置 JWT_SECRET 环境变量（请在 .env 中配置足够长度的随机字符串）');
  }
  // 拒绝已知弱密钥；同时要求最小长度，降低短密钥/可猜测密钥被直接采用的风险
  // 注意：长度检查不能证明密钥随机，部署时请务必使用 openssl rand -hex 32 生成
  const weakSecrets = ['default-change-me', 'change-me', 'secret', 'your-secret-key'];
  if (weakSecrets.includes(jwtSecret.toLowerCase())) {
    throw new Error('生产环境 JWT_SECRET 过于简单，请使用 openssl rand -hex 32 生成强密钥');
  }
  if (jwtSecret.length < 32) {
    throw new Error('生产环境 JWT_SECRET 长度不能小于 32 个字符，请使用 openssl rand -hex 32 生成');
  }
  if (!defaultAdminUsername || !defaultAdminPassword) {
    throw new Error('生产环境必须设置 DEFAULT_ADMIN_USERNAME 与 DEFAULT_ADMIN_PASSWORD');
  }
  if (defaultAdminPassword.length < 8) {
    throw new Error('生产环境 DEFAULT_ADMIN_PASSWORD 长度不能小于 8 位');
  }
  if (defaultAdminUsername === 'admin' && defaultAdminPassword === 'admin123') {
    throw new Error('生产环境禁止使用默认管理员凭据 admin / admin123，请在 .env 中更换');
  }
}

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  jwtSecret: jwtSecret || 'dev-only-default-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  useSudo: process.env.USE_SUDO === 'true',
  dbPath: process.env.DB_PATH || path.join(__dirname, '../../data/panel.db'),
  defaultAdmin: {
    username: defaultAdminUsername || 'admin',
    password: defaultAdminPassword || 'admin123',
  },
};
