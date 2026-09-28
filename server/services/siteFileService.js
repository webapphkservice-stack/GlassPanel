const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { listSites } = require('./nginxService');
const { run } = require('./commandRunner');

const SITE_NAME_RE = /^[A-Za-z0-9._-]+$/;
// 上传单文件大小上限，与路由上 express.raw 的 limit 保持一致
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024;

// 解压相关限制
const MAX_ARCHIVE_ENTRIES = 100000;
const MAX_EXTRACT_SIZE = 2 * 1024 * 1024 * 1024;
const LIST_TIMEOUT = 60000;
const EXTRACT_TIMEOUT = 300000;
const LIST_MAX_BUFFER = 64 * 1024 * 1024;

// 支持的压缩格式：tar 家族交给系统 tar（可处理 gz/bz2/xz），zip 由本文件解析
const TAR_KINDS = [
  { re: /\.tar\.gz$/i, extractFlag: '-xzf' },
  { re: /\.tgz$/i, extractFlag: '-xzf' },
  { re: /\.tar\.bz2$/i, extractFlag: '-xjf' },
  { re: /\.tbz2?$/i, extractFlag: '-xjf' },
  { re: /\.tar\.xz$/i, extractFlag: '-xJf' },
  { re: /\.txz$/i, extractFlag: '-xJf' },
  { re: /\.tar$/i, extractFlag: '-xf' },
];
const ZIP_RE = /\.zip$/i;
// 去掉压缩包扩展名后的默认解压目录名
const ARCHIVE_SUFFIX_RE = /\.(tar\.(gz|bz2|xz)|tgz|tbz2?|txz|zip|tar)$/i;

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

function joinRel(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

// 识别压缩格式，返回 null 表示不支持
function detectArchiveKind(filename) {
  const name = String(filename || '');
  if (ZIP_RE.test(name)) return { type: 'zip' };
  const tar = TAR_KINDS.find((k) => k.re.test(name));
  return tar ? { type: 'tar', extractFlag: tar.extractFlag } : null;
}

// 压缩包条目名校验：拒绝绝对路径与越级路径，避免解压时写出目标目录
function assertSafeEntryName(name) {
  const cleaned = String(name || '').replace(/\\/g, '/');
  if (!cleaned) return;
  if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) {
    throw clientError(`压缩包包含绝对路径条目，已拒绝解压：${name}`);
  }
  const parts = cleaned.split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.some((p) => p === '..')) {
    throw clientError(`压缩包包含越级路径条目，已拒绝解压：${name}`);
  }
}

// 解压后清理符号链接：tar 允许携带链接条目，链接可能指向站点目录之外
async function stripSymlinks(rootAbs) {
  let removed = 0;
  async function walk(dir) {
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const abs = path.join(dir, dirent.name);
      let stat;
      try {
        stat = await fs.promises.lstat(abs);
      } catch (err) {
        continue;
      }
      if (stat.isSymbolicLink()) {
        await fs.promises.unlink(abs);
        removed += 1;
        continue;
      }
      // 只递归真实目录，链接已在上面被删除，不会跟随出去
      if (stat.isDirectory()) await walk(abs);
    }
  }
  await walk(rootAbs);
  return removed;
}

// zip 文件名解码：仅在 UTF-8 标志位（bit 11）缺失时按 latin1 处理并不可靠，
// 因为 macOS zip / Windows 资源管理器等工具仍会写入 UTF-8 字节。此处优先按 UTF-8 尝试，
// 解码后字节可完整还原才认定为 UTF-8，否则退回 latin1（CP437 兼容纯 ASCII 场景）。
function decodeZipName(buf, flags) {
  if (flags & 0x800) return buf.toString('utf8');
  const utf8 = buf.toString('utf8');
  if (Buffer.from(utf8, 'utf8').equals(buf)) return utf8;
  return buf.toString('latin1');
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
      return {
        name: d.name,
        type,
        size: childStat.size,
        mtime: childStat.mtimeMs,
        // 由服务端判定可解压格式，前端据此显示解压入口
        archive: type === 'file' && Boolean(detectArchiveKind(d.name)),
      };
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

// —— 解压 ——

const ZIP_SIG_EOCD = 0x06054b50;
const ZIP_SIG_EOCD64 = 0x06064b50;
const ZIP_SIG_EOCD64_LOCATOR = 0x07064b50;
const ZIP_SIG_CENTRAL = 0x02014b50;
const ZIP_SIG_LOCAL = 0x04034b50;

// 读取 zip 中央目录，解析出条目清单（含 ZIP64 支持）
async function readZipEntries(zipAbs) {
  const fh = await fs.promises.open(zipAbs, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw clientError('不是有效的 zip 文件（文件过小）');

    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === ZIP_SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw clientError('不是有效的 zip 文件（未找到中央目录结尾标记）');

    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    // 任一字段达到 32 位上限，说明真实值存放在 ZIP64 记录里
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locatorAt = eocd - 20;
      if (locatorAt < 0 || tail.readUInt32LE(locatorAt) !== ZIP_SIG_EOCD64_LOCATOR) {
        throw clientError('不支持的 zip 结构（缺少 ZIP64 定位记录）');
      }
      const eocd64At = Number(tail.readBigUInt64LE(locatorAt + 8));
      const head = Buffer.alloc(56);
      await fh.read(head, 0, 56, eocd64At);
      if (head.readUInt32LE(0) !== ZIP_SIG_EOCD64) {
        throw clientError('不支持的 zip 结构（ZIP64 记录无效）');
      }
      count = Number(head.readBigUInt64LE(32));
      cdSize = Number(head.readBigUInt64LE(40));
      cdOffset = Number(head.readBigUInt64LE(48));
    }

    if (count > MAX_ARCHIVE_ENTRIES) {
      throw clientError(`压缩包内条目过多（${count}），已拒绝解压`);
    }
    if (cdOffset + cdSize > size) throw clientError('zip 中央目录越界，文件可能已损坏');

    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);

    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i += 1) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== ZIP_SIG_CENTRAL) {
        throw clientError('zip 中央目录结构损坏');
      }
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let rawSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const externalAttr = cd.readUInt32LE(p + 38);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = decodeZipName(cd.slice(p + 46, p + 46 + nameLen), flags);
      const extra = cd.slice(p + 46 + nameLen, p + 46 + nameLen + extraLen);

      // ZIP64 扩展字段只包含发生溢出的那几项，需按顺序取用
      if (rawSize === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
        let e = 0;
        while (e + 4 <= extra.length) {
          const id = extra.readUInt16LE(e);
          const len = extra.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            if (rawSize === 0xffffffff && q + 8 <= e + 4 + len) {
              rawSize = Number(extra.readBigUInt64LE(q));
              q += 8;
            }
            if (compSize === 0xffffffff && q + 8 <= e + 4 + len) {
              compSize = Number(extra.readBigUInt64LE(q));
              q += 8;
            }
            if (localOffset === 0xffffffff && q + 8 <= e + 4 + len) {
              localOffset = Number(extra.readBigUInt64LE(q));
              q += 8;
            }
            break;
          }
          e += 4 + len;
        }
      }

      const unixMode = (externalAttr >>> 16) & 0xffff;
      entries.push({
        name,
        method,
        compSize,
        rawSize,
        localOffset,
        isDir: name.endsWith('/'),
        isSymlink: (unixMode & 0xf000) === 0xa000,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, size };
  } finally {
    await fh.close();
  }
}

// zip 解压：逐条目流式解压，不把整个压缩包读进内存
async function extractZip(zipAbs, destAbs) {
  const { entries, size } = await readZipEntries(zipAbs);
  if (entries.length === 0) throw clientError('压缩包为空');

  let total = 0;
  for (const entry of entries) {
    assertSafeEntryName(entry.name);
    if (entry.isSymlink) {
      throw clientError(`压缩包包含符号链接条目，已拒绝解压：${entry.name}`);
    }
    total += entry.rawSize;
    if (total > MAX_EXTRACT_SIZE) {
      throw clientError('解压后体积超过 2GB 上限，已拒绝解压');
    }
  }

  const fh = await fs.promises.open(zipAbs, 'r');
  try {
    for (const entry of entries) {
      const segments = entry.name
        .replace(/\\/g, '/')
        .split('/')
        .filter((s) => s.length > 0 && s !== '.');
      if (segments.length === 0) continue;
      const target = path.join(destAbs, ...segments);
      if (!target.startsWith(destAbs + path.sep)) throw clientError(`非法条目路径：${entry.name}`);

      if (entry.isDir) {
        await fs.promises.mkdir(target, { recursive: true });
        continue;
      }
      if (entry.method !== 0 && entry.method !== 8) {
        throw clientError(`不支持的压缩算法（method=${entry.method}）：${entry.name}`);
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });

      if (entry.compSize === 0) {
        await fs.promises.writeFile(target, Buffer.alloc(0));
        continue;
      }

      // 本地头中的名称/扩展字段长度可能与中央目录不同，需重新定位数据起点
      const header = Buffer.alloc(30);
      await fh.read(header, 0, 30, entry.localOffset);
      if (header.readUInt32LE(0) !== ZIP_SIG_LOCAL) throw clientError(`zip 本地头损坏：${entry.name}`);
      const dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      if (dataStart + entry.compSize > size) throw clientError(`zip 数据越界，文件可能已损坏：${entry.name}`);

      const source = fs.createReadStream(zipAbs, { start: dataStart, end: dataStart + entry.compSize - 1 });
      try {
        if (entry.method === 8) {
          await pipeline(source, zlib.createInflateRaw(), fs.createWriteStream(target));
        } else {
          await pipeline(source, fs.createWriteStream(target));
        }
      } catch (err) {
        throw clientError(`写入文件失败：${entry.name}（${err.message}）`);
      }
    }
  } finally {
    await fh.close();
  }
  return { entries: entries.length, removedLinks: 0 };
}

// tar 解压：交由系统 tar，解压前先列出条目做路径校验
async function extractTar(archiveAbs, destAbs, extractFlag) {
  const listFlag = extractFlag.replace('x', 't');
  const listed = await run('tar', [listFlag, archiveAbs], {
    timeout: LIST_TIMEOUT,
    maxBuffer: LIST_MAX_BUFFER,
  });
  if (listed.exitCode !== 0 || listed.error) {
    throw clientError(`读取压缩包失败：${(listed.stderr || listed.error || '').trim() || '未知错误'}`);
  }
  const names = String(listed.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) throw clientError('压缩包为空');
  if (names.length > MAX_ARCHIVE_ENTRIES) {
    throw clientError(`压缩包内条目过多（${names.length}），已拒绝解压`);
  }
  names.forEach((name) => assertSafeEntryName(name));

  const extracted = await run(
    'tar',
    [extractFlag, archiveAbs, '-C', destAbs, '--no-same-owner', '--no-same-permissions'],
    { timeout: EXTRACT_TIMEOUT }
  );
  if (extracted.exitCode !== 0 || extracted.error) {
    throw clientError(`解压失败：${(extracted.stderr || extracted.error || '').trim() || '未知错误'}`);
  }
  const removedLinks = await stripSymlinks(destAbs);
  return { entries: names.length, removedLinks };
}

// 解压站点内的压缩包；destRel 省略时默认解压到压缩包同目录下的同名文件夹
async function extractArchive(siteName, archiveRel, destRel) {
  const { rootReal } = await getSiteRoot(siteName);
  if (!String(archiveRel || '').trim()) throw clientError('缺少 path 参数');
  const archiveAbs = await resolveWithin(rootReal, archiveRel);
  let archiveStat;
  try {
    archiveStat = await fs.promises.lstat(archiveAbs);
  } catch (err) {
    if (err.code === 'ENOENT') throw clientError('压缩包不存在', 404);
    throw err;
  }
  if (archiveStat.isSymbolicLink()) throw clientError('不支持解压符号链接');
  if (!archiveStat.isFile()) throw clientError('目标不是文件');

  const filename = path.basename(archiveAbs);
  const kind = detectArchiveKind(filename);
  if (!kind) throw clientError('不支持的压缩格式（支持 .zip 与 .tar / .tar.gz / .tar.bz2 / .tar.xz）');

  const archiveDirRel = toRelative(rootReal, path.dirname(archiveAbs));
  const defaultDest = joinRel(archiveDirRel, filename.replace(ARCHIVE_SUFFIX_RE, '') || 'extracted');
  const destAbs = await resolveWithin(rootReal, String(destRel || '').trim() || defaultDest);

  // 目标目录必须不存在或为空，避免覆盖站点已有文件
  let exists = false;
  try {
    const destStat = await fs.promises.lstat(destAbs);
    if (!destStat.isDirectory()) throw clientError('目标路径已存在且不是目录', 409);
    const remain = await fs.promises.readdir(destAbs);
    if (remain.length > 0) {
      const shown = toRelative(rootReal, destAbs) || '/';
      throw clientError(`目标目录 ${shown} 已存在且不为空，请先清空或更换目录`, 409);
    }
    exists = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (!exists) await fs.promises.mkdir(destAbs, { recursive: true });

  let result;
  try {
    result = kind.type === 'zip'
      ? await extractZip(archiveAbs, destAbs)
      : await extractTar(archiveAbs, destAbs, kind.extractFlag);
  } catch (err) {
    // 解压失败时清掉本次新建的目录，不留下半成品
    if (!exists) await fs.promises.rm(destAbs, { recursive: true, force: true });
    throw err;
  }

  return {
    path: toRelative(rootReal, destAbs),
    archive: toRelative(rootReal, archiveAbs),
    entries: result.entries,
    removedLinks: result.removedLinks,
  };
}

module.exports = {
  getSiteRoot,
  listDirectory,
  createDirectory,
  saveUpload,
  resolveForDownload,
  removeEntry,
  extractArchive,
  MAX_UPLOAD_SIZE,
};
