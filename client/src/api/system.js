import request from './request';

export const getSystemInfo = () => request.get('/system/info');
export const getServiceStatuses = () => request.get('/system/services');
export const restartPanel = () => request.post('/system/restart');
export const getPanelSettings = () => request.get('/system/settings');
export const savePanelSettings = (settings) => request.post('/system/settings', settings);
