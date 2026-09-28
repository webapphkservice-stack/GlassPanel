import request from './request';

export const getMysqlStatus = () => request.get('/mysql/status');
export const controlMysql = (action) => request.post(`/mysql/control/${action}`);
// 建库需要执行多条 SQL，放宽超时
export const createMysqlDatabase = (domain) =>
  request.post('/mysql/databases', { domain }, { timeout: 60000 });

// 重置数据库用户密码：存量库密码未记录，重置后由面板保存并在列表展示
export const resetDbPassword = (name) =>
  request.post(`/mysql/databases/${encodeURIComponent(name)}/password`, {}, { timeout: 60000 });

// 删除数据库（连同同名用户）：库内数据不可恢复
export const deleteMysqlDatabase = (name) =>
  request.delete(`/mysql/databases/${encodeURIComponent(name)}`, { timeout: 120000 });

// —— 数据库备份（导出 .sql / 恢复 / 下载） ——
export const getDbBackups = (name) =>
  request.get(`/mysql/databases/${encodeURIComponent(name)}/backups`);
// 大库导出耗时较长，单独放宽超时
export const createDbBackup = (name, schemaOnly = false) =>
  request.post(`/mysql/databases/${encodeURIComponent(name)}/backups`, { schemaOnly }, { timeout: 600000 });
export const downloadDbBackup = (name, file) =>
  request.get(`/mysql/databases/${encodeURIComponent(name)}/backups/download`, {
    params: { file }, responseType: 'blob', timeout: 600000,
  });
export const restoreDbBackup = (name, file) =>
  request.post(
    `/mysql/databases/${encodeURIComponent(name)}/backups/restore`,
    { file },
    { timeout: 600000 }
  );
export const deleteDbBackup = (name, file) =>
  request.delete(`/mysql/databases/${encodeURIComponent(name)}/backups`, { params: { file } });