import request from './request';

export const getSystemInfo = () => request.get('/system/info');
export const getServiceStatuses = () => request.get('/system/services');
export const restartPanel = () => request.post('/system/restart');
