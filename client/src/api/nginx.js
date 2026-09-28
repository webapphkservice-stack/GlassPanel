import request from './request';

export const getNginxStatus = () => request.get('/nginx/status');
export const controlNginx = (action) => request.post(`/nginx/control/${action}`);
export const testNginxConfig = () => request.post('/nginx/test');
export const getNginxSites = () => request.get('/nginx/sites');
// 创建站点可能同时签发证书，耗时较长，单独放宽超时
export const createNginxSite = (payload) => request.post('/nginx/sites', payload, { timeout: 240000 });
export const getNginxConfig = (path) => request.get('/nginx/config', { params: { path } });
export const saveNginxConfig = (path, content, reload = false) => request.post('/nginx/config', { path, content, reload });
// 删除站点会同时清理关联数据库与证书，耗时较长，单独放宽超时
export const getSiteRelations = (name) => request.get(`/nginx/sites/${encodeURIComponent(name)}/relations`);
export const deleteNginxSite = (name) => request.delete(`/nginx/sites/${encodeURIComponent(name)}`, { timeout: 240000 });

// 开通进度查询：失败时拦截器只会抛出字符串（且不含状态码），这里归一化成结果对象，
// 便于轮询逻辑区分「进度已过期」与「网络/服务异常」
export async function getProvisionStatus(opId) {
  try {
    const data = await request.get(`/nginx/sites/provision/${encodeURIComponent(opId)}`, { timeout: 10000 });
    return { ok: true, provision: data?.provision || null };
  } catch (message) {
    const text = String(message);
    return { ok: false, expired: text.includes('不存在或已过期'), message: text };
  }
}

// —— 站点文件管理（限定在该站点 root 内） ——
export const getSiteFiles = (name, dir = '') =>
  request.get(`/nginx/sites/${encodeURIComponent(name)}/files`, { params: { dir } });
export const createSiteDir = (name, path) =>
  request.post(`/nginx/sites/${encodeURIComponent(name)}/files/dirs`, { path });
export const uploadSiteFile = (name, dir, file, overwrite = true) =>
  request.post(
    `/nginx/sites/${encodeURIComponent(name)}/files/upload`,
    file,
    {
      params: { dir, name: file.name, overwrite },
      headers: { 'Content-Type': 'application/octet-stream' },
      timeout: 600000,
    }
  );
export const downloadSiteFile = (name, path) =>
  request.get(`/nginx/sites/${encodeURIComponent(name)}/files/download`, {
    params: { path },
    responseType: 'blob',
    timeout: 600000,
  });
export const deleteSiteFile = (name, path) =>
  request.delete(`/nginx/sites/${encodeURIComponent(name)}/files`, { params: { path } });
// 解压压缩包可能耗时较长，单独放宽超时；dest 留空由服务端按压缩包名推导默认目录
export const extractSiteFile = (name, path, dest = '') =>
  request.post(
    `/nginx/sites/${encodeURIComponent(name)}/files/extract`,
    { path, dest },
    { timeout: 600000 }
  );
