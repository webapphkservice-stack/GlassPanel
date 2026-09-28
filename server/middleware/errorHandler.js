const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
  logger.error('API Error', { path: req.path, error: err.message });
  const status = err.status || 500;
  const message = err.message || '服务器内部错误';
  res.status(status).json({ error: message });
}

module.exports = errorHandler;
