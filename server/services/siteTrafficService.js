const fs = require('fs');
const path = require('path');
const { listSites, NGINX_LOG_DIR } = require('./nginxService');

const SITE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const HOURS = 24;
// 单个日志文件最多解析尾部 16MB：站点日志量大时仍能覆盖远超 24 小时的行数，
// 同时避免把 GB 级日志整份读入内存
const MAX_TAIL_BYTES = 16 * 1024 * 1024;
const HOUR_MS = 3600000;
const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};
// main / combined 格式：host ident user [time] "request" status bytes ...
const LOG_LINE_RE = /^\S+ \S+ \S+ \[([^\]]+)\] "[^"]*" (\d{3}|-) (\d+|-)/;
const TIME_RE = /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/;

function clientError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function findSite(siteName) {
  const key = String(siteName || '').trim();
  if (!SITE_NAME_RE.test(key)) throw clientError('非法站点名称');
  const site = (await listSites()).find((item) => item.name === key);
  if (!site) throw clientError('站点不存在', 404);
  return site;
}

// 站点访问日志路径：优先配置里显式声明的 access_log，其次约定的站点独立日志路径。
// 全局日志不含 Host 字段（combined 格式），无法按站点归属，因此不做兜底统计
async function resolveAccessLog(site) {
  const content = await fs.promises.readFile(site.file, 'utf8').catch(() => '');
  const declared = /^\s*access_log\s+(\S+)/m.exec(content);
  if (declared && path.isAbsolute(declared[1])) return declared[1];
  const conventional = path.join(NGINX_LOG_DIR, `${site.name}.access.log`);
  if (fs.existsSync(conventional)) return conventional;
  return '';
}

// 读取文件尾部若干字节：日志通常远大于统计窗口，只需要最新的一段
async function readTail(filePath) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (err) {
    return { text: '', truncated: false };
  }
  if (!stat.isFile()) return { text: '', truncated: false };
  const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
  const length = stat.size - start;
  if (length <= 0) return { text: '', truncated: false };
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

// "28/Sep/2026:19:40:51 +0800" -> 毫秒时间戳（按日志携带的时区偏移换算）
function parseLogTime(raw) {
  const m = TIME_RE.exec(String(raw || '').trim());
  if (!m) return 0;
  const month = MONTHS[m[2]];
  if (month === undefined) return 0;
  const offset = m[7];
  const sign = offset[0] === '-' ? -1 : 1;
  const offsetMs = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5))) * 60000;
  return Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - offsetMs;
}

// 站点最近 N 小时流量：按小时聚合请求数、出站字节（body_bytes_sent）与错误请求数
async function getTraffic(siteName, hours = HOURS) {
  const site = await findSite(siteName);
  const window = Math.min(Math.max(parseInt(hours, 10) || HOURS, 1), 168);
  const logPath = await resolveAccessLog(site);
  if (!logPath) {
    return {
      available: false,
      reason: 'no-log',
      logPath: '',
      hours: window,
      expectedLogPath: path.join(NGINX_LOG_DIR, `${site.name}.access.log`),
    };
  }

  const now = Date.now();
  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const from = currentHour - (window - 1) * HOUR_MS;
  const buckets = [];
  const index = new Map();
  for (let i = 0; i < window; i += 1) {
    const ts = from + i * HOUR_MS;
    const bucket = { ts, requests: 0, bytes: 0, errors: 0 };
    buckets.push(bucket);
    index.set(ts, bucket);
  }

  let requests = 0;
  let bytes = 0;
  let errors = 0;
  let truncated = false;
  // 轮转后的 .1 与当前文件一并统计，避免跨日轮转时段数据缺失
  for (const file of [`${logPath}.1`, logPath]) {
    const tail = await readTail(file);
    if (!tail.text) continue;
    truncated = truncated || tail.truncated;
    for (const line of tail.text.split('\n')) {
      const m = LOG_LINE_RE.exec(line);
      if (!m) continue;
      const ts = parseLogTime(m[1]);
      if (!ts || ts < from || ts > now + 60000) continue;
      const status = m[2] === '-' ? 0 : Number(m[2]);
      const size = m[3] === '-' ? 0 : Number(m[3]);
      const bucket = index.get(Math.floor(ts / HOUR_MS) * HOUR_MS);
      requests += 1;
      bytes += Number.isFinite(size) ? size : 0;
      if (status >= 400) errors += 1;
      if (bucket) {
        bucket.requests += 1;
        bucket.bytes += Number.isFinite(size) ? size : 0;
        if (status >= 400) bucket.errors += 1;
      }
    }
  }

  return {
    available: true,
    logPath,
    hours: window,
    from,
    to: now,
    truncated,
    total: { requests, bytes, errors },
    hourly: buckets,
  };
}

module.exports = {
  getTraffic,
};