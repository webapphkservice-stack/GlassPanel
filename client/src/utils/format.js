import i18n from '@/i18n';

export function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(i18n.t('format.days', { n: d, count: d }));
  if (h > 0) parts.push(i18n.t('format.hours', { n: h, count: h }));
  if (m > 0 || parts.length === 0) parts.push(i18n.t('format.mins', { n: m, count: m }));
  return parts.join(' ');
}

export function formatBytes(value, unit = 'GB') {
  return `${value} ${unit}`;
}

// 字节数自适应单位，如 1536 → 1.50 KB
export function formatBytesSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const digits = i === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[i]}`;
}

// 网络速率，如 2048 → 2.00 KB/s
export function formatSpeed(bytesPerSecond) {
  return `${formatBytesSize(bytesPerSecond)}/s`;
}
