const fs = require('fs');
const path = require('path');
const { run } = require('./commandRunner');
const { listSites } = require('./nginxService');

// 备份文件统一落在面板数据目录下（data/ 已被 .gitignore 排除）
const BACKUP_ROOT = path.join(__dirname, '../../data/site-backups');
const NGINX_CONF_DIR = '/etc/nginx';
const SITE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const STAMP_RE = /^\d{8}-\d{6}\.tar\.gz$/;
// 网站目录打包/解包耗时随体积增长，放宽超时
const TAR_TIMEOUT = 600000;

function clientError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function assertSiteName(siteName) {
  const key = String(siteName || '').trim();
  if (!SITE_NAME_RE.test(key)) throw clientError('非法站点名称');
  return key;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function findSite(siteName) {
  const key = assertSiteName(siteName);
  const site = (await listSites()).find((item) => item.name === key);
  if (!site) throw clientError('站点不存在', 404);
  return site;
}

// 备份文件名固定为 <站点名>-<时间戳>.tar.gz，且解析后必须仍位于备份目录内
function resolveBackupPath(siteName, fileName) {
  const key = assertSiteName(siteName);
  const name = String(fileName || '').trim();
  if (!name || name.includes('/') || name.includes('\\') || !name.startsWith(`${key}-`)) {
    throw clientError('非法备份文件名');
  }
  if (!STAMP_RE.test(name.slice(key.length + 1))) throw clientError('非法备份文件名');
  const abs = path.resolve(path.join(BACKUP_ROOT, name));
  if (!abs.startsWith(path.resolve(BACKUP_ROOT) + path.sep)) throw clientError('非法备份路径');
  return { name, abs };
}

// 清单文件记录备份来源路径，恢复时据此校验包内条目，避免解压到预期之外的位置
async function readManifest(abs, siteName) {
  const raw = await fs.promises.readFile(`${abs}.json`, 'utf8').catch(() => '');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.site === siteName) {
      return {
        root: String(parsed.root || ''),
        configFile: String(parsed.configFile || ''),
      };
    }
  } catch (err) {
    // 清单损坏时按无清单处理，走保守的默认白名单
  }
  return null;
}

async function createBackup(siteName) {
  const site = await findSite(siteName);
  const targets = [];

  if (site.root) {
    const absRoot = path.resolve(site.root);
    const stat = await fs.promises.stat(absRoot).catch(() => null);
    if (!stat || !stat.isDirectory()) throw clientError(`网站根目录不存在：${site.root}`, 404);
    // 拒绝打包层级过浅的目录（如 /、/etc），避免把整机内容卷进备份
    if (absRoot.split(path.sep).filter(Boolean).length < 2) {
      throw clientError(`网站根目录层级过浅，拒绝打包：${absRoot}`);
    }
    const backupRoot = path.resolve(BACKUP_ROOT);
    if (backupRoot === absRoot || backupRoot.startsWith(absRoot + path.sep)) {
      throw clientError('备份目录位于网站根目录内，会造成备份套娃，请调整网站根目录');
    }
    targets.push(absRoot);
  }

  const absConfig = path.resolve(site.file);
  if (!absConfig.startsWith(path.resolve(NGINX_CONF_DIR) + path.sep)) {
    throw clientError('站点配置文件不在 Nginx 配置目录内，拒绝备份');
  }
  targets.push(absConfig);

  await fs.promises.mkdir(BACKUP_ROOT, { recursive: true });
  const name = `${site.name}-${stamp()}.tar.gz`;
  const dest = path.join(BACKUP_ROOT, name);
  // -C / 配合去掉前导斜杠：包内保存相对根目录的路径，恢复时可直接解压回原位置
  const result = await run(
    'tar',
    ['-czf', dest, '-C', '/', ...targets.map((p) => p.replace(/^\/+/, ''))],
    { timeout: TAR_TIMEOUT }
  );

  const stat = await fs.promises.stat(dest).catch(() => null);
  if (!stat || stat.size === 0) {
    await fs.promises.unlink(dest).catch(() => {});
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 300);
    throw clientError(`备份失败：${detail || `tar 退出码 ${result.exitCode}`}`, 500);
  }

  const manifest = {
    site: site.name,
    root: site.root || '',
    configFile: absConfig,
    createdAt: new Date().toISOString(),
  };
  await fs.promises.writeFile(`${dest}.json`, JSON.stringify(manifest, null, 2), 'utf8');

  return {
    file: name,
    size: stat.size,
    createdAt: manifest.createdAt,
    root: manifest.root,
    configFile: absConfig,
    // tar 退出码 1 表示「文件在读取过程中被修改」，包本身可用，仅提示
    warning: result.exitCode === 1
      ? '打包期间有文件发生变化，备份已生成，但可能缺少该文件的最新内容'
      : '',
  };
}

async function listBackups(siteName) {
  const key = assertSiteName(siteName);
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
      hasManifest: fs.existsSync(path.join(BACKUP_ROOT, `${name}.json`)),
    });
  }
  items.sort((a, b) => b.file.localeCompare(a.file));
  return { items, dir: BACKUP_ROOT };
}

async function deleteBackup(siteName, fileName) {
  const { name, abs } = resolveBackupPath(siteName, fileName);
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat) throw clientError('备份文件不存在', 404);
  await fs.promises.unlink(abs);
  await fs.promises.unlink(`${abs}.json`).catch(() => {});
  return { file: name };
}

async function resolveForDownload(siteName, fileName) {
  const { name, abs } = resolveBackupPath(siteName, fileName);
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat) throw clientError('备份文件不存在', 404);
  return { absPath: abs, filename: name };
}

// 恢复备份：先校验包内条目（防路径穿越 / 写到预期之外），解压后再做 nginx 配置校验，
// 校验失败时还原解压前的站点配置，避免站点起不来
async function restoreBackup(siteName, fileName) {
  const key = assertSiteName(siteName);
  const { name, abs } = resolveBackupPath(key, fileName);
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat) throw clientError('备份文件不存在', 404);

  const manifest = await readManifest(abs, key);
  const allowed = manifest
    ? [manifest.root, manifest.configFile].filter(Boolean).map((p) => path.resolve(p))
    : [path.resolve('/var/www'), path.resolve(NGINX_CONF_DIR, 'conf.d')];
  if (!allowed.length) throw clientError('备份清单缺少恢复路径，无法安全恢复');

  const listed = await run('tar', ['-tzf', abs], { timeout: 120000 });
  if (listed.exitCode !== 0) {
    throw clientError('备份包无法读取，可能已损坏', 400);
  }
  const entries = listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!entries.length) throw clientError('备份包为空', 400);
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.split('/').includes('..')) {
      throw clientError(`备份包含不安全路径：${entry}`);
    }
    const absEntry = path.resolve('/', entry);
    if (!allowed.some((base) => absEntry === base || absEntry.startsWith(base + path.sep))) {
      throw clientError(`备份包含预期之外的路径：${entry}`);
    }
  }

  const configPath = manifest ? manifest.configFile : '';
  const prevConfig = configPath && fs.existsSync(configPath)
    ? await fs.promises.readFile(configPath, 'utf8')
    : null;

  const extract = await run('tar', ['-xzf', abs, '-C', '/'], { timeout: TAR_TIMEOUT });
  if (extract.exitCode !== 0) {
    const detail = (extract.stderr || extract.stdout || '').trim().slice(0, 300);
    throw clientError(`恢复失败：${detail || `tar 退出码 ${extract.exitCode}`}`, 500);
  }

  const test = await run('nginx', ['-t']);
  if (test.exitCode !== 0) {
    if (configPath && prevConfig !== null) {
      await fs.promises.writeFile(configPath, prevConfig, 'utf8');
    }
    const detail = (test.stderr || test.stdout || '').trim().slice(0, 300);
    throw clientError(`恢复后 Nginx 配置校验失败，已还原恢复前的站点配置：${detail}`, 400);
  }

  const reload = await run('systemctl', ['reload', 'nginx']);
  return {
    file: name,
    entries: entries.length,
    root: manifest ? manifest.root : '',
    configFile: configPath,
    reloaded: reload.exitCode === 0,
  };
}

module.exports = {
  createBackup,
  listBackups,
  deleteBackup,
  restoreBackup,
  resolveForDownload,
  BACKUP_ROOT,
};