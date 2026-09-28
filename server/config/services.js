// 服务命令白名单与路径映射
// 生产环境建议通过 sudoers 限制专用用户执行这些命令
module.exports = {
  nginx: {
    service: 'nginx',
    binary: '/usr/sbin/nginx',
    configDir: '/etc/nginx',
    sitesAvailable: '/etc/nginx/sites-available',
    sitesEnabled: '/etc/nginx/sites-enabled',
  },
  php: {
    prefix: '/usr/bin/php',
    fpmPrefix: '/usr/sbin/php-fpm',
    configDir: '/etc/php',
  },
  mysql: {
    service: 'mysql',
    binary: '/usr/bin/mysql',
    adminBinary: '/usr/bin/mysqladmin',
  },
  redis: {
    service: 'redis',
    binary: '/usr/bin/redis-cli',
    serverBinary: '/usr/bin/redis-server',
    configPath: '/etc/redis/redis.conf',
  },
  supervisor: {
    service: 'supervisor',
    binary: '/usr/bin/supervisorctl',
    configDir: '/etc/supervisor/conf.d',
  },
  pm2: {
    binary: '/usr/bin/pm2',
  },
  firewall: {
    ufw: '/usr/sbin/ufw',
    firewallCmd: '/usr/bin/firewall-cmd',
  },
  certbot: {
    binary: '/usr/bin/certbot',
    certsDir: '/etc/letsencrypt/live',
  },
  system: {
    systemctl: '/usr/bin/systemctl',
    service: '/usr/sbin/service',
  },
};
