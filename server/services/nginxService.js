const path = require('path');
const fs = require('fs');
const { run } = require('./commandRunner');
const servicesConfig = require('../config/services').nginx;
const mysqlService = require('./mysqlService');
const store = require('../models/store');
const phpService = require('./phpService');
const sslService = require('./sslService');

// 站点配置目录：RHEL 系（Alibaba Cloud Linux）通过 conf.d/*.conf 引入
const SITE_DIR = path.join(servicesConfig.configDir, 'conf.d');
// 已停止的站点配置存放目录：nginx.conf 的 include 只匹配 conf.d/*.conf 一层，
// 子目录不会被加载，因此把配置移到此处即可让站点下线，同时保留文件便于随时重启
const SITE_DISABLED_DIR = path.join(SITE_DIR, '.disabled');
// 站点名称：允许中文、字母、数字、点、下划线与短横线。
// 首字符不能是点，避免生成隐藏配置文件；不含路径分隔符与空白，杜绝路径穿越
const SITE_NAME_RE = /^[\p{L}\p{N}_-][\p{L}\p{N}._-]*$/u;
// 站点根目录标记：建站时写入配置头部，记录用户填写的网站根目录。
// nginx 的 root 可能是网站根目录下的运行目录（如 public），二者需要区分展示
const SITE_ROOT_MARK_RE = /^#\s*glass-panel:site-root\s+(.+?)\s*$/m;
// 停止站点时在原位置留下的占位页标记：占位页保留原 server_name 与监听端口，
// 使该域名仍由本 server 块处理，否则请求会落到同端口上其它站点（域名串站）
const STOP_PAGE_MARK = '# glass-panel:stopped-site';
const STOP_PAGE_HTML = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Service Stopped</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif}.card{max-width:520px;margin:24px;padding:48px 40px;text-align:center;border:1px solid rgba(255,255,255,.08);border-radius:20px;background:rgba(255,255,255,.03)}.code{font-size:13px;letter-spacing:.3em;color:#64748b}h1{margin:16px 0 8px;font-size:28px;font-weight:600}p{margin:0;color:#94a3b8;font-size:15px;line-height:1.7}</style></head><body><div class="card"><div class="code">503</div><h1>Service Stopped</h1><p>This website is currently unavailable.</p><p>The service has been stopped by the administrator. Please try again later.</p></div></body></html>';

// 站点独立日志目录：与 Fail2ban 站点保护使用的路径、格式完全一致
// （fail2banService.siteLogLines），两处写入同一行内容，重复注入时互相幂等
const NGINX_LOG_DIR = '/var/log/nginx';

// 站点根目录约定：面板创建的站点目录位于 /var/www 下，目录隔离以此为边界
const WEB_ROOT = '/var/www';

function siteLogLines(siteName) {
  return [
    `    access_log ${NGINX_LOG_DIR}/${siteName}.access.log main;`,
    `    error_log ${NGINX_LOG_DIR}/${siteName}.error.log;`,
  ];
}

// 伪静态预设：preset 为空时使用默认 try_files
const REWRITE_PRESETS = {
  none: null,
  wordpress: ['    location / {', '        try_files $uri $uri/ /index.php?$args;', '    }'],
  laravel: ['    location / {', '        try_files $uri $uri/ /index.php?$query_string;', '    }'],
  thinkphp: [
    '    if (!-e $request_filename) {',
    '        rewrite ^(.*)$ /index.php?s=$1 last;',
    '    }',
  ],
};

// 解析站点根目录（用户填写的网站根目录）：
// 优先使用配置中的标记；旧站点没有标记时按约定推断 —— /var/www 下的一级目录，
// 从而把 nginx root 中的运行目录（public、web 等）剥离出来
function resolveSiteDir(text, root) {
  const marked = String(text || '').match(SITE_ROOT_MARK_RE)?.[1]?.trim();
  if (marked) return marked;

  const raw = String(root || '').trim();
  if (!raw || !raw.startsWith('/')) return '';
  const base = path.resolve(raw);
  const rel = path.relative(WEB_ROOT, base);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return path.join(WEB_ROOT, rel.split(path.sep)[0]);
  }
  return base;
}

// 取首个可用于签发证书的域名（忽略 _ 与泛域名）
function pickPrimaryDomain(serverName) {
  return String(serverName || '')
    .split(/\s+/)
    .map((d) => d.trim())
    .filter((d) => d && d !== '_' && !d.includes('*'))[0] || '';
}

// 校验配置文件路径：必须落在允许的 nginx 配置目录内，且规范化后仍以目录前缀开头
// 解决原始 startsWith 无法防御 ../ 与符号链接的问题
function isPathAllowed(filePath) {
  const allowedDirs = [
    servicesConfig.configDir,
    servicesConfig.sitesAvailable,
    servicesConfig.sitesEnabled,
  ].filter(Boolean);

  // 先拒绝包含 .. 的原始路径，避免 path.resolve 将其折叠后误判为合法
  const rawSegments = String(filePath).split(/[\\/]/);
  if (rawSegments.includes('..')) return false;

  let resolved;
  try {
    // realpathSync 会解析符号链接；文件不存在时使用 path.resolve 规范化
    resolved = fs.existsSync(filePath)
      ? fs.realpathSync(filePath)
      : path.resolve(filePath);
  } catch (err) {
    return false;
  }

  return allowedDirs.some((dir) => {
    const realDir = fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);
    const relative = path.relative(realDir, resolved);
    // relative 不能以 .. 开头，且不能等于空（不允许直接指向目录本身）
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

async function getStatus() {
  const result = await run('systemctl', ['is-active', servicesConfig.service]);
  return result.exitCode === 0 ? result.stdout.trim() : 'inactive';
}

// 停止没有被 systemd 托管的 nginx master（历史上手工启动过 nginx 时会出现）：
// 这类进程不在 unit 的 cgroup 里，systemctl restart 无法结束它，新 master 会因
// 80/443 被占用而启动失败，unit 变成 failed 但旧进程仍在服务
async function stopUntrackedMasters() {
  const unit = await run('systemctl', ['show', servicesConfig.service, '-p', 'MainPID']);
  const mainPid = Number(String(unit.stdout || '').replace(/[^\d]/g, '')) || 0;
  const ps = await run('ps', ['-eo', 'pid=,args=']);
  const pids = (ps.stdout || '')
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+nginx: master process/))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .filter((pid) => pid && pid !== mainPid);
  if (!pids.length) return false;
  const signal = (sig) => run('bash', ['-c', `kill -${sig} ${pids.join(' ')} 2>/dev/null || true`]);
  await signal('QUIT');
  // 优雅退出最多等 5 秒，仍未退出则强制结束
  for (let i = 0; i < 10; i += 1) {
    const alive = await run('ps', ['-p', pids.join(','), '-o', 'pid=']);
    if (!String(alive.stdout || '').trim()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await signal('TERM');
  return true;
}

async function control(action) {
  const allowed = ['start', 'stop', 'restart', 'reload'];
  if (!allowed.includes(action)) throw new Error('非法操作');
  let result = await run('systemctl', [action, servicesConfig.service]);
  if (result.exitCode !== 0 && (action === 'start' || action === 'restart')) {
    // 用 unit 的 Result 判定失败类型，不依赖 systemctl 的本地化提示文本
    const state = await run('systemctl', ['show', servicesConfig.service, '-p', 'Result']);
    const reason = String(state.stdout || '').trim().replace(/^Result=/, '');
    if (reason === 'start-limit-hit') {
      // 短时间内的重复启停会触发 systemd 的启动频率限制（默认 5 次/10 秒），
      // unit 被锁定为 failed 后即使配置正常也无法启动，需先解除锁定再启动
      await run('systemctl', ['reset-failed', servicesConfig.service]);
      result = await run('systemctl', ['start', servicesConfig.service]);
    } else if (await stopUntrackedMasters()) {
      // 启动失败时若存在历史遗留的非托管 nginx master（占用 80/443），结束它后重试一次
      result = await run('systemctl', [action, servicesConfig.service]);
    }
  }
  return result;
}

async function testConfig() {
  return run('nginx', ['-t']);
}

// 解析 nginx -T 输出为站点列表：先按花括号配对切出 server 块并归属到文件，
// 再把同一文件内 server_name 相同的块合并（Certbot 会追加一个 80 端口跳转块）
// fpmByListen：fastcgi_pass 目标 → PHP 版本 的映射，用于在站点列表标注站点使用的 PHP 版本
function parseServerBlocks(stdout, siteDir, fpmByListen = new Map()) {
  // nginx -T 会在每个配置文件内容前输出 "# configuration file <路径>:" 标记，
  // 据此把每个 server 块归属到具体配置文件，便于编辑与识别站点
  const marks = [];
  const markRegex = /# configuration file (\S+):/g;
  let mark;
  while ((mark = markRegex.exec(stdout)) !== null) {
    marks.push({ file: mark[1], index: mark.index });
  }
  const fileAt = (pos) => {
    let current = '';
    for (const item of marks) {
      if (item.index <= pos) current = item.file;
      else break;
    }
    return current;
  };

  // 停止占位页文件集合与站点根目录标记：均按 nginx -T 输出的文件分段识别
  const stopPageFiles = new Set();
  const fileTextByFile = new Map();
  marks.forEach((item, idx) => {
    const end = idx + 1 < marks.length ? marks[idx + 1].index : stdout.length;
    const segment = stdout.slice(item.index, end);
    fileTextByFile.set(item.file, segment);
    if (segment.includes(STOP_PAGE_MARK)) stopPageFiles.add(item.file);
  });

  // 用花括号配对切块：嵌套的 location / if 块内部的 } 不能当作 server 块结束，
  // 否则位于嵌套块之后的指令（如 Certbot 追加的 listen 443 ssl）会被漏读
  const blocks = [];
  const openRegex = /server\s*\{/g;
  let hit;
  while ((hit = openRegex.exec(stdout)) !== null) {
    const start = hit.index + hit[0].length;
    let depth = 1;
    let i = start;
    for (; i < stdout.length && depth > 0; i += 1) {
      const ch = stdout[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (depth !== 0) break; // 花括号不配对，放弃后续解析
    blocks.push({ start: hit.index, text: stdout.slice(start, i - 1) });
    openRegex.lastIndex = i;
  }

  const merged = [];
  const seen = new Map();
  for (const block of blocks) {
    const file = fileAt(block.start);
    // 仅展示站点目录下的 server 块，忽略 nginx.conf 内部块
    if (!file.startsWith(siteDir)) continue;
    const serverName = block.text.match(/server_name\s+([^;]+);/)?.[1]?.trim() || '_';
    const listens = [...block.text.matchAll(/listen\s+([^;]+);/g)].map((m) => m[1].trim());
    const proxyPass = block.text.match(/proxy_pass\s+([^;]+);/)?.[1]?.trim() || '';
    const fpmListen = block.text.match(/fastcgi_pass\s+([^;]+);/)?.[1]?.trim() || '';
    const root = block.text.match(/root\s+([^;]+);/)?.[1]?.trim() || '';
    const site = {
      name: path.basename(file, '.conf'),
      file,
      serverName,
      listen: listens.join(', '),
      // 站点根目录（用户填写的网站根目录）与 nginx 运行目录（root）分开返回
      siteDir: resolveSiteDir(fileTextByFile.get(file) || '', root),
      root,
      proxyPass,
      fpmListen,
      phpVersion: fpmByListen.get(fpmListen) || '',
      // 站点类型：有 proxy_pass 为反代，有 fastcgi_pass 为 PHP，其余为静态
      type: proxyPass ? 'proxy' : (fpmListen ? 'php' : 'html'),
      ssl: /ssl/.test(block.text),
      stopped: stopPageFiles.has(file),
      // 是否已由面板注入目录隔离（open_basedir 通过 PHP_ADMIN_VALUE 下发）
      isolated: /PHP_ADMIN_VALUE[^;]*open_basedir=/.test(block.text),
    };

    const key = `${file}|${serverName}`;
    const exist = seen.get(key);
    if (!exist) {
      seen.set(key, site);
      merged.push(site);
      continue;
    }
    const listenSet = [...new Set([...exist.listen.split(', '), ...site.listen.split(', ')].filter(Boolean))];
    exist.listen = listenSet.join(', ');
    exist.siteDir = exist.siteDir || site.siteDir;
    exist.root = exist.root || site.root;
    exist.proxyPass = exist.proxyPass || site.proxyPass;
    exist.fpmListen = exist.fpmListen || site.fpmListen;
    exist.phpVersion = exist.phpVersion || site.phpVersion;
    // 跳转块（return 301）本身不含业务指令，类型取有内容的那一块
    if (exist.type === 'html' && site.type !== 'html') exist.type = site.type;
    exist.ssl = exist.ssl || site.ssl;
    exist.stopped = exist.stopped || site.stopped;
    exist.isolated = exist.isolated || site.isolated;
  }
  return merged;
}

// fastcgi_pass 目标 → PHP 版本 的映射：PHP 缺失或 pool 解析失败不影响站点列表本身
async function buildFpmVersionMap() {
  const fpmByListen = new Map();
  try {
    for (const { version, listen } of await phpService.listFpmListens()) {
      if (!fpmByListen.has(listen)) fpmByListen.set(listen, version);
    }
  } catch (err) {
    // 忽略：站点列表仍正常返回，PHP 版本留空
  }
  return fpmByListen;
}

// 把单个配置文件文本解析成站点对象：用于未被 nginx 加载的（已停止）站点，
// 无法从 nginx -T 输出识别，只能直接读文件，字段与 parseServerBlocks 保持一致
function parseConfigText(text, file, fpmByListen = new Map()) {
  const serverNames = [...text.matchAll(/server_name\s+([^;]+);/g)].map((m) => m[1].trim());
  const listens = [...text.matchAll(/listen\s+([^;]+);/g)].map((m) => m[1].trim());
  const roots = [...text.matchAll(/\broot\s+([^;]+);/g)].map((m) => m[1].trim());
  const proxyPass = text.match(/proxy_pass\s+([^;]+);/)?.[1]?.trim() || '';
  const fpmListen = text.match(/fastcgi_pass\s+([^;]+);/)?.[1]?.trim() || '';
  return {
    name: path.basename(file, '.conf'),
    file,
    serverName: [...new Set(serverNames)].join(' ') || '_',
    listen: [...new Set(listens)].join(', '),
    siteDir: resolveSiteDir(text, roots[0] || ''),
    root: roots[0] || '',
    proxyPass,
    fpmListen,
    phpVersion: fpmByListen.get(fpmListen) || '',
    type: proxyPass ? 'proxy' : (fpmListen ? 'php' : 'html'),
    ssl: /\bssl\b/.test(text),
    stopped: text.includes(STOP_PAGE_MARK),
    isolated: /PHP_ADMIN_VALUE[^;]*open_basedir=/.test(text),
  };
}

// 列出已停止的站点：目录不存在（从未停过站点）时返回空列表
async function listDisabledSites(fpmByListen = new Map()) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(SITE_DISABLED_DIR);
  } catch (err) {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.conf')) continue;
    const file = path.join(SITE_DISABLED_DIR, name);
    try {
      const text = await fs.promises.readFile(file, 'utf8');
      out.push({ ...parseConfigText(text, file, fpmByListen), enabled: false });
    } catch (err) {
      // 单个文件不可读不影响其它站点展示
    }
  }
  return out;
}

// 当前被 nginx 加载的 server 块（含停止占位页）：域名冲突检测以它为准，
// 占位页同样占用域名与端口，新站点若同域名会被它遮蔽
async function listLoadedSites(fpmByListen) {
  try {
    const { stdout } = await run('nginx', ['-T']);
    return parseServerBlocks(stdout, SITE_DIR, fpmByListen);
  } catch (err) {
    // nginx 未运行或命令不可用：视为没有已加载站点
    return [];
  }
}

// 站点列表 = nginx 当前加载的站点（enabled: true）+ 已停止站点（enabled: false）。
// 停止占位页不算独立站点，已停止站点由 .disabled 下的原配置代表，避免同一站点出现两条
async function listSites() {
  const fpmByListen = await buildFpmVersionMap();
  const active = (await listLoadedSites(fpmByListen))
    .filter((site) => !site.stopped)
    .map((site) => ({ ...site, enabled: true }));
  return [...active, ...(await listDisabledSites(fpmByListen))];
}

// 监听端口集合：把 "80, 443 ssl" 这类 listen 串解析成数字端口
function listenPortSet(listen) {
  return new Set((String(listen || '').match(/\d+/g) || []).map((n) => n));
}

// 建站前检查域名冲突：其他站点在相同端口上已占用同一 server_name 时拒绝写入。
// 否则 nginx 按 conf.d 文件加载顺序取第一个匹配的 server 块，后建的站点（如反代）会被静默遮蔽。
async function findDomainConflict(domain, selfName, ports) {
  const tokens = String(domain || '').split(/\s+/).map((d) => d.trim()).filter((d) => d && d !== '_' && !d.includes('*'));
  if (!tokens.length) return null;
  const sites = await listLoadedSites(await buildFpmVersionMap());
  for (const site of sites) {
    if (site.name === selfName) continue;
    const names = String(site.serverName || '').split(/\s+/).map((d) => d.trim());
    const hit = names.find((n) => tokens.includes(n));
    if (!hit) continue;
    const occupied = listenPortSet(site.listen);
    if (![...ports].some((p) => occupied.has(p))) continue;
    return { site: site.name, file: site.file, domain: hit };
  }
  return null;
}

// open_basedir 允许的路径集合：站点自身目录树 + /tmp。
// 取 /var/www 下的一级目录而不是 nginx 的 root，是为了覆盖「运行目录」场景
// （root 指向 public 等子目录时框架仍要读上级）；兄弟站点是同级目录，不会被放行。
// root 不在 /var/www 下时退回 root 自身
function openBasedirValue(root) {
  const raw = String(root || '').trim();
  if (!raw) return '';
  const base = path.resolve(raw);
  const rel = path.relative(WEB_ROOT, base);
  const siteDir = (rel && !rel.startsWith('..') && !path.isAbsolute(rel))
    ? path.join(WEB_ROOT, rel.split(path.sep)[0])
    : base;
  const allow = [`${siteDir}/`];
  if (siteDir !== base) allow.push('$document_root/');
  allow.push('/tmp/');
  return allow.join(':');
}

// 用 nginx 下发 open_basedir：PHP_ADMIN_VALUE 属 admin 级设置，优先级高于站点目录下的
// .user.ini。相比宝塔落盘 .user.ini 的方案，既没有 user_ini 缓存延迟（默认 300s），
// 站内放置 .user.ini 也无法把它放宽 —— 后者只有在文件被 chattr +i 锁定时才安全
function openBasedirParam(root) {
  const value = openBasedirValue(root);
  return value ? `        fastcgi_param PHP_ADMIN_VALUE "open_basedir=${value}";` : '';
}

// PHP 处理块：新建站点与存量静态站点启用 PHP 共用同一份格式，保证两种入口生成的配置一致
function phpLocationLines(fpmListen, root) {
  const isolation = openBasedirParam(root);
  return [
    '    location ~ \\.php$ {',
    `        fastcgi_pass ${fpmListen};`,
    '        fastcgi_index index.php;',
    '        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;',
    ...(isolation ? [isolation] : []),
    '        include fastcgi_params;',
    '    }',
  ];
}

// siteBody：生成 server 块内部主体行（反代或静态/PHP 根目录），供 HTTP 与 HTTPS 两种 server 块共用
function buildSiteBodyLines({ root, proxyPass, rewrite, type, fpmListen, logName }) {
  const lines = [];
  // 独立访问日志：流量统计按站点维度读取该文件，避免混在全局日志里无法归属
  if (logName) lines.push(...siteLogLines(logName), '');
  if (proxyPass) {
    lines.push('    location / {');
    lines.push(`        proxy_pass ${proxyPass};`);
    lines.push('        proxy_http_version 1.1;');
    lines.push('        proxy_set_header Host $host;');
    lines.push('        proxy_set_header X-Real-IP $remote_addr;');
    lines.push('        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
    lines.push('        proxy_set_header X-Forwarded-Proto $scheme;');
    lines.push('    }');
  } else {
    const isPhp = type === 'php';
    lines.push(`    root ${root};`);
    lines.push(isPhp ? '    index index.php index.html index.htm;' : '    index index.html index.htm;');
    lines.push('');
    const preset = REWRITE_PRESETS[rewrite];
    if (preset) {
      lines.push(...preset);
    } else {
      lines.push('    location / {');
      lines.push('        try_files $uri $uri/ =404;');
      lines.push('    }');
    }
    if (isPhp) {
      lines.push('');
      lines.push(...phpLocationLines(fpmListen, root));
    }
  }
  return lines;
}

// 为存量站点补写独立访问日志（流量统计依赖该文件）：
// 与新建站点写入的内容、位置完全一致，已存在的行不重复写入；写前备份，校验失败回滚
async function enableSiteLog(siteName) {
  const key = String(siteName || '').trim();
  if (!SITE_NAME_RE.test(key)) throw new Error('非法站点名称');
  const site = (await listSites()).find((item) => item.name === key);
  if (!site || !site.file) throw new Error('站点不存在');
  // 已停止的站点配置未被 nginx 加载，此时写入日志指令不会生效
  if (site.enabled === false) throw new Error('站点已停止，请先重启站点再启用独立访问日志');

  const original = await fs.promises.readFile(site.file, 'utf8');
  const rows = original.split('\n').map((row) => row.trim());
  const missing = siteLogLines(key).filter((line) => !rows.includes(line.trim()));
  if (missing.length === 0) {
    return { file: site.file, injected: false, reloaded: false };
  }

  // 插到首个 server_name 之后：与 Fail2ban 站点保护注入位置一致，
  // 保证日志指令落在真正生效的 server 块内（Certbot 追加的跳转块不带业务指令）
  const out = [];
  let inserted = false;
  for (const raw of original.split('\n')) {
    out.push(raw);
    if (!inserted && /^\s*server_name\s/.test(raw)) {
      out.push(...missing);
      inserted = true;
    }
  }
  if (!inserted) throw new Error('未在站点配置中找到 server_name，无法写入日志指令');

  const backupPath = `${site.file}.${Date.now()}.bak`;
  await fs.promises.writeFile(backupPath, original, 'utf8');
  await fs.promises.writeFile(site.file, out.join('\n'), 'utf8');

  const test = await run('nginx', ['-t']);
  if (test.exitCode !== 0) {
    await fs.promises.writeFile(site.file, original, 'utf8');
    await fs.promises.unlink(backupPath).catch(() => {});
    throw new Error(`配置校验失败，已回滚：${(test.stderr || test.stdout || '').trim()}`);
  }
  const reload = await run('systemctl', ['reload', servicesConfig.service]);
  return {
    file: site.file,
    injected: true,
    injectedLines: missing.map((l) => l.trim()),
    backup: backupPath,
    reloaded: reload.exitCode === 0,
  };
}

// 定位配置里所有 PHP 处理块的范围，返回 [起始下标, 结束下标) 列表。
// 用花括号配对取块，避免块内出现嵌套 `if` 时被截断
function findPhpLocationRanges(text) {
  const ranges = [];
  const re = /location\s+~\s+\\\.php\$\s*\{/g;
  let hit;
  while ((hit = re.exec(text)) !== null) {
    const open = hit.index + hit[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) break; // 花括号不配对，放弃后续解析
    ranges.push([hit.index, end]);
    re.lastIndex = end;
  }
  return ranges;
}

// 定位配置里所有 server 块的范围，记录块内主体区间，供按站点注入/移除 PHP 指令使用。
// 与 parseServerBlocks 一样用花括号配对，嵌套的 location / if 不参与边界判断
function findServerBlockRanges(text) {
  const ranges = [];
  const re = /server\s*\{/g;
  let hit;
  while ((hit = re.exec(text)) !== null) {
    const open = hit.index + hit[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) break;
    ranges.push({ bodyStart: open + 1, bodyEnd: end - 1 });
    re.lastIndex = end;
  }
  return ranges;
}

// 调整 server 块内的 index 指令：启用 PHP 时把 index.php 放到首位，禁用时移除该项。
// 原配置没有 index 指令时启用后补一行，避免只加 fastcgi 块却仍以 index.html 为默认首页
function adjustIndexDirective(body, enable) {
  const re = /^([ \t]*)index[ \t]+([^;\r\n]+);/m;
  const hit = re.exec(body);
  if (hit) {
    let tokens = hit[2].trim().split(/\s+/).filter(Boolean);
    if (enable) {
      if (!tokens.includes('index.php')) tokens = ['index.php', ...tokens];
    } else {
      tokens = tokens.filter((token) => token !== 'index.php');
    }
    if (!tokens.length) tokens = ['index.html', 'index.htm'];
    return body.replace(re, `${hit[1]}index ${tokens.join(' ')};`);
  }
  if (!enable) return body;
  const rootHit = /^([ \t]*)root[ \t]+[^;\r\n]+;[ \t]*$/m.exec(body);
  if (!rootHit) return body;
  const at = rootHit.index + rootHit[0].length;
  return `${body.slice(0, at)}\n${rootHit[1]}index index.php index.html index.htm;${body.slice(at)}`;
}

// 为站点配置启用 PHP：对每个含 root 的业务 server 块注入 PHP 处理块（已有则只改转发目标），
// 并同步 index 指令。返回是否新增了处理块，便于调用方区分「切换版本」与「由静态启用」
function enablePhpInConfig(text, { fpmListen, root }) {
  const ranges = findServerBlockRanges(text);
  let out = text;
  let injected = 0;
  // 从后往前处理，前面块的偏移不会被插入内容影响
  for (const range of ranges.reverse()) {
    const body = out.slice(range.bodyStart, range.bodyEnd);
    if (!/\broot\s+[^;\r\n]+;/.test(body)) continue;
    if (/\bproxy_pass\s+[^;\r\n]+;/.test(body)) continue;
    if (!/\bfastcgi_pass\s+[^;\r\n]+;/.test(body)) injected += 1;
    const blockRoot = body.match(/\broot\s+([^;\r\n]+);/)?.[1]?.trim() || root;
    // 已有 fastcgi_pass 的块只替换转发目标，避免重复写入 location 块
    let nextBody = body.replace(/^([ \t]*fastcgi_pass[ \t]+)[^;\r\n]+;/gm, (m, prefix) => `${prefix}${fpmListen};`);
    if (!/\bfastcgi_pass\s+[^;\r\n]+;/.test(body)) {
      const trimmed = nextBody.replace(/\s*$/, '');
      nextBody = `${trimmed}\n\n${phpLocationLines(fpmListen, blockRoot).join('\n')}\n`;
    }
    const adjusted = adjustIndexDirective(nextBody, true);
    out = `${out.slice(0, range.bodyStart)}${adjusted}${out.slice(range.bodyEnd)}`;
  }
  return { text: out, injected };
}

// 将站点配置改回静态 HTML：删除所有 PHP 处理块（含其中的 open_basedir 下发），
// 并从 index 指令中移除 index.php
function disablePhpInConfig(text) {
  let out = text;
  let removed = 0;
  for (const [rawStart, rawEnd] of findPhpLocationRanges(out).reverse()) {
    let start = rawStart;
    while (start > 0 && (out[start - 1] === ' ' || out[start - 1] === '\t')) start -= 1;
    // 块前若是空行一并删除，避免移除后留下连续空行
    if (start > 0 && out[start - 1] === '\n') {
      const prevLineStart = out.lastIndexOf('\n', start - 2) + 1;
      if (!out.slice(prevLineStart, start - 1).trim()) start = prevLineStart;
    }
    let end = rawEnd;
    while (end < out.length && (out[end] === ' ' || out[end] === '\t')) end += 1;
    if (out[end] === '\r') end += 1;
    if (out[end] === '\n') end += 1;
    out = `${out.slice(0, start)}${out.slice(end)}`;
    removed += 1;
  }
  if (removed) {
    const ranges = findServerBlockRanges(out);
    for (const range of ranges.reverse()) {
      const body = out.slice(range.bodyStart, range.bodyEnd);
      const adjusted = adjustIndexDirective(body, false);
      if (adjusted === body) continue;
      out = `${out.slice(0, range.bodyStart)}${adjusted}${out.slice(range.bodyEnd)}`;
    }
  }
  return { text: out, removed };
}

// 为存量 PHP 站点补写目录隔离：向 siteBody 写入的位置（fastcgi_pass 之后）注入同一行，
// 已注入的文件不重复写；写前备份，校验失败回滚
async function enableSiteOpenBasedir(siteName) {
  const key = String(siteName || '').trim();
  if (!SITE_NAME_RE.test(key)) throw new Error('非法站点名称');
  const site = (await listSites()).find((item) => item.name === key);
  if (!site || !site.file) throw new Error('站点不存在');
  if (site.type !== 'php') throw new Error('仅 PHP 站点需要目录隔离，静态与反向代理站点不经过 PHP-FPM');
  // 已停止的站点配置未被 nginx 加载，此时写入不会生效
  if (site.enabled === false) throw new Error('站点已停止，请先重启站点再配置目录隔离');
  if (!site.root) throw new Error('站点未配置网站根目录，无法生成目录隔离配置');

  const line = openBasedirParam(site.root);
  if (!line) throw new Error('站点未配置网站根目录，无法生成目录隔离配置');

  const original = await fs.promises.readFile(site.file, 'utf8');
  // 从后往前插入，保证前面块的下标不因插入而失效
  const ranges = findPhpLocationRanges(original).reverse();
  let out = original;
  let injected = 0;
  for (const [start, end] of ranges) {
    const block = out.slice(start, end);
    if (/PHP_ADMIN_VALUE[^;]*open_basedir=/.test(block)) continue;
    const anchor = /[ \t]*fastcgi_pass[^\n]*\n/.exec(block);
    const at = anchor
      ? start + anchor.index + anchor[0].length
      : out.indexOf('\n', start) + 1;
    out = `${out.slice(0, at)}${line}\n${out.slice(at)}`;
    injected += 1;
  }
  if (injected === 0) {
    return { file: site.file, injected: false, injectedLines: [], reloaded: false };
  }

  const backupPath = `${site.file}.${Date.now()}.bak`;
  await fs.promises.writeFile(backupPath, original, 'utf8');
  await fs.promises.writeFile(site.file, out, 'utf8');

  const test = await run('nginx', ['-t']);
  if (test.exitCode !== 0) {
    await fs.promises.writeFile(site.file, original, 'utf8');
    await fs.promises.unlink(backupPath).catch(() => {});
    throw new Error(`配置校验失败，已回滚：${(test.stderr || test.stdout || '').trim()}`);
  }
  const reload = await run('systemctl', ['reload', servicesConfig.service]);
  return {
    file: site.file,
    injected: true,
    injectedLines: [line.trim()],
    openBasedir: openBasedirValue(site.root),
    backup: backupPath,
    reloaded: reload.exitCode === 0,
  };
}

// 设置站点 PHP 版本：version 传具体版本时启用 PHP 或切换版本，传空字符串表示改回静态 HTML。
// 已停止的站点配置位于 .disabled 目录，同样改写，重启站点后生效
async function setSitePhpVersion(siteName, version) {
  const key = String(siteName || '').trim();
  if (!SITE_NAME_RE.test(key)) throw new Error('非法站点名称');
  const targetVersion = String(version ?? '').trim();

  const site = (await listSites()).find((item) => item.name === key);
  if (!site || !site.file) throw new Error('站点不存在');
  if (site.proxyPass) throw new Error('反向代理站点不经过 PHP-FPM，无法设置 PHP 版本');
  if (!site.root) throw new Error('站点未配置网站根目录，无法设置 PHP 版本');

  // 目标为静态 HTML：删除 PHP 处理块；本身已是静态站点则无需改动
  if (!targetVersion) {
    if (site.type !== 'php') {
      return {
        file: site.file,
        type: 'html',
        phpVersion: '',
        fpmListen: '',
        changed: false,
        enabled: site.enabled !== false,
        reloaded: false,
      };
    }
    const original = await fs.promises.readFile(site.file, 'utf8');
    const { text: next, removed } = disablePhpInConfig(original);
    if (!removed) throw new Error('站点配置中未找到 PHP 处理块，无法改回静态 HTML');

    const backupPath = `${site.file}.${Date.now()}.bak`;
    await fs.promises.writeFile(backupPath, original, 'utf8');
    await fs.promises.writeFile(site.file, next, 'utf8');

    const test = await run('nginx', ['-t']);
    if (test.exitCode !== 0) {
      await fs.promises.writeFile(site.file, original, 'utf8');
      await fs.promises.unlink(backupPath).catch(() => {});
      throw new Error(`配置校验失败，已回滚：${(test.stderr || test.stdout || '').trim()}`);
    }

    let reloaded = false;
    if (site.enabled !== false) {
      const reload = await run('systemctl', ['reload', servicesConfig.service]);
      if (reload.exitCode !== 0) {
        await fs.promises.writeFile(site.file, original, 'utf8');
        await fs.promises.unlink(backupPath).catch(() => {});
        await run('nginx', ['-t']);
        await run('systemctl', ['reload', servicesConfig.service]);
        throw new Error(`Nginx 重载失败，已回滚：${(reload.stderr || reload.stdout || '').trim()}`);
      }
      reloaded = true;
    }
    return {
      file: site.file,
      type: 'html',
      phpVersion: '',
      fpmListen: '',
      changed: true,
      enabled: site.enabled !== false,
      backup: backupPath,
      reloaded,
    };
  }

  const fpmListen = await phpService.getFpmListen(targetVersion);
  if (!fpmListen) throw new Error(`未检测到 PHP ${targetVersion} 可用的 PHP-FPM，请确认该版本已安装并启动`);
  // 已是指定版本的 PHP 站点，无需改写配置
  if (site.type === 'php' && site.fpmListen === fpmListen) {
    return {
      file: site.file,
      type: 'php',
      phpVersion: site.phpVersion || targetVersion,
      fpmListen,
      changed: false,
      enabled: site.enabled !== false,
      reloaded: false,
    };
  }

  const original = await fs.promises.readFile(site.file, 'utf8');
  // 静态站点会注入完整 PHP 处理块，PHP 站点则只替换转发目标
  const { text: next, injected } = enablePhpInConfig(original, { fpmListen, root: site.root });
  if (next === original) throw new Error('站点配置中没有可启用 PHP 的 server 块，无法设置 PHP 版本');

  const backupPath = `${site.file}.${Date.now()}.bak`;
  await fs.promises.writeFile(backupPath, original, 'utf8');
  await fs.promises.writeFile(site.file, next, 'utf8');

  const test = await run('nginx', ['-t']);
  if (test.exitCode !== 0) {
    await fs.promises.writeFile(site.file, original, 'utf8');
    await fs.promises.unlink(backupPath).catch(() => {});
    throw new Error(`配置校验失败，已回滚：${(test.stderr || test.stdout || '').trim()}`);
  }

  // 已停止的站点未被 nginx 加载，改写配置即可，无需重载
  let reloaded = false;
  if (site.enabled !== false) {
    const reload = await run('systemctl', ['reload', servicesConfig.service]);
    if (reload.exitCode !== 0) {
      // 重载失败说明新配置未生效，恢复原配置并再次重载，避免站点继续使用旧配置
      await fs.promises.writeFile(site.file, original, 'utf8');
      await fs.promises.unlink(backupPath).catch(() => {});
      await run('nginx', ['-t']);
      await run('systemctl', ['reload', servicesConfig.service]);
      throw new Error(`Nginx 重载失败，已回滚：${(reload.stderr || reload.stdout || '').trim()}`);
    }
    reloaded = true;
  }
  return {
    file: site.file,
    type: 'php',
    phpVersion: targetVersion,
    fpmListen,
    changed: true,
    converted: injected > 0,
    enabled: site.enabled !== false,
    backup: backupPath,
    reloaded,
  };
}

// 站点空间占用：按站点根目录统计磁盘使用量（含子目录），供站点列表展示。
// 反向代理站点或根目录不存在的站点不计入；单个站点统计失败不影响其它站点
async function getSiteSizes() {
  const sites = await listSites();
  const sizes = {};
  // 多个站点共用根目录时只统计一次，避免重复遍历大目录
  const cache = new Map();
  for (const site of sites) {
    // 按站点根目录统计（含运行目录之外的 vendor、storage 等），而非仅统计 nginx 运行目录
    const root = String(site.siteDir || site.root || '').trim();
    if (!root || !root.startsWith('/')) {
      sizes[site.name] = null;
      continue;
    }
    if (!cache.has(root)) {
      let value = null;
      try {
        if (fs.existsSync(root)) {
          const res = await run('du', ['-sb', '--', root], { timeout: 60000 });
          const bytes = parseInt(String(res.stdout || '').trim().split(/\s+/)[0], 10);
          if (res.exitCode === 0 && Number.isFinite(bytes)) value = bytes;
        }
      } catch (err) {
        // 忽略：该站点空间大小显示为未知
      }
      cache.set(root, value);
    }
    sizes[site.name] = cache.get(root);
  }
  return sizes;
}

// 站点类型：静态 HTML 或 PHP（PHP 会额外生成 fastcgi 转发块）
// 提供 certPath/keyPath 时生成 80 跳转 + 443 反代的完整 HTTPS 配置（直接复用面板已有证书）
function buildSiteConfig({ serverName, listen, root, proxyPass, rewrite, type, fpmListen, certPath, keyPath, logName }) {
  if (certPath && keyPath) {
    const httpsLines = [
      'server {',
      '    listen 443 ssl;',
      `    server_name ${serverName};`,
      `    ssl_certificate ${certPath};`,
      `    ssl_certificate_key ${keyPath};`,
      '',
      ...buildSiteBodyLines({ root, proxyPass, rewrite, type, fpmListen, logName }),
      '}',
    ];
    const redirectLines = [
      'server {',
      `    listen ${listen};`,
      `    server_name ${serverName};`,
      '    return 301 https://$host$request_uri;',
      '}',
    ];
    return `${httpsLines.join('\n')}\n\n${redirectLines.join('\n')}\n`;
  }
  const lines = ['server {', `    listen ${listen};`, `    server_name ${serverName};`, ''];
  lines.push(...buildSiteBodyLines({ root, proxyPass, rewrite, type, fpmListen, logName }));
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

// 默认首页样式（英文页面，避免与站点自身样式混淆）
const DEFAULT_PAGE_STYLE = `    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: radial-gradient(circle at 50% 0%, #1e293b 0%, #0f172a 70%); color: #e2e8f0;
    }
    main { width: 100%; max-width: 680px; padding: 56px 32px; text-align: center; }
    h1 { margin: 0 0 16px; font-size: 30px; font-weight: 600; letter-spacing: -0.02em; }
    p { margin: 10px 0; color: #94a3b8; font-size: 15px; line-height: 1.75; }
    code { padding: 2px 7px; border-radius: 6px; background: rgba(148, 163, 184, 0.16); color: #cbd5e1; font-size: 13px; }
    .meta { margin-top: 28px; font-size: 13px; color: #64748b; }`;

// 新站点默认首页：仅用于确认站点已可用，用户可自行覆盖
function buildDefaultPage(domain, type) {
  const title = `Welcome to ${domain}`;
  if (type === 'php') {
    return `<?php
// Default page generated by the panel for ${domain}.
// Replace this file with your own application.
$title = 'Welcome to ${domain}';
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title><?php echo htmlspecialchars($title); ?></title>
  <style>
${DEFAULT_PAGE_STYLE}
  </style>
</head>
<body>
  <main>
    <h1><?php echo htmlspecialchars($title); ?></h1>
    <p>This site has been created and is now served by nginx with PHP-FPM.</p>
    <p>PHP <?php echo PHP_VERSION; ?> is running correctly.</p>
    <p>Replace <code>index.php</code> in the document root with your own code to get started.</p>
    <p class="meta">Generated by glass-panel</p>
  </main>
</body>
</html>
`;
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
${DEFAULT_PAGE_STYLE}
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>This site has been created and is now served by nginx as a static website.</p>
    <p>Upload your files to the document root, or replace <code>index.html</code> with your own homepage.</p>
    <p class="meta">Generated by glass-panel</p>
  </main>
</body>
</html>
`;
}

// 开通流程的步骤定义（建站领域唯一真源，路由层据此初始化进度）
const PROVISION_STEPS = [
  { key: 'directory' },
  { key: 'ssl' },
  { key: 'database' },
];

// 默认空上报器：旧调用方（appService 安装 3x-ui 时自动建反代站点）无需感知进度
const NOOP_REPORTER = {
  begin() {},
  note() {},
  complete() {},
  fail() {},
  skip() {},
  failOpen() {},
};

async function createSite(input, { reporter = NOOP_REPORTER } = {}) {
  try {
    return await createSiteInner(input || {}, reporter);
  } catch (err) {
    // 标记是哪一步失败后原样抛出，保持既有错误契约不变
    reporter.failOpen(err.message);
    throw err;
  }
}

async function createSiteInner({
  name,
  serverName,
  listen,
  root,
  proxyPass,
  runDir,
  rewrite,
  type,
  phpVersion,
  ssl,
  email,
  createDb,
  certPath,
  keyPath,
}, reporter) {
  const siteName = String(name || '').trim().replace(/\.conf$/, '');
  const domain = String(serverName || '').trim();
  const port = String(listen || '80').trim();
  const docRoot = String(root || '').trim();
  const proxy = String(proxyPass || '').trim();
  const runDirClean = String(runDir || '').trim().replace(/^\/+|\/+$/g, '');
  const rewriteKey = String(rewrite || 'none').trim();
  const typeKey = String(type || 'html').trim();
  const phpVersionKey = String(phpVersion || '').trim();
  const wantSsl = ssl === true || ssl === 'true';
  const wantDb = createDb === true || createDb === 'true';
  const mail = String(email || '').trim();

  // 未勾选的步骤提前标记为「已跳过」，进度弹窗打开即可看到
  if (!wantSsl) reporter.skip('ssl', 'disabled');
  if (!wantDb) reporter.skip('database', 'disabled');

  if (!SITE_NAME_RE.test(siteName)) {
    throw new Error('站点名称只能包含中文、字母、数字、点、下划线和短横线');
  }
  if (siteName.length > 64) throw new Error('站点名称最多 64 个字符');
  if (!domain) throw new Error('请填写域名（server_name）');
  if (!/^\d+$/.test(port)) throw new Error('监听端口必须是数字');
  if (!proxy && !docRoot) throw new Error('请填写网站根目录，或填写反向代理地址');
  if (proxy && !/^https?:\/\//.test(proxy)) {
    throw new Error('反向代理地址需以 http:// 或 https:// 开头');
  }
  if (!Object.prototype.hasOwnProperty.call(REWRITE_PRESETS, rewriteKey)) {
    throw new Error('不支持的伪静态规则');
  }
  if (!['html', 'php'].includes(typeKey)) throw new Error('不支持的站点类型');

  // PHP 站点需要 fastcgi_pass：从已安装的 php-fpm pool 解析，解析不到说明环境缺 PHP。
  // phpVersion 为空时使用面板默认版本（已安装的最高源码编译版本）
  let fpmListen = '';
  if (typeKey === 'php' && !proxy) {
    fpmListen = await phpService.getFpmListen(phpVersionKey);
    if (!fpmListen) {
      throw new Error(phpVersionKey
        ? `未检测到 PHP ${phpVersionKey} 可用的 PHP-FPM，请确认该版本已安装并启动`
        : '未检测到可用的 PHP-FPM，请先在应用中心安装并启动 PHP');
    }
  }

  const filePath = path.join(SITE_DIR, `${siteName}.conf`);
  if (fs.existsSync(filePath)) throw new Error(`站点配置已存在：${filePath}`);

  // 域名冲突检测：请求 ssl 时实际会占用 80（跳转）与 443，需一并纳入比较
  const targetPorts = wantSsl ? new Set([port, '80', '443']) : new Set([port]);
  const conflict = await findDomainConflict(domain, siteName, targetPorts);
  if (conflict) {
    throw new Error(
      `域名冲突：${conflict.domain} 已被站点 ${conflict.site} 占用（${conflict.file}），`
      + '同端口下 nginx 只会命中先加载的 server 块，新站点将被遮蔽。请先重启、停用或删除该站点后重试'
    );
  }

  // 校验全部通过，进入步骤 1「创建目录」（涵盖建目录、默认首页、写配置、校验、重载）
  reporter.begin('directory');
  reporter.note('directory', '正在创建网站目录与 nginx 配置');

  // 运行目录拼接在网站根目录之后，作为 nginx 实际 root
  const siteRoot = runDirClean ? path.join(docRoot, runDirClean) : docRoot;

  // 静态站点：自动创建网站根目录与默认首页，避免站点打开是 403/404
  let defaultPage = '';
  if (siteRoot && !proxy) {
    await fs.promises.mkdir(siteRoot, { recursive: true });
    defaultPage = path.join(siteRoot, typeKey === 'php' ? 'index.php' : 'index.html');
    // 已存在同名首页时不覆盖，避免冲掉用户内容
    if (!fs.existsSync(defaultPage)) {
      await fs.promises.writeFile(defaultPage, buildDefaultPage(domain, typeKey), 'utf8');
    }
    reporter.note('directory', `已创建网站目录与默认首页：${defaultPage}`);
  }

  // 校验传入证书路径必须位于 Let's Encrypt live 目录内，防止任意路径写入配置
  const certDirOk = (p) => {
    const abs = String(p || '').trim();
    if (!abs) return false;
    if (abs.includes('..')) return false;
    const liveDir = sslService.getLiveDir();
    return path.resolve(abs).startsWith(path.resolve(liveDir));
  };
  const primary = pickPrimaryDomain(domain);
  // 已有证书可直接引用：证书文件存在时生成 80 跳转 + 443 反代配置，免去重新签发
  const reuseCert = wantSsl
    && certDirOk(certPath) && certDirOk(keyPath)
    && fs.existsSync(certPath) && fs.existsSync(keyPath);

  const content = buildSiteConfig({
    serverName: domain,
    listen: port,
    root: siteRoot,
    proxyPass: proxy,
    rewrite: rewriteKey,
    type: typeKey,
    fpmListen,
    certPath: reuseCert ? String(certPath).trim() : '',
    keyPath: reuseCert ? String(keyPath).trim() : '',
    logName: siteName,
  });
  // 配置头部记录网站根目录：nginx root 可能是其下的运行目录，站点列表需要区分展示
  const markedContent = (!proxy && docRoot)
    ? `# glass-panel:site-root ${docRoot}\n${content}`
    : content;
  await fs.promises.writeFile(filePath, markedContent, 'utf8');
  reporter.note('directory', `配置文件已写入 ${filePath}`);

  // 先校验再重载，校验失败时回滚新配置，避免影响在运行的站点
  const test = await run('nginx', ['-t']);
  if (test.exitCode !== 0) {
    await fs.promises.unlink(filePath).catch(() => {});
    throw new Error(`配置校验失败，已回滚：${(test.stderr || test.stdout || '').trim()}`);
  }
  reporter.note('directory', 'nginx -t 配置校验通过');

  const reload = await run('systemctl', ['reload', servicesConfig.service]);
  // 重载失败不抛错也不计入 warnings（保持既有语义），仅在进度里提示站点尚未生效
  if (reload.exitCode === 0) {
    reporter.complete('directory', 'Nginx 已重载，站点已生效');
  } else {
    reporter.complete('directory', `Nginx 重载未成功（退出码 ${reload.exitCode}），站点尚未生效`);
  }

  // 站点已生效，后续 SSL 与数据库失败只记录告警，不影响站点本身
  const warnings = [];
  let sslResult = null;
  let database = null;

  // 一张证书覆盖站点的全部域名：多域名站点（如 www + 裸域名）不能只签首个域名，
  // 否则其余域名访问 443 会因证书不匹配而失败
  const sslDomains = [...new Set(
    String(domain || '')
      .split(/\s+/)
      .map((d) => d.trim())
      .filter((d) => d && d !== '_' && !d.includes('*'))
  )];

  if (wantSsl) {
    if (sslDomains.length === 0) {
      warnings.push('未找到可用于签发证书的域名');
      reporter.fail('ssl', '未找到可用于签发证书的域名');
    } else if (reuseCert) {
      // 配置中已引用面板已有证书，无需重新签发
      sslResult = { domain: primary, domains: sslDomains, success: true, reused: true };
      reporter.complete('ssl', '已复用面板已有证书');
    } else {
      // 站点已占用 80 端口，必须使用 nginx 插件签发而非 standalone；
      // --expand 用于已有单域名证书时补全新域名，而不是报错退出
      reporter.begin('ssl');
      reporter.note('ssl', `正在为 ${sslDomains.join('、')} 签发证书`);
      const args = ['--nginx'];
      for (const d of sslDomains) args.push('-d', d);
      args.push('--agree-tos', '-n', '--redirect', '--expand');
      if (mail) args.push('-m', mail);
      else args.push('--register-unsafely-without-email');
      const result = await run('certbot', args, { timeout: 180000 });
      sslResult = { domain: primary, domains: sslDomains, success: result.exitCode === 0 };
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout || '').trim().slice(0, 300);
        warnings.push(`SSL 证书签发失败：${detail}`);
        reporter.fail('ssl', `证书签发失败：${detail}`);
      } else {
        reporter.complete('ssl', '证书签发成功');
      }
    }
  }

  if (wantDb) {
    if (!primary) {
      warnings.push('未找到可用于生成数据库名的域名');
      reporter.fail('database', '未找到可用于生成数据库名的域名');
    } else {
      reporter.begin('database');
      try {
        database = await mysqlService.createDatabase({
          dbName: mysqlService.normalizeName(primary),
          user: mysqlService.normalizeName(primary),
          password: mysqlService.generatePassword(),
        });
        // 密码只在开通流程展示一次，落库保存才能让 MySQL 列表里随时查看
        store.saveDatabaseCredential(database.dbName, database.user, database.password);
        reporter.complete('database', `数据库 ${database.dbName} 创建成功`);
      } catch (err) {
        warnings.push(`数据库创建失败：${err.message}`);
        reporter.fail('database', `数据库创建失败：${err.message}`);
      }
    }
  }

  return {
    name: siteName,
    file: filePath,
    content,
    root: siteRoot,
    type: typeKey,
    fpmListen,
    defaultPage,
    reloaded: reload.exitCode === 0,
    ssl: sslResult,
    database,
    warnings,
  };
}

// 汇总站点关联资源（数据库、证书），供删除前的确认弹窗展示
async function getSiteRelations(siteName) {
  const { name: key, active, disabled } = sitePaths(siteName);
  const activeExists = fs.existsSync(active);
  const disabledExists = fs.existsSync(disabled);
  if (!activeExists && !disabledExists) throw new Error('站点配置文件不存在');
  // 已停止的站点：原配置在 .disabled，conf.d 下只剩停止占位页，站点配置以原配置为准
  const filePath = disabledExists ? disabled : active;
  // 停止占位页需与站点配置一并删除，否则域名会一直停留在停止页
  const extraFiles = activeExists && isStopPageFile(active) ? [active] : [];

  const site = (await listSites()).find((item) => item.name === key);
  // 库名与证书名均按创建站点时的规则由首个域名推导，保证与创建时一致
  const primary = pickPrimaryDomain(site?.serverName || '');
  const dbName = primary ? mysqlService.normalizeName(primary) : '';

  return {
    name: key,
    file: filePath,
    extraFiles,
    serverName: site?.serverName || '',
    primaryDomain: primary,
    root: site?.root || '',
    dbName,
    dbExists: dbName ? await mysqlService.databaseExists(dbName) : false,
    certName: primary,
    certExists: primary ? fs.existsSync(path.join('/etc/letsencrypt/live', primary)) : false,
  };
}

// 删除站点：先移除配置并校验通过，再清理关联的数据库与 SSL 证书
async function deleteSite(siteName, { removeDb = true, removeSsl = true } = {}) {
  const relations = await getSiteRelations(siteName);
  const warnings = [];
  // 临时改名而非直接删除：校验失败时用于还原站点配置；
  // 已停止的站点还需一并移除 conf.d 下的停止占位页，否则域名会停在停止页
  const targets = [relations.file, ...(relations.extraFiles || [])];
  const stamp = Date.now();
  const moved = targets.map((from, idx) => ({ from, to: `${from}.deleted.${stamp}.${idx}` }));

  for (const item of moved) await fs.promises.rename(item.from, item.to);
  const test = await run('nginx', ['-t']);
  if (test.exitCode !== 0) {
    for (const item of moved) await fs.promises.rename(item.to, item.from).catch(() => {});
    throw new Error(`配置校验失败，站点未删除：${(test.stderr || test.stdout || '').trim()}`);
  }
  await run('systemctl', ['reload', servicesConfig.service]);

  // 站点已下线，后续清理失败只记录告警
  let database = null;
  if (removeDb && relations.dbExists) {
    try {
      await mysqlService.dropDatabase({ dbName: relations.dbName, user: relations.dbName });
      // 库已删除，凭据记录一并清理，避免列表里残留失效的密码
      store.deleteManagedDatabase(relations.dbName);
      database = { dbName: relations.dbName, dropped: true };
    } catch (err) {
      warnings.push(`数据库删除失败：${err.message}`);
    }
  }

  let certificate = null;
  if (removeSsl && relations.certExists) {
    const result = await run('certbot', ['delete', '--cert-name', relations.primaryDomain, '--non-interactive'], {
      timeout: 120000,
    });
    certificate = { domain: relations.primaryDomain, deleted: result.exitCode === 0 };
    if (result.exitCode !== 0) {
      warnings.push(`SSL 证书删除失败：${(result.stderr || result.stdout || '').trim().slice(0, 300)}`);
    }
  }

  // 证书删除后复核一次，确认没有其他站点仍在引用被删证书
  const finalTest = await run('nginx', ['-t']);
  if (finalTest.exitCode !== 0) {
    warnings.push(`证书删除后配置校验失败，请检查是否有其他站点引用该证书：${(finalTest.stderr || finalTest.stdout || '').trim().slice(0, 300)}`);
  }

  for (const item of moved) await fs.promises.unlink(item.to).catch(() => {});

  // 清理历史配置备份（<file>.<ts>.bak / <file>.bak.<ts>），避免留下不可见残留
  try {
    const bakPrefix = `${path.basename(relations.file)}.`;
    const bakFiles = fs.readdirSync(SITE_DIR)
      .filter((f) => f.startsWith(bakPrefix) && f.includes('.bak'))
      .map((f) => path.join(SITE_DIR, f));
    for (const f of bakFiles) await fs.promises.unlink(f).catch(() => {});
  } catch (err) {
    warnings.push(`历史备份清理失败：${err.message}`);
  }

  // 清理站点根目录：仅限 /var/www 下的一级目录，防止误删其它路径
  let rootDeleted = false;
  const root = (relations.root || '').replace(/\/+$/, '');
  if (root.startsWith('/var/www/') && root.split('/').length >= 4) {
    try {
      const st = fs.lstatSync(root);
      if (st.isDirectory()) {
        await fs.promises.rm(root, { recursive: true, force: true });
      } else {
        // 符号链接等非目录：只删链接本身，不动指向的目标
        await fs.promises.unlink(root);
      }
      rootDeleted = true;
    } catch (err) {
      warnings.push(`站点根目录删除失败：${err.message}`);
    }
  }

  return {
    name: relations.name,
    file: relations.file,
    serverName: relations.serverName,
    root: relations.root,
    rootDeleted,
    database,
    certificate,
    warnings,
  };
}

// 站点配置文件的两个可能位置：在线（conf.d）与已停止（conf.d/.disabled）
function sitePaths(siteName) {
  const key = String(siteName || '').trim();
  if (!SITE_NAME_RE.test(key)) throw new Error('非法站点名称');
  return {
    name: key,
    active: path.join(SITE_DIR, `${key}.conf`),
    disabled: path.join(SITE_DISABLED_DIR, `${key}.conf`),
  };
}

// 停止占位页内容：保留原 server_name、监听端口与证书指令，只返回 503 停止页。
// 证书指令必须保留，否则 443 端口会与其它站点的 listen 参数冲突导致 nginx -t 失败
function buildStopPage(originalText) {
  const uniq = (re) => [...new Set([...String(originalText || '').matchAll(re)].map((m) => m[1].trim()))];
  const listens = uniq(/listen\s+([^;]+);/g);
  const serverNames = uniq(/server_name\s+([^;]+);/g);
  const keepRe = /^\s*(ssl_certificate|ssl_certificate_key|ssl_trusted_certificate|ssl_dhparam|ssl_protocols|ssl_ciphers|ssl_prefer_server_ciphers|ssl_session_cache|ssl_session_timeout|ssl_session_tickets|ssl_stapling)/;
  const keep = String(originalText || '').split('\n').map((l) => l.trim()).filter((l) => keepRe.test(l));
  return [
    STOP_PAGE_MARK,
    '# 站点已停止，此文件为占位页：保留域名与端口，避免请求落到同端口其它站点',
    'server {',
    ...listens.map((v) => `    listen ${v};`),
    `    server_name ${serverNames.join(' ') || '_'};`,
    ...keep.map((l) => `    ${l}`),
    '    add_header Cache-Control "no-store" always;',
    '    location / {',
    '        default_type text/html;',
    `        return 503 '${STOP_PAGE_HTML}';`,
    '    }',
    '}',
    '',
  ].join('\n');
}

// 文件是否为停止占位页（只读头部标记，读取失败按「不是」处理）
function isStopPageFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').includes(STOP_PAGE_MARK);
  } catch (err) {
    return false;
  }
}

// 停止站点：原配置移出 nginx 加载范围，原位置写入停止占位页并重载。
// 占位页保留域名与端口，避免域名串到同端口其它站点；
// 校验或重载失败时把原配置移回原位，保证不会把一个坏配置留在停用目录里
async function stopSite(siteName) {
  const { name, active, disabled } = sitePaths(siteName);
  const activeExists = fs.existsSync(active);
  const disabledExists = fs.existsSync(disabled);
  if (!activeExists && !disabledExists) throw new Error('站点配置文件不存在');

  // 已停止但缺少占位页（旧版本停止的站点）：补写占位页，让域名不再串站
  if (!activeExists) {
    const originalText = await fs.promises.readFile(disabled, 'utf8');
    await fs.promises.writeFile(active, buildStopPage(originalText), 'utf8');
    const test = await run('nginx', ['-t']);
    if (test.exitCode !== 0) {
      await fs.promises.unlink(active).catch(() => {});
      throw new Error(`停止页配置校验失败：${(test.stderr || test.stdout || '').trim().slice(0, 300)}`);
    }
    await run('systemctl', ['reload', servicesConfig.service]);
    return { name, file: disabled, enabled: false, changed: true, reloaded: true };
  }

  // 已停止且占位页就位：无需重复操作
  if (disabledExists && isStopPageFile(active)) {
    return { name, file: disabled, enabled: false, changed: false, reloaded: false };
  }

  const originalText = await fs.promises.readFile(active, 'utf8');
  await fs.promises.mkdir(SITE_DISABLED_DIR, { recursive: true });
  await fs.promises.rename(active, disabled);
  await fs.promises.writeFile(active, buildStopPage(originalText), 'utf8');

  const test = await run('nginx', ['-t']);
  if (test.exitCode !== 0) {
    await fs.promises.rename(disabled, active).catch(() => {});
    throw new Error(`配置校验失败，站点未停止：${(test.stderr || test.stdout || '').trim().slice(0, 300)}`);
  }
  const reload = await run('systemctl', ['reload', servicesConfig.service]);
  if (reload.exitCode !== 0) {
    // 重载失败时 nginx 仍按旧配置运行，把文件移回原位保持一致
    await fs.promises.rename(disabled, active).catch(() => {});
    await run('systemctl', ['reload', servicesConfig.service]);
    throw new Error(`Nginx 重载失败，站点未停止：${(reload.stderr || reload.stdout || '').trim().slice(0, 300)}`);
  }
  return { name, file: disabled, enabled: false, changed: true, reloaded: true };
}

// 重启失败时恢复停止状态：原配置移回 .disabled，原位置写回停止占位页
async function restoreStopPage(active, disabled, originalText) {
  await fs.promises.rename(active, disabled).catch(() => {});
  await fs.promises.writeFile(active, buildStopPage(originalText), 'utf8').catch(() => {});
}

// 重启站点：已停止的站点恢复配置（覆盖停止占位页）后重载；在线站点仅重载配置使其立即生效
async function restartSite(siteName) {
  const { name, active, disabled } = sitePaths(siteName);
  const wasDisabled = fs.existsSync(disabled);
  const activeExists = fs.existsSync(active);
  // 停止占位页不算在线配置：只有非占位页的在线配置才算真冲突
  const activeIsStopPage = activeExists && isStopPageFile(active);
  if (wasDisabled && activeExists && !activeIsStopPage) {
    throw new Error('同名站点配置已在线，请先处理配置冲突');
  }
  if (!wasDisabled && !activeExists) {
    throw new Error('站点配置文件不存在');
  }

  let originalText = '';
  if (wasDisabled) {
    originalText = await fs.promises.readFile(disabled, 'utf8');
    await fs.promises.mkdir(SITE_DIR, { recursive: true });
    await fs.promises.rename(disabled, active);
  }

  const test = await run('nginx', ['-t']);
  if (test.exitCode !== 0) {
    if (wasDisabled) await restoreStopPage(active, disabled, originalText);
    throw new Error(`配置校验失败，站点未重启：${(test.stderr || test.stdout || '').trim().slice(0, 300)}`);
  }
  const reload = await run('systemctl', ['reload', servicesConfig.service]);
  if (reload.exitCode !== 0) {
    if (wasDisabled) await restoreStopPage(active, disabled, originalText);
    throw new Error(`Nginx 重载失败：${(reload.stderr || reload.stdout || '').trim().slice(0, 300)}`);
  }
  return { name, file: active, enabled: true, changed: wasDisabled, reloaded: true };
}

async function readConfig(filePath) {
  if (!isPathAllowed(filePath)) throw new Error('非法配置文件路径');
  if (!fs.existsSync(filePath)) throw new Error('配置文件不存在');
  // 二次校验真实路径（文件可能通过符号链接指向允许目录外）
  const realFile = fs.realpathSync(filePath);
  if (!isPathAllowed(realFile)) throw new Error('非法配置文件路径');
  return fs.promises.readFile(realFile, 'utf8');
}

async function writeConfig(filePath, content, reload = false) {
  if (!isPathAllowed(filePath)) throw new Error('非法配置文件路径');
  const targetDir = path.dirname(filePath);
  // 父目录也必须是允许目录的子目录，防止 .. 与符号链接绕过
  if (!isPathAllowed(targetDir)) throw new Error('非法配置文件路径');
  await fs.promises.mkdir(targetDir, { recursive: true });

  // 先备份原文件，写入后校验，失败时回滚，避免把 Nginx 配坏
  const existed = fs.existsSync(filePath);
  const backupPath = existed ? `${filePath}.bak.${Date.now()}` : null;
  if (backupPath) {
    await fs.promises.copyFile(filePath, backupPath);
  }

  await fs.promises.writeFile(filePath, content, 'utf8');

  const test = await run('nginx', ['-t']);
  if (test.exitCode !== 0) {
    const msg = (test.stderr || test.stdout || '').trim();
    if (backupPath) {
      await fs.promises.copyFile(backupPath, filePath).catch(() => {});
      await fs.promises.unlink(backupPath).catch(() => {});
    } else {
      await fs.promises.unlink(filePath).catch(() => {});
    }
    throw new Error(`配置校验失败，已回滚：${msg}`);
  }

  let reloaded = false;
  let reloadOutput = null;
  if (reload) {
    reloadOutput = await run('systemctl', ['reload', servicesConfig.service]);
    reloaded = reloadOutput.exitCode === 0;
  }

  // 只有重载成功或未请求重载时才删除备份；重载失败保留备份并明确告知前端
  if (backupPath && (!reload || reloaded)) {
    await fs.promises.unlink(backupPath).catch(() => {});
  }

  return { success: true, reloaded, reloadFailed: reload && !reloaded, reloadOutput, testOutput: test };
}

module.exports = {
  getStatus,
  control,
  testConfig,
  listSites,
  getSiteSizes,
  parseServerBlocks,
  createSite,
  PROVISION_STEPS,
  getSiteRelations,
  deleteSite,
  stopSite,
  restartSite,
  readConfig,
  writeConfig,
  enableSiteLog,
  enableSiteOpenBasedir,
  setSitePhpVersion,
  buildSiteConfig,
  buildDefaultPage,
  NGINX_LOG_DIR,
};
