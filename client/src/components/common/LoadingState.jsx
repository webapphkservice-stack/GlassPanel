import React from 'react';
import { useTranslation } from 'react-i18next';
import { Activity } from './Icons';

export default function LoadingState({ message }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-96 items-center justify-center text-white/60">
      <Activity className="mr-2 h-5 w-5 animate-spin" />
      {message || t('common.loading')}
    </div>
  );
}