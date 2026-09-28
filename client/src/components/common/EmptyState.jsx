import React from 'react';
import { useTranslation } from 'react-i18next';
import { Activity } from './Icons';

export default function EmptyState({ message, className = '' }) {
  const { t } = useTranslation();
  return (
    <div className={`flex flex-col items-center justify-center py-12 text-white/50 ${className}`}>
      <Activity className="mb-2 h-6 w-6 opacity-60" />
      <span className="text-sm">{message || t('common.noData')}</span>
    </div>
  );
}