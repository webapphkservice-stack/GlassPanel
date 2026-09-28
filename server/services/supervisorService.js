const { run } = require('./commandRunner');
const path = require('path');
const fs = require('fs');
const servicesConfig = require('../config/services').supervisor;

async function getStatus() {
  const result = await run('systemctl', ['is-active', servicesConfig.service]);
  return result.exitCode === 0 ? result.stdout.trim() : 'inactive';
}

async function listSupervisorProcesses() {
  try {
    const { stdout } = await run('supervisorctl', ['status']);
    return stdout.split('\n').filter(Boolean).map((line) => {
      const parts = line.trim().split(/\s+/);
      const [name, state, ...rest] = parts;
      return { name, state, detail: rest.join(' '), type: 'supervisor' };
    });
  } catch (err) {
    return [];
  }
}

async function listPm2Processes() {
  try {
    const { stdout } = await run('pm2', ['jlist']);
    const list = JSON.parse(stdout || '[]');
    return list.map((p) => ({
      name: p.name,
      state: p.pm2_env?.status || 'unknown',
      pid: p.pid,
      uptime: p.pm2_env?.pm_uptime,
      type: 'pm2',
    }));
  } catch (err) {
    return [];
  }
}

async function listProcesses() {
  const [supervisor, pm2] = await Promise.all([
    listSupervisorProcesses(),
    listPm2Processes(),
  ]);
  return { supervisor, pm2 };
}

async function controlSupervisor(action, name) {
  const allowed = ['start', 'stop', 'restart'];
  if (!allowed.includes(action)) throw new Error('非法操作');
  return run('supervisorctl', [action, name]);
}

async function controlPm2(action, name) {
  const allowed = ['start', 'stop', 'restart', 'delete', 'reload'];
  if (!allowed.includes(action)) throw new Error('非法操作');
  return run('pm2', [action, name]);
}

function getProgramPath(name) {
  return path.join(servicesConfig.configDir, `${name}.conf`);
}

async function addProgram({ name, command, directory, user, autostart = true, autorestart = true }) {
  if (!name || !command) throw new Error('缺少名称或命令');
  const programPath = getProgramPath(name);
  if (fs.existsSync(programPath)) {
    throw new Error(`已存在同名 Supervisor 程序 ${name}，请先删除或更换名称`);
  }
  const content = `[program:${name}]
command=${command}
${directory ? `directory=${directory}` : ''}
${user ? `user=${user}` : ''}
autostart=${autostart ? 'true' : 'false'}
autorestart=${autorestart ? 'true' : 'false'}
stdout_logfile=/var/log/supervisor/${name}.log
stderr_logfile=/var/log/supervisor/${name}.err.log
`;
  await fs.promises.mkdir(path.dirname(programPath), { recursive: true });
  await fs.promises.writeFile(programPath, content, 'utf8');

  const reread = await run('supervisorctl', ['reread']);
  if (reread.exitCode !== 0) {
    await fs.promises.unlink(programPath).catch(() => {});
    throw new Error(`supervisorctl reread 失败：${(reread.stderr || reread.stdout || '').trim()}`);
  }

  const update = await run('supervisorctl', ['update']);
  if (update.exitCode !== 0) {
    await fs.promises.unlink(programPath).catch(() => {});
    // 再次 reread，让 supervisor 忘掉刚才添加但未成功的配置
    await run('supervisorctl', ['reread']);
    throw new Error(`supervisorctl update 失败：${(update.stderr || update.stdout || '').trim()}`);
  }

  return { success: true, name, rereadOutput: reread, updateOutput: update };
}

async function removeProgram(name) {
  const programPath = getProgramPath(name);
  if (!fs.existsSync(programPath)) {
    return { success: true, name };
  }

  // 先备份，后续 reread/update 失败时可恢复
  const backupPath = `${programPath}.bak.${Date.now()}`;
  await fs.promises.copyFile(programPath, backupPath);

  const stop = await run('supervisorctl', ['stop', name]);
  // 程序未运行/不存在时不视为致命错误，继续清理配置
  await fs.promises.unlink(programPath);

  const reread = await run('supervisorctl', ['reread']);
  if (reread.exitCode !== 0) {
    await fs.promises.copyFile(backupPath, programPath).catch(() => {});
    throw new Error(`supervisorctl reread 失败，配置已恢复：${(reread.stderr || reread.stdout || '').trim()}`);
  }

  const update = await run('supervisorctl', ['update']);
  if (update.exitCode !== 0) {
    await fs.promises.copyFile(backupPath, programPath).catch(() => {});
    await run('supervisorctl', ['reread']);
    throw new Error(`supervisorctl update 失败，配置已恢复：${(update.stderr || update.stdout || '').trim()}`);
  }

  await fs.promises.unlink(backupPath).catch(() => {});
  return { success: true, name, stopOutput: stop, rereadOutput: reread, updateOutput: update };
}

async function addPm2Process({ name, script, cwd }) {
  if (!name || !script) throw new Error('缺少名称或脚本');
  const args = ['start', script, '--name', name];
  if (cwd) args.push('--cwd', cwd);
  return run('pm2', args);
}

module.exports = {
  getStatus,
  listProcesses,
  controlSupervisor,
  controlPm2,
  addProgram,
  removeProgram,
  addPm2Process,
};
