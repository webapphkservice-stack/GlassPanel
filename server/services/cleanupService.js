const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { run } = require('./commandRunner');
const { INSTALL_MARKERS } = require('./appService');

// 系统清理：四项互不重叠的清理范围，全部为「保守清理」策略 ——
// 只删除确定无用且可再生（缓存/轮转日志/构建目录/垃圾文件）的内容，
// 活跃日志、正在使用的文件、最近 RETAIN_DAYS 天内的日志与临时文件一律不动。
const CATEGORIES = ['junk', 'residue', 'syslog', 'temp'];
const RETAIN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// 单个根目录的遍历上限，避免超大目录把扫描拖死
const WALK_LIMIT = 60000;
// 前端预览用的样例条数
const SAMPLE_LIMIT = 6;

// —— 垃圾文件：网站目录里的系统/编辑器垃圾 ——
const JUNK_ROOTS = ['/var/www'];
const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const JUNK_PATTERNS = [/~$/, /\.swp$/, /\.swo$/, /^#.+#$/];

// —— 应用残留：编译工作目录（产物已装到 /usr/local，工作目录只剩源码与 tarball） ——
const BUILD_DIRS = [
  '/opt/phpbuild',
  '/opt/redisbuild',
  '/opt/ffmpegbuild',
  '/opt/fail2banbuild',
];
// 版本标记 → 已安装产物路径：产物不存在说明该标记已失效
const MARKER_TARGETS = {
  php: (v) => `/usr/local/php/${v}`,
  redis: (v) => `/usr/local/redis/${v}`,
  supervisor: () => '/usr/bin/supervisorctl',
  ffmpeg: (v) => `/usr/local/ffmpeg/${v}`,
  fail2ban: () => '/usr/local/bin/fail2ban-client',
  '3x-ui': () => '/usr/local/x-ui',
};
// 面板创建过的软链接：仅当链接失效（指向已不存在的目标）时清理
const MANAGED_LINKS = {
  '/usr/bin': ['redis-cli', 'redis-server', 'redis-sentinel', 'supervisord', 'supervisorctl'],
  '/usr/local/bin': ['ffmpeg', 'ffprobe', 'fail2ban-client', 'fail2ban-server', 'fail2ban-regex'],
};
const SYSTEMD_DIR = '/etc/systemd/system';

// —— 系统日志：journal 收缩 + 轮转归档（当前正在写入的日志不匹配归档后缀） ——
const LOG_ROOTS = ['/var/log'];
const LOG_SKIP_DIRS = new Set(['/var/log/journal']);
const LOG_ARCHIVE_PATTERNS = [
  /\.\d+$/,
  /\.\d+\.gz$/,
  /\.gz$/,
  /\.bz2$/,
  /\.xz$/,
  /\.old$/,
  /-\d{8}$/,
  /-\d{8}\.gz$/,
];
// journal 保留窗口，与轮转日志一致
const JOURNAL_VACUUM = `--vacuum-time=${RETAIN_DAYS}d`;

// —— 临时文件：/tmp、/var/tmp 陈旧条目 + 可再生缓存 ——
const TMP_ROOTS = ['/tmp', '/var/tmp'];
const TMP_EXCLUDE = [/^\.X11-unix$/, /^\.ICE-unix$/, /^\.font-unix$/, /^\.XIM-unix$/, /^systemd-private-/];
const CACHE_DIRS = ['/root/.npm/_cacache', '/root/.cache/pip'];
// 包管理器缓存用官方命令清理，避免手删目录破坏元数据
const PKG_CACHE_DIRS = ['/var/cache/dnf', '/var/cache/yum'];

function isOld(mtimeMs) {
  return Date.now() - mtimeMs > RETAIN_DAYS * DAY_MS;
}

// 递归统计目录体积与文件数，不跟随符号链接
function dirSize(target) {
  let bytes = 0;
  let count = 0;
  const stack = [target];
  let visited = 0;
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      if (visited++ > WALK_LIMIT) return { bytes, count };
      const full = path.join(cur, entry.name);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch (err) {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) stack.push(full);
      else {
        bytes += stat.size;
        count += 1;
      }
    }
  }
  return { bytes, count };
}

// 确认待删路径位于本项允许的根目录内，避免任何越界删除
function withinRoots(target, roots) {
  const resolved = path.resolve(target);
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

// 遍历目录树，回调每个条目（含根之外的子项），不跟随符号链接
function walk(root, onEntry, { skipDirs = new Set() } = {}) {
  let visited = 0;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      if (visited++ > WALK_LIMIT) return;
      const full = path.join(cur, entry.name);
      if (skipDirs.has(full)) continue;
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch (err) {
        continue;
      }
      if (stat.isSymbolicLink()) {
        onEntry(full, stat, entry);
        continue;
      }
      if (stat.isDirectory()) stack.push(full);
      onEntry(full, stat, entry);
    }
  }
}

// —— 各项候选收集：扫描与执行复用同一套判定，保证「看到什么就删什么」 ——

function junkCandidates() {
  const files = [];
  for (const root of JUNK_ROOTS) {
    if (!fs.existsSync(root)) continue;
    walk(root, (full, stat, entry) => {
      if (!stat.isFile()) return;
      const hit = JUNK_NAMES.has(entry.name) || JUNK_PATTERNS.some((re) => re.test(entry.name));
      if (hit) files.push({ path: full, bytes: stat.size });
    });
  }
  return { files, dirs: [], roots: JUNK_ROOTS };
}

// 残留中的编译工作目录：整目录删除（体积与条目数按递归统计）
function residueBuildDirs() {
  const dirs = [];
  for (const root of BUILD_DIRS) {
    if (!fs.existsSync(root)) continue;
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(root, entry.name);
      const { bytes, count } = entry.isDirectory() ? dirSize(full) : { bytes: 0, count: 0 };
      dirs.push({ path: full, bytes, count, recursive: entry.isDirectory() });
    }
  }
  return dirs;
}

// 失效版本标记：标记里记录的版本目录已不存在
function residueDeadMarkers() {
  const files = [];
  for (const [key, markerPath] of Object.entries(INSTALL_MARKERS)) {
    const toTarget = MARKER_TARGETS[key];
    if (!toTarget || !fs.existsSync(markerPath)) continue;
    let version = '';
    try {
      version = fs.readFileSync(markerPath, 'utf8').trim();
    } catch (err) {
      continue;
    }
    const target = toTarget(version);
    if (target && fs.existsSync(target)) continue;
    let bytes = 0;
    try {
      bytes = fs.statSync(markerPath).size;
    } catch (err) {
      bytes = 0;
    }
    files.push({ path: markerPath, bytes, count: 1 });
  }
  return files;
}

// 失效软链接：只检查面板自己创建过的那几个名字
function residueDeadLinks() {
  const files = [];
  for (const [dir, names] of Object.entries(MANAGED_LINKS)) {
    for (const name of names) {
      const full = path.join(dir, name);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch (err) {
        continue;
      }
      if (!stat.isSymbolicLink()) continue;
      if (fs.existsSync(full)) continue; // 目标仍在，链接有效
      files.push({ path: full, bytes: 0, count: 1 });
    }
  }
  return files;
}

// 失效 systemd 单元：ExecStart 指向的可执行文件已不存在
function residueDeadUnits() {
  const files = [];
  let entries;
  try {
    entries = fs.readdirSync(SYSTEMD_DIR, { withFileTypes: true });
  } catch (err) {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.service')) continue;
    const full = path.join(SYSTEMD_DIR, entry.name);
    let content = '';
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch (err) {
      continue;
    }
    const exec = content.match(/^ExecStart=\s*(?:\S+=\S+\s+)*(\/\S+)/m);
    if (!exec) continue;
    if (fs.existsSync(exec[1])) continue;
    let bytes = 0;
    try {
      bytes = fs.statSync(full).size;
    } catch (err) {
      bytes = 0;
    }
    files.push({ path: full, bytes, count: 1 });
  }
  return files;
}

function residueCandidates() {
  return { files: [...residueDeadMarkers(), ...residueDeadLinks(), ...residueDeadUnits()], dirs: residueBuildDirs(), roots: [...BUILD_DIRS, SYSTEMD_DIR, ...Object.keys(MANAGED_LINKS), path.dirname(INSTALL_MARKERS.php)] };
}

function isRotatedLog(name) {
  return LOG_ARCHIVE_PATTERNS.some((re) => re.test(name));
}

function syslogCandidates() {
  const files = [];
  for (const root of LOG_ROOTS) {
    if (!fs.existsSync(root)) continue;
    walk(root, (full, stat, entry) => {
      if (!stat.isFile()) return;
      if (!isRotatedLog(entry.name)) return;
      // 只清理超过保留窗口的归档；活跃日志没有归档后缀，不会被命中
      if (!isOld(stat.mtimeMs)) return;
      files.push({ path: full, bytes: stat.size });
    }, { skipDirs: LOG_SKIP_DIRS });
  }
  return { files, dirs: [], roots: LOG_ROOTS };
}

function tempCandidates() {
  const files = [];
  const dirs = [];
  for (const root of TMP_ROOTS) {
    if (!fs.existsSync(root)) continue;
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      if (TMP_EXCLUDE.some((re) => re.test(entry.name))) continue;
      const full = path.join(root, entry.name);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch (err) {
        continue;
      }
      if (stat.isSymbolicLink() || !isOld(stat.mtimeMs)) continue;
      // 只处理常规文件与目录：socket / 管道 / 设备节点属于运行中服务的资源，一律不动
      if (!stat.isFile() && !stat.isDirectory()) continue;
      if (stat.isDirectory()) {
        const { bytes, count } = dirSize(full);
        dirs.push({ path: full, bytes, count, recursive: true });
      } else {
        files.push({ path: full, bytes: stat.size });
      }
    }
  }
  for (const dir of CACHE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const { bytes, count } = dirSize(dir);
    dirs.push({ path: dir, bytes, count, recursive: true, cache: true });
  }
  for (const dir of PKG_CACHE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const { bytes, count } = dirSize(dir);
    dirs.push({ path: dir, bytes, count, recursive: true, cache: true, pkgCache: true });
  }
  return { files, dirs, roots: [...TMP_ROOTS, ...CACHE_DIRS, ...PKG_CACHE_DIRS] };
}

const COLLECTORS = {
  junk: junkCandidates,
  residue: residueCandidates,
  syslog: syslogCandidates,
  temp: tempCandidates,
};

// journal 体积：journalctl --disk-usage 输出的可读体积
function parseSize(text) {
  const m = String(text || '').match(/([\d.]+)\s*([KMGT]?)B?/i);
  if (!m) return 0;
  const unit = (m[2] || '').toUpperCase();
  const scale = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return Math.round(parseFloat(m[1]) * (scale[unit] || 1));
}

async function journalBytes() {
  const res = await run('journalctl', ['--disk-usage'], { timeout: 15000 });
  if (res.exitCode !== 0) return 0;
  return parseSize(res.stdout);
}

function summarize(key, candidates) {
  const files = candidates.files || [];
  const dirs = candidates.dirs || [];
  const bytes = files.reduce((sum, f) => sum + (f.bytes || 0), 0) + dirs.reduce((sum, d) => sum + (d.bytes || 0), 0);
  const count = files.reduce((sum, f) => sum + (f.count || 1), 0) + dirs.reduce((sum, d) => sum + (d.count || 1), 0);
  return {
    key,
    bytes,
    count,
    samples: [...dirs, ...files]
      .sort((a, b) => (b.bytes || 0) - (a.bytes || 0))
      .slice(0, SAMPLE_LIMIT)
      .map((item) => ({ path: item.path, bytes: item.bytes || 0 })),
  };
}

// 扫描四项可清理的体积与条目数（只读，不产生任何删除）
async function scan() {
  const items = [];
  for (const key of CATEGORIES) {
    const candidates = COLLECTORS[key]();
    const summary = summarize(key, candidates);
    // 系统日志额外统计 journal 体积，执行时用官方 vacuum 收缩
    if (key === 'syslog') {
      const bytes = await journalBytes();
      if (bytes > 0) {
        summary.bytes += bytes;
        summary.journalBytes = bytes;
        summary.samples.unshift({ path: 'journal (journalctl --vacuum-time=7d)', bytes });
      }
    }
    items.push(summary);
  }
  return { items, retainDays: RETAIN_DAYS };
}

async function removeFiles(files, roots, result) {
  for (const item of files) {
    if (!withinRoots(item.path, roots)) continue;
    try {
      await fsp.rm(item.path, { recursive: true, force: true });
      result.bytes += item.bytes || 0;
      result.count += item.count || 1;
    } catch (err) {
      result.failed.push({ path: item.path, error: err.message });
    }
  }
}

// 执行清理：只处理请求中列出的项，逐项统计实际释放量
async function clean(keys) {
  const wanted = (Array.isArray(keys) ? keys : []).filter((key) => CATEGORIES.includes(key));
  if (!wanted.length) {
    const err = new Error('请选择要清理的项目');
    err.status = 400;
    throw err;
  }

  const results = [];
  for (const key of wanted) {
    const result = { key, bytes: 0, count: 0, failed: [] };
    const candidates = COLLECTORS[key]();
    await removeFiles(candidates.files || [], candidates.roots || [], result);
    for (const dir of candidates.dirs || []) {
      if (!withinRoots(dir.path, candidates.roots || [])) continue;
      // 包管理器缓存交给官方命令重建索引，手删目录会让 dnf 元数据不一致
      if (dir.pkgCache) {
        const res = await run('dnf', ['clean', 'all'], { timeout: 120000 });
        if (res.exitCode === 0) {
          result.bytes += dir.bytes || 0;
          result.count += dir.count || 0;
        } else {
          result.failed.push({ path: dir.path, error: (res.stderr || res.stdout || '').trim() });
        }
        continue;
      }
      try {
        await fsp.rm(dir.path, { recursive: dir.recursive !== false, force: true });
        result.bytes += dir.bytes || 0;
        result.count += dir.count || 1;
      } catch (err) {
        result.failed.push({ path: dir.path, error: err.message });
      }
    }

    if (key === 'syslog') {
      const before = await journalBytes();
      const res = await run('journalctl', [JOURNAL_VACUUM], { timeout: 60000 });
      if (res.exitCode === 0) {
        const after = await journalBytes();
        result.bytes += Math.max(0, before - after);
      } else {
        result.failed.push({ path: 'journal', error: (res.stderr || res.stdout || '').trim() });
      }
    }
    if (key === 'residue') {
      // 删掉失效单元后刷新 systemd，避免残留引用
      await run('systemctl', ['daemon-reload'], { timeout: 30000 });
    }
    results.push(result);
  }

  return {
    results,
    totalBytes: results.reduce((sum, r) => sum + r.bytes, 0),
    totalCount: results.reduce((sum, r) => sum + r.count, 0),
  };
}

module.exports = { CATEGORIES, RETAIN_DAYS, scan, clean };