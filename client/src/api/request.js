import axios from 'axios';

const request = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  timeout: 30000,
});

request.interceptors.request.use((config) => {
  const token = localStorage.getItem('panel_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

request.interceptors.response.use(
  (response) => response.data,
  (error) => {
    const status = error.response?.status;
    const message = error.response?.data?.error || error.message || '请求失败';
    if (status === 401) {
      localStorage.removeItem('panel_token');
      const onLoginPage = window.location.pathname.endsWith('/login');
      if (!onLoginPage && !error.config?.skipAuthRedirect) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(message);
  }
);

export default request;
