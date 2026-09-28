const bcrypt = require('bcryptjs');
const store = require('../models/store');
const config = require('../config/default');
const logger = require('../utils/logger');

async function main() {
  const args = process.argv.slice(2);
  const username = args[0] || config.defaultAdmin.username;
  const password = args[1] || config.defaultAdmin.password;

  if (!username || !password) {
    logger.error('请提供管理员用户名和密码：node scripts/createAdmin.js <username> <password>');
    process.exit(1);
  }
  if (password.length < 8) {
    logger.error('管理员密码长度不能小于 8 位');
    process.exit(1);
  }
  if (username === 'admin' && password === 'admin123') {
    logger.error('禁止使用默认弱密码 admin123，请更换为强密码');
    process.exit(1);
  }

  const existing = store.getByUsername ? store.getByUsername(username) : store.getUserByUsername(username);
  if (existing) {
    logger.warn(`User ${username} already exists`);
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  store.createUser(username, passwordHash, 'admin');
  logger.info(`Admin user created: ${username}`);
}

main().catch((err) => {
  logger.error('Create admin failed', { error: err.message });
  process.exit(1);
});
