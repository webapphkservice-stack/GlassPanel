import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getRedisStatus, controlRedis } from '@/api/redis';
import GlassCard from '@/components/common/GlassCard';
import LiquidButton from '@/components/common/LiquidButton';
import StatusBadge from '@/components/common/StatusBadge';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import { Play, Square, RefreshCw, Cpu } from '@/components/common/Icons';
import { useUIStore } from '@/components/common/uiStore';

export default function Redis() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const [data, setData] = useState({ status: 'unknown', info: {} });
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  async function fetchData() {
    try {
      const d = await getRedisStatus();
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
      await controlRedis(action);
      await fetchData();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  const importantKeys = ['redis_version', 'used_memory_human', 'connected_clients', 'total_commands_processed'];

  if (initialLoading) return <LoadingState />;

  return (
    <div className="space-y-6">
      <GlassCard>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('redis.status')}</h2>
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
      </GlassCard>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        {importantKeys.map((key) => (
          <GlassCard key={key}>
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-white/50 uppercase">{key}</p>
                <p className="mt-1 text-xl font-bold">{data.info[key] || '-'}</p>
              </div>
              <Cpu className="h-5 w-5 text-cyan-300" />
            </div>
          </GlassCard>
        ))}
      </div>

      <GlassCard>
        <h2 className="mb-4 text-lg font-semibold">{t('redis.fullInfo')}</h2>
        <div className="max-h-96 overflow-auto rounded-xl bg-black/30 p-4 text-xs font-mono text-white/70">
          {Object.entries(data.info).map(([k, v]) => (
            <div key={k} className="py-0.5">
              <span className="text-cyan-300">{k}</span>: <span>{v}</span>
            </div>
          ))}
        </div>
      </GlassCard>
    </div>
  );
}