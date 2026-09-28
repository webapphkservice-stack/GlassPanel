const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../config/default');
const logger = require('../utils/logger');

const execFileAsync = promisify(execFile);

// 命令白名单：key 为内部名称，value 为绝对路径
const ALLOWED_COMMANDS = {
  systemctl: '/usr/bin/systemctl',
  service: '/usr/sbin/service',
  nginx: '/usr/sbin/nginx',
  php: '/usr/bin/php',
  phpFpm: '/usr/sbin/php-fpm',
  mysql: '/usr/bin/mysql',
  mysqladmin: '/usr/bin/mysqladmin',
  mysqldump: '/usr/bin/mysqldump',
  redisCli: '/usr/bin/redis-cli',
  redisServer: '/usr/bin/redis-server',
  supervisorctl: '/usr/bin/supervisorctl',
  fail2banClient: '/usr/bin/fail2ban-client',
  // 面板源码编译安装的 fail2ban 客户端落在 /usr/local/bin（见 appService 的安装脚本）
  fail2banClientLocal: '/usr/local/bin/fail2ban-client',
  pm2: '/usr/bin/pm2',
  ufw: '/usr/sbin/ufw',
  firewallCmd: '/usr/bin/firewall-cmd',
  iptables: '/usr/sbin/iptables',
  iptablesSave: '/usr/sbin/iptables-save',
  iptablesRestore: '/usr/sbin/iptables-restore',
  certbot: '/usr/bin/certbot',
  openssl: '/usr/bin/openssl',
  free: '/usr/bin/free',
  df: '/usr/bin/df',
  ps: '/usr/bin/ps',
  ss: '/usr/sbin/ss',
  dnf: '/usr/bin/dnf',
  apt: '/usr/bin/apt',
  aptGet: '/usr/bin/apt-get',
  aptCache: '/usr/bin/apt-cache',
  yum: '/usr/bin/yum',
  rpm: '/usr/bin/rpm',
  dpkg: '/usr/bin/dpkg',
  curl: '/usr/bin/curl',
  bash: '/usr/bin/bash',
  uname: '/usr/bin/uname',
  tar: '/usr/bin/tar',
  ffmpeg: '/usr/local/bin/ffmpeg',
  ffprobe: '/usr/local/bin/ffprobe',
  pip3: '/usr/bin/pip3',
  journalctl: '/usr/bin/journalctl',
};

/**
 * 安全执行命令
 * @param {string} name - 白名单中的命令名
 * @param {string[]} args - 命令参数数组
 * @param {object} options - 额外选项
 */
async function run(name, args = [], options = {}) {
  const bin = ALLOWED_COMMANDS[name];
  if (!bin) {
    throw new Error(`非法命令: ${name}`);
  }

  const cmd = config.useSudo ? 'sudo' : bin;
  const finalArgs = config.useSudo ? [bin, ...args] : args;

  // 对含敏感信息的参数进行脱敏，避免密码进入日志
  const logArgs = finalArgs.map((arg) => {
    const str = String(arg);
    // MySQL 命令中常见的明文密码语句
    if (/IDENTIFIED BY\s+['"][^'"]+['"]/i.test(str)) {
      return str.replace(/(IDENTIFIED BY\s+['"])[^'"]+(['"])/gi, '$1***$2');
    }
    // 单独脱敏密码参数：PASS=xxx / --password=xxx / password=xxx
    if (/^([A-Z_]*PASS(WORD)?=|--password=).{3,}$/i.test(str)) {
      return str.replace(/=.*/, '=***');
    }
    return str;
  });
  // 生产环境默认只记录命令名与参数数量，完整参数仅在调试模式输出
  logger.info('Execute command', { cmd: name, argsCount: finalArgs.length });
  logger.debug('Execute command details', { cmd: name, args: logArgs });

  try {
    const result = await execFileAsync(cmd, finalArgs, {
      timeout: options.timeout || 30000,
      encoding: 'utf8',
      ...options,
    });
    return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.code || 1,
      error: err.message,
    };
  }
}

module.exports = { run, ALLOWED_COMMANDS };
