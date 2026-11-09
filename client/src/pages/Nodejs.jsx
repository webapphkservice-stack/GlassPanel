import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getNodejsOverview, setNodejsCurrent, removeNodejsVersion } from '@/api/nodejs';
import { getAppVersions, installApp, getAppJob } from '@/api/apps';
import GlassCard from '@/components/common/GlassCard';
import GlassModal from '@/components/common/GlassModal';
import LiquidButton from '@/components/common/LiquidButton';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import { Box, RefreshCw, Download, Check, Trash2, Copy, Terminal } from '@/components/common/Icons';
import { useUIStore } from '@/components/common/uiStore';

// 面板托管的 Node.js 运行时管理：查看版本、切换 current、删除旧版本、安装新版本
export default function Nodejs() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const uiConfirm = useUIStore((s) => s.confirm);
  const [data, setData] = useState({ current: '', versions: [], stablePath: '', systemNode: '' });
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState('');
  const [installOpen, setInstallOpen] = useState(false);
  const [installVersions, setInstallVersions] = useState([]);
  const [installVersion, setInstallVersion] = useState('');
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [job, setJob] = useState(null);
  const pollRef = useRef(null);
  const logRef = useRef(null);

  async function fetchData(showSpinner) {
    if (showSpinner) setRefreshing(true);
    try {
      const d = await getNodejsOverview();
      setData(d);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    fetchData(false).finally(() => setInitialLoading(false));
    return () => clearTimeout(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.log]);

  async function pollJob() {
    try {
      const { job: j } = await getAppJob('nodejs');
      setJob({
        label: j.label || '',
        running: !!j.running,
        exitCode: j.exitCode,
        log: j.log || '',
      });
      if (j.running) {
        pollRef.current = setTimeout(pollJob, 2000);
        return;
      }
      await fetchData(false);
      if (j.exitCode === 0) toast(t('nodejs.installDone'), 'success');
      else toast(t('nodejs.installFailed', { code: j.exitCode }), 'error');
    } catch (err) {
      pollRef.current = setTimeout(pollJob, 3000);
    }
  }

  async function openInstall() {
    setInstallOpen(true);
    setInstallVersion('');
    setVersionsLoading(true);
    try {
      const result = await getAppVersions('nodejs');
      const list = result.versions || [];
      setInstallVersions(list);
      if (list.length) setInstallVersion(list[0]);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setVersionsLoading(false);
    }
  }

  async function handleInstall() {
    if (!installVersion) return;
    setInstalling(true);
    try {
      const { job: started } = await installApp('nodejs', installVersion, {});
      setInstallOpen(false);
      setJob({ label: started.label || '', running: true, exitCode: null, log: '' });
      pollJob();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setInstalling(false);
    }
  }

  async function handleSwitch(version) {
    setBusy(version);
    try {
      const next = await setNodejsCurrent(version);
      setData(next);
      toast(t('nodejs.switched', { version }), 'success');
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setBusy('');
    }
  }

  async function handleRemove(version) {
    const ok = await uiConfirm({
      title: t('nodejs.removeTitle'),
      message: t('nodejs.removeConfirm', { version }),
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    setBusy(version);
    try {
      const next = await removeNodejsVersion(version);
      setData(next);
      toast(t('nodejs.removeDone', { version }), 'success');
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setBusy('');
    }
  }

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(data.stablePath);
      toast(t('nodejs.copied'), 'success');
    } catch (err) {
      toast(t('nodejs.copyFailed'), 'error');
    }
  }

  if (initialLoading) return <LoadingState />;

  return (
    <div className="space-y-6">
      <GlassCard>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 flex-none items-center justify-center rounded-2xl border border-emerald-400/25 bg-emerald-500/10">
              <Box className="h-6 w-6 text-emerald-300" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">{t('nodejs.title')}</h2>
              <p className="mt-1 text-sm text-white/50">{t('nodejs.subtitle')}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/60">
                  {t('nodejs.current')}
                </span>
                <span className="text-xl font-bold text-emerald-300">
                  {data.current ? `v${data.current}` : '—'}
                </span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <LiquidButton variant="ghost" onClick={() => fetchData(true)} disabled={refreshing}>
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> {t('common.refresh')}
            </LiquidButton>
            <LiquidButton onClick={openInstall}>
              <Download className="h-4 w-4" /> {t('nodejs.install')}
            </LiquidButton>
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
            <p className="text-xs text-white/45">{t('nodejs.stablePath')}</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="truncate font-mono text-sm text-cyan-300">{data.stablePath}</code>
              {data.current && (
                <button
                  type="button"
                  onClick={copyPath}
                  className="flex-none rounded-lg p-1 text-white/40 hover:bg-white/10 hover:text-white"
                  title={t('nodejs.copy')}
                >
                  <Copy className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
            <p className="text-xs text-white/45">{t('nodejs.systemNode')}</p>
            <p className="mt-1 font-mono text-sm text-white/70">
              {data.systemNode ? `v${data.systemNode}` : '—'}
            </p>
            <p className="mt-1 text-[11px] text-white/35">{t('nodejs.systemNodeHint')}</p>
          </div>
        </div>
      </GlassCard>

      <GlassCard>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{t('nodejs.versions')}</h2>
          <span className="text-xs text-white/40">{t('nodejs.count', { count: data.versions.length })}</span>
        </div>

        {data.versions.length === 0 ? (
          <EmptyState message={t('nodejs.noVersionsHint')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] table-fixed text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs text-white/45">
                  <th className="w-32 px-3 py-2 font-medium">{t('nodejs.version')}</th>
                  <th className="w-28 px-3 py-2 font-medium">{t('nodejs.nodeVersion')}</th>
                  <th className="w-24 px-3 py-2 font-medium">{t('nodejs.npmVersion')}</th>
                  <th className="w-20 px-3 py-2 font-medium">{t('nodejs.size')}</th>
                  <th className="w-44 px-3 py-2 font-medium">{t('nodejs.installedAt')}</th>
                  <th className="w-20 px-3 py-2 font-medium">{t('nodejs.status')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('nodejs.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {data.versions.map((item) => (
                  <tr key={item.version} className="border-b border-white/[0.06] last:border-0">
                    <td className="px-3 py-3 font-mono text-white/85">v{item.version}</td>
                    <td className="px-3 py-3 font-mono text-white/60">{item.node ? `v${item.node}` : '—'}</td>
                    <td className="px-3 py-3 font-mono text-white/60">{item.npm || '—'}</td>
                    <td className="px-3 py-3 text-white/60">{item.size || '—'}</td>
                    <td className="px-3 py-3 text-xs text-white/50">
                      {item.installedAt ? new Date(item.installedAt).toLocaleString() : '—'}
                    </td>
                    <td className="px-3 py-3">
                      {item.current ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300">
                          <Check className="h-3 w-3" /> {t('nodejs.inUse')}
                        </span>
                      ) : (
                        <span className="text-[11px] text-white/35">{t('nodejs.idle')}</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex justify-end gap-2">
                        {!item.current && (
                          <button
                            type="button"
                            onClick={() => handleSwitch(item.version)}
                            disabled={!!busy}
                            className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[11px] text-cyan-300 transition-colors hover:bg-cyan-500/20 disabled:opacity-50"
                          >
                            {t('nodejs.switchTo')}
                          </button>
                        )}
                        {!item.current && (
                          <button
                            type="button"
                            onClick={() => handleRemove(item.version)}
                            disabled={!!busy}
                            className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-[11px] text-rose-300 transition-colors hover:bg-rose-500/20 disabled:opacity-50"
                          >
                            <Trash2 className="mr-1 inline h-3 w-3" />
                            {t('common.delete')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      <GlassModal
        title={t('nodejs.installTitle')}
        subtitle={t('nodejs.installSubtitle')}
        open={installOpen}
        onClose={() => setInstallOpen(false)}
        maxWidth="max-w-lg"
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-white/70">{t('nodejs.installVersion')}</label>
            {versionsLoading ? (
              <p className="text-sm text-white/50">{t('common.loading')}</p>
            ) : (
              <select
                value={installVersion}
                onChange={(e) => setInstallVersion(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-[#0f1526] px-4 py-2 text-sm outline-none focus:border-cyan-400"
              >
                {installVersions.map((v) => (
                  <option key={v} value={v}>
                    {v.replace(/^官方:/, 'v')}
                  </option>
                ))}
              </select>
            )}
            <p className="mt-2 text-xs text-white/40">{t('nodejs.installHint')}</p>
          </div>
          <div className="flex justify-end gap-3">
            <LiquidButton variant="ghost" onClick={() => setInstallOpen(false)}>
              {t('common.cancel')}
            </LiquidButton>
            <LiquidButton onClick={handleInstall} disabled={installing || versionsLoading || !installVersion}>
              {installing ? t('nodejs.installing') : t('nodejs.startInstall')}
            </LiquidButton>
          </div>
        </div>
      </GlassModal>

      <GlassModal
        title={t('nodejs.jobTitle')}
        subtitle={job?.label}
        open={!!job}
        onClose={() => setJob(null)}
        maxWidth="max-w-3xl"
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            {job?.running ? (
              <span className="text-cyan-300">{t('nodejs.jobRunning')}</span>
            ) : job?.exitCode === 0 ? (
              <span className="text-emerald-300">{t('nodejs.installDone')}</span>
            ) : (
              <span className="text-rose-300">{t('nodejs.installFailed', { code: job?.exitCode })}</span>
            )}
          </div>
          <pre
            ref={logRef}
            className="max-h-[50vh] overflow-auto rounded-xl bg-black/40 p-4 text-xs font-mono text-white/70"
          >
            {job?.log || t('common.waitingOutput')}
          </pre>
          <div className="flex justify-end">
            <LiquidButton variant="ghost" onClick={() => setJob(null)}>
              {t('common.close')}
            </LiquidButton>
          </div>
        </div>
      </GlassModal>
    </div>
  );
}
