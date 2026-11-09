const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { run } = require('./commandRunner');

const execFileAsync = promisify(execFile);

// Geth 由系统服务托管，面板只做状态展示与服务控制，
// 安装方式、数据目录、启动参数均以 systemd 单元的实际配置为准
const SERVICE = 'geth';
const TIMER_UNIT = 'geth-idle-block.timer';
const DEFAULT_HTTP_PORT = '8545';
const FALLBACK_BINARIES = ['/usr/local/bin/geth', '/usr/bin/geth'];
const UNIT_PATHS = [
  '/etc/systemd/system/geth.service',
  '/usr/lib/systemd/system/geth.service',
  '/lib/systemd/system/geth.service',
];
const TIMER_PATHS = [
  '/etc/systemd/system/geth-idle-block.timer',
  '/usr/lib/systemd/system/geth-idle-block.timer',
  '/lib/systemd/system/geth-idle-block.timer',
];

let unitCache = null;
let unitCacheAt = 0;
const UNIT_CACHE_TTL = 30 * 1000;
// 数据目录可能很大，du 结果短暂缓存，避免页面轮询反复扫描磁盘
const dirSizeCache = new Map();
const DIR_SIZE_TTL = 60 * 1000;

function unitExists() {
  return UNIT_PATHS.some((p) => fs.existsSync(p));
}

function timerUnitExists() {
  return TIMER_PATHS.some((p) => fs.existsSync(p));
}

// 解析 ExecStart 中的关键参数（不带 shell，按空白切分即可覆盖常见写法）
function parseExecStart(raw) {
  const text = String(raw || '').trim();
  const binary = (text.split(/\s+/)[0] || '').replace(/^["']|["']$/g, '');
  const valueOf = (flag) => {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:^|\\s)${escaped}(?:=|\\s+)([^\\s]+)`).exec(text);
    return m ? m[1] : '';
  };
  const hasFlag = (flag) => {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`).test(text);
  };
  return {
    execStart: text,
    binary,
    datadir: valueOf('--datadir'),
    httpAddr: valueOf('--http.addr') || '127.0.0.1',
    httpPort: valueOf('--http.port') || DEFAULT_HTTP_PORT,
    networkId: valueOf('--networkid'),
    unlock: valueOf('--unlock'),
    dev: hasFlag('--dev'),
    mine: hasFlag('--mine'),
  };
}

async function readUnit(force = false) {
  const now = Date.now();
  if (!force && unitCache && now - unitCacheAt < UNIT_CACHE_TTL) return unitCache;
  const cat = await run('systemctl', ['cat', SERVICE], { timeout: 10000 });
  const content = cat.exitCode === 0 ? cat.stdout : '';
  const execLine = (content.split('\n').find((line) => /^\s*ExecStart=/.test(line)) || '')
    .replace(/^\s*ExecStart=\s*/, '');
  const info = {
    exists: !!content || unitExists(),
    content,
    parsed: parseExecStart(execLine),
  };
  unitCache = info;
  unitCacheAt = now;
  return info;
}

// 优先使用服务单元里的可执行文件，回退到常见安装路径
function resolveBinary(parsed) {
  const candidates = [parsed.binary, ...FALLBACK_BINARIES].filter(Boolean);
  for (const bin of candidates) {
    if (!bin.startsWith('/')) continue;
    try {
      if (fs.statSync(bin).isFile()) return bin;
    } catch (e) {
      // 尝试下一个候选路径
    }
  }
  return '';
}

async function getVersion(binary) {
  if (!binary) return '';
  try {
    const { stdout } = await execFileAsync(binary, ['version'], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    const m = /Version:\s*([^\s]+)/.exec(stdout || '');
    return m ? m[1] : '';
  } catch (e) {
    return '';
  }
}

async function getServiceStatus() {
  const result = await run('systemctl', ['is-active', SERVICE], { timeout: 10000 });
  return result.exitCode === 0 ? result.stdout.trim() : 'inactive';
}

async function getServiceDetail() {
  const result = await run('systemctl', [
    'show', SERVICE, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'ActiveEnterTimestamp',
  ], { timeout: 10000 });
  const map = {};
  for (const line of (result.stdout || '').split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) map[line.slice(0, idx)] = line.slice(idx + 1).trim();
  }
  return {
    status: map.ActiveState || 'inactive',
    subState: map.SubState || '',
    pid: Number(map.MainPID) || 0,
    startedAt: map.ActiveEnterTimestamp || '',
  };
}

async function getTimerState() {
  let exists = timerUnitExists();
  if (!exists) {
    const cat = await run('systemctl', ['cat', TIMER_UNIT], { timeout: 10000 });
    exists = cat.exitCode === 0 && !!cat.stdout;
  }
  if (!exists) return { exists: false, active: '', enabled: '' };
  const [active, enabled] = await Promise.all([
    run('systemctl', ['is-active', TIMER_UNIT], { timeout: 10000 }),
    run('systemctl', ['is-enabled', TIMER_UNIT], { timeout: 10000 }),
  ]);
  return {
    exists: true,
    active: (active.stdout || '').trim() || 'inactive',
    enabled: (enabled.stdout || '').trim() || 'disabled',
  };
}

async function getDirSize(dir) {
  if (!dir || !fs.existsSync(dir)) return '';
  const cached = dirSizeCache.get(dir);
  if (cached && Date.now() - cached.at < DIR_SIZE_TTL) return cached.value;
  const result = await run('du', ['-sh', dir], { timeout: 60000 });
  const value = result.exitCode === 0 ? ((result.stdout || '').trim().split(/\s+/)[0] || '') : '';
  dirSizeCache.set(dir, { value, at: Date.now() });
  return value;
}

// 批量调用 JSON-RPC：一次 curl 取回区块高度、链 ID、节点数等运行数据
async function rpcBatch(host, port, methods) {
  const payload = JSON.stringify(methods.map((method, index) => ({
    jsonrpc: '2.0',
    id: index + 1,
    method,
    params: [],
  })));
  const result = await run('curl', [
    '-s', '-m', '5',
    '-X', 'POST',
    '-H', 'Content-Type: application/json',
    '--data-binary', payload,
    `http://${host}:${port}`,
  ], { timeout: 8000 });
  if (result.exitCode !== 0 || !result.stdout) return null;
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (e) {
    return null;
  }
  const list = Array.isArray(data) ? data : [data];
  const map = {};
  for (const item of list) {
    if (item && item.id > 0 && item.result !== undefined) {
      map[methods[item.id - 1]] = item.result;
    }
  }
  return Object.keys(map).length ? map : null;
}

function parseHexNumber(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) return null;
  return parseInt(value, 16);
}

// 应用中心卡片使用的轻量状态：只探测安装情况、版本与服务状态
async function getSummary() {
  const unit = await readUnit();
  const binary = resolveBinary(unit.parsed);
  const installed = !!binary || unit.exists;
  if (!installed) return { installed: false, service: SERVICE };
  return {
    installed: true,
    service: SERVICE,
    serviceExists: unit.exists,
    version: await getVersion(binary),
    status: await getServiceStatus(),
  };
}

async function getOverview() {
  const unit = await readUnit();
  const binary = resolveBinary(unit.parsed);
  const installed = !!binary || unit.exists;
  if (!installed) {
    return {
      installed: false,
      service: SERVICE,
      serviceExists: false,
      status: 'inactive',
      version: '',
    };
  }

  const parsed = unit.parsed;
  const [version, detail, timer, datadirSize] = await Promise.all([
    getVersion(binary),
    getServiceDetail(),
    getTimerState(),
    getDirSize(parsed.datadir),
  ]);

  const port = /^\d+$/.test(parsed.httpPort) ? parsed.httpPort : DEFAULT_HTTP_PORT;
  const host = !parsed.httpAddr || parsed.httpAddr === '0.0.0.0' ? '127.0.0.1' : parsed.httpAddr;
  let rpc = null;
  if (detail.status === 'active') {
    rpc = await rpcBatch(host, port, [
      'eth_blockNumber',
      'eth_chainId',
      'net_version',
      'net_peerCount',
      'eth_syncing',
      'eth_mining',
      'web3_clientVersion',
    ]);
  }

  const peerCount = rpc ? parseHexNumber(rpc.net_peerCount) : null;
  const chainId = rpc ? parseHexNumber(rpc.eth_chainId) : null;
  const networkId = rpc && rpc.net_version !== undefined
    ? String(rpc.net_version)
    : (parsed.networkId || '');

  return {
    installed: true,
    service: SERVICE,
    serviceExists: unit.exists,
    status: detail.status,
    subState: detail.subState,
    pid: detail.pid,
    startedAt: detail.startedAt,
    version,
    clientVersion: rpc && rpc.web3_clientVersion ? String(rpc.web3_clientVersion) : '',
    blockNumber: rpc ? parseHexNumber(rpc.eth_blockNumber) : null,
    chainId,
    networkId,
    peerCount,
    syncing: rpc && rpc.eth_syncing !== undefined ? rpc.eth_syncing : null,
    mining: rpc && typeof rpc.eth_mining === 'boolean' ? rpc.eth_mining : null,
    rpcOk: !!rpc,
    datadir: parsed.datadir || '',
    datadirSize,
    httpAddr: parsed.httpAddr,
    httpPort: port,
    dev: parsed.dev,
    mineFlag: parsed.mine,
    unlock: parsed.unlock,
    execStart: parsed.execStart,
    timer,
  };
}

async function getLogs(lines = 200) {
  const count = Math.min(Math.max(parseInt(lines, 10) || 200, 20), 1000);
  const result = await run('journalctl', [
    '-u', SERVICE, '-n', String(count), '--no-pager', '-o', 'cat',
  ], { timeout: 15000 });
  if (result.exitCode !== 0) return '';
  return (result.stdout || '').trim();
}

async function control(action) {
  const allowed = ['start', 'stop', 'restart'];
  if (!allowed.includes(action)) throw new Error('非法操作');
  const unit = await readUnit(true);
  const binary = resolveBinary(unit.parsed);
  if (!binary && !unit.exists) throw new Error('本机未安装 Geth');
  if (!unit.exists) throw new Error('未找到 geth.service 服务单元');
  const result = await run('systemctl', [action, SERVICE], { timeout: 60000 });
  if (result.exitCode !== 0) {
    const message = (result.stderr || result.stdout || '').trim();
    throw new Error(message || `systemctl ${action} geth 执行失败`);
  }
  unitCacheAt = 0;
  return getOverview();
}

module.exports = { getSummary, getOverview, getLogs, control, SERVICE };
