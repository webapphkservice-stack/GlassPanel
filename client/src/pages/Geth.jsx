import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getGethOverview, getGethLogs, controlGethService } from '@/api/geth';
import GlassCard from '@/components/common/GlassCard';
import LiquidButton from '@/components/common/LiquidButton';
import StatusBadge from '@/components/common/StatusBadge';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import {
  Network, Play, Square, RefreshCw, FileText,
} from '@/components/common/Icons';
import { useUIStore } from '@/components/common/uiStore';

// Geth 节点管理：状态总览、服务启停、链上运行数据与最近日志
export default function Geth() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const uiConfirm = useUIStore((s) => s.confirm);
  const [data, setData] = useState(null);
  const [logs, setLogs] = useState('');
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const logRef = useRef(null);

  async function fetchData(manual = true) {
    if (manual) setRefreshing(true);
    try {
      const next = await getGethOverview();
      setData(next);
    } catch (err) {
      if (manual) toast(err?.message || String(err), 'error');
    } finally {
      if (manual) setRefreshing(false);
    }
  }

  async function fetchLogs(manual = true) {
    setLogsLoading(true);
    try {
      const result = await getGethLogs(200);
      setLogs(result.logs || '');
    } catch (err) {
      if (manual) toast(err?.message || String(err), 'error');
    } finally {
      setLogsLoading(false);
    }
  }

  useEffect(() => {
    fetchData(false).finally(() => setInitialLoading(false));
    fetchLogs(false);
    // 运行数据定时刷新（页面隐藏时跳过），日志保持手动刷新避免打断阅读
    const timer = setInterval(() => {
      if (!document.hidden) fetchData(false);
    }, 10000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  async function handleControl(action) {
    if (action === 'stop') {
      const ok = await uiConfirm({
        title: t('geth.stopTitle'),
        message: t('geth.stopConfirm'),
        confirmText: t('common.stop'),
      });
      if (!ok) return;
    }
    if (action === 'restart') {
      const ok = await uiConfirm({
        title: t('geth.restartTitle'),
        message: t('geth.restartConfirm'),
        confirmText: t('common.restart'),
      });
      if (!ok) return;
    }
    setBusy(action);
    try {
      const next = await controlGethService(action);
      setData(next);
      toast(t(`geth.${action}Done`), 'success');
      fetchLogs(false);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setBusy('');
    }
  }

  if (initialLoading || !data) return <LoadingState />;

  if (!data.installed) {
    return (
      <div className="space-y-6">
        <GlassCard>
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 flex-none items-center justify-center rounded-2xl border border-cyan-400/25 bg-cyan-500/10">
              <Network className="h-6 w-6 text-cyan-300" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">{t('geth.title')}</h2>
              <p className="mt-1 text-sm text-white/50">{t('geth.subtitle')}</p>
            </div>
          </div>
        </GlassCard>
        <GlassCard>
          <EmptyState message={t('geth.notInstalled')} />
          <p className="-mt-6 pb-8 text-center text-sm text-white/40">{t('geth.notInstalledHint')}</p>
          <div className="flex justify-center pb-4">
            <LiquidButton variant="ghost" onClick={() => fetchData(true)} disabled={refreshing}>
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> {t('common.refresh')}
            </LiquidButton>
          </div>
        </GlassCard>
      </div>
    );
  }

  const running = data.status === 'active';
  const stats = [
    { label: t('geth.blockNumber'), value: data.blockNumber ?? '—', mono: true },
    { label: t('geth.chainId'), value: data.chainId ?? '—', mono: true },
    { label: t('geth.networkId'), value: data.networkId || '—', mono: true },
    { label: t('geth.peerCount'), value: data.peerCount ?? '—', mono: true },
    { label: t('geth.datadirSize'), value: data.datadirSize || '—', mono: false },
    { label: t('geth.startedAt'), value: data.startedAt || '—', mono: false },
  ];

  return (
    <div className="space-y-6">
      <GlassCard>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 flex-none items-center justify-center rounded-2xl border border-cyan-400/25 bg-cyan-500/10">
              <Network className="h-6 w-6 text-cyan-300" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">{t('geth.title')}</h2>
              <p className="mt-1 text-sm text-white/50">{t('geth.subtitle')}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <StatusBadge status={data.status} />
                {data.version && (
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/60">
                    v{data.version}
                  </span>
                )}
                {data.serviceExists && (
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/60">
                    geth.service
                  </span>
                )}
                <span className={`inline-flex items-center gap-1.5 text-xs ${data.rpcOk ? 'text-emerald-300' : 'text-amber-300'}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${data.rpcOk ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  {data.rpcOk ? t('geth.rpcOk') : t('geth.rpcDown')}
                </span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <LiquidButton variant="ghost" onClick={() => fetchData(true)} disabled={refreshing || !!busy}>
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> {t('common.refresh')}
            </LiquidButton>
            <LiquidButton
              variant="success"
              onClick={() => handleControl('start')}
              disabled={running || !!busy}
            >
              <Play className="h-4 w-4" /> {t('common.start')}
            </LiquidButton>
            <LiquidButton
              variant="danger"
              onClick={() => handleControl('stop')}
              disabled={!running || !!busy}
            >
              <Square className="h-4 w-4" /> {t('common.stop')}
            </LiquidButton>
            <LiquidButton onClick={() => handleControl('restart')} disabled={!!busy}>
              <RefreshCw className="h-4 w-4" /> {t('common.restart')}
            </LiquidButton>
          </div>
        </div>
      </GlassCard>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {stats.map((item) => (
          <GlassCard key={item.label}>
            <p className="text-xs text-white/45">{item.label}</p>
            <p className={`mt-2 truncate text-xl font-bold text-white/85 ${item.mono ? 'font-mono' : ''}`}>
              {item.value}
            </p>
          </GlassCard>
        ))}
      </div>

      <GlassCard>
        <h2 className="mb-4 text-lg font-semibold">{t('geth.nodeInfo')}</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
            <p className="text-xs text-white/45">{t('geth.rpc')}</p>
            <p className="mt-1 font-mono text-sm text-cyan-300">
              http://{data.httpAddr}:{data.httpPort}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
            <p className="text-xs text-white/45">{t('geth.datadir')}</p>
            <p className="mt-1 truncate font-mono text-sm text-white/70">{data.datadir || '—'}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
            <p className="text-xs text-white/45">{t('geth.mining')}</p>
            <p className="mt-1 text-sm text-white/70">
              {data.mining === null ? '—' : data.mining ? t('geth.miningOn') : t('geth.miningOff')}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
            <p className="text-xs text-white/45">{t('geth.syncing')}</p>
            <p className="mt-1 text-sm text-white/70">
              {data.syncing === null ? '—' : data.syncing === false ? t('geth.synced') : t('geth.syncingNow')}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
            <p className="text-xs text-white/45">{t('geth.timer')}</p>
            {data.timer?.exists ? (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <StatusBadge status={data.timer.active} />
                <span className="text-xs text-white/50">
                  {data.timer.enabled === 'enabled' ? t('geth.timerEnabled') : t('geth.timerDisabled')}
                </span>
              </div>
            ) : (
              <p className="mt-1 text-sm text-white/40">{t('geth.timerMissing')}</p>
            )}
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
            <p className="text-xs text-white/45">{t('geth.clientVersion')}</p>
            <p className="mt-1 truncate font-mono text-sm text-white/70">{data.clientVersion || '—'}</p>
          </div>
        </div>
        <div className="mt-3 rounded-2xl border border-white/10 bg-black/30 px-4 py-3">
          <p className="text-xs text-white/45">{t('geth.execStart')}</p>
          <code className="mt-1 block break-all font-mono text-xs leading-relaxed text-cyan-300/80">
            {data.execStart || '—'}
          </code>
        </div>
      </GlassCard>

      <GlassCard>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-white/50" />
            <h2 className="text-lg font-semibold">{t('geth.logs')}</h2>
          </div>
          <LiquidButton variant="ghost" onClick={() => fetchLogs(true)} disabled={logsLoading}>
            <RefreshCw className={`h-4 w-4 ${logsLoading ? 'animate-spin' : ''}`} /> {t('geth.refreshLogs')}
          </LiquidButton>
        </div>
        <div
          ref={logRef}
          className="max-h-96 overflow-auto rounded-xl bg-black/30 p-4 font-mono text-xs leading-relaxed text-white/70"
        >
          {logs ? (
            <pre className="whitespace-pre-wrap break-all">{logs}</pre>
          ) : (
            <p className="py-6 text-center text-white/40">{t('geth.noLogs')}</p>
          )}
        </div>
      </GlassCard>
    </div>
  );
}
