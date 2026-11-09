const mysql = require('mysql2/promise');
const { run } = require('./commandRunner');

// 系统库只做浏览，禁止在面板里改数据，避免误伤 MySQL 自身
const SYSTEM_DBS = new Set(['information_schema', 'performance_schema', 'sys', 'mysql']);
const MAX_PAGE_SIZE = 200;

function clientError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// 标识符统一用反引号包裹；库名/表名/列名都先经过存在性校验，避免拼接注入
function ident(name) {
  const value = String(name ?? '');
  if (!value || value.length > 64 || value.includes('\u0000')) throw clientError('标识符非法');
  return `\`${value.replace(/`/g, '``')}\``;
}

let socketPathCache = '';
let pool;

// 面板以 root 运行，MySQL root 走 unix socket 认证；socket 路径随发行版不同，先问一次服务端
async function resolveSocketPath() {
  if (socketPathCache) return socketPathCache;
  try {
    const { stdout } = await run('mysql', ['-N', '-B', '-e', 'SHOW VARIABLES LIKE "socket";']);
    const value = String(stdout || '').trim().split('\n')[0]?.split('\t')[1];
    if (value) {
      socketPathCache = value.trim();
      return socketPathCache;
    }
  } catch (err) {
    // 取不到时退回常见默认路径
  }
  socketPathCache = '/var/lib/mysql/mysql.sock';
  return socketPathCache;
}

async function getPool() {
  if (pool) return pool;
  const socketPath = await resolveSocketPath();
  pool = mysql.createPool({
    socketPath,
    user: 'root',
    connectionLimit: 4,
    waitForConnections: true,
    charset: 'utf8mb4',
    // 日期按字符串返回，避免时区换算与环境差异
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    connectTimeout: 10000,
  });
  return pool;
}

async function assertDatabase(dbName) {
  const name = String(dbName || '');
  if (!name) throw clientError('数据库名不能为空');
  const p = await getPool();
  const [rows] = await p.query('SHOW DATABASES');
  const names = rows.map((row) => Object.values(row)[0]);
  if (!names.includes(name)) throw clientError('数据库不存在', 404);
  return name;
}

async function assertTable(dbName, tableName) {
  const db = await assertDatabase(dbName);
  const table = String(tableName || '');
  if (!table) throw clientError('表名不能为空');
  const p = await getPool();
  const [rows] = await p.query(`SHOW TABLES FROM ${ident(db)}`);
  const names = rows.map((row) => Object.values(row)[0]);
  if (!names.includes(table)) throw clientError('数据表不存在', 404);
  return { db, table };
}

function assertWritable(dbName) {
  if (SYSTEM_DBS.has(dbName)) throw clientError('系统数据库只读，不能在面板中修改');
}

// Buffer（BLOB/BINARY）无法直接 JSON 化，转成标记对象由前端只读展示
function normalizeValue(value) {
  if (Buffer.isBuffer(value)) {
    return { binary: true, base64: value.toString('base64'), length: value.length };
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function normalizeRows(rows) {
  return rows.map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) out[key] = normalizeValue(value);
    return out;
  });
}

// 数据表清单：带上引擎、行数、占用空间，供左侧列表展示
async function listTables(dbName) {
  const db = await assertDatabase(dbName);
  const p = await getPool();
  const [rows] = await p.query(`SHOW TABLE STATUS FROM ${ident(db)}`);
  return rows.map((row) => ({
    name: row.Name,
    engine: row.Engine || '',
    rows: Number(row.Rows) || 0,
    dataLength: Number(row.Data_length) || 0,
    indexLength: Number(row.Index_length) || 0,
    collation: row.Collation || '',
    comment: row.Comment || '',
    // 视图没有引擎，界面上禁用行编辑
    isView: !row.Engine,
  }));
}

async function getStructure(dbName, tableName) {
  const { db, table } = await assertTable(dbName, tableName);
  const p = await getPool();
  const [columns] = await p.query(`SHOW FULL COLUMNS FROM ${ident(table)} FROM ${ident(db)}`);
  const [indexes] = await p.query(`SHOW INDEX FROM ${ident(table)} FROM ${ident(db)}`);
  const primaryKey = indexes
    .filter((row) => row.Key_name === 'PRIMARY')
    .sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index))
    .map((row) => row.Column_name);
  return {
    columns: columns.map((row) => ({
      name: row.Field,
      type: row.Type,
      collation: row.Collation || '',
      nullable: row.Null === 'YES',
      key: row.Key || '',
      default: row.Default,
      extra: row.Extra || '',
      comment: row.Comment || '',
      // 仅 auto_increment 与真正的生成列（VIRTUAL/STORED GENERATED）不可赋值；
      // DEFAULT_GENERATED 只是默认值表达式，仍然可写
      generated: /auto_increment|virtual generated|stored generated/i.test(row.Extra || ''),
    })),
    primaryKey,
    indexes: indexes.map((row) => ({
      name: row.Key_name,
      unique: Number(row.Non_unique) === 0,
      column: row.Column_name,
      seq: Number(row.Seq_in_index),
    })),
  };
}

async function getRows(dbName, tableName, options = {}) {
  const { db, table } = await assertTable(dbName, tableName);
  const structure = await getStructure(db, table);
  const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(options.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;
  const p = await getPool();

  const orderBy = String(options.orderBy || '');
  const columnNames = structure.columns.map((col) => col.name);
  const dir = String(options.orderDir || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  // 默认按主键排序，保证翻页稳定；无主键时按第一列
  const sortColumn = columnNames.includes(orderBy)
    ? orderBy
    : structure.primaryKey[0] || columnNames[0];

  const [countRows] = await p.query(`SELECT COUNT(*) AS total FROM ${ident(db)}.${ident(table)}`);
  const total = Number(Object.values(countRows[0] || {})[0]) || 0;

  const orderSql = sortColumn ? ` ORDER BY ${ident(sortColumn)} ${dir}` : '';
  const [rows] = await p.query(
    `SELECT * FROM ${ident(db)}.${ident(table)}${orderSql} LIMIT ${pageSize} OFFSET ${offset}`
  );

  return {
    columns: structure.columns,
    primaryKey: structure.primaryKey,
    rows: normalizeRows(rows),
    total,
    page,
    pageSize,
  };
}

function pickValues(structure, values, { forUpdate = false } = {}) {
  const allowed = new Map(structure.columns.map((col) => [col.name, col]));
  const entries = Object.entries(values || {});
  if (!entries.length) throw clientError('没有可写入的字段');
  const out = {};
  for (const [name, value] of entries) {
    const column = allowed.get(name);
    if (!column) throw clientError(`字段不存在：${name}`);
    if (column.generated) throw clientError(`字段 ${name} 由 MySQL 自动生成，不能直接赋值`);
    out[name] = value === undefined ? null : value;
  }
  if (forUpdate && !Object.keys(out).length) throw clientError('没有需要更新的字段');
  return out;
}

async function insertRow(dbName, tableName, values) {
  const { db, table } = await assertTable(dbName, tableName);
  assertWritable(db);
  const structure = await getStructure(db, table);
  const picked = pickValues(structure, values);
  const columns = Object.keys(picked);
  const placeholders = columns.map(() => '?');
  // auto_increment 留空时写 NULL，由 MySQL 生成值，避免空串导致类型错误
  const params = columns.map((name) => {
    const column = structure.columns.find((col) => col.name === name);
    const value = picked[name];
    if (/auto_increment/i.test(column?.extra || '') && (value === '' || value === undefined)) return null;
    return value;
  });
  const p = await getPool();
  const [result] = await p.query(
    `INSERT INTO ${ident(db)}.${ident(table)} (${columns.map(ident).join(', ')}) VALUES (${placeholders.join(', ')})`,
    params
  );
  return { insertId: normalizeValue(result.insertId), affectedRows: result.affectedRows };
}

async function updateRow(dbName, tableName, key, changes) {
  const { db, table } = await assertTable(dbName, tableName);
  assertWritable(db);
  const structure = await getStructure(db, table);
  if (!structure.primaryKey.length) throw clientError('该表没有主键，无法定位要修改的行');
  const where = buildWhere(structure, key);
  const picked = pickValues(structure, changes, { forUpdate: true });
  const columns = Object.keys(picked);
  const setSql = columns.map((name) => `${ident(name)} = ?`).join(', ');
  const params = [...columns.map((name) => picked[name]), ...where.params];
  const p = await getPool();
  const [result] = await p.query(
    `UPDATE ${ident(db)}.${ident(table)} SET ${setSql} WHERE ${where.sql} LIMIT 1`,
    params
  );
  return { affectedRows: result.affectedRows };
}

async function deleteRow(dbName, tableName, key) {
  const { db, table } = await assertTable(dbName, tableName);
  assertWritable(db);
  const structure = await getStructure(db, table);
  if (!structure.primaryKey.length) throw clientError('该表没有主键，无法删除指定的行');
  const where = buildWhere(structure, key);
  const p = await getPool();
  const [result] = await p.query(
    `DELETE FROM ${ident(db)}.${ident(table)} WHERE ${where.sql} LIMIT 1`,
    where.params
  );
  return { affectedRows: result.affectedRows };
}

// 主键条件：要求调用方把全部主键列都传上来，缺一列就拒绝，避免误删/误改整表
function buildWhere(structure, key) {
  const provided = key || {};
  const parts = [];
  const params = [];
  for (const name of structure.primaryKey) {
    if (!Object.prototype.hasOwnProperty.call(provided, name)) {
      throw clientError(`缺少主键字段：${name}`);
    }
    parts.push(`${ident(name)} = ?`);
    params.push(provided[name]);
  }
  return { sql: parts.join(' AND '), params };
}

module.exports = {
  listTables,
  getStructure,
  getRows,
  insertRow,
  updateRow,
  deleteRow,
  SYSTEM_DBS,
};
