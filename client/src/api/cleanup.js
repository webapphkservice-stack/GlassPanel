import request from './request';

// 扫描四类清理项：只读，目录遍历耗时随文件数增长
export const scanCleanup = () => request.get('/cleanup/scan', { timeout: 180000 });

// 执行清理：journal 收缩与包管理器缓存清理较慢，单独放宽超时
export const runCleanup = (keys) => request.post('/cleanup/run', { keys }, { timeout: 600000 });