const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { run } = require('./commandRunner');
const jobService = require('./jobService');
const official = require('./officialSources');

const execFileAsync = promisify(execFile);

// 源码编译安装目录：/usr/local/php/<version>/sbin/php-fpm
const COMPILED_ROOT = '/usr/local/php';
// remi / 系统源的 php-fpm 二进制目录：/usr/sbin/php<major>-fpm
const SBIN_DIR = '/usr/sbin';
// 扩展编译工作目录（安装结束后保留 .so，工作区可随时清理）
const EXT_BUILD_ROOT = '/opt/phpextbuild';

function compareVersions(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// 列出所有已安装的 PHP 版本：源码编译（/usr/local/php/*）+ 系统/remi（/usr/sbin/php*-fpm）
function listInstalled() {
  const found = [];

  if (fs.existsSync(COMPILED_ROOT)) {
    for (const version of fs.readdirSync(COMPILED_ROOT)) {
      const prefix = path.join(COMPILED_ROOT, version);
      if (!fs.existsSync(path.join(prefix, 'sbin', 'php-fpm'))) continue;
      const major = version.replace(/\.\d+$/, '');
      found.push({
        version,
        source: 'compiled',
        service: `php-fpm-${major}`,
        bin: path.join(prefix, 'bin', 'php'),
      });
    }
  }

  if (fs.existsSync(SBIN_DIR)) {
    for (const name of fs.readdirSync(SBIN_DIR)) {
      const m = /^php(\d+\.\d+)-fpm$/.exec(name);
      if (!m) continue;
      found.push({
        version: m[1],
        source: 'package',
        service: `php${m[1]}-fpm`,
        bin: `/usr/bin/php${m[1]}`,
      });
    }
  }

  return found.sort((a, b) => compareVersions(b.version, a.version));
}

async function getServiceStatus(service) {
  const result = await run('systemctl', ['is-active', service]);
  return result.exitCode === 0 ? result.stdout.trim() : 'inactive';
}

// 汇总状态：任一版本服务处于 active 即视为运行中
async function getStatus() {
  const installed = listInstalled();
  if (installed.length === 0) return 'inactive';
  const statuses = await Promise.all(installed.map((i) => getServiceStatus(i.service)));
  return statuses.find((s) => s === 'active') || 'inactive';
}

// 供 /php/status 返回：每个版本附带服务名与运行状态，前端可逐版本控制
async function listVersions() {
  const installed = listInstalled();
  return Promise.all(
    installed.map(async (item) => ({
      version: item.version,
      source: item.source,
      service: item.service,
      status: await getServiceStatus(item.service),
    })),
  );
}

// 由版本号定位服务名（源码编译为 php-fpm-8.5，remi 为 php8.5-fpm）
function resolveService(version) {
  const installed = listInstalled();
  const hit = version
    ? installed.find((i) => i.version === version || i.version.replace(/\.\d+$/, '') === version)
    : installed.find((i) => i.source === 'compiled') || installed[0];
  if (hit) return hit.service;
  return version ? `php${version}-fpm` : 'php-fpm';
}

async function control(action, version = '') {
  const allowed = ['start', 'stop', 'restart', 'reload'];
  if (!allowed.includes(action)) throw new Error('非法操作');
  return run('systemctl', [action, resolveService(version)]);
}

async function getDefaultVersion() {
  const installed = listInstalled();
  const target = installed.find((i) => i.source === 'compiled') || installed[0];
  const bin = target ? target.bin : 'php';
  try {
    const { stdout } = await execFileAsync(bin, ['-r', 'echo PHP_VERSION;']);
    return stdout.trim();
  } catch (err) {
    return '';
  }
}

// ---------- 版本上下文（配置 / 扩展 / 日志共用的路径解析） ----------

function findItem(version) {
  const installed = listInstalled();
  if (installed.length === 0) return null;
  if (!version) return installed.find((i) => i.source === 'compiled') || installed[0];
  return (
    installed.find((i) => i.version === version)
    || installed.find((i) => i.version.replace(/\.\d+$/, '') === version)
    || null
  );
}

// 解析某版本的 php.ini / conf.d / 日志 / pool 等路径
async function resolveContext(version) {
  const item = findItem(version);
  if (!item) throw new Error('未检测到已安装的 PHP 版本');

  if (item.source === 'compiled') {
    const prefix = path.dirname(path.dirname(item.bin));
    return {
      item,
      prefix,
      ini: path.join(prefix, 'etc', 'php.ini'),
      confD: path.join(prefix, 'etc', 'conf.d'),
      pool: path.join(prefix, 'etc', 'php-fpm.d', 'www.conf'),
      fpmConf: path.join(prefix, 'etc', 'php-fpm.conf'),
      logDir: path.join(prefix, 'var', 'log'),
      defaultErrorLog: path.join(prefix, 'var', 'log', 'php-fpm.log'),
    };
  }

  // 包管理器安装：用 php --ini 解析实际 ini 与扫描目录
  let ini = '';
  let confD = '';
  try {
    const { stdout } = await execFileAsync(item.bin, ['--ini']);
    const m = /Loaded Configuration File:\s*(\S+)/.exec(stdout);
    if (m && m[1] !== '(none)') ini = m[1];
    const s = /Scan for additional .ini files in:\s*(\S+)/.exec(stdout);
    if (s && s[1] !== '(none)') confD = s[1];
  } catch (err) {
    // 忽略：下面回退到默认路径
  }
  const major = item.version.replace(/\.\d+$/, '');
  const poolCandidates = [
    `/etc/php-fpm.d/www.conf`,
    `/etc/php/${item.version}/fpm/pool.d/www.conf`,
    `/etc/opt/remi/php${major.replace('.', '')}/php-fpm.d/www.conf`,
  ];
  const pool = poolCandidates.find((p) => fs.existsSync(p)) || '';
  const logCandidates = [
    `/var/log/php-fpm/www-error.log`,
    `/var/opt/remi/php${major.replace('.', '')}/log/php-fpm/www-error.log`,
    `/var/log/php${major}-fpm.log`,
  ];
  return {
    item,
    prefix: '/usr',
    ini: ini || '/etc/php.ini',
    confD: confD || '/etc/php.d',
    pool,
    fpmConf: '',
    logDir: '/var/log',
    defaultErrorLog: logCandidates.find((p) => fs.existsSync(p)) || logCandidates[0],
  };
}

// ---------- php.ini 键值读写 ----------

// 面板允许修改的 php.ini 键白名单（防止任意键注入 / 破坏配置）
const EDITABLE_INI_KEYS = [
  'upload_max_filesize', 'post_max_size', 'max_file_uploads', 'file_uploads',
  'memory_limit', 'max_execution_time', 'max_input_time', 'max_input_vars',
  'display_errors', 'error_reporting', 'date.timezone', 'default_charset',
  'expose_php', 'allow_url_fopen', 'disable_functions',
  'opcache.enable', 'opcache.memory_consumption', 'opcache.max_accelerated_files',
];

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 读取某个键的实际生效值：php.ini 后出现的「生效行」覆盖先前的，注释行不参与
function readIniEntry(content, key) {
  const re = new RegExp(`^[ \\t]*(;?)[ \\t]*${escapeRe(key)}[ \\t]*=[ \\t]*(.*)$`, 'gm');
  let m;
  let lastActive = null;
  let lastSeen = null;
  while ((m = re.exec(content)) !== null) {
    lastSeen = m[2].trim();
    if (m[1] !== ';') lastActive = m[2].trim();
  }
  if (lastActive === null) return { value: '', active: false, raw: lastSeen || '' };
  return { value: lastActive, active: true, raw: lastSeen || '' };
}

function readIniKeys(content, keys) {
  const out = {};
  for (const key of keys) out[key] = readIniEntry(content, key).value;
  return out;
}

// 写入键值：首个匹配行改为生效行，其余重复行统一注释掉，确保写入值一定生效
function replaceIniKey(content, key, line) {
  const source = `^[ \\t]*;?[ \\t]*${escapeRe(key)}[ \\t]*=.*$`;
  if (!new RegExp(source, 'm').test(content)) {
    return `${content.replace(/\s*$/, '')}\n${line}\n`;
  }
  let seen = 0;
  return content.replace(new RegExp(source, 'gm'), (matched) => {
    seen += 1;
    if (seen === 1) return line;
    return /^[ \t]*;/.test(matched) ? matched : `;${matched}`;
  });
}

function setIniValue(content, key, value) {
  return replaceIniKey(content, key, `${key} = ${value}`);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function reloadService(item) {
  const r = await run('systemctl', ['reload', item.service]);
  if (r.exitCode === 0) return true;
  const r2 = await run('systemctl', ['restart', item.service]);
  return r2.exitCode === 0;
}

// 读取上传限制 / 禁用函数 / 常规配置（供 上传限制、禁用函数、配置修改 三个页签共用）
async function getSettings(version) {
  const ctx = await resolveContext(version);
  if (!ctx.ini || !fs.existsSync(ctx.ini)) {
    throw new Error(`未找到 php.ini：${ctx.ini || '未知路径'}`);
  }
  const content = fs.readFileSync(ctx.ini, 'utf8');
  const slowlog = readSlowlogConfig(ctx, content);
  return {
    version: ctx.item.version,
    source: ctx.item.source,
    service: ctx.item.service,
    iniPath: ctx.ini,
    confD: ctx.confD,
    settings: readIniKeys(content, EDITABLE_INI_KEYS),
    disabledFunctions: readIniEntry(content, 'disable_functions').value,
    slowlog,
  };
}

// pool 中的慢日志配置：slowlog / request_slowlog_timeout
function readSlowlogConfig(ctx, iniContent) {
  const slowPath = poolEntry(ctx, 'slowlog', '') || path.join(ctx.logDir, 'php-fpm-slow.log');
  const entry = poolEntry(ctx, 'request_slowlog_timeout', '0', true);
  const secs = parseInt(entry && entry.value ? entry.value : '0', 10) || 0;
  return {
    poolPath: ctx.pool || '',
    path: slowPath,
    enabled: !!(entry && entry.active) && secs > 0,
    timeout: secs,
    // php.ini 中若也配置了 slowlog 相关项，这里一并暴露给前端展示
    iniHasSlowlog: /^\s*;?\s*slowlog\s*=/m.test(iniContent),
  };
}

// 读取 pool 配置项；withMeta 为 true 时返回 { value, active }
function poolEntry(ctx, key, fallback, withMeta = false) {
  const file = ctx.pool;
  if (!file || !fs.existsSync(file)) {
    return withMeta ? { value: fallback, active: false } : fallback;
  }
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return withMeta ? { value: fallback, active: false } : fallback;
  }
  const entry = readIniEntry(content, key);
  if (!entry.value) return withMeta ? { value: fallback, active: false } : fallback;
  return withMeta ? entry : entry.value;
}

// 写入配置项（仅白名单键），写前备份 php.ini，写后 reload/restart 使配置生效
async function updateSettings(version, patch) {
  const entries = Object.entries(patch || {});
  if (entries.length === 0) throw new Error('没有需要修改的配置项');
  for (const [key, value] of entries) {
    if (!EDITABLE_INI_KEYS.includes(key)) throw new Error(`不允许修改的配置项：${key}`);
    if (/[\r\n]/.test(String(value))) throw new Error(`配置值非法：${key}`);
  }

  const ctx = await resolveContext(version);
  if (!ctx.ini || !fs.existsSync(ctx.ini)) throw new Error(`未找到 php.ini：${ctx.ini || '未知路径'}`);

  const original = fs.readFileSync(ctx.ini, 'utf8');
  const backup = `${ctx.ini}.bak.${stamp()}`;
  fs.writeFileSync(backup, original, 'utf8');

  let content = original;
  for (const [key, value] of entries) content = setIniValue(content, key, value);
  fs.writeFileSync(ctx.ini, content, 'utf8');

  const reloaded = await reloadService(ctx.item);
  return { iniPath: ctx.ini, backup, changedKeys: entries.map(([k]) => k), reloaded };
}

// ---------- 扩展安装 ----------

// 扩展目录：PECL 扩展从 pecl.php.net 取最新稳定版；自带扩展从 php 源码包 ext/ 目录编译
const EXT_CATALOG = [
  { module: 'redis', name: 'Redis', kind: 'pecl', pkg: 'redis', desc: 'Redis 客户端（缓存 / 会话）', deps: [] },
  { module: 'memcached', name: 'Memcached', kind: 'pecl', pkg: 'memcached', desc: 'Memcached 客户端', deps: ['libmemcached-devel', 'zlib-devel'] },
  { module: 'mongodb', name: 'MongoDB', kind: 'pecl', pkg: 'mongodb', desc: 'MongoDB 官方驱动', deps: ['openssl-devel'] },
  { module: 'igbinary', name: 'Igbinary', kind: 'pecl', pkg: 'igbinary', desc: '二进制序列化，降低内存占用', deps: [] },
  { module: 'msgpack', name: 'MessagePack', kind: 'pecl', pkg: 'msgpack', desc: 'MessagePack 序列化', deps: [] },
  { module: 'apcu', name: 'APCu', kind: 'pecl', pkg: 'apcu', desc: '单机用户缓存', deps: [] },
  { module: 'imagick', name: 'ImageMagick', kind: 'pecl', pkg: 'imagick', desc: '图像处理（ImageMagick）', deps: ['ImageMagick-devel'] },
  { module: 'yaml', name: 'YAML', kind: 'pecl', pkg: 'yaml', desc: 'YAML 解析', deps: ['libyaml-devel'] },
  { module: 'ssh2', name: 'SSH2', kind: 'pecl', pkg: 'ssh2', desc: 'SSH 远程操作', deps: ['libssh2-devel'] },
  { module: 'xdebug', name: 'Xdebug', kind: 'pecl', pkg: 'xdebug', desc: '调试与性能分析', deps: [] },
  { module: 'zip', name: 'Zip', kind: 'bundled', dir: 'zip', desc: 'zip 压缩与解压', args: ['--with-zip'], deps: ['libzip-devel'] },
  { module: 'gd', name: 'GD', kind: 'bundled', dir: 'gd', desc: '图像处理（GD）', args: ['--enable-gd', '--with-jpeg', '--with-freetype'], deps: ['libpng-devel', 'libjpeg-turbo-devel', 'freetype-devel'] },
  { module: 'exif', name: 'Exif', kind: 'bundled', dir: 'exif', desc: '读取图片 EXIF 信息', args: ['--enable-exif'], deps: [] },
  { module: 'soap', name: 'SOAP', kind: 'bundled', dir: 'soap', desc: 'SOAP 协议支持', args: ['--enable-soap'], deps: ['libxml2-devel'] },
  { module: 'ldap', name: 'LDAP', kind: 'bundled', dir: 'ldap', desc: 'LDAP 目录服务', args: ['--with-ldap'], deps: ['openldap-devel'] },
  { module: 'gmp', name: 'GMP', kind: 'bundled', dir: 'gmp', desc: '大整数运算', args: ['--with-gmp'], deps: ['gmp-devel'] },
  { module: 'sodium', name: 'Sodium', kind: 'bundled', dir: 'sodium', desc: '现代加密库', args: ['--with-sodium'], deps: ['libsodium-devel'] },
  { module: 'xsl', name: 'XSL', kind: 'bundled', dir: 'xsl', desc: 'XSLT 转换', args: ['--with-xsl'], deps: ['libxslt-devel'] },
  { module: 'sqlite3', name: 'SQLite3', kind: 'bundled', dir: 'sqlite3', desc: 'SQLite3 数据库', args: ['--with-sqlite3'], deps: ['sqlite-devel'] },
  { module: 'pdo_pgsql', name: 'PDO PostgreSQL', kind: 'bundled', dir: 'pdo_pgsql', desc: 'PostgreSQL PDO 驱动', args: ['--with-pdo-pgsql'], deps: ['postgresql-devel'] },
  { module: 'calendar', name: 'Calendar', kind: 'bundled', dir: 'calendar', desc: '日历转换', args: ['--enable-calendar'], deps: [] },
  { module: 'ftp', name: 'FTP', kind: 'bundled', dir: 'ftp', desc: 'FTP 客户端', args: ['--enable-ftp'], deps: [] },
  { module: 'sysvsem', name: 'SysV Semaphore', kind: 'bundled', dir: 'sysvsem', desc: 'SysV 信号量', args: ['--enable-sysvsem'], deps: [] },
  { module: 'sysvshm', name: 'SysV Shared Memory', kind: 'bundled', dir: 'sysvshm', desc: 'SysV 共享内存', args: ['--enable-sysvshm'], deps: [] },
];

async function listLoadedModules(bin) {
  try {
    const { stdout } = await execFileAsync(bin, ['-m'], { timeout: 15000 });
    return stdout.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('['));
  } catch (err) {
    return [];
  }
}

async function getExtensions(version) {
  const ctx = await resolveContext(version);
  const loaded = await listLoadedModules(ctx.item.bin);
  const set = new Set(loaded.map((m) => m.toLowerCase()));
  const catalog = EXT_CATALOG.map((ext) => {
    let enabledFile = '';
    if (ctx.confD) {
      const f = path.join(ctx.confD, `${ext.module}.ini`);
      if (fs.existsSync(f)) enabledFile = f;
    }
    return { ...ext, installed: set.has(ext.module.toLowerCase()), enabledFile };
  });
  return {
    version: ctx.item.version,
    service: ctx.item.service,
    confD: ctx.confD,
    loaded,
    catalog,
  };
}

// 生成扩展编译安装脚本（phpize + configure + make install，最后写 conf.d 并重启 fpm）
function buildExtInstallScript(ctx, ext) {
  const { prefix } = ctx;
  const phpVer = ctx.item.version;
  const work = `${EXT_BUILD_ROOT}/${ext.module}`;
  const deps = (ext.deps || []).join(' ');
  const args = (ext.args || []).join(' ');
  // 编译依赖统一从系统源安装：显式排除面板托管的官方源，避免与官方包混装
  // （存量机器上 repo 文件可能仍是 enabled=1，只改写盘逻辑覆盖不到）
  const repoExclude = official.allOfficialRepoIds().join(',');

  const lines = [
    '#!/usr/bin/env bash',
    `PREFIX="${prefix}"`,
    `PHPVER="${phpVer}"`,
    `MOD="${ext.module}"`,
    `WORK="${work}"`,
    `INI="$PREFIX/etc/conf.d/${ext.module}.ini"`,
    `SERVICE="${ctx.item.service}"`,
    'echo "[面板] 开始安装 PHP 扩展 ${MOD}（PHP ${PHPVER}）"',
    'if [ ! -x "$PREFIX/bin/phpize" ] || [ ! -x "$PREFIX/bin/php-config" ]; then',
    '  echo "[面板] 缺少 $PREFIX/bin/phpize 或 php-config，无法编译扩展"',
    '  exit 1',
    'fi',
    'echo "[面板] 安装编译工具与依赖 ..."',
    `dnf -y install --disablerepo=${repoExclude} gcc gcc-c++ make autoconf libtool >/dev/null 2>&1 || echo "[面板] 基础编译工具安装返回非 0，继续尝试"`,
  ];

  if (deps) {
    lines.push(`dnf -y install --disablerepo=${repoExclude} ${deps} || echo "[面板] 依赖 ${deps} 安装失败，继续尝试编译"`);
  }

  lines.push('rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK" || exit 1');

  if (ext.kind === 'pecl') {
    lines.push(
      `echo "[面板] 下载 ${ext.pkg} 源码（pecl.php.net 最新稳定版）"`,
      `curl -fSL -o ext.tar.gz "https://pecl.php.net/get/${ext.pkg}" || { echo "[面板] 下载失败，请检查服务器网络"; exit 1; }`,
      'tar xzf ext.tar.gz || { echo "[面板] 解压失败"; exit 1; }',
      'SRCDIR="$(find "$WORK" -maxdepth 1 -mindepth 1 -type d | head -1)"',
      'if [ -z "$SRCDIR" ]; then echo "[面板] 未找到解压后的源码目录"; exit 1; fi',
      'cd "$SRCDIR" || exit 1',
    );
  } else {
    const tarball = `php-${phpVer}.tar.gz`;
    lines.push(
      `echo "[面板] 取 PHP ${phpVer} 源码包中的 ext/${ext.dir} 编译"`,
      `if [ -f "/opt/phpbuild/php-${phpVer}/${tarball}" ]; then cp "/opt/phpbuild/php-${phpVer}/${tarball}" "$WORK/${tarball}"; else curl -fSL -o "$WORK/${tarball}" "https://www.php.net/distributions/${tarball}" || { echo "[面板] 下载失败，请检查服务器网络"; exit 1; }; fi`,
      `tar xzf "${tarball}" "php-${phpVer}/ext/${ext.dir}" || { echo "[面板] 解压失败"; exit 1; }`,
      `cd "php-${phpVer}/ext/${ext.dir}" || exit 1`,
    );
  }

  lines.push(
    'echo "[面板] 生成构建脚本（phpize）..."',
    '"$PREFIX/bin/phpize" || { echo "[面板] phpize 失败"; exit 1; }',
    `./configure --with-php-config="$PREFIX/bin/php-config"${args ? ` ${args}` : ''} || { echo "[面板] configure 失败，请查看上方输出"; exit 1; }`,
    'echo "[面板] 编译中（make）..."',
    'make -j"$(nproc)" || { echo "[面板] 编译失败"; exit 1; }',
    'make install || { echo "[面板] 安装 .so 失败"; exit 1; }',
    'mkdir -p "$(dirname "$INI")"',
    'grep -q "^extension=${MOD}" "$INI" 2>/dev/null || echo "extension=${MOD}.so" >> "$INI"',
    'echo "[面板] 已写入启用配置：$INI"',
    'systemctl restart "$SERVICE" || echo "[面板] php-fpm 重启失败，请检查日志"',
    'if "$PREFIX/bin/php" -m 2>/dev/null | grep -qi "^${MOD}$"; then',
    '  echo "[面板] 扩展 ${MOD} 安装成功并已加载"',
    'else',
    '  echo "[面板] 警告：扩展 ${MOD} 未加载，请检查上方编译输出"',
    'fi',
    'echo "[面板] 安装流程结束"',
  );

  return `${lines.join('\n')}\n`;
}

async function installExtension(version, module) {
  const ext = EXT_CATALOG.find((e) => e.module === module);
  if (!ext) throw new Error('未知扩展');
  const ctx = await resolveContext(version);
  const key = `php-ext-${ctx.item.version}-${ext.module}`;
  const script = buildExtInstallScript(ctx, ext);
  const job = jobService.start({
    key,
    label: `PHP 扩展 ${ext.name}（${ctx.item.version}）`,
    script,
  });
  return { job, key };
}

// 卸载扩展：删除面板写入的 conf.d/<module>.ini 并重启 fpm（.so 保留，便于再次启用）
async function uninstallExtension(version, module) {
  const ext = EXT_CATALOG.find((e) => e.module === module);
  if (!ext) throw new Error('未知扩展');
  const ctx = await resolveContext(version);
  if (!ctx.confD) throw new Error('未找到 conf.d 目录');
  const ini = path.join(ctx.confD, `${module}.ini`);
  let removed = false;
  if (fs.existsSync(ini)) {
    fs.writeFileSync(`${ini}.bak.${stamp()}`, fs.readFileSync(ini, 'utf8'), 'utf8');
    fs.unlinkSync(ini);
    removed = true;
  }
  const reloaded = await reloadService(ctx.item);
  return { removed, iniPath: ini, reloaded };
}

// ---------- 日志 ----------

// 错误日志路径：优先 php-fpm.conf 的 error_log，否则用默认路径
function resolveErrorLogPath(ctx) {
  if (ctx.fpmConf && fs.existsSync(ctx.fpmConf)) {
    try {
      const content = fs.readFileSync(ctx.fpmConf, 'utf8');
      const entry = readIniEntry(content, 'error_log');
      if (entry.value && entry.value !== 'log/php-fpm.log') {
        return path.isAbsolute(entry.value) ? entry.value : path.join(path.dirname(ctx.fpmConf), entry.value);
      }
    } catch (err) {
      // 忽略，回退默认路径
    }
  }
  return ctx.defaultErrorLog;
}

function resolveSlowLogPath(ctx) {
  const p = poolEntry(ctx, 'slowlog', '');
  if (!p) return '';
  return path.isAbsolute(p) ? p : path.join(path.dirname(ctx.pool || '/'), p);
}

// 读取文件末尾若干行（大文件只读末尾 2MB）
function tailFile(filePath, lines) {
  const MAX = 2 * 1024 * 1024;
  const size = fs.statSync(filePath).size;
  const start = Math.max(0, size - MAX);
  const len = size - start;
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(len);
  try {
    fs.readSync(fd, buf, 0, len, start);
  } finally {
    fs.closeSync(fd);
  }
  let text = buf.toString('utf8');
  if (start > 0) {
    const idx = text.indexOf('\n');
    text = idx >= 0 ? text.slice(idx + 1) : text;
  }
  const arr = text.split('\n');
  return arr.slice(Math.max(0, arr.length - lines)).join('\n');
}

async function getLogs(version, type = 'error', lines = 200) {
  const ctx = await resolveContext(version);
  const count = Math.min(Math.max(parseInt(lines, 10) || 200, 10), 2000);
  const logType = type === 'slow' ? 'slow' : 'error';
  const filePath = logType === 'slow' ? resolveSlowLogPath(ctx) : resolveErrorLogPath(ctx);
  if (!filePath) {
    return { type: logType, path: '', exists: false, content: '慢日志未启用，请先在上方开启慢日志。', size: 0 };
  }
  if (!fs.existsSync(filePath)) {
    return { type: logType, path: filePath, exists: false, content: '', size: 0 };
  }
  const size = fs.statSync(filePath).size;
  return { type: logType, path: filePath, exists: true, content: tailFile(filePath, count), size };
}

// 清空日志：清空全部或仅保留末尾 N 行
async function clearLogs(version, type = 'error', keepLines = 0) {
  const ctx = await resolveContext(version);
  const logType = type === 'slow' ? 'slow' : 'error';
  const filePath = logType === 'slow' ? resolveSlowLogPath(ctx) : resolveErrorLogPath(ctx);
  if (!filePath || !fs.existsSync(filePath)) throw new Error('日志文件不存在');
  const keep = Math.max(parseInt(keepLines, 10) || 0, 0);
  if (keep > 0) {
    const tail = tailFile(filePath, keep);
    fs.writeFileSync(filePath, tail.endsWith('\n') ? tail : `${tail}\n`, 'utf8');
    return { path: filePath, kept: keep };
  }
  fs.writeFileSync(filePath, '', 'utf8');
  return { path: filePath, kept: 0 };
}

// 开启/关闭慢日志（写 pool 的 slowlog 与 request_slowlog_timeout 后重启 fpm）
async function setSlowlog(version, enabled, timeout = 5) {
  const ctx = await resolveContext(version);
  if (!ctx.pool || !fs.existsSync(ctx.pool)) throw new Error('未找到 php-fpm pool 配置（www.conf）');
  const secs = Math.min(Math.max(parseInt(timeout, 10) || 5, 1), 3600);
  const slowPath = path.join(ctx.logDir, 'php-fpm-slow.log');

  let content = fs.readFileSync(ctx.pool, 'utf8');
  fs.writeFileSync(`${ctx.pool}.bak.${stamp()}`, content, 'utf8');

  if (enabled) {
    content = replaceIniKey(content, 'slowlog', `slowlog = ${slowPath}`);
    content = replaceIniKey(content, 'request_slowlog_timeout', `request_slowlog_timeout = ${secs}s`);
  } else {
    content = replaceIniKey(content, 'slowlog', `;slowlog = ${slowPath}`);
    content = replaceIniKey(content, 'request_slowlog_timeout', 'request_slowlog_timeout = 0');
  }
  fs.writeFileSync(ctx.pool, content, 'utf8');

  const reloaded = await reloadService(ctx.item);
  return { enabled: !!enabled, timeout: enabled ? secs : 0, path: slowPath, poolPath: ctx.pool, reloaded };
}

function getJob(key) {
  return jobService.snapshot(key);
}

// Nginx fastcgi_pass 目标：从 php-fpm pool 配置解析 listen（unix socket 补 unix: 前缀）
async function getFpmListen(version = '') {
  const item = findItem(version);
  if (!item) return '';
  const ctx = await resolveContext(item.version);
  if (!ctx.pool || !fs.existsSync(ctx.pool)) return '';
  const m = /^\s*listen\s*=\s*(.+?)\s*$/m.exec(fs.readFileSync(ctx.pool, 'utf8'));
  if (!m) return '';
  return m[1].startsWith('/') ? `unix:${m[1]}` : m[1];
}

module.exports = {
  getStatus,
  control,
  listVersions,
  getFpmListen,
  getDefaultVersion,
  getSettings,
  updateSettings,
  getExtensions,
  installExtension,
  uninstallExtension,
  getLogs,
  clearLogs,
  setSlowlog,
  getJob,
  EDITABLE_INI_KEYS,
  EXT_CATALOG,
};
