const os = require('os');
const fs = require('fs');
const { run } = require('./commandRunner');

function bytesToGB(bytes) {
  return (bytes / 1024 / 1024 / 1024).toFixed(2);
}

// ---- CPU 频率：云主机 / 容器中 os.cpus() 常返回 speed=0，需要回退取值 ----

function readProcCpuSpeeds() {
  try {
    const content = fs.readFileSync('/proc/cpuinfo', 'utf8');
    const speeds = [];
    content.split('\n').forEach((line) => {
      const match = line.match(/^cpu MHz\s*:\s*([\d.]+)/i);
      if (match) speeds.push(Math.round(parseFloat(match[1])));
    });
    return speeds;
  } catch (err) {
    return [];
  }
}

function readSysfsCpuSpeed(index) {
  const files = ['cpufreq/scaling_cur_freq', 'cpufreq/cpuinfo_max_freq'];
  for (const file of files) {
    try {
      const khz = parseInt(fs.readFileSync(`/sys/devices/system/cpu/cpu${index}/${file}`, 'utf8').trim(), 10);
      if (khz > 0) return Math.round(khz / 1000);
    } catch (err) {
      // 该核心无 cpufreq 信息，继续尝试下一个来源
    }
  }
  return 0;
}

// 型号字符串中的标称频率，如 "Intel(R) Xeon(R) ... CPU @ 2.50GHz"
function modelSpeedMHz(model) {
  const match = String(model || '').match(/@\s*([\d.]+)\s*GHz/i);
  return match ? Math.round(parseFloat(match[1]) * 1000) : 0;
}

function resolveCpuSpeeds(cpus) {
  const procSpeeds = readProcCpuSpeeds();
  const fallback = procSpeeds.find((s) => s > 0) || modelSpeedMHz(cpus[0]?.model);
  return cpus.map((cpu, idx) => {
    if (cpu.speed > 0) return cpu.speed;
    if (procSpeeds[idx] > 0) return procSpeeds[idx];
    const sysfs = readSysfsCpuSpeed(idx);
    return sysfs > 0 ? sysfs : fallback;
  });
}

// ---- 网络：/proc/net/dev 累计字节数，两次采样计算实时速率 ----
const NET_SAMPLE_MS = 500;
const VIRTUAL_IFACE = /^(lo|veth|docker|br-|virbr|tun|tap)/;

function readNetDevTotals() {
  try {
    const content = fs.readFileSync('/proc/net/dev', 'utf8');
    let received = 0;
    let sent = 0;
    content.split('\n').slice(2).forEach((line) => {
      const [namePart, dataPart] = line.split(':');
      if (!namePart || !dataPart) return;
      const name = namePart.trim();
      if (!name || VIRTUAL_IFACE.test(name)) return;
      const cols = dataPart.trim().split(/\s+/);
      received += parseInt(cols[0], 10) || 0;
      sent += parseInt(cols[8], 10) || 0;
    });
    return { received, sent };
  } catch (err) {
    return null;
  }
}

async function getNetworkStats() {
  const start = readNetDevTotals();
  const startedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, NET_SAMPLE_MS));
  const end = readNetDevTotals();
  if (!end) return { up: 0, down: 0, sent: 0, received: 0, available: false };
  const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
  return {
    up: start ? Math.max((end.sent - start.sent) / seconds, 0) : 0,
    down: start ? Math.max((end.received - start.received) / seconds, 0) : 0,
    sent: end.sent,
    received: end.received,
    available: true,
  };
}

async function getSystemInfo() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const cpus = os.cpus();
  const cpuSpeeds = resolveCpuSpeeds(cpus);
  const info = {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptime: os.uptime(),
    loadAverage: os.loadavg(),
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model || '',
    cpus: cpus.map((cpu, idx) => ({
      model: cpu.model,
      speed: cpuSpeeds[idx] || 0,
    })),
    memory: {
      total: bytesToGB(totalMem),
      used: bytesToGB(usedMem),
      free: bytesToGB(freeMem),
      percent: Math.round((usedMem / totalMem) * 100),
    },
    disk: [],
  };

  // 磁盘使用（Linux）
  try {
    const { stdout } = await run('df', ['-h', '-P', '/']);
    const lines = stdout.trim().split('\n').slice(1);
    info.disk = lines.map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        filesystem: parts[0],
        size: parts[1],
        used: parts[2],
        available: parts[3],
        percent: parseInt(parts[4], 10),
        mount: parts[5],
      };
    });
  } catch (err) {
    info.disk = [];
  }

  return info;
}

async function getCpuUsage() {
  // 简单采样计算 CPU 使用率
  const getTimes = () => os.cpus().map((cpu) => cpu.times);
  const start = getTimes();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const end = getTimes();

  let totalDiff = 0;
  let idleDiff = 0;
  for (let i = 0; i < start.length; i++) {
    const s = start[i];
    const e = end[i];
    const total = Object.keys(e).reduce((acc, key) => acc + (e[key] - s[key]), 0);
    const idle = e.idle - s.idle;
    totalDiff += total;
    idleDiff += idle;
  }

  const usage = totalDiff === 0 ? 0 : Math.round(((totalDiff - idleDiff) / totalDiff) * 100);
  return { usage };
}

// 重启面板服务（通过 systemd 优雅重启）
async function restartPanel() {
  const result = await run('systemctl', ['restart', 'glass-panel']);
  return result;
}

module.exports = { getSystemInfo, getCpuUsage, getNetworkStats, restartPanel };
