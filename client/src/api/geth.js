import request from './request';

export const getGethOverview = () => request.get('/geth');
export const getGethLogs = (lines = 200) => request.get('/geth/logs', { params: { lines } });
export const controlGethService = (action) => request.post(`/geth/control/${action}`);
