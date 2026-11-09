const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { run } = require('./commandRunner');

const execFileAsync = promisify(execFile);

// 面板托管的 Node.js 运行时目录（由应用中心安装，不影响系统 /usr/local/bin/node）
const ROOT = '/usr/local/nodejs';
const MARKER = '/opt/glass-panel/data/nodejs-version';
const VERSION_RE = /^v(\d+\.\d+\.\d+)$/;

function readMarker() {
  try {
    return fs.readFileSync(MARKER, 'utf8').trim();
  } catch (e) {
    return '';
  }
}

function readCurrent() {
  try {
    return path.basename(fs.readlinkSync(path.join(ROOT, 'current'))).replace(/^v/, '');
  } catch (e) {
    return '';
  }
}

// 执行某个版本自带的 node/npm：npm 的 shebang 依赖 PATH 中的 node，需把该版本目录前置
async function probe(bin, args, dir) {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: 10000,
      env: dir ? { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` } : process.env,
    });
    return String(stdout || '').trim();
  } catch (e) {
    return '';
  }
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// 校验版本号并返回其安装目录，拒绝路径穿越与软链
function resolveVersionDir(version) {
  const m = /^(\d+\.\d+\.\d+)$/.exec(String(version || ''));
  if (!m) throw new Error('版本号格式不正确');
  const dir = path.join(ROOT, `v${m[1]}`);
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch (e) {
    throw new Error(`Node.js ${m[1]} 未安装`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Node.js ${m[1]} 安装目录异常`);
  return { version: m[1], dir };
}

async function listVersions() {
  let entries = [];
  try {
    entries = fs.readdirSync(ROOT, { withFileTypes: true });
  } catch (e) {
    entries = [];
  }
  const current = readCurrent();
  const versions = [];
  for (const entry of entries) {
    const m = VERSION_RE.exec(entry.name);
    if (!m || !entry.isDirectory()) continue;
    const version = m[1];
    const dir = path.join(ROOT, entry.name);
    const [nodeVersion, npmVersion, sizeResult, stat] = await Promise.all([
      probe(path.join(dir, 'bin', 'node'), ['-v'], dir),
      probe(path.join(dir, 'bin', 'npm'), ['-v'], dir),
      run('du', ['-sh', dir], { timeout: 60000 }),
      Promise.resolve(fs.statSync(dir)),
    ]);
    versions.push({
      version,
      dir,
      path: path.join(dir, 'bin', 'node'),
      node: nodeVersion.replace(/^v/, ''),
      npm: npmVersion,
      size: (sizeResult.stdout || '').trim().split(/\s+/)[0] || '',
      installedAt: stat.mtime.toISOString(),
      current: version === current,
    });
  }
  versions.sort((a, b) => compareVersions(b.version, a.version));
  // 系统 node 与托管运行时互不影响，返回展示用信息
  const [systemNode, systemNpm] = await Promise.all([
    probe('/usr/local/bin/node', ['-v']),
    probe('/usr/local/bin/npm', ['-v']),
  ]);
  return {
    root: ROOT,
    current,
    marker: readMarker(),
    stablePath: path.join(ROOT, 'current', 'bin', 'node'),
    versions,
    systemNode: systemNode.replace(/^v/, ''),
    systemNpm,
  };
}

async function setCurrent(version) {
  const { version: ver, dir } = resolveVersionDir(version);
  const link = path.join(ROOT, 'current');
  const tmp = path.join(ROOT, '.current.tmp');
  try {
    fs.unlinkSync(tmp);
  } catch (e) {
    // 无残留临时链接时忽略
  }
  fs.symlinkSync(dir, tmp, 'dir');
  fs.renameSync(tmp, link);
  // 版本标记跟随 current，应用中心的「已安装版本/更新检查」以此为准
  fs.mkdirSync(path.dirname(MARKER), { recursive: true });
  fs.writeFileSync(MARKER, `${ver}\n`, 'utf8');
  return listVersions();
}

async function removeVersion(version) {
  const { version: ver, dir } = resolveVersionDir(version);
  if (ver === readCurrent()) throw new Error(`Node.js ${ver} 正在使用中，请先切换到其他版本`);
  fs.rmSync(dir, { recursive: true, force: true });
  return listVersions();
}

module.exports = { listVersions, setCurrent, removeVersion, ROOT, MARKER };
