const fs = require('fs');
const path = require('path');
const { run } = require('./commandRunner');
const mysqlService = require('./mysqlService');

// 备份文件统一落在面板数据目录下（data/ 已被 .gitignore 排除）
const BACKUP_ROOT = path.join(__dirname, '../../data/mysql-backups');
const DB_NAME_RE = /^[A-Za-z0-9_]+$/;
// 全量：<库名>-<时间戳>.sql；仅结构：<库名>-<时间戳>-schema.sql（两者不能同名，否则会互相覆盖）
const STAMP_RE = /^\d{8}-\d{6}(-schema)?\.sql$/;
// 系统库不允许备份/恢复，与列表过滤保持一致
const SYSTEM_DBS = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);
// 导出/导入耗时随库体积增长，放宽超时
const DUMP_TIMEOUT = 600000;
// execFile 无法向 mysql 客户端喂 stdin，恢复走 bash 重定向；路径与库名均已严格校验
const MYSQL_BIN = '/usr/bin/mysql';

function clientError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function assertDbName(dbName) {
  const name = String(dbName || '').trim();
  if (!DB_NAME_RE.test(name)) throw clientError('非法数据库名称');
  if (SYSTEM_DBS.has(name.toLowerCase())) throw clientError('系统库不允许备份');
  return name;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 备份文件名固定为 <库名>-<时间戳>.sql，且解析后必须仍位于备份目录内
function resolveBackupPath(dbName, fileName) {
  const key = assertDbName(dbName);
  const name = String(fileName || '').trim();
  if (!name || name.includes('/') || name.includes('\\') || !name.startsWith(`${key}-`)) {
    throw clientError('非法备份文件名');
  }
  if (!STAMP_RE.test(name.slice(key.length + 1))) throw clientError('非法备份文件名');
  const abs = path.resolve(path.join(BACKUP_ROOT, name));
  if (!abs.startsWith(path.resolve(BACKUP_ROOT) + path.sep)) throw clientError('非法备份路径');
  return { name, abs };
}

async function listDatabases() {
  return mysqlService.listDatabases();
}

async function assertDatabaseExists(dbName) {
  const list = await listDatabases();
  if (!list.includes(dbName)) throw clientError('数据库不存在', 404);
}

async function createBackup(dbName, { schemaOnly = false } = {}) {
  const key = assertDbName(dbName);

  const status = await mysqlService.getStatus();
  if (status !== 'active') throw clientError('MySQL 未运行，无法备份数据库');
  await assertDatabaseExists(key);

  await fs.promises.mkdir(BACKUP_ROOT, { recursive: true });
  const name = `${key}-${stamp()}${schemaOnly ? '-schema' : ''}.sql`;
  const dest = path.join(BACKUP_ROOT, name);

  // --result-file 让 mysqldump 直接把结果写盘，避免大库 dump 撑爆 Node 的 stdout 缓冲
  const args = [
    '--single-transaction',
    '--quick',
    '--routines',
    '--events',
    '--triggers',
    '--default-character-set=utf8mb4',
    '--result-file', dest,
  ];
  if (schemaOnly) args.push('--no-data', '--skip-triggers');
  args.push(key);

  const result = await run('mysqldump', args, { timeout: DUMP_TIMEOUT });

  const stat = await fs.promises.stat(dest).catch(() => null);
  if (!stat || stat.size === 0) {
    await fs.promises.unlink(dest).catch(() => {});
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 300);
    throw clientError(`备份失败：${detail || `mysqldump 退出码 ${result.exitCode}`}`, 500);
  }
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 300);
    throw clientError(`备份失败：${detail || `mysqldump 退出码 ${result.exitCode}`}`, 500);
  }

  return {
    file: name,
    size: stat.size,
    createdAt: stat.mtime.toISOString(),
    schemaOnly: Boolean(schemaOnly),
  };
}

async function listBackups(dbName) {
  const key = assertDbName(dbName);
  if (!fs.existsSync(BACKUP_ROOT)) return { items: [], dir: BACKUP_ROOT };
  const names = await fs.promises.readdir(BACKUP_ROOT);
  const items = [];
  for (const name of names) {
    if (!name.startsWith(`${key}-`) || !STAMP_RE.test(name.slice(key.length + 1))) continue;
    const stat = await fs.promises.stat(path.join(BACKUP_ROOT, name)).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    items.push({
      file: name,
      size: stat.size,
      createdAt: stat.mtime.toISOString(),
      // 仅结构备份恢复时会先删表再建空表，前端需要更强的覆盖提示
      schemaOnly: name.endsWith('-schema.sql'),
    });
  }
  items.sort((a, b) => b.file.localeCompare(a.file));
  return { items, dir: BACKUP_ROOT };
}

async function resolveForDownload(dbName, fileName) {
  const { name, abs } = resolveBackupPath(dbName, fileName);
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat) throw clientError('备份文件不存在', 404);
  return { absPath: abs, filename: name };
}

async function deleteBackup(dbName, fileName) {
  const { name, abs } = resolveBackupPath(dbName, fileName);
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat) throw clientError('备份文件不存在', 404);
  await fs.promises.unlink(abs);
  return { file: name };
}

// 恢复备份：导入到与文件名同名的库中（文件名前缀已校验为当前库名），同名表会被覆盖
async function restoreBackup(dbName, fileName) {
  const key = assertDbName(dbName);
  const { name, abs } = resolveBackupPath(key, fileName);
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat) throw clientError('备份文件不存在', 404);

  const status = await mysqlService.getStatus();
  if (status !== 'active') throw clientError('MySQL 未运行，无法恢复数据库');
  await assertDatabaseExists(key);

  const result = await run(
    'bash',
    ['-c', `${MYSQL_BIN} --default-character-set=utf8mb4 ${key} < '${abs}'`],
    { timeout: DUMP_TIMEOUT }
  );
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 300);
    throw clientError(`恢复失败：${detail || `mysql 退出码 ${result.exitCode}`}`, 500);
  }

  return { file: name, size: stat.size, dbName: key };
}

module.exports = {
  createBackup,
  listBackups,
  deleteBackup,
  restoreBackup,
  resolveForDownload,
  BACKUP_ROOT,
};