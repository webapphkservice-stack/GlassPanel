const fs = require('fs');
const path = require('path');
const { run } = require('./commandRunner');

// 裸 iptables 规则的持久化文件：由 iptables-restore.service 在开机时加载，
// 面板每次增删规则 / 切换策略后都要回写，否则重启后会丢失
const IPTABLES_RULES_FILE = '/etc/iptables/rules.v4';

// 只有三条默认策略、没有任何自定义规则时说明没在用 iptables，不应识别为该后端
function iptablesInUse(spec) {
  const lines = String(spec || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.includes('-P INPUT DROP')) return true;
  return lines.some((l) => l.startsWith('-A '));
}

// 仅暴露带 --dport 的端口规则：这类规则可安全增删；
// icmp / lo / established 是系统必需项，不在面板中列出以免被误删
function parseIptablesRules(stdout) {
  const rules = [];
  for (const line of String(stdout || '').split('\n')) {
    const text = line.trim();
    if (!text.startsWith('-A INPUT ')) continue;
    const dport = text.match(/--dport\s+([\d:]+)/);
    if (!dport) continue;
    const target = text.match(/-j\s+(\w+)/)?.[1] || '';
    if (!['ACCEPT', 'DROP', 'REJECT'].includes(target)) continue;
    rules.push({
      id: rules.length + 1,
      port: dport[1],
      protocol: text.match(/-p\s+(\w+)/)?.[1] || 'any',
      action: target === 'ACCEPT' ? 'allow' : 'deny',
      from: 'any',
      // 用 -S 输出的完整规则串删除，避免人工拼参数产生歧义
      spec: text,
    });
  }
  return rules;
}

// 把内存中的规则落盘：先写临时文件并做语法校验，通过后再替换，避免写坏开机规则
async function persistIptables() {
  const saved = await run('iptablesSave', []);
  if (saved.exitCode !== 0 || !saved.stdout.trim()) return;
  const tmp = `${IPTABLES_RULES_FILE}.tmp`;
  try {
    fs.mkdirSync(path.dirname(IPTABLES_RULES_FILE), { recursive: true });
    fs.writeFileSync(tmp, saved.stdout, 'utf8');
    const test = await run('iptablesRestore', ['--test', tmp]);
    if (test.exitCode !== 0) {
      fs.rmSync(tmp, { force: true });
      return;
    }
    fs.renameSync(tmp, IPTABLES_RULES_FILE);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* ignore */ }
  }
}

async function detect() {
  try {
    const ufw = await run('ufw', ['status']);
    if (ufw.exitCode === 0) return 'ufw';
  } catch (e) { /* ignore */ }
  try {
    const fw = await run('firewallCmd', ['--state']);
    // firewalld 未运行时 exitCode 非 0 且 "not running" 写在 stderr，
    // 因此只能按 exitCode === 0 判定，不能匹配 stdout 里的 running 字样
    if (fw.exitCode === 0) return 'firewalld';
  } catch (e) { /* ignore */ }
  try {
    const ipt = await run('iptables', ['-S']);
    if (ipt.exitCode === 0 && iptablesInUse(ipt.stdout)) return 'iptables';
  } catch (e) { /* ignore */ }
  return 'unknown';
}

async function getStatus() {
  const backend = await detect();
  if (backend === 'ufw') {
    const result = await run('ufw', ['status', 'numbered']);
    const active = /Status:\s*active/i.test(result.stdout);
    return { backend, active, raw: result.stdout };
  }
  if (backend === 'firewalld') {
    const result = await run('firewallCmd', ['--state']);
    return { backend, active: /running/i.test(result.stdout), raw: result.stdout };
  }
  if (backend === 'iptables') {
    const result = await run('iptables', ['-S']);
    // 只有 INPUT 策略为 DROP 时才算真正生效的默认拒绝，否则防火墙形同关闭
    return { backend, active: /^-P INPUT DROP$/m.test(result.stdout), raw: result.stdout };
  }
  return { backend, active: false, raw: '' };
}

function parseUfwRules(stdout) {
  const lines = stdout.split('\n');
  const rules = [];
  let id = 0;
  for (const line of lines) {
    const match = line.match(/^\[\s*(\d+)\]\s+(.+?)\s+(ALLOW|DENY|REJECT)\s+IN\s+(.+)$/);
    if (match) {
      id = parseInt(match[1], 10);
      const spec = match[2].trim();
      let port = '';
      let protocol = '';
      const portProto = spec.match(/^(\d+(?:\/(?:tcp|udp))?)$/);
      if (portProto) {
        const [p, proto] = portProto[1].split('/');
        port = p;
        protocol = proto || 'any';
      } else {
        port = spec;
        protocol = 'any';
      }
      rules.push({ id, port, protocol, action: match[3].toLowerCase(), from: match[4].trim() });
    }
  }
  return rules;
}

async function listRules() {
  const backend = await detect();
  if (backend === 'ufw') {
    const result = await run('ufw', ['status', 'numbered']);
    return { backend, rules: parseUfwRules(result.stdout) };
  }
  if (backend === 'firewalld') {
    const result = await run('firewallCmd', ['--list-all', '--zone=public']);
    const rules = [];
    const portRegex = /ports:\s*([\s\S]*?)\n\S+:/;
    const match = result.stdout.match(portRegex);
    if (match) {
      const ports = match[1].trim().split(/\s+/).filter(Boolean);
      ports.forEach((p, idx) => {
        const [port, protocol] = p.split('/');
        rules.push({ id: idx + 1, port, protocol, action: 'allow', from: 'public' });
      });
    }
    return { backend, rules };
  }
  if (backend === 'iptables') {
    const result = await run('iptables', ['-S', 'INPUT']);
    return { backend, rules: parseIptablesRules(result.stdout) };
  }
  return { backend, rules: [] };
}

async function control(action) {
  const backend = await detect();
  if (!['enable', 'disable'].includes(action)) throw new Error('非法操作');
  if (backend === 'ufw') {
    return run('ufw', ['--force', action]);
  }
  if (backend === 'firewalld') {
    return run('systemctl', [action === 'enable' ? 'start' : 'stop', 'firewalld']);
  }
  if (backend === 'iptables') {
    // iptables 没有独立开关，通过 INPUT 默认策略在「默认拒绝」与「全部放行」间切换
    const result = await run('iptables', ['-P', 'INPUT', action === 'enable' ? 'DROP' : 'ACCEPT']);
    if (result.exitCode === 0) await persistIptables();
    return result;
  }
  throw new Error('未检测到支持的防火墙');
}

async function addRule({ port, protocol = 'tcp', action = 'allow' }) {
  if (!port || !/^[\d\-:/]+$/.test(String(port))) throw new Error('非法端口');
  const backend = await detect();
  if (backend === 'ufw') {
    return run('ufw', [action, `${port}/${protocol}`]);
  }
  if (backend === 'firewalld') {
    await run('firewallCmd', ['--permanent', '--zone=public', `--add-port=${port}/${protocol}`]);
    return run('firewallCmd', ['--reload']);
  }
  if (backend === 'iptables') {
    const dport = String(port).replace(/-/g, ':'); // iptables 的端口区间用冒号
    // --dport 必须搭配 -p，协议选 any 时同时放行 tcp 与 udp
    const protos = ['tcp', 'udp'].includes(protocol) ? [protocol] : ['tcp', 'udp'];
    let last = { stdout: '', stderr: '', exitCode: 0 };
    for (const p of protos) {
      last = await run('iptables', ['-A', 'INPUT', '-p', p, '--dport', dport, '-j', action === 'deny' ? 'DROP' : 'ACCEPT']);
      if (last.exitCode !== 0) break;
    }
    if (last.exitCode === 0) await persistIptables();
    return last;
  }
  throw new Error('未检测到支持的防火墙');
}

async function removeRule(id) {
  const backend = await detect();
  if (backend === 'ufw') {
    return run('ufw', ['--force', 'delete', String(id)]);
  }
  if (backend === 'firewalld') {
    const { rules } = await listRules();
    const rule = rules.find((r) => r.id === id);
    if (!rule) throw new Error('规则不存在');
    await run('firewallCmd', ['--permanent', '--zone=public', `--remove-port=${rule.port}/${rule.protocol}`]);
    return run('firewallCmd', ['--reload']);
  }
  if (backend === 'iptables') {
    const { rules } = await listRules();
    const rule = rules.find((r) => r.id === id);
    if (!rule) throw new Error('规则不存在');
    const result = await run('iptables', ['-D', 'INPUT', ...rule.spec.replace(/^-A INPUT\s+/, '').split(/\s+/)]);
    if (result.exitCode === 0) await persistIptables();
    return result;
  }
  throw new Error('未检测到支持的防火墙');
}

module.exports = {
  detect,
  getStatus,
  listRules,
  control,
  addRule,
  removeRule,
};
