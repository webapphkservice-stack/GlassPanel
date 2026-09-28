const fs = require('fs');
const path = require('path');
const { listSites } = require('./nginxService');

const SITE_NAME_RE = /^[A-Za-z0-9._-]+$/;
// 上传单文件大小上限，与路由上 express.raw 的 limit 保持一致
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024;

// 业务校验类错误统一带上 4xx 状态码，避免 errorHandler 兜底成 500
function clientError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// 站点名 -> 网站根目录（realpath），文件操作全部以该目录为界
async function getSiteRoot(siteName) {
  const key = String(siteName || '').trim();
  if (!SITE_NAME_RE.test(key)) throw clientError('非法站点名称');
  const site = (await listSites()).find((item) => item.name === key);
  if (!site) throw clientError('站点不存在', 404);
  if (!site.root) throw clientError('该站点未配置 root（可能为纯反向代理站点），无法管理文件');
  let rootReal;
  try {
    rootReal = await fs.promises.realpath(site.root);
  } catch (err) {
    if (err.code === 'ENOENT') throw clientError(`站点根目录不存在：${site.root}`, 404);
    throw err;
  }
  return { name: key, root: site.root, rootReal };
}

// 相对路径规范化：拒绝绝对路径、.. 与空段
function normalizeSegments(rel) {
  const cleaned = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = cleaned.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.some((s) => s === '..')) throw clientError('非法路径');
  return segments;
}

// 将相对路径解析到站点根目录内；逐级 lstat 阻断符号链接逃逸
async function resolveWithin(rootReal, rel) {
  const segments = normalizeSegments(rel);
  let current = rootReal;
  for (const seg of segments) {
    current = path.join(current, seg);
  }
  if (segments.length > 0 && !current.startsWith(rootReal + path.sep)) {
    throw clientError('非法路径');
  }
  let cursor = rootReal;
  for (const seg of segments) {
    cursor = path.join(cursor, seg);
    let stat;
    try {
      stat = await fs.promises.lstat(cursor);
    } catch (err) {
      // 中途不存在则后续必然创建失败，交给具体操作报错
      if (err.code === 'ENOENT') break;
      throw err;
    }
    if (stat.isSymbolicLink()) throw clientError('禁止通过符号链接访问站点目录以外的文件');
  }
  return current;
}

function toRelative(rootReal, absPath) {
  if (absPath === rootReal) return '';
  return path.relative(rootReal, absPath).split(path.sep).join('/');
}

async function listDirectory(siteName, dir) {
  const { root, rootReal } = await getSiteRoot(siteName);
  const abs = await resolveWithin(rootReal, dir);
  let stat;
  try {
    stat = await fs.promises.stat(abs);
  } catch (err) {
    if (err.code === 'ENOENT') throw clientError('目录不存在', 404);
    throw err;
  }
  if (!stat.isDirectory()) throw clientError('目标不是目录');

  const dirents = await fs.promises.readdir(abs, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (d) => {
      const childAbs = path.join(abs, d.name);
      let childStat;
      try {
        childStat = await fs.promises.lstat(childAbs);
      } catch (err) {
        return null;
      }
      const type = childStat.isSymbolicLink() ? 'link' : childStat.isDirectory() ? 'dir' : 'file';
      return { name: d.name, type, size: childStat.size, mtime: childStat.mtimeMs };
    })
  );
  const list = entries
    .filter(Boolean)
    .sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      if (a.type === 'dir') return -1;
      if (b.type === 'dir') return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

  return { root, path: toRelative(rootReal, abs), entries: list };
}

async function createDirectory(siteName, relPath) {
  const { rootReal } = await getSiteRoot(siteName);
  const abs = await resolveWithin(rootReal, relPath);
  if (abs === rootReal) throw clientError('目录名称不能为空');
  try {
    await fs.promises.mkdir(abs);
  } catch (err) {
    if (err.code === 'EEXIST') throw clientError('同名目录已存在', 409);
    if (err.code === 'ENOENT') throw clientError('上级目录不存在', 404);
    throw err;
  }
  return { path: toRelative(rootReal, abs) };
}

// 上传：文件名来自 query 参数，做严格清洗后写入 dir/文件名
// overwrite=false 时同名文件已存在会报错，由前端确认后重传
async function saveUpload(siteName, dir, filename, buffer, overwrite = true) {
  const { rootReal } = await getSiteRoot(siteName);
  const safe = String(filename || '')
    .replace(/[\\/\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+$/, '')
    .trim();
  if (!safe) throw new Error('文件名无效');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('上传内容为空');
  if (buffer.length > MAX_UPLOAD_SIZE) throw new Error(`文件超过 ${Math.floor(MAX_UPLOAD_SIZE / 1024 / 1024)}MB 上限`);
  const dirAbs = await resolveWithin(rootReal, dir);
  const abs = await resolveWithin(rootReal, toRelative(rootReal, path.join(dirAbs, safe)));
  try {
    await fs.promises.writeFile(abs, buffer, overwrite ? undefined : { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error(`同名文件已存在：${safe}`);
    throw err;
  }
  return { path: toRelative(rootReal, abs), name: safe, size: buffer.length };
}

async function resolveForDownload(siteName, relPath) {
  const { rootReal } = await getSiteRoot(siteName);
  if (!String(relPath || '').trim()) throw new Error('缺少 path 参数');
  const abs = await resolveWithin(rootReal, relPath);
  let stat;
  try {
    stat = await fs.promises.lstat(abs);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('文件不存在');
    throw err;
  }
  if (stat.isSymbolicLink()) throw new Error('不支持下载符号链接');
  if (!stat.isFile()) throw new Error('目标不是文件');
  return { absPath: abs, filename: path.basename(abs), size: stat.size };
}

async function removeEntry(siteName, relPath) {
  const { rootReal } = await getSiteRoot(siteName);
  if (!String(relPath || '').trim()) throw new Error('缺少 path 参数');
  const abs = await resolveWithin(rootReal, relPath);
  if (abs === rootReal) throw new Error('不能删除站点根目录');
  let stat;
  try {
    stat = await fs.promises.lstat(abs);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('目标不存在');
    throw err;
  }
  if (stat.isDirectory()) {
    await fs.promises.rm(abs, { recursive: true, force: true });
  } else {
    await fs.promises.unlink(abs);
  }
  return { path: toRelative(rootReal, abs), type: stat.isDirectory() ? 'dir' : 'file' };
}

module.exports = {
  getSiteRoot,
  listDirectory,
  createDirectory,
  saveUpload,
  resolveForDownload,
  removeEntry,
  MAX_UPLOAD_SIZE,
};
