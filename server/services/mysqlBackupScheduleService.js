const store = require('../models/store');
const mysqlBackups = require('./mysqlBackupService');
const logger = require('../utils/logger');

// 每分钟检查一次是否有到期的备份任务；任务粒度最细为每小时，足够
const TICK_MS = 60 * 1000;
let timer = null;
// 正在执行的任务 id：避免同一任务在上一次 dump 未结束时重复触发
const running = new Set();

function validDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

// 计算下一次执行时间：以上次执行时间（没有则创建时间）为基准，
// 全部按服务器本地时区计算（两台面板均为 Asia/Shanghai）
function computeNextRun(task, from) {
  if (!task.enabled) return null;
  const base = from || validDate(task.lastRunAt) || validDate(task.createdAt) || new Date();
  const next = new Date(base);
  next.setSeconds(0, 0);

  if (task.frequency === 'hourly') {
    next.setMinutes(Number(task.minute) || 0);
    if (next <= base) next.setHours(next.getHours() + 1);
    return next;
  }

  next.setHours(Number(task.hour) || 0, Number(task.minute) || 0, 0, 0);
  if (task.frequency === 'weekly') {
    const weekday = Number.isInteger(Number(task.weekday)) ? Number(task.weekday) : 1;
    const diff = (weekday - next.getDay() + 7) % 7;
    next.setDate(next.getDate() + diff);
    if (next <= base) next.setDate(next.getDate() + 7);
    return next;
  }

  // daily
  if (next <= base) next.setDate(next.getDate() + 1);
  return next;
}

// 只清理自动备份，保留最新 keepCount 份；手动备份不参与
async function pruneAutoBackups(task) {
  const keep = Math.max(1, Number(task.keepCount) || 1);
  const { items } = await mysqlBackups.listBackups(task.databaseName);
  const auto = items.filter((item) => item.isAuto);
  for (const item of auto.slice(keep)) {
    try {
      await mysqlBackups.deleteBackup(task.databaseName, item.file);
    } catch (err) {
      logger.warn('Failed to prune scheduled database backup', {
        database: task.databaseName,
        file: item.file,
        error: err.message,
      });
    }
  }
}

async function runTask(task) {
  if (!task || running.has(task.id)) return null;
  running.add(task.id);
  try {
    const result = await mysqlBackups.createBackup(task.databaseName, { auto: true });
    store.markBackupTaskRun(task.id, {
      status: 'success',
      message: '自动备份完成',
      file: result.file,
    });
    await pruneAutoBackups(task);
    logger.info('Scheduled database backup succeeded', {
      id: task.id,
      database: task.databaseName,
      file: result.file,
    });
    return result;
  } catch (err) {
    const message = String(err.message || err).slice(0, 500);
    store.markBackupTaskRun(task.id, { status: 'failed', message });
    logger.error('Scheduled database backup failed', {
      id: task.id,
      database: task.databaseName,
      error: message,
    });
    throw err;
  } finally {
    running.delete(task.id);
  }
}

function tick() {
  const now = new Date();
  for (const task of store.listBackupTasks()) {
    if (!task.enabled || running.has(task.id)) continue;
    const next = computeNextRun(task);
    if (next && next <= now) {
      // 不阻塞其它任务的检查；错误已在 runTask 内记录
      runTask(task).catch(() => {});
    }
  }
}

function start() {
  if (timer) return;
  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  logger.info('Database backup scheduler started');
}

function stop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

function isRunning(id) {
  return running.has(Number(id));
}

module.exports = {
  computeNextRun,
  runTask,
  isRunning,
  start,
  stop,
};
