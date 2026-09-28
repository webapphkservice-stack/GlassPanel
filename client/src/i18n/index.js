import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';
import en from './locales/en.json';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { translation: zhCN },
      'zh-TW': { translation: zhTW },
      en: { translation: en },
    },
    fallbackLng: 'zh-CN',
    interpolation: {
      escapeValue: false,
      // 面板所有语言包统一使用单花括号占位符 {name}，与 i18next 默认的 {{name}} 不同
      prefix: '{',
      suffix: '}',
    },
    detection: {
      order: ['querystring', 'localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupQuerystring: 'lang',
    },
  });

export default i18n;