import request from './request';

export const getSupervisorStatus = () => request.get('/supervisor/status');
export const getSupervisorProcesses = () => request.get('/supervisor/processes');
export const controlSupervisorProcess = (type, action, name) =>
  request.post(`/supervisor/control/${type}/${action}`, { name });
export const addSupervisorProgram = (payload) => request.post('/supervisor/program', payload);
export const removeSupervisorProgram = (name) => request.delete(`/supervisor/program/${name}`);
export const addPm2Process = (payload) => request.post('/supervisor/pm2', payload);
