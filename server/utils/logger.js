const config = require('../config/default');

function log(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message} ${metaStr}`);
}

module.exports = {
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  debug: (msg, meta) => {
    if (process.env.NODE_ENV === 'development' || process.env.DEBUG_COMMANDS === 'true') {
      log('debug', msg, meta);
    }
  },
};
