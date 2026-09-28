import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getMysqlStatus, controlMysql } from '@/api/mysql';
import GlassCard from '@/components/common/GlassCard';
import LiquidButton from '@/components/common/LiquidButton';
import StatusBadge from '@/components/common/StatusBadge';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import { Play, Square, RefreshCw, Database } from '@/components/common/Icons';
import { useUIStore } from '@/components/common/uiStore';

export default function Mysql() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const [data, setData] = useState({ status: 'unknown', info: '', databases: [] });
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  async function fetchData() {
    try {
      const d = await getMysqlStatus();
      setData(d);
    } catch (err) {
      console.error(err);
    }
  }

  useEffect(() => {
    setInitialLoading(true);
    fetchData().finally(() => setInitialLoading(false));
  }, []);

  async function handleControl(action) {
    setLoading(true);
    try {
      await controlMysql(action);
      await fetchData();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  if (initialLoading) return <LoadingState />;

  return (
    <div className="space-y-6">
      <GlassCard>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('mysql.status')}</h2>
            <div className="mt-2">
              <StatusBadge status={data.status} />
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <LiquidButton onClick={() => handleControl('start')} disabled={loading} variant="success">
              <Play className="w-4 h-4" /> {t('common.start')}
            </LiquidButton>
            <LiquidButton onClick={() => handleControl('stop')} disabled={loading} variant="danger">
              <Square className="w-4 h-4" /> {t('common.stop')}
            </LiquidButton>
            <LiquidButton onClick={() => handleControl('restart')} disabled={loading}>
              <RefreshCw className="w-4 h-4" /> {t('common.restart')}
            </LiquidButton>
          </div>
        </div>
        {data.info && (
          <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-white/70 font-mono">
            {data.info}
          </div>
        )}
      </GlassCard>

      <GlassCard>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('mysql.databases')}</h2>
          <span className="text-xs text-white/50">{t('mysql.dbCount', { count: data.databases.length })}</span>
        </div>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {data.databases.map((db) => (
            <div key={db} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-3 hover:bg-white/10 transition-colors">
              <Database className="h-4 w-4 text-cyan-300" />
              <span className="text-sm font-medium truncate">{db}</span>
            </div>
          ))}
          {data.databases.length === 0 && <EmptyState message={t('common.noDatabase')} className="col-span-full" />}
        </div>
      </GlassCard>
    </div>
  );
}