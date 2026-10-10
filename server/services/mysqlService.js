const crypto = require('crypto');
const { run } = require('./commandRunner');

const IDENT_RE = /^[A-Za-z0-9_]+$/;
const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
// 特殊字符只取 ASCII 中对 SQL 单引号字面量安全的符号，避免生成后还需额外转义
const PASSWORD_SPECIALS = '!@#%^*_-+=';
const PASSWORD_RE = /^[A-Za-z0-9!@#%^*_\-+=]+$/;

// 由域名派生合法的数据库名/用户名：abc.com -> abc_com
function normalizeName(domain) {
  const name = String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return name.slice(0, 32);
}

// MySQL 8.0+ 默认启用 validate_password(MEDIUM)：密码必须同时含大写、小写、数字和特殊字符，
// 否则 CREATE USER 会直接报「密码不满足当前策略」，因此四类字符都要保证至少出现一次
function generatePassword(length = 20) {
  const pick = (chars) => chars[crypto.randomBytes(1)[0] % chars.length];
  const out = [
    pick('ABCDEFGHJKLMNPQRSTUVWXYZ'),
    pick('abcdefghijkmnopqrstuvwxyz'),
    pick('23456789'),
    pick(PASSWORD_SPECIALS),
  ];
  const pool = PASSWORD_CHARS + PASSWORD_SPECIALS;
  while (out.length < length) out.push(pick(pool));
  // 打乱顺序，避免前四位固定为「大写+小写+数字+特殊字符」
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = crypto.randomBytes(1)[0] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

// MySQL 的 systemd 单元名随发行版不同（alinux/RHEL 为 mysqld、Debian 系为 mysql），
// 必须按实际存在的单元判定，否则状态会误判为 inactive（alinux4 上只有 mysqld.service）
const MYSQL_UNITS = ['mysqld', 'mysql'];
let unitCache = '';

async function mysqlUnit() {
  if (unitCache) return unitCache;
  for (const unit of MYSQL_UNITS) {
    const r = await run('systemctl', ['cat', `${unit}.service`]);
    if (r.exitCode === 0) {
      unitCache = unit;
      return unit;
    }
  }
  unitCache = MYSQL_UNITS[0];
  return unitCache;
}

async function getStatus() {
  const result = await run('systemctl', ['is-active', await mysqlUnit()]);
  return result.exitCode === 0 ? result.stdout.trim() : 'inactive';
}

async function control(action) {
  const allowed = ['start', 'stop', 'restart'];
  if (!allowed.includes(action)) throw new Error('非法操作');
  return run('systemctl', [action, await mysqlUnit()]);
}

async function getInfo() {
  try {
    const { stdout } = await run('mysqladmin', ['status']);
    return stdout.trim();
  } catch (err) {
    return '';
  }
}

async function listDatabases() {
  try {
    const { stdout } = await run('mysql', ['-e', 'SHOW DATABASES;']);
    return stdout.split('\n').slice(1).filter(Boolean);
  } catch (err) {
    return [];
  }
}

// 创建数据库并授权给同名用户：库名/用户名由调用方给出，密码必须为字母数字
async function createDatabase({ dbName, user, password } = {}) {
  const db = String(dbName || '').trim();
  const account = String(user || '').trim();
  const pwd = String(password || '').trim();

  if (!IDENT_RE.test(db)) throw new Error('数据库名称只能包含字母、数字和下划线');
  if (!IDENT_RE.test(account)) throw new Error('数据库用户名只能包含字母、数字和下划线');
  if (!pwd || !PASSWORD_RE.test(pwd)) throw new Error('数据库密码只能是字母或数字');

  const status = await getStatus();
  if (status !== 'active') throw new Error('MySQL 未运行，无法创建数据库');

  const sql = [
    `CREATE DATABASE IF NOT EXISTS \`${db}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    `CREATE USER IF NOT EXISTS '${account}'@'localhost' IDENTIFIED BY '${pwd}';`,
    `ALTER USER '${account}'@'localhost' IDENTIFIED BY '${pwd}';`,
    `GRANT ALL PRIVILEGES ON \`${db}\`.* TO '${account}'@'localhost';`,
    'FLUSH PRIVILEGES;',
  ].join(' ');

  const result = await run('mysql', ['-e', sql], { timeout: 30000 });
  if (result.exitCode !== 0) {
    throw new Error(`数据库创建失败：${(result.stderr || result.stdout || '').trim()}`);
  }

  return { dbName: db, user: account, password: pwd, host: 'localhost' };
}

// 重置数据库用户密码：存量库的密码只在建站/建库时展示过一次，MySQL 内仅有哈希，只能重置后重新记录
async function resetDatabasePassword({ dbName, user, password } = {}) {
  const db = String(dbName || '').trim();
  const account = String(user || '').trim();
  const pwd = String(password || '').trim();

  if (!IDENT_RE.test(db)) throw new Error('数据库名称只能包含字母、数字和下划线');
  if (!IDENT_RE.test(account)) throw new Error('数据库用户名只能包含字母、数字和下划线');
  if (!pwd || !PASSWORD_RE.test(pwd)) throw new Error('数据库密码只能是字母或数字');

  const status = await getStatus();
  if (status !== 'active') throw new Error('MySQL 未运行，无法重置数据库密码');

  const sql = [
    `CREATE USER IF NOT EXISTS '${account}'@'localhost' IDENTIFIED BY '${pwd}';`,
    `ALTER USER '${account}'@'localhost' IDENTIFIED BY '${pwd}';`,
    `GRANT ALL PRIVILEGES ON \`${db}\`.* TO '${account}'@'localhost';`,
    'FLUSH PRIVILEGES;',
  ].join(' ');

  const result = await run('mysql', ['-e', sql], { timeout: 30000 });
  if (result.exitCode !== 0) {
    throw new Error(`密码重置失败：${(result.stderr || result.stdout || '').trim()}`);
  }
  return { dbName: db, user: account, password: pwd };
}

// 判断数据库是否存在：删除站点前用于确认关联资源
async function databaseExists(dbName) {
  const db = String(dbName || '').trim();
  if (!IDENT_RE.test(db)) return false;
  try {
    // 不使用 LIKE 匹配：库名中的下划线在 LIKE 里是单字符通配符，会误判
    const { stdout } = await run('mysql', ['-N', '-B', '-e', 'SHOW DATABASES;']);
    return stdout.split('\n').map((line) => line.trim()).includes(db);
  } catch (err) {
    return false;
  }
}

// 删除数据库与同名用户：站点删除时清理关联资源，调用方负责二次确认
async function dropDatabase({ dbName, user } = {}) {
  const db = String(dbName || '').trim();
  const account = String(user || '').trim();

  if (!IDENT_RE.test(db)) throw new Error('数据库名称只能包含字母、数字和下划线');
  if (account && !IDENT_RE.test(account)) throw new Error('数据库用户名只能包含字母、数字和下划线');

  const status = await getStatus();
  if (status !== 'active') throw new Error('MySQL 未运行，无法删除数据库');

  const sql = [`DROP DATABASE IF EXISTS \`${db}\`;`];
  if (account) sql.push(`DROP USER IF EXISTS '${account}'@'localhost';`);
  sql.push('FLUSH PRIVILEGES;');

  const result = await run('mysql', ['-e', sql.join(' ')], { timeout: 30000 });
  if (result.exitCode !== 0) {
    throw new Error(`数据库删除失败：${(result.stderr || result.stdout || '').trim()}`);
  }
  return { dbName: db, user: account };
}

module.exports = {
  getStatus,
  control,
  getInfo,
  listDatabases,
  createDatabase,
  resetDatabasePassword,
  databaseExists,
  dropDatabase,
  normalizeName,
  generatePassword,
};
