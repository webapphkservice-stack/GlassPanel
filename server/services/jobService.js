const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config/default');
const logger = require('../utils/logger');

// 安装/更新/卸载等长耗时任务的后台执行与日志留存目录
const JOB_DIR = '/opt/glass-panel/data/jobs';
// 单次返回给前端的日志上限，超出只保留末尾
const MAX_LOG_BYTES = 512 * 1024;
// 任务文件保留时长：7 天
const MAX_JOB_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// 任务目录总容量上限：500 MB
const MAX_JOB_DIR_BYTES = 500 * 1024 * 1024;

// 运行中的任务（key → job）。进程重启后 Map 为空，但日志与落盘状态仍在磁盘上可回放
const jobs = new Map();

function ensureDir() {
  fs.mkdirSync(JOB_DIR, { recursive: true });
}

// 从文件名提取任务 key（如 php-install.log → php-install）
// 注意：.body.sh 必须放在 .sh 之前处理，避免 foo.body.sh 被错误识别为 foo.body
function keyOfFile(filename) {
  return filename.replace(/\.(body\.sh|log|sh|pid|exit)$/g, '');
}

// 清理过期任务文件与容量超限文件，跳过正在运行任务
async function cleanupOldJobs() {
  ensureDir();
  const now = Date.now();
  const entries = await fs.promises.readdir(JOB_DIR, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => ({ name: e.name, path: path.join(JOB_DIR, e.name) }));

  const stats = await Promise.all(
    files.map(async (f) => {
      const s = await fs.promises.stat(f.path);
      return { ...f, mtime: s.mtimeMs, size: s.size };
    })
  );

  const runningKeys = new Set();
  for (const f of files) {
    const key = keyOfFile(f.name);
    if (isAliveByPid(key)) runningKeys.add(key);
  }

  // 第一步：按时间删除过期文件
  for (const s of stats) {
    const key = keyOfFile(s.name);
    if (runningKeys.has(key)) continue;
    if (now - s.mtime > MAX_JOB_AGE_MS) {
      try {
        await fs.promises.unlink(s.path);
      } catch (e) {
        logger.error('Cleanup old job file failed', { file: s.name, error: e.message });
      }
    }
  }

  // 第二步：若目录总大小仍超限，按修改时间升序删除最旧文件
  // 过期文件删除后重新统计目录大小，避免用原始 totalSize 误删仍在保留期内的文件
  const remainingEntries = await fs.promises.readdir(JOB_DIR, { withFileTypes: true });
  const remainingFiles = remainingEntries
    .filter((e) => e.isFile())
    .map((e) => ({ name: e.name, path: path.join(JOB_DIR, e.name) }));
  const remainingStats = await Promise.all(
    remainingFiles.map(async (f) => {
      const s = await fs.promises.stat(f.path);
      return { ...f, mtime: s.mtimeMs, size: s.size };
    })
  );
  const totalSize = remainingStats.reduce((sum, s) => sum + s.size, 0);
  if (totalSize > MAX_JOB_DIR_BYTES) {
    const sorted = remainingStats
      .filter((s) => !runningKeys.has(keyOfFile(s.name)))
      .sort((a, b) => a.mtime - b.mtime);
    let freed = 0;
    const need = totalSize - MAX_JOB_DIR_BYTES;
    for (const s of sorted) {
      if (freed >= need) break;
      try {
        await fs.promises.unlink(s.path);
        freed += s.size;
      } catch (e) {
        logger.error('Cleanup large job file failed', { file: s.name, error: e.message });
      }
    }
  }
}

function logPathOf(key) {
  return path.join(JOB_DIR, `${key}.log`);
}

// 外层壳脚本：负责向磁盘汇报 PID 与退出码
function scriptPathOf(key) {
  return path.join(JOB_DIR, `${key}.sh`);
}

// 真正的任务体脚本
function bodyPathOf(key) {
  return path.join(JOB_DIR, `${key}.body.sh`);
}

// 外层壳运行期间写入的 PID
function pidPathOf(key) {
  return path.join(JOB_DIR, `${key}.pid`);
}

// 外层壳退出时写入的退出码
function exitPathOf(key) {
  return path.join(JOB_DIR, `${key}.exit`);
}

// 读取任务日志；超长时仅返回末尾部分，避免响应体过大
function readLog(key) {
  const p = logPathOf(key);
  if (!fs.existsSync(p)) return '';
  const size = fs.statSync(p).size;
  if (size <= MAX_LOG_BYTES) return fs.readFileSync(p, 'utf8');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(MAX_LOG_BYTES);
  fs.readSync(fd, buf, 0, MAX_LOG_BYTES, size - MAX_LOG_BYTES);
  fs.closeSync(fd);
  return `[面板] 日志过长，仅显示末尾部分\n${buf.toString('utf8')}`;
}

// 面板进程重启后 jobs 内存 Map 会清空，但日志文件仍在磁盘上。
// 从日志里的「任务结束，退出码 N」行还原退出码，避免把已完成的任务误判为失败（退出码为空）。
function exitCodeFromLog(log) {
  const re = /\[面板\] 任务结束，退出码 (-?\d+)/g;
  let last = null;
  let hit;
  while ((hit = re.exec(log)) !== null) last = hit[1];
  return last === null ? null : parseInt(last, 10);
}

function readExitFile(key) {
  const p = exitPathOf(key);
  if (!fs.existsSync(p)) return null;
  const n = parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
  return Number.isNaN(n) ? null : n;
}

// 面板重启后内存任务表已丢，靠落盘 PID 判断任务是否仍在运行。
// 再用 /proc/<pid>/cmdline 确认该 PID 确实在跑本任务的外层壳，排除 PID 复用导致的误判。
function isAliveByPid(key) {
  const p = pidPathOf(key);
  if (!fs.existsSync(p)) return false;
  const pid = parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(scriptPathOf(key));
  } catch (e) {
    return false;
  }
}

function isRunning(key) {
  if (jobs.get(key)?.running === true) return true;
  // 面板重启过：内存里没有记录，但任务可能仍在跑，避免同一任务被重复发起
  return isAliveByPid(key);
}

// 任务快照：用于前端轮询展示终端输出与结束状态
function snapshot(key) {
  const job = jobs.get(key);
  const log = readLog(key);
  if (!job) {
    // 面板重启过，内存任务表已丢：改为从落盘状态还原是否仍在运行、结束时的退出码；
    // 两者都拿不到时保持 null，前端提示「退出码未知」而不是渲染空字符串
    const running = isAliveByPid(key);
    return {
      key,
      label: '',
      running,
      exitCode: running ? null : (readExitFile(key) ?? exitCodeFromLog(log)),
      startedAt: null,
      endedAt: null,
      log,
    };
  }
  return {
    key,
    label: job.label,
    running: job.running,
    exitCode: job.exitCode,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    log,
  };
}

function listRunning() {
  return [...jobs.values()]
    .filter((j) => j.running)
    .map((j) => ({ key: j.key, label: j.label, startedAt: j.startedAt }));
}

// 外层壳：面板重启时 jobService 的内存任务表会丢、监听子进程的 node 也已不在，
// 所以由这层独立 bash 壳在退出时把真实退出码落到磁盘，供重启后的新面板还原任务结果。
// PID 由 start() 在 spawn 后立即写入，避免外层壳尚未执行到这里时被误判为「未在运行」。
function buildWrapperScript(key, bodyPath) {
  return `#!/usr/bin/env bash
/usr/bin/bash "${bodyPath}"
RC=$?
printf '%s\\n' "$RC" > "${exitPathOf(key)}"
rm -f "${pidPathOf(key)}" "${bodyPath}"
exit "$RC"
`;
}

// 由面板自身写入的日志行（任务结束等），与子进程直接写文件互不冲突
function appendLog(logPath, text) {
  try {
    fs.appendFileSync(logPath, text);
  } catch (e) {
    logger.error('Append job log failed', { error: e.message });
  }
}

// 供任务后处理阶段追加日志（如安装成功后的自动反代 / 证书签发结果）
function appendLogTo(key, text) {
  appendLog(logPathOf(key), text);
}

/**
 * 后台执行一段 bash 脚本，stdout/stderr 实时写入日志文件供前端轮询。
 * 子进程的 stdout/stderr 直接指向日志文件（而非管道），这样面板重启后
 * 失去读取端的管道会让子进程下一次输出就收到 SIGPIPE 而被打断，任务等于白跑。
 * onDone 在任务结束时、running 置为 false 之前执行，保证前端看到结束时后处理已完成。
 */
async function start({ key, label, script, onDone }) {
  if (isRunning(key)) {
    throw new Error(`${label} 正在进行中，请等待当前任务完成`);
  }
  ensureDir();
  // 启动新任务前清理过期/过量日志，避免磁盘占满导致任务无法落盘
  await cleanupOldJobs();

  const logPath = logPathOf(key);
  const scriptPath = scriptPathOf(key);
  const bodyPath = bodyPathOf(key);
  // 清掉上一轮的日志与落盘状态，避免前端读到过期结果
  fs.writeFileSync(logPath, '', 'utf8');
  fs.rmSync(exitPathOf(key), { force: true });
  fs.rmSync(pidPathOf(key), { force: true });
  // 任务体与外层壳分开落盘：外层壳负责汇报退出码
  fs.writeFileSync(bodyPath, script, 'utf8');
  fs.writeFileSync(scriptPath, buildWrapperScript(key, bodyPath), 'utf8');
  fs.chmodSync(bodyPath, 0o755);
  fs.chmodSync(scriptPath, 0o755);

  const cmd = config.useSudo ? 'sudo' : '/usr/bin/bash';
  const args = config.useSudo ? ['/usr/bin/bash', scriptPath] : [scriptPath];

  logger.info('Start job', { key, label });

  // 子进程持有自己的日志文件描述符：面板被重启也不会影响任务继续输出与收尾
  const logFd = fs.openSync(logPath, 'a');
  let child;
  try {
    child = spawn(cmd, args, { stdio: ['ignore', logFd, logFd] });
  } finally {
    fs.closeSync(logFd);
  }
  const job = { key, label, running: true, exitCode: null, startedAt: Date.now(), endedAt: null };
  jobs.set(key, job);
  // 立即记录外层壳 PID：面板若随后被重启，靠它判断任务是否仍在运行
  try {
    fs.writeFileSync(pidPathOf(key), String(child.pid), 'utf8');
  } catch (e) {
    logger.error('Write job pid file failed', { key, error: e.message });
  }

  child.on('error', (err) => {
    appendLog(logPath, `\n[面板] 无法启动任务：${err.message}\n`);
  });

  child.on('close', async (code) => {
    // code 为 null 表示进程被信号终止（如面板重启时 cgroup 连带终止子进程）
    const rc = code === null ? -1 : code;
    try {
      if (onDone) await onDone(rc);
    } catch (err) {
      appendLog(logPath, `\n[面板] 后处理失败：${err.message}\n`);
      logger.error('Job post-process failed', { key, error: err.message });
    }
    appendLog(logPath, code === null
      ? '\n[面板] 任务进程被信号终止，未正常退出\n'
      : `\n[面板] 任务结束，退出码 ${rc}\n`);
    job.exitCode = rc;
    job.endedAt = Date.now();
    job.running = false;
    try { fs.unlinkSync(scriptPath); } catch (e) {}
    try { fs.unlinkSync(bodyPath); } catch (e) {}
    logger.info('Job finished', { key, code: rc });
  });

  return snapshot(key);
}

module.exports = { start, snapshot, isRunning, listRunning, cleanupOldJobs, appendLogTo };