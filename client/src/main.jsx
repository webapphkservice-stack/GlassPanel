import React from 'react';
import ReactDOM from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import App from './App';
import { initTheme } from './store';
import i18n from './i18n';
import './styles/global.css';

// 渲染前先套用已保存的主题色，避免首屏闪默认色
initTheme();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <App />
    </I18nextProvider>
  </React.StrictMode>
);