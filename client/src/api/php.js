import request from './request';

export const getPhpStatus = () => request.get('/php/status');
export const controlPhp = (action, version = '') =>
  request.post(`/php/control/${action}`, { version });

// 配置（上传限制 / 禁用函数 / 配置修改 共用）
export const getPhpSettings = (version = '') =>
  request.get('/php/settings', { params: { version } });
export const savePhpSettings = (version, settings) =>
  request.post('/php/settings', { version, settings });

// 扩展
export const getPhpExtensions = (version = '') =>
  request.get('/php/extensions', { params: { version } });
export const installPhpExtension = (version, module) =>
  request.post('/php/extensions/install', { version, module });
export const uninstallPhpExtension = (version, module) =>
  request.post('/php/extensions/uninstall', { version, module });
export const getPhpJob = (key) => request.get(`/php/job/${key}`);

// 日志
export const getPhpLogs = (version, type = 'error', lines = 200) =>
  request.get('/php/logs', { params: { version, type, lines } });
export const clearPhpLogs = (version, type = 'error', keepLines = 0) =>
  request.post('/php/logs/clear', { version, type, keepLines });
export const setPhpSlowlog = (version, enabled, timeout = 5) =>
  request.post('/php/logs/slowlog', { version, enabled, timeout });
