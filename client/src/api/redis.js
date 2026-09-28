import request from './request';

export const getRedisStatus = () => request.get('/redis/status');
export const controlRedis = (action) => request.post(`/redis/control/${action}`);
