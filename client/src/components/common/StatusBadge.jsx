import React from 'react';
import { useTranslation } from 'react-i18next';

export default function StatusBadge({ status }) {
  const { t } = useTranslation();
  const normalized = String(status || 'unknown').toLowerCase();
  const isActive = ['active', 'running', 'enabled', 'true', 'online'].includes(normalized);
  const isInactive = ['inactive', 'stopped', 'disabled', 'false', 'offline', 'dead'].includes(normalized);

  let colorClass = 'bg-white/10 text-white/70';
  if (isActive) colorClass = 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30';
  if (isInactive) colorClass = 'bg-rose-500/20 text-rose-300 border-rose-500/30';

  return (
    <span
      className={`
        inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium
        ${colorClass}
      `}
    >
      <span
        className={`
          mr-2 h-2 w-2 rounded-full
          ${isActive ? 'bg-emerald-400 animate-pulse' : isInactive ? 'bg-rose-400' : 'bg-white/50'}
        `}
      />
      {status || t('common.unknown')}
    </span>
  );
}