import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuthStore, useUIStore as useSidebarUI, THEMES, useThemeStore } from '@/store';
import { useUIStore } from '@/components/common/uiStore';
import { Bell, Menu, RefreshCw, Palette, Check, Shield, Globe, Trash2 } from '@/components/common/Icons';
import GlassModal from '@/components/common/GlassModal';
import CleanupModal from '@/components/common/CleanupModal';
import { restartPanel } from '@/api/system';
import i18n from '@/i18n';

const LANGUAGES = [
  { code: 'zh-CN', label: '简' },
  { code: 'zh-TW', label: '繁' },
  { code: 'en', label: 'EN' },
];

export default function Header({ title }) {
  const { t, i18n: i18nInstance } = useTranslation();
  const { sidebarCollapsed, toggleSidebar } = useSidebarUI();
  const { user } = useAuthStore();
  const toast = useUIStore((s) => s.toast);
  const uiConfirm = useUIStore((s) => s.confirm);
  const { themeId, setTheme } = useThemeStore();
  const navigate = useNavigate();
  const [restarting, setRestarting] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const langRef = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (langRef.current && !langRef.current.contains(e.target)) setLangOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  async function handleRestart() {
    const ok = await uiConfirm({
      title: t('header.restartPanel'),
      message: t('header.restartConfirm'),
    });
    if (!ok) return;
    setRestarting(true);
    try {
      const result = await restartPanel();
      toast(result.message || t('header.restartingNotice'), 'info');
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setRestarting(false);
    }
  }

  function handlePickTheme(theme) {
    setTheme(theme.id);
    toast(t('header.themeSwitched', { name: t(`theme.${theme.id}`) }), 'success');
  }

  function changeLang(code) {
    i18n.changeLanguage(code);
    setLangOpen(false);
  }

  const currentLang = i18nInstance.language || 'zh-CN';

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-white/10 bg-[rgba(15,21,38,0.5)] px-6 backdrop-blur-2xl backdrop-saturate-150">
      <div className="flex items-center gap-4">
        <button
          onClick={toggleSidebar}
          className="rounded-lg p-2 hover:bg-white/10 transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
        <h1 className="text-xl font-semibold">{title}</h1>
      </div>
      <div className="flex items-center gap-4">
        <button
          onClick={() => setCleanupOpen(true)}
          className="rounded-full p-2 hover:bg-white/10 transition-colors"
          title={t('header.cleanup')}
        >
          <Trash2 className="w-5 h-5" />
        </button>
        <button
          onClick={() => setThemeOpen(true)}
          className="rounded-full p-2 hover:bg-white/10 transition-colors"
          title={t('header.themeColor')}
        >
          <Palette className="w-5 h-5" />
        </button>

        <div className="relative" ref={langRef}>
          <button
            onClick={() => setLangOpen(!langOpen)}
            className="flex items-center gap-1 rounded-full p-2 hover:bg-white/10 transition-colors"
            title={t('header.language')}
          >
            <Globe className="w-4 h-4" />
            <span className="text-xs font-medium text-white/70">{LANGUAGES.find((l) => l.code === currentLang)?.label || '简'}</span>
          </button>
          {langOpen && (
            <div className="absolute right-0 top-full mt-2 w-28 rounded-xl border border-white/10 bg-gray-900/90 backdrop-blur-xl py-1 shadow-xl">
              {LANGUAGES.map((lang) => (
                <button
                  key={lang.code}
                  onClick={() => changeLang(lang.code)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-white/10 ${
                    currentLang === lang.code ? 'text-cyan-300' : 'text-white/70'
                  }`}
                >
                  {lang.code === 'zh-CN' ? '简体中文' : lang.code === 'zh-TW' ? '繁體中文' : 'English'}
                  {currentLang === lang.code && <Check className="ml-auto h-3.5 w-3.5" />}
                </button>
              ))}
            </div>
          )}
        </div>

        <button className="relative rounded-full p-2 hover:bg-white/10 transition-colors">
          <Bell className="w-5 h-5" />
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-rose-500" />
        </button>
        <button
          onClick={handleRestart}
          disabled={restarting}
          className="rounded-full p-2 hover:bg-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title={t('header.restartPanel')}
        >
          <RefreshCw className={`w-5 h-5 ${restarting ? 'animate-spin' : ''}`} />
        </button>
        {user && (
          <button
            type="button"
            onClick={() => navigate('/security')}
            className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 py-1 pl-1 pr-3 transition-colors hover:bg-white/10"
            title={t('header.securitySettings')}
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-cyan-400/30 to-cyan-500/30 text-xs font-semibold text-cyan-100">
              {(user.username || 'A').slice(0, 1).toUpperCase()}
            </span>
            <span className="text-sm font-medium text-white/80">{user.username}</span>
            {user.totpEnabled && <Shield className="h-3.5 w-3.5 text-emerald-300" />}
            {user.role && <span className="text-xs text-white/40">{user.role === 'admin' ? t('header.admin') : user.role}</span>}
          </button>
        )}
      </div>

      <GlassModal
        title={t('header.themeColor')}
        subtitle={t('header.themeSubtitle')}
        open={themeOpen}
        onClose={() => setThemeOpen(false)}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {THEMES.map((theme) => {
            const active = theme.id === themeId;
            return (
              <button
                key={theme.id}
                type="button"
                onClick={() => handlePickTheme(theme)}
                className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
                  active
                    ? 'border-cyan-400/50 bg-cyan-500/10'
                    : 'border-white/10 bg-white/5 hover:bg-white/10'
                }`}
              >
                <span
                  className="h-7 w-7 flex-none rounded-full border border-white/25"
                  style={{ background: `rgb(${theme.rgb.join(', ')})` }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{t(`theme.${theme.id}`)}</span>
                  <span className="block truncate text-xs text-white/45">
                    {t(`theme.${theme.id}Desc`)}
                  </span>
                </span>
                {active && <Check className="w-4 h-4 flex-none text-cyan-300" />}
              </button>
            );
          })}
        </div>
      </GlassModal>

      <CleanupModal open={cleanupOpen} onClose={() => setCleanupOpen(false)} />
    </header>
  );
}