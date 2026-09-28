import request from './request';

// 服务状态与启停
export const getFail2banStatus = () => request.get('/fail2ban/status');
export const controlFail2ban = (action) => request.post(`/fail2ban/control/${action}`);
export const unbanFail2banIp = (jail, ip) => request.post('/fail2ban/unban', { jail, ip });

// 服务保护
export const getFail2banServices = () => request.get('/fail2ban/services');
export const saveFail2banServices = (services) => request.post('/fail2ban/services', { services });

// 站点保护
export const getFail2banSites = () => request.get('/fail2ban/sites');
export const saveFail2banSite = (site, enabled, filters) =>
  request.post('/fail2ban/sites', { site, enabled, filters });

// IP 白名单
export const getFail2banWhitelist = () => request.get('/fail2ban/whitelist');
export const addFail2banWhitelist = (ip, note = '') =>
  request.post('/fail2ban/whitelist/add', { ip, note });
export const removeFail2banWhitelist = (ip) =>
  request.post('/fail2ban/whitelist/remove', { ip });
export const refreshFail2banAutoIps = () => request.post('/fail2ban/whitelist/refresh');

// IP 黑名单
export const getFail2banBlacklist = () => request.get('/fail2ban/blacklist');
export const addFail2banBlacklist = (ip, note = '') =>
  request.post('/fail2ban/blacklist/add', { ip, note });
export const removeFail2banBlacklist = (ip) =>
  request.post('/fail2ban/blacklist/remove', { ip });