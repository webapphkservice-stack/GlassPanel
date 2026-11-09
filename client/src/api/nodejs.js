import request from './request';

export const getNodejsOverview = () => request.get('/nodejs');
export const setNodejsCurrent = (version) => request.post('/nodejs/current', { version });
export const removeNodejsVersion = (version) => request.delete(`/nodejs/versions/${encodeURIComponent(version)}`);
