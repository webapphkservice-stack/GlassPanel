import React from 'react';
import ReactDOM from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { loader } from '@monaco-editor/react';
import App from './App';
import { initTheme } from './store';
import i18n from './i18n';
import './styles/global.css';

// Monaco 从面板本地加载：默认 CDN 会被 CSP（script-src 'self'）拦截，
// 表现为配置文件弹窗一直停留在 Loading...
loader.config({ paths: { vs: '/monaco/vs' } });

// 渲染前先套用已保存的主题色，避免首屏闪默认色
initTheme();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <App />
    </I18nextProvider>
  </React.StrictMode>
);