const logger = require('../utils/logger');

// 站点开通进度的内存态存储：仅用于「创建站点」期间给前端轮询展示，不落库。
// 终态后保留一段时间便于前端补查（含 504 兜底），过期即回收，避免无限增长。
const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 100;

const ops = new Map();

function provisionError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function prune() {
  const now = Date.now();
  for (const [opId, op] of ops) {
    if (op.endedAt && now - op.endedAt > TTL_MS) ops.delete(opId);
  }
  if (ops.size <= MAX_ENTRIES) return;
  // 超出上限时按开始时间从旧到新回收已结束的条目，绝不回收进行中的
  const removable = [...ops.values()]
    .filter((op) => op.status !== 'running')
    .sort((a, b) => a.startedAt - b.startedAt);
  let overflow = ops.size - MAX_ENTRIES;
  for (const op of removable) {
    if (overflow <= 0) break;
    ops.delete(op.opId);
    overflow -= 1;
  }
}

function findStep(op, key) {
  return op.steps.find((step) => step.key === key) || null;
}

// 把整条流程标记为失败：运行中（或首个待执行）的步骤记为失败，其余待执行记为「前置失败，未执行」
function markOpenFailed(op, message) {
  if (op.status !== 'running') return;
  const text = String(message || '');
  const target = op.steps.find((step) => step.state === 'running')
    || op.steps.find((step) => step.state === 'pending');
  if (target) {
    target.state = 'failed';
    target.message = text;
    target.endedAt = Date.now();
  }
  for (const step of op.steps) {
    if (step.state === 'pending') {
      step.state = 'skipped';
      step.skippedReason = 'blocked';
      step.message = '';
      step.endedAt = Date.now();
    }
  }
  op.status = 'failed';
  op.error = text;
  op.endedAt = Date.now();
  logger.info('Provision end', { opId: op.opId, status: op.status });
}

// reporter：nginxService 只见这个对象，因此其内部必须吞掉所有异常，
// 进度跟踪的任何故障都不能传导为建站失败。
function createReporter(op) {
  const safe = (fn) => (...args) => {
    try {
      fn(...args);
    } catch (err) {
      logger.warn('Provision reporter failed', { opId: op.opId, error: err.message });
    }
  };

  const setState = (key, state, message, skippedReason) => {
    if (op.status !== 'running') return;
    const step = findStep(op, key);
    if (!step) return;
    step.state = state;
    if (message !== undefined) step.message = String(message || '');
    if (skippedReason !== undefined) step.skippedReason = skippedReason;
    if (state === 'running') step.startedAt = Date.now();
    if (state === 'done' || state === 'failed' || state === 'skipped') step.endedAt = Date.now();
  };

  return {
    begin: safe((key) => setState(key, 'running', '', null)),
    // 子阶段提示：只更新文案，不改变状态，因此步骤状态只变两次（等待中 → 进行中 → 完成）
    note: safe((key, message) => {
      if (op.status !== 'running') return;
      const step = findStep(op, key);
      if (step) step.message = String(message || '');
    }),
    complete: safe((key, message) => setState(key, 'done', message, null)),
    fail: safe((key, message) => setState(key, 'failed', message, null)),
    skip: safe((key, reason, message) => setState(key, 'skipped', message, reason || 'disabled')),
    failOpen: safe((message) => markOpenFailed(op, message)),
  };
}

/**
 * 开始一次开通流程
 * @returns reporter 供 nginxService.createSite 逐步上报
 */
function begin(opId, { steps, user, name, domain } = {}) {
  prune();
  if (ops.has(opId)) throw provisionError(`开通流程已存在：${opId}`, 409);
  const now = Date.now();
  const op = {
    opId,
    user: String(user || ''),
    status: 'running',
    name: String(name || ''),
    domain: String(domain || ''),
    startedAt: now,
    endedAt: null,
    steps: (steps || []).map((step) => ({
      key: step.key,
      state: 'pending',
      message: '',
      skippedReason: null,
      startedAt: null,
      endedAt: null,
    })),
    result: null,
    warnings: [],
    error: null,
  };
  ops.set(opId, op);
  logger.info('Provision begin', { opId, name: op.name, domain: op.domain });
  return createReporter(op);
}

// 快照：仅返回前端需要的字段，剔除 const content（整份 nginx 配置文本）避免响应体膨胀
function pickResult(result) {
  if (!result) return null;
  const { name, file, root, type, fpmListen, defaultPage, reloaded, ssl, database } = result;
  return { name, file, root, type, fpmListen, defaultPage, reloaded, ssl, database };
}

function get(opId, username) {
  prune();
  const op = ops.get(opId);
  if (!op) return null;
  // 只能读取自己发起的流程
  if (username !== undefined && op.user && op.user !== String(username)) return null;
  return {
    opId: op.opId,
    status: op.status,
    name: op.name,
    domain: op.domain,
    startedAt: op.startedAt,
    endedAt: op.endedAt,
    steps: op.steps.map((step) => ({ ...step })),
    result: op.result,
    warnings: op.warnings.slice(),
    error: op.error,
  };
}

function finish(opId, result, warnings) {
  const op = ops.get(opId);
  if (!op || op.status !== 'running') return;
  for (const step of op.steps) {
    // 兜底补齐：createSite 正常返回即代表已按请求完成开通，
    // 未被显式置态的步骤不应在成功流程里停留在「等待中」
    if (step.state === 'running' || step.state === 'pending') {
      step.state = 'done';
      step.endedAt = Date.now();
    }
  }
  op.status = 'done';
  op.result = pickResult(result);
  op.warnings = Array.isArray(warnings) ? warnings.slice() : [];
  op.endedAt = Date.now();
  logger.info('Provision end', { opId, status: op.status });
}

function fail(opId, message) {
  const op = ops.get(opId);
  if (!op) return;
  markOpenFailed(op, message);
}

module.exports = { begin, get, finish, fail };