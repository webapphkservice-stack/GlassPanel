import React from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from './uiStore';
import { Check, X, AlertTriangle, Info } from './Icons';

const typeIcon = {
  success: { icon: Check, cls: 'text-emerald-300' },
  error: { icon: X, cls: 'text-rose-300' },
  warning: { icon: AlertTriangle, cls: 'text-amber-300' },
  info: { icon: Info, cls: 'text-cyan-300' },
};

export function ToastContainer() {
  const toasts = useUIStore((s) => s.toasts);
  const dismiss = useUIStore((s) => s.dismissToast);
  return (
    <div className="fixed right-4 top-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const tv = typeIcon[t.type] || typeIcon.info;
        const Icon = tv.icon;
        return (
          <div
            key={t.id}
            className="animate-[toastIn_0.25s_cubic-bezier(0.16,1,0.3,1)] overflow-hidden rounded-2xl border border-white/[0.12] bg-gradient-to-b from-white/[0.12] via-white/[0.06] to-white/[0.09] shadow-glass backdrop-blur-2xl backdrop-saturate-150"
          >
            <div className="flex items-center gap-3 rounded-[calc(1rem-1px)] bg-gray-950/70 px-4 py-3 backdrop-blur-2xl backdrop-saturate-150">
              <div className={`rounded-lg bg-white/5 p-1.5 ${tv.cls}`}>
                <Icon className="h-4 w-4" />
              </div>
              <p className="flex-1 text-sm text-white/90 break-all">{t.message}</p>
              <button onClick={() => dismiss(t.id)} className="text-white/40 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        );
      })}
      <style>{`@keyframes toastIn { from { opacity:0; transform: translateX(12px) } to { opacity:1; transform:none } }`}</style>
    </div>
  );
}

export function ConfirmDialog() {
  const { t } = useTranslation();
  const cs = useUIStore((s) => s.confirmState);
  const resolve = useUIStore((s) => s.resolveConfirm);
  if (!cs) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-md animate-[fadeIn_0.2s_ease]" onClick={() => resolve(false)} />
      <div className="relative z-10 w-full max-w-md overflow-hidden rounded-3xl border border-white/[0.12] bg-gradient-to-b from-white/[0.12] via-white/[0.06] to-white/[0.09] shadow-glass backdrop-blur-2xl backdrop-saturate-150 animate-[scaleIn_0.22s_cubic-bezier(0.16,1,0.3,1)]">
        <div className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
        <div className="relative rounded-[calc(1.5rem-1px)] bg-gray-950/75 px-6 py-6 backdrop-blur-2xl backdrop-saturate-150">
          <div className="flex items-start gap-4">
            <div className="rounded-xl bg-rose-500/10 p-2 text-rose-300">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold">{cs.title || t('common.pleaseConfirm')}</h3>
              {cs.message && <p className="mt-1.5 text-sm text-white/60 break-all whitespace-pre-line">{cs.message}</p>}
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <button
              onClick={() => resolve(false)}
              className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/80 hover:bg-white/10 transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={() => resolve(true)}
              className="rounded-xl bg-gradient-to-r from-rose-500 to-red-500 px-4 py-2 text-sm font-medium text-white shadow-lg hover:brightness-110 transition-all"
            >
              {cs.confirmText || t('common.confirm')}
            </button>
          </div>
          <style>{`
            @keyframes fadeIn { from { opacity:0 } to { opacity:1 } }
            @keyframes scaleIn { from { opacity:0; transform:scale(0.96) translateY(8px) } to { opacity:1; transform:scale(1) } }
          `}</style>
        </div>
      </div>
    </div>
  );
}