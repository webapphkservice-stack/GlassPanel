import request from './request';

export const getFirewallStatus = () => request.get('/firewall/status');
export const getFirewallRules = () => request.get('/firewall/rules');
export const addFirewallRule = (payload) => request.post('/firewall/rules', payload);
export const removeFirewallRule = (id) => request.delete(`/firewall/rules/${id}`);
export const controlFirewall = (action) => request.post(`/firewall/control/${action}`);
