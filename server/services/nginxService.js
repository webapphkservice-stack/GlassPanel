const path = require('path');
const fs = require('fs');
const { run } = require('./commandRunner');
const servicesConfig = require('../config/services').nginx;
const mysqlService = require('./mysqlService');
const phpService = require('./phpService');
const sslService = require('./sslService');

// 站点配置目录：RHEL 系（Alibaba Cloud Linux）通过 conf.d/*.conf 引入
const SITE_DIR = path.join(servicesConfig.configDir, 'conf.d');
const SITE_NAME_RE = /^[A-Za-z0-9._-]+$/;

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

async function control(action) {
  const allowed = ['start', 'stop', 'restart', 'reload'];
  if (!allowed.includes(action)) throw new Error('非法操作');
  return run('systemctl', [action, servicesConfig.service]);
}

async function testConfig() {
  return run('nginx', ['-t']);
}

// 解析 nginx -T 输出为站点列表：先按花括号配对切出 server 块并归属到文件，
// 再把同一文件内 server_name 相同的块合并（Certbot 会追加一个 80 端口跳转块）
function parseServerBlocks(stdout, siteDir) {
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
    const site = {
      name: path.basename(file, '.conf'),
      file,
      serverName,
      listen: listens.join(', '),
      root: block.text.match(/root\s+([^;]+);/)?.[1]?.trim() || '',
      proxyPass: block.text.match(/proxy_pass\s+([^;]+);/)?.[1]?.trim() || '',
      ssl: /ssl/.test(block.text),
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
    exist.root = exist.root || site.root;
    exist.proxyPass = exist.proxyPass || site.proxyPass;
    exist.ssl = exist.ssl || site.ssl;
  }
  return merged;
}

async function listSites() {
  try {
    const { stdout } = await run('nginx', ['-T']);
    return parseServerBlocks(stdout, SITE_DIR);
  } catch (err) {
    return [];
  }
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
  const sites = await listSites();
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

// siteBody：生成 server 块内部主体行（反代或静态/PHP 根目录），供 HTTP 与 HTTPS 两种 server 块共用
function buildSiteBodyLines({ root, proxyPass, rewrite, type, fpmListen }) {
  const lines = [];
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
      lines.push('    location ~ \\.php$ {');
      lines.push(`        fastcgi_pass ${fpmListen};`);
      lines.push('        fastcgi_index index.php;');
      lines.push('        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;');
      lines.push('        include fastcgi_params;');
      lines.push('    }');
    }
  }
  return lines;
}

// 站点类型：静态 HTML 或 PHP（PHP 会额外生成 fastcgi 转发块）
// 提供 certPath/keyPath 时生成 80 跳转 + 443 反代的完整 HTTPS 配置（直接复用面板已有证书）
function buildSiteConfig({ serverName, listen, root, proxyPass, rewrite, type, fpmListen, certPath, keyPath }) {
  if (certPath && keyPath) {
    const httpsLines = [
      'server {',
      '    listen 443 ssl;',
      `    server_name ${serverName};`,
      `    ssl_certificate ${certPath};`,
      `    ssl_certificate_key ${keyPath};`,
      '',
      ...buildSiteBodyLines({ root, proxyPass, rewrite, type, fpmListen }),
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
  lines.push(...buildSiteBodyLines({ root, proxyPass, rewrite, type, fpmListen }));
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
  const wantSsl = ssl === true || ssl === 'true';
  const wantDb = createDb === true || createDb === 'true';
  const mail = String(email || '').trim();

  // 未勾选的步骤提前标记为「已跳过」，进度弹窗打开即可看到
  if (!wantSsl) reporter.skip('ssl', 'disabled');
  if (!wantDb) reporter.skip('database', 'disabled');

  if (!SITE_NAME_RE.test(siteName)) {
    throw new Error('站点名称只能包含字母、数字、点、下划线和短横线');
  }
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

  // PHP 站点需要 fastcgi_pass：从已安装的 php-fpm pool 解析，解析不到说明环境缺 PHP
  let fpmListen = '';
  if (typeKey === 'php' && !proxy) {
    fpmListen = await phpService.getFpmListen();
    if (!fpmListen) throw new Error('未检测到可用的 PHP-FPM，请先在应用中心安装并启动 PHP');
  }

  const filePath = path.join(SITE_DIR, `${siteName}.conf`);
  if (fs.existsSync(filePath)) throw new Error(`站点配置已存在：${filePath}`);

  // 域名冲突检测：请求 ssl 时实际会占用 80（跳转）与 443，需一并纳入比较
  const targetPorts = wantSsl ? new Set([port, '80', '443']) : new Set([port]);
  const conflict = await findDomainConflict(domain, siteName, targetPorts);
  if (conflict) {
    throw new Error(
      `域名冲突：${conflict.domain} 已被站点 ${conflict.site} 占用（${conflict.file}），`
      + '同端口下 nginx 只会命中先加载的 server 块，新站点将被遮蔽。请先停用或删除该站点后重试'
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
  });
  await fs.promises.writeFile(filePath, content, 'utf8');
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

  if (wantSsl) {
    if (!primary) {
      warnings.push('未找到可用于签发证书的域名');
      reporter.fail('ssl', '未找到可用于签发证书的域名');
    } else if (reuseCert) {
      // 配置中已引用面板已有证书，无需重新签发
      sslResult = { domain: primary, success: true, reused: true };
      reporter.complete('ssl', '已复用面板已有证书');
    } else {
      // 站点已占用 80 端口，必须使用 nginx 插件签发而非 standalone
      reporter.begin('ssl');
      reporter.note('ssl', `正在为 ${primary} 签发证书`);
      const args = ['--nginx', '-d', primary, '--agree-tos', '-n', '--redirect'];
      if (mail) args.push('-m', mail);
      else args.push('--register-unsafely-without-email');
      const result = await run('certbot', args, { timeout: 180000 });
      sslResult = { domain: primary, success: result.exitCode === 0 };
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
  const key = String(siteName || '').trim();
  if (!SITE_NAME_RE.test(key)) throw new Error('非法站点名称');

  const filePath = path.join(SITE_DIR, `${key}.conf`);
  if (!fs.existsSync(filePath)) throw new Error('站点配置文件不存在');

  const site = (await listSites()).find((item) => item.name === key);
  // 库名与证书名均按创建站点时的规则由首个域名推导，保证与创建时一致
  const primary = pickPrimaryDomain(site?.serverName || '');
  const dbName = primary ? mysqlService.normalizeName(primary) : '';

  return {
    name: key,
    file: filePath,
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
  // 临时改名而非直接删除：校验失败时用于还原站点配置
  const rollbackPath = `${relations.file}.deleted.${Date.now()}`;

  await fs.promises.rename(relations.file, rollbackPath);
  const test = await run('nginx', ['-t']);
  if (test.exitCode !== 0) {
    await fs.promises.rename(rollbackPath, relations.file).catch(() => {});
    throw new Error(`配置校验失败，站点未删除：${(test.stderr || test.stdout || '').trim()}`);
  }
  await run('systemctl', ['reload', servicesConfig.service]);

  // 站点已下线，后续清理失败只记录告警
  let database = null;
  if (removeDb && relations.dbExists) {
    try {
      await mysqlService.dropDatabase({ dbName: relations.dbName, user: relations.dbName });
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

  await fs.promises.unlink(rollbackPath).catch(() => {});

  return {
    name: relations.name,
    file: relations.file,
    serverName: relations.serverName,
    root: relations.root,
    database,
    certificate,
    warnings,
  };
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
  parseServerBlocks,
  createSite,
  PROVISION_STEPS,
  getSiteRelations,
  deleteSite,
  readConfig,
  writeConfig,
  buildSiteConfig,
  buildDefaultPage,
};
