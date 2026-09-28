import request from './request';

export const getMysqlStatus = () => request.get('/mysql/status');
export const controlMysql = (action) => request.post(`/mysql/control/${action}`);
