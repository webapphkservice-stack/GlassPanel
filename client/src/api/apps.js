import request from './request';

export const getApps = () => request.get('/apps/apps');
export const getAppVersions = (key) => request.get(`/apps/versions/${key}`);
// 安装/更新/卸载改为后台任务：接口立即返回任务信息，执行过程通过 getAppJob 轮询
export const installApp = (key, version = '', config = {}) => request.post(`/apps/install/${key}`, { version, config });
export const updateApp = (key) => request.post(`/apps/update/${key}`, {});
export const uninstallApp = (key) => request.post(`/apps/uninstall/${key}`);
export const getAppJob = (key) => request.get(`/apps/job/${key}`);
export const syncXui = (version) => request.post('/apps/sync-xui', { version });
export const syncXuiLatest = () => request.post('/apps/sync-xui-latest', {});
