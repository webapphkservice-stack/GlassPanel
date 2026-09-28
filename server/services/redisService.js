const fs = require('fs');
const { run } = require('./commandRunner');

const REDIS_MARKER = '/opt/glass-panel/data/redis-compiled-version';

// 源码编译安装的 Redis 使用独立服务名（redis-8.0）与端口（6380），
// 与系统源 redis（redis / 6379）并存，按版本标记文件判断当前使用哪一个
function resolveRedis() {
  let version = '';
  try {
    if (fs.existsSync(REDIS_MARKER)) version = fs.readFileSync(REDIS_MARKER, 'utf8').trim();
  } catch (err) {
    version = '';
  }
  if (version) {
    return { service: `redis-${version.replace(/\.\d+$/, '')}`, port: '6380' };
  }
  return { service: 'redis', port: '6379' };
}

async function getStatus() {
  const { service } = resolveRedis();
  const result = await run('systemctl', ['is-active', service]);
  return result.exitCode === 0 ? result.stdout.trim() : 'inactive';
}

async function control(action) {
  const allowed = ['start', 'stop', 'restart'];
  if (!allowed.includes(action)) throw new Error('非法操作');
  const { service } = resolveRedis();
  return run('systemctl', [action, service]);
}

async function getInfo() {
  try {
    const { port } = resolveRedis();
    const { stdout } = await run('redisCli', ['-p', port, 'INFO']);
    return stdout.split('\n').reduce((acc, line) => {
      if (!line || line.startsWith('#')) return acc;
      const [key, value] = line.split(':');
      if (key && value) acc[key] = value.trim();
      return acc;
    }, {});
  } catch (err) {
    return {};
  }
}

module.exports = { getStatus, control, getInfo };