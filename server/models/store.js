const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config/default');

const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

// 初始化表
function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      passwordHash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      totpSecret TEXT,
      totpEnabled INTEGER DEFAULT 0,
      totpVerified INTEGER DEFAULT 0,
      recoveryCodes TEXT,
      tokenVersion INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      action TEXT NOT NULL,
      detail TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS certificates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT UNIQUE NOT NULL,
      certPath TEXT,
      keyPath TEXT,
      issuedAt TEXT,
      expiresAt TEXT,
      autoRenew INTEGER DEFAULT 1,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS token_blocklist (
      jti TEXT PRIMARY KEY,
      expiresAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_blocklist_expires ON token_blocklist(expiresAt);

    CREATE TABLE IF NOT EXISTS mysql_databases (
      name TEXT PRIMARY KEY,
      username TEXT,
      password TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
initTables();

// 迁移：为已存在数据库补齐 TOTP 与 tokenVersion 字段
function migrate() {
  const columns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  const add = (name, def) => {
    if (!columns.includes(name)) {
      db.prepare(`ALTER TABLE users ADD COLUMN ${name} ${def}`).run();
    }
  };
  add('totpSecret', 'TEXT');
  add('totpEnabled', 'INTEGER DEFAULT 0');
  add('totpVerified', 'INTEGER DEFAULT 0');
  add('recoveryCodes', 'TEXT');
  add('tokenVersion', 'INTEGER DEFAULT 0');

  // 确保 token_blocklist 表和索引存在（initTables 已处理，此处再执行一次以防旧库）
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_blocklist (
      jti TEXT PRIMARY KEY,
      expiresAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_blocklist_expires ON token_blocklist(expiresAt);
  `);

  // 补齐 mysql_databases 的凭据字段（早期版本只登记库名）
  const dbColumns = db.prepare('PRAGMA table_info(mysql_databases)').all().map((c) => c.name);
  ['username', 'password', 'updatedAt'].forEach((name) => {
    if (!dbColumns.includes(name)) {
      db.prepare(`ALTER TABLE mysql_databases ADD COLUMN ${name} TEXT`).run();
    }
  });

  // 清理过期 blocklist
  cleanupExpiredBlocklist();
}
migrate();

function cleanupExpiredBlocklist() {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM token_blocklist WHERE expiresAt < ?').run(now);
}

module.exports = {
  db,

  // Users
  getUserByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  },
  createUser(username, passwordHash, role = 'admin') {
    return db.prepare('INSERT INTO users (username, passwordHash, role) VALUES (?, ?, ?)')
      .run(username, passwordHash, role);
  },
  hasUsers() {
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
    return row.count > 0;
  },
  updateUserTotp(username, { totpSecret, totpEnabled, totpVerified, recoveryCodes }) {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return { changes: 0 };

    const nextSecret = totpSecret === undefined ? user.totpSecret : JSON.stringify(totpSecret);
    const nextEnabled = totpEnabled === undefined ? user.totpEnabled : (totpEnabled ? 1 : 0);
    const nextVerified = totpVerified === undefined ? user.totpVerified : (totpVerified ? 1 : 0);
    const nextRecovery = recoveryCodes === undefined ? user.recoveryCodes : JSON.stringify(recoveryCodes);

    const stmt = db.prepare(`
      UPDATE users SET
        totpSecret = ?,
        totpEnabled = ?,
        totpVerified = ?,
        recoveryCodes = ?
      WHERE username = ?
    `);
    return stmt.run(nextSecret, nextEnabled, nextVerified, nextRecovery, username);
  },
  clearUserTotp(username) {
    return db.prepare(`
      UPDATE users SET totpSecret = NULL, totpEnabled = 0, totpVerified = 0, recoveryCodes = NULL
      WHERE username = ?
    `).run(username);
  },
  incrementTokenVersion(username) {
    return db.prepare('UPDATE users SET tokenVersion = tokenVersion + 1 WHERE username = ?').run(username);
  },

  // Token blocklist
  addTokenToBlocklist(jti, expiresAt) {
    return db.prepare('INSERT OR REPLACE INTO token_blocklist (jti, expiresAt) VALUES (?, ?)')
      .run(jti, Math.floor(expiresAt / 1000));
  },
  isTokenBlocklisted(jti) {
    const row = db.prepare('SELECT 1 as one FROM token_blocklist WHERE jti = ?').get(jti);
    return !!row;
  },

  // Audit logs
  addLog(username, action, detail = '') {
    return db.prepare('INSERT INTO audit_logs (username, action, detail) VALUES (?, ?, ?)')
      .run(username, action, detail);
  },
  getLogs(limit = 100) {
    return db.prepare('SELECT * FROM audit_logs ORDER BY createdAt DESC LIMIT ?').all(limit);
  },

  // Certificates
  getCertificates() {
    return db.prepare('SELECT * FROM certificates ORDER BY createdAt DESC').all();
  },
  getCertificateByDomain(domain) {
    return db.prepare('SELECT * FROM certificates WHERE domain = ?').get(domain);
  },
  saveCertificate(domain, certPath, keyPath, issuedAt, expiresAt, autoRenew = 1) {
    const stmt = db.prepare(`
      INSERT INTO certificates (domain, certPath, keyPath, issuedAt, expiresAt, autoRenew)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        certPath = excluded.certPath,
        keyPath = excluded.keyPath,
        issuedAt = excluded.issuedAt,
        expiresAt = excluded.expiresAt,
        autoRenew = excluded.autoRenew
    `);
    return stmt.run(domain, certPath, keyPath, issuedAt, expiresAt, autoRenew ? 1 : 0);
  },
  deleteCertificate(domain) {
    return db.prepare('DELETE FROM certificates WHERE domain = ?').run(domain);
  },

  // 面板创建/重置过密码的 MySQL 数据库凭据：列表默认只展示站点对应的库，
  // 手动新增的库无对应站点，登记后才能出现在列表中；密码只在此保存，MySQL 内仅有哈希
  saveDatabaseCredential(name, username, password) {
    return db.prepare(`
      INSERT INTO mysql_databases (name, username, password, updatedAt) VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        username = excluded.username,
        password = excluded.password,
        updatedAt = excluded.updatedAt
    `).run(name, username, password, new Date().toISOString());
  },
  getManagedDatabases() {
    return db.prepare('SELECT name FROM mysql_databases').all().map((row) => row.name);
  },
  listDatabaseCredentials() {
    return db.prepare('SELECT name, username, password, updatedAt FROM mysql_databases').all();
  },
  deleteManagedDatabase(name) {
    return db.prepare('DELETE FROM mysql_databases WHERE name = ?').run(name);
  },
};
