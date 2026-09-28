const fs = require('fs');
const path = require('path');
const { run } = require('./commandRunner');
const nginxService = require('./nginxService');

// 状态文件目录可通过环境变量覆盖，便于本地渲染断言与排查
const DATA_DIR = process.env.PANEL_DATA_DIR || '/opt/glass-panel/data';
const JAIL_LOCAL = '/etc/fail2ban/jail.local';
const FILTER_DIR = '/etc/fail2ban/filter.d';
const NGINX_LOG_DIR = '/var/log/nginx';
const SERVICE = 'fail2ban';
const BLACKLIST_JAIL = 'panel-blacklist';

const STATE_FILES = {
  sites: path.join(DATA_DIR, 'fail2ban-sites.json'),
  services: path.join(DATA_DIR, 'fail2ban-services.json'),
  whitelist: path.join(DATA_DIR, 'fail2ban-whitelist.json'),
  blacklist: path.join(DATA_DIR, 'fail2ban-blacklist.json'),
};
const BLACKLIST_LOG = path.join(DATA_DIR, 'fail2ban-blacklist.log');

// 内置白名单：回环 + 阿里云 Workbench 内网段，作为误封后的兜底通道，不允许删除
const BUILTIN_IGNOREIP = ['127.0.0.1/8', '::1', '100.64.0.0/10'];
const JAIL_NAME_RE = /^[A-Za-z0-9_-]+$/;
const SITE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULTS = { bantime: '1h', findtime: '10m', maxretry: '5' };

// 服务保护固定清单（sshd 与 nginx 的取值均为本机实测结论：
// banaction 走 iptables-multiport、backend 用 polling、sshd 必须显式 port 22,2222 且 mode=normal）
const SERVICE_PROTECTIONS = [
  {
    key: 'sshd',
    label: 'SSH 服务（防爆破）',
    filter: 'sshd',
    logpath: '/var/log/secure',
    port: '22,2222',
    extra: { mode: 'normal' },
    defaultEnabled: true,
  },
  {
    key: 'nginx-http-auth',
    label: 'Nginx 认证爆破（401）',
    filter: 'nginx-http-auth',
    logpath: '/var/log/nginx/error.log',
    port: 'http,https',
    defaultEnabled: false,
  },
  {
    key: 'nginx-bad-request',
    label: 'Nginx 恶意请求（400）',
    filter: 'nginx-bad-request',
    logpath: '/var/log/nginx/error.log',
    port: 'http,https',
    defaultEnabled: false,
  },
  {
    key: 'nginx-botsearch',
    label: 'Nginx 扫描器探测',
    filter: 'nginx-botsearch',
    logpath: '/var/log/nginx/access.log',
    port: 'http,https',
    defaultEnabled: false,
  },
];

// 站点保护过滤器：log 指定读取站点的 access 还是 error 日志
const SITE_FILTERS = [
  { key: 'botsearch', label: '扫描器/敏感路径探测', filter: 'nginx-botsearch', log: 'access' },
  { key: 'httpauth', label: '认证爆破（401）', filter: 'nginx-http-auth', log: 'error' },
  { key: 'badreq', label: '恶意请求（400）', filter: 'nginx-bad-request', log: 'error' },
  { key: 'notfound', label: '高频 404', filter: 'panel-nginx-404', log: 'access' },
];

// 面板自管过滤器：blacklist 每行一个 IP；404 按 nginx 默认 main 日志格式匹配
const PANEL_FILTERS = {
  'panel-blacklist.conf': [
    '[Definition]',
    'failregex = ^<HOST>\\s*$',
    'ignoreregex =',
    '',
  ].join('\n'),
  'panel-nginx-404.conf': [
    '[Definition]',
    // 对应 $remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent ...
    'failregex = ^<HOST> \\S+ \\S+ \\[[^\\]]*\\] "[^"]*" 404 \\d+',
    'ignoreregex =',
    '',
  ].join('\n'),
};

// fail2ban 由源码编译装到 /usr/local，客户端二进制与配置目录都不在系统默认位置：
// 必须显式 -c /etc/fail2ban，否则客户端会去找 /usr/local/etc/fail2ban 而连不上服务端 socket
function clientKey() {
  return fs.existsSync('/usr/local/bin/fail2ban-client') ? 'fail2banClientLocal' : 'fail2banClient';
}

function client(args, options) {
  return run(clientKey(), ['-c', '/etc/fail2ban', ...args], options);
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return '';
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

// ---- 状态文件 ----

function defaultServices() {
  const services = {};
  for (const item of SERVICE_PROTECTIONS) services[item.key] = item.defaultEnabled;
  return { version: 1, services };
}

function readState(key) {
  if (key === 'services') {
    const data = readJson(STATE_FILES.services, null) || {};
    return { version: 1, services: { ...defaultServices().services, ...(data.services || {}) } };
  }
  if (key === 'sites') {
    const data = readJson(STATE_FILES.sites, null) || {};
    return { version: 1, sites: data.sites && typeof data.sites === 'object' ? data.sites : {} };
  }
  if (key === 'whitelist') {
    const data = readJson(STATE_FILES.whitelist, null) || {};
    return {
      version: 1,
      items: Array.isArray(data.items) ? data.items : [],
      autoIps: Array.isArray(data.autoIps) ? data.autoIps : [],
    };
  }
  const data = readJson(STATE_FILES.blacklist, null) || {};
  return { version: 1, items: Array.isArray(data.items) ? data.items : [] };
}

function writeState(key, data) {
  writeJson(STATE_FILES[key], data);
}

// 解析 jail.local，用于把安装脚本产出的初始配置导入面板状态
function parseJailLocal(text) {
  const result = { ignoreip: [], enabledJails: [] };
  let section = '';
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (section.toLowerCase() === 'default' && key === 'ignoreip') {
      result.ignoreip = value.split(/\s+/).filter(Boolean);
    }
    if (section && section.toLowerCase() !== 'default' && key === 'enabled' && /^(true|yes|1)$/i.test(value)) {
      result.enabledJails.push(section);
    }
  }
  return result;
}

let seeded = false;

// 首次访问时把当前 jail.local（安装脚本产出）导入面板状态文件；
// 之后面板生成 jail.local，两者不再互相覆盖。
function ensureDefaultState() {
  if (seeded) return;
  seeded = true;
  if (Object.values(STATE_FILES).some((f) => fs.existsSync(f))) return;

  const parsed = parseJailLocal(readFileSafe(JAIL_LOCAL));
  const services = defaultServices();
  for (const item of SERVICE_PROTECTIONS) {
    services.services[item.key] = parsed.enabledJails.includes(item.key);
  }
  if (parsed.enabledJails.length === 0) {
    services.services.sshd = true;
  }
  writeState('services', services);

  const autoIps = parsed.ignoreip
    .filter((ip) => !BUILTIN_IGNOREIP.includes(ip) && isValidIp(ip));
  writeState('whitelist', { version: 1, items: [], autoIps });
  writeState('sites', { version: 1, sites: {} });
  writeState('blacklist', { version: 1, items: [] });
  if (!fs.existsSync(BLACKLIST_LOG)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BLACKLIST_LOG, '', 'utf8');
  }
}

// ---- IP 校验 ----

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;

// 严格校验，禁止空白与换行（防止写入 jail.local 时被注入额外配置行）
function isValidIp(input) {
  const s = String(input || '').trim();
  if (!s || /\s/.test(s)) return false;
  const m = IPV4_RE.exec(s);
  if (m) {
    const parts = [m[1], m[2], m[3], m[4]].map((x) => parseInt(x, 10));
    if (parts.some((n) => n > 255)) return false;
    if (m[5] !== undefined && parseInt(m[5], 10) > 32) return false;
    return true;
  }
  return /^[0-9a-fA-F:]{2,45}$/.test(s) && s.includes(':');
}

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (Number.isNaN(n) || n < 0 || n > 255) return null;
    value = ((value << 8) >>> 0) + n;
  }
  return value >>> 0;
}

function ipv4InCidr(ip, cidr) {
  const [net, lenStr] = String(cidr).split('/');
  const len = parseInt(lenStr, 10);
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(net);
  if (a === null || b === null || Number.isNaN(len)) return false;
  if (len <= 0) return true;
  const mask = (0xffffffff << (32 - len)) >>> 0;
  return (a & mask) === (b & mask);
}

function buildIgnoreip(wlState) {
  const list = [
    ...BUILTIN_IGNOREIP,
    ...wlState.items.map((it) => it.ip).filter(Boolean),
    ...wlState.autoIps,
  ];
  return [...new Set(list)];
}

// 白名单是否覆盖该 IP（支持 CIDR 网段包含判断）
function whitelistCovers(wlState, ip) {
  return buildIgnoreip(wlState).some((entry) => {
    if (entry === ip) return true;
    return entry.includes('/') ? ipv4InCidr(ip, entry) : false;
  });
}

// ---- 站点日志注入 ----

function siteLogPaths(siteName) {
  return {
    access: `${NGINX_LOG_DIR}/${siteName}.access.log`,
    error: `${NGINX_LOG_DIR}/${siteName}.error.log`,
  };
}

function siteLogLines(siteName) {
  const paths = siteLogPaths(siteName);
  // 显式指定 main 格式：面板自写的 404 过滤器按默认 main 格式编写
  return [
    `    access_log ${paths.access} main;`,
    `    error_log ${paths.error};`,
  ];
}

function stripSiteLogs(content, siteName) {
  const targets = siteLogLines(siteName).map((l) => l.trim());
  return String(content)
    .split('\n')
    .filter((line) => !targets.includes(line.trim()))
    .join('\n');
}

// 幂等注入：先剔除历史同名行，再插到首个 server_name 之后；找不到 server_name 返回 null
function injectSiteLogs(content, siteName) {
  const lines = siteLogLines(siteName);
  const out = [];
  let inserted = false;
  for (const raw of stripSiteLogs(content, siteName).split('\n')) {
    out.push(raw);
    if (!inserted && /^\s*server_name\s/.test(raw)) {
      out.push(...lines);
      inserted = true;
    }
  }
  return inserted ? out.join('\n') : null;
}

function siteJailName(siteName, filterKey) {
  return `site-${String(siteName).replace(/\./g, '_')}-${filterKey}`;
}

// ---- 过滤器与 jail.local 生成 ----

function writeFilterFiles() {
  fs.mkdirSync(FILTER_DIR, { recursive: true });
  for (const [name, content] of Object.entries(PANEL_FILTERS)) {
    const file = path.join(FILTER_DIR, name);
    if (readFileSafe(file) !== content) fs.writeFileSync(file, content, 'utf8');
  }
}

function buildJailLocal() {
  ensureDefaultState();
  const services = readState('services').services;
  const sites = readState('sites').sites;
  const whitelist = readState('whitelist');

  const lines = [];
  lines.push('# 由面板生成，请勿手工修改（面板页面：Fail2ban）');
  lines.push('[DEFAULT]');
  lines.push(`ignoreip = ${buildIgnoreip(whitelist).join(' ')}`);
  lines.push('banaction = iptables-multiport');
  lines.push(`bantime = ${DEFAULTS.bantime}`);
  lines.push(`findtime = ${DEFAULTS.findtime}`);
  lines.push(`maxretry = ${DEFAULTS.maxretry}`);
  lines.push('');

  for (const item of SERVICE_PROTECTIONS) {
    lines.push(`[${item.key}]`);
    lines.push(`enabled = ${services[item.key] ? 'true' : 'false'}`);
    lines.push(`port = ${item.port}`);
    lines.push(`filter = ${item.filter}`);
    lines.push('backend = polling');
    lines.push(`logpath = ${item.logpath}`);
    for (const [k, v] of Object.entries(item.extra || {})) lines.push(`${k} = ${v}`);
    lines.push('');
  }

  // 站点 jail：按站点名排序，保证多次生成结果完全一致
  for (const siteName of Object.keys(sites).sort()) {
    const record = sites[siteName] || {};
    if (!record.enabled) continue;
    const paths = siteLogPaths(siteName);
    for (const filterItem of SITE_FILTERS) {
      if (!(record.filters || {})[filterItem.key]) continue;
      lines.push(`[${siteJailName(siteName, filterItem.key)}]`);
      lines.push('enabled = true');
      lines.push('port = http,https');
      lines.push(`filter = ${filterItem.filter}`);
      lines.push('backend = polling');
      lines.push(`logpath = ${filterItem.log === 'error' ? paths.error : paths.access}`);
      lines.push('');
    }
  }

  // 黑名单 jail：常开（set banip 需要目标 jail 先存在），永久封禁
  lines.push(`[${BLACKLIST_JAIL}]`);
  lines.push('enabled = true');
  lines.push('filter = panel-blacklist');
  lines.push('backend = polling');
  lines.push(`logpath = ${BLACKLIST_LOG}`);
  lines.push('maxretry = 1');
  lines.push('bantime = -1');
  lines.push('banaction = iptables-allports');
  lines.push('');

  return lines.join('\n');
}

// 写 jail.local 并重载 fail2ban；重载失败时还原备份再重载
async function applyJailLocal() {
  writeFilterFiles();
  const content = buildJailLocal();
  const previous = readFileSafe(JAIL_LOCAL);
  let backup = '';
  if (previous !== content) {
    if (previous) {
      backup = `${JAIL_LOCAL}.bak.${stamp()}`;
      fs.writeFileSync(backup, previous, 'utf8');
    }
    fs.mkdirSync(path.dirname(JAIL_LOCAL), { recursive: true });
    fs.writeFileSync(JAIL_LOCAL, content, 'utf8');
  }

  const reload = await client(['reload']);
  if (reload.exitCode !== 0) {
    if (backup) {
      fs.writeFileSync(JAIL_LOCAL, previous, 'utf8');
      await client(['reload']);
    }
    throw new Error(`fail2ban 重载失败，已回滚：${(reload.stderr || reload.stdout || '').trim().slice(0, 300)}`);
  }
  return { content, reloaded: true, backup };
}

// ---- 服务状态 ----

// fail2ban-client 输出是带 | ` - 装饰的树形文本，剥掉行首装饰再匹配字段
function pickField(text, label) {
  const re = new RegExp(`^${label}:\\s*(.*)$`);
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/^[\s|`-]+/, '');
    const m = re.exec(line);
    if (m) return m[1].trim();
  }
  return '';
}

// jail → filter 映射：client 输出不直接给出 filter 名，从面板配置状态反推
function jailFilterMap() {
  const map = { [BLACKLIST_JAIL]: 'panel-blacklist' };
  for (const item of SERVICE_PROTECTIONS) map[item.key] = item.filter;
  const sites = readState('sites').sites;
  for (const [siteName, record] of Object.entries(sites)) {
    if (!record || !record.enabled) continue;
    for (const item of SITE_FILTERS) {
      if ((record.filters || {})[item.key]) map[siteJailName(siteName, item.key)] = item.filter;
    }
  }
  return map;
}

async function listJails() {
  const res = await client(['status']);
  if (res.exitCode !== 0) return [];
  const listMatch = /Jail list:\s*(.*)/.exec(res.stdout || '');
  const names = listMatch
    ? listMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const filterMap = jailFilterMap();
  const jails = [];
  for (const name of names) {
    if (!JAIL_NAME_RE.test(name)) continue;
    const detail = await client(['status', name]);
    const out = detail.stdout || '';
    jails.push({
      name,
      filter: filterMap[name] || '',
      logpath: pickField(out, 'File list').split(',')[0].trim(),
      currentlyBanned: parseInt(pickField(out, 'Currently banned'), 10) || 0,
      totalBanned: parseInt(pickField(out, 'Total banned'), 10) || 0,
      bannedIps: pickField(out, 'Banned IP list').split(/\s+/).filter(Boolean),
    });
  }
  return jails;
}

async function getStatus() {
  ensureDefaultState();
  const active = await run('systemctl', ['is-active', SERVICE]);
  const status = active.exitCode === 0 ? active.stdout.trim() : 'inactive';
  let version = '';
  if (status === 'active') {
    const versionRes = await client(['--version']);
    const m = /[Ff]ail2[Bb]an v([\d.]+)/.exec(versionRes.stdout || '');
    version = m ? m[1] : '';
  }
  const jails = status === 'active' ? await listJails() : [];
  return {
    status,
    version,
    jails,
    defaults: { ...DEFAULTS, blacklistJail: BLACKLIST_JAIL },
  };
}

async function control(action) {
  const allowed = ['start', 'stop', 'restart', 'reload'];
  if (!allowed.includes(action)) throw new Error('非法操作');
  const result = await run('systemctl', [action, SERVICE]);
  return { success: result.exitCode === 0, output: result };
}

async function unbanFromJail(jail, ip) {
  const name = String(jail || '').trim();
  const value = String(ip || '').trim();
  if (!JAIL_NAME_RE.test(name)) throw new Error('非法 jail 名称');
  if (!isValidIp(value)) throw new Error('IP 格式不正确');
  const res = await client(['set', name, 'unbanip', value]);
  const output = `${res.stderr || ''}${res.stdout || ''}`;
  // 该 IP 已不在封禁列表时 fail2ban 返回错误，按成功处理
  if (res.exitCode !== 0 && !/not banned|NOK/i.test(output)) {
    throw new Error(`解封失败：${output.trim().slice(0, 200)}`);
  }
  return { jail: name, ip: value };
}

// ---- 服务保护 ----

async function listServices() {
  ensureDefaultState();
  const state = readState('services');
  return {
    items: SERVICE_PROTECTIONS.map((item) => ({
      key: item.key,
      label: item.label,
      filter: item.filter,
      logpath: item.logpath,
      port: item.port,
      enabled: !!state.services[item.key],
    })),
  };
}

async function setServices(map) {
  ensureDefaultState();
  if (!map || typeof map !== 'object') throw new Error('缺少 services 参数');
  const state = readState('services');
  for (const item of SERVICE_PROTECTIONS) {
    if (Object.prototype.hasOwnProperty.call(map, item.key)) {
      state.services[item.key] = map[item.key] === true || map[item.key] === 'true';
    }
  }
  writeState('services', state);
  const applied = await applyJailLocal();
  return { services: state.services, reloaded: applied.reloaded };
}

// ---- 站点保护 ----

async function listSites() {
  ensureDefaultState();
  const sites = await nginxService.listSites();
  const state = readState('sites');
  return {
    items: sites.map((site) => {
      const record = state.sites[site.name] || {};
      const filters = {};
      for (const item of SITE_FILTERS) filters[item.key] = !!(record.filters || {})[item.key];
      const content = readFileSafe(site.file);
      return {
        name: site.name,
        serverName: site.serverName,
        file: site.file,
        enabled: !!record.enabled,
        filters,
        logsInjected: content.includes(`access_log ${siteLogPaths(site.name).access} main;`),
      };
    }),
    filterOptions: SITE_FILTERS.map((item) => ({ key: item.key, label: item.label })),
  };
}

async function setSiteProtection(siteName, { enabled, filters }) {
  ensureDefaultState();
  const name = String(siteName || '').trim();
  if (!SITE_NAME_RE.test(name)) throw new Error('非法站点名称');
  const site = (await nginxService.listSites()).find((s) => s.name === name);
  if (!site) throw new Error('站点不存在');

  const record = { enabled: !!enabled, filters: {} };
  for (const item of SITE_FILTERS) {
    record.filters[item.key] = record.enabled && !!((filters || {})[item.key]);
  }

  const original = readFileSafe(site.file);
  const wanted = record.enabled ? injectSiteLogs(original, name) : stripSiteLogs(original, name);
  if (wanted === null) throw new Error('未在站点配置中找到 server_name，无法注入日志');

  let backup = '';
  if (wanted !== original) {
    backup = `${site.file}.${stamp()}.bak`;
    fs.writeFileSync(backup, original, 'utf8');
    fs.writeFileSync(site.file, wanted, 'utf8');
    const test = await nginxService.testConfig();
    if (test.exitCode !== 0) {
      fs.writeFileSync(site.file, original, 'utf8');
      throw new Error(`nginx 配置校验失败，已回滚：${(test.stderr || test.stdout || '').trim()}`);
    }
    await run('systemctl', ['reload', 'nginx']);
  }

  // 日志文件先建好：fail2ban 找不到 logpath 会把该 jail 标为失败
  if (record.enabled) {
    const paths = siteLogPaths(name);
    for (const file of [paths.access, paths.error]) {
      try {
        if (!fs.existsSync(file)) fs.writeFileSync(file, '');
      } catch (e) {
        // 交给后续 nginx reload / fail2ban 报错暴露
      }
    }
  }

  const state = readState('sites');
  state.sites[name] = record;
  writeState('sites', state);
  const applied = await applyJailLocal();

  return { site: name, ...record, logsInjected: record.enabled, backup, reloaded: applied.reloaded };
}

// ---- IP 白名单 ----

async function listWhitelist() {
  ensureDefaultState();
  const state = readState('whitelist');
  return {
    builtin: BUILTIN_IGNOREIP.map((ip) => ({ ip, builtin: true, note: '内置，不可删除' })),
    items: state.items.map((it) => ({ ...it, builtin: false })),
    autoIps: state.autoIps,
    ignoreip: buildIgnoreip(state).join(' '),
  };
}

async function addWhitelist(ip, note) {
  ensureDefaultState();
  const value = String(ip || '').trim();
  if (!isValidIp(value)) throw new Error('IP 格式不正确');
  const state = readState('whitelist');
  if (!state.items.some((it) => it.ip === value)) {
    state.items.push({
      ip: value,
      note: String(note || '').trim(),
      builtin: false,
      addedAt: new Date().toISOString(),
    });
    writeState('whitelist', state);
  }
  const applied = await applyJailLocal();
  return { ...(await listWhitelist()), reloaded: applied.reloaded };
}

async function removeWhitelist(ip) {
  ensureDefaultState();
  const value = String(ip || '').trim();
  if (BUILTIN_IGNOREIP.includes(value)) {
    const err = new Error('内置白名单不可删除');
    err.statusCode = 400;
    throw err;
  }
  const state = readState('whitelist');
  state.items = state.items.filter((it) => it.ip !== value);
  state.autoIps = state.autoIps.filter((x) => x !== value);
  writeState('whitelist', state);
  const applied = await applyJailLocal();
  return { ...(await listWhitelist()), reloaded: applied.reloaded };
}

// 重新采集最近 5 个不同登录来源 IP（换网络后调用可刷新兜底白名单）
async function refreshAutoIps() {
  ensureDefaultState();
  const script = "grep ' Accepted ' /var/log/secure 2>/dev/null | tail -300 | sed -n 's/.* from \\([0-9a-fA-F.:]*\\) port.*/\\1/p' | tac | awk '!seen[$0]++' | head -5";
  const res = await run('bash', ['-c', script]);
  const ips = String(res.stdout || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => isValidIp(s));
  const state = readState('whitelist');
  state.autoIps = ips;
  writeState('whitelist', state);
  const applied = await applyJailLocal();
  return { ...(await listWhitelist()), reloaded: applied.reloaded };
}

// ---- IP 黑名单 ----

function rewriteBlacklistLog(items) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const content = items.map((it) => it.ip).join('\n');
  fs.writeFileSync(BLACKLIST_LOG, content ? `${content}\n` : '', 'utf8');
}

async function listBlacklist() {
  ensureDefaultState();
  return { items: readState('blacklist').items };
}

async function addBlacklist(ip, note) {
  ensureDefaultState();
  const value = String(ip || '').trim();
  if (!isValidIp(value)) throw new Error('IP 格式不正确');
  if (whitelistCovers(readState('whitelist'), value)) {
    const err = new Error('该 IP 在白名单中，不能加入黑名单');
    err.statusCode = 400;
    throw err;
  }
  const state = readState('blacklist');
  if (!state.items.some((it) => it.ip === value)) {
    state.items.push({
      ip: value,
      note: String(note || '').trim(),
      addedAt: new Date().toISOString(),
    });
    writeState('blacklist', state);
  }
  rewriteBlacklistLog(state.items);
  await applyJailLocal();
  await client(['set', BLACKLIST_JAIL, 'banip', value]);
  return { items: state.items };
}

async function removeBlacklist(ip) {
  ensureDefaultState();
  const value = String(ip || '').trim();
  if (!isValidIp(value)) throw new Error('IP 格式不正确');
  const state = readState('blacklist');
  const next = state.items.filter((it) => it.ip !== value);
  if (next.length !== state.items.length) {
    writeState('blacklist', { version: 1, items: next });
    rewriteBlacklistLog(next);
  }
  await applyJailLocal();
  const res = await client(['set', BLACKLIST_JAIL, 'unbanip', value]);
  const output = `${res.stderr || ''}${res.stdout || ''}`;
  if (res.exitCode !== 0 && !/not banned|NOK/i.test(output)) {
    throw new Error(`解封失败：${output.trim().slice(0, 200)}`);
  }
  return { items: next };
}

// 站点被删除时清掉其保护状态：只重建 jail.local，不再回写已被删除的站点配置
async function forgetSite(siteName) {
  const key = String(siteName || '').trim();
  if (!key || !SITE_NAME_RE.test(key)) return { removed: false };

  const state = readState('sites');
  if (!state.sites[key]) return { removed: false };

  delete state.sites[key];
  writeState('sites', state);
  await applyJailLocal();
  return { removed: true };
}

module.exports = {
  getStatus,
  control,
  listJails,
  unbanFromJail,
  listServices,
  setServices,
  listSites,
  setSiteProtection,
  forgetSite,
  listWhitelist,
  addWhitelist,
  removeWhitelist,
  refreshAutoIps,
  listBlacklist,
  addBlacklist,
  removeBlacklist,
  // 供本地断言与排查使用
  buildJailLocal,
  applyJailLocal,
  injectSiteLogs,
  stripSiteLogs,
  parseJailLocal,
  isValidIp,
  siteJailName,
  BUILTIN_IGNOREIP,
  SERVICE_PROTECTIONS,
  SITE_FILTERS,
  BLACKLIST_JAIL,
};