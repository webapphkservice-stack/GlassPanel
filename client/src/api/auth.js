import request from './request';

export const login = (username, password) =>
  request.post('/auth/login', { username, password }, { skipAuthRedirect: true });

export const verifyTotp = (tempToken, code) =>
  request.post('/auth/totp', { tempToken, code }, { skipAuthRedirect: true });

export const getMe = () => request.get('/auth/me');

export const logout = () => request.post('/auth/logout');

export const setupTotp = () => request.post('/auth/totp/setup');

export const confirmTotp = (password, code) =>
  request.post('/auth/totp/confirm', { password, code }, { skipAuthRedirect: true });

export const disableTotp = (password, code) =>
  request.post('/auth/totp/disable', { password, code }, { skipAuthRedirect: true });

export const resetTotp = (password, code) =>
  request.post('/auth/totp/reset', { password, code }, { skipAuthRedirect: true });
