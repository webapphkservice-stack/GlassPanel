const app = require('../app');
const config = require('../config/default');
const store = require('../models/store');
const logger = require('../utils/logger');
const bcrypt = require('bcryptjs');
const jobService = require('../services/jobService');

// 首次启动自动创建管理员：若数据库中没有任何用户则创建。
// 生产环境 config/default.js 已强制要求设置强密码，避免使用默认凭据。
async function ensureAdmin() {
  try {
    if (store.hasUsers()) return;
    const { username, password } = config.defaultAdmin;
    const passwordHash = await bcrypt.hash(password, 10);
    store.createUser(username, passwordHash, 'admin');
    logger.info('First-run admin created', { username });
  } catch (err) {
    logger.error('Failed to create first-run admin', { error: err.message });
    process.exit(1);
  }
}

ensureAdmin()
  .then(() => jobService.cleanupOldJobs())
  .then(() => {
    logger.info('Old job files cleanup completed');
  })
  .catch((err) => {
    logger.error('Old job files cleanup failed', { error: err.message });
  })
  .then(() => {
    const server = app.listen(config.port, () => {
      logger.info(`Glass Panel server running at http://localhost:${config.port} [${config.nodeEnv}]`);
    });

    process.on('SIGTERM', () => {
      logger.info('SIGTERM received, shutting down gracefully');
      server.close(() => process.exit(0));
    });
  });
