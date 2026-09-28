import React, { useEffect, useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from '@/components/common/Icons';
import AppRouter from '@/router';

function VersionWatcher() {
  const { t } = useTranslation();
  const [newVersion, setNewVersion] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const res = await fetch('/build.json', { cache: 'no-store' });
        if (!res.ok) return;
        const meta = await res.json();
        if (meta.build && String(meta.build) !== __BUILD_ID__ && !cancelled) {
          setNewVersion(true);
        }
      } catch (e) {
        /* 开发环境无 build.json 时忽略 */
      }
    };

    check();
    const timer = setInterval(check, 60 * 1000);
    const onFocus = () => check();
    const onVisibility = () => {
      if (!document.hidden) check();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  if (!newVersion) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[100] animate-[toastIn_0.25s_ease] rounded-2xl border border-white/[0.12] bg-gradient-to-b from-white/[0.12] via-white/[0.06] to-white/[0.09] p-px shadow-glass backdrop-blur-2xl backdrop-saturate-150">
      <div className="flex items-center gap-3 rounded-[calc(1rem-1px)] bg-gray-950/75 px-5 py-4">
        <span className="text-sm text-white/85">{t('common.newVersionAvailable')}</span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="group relative overflow-hidden rounded-full border border-cyan-300/40 bg-gradient-to-b from-cyan-400/90 to-cyan-500/70 px-4 py-1.5 text-sm font-medium text-white shadow-[0_8px_24px_rgba(34,211,238,0.25)] backdrop-blur-xl transition-all duration-300 hover:brightness-110 active:scale-[0.97]"
        >
          <span className="pointer-events-none absolute inset-x-2 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
          <span className="relative flex items-center gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            {t('common.refreshNow')}
          </span>
        </button>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <VersionWatcher />
      <AppRouter />
    </BrowserRouter>
  );
}