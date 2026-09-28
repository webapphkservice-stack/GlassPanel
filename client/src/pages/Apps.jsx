import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getApps, getAppVersions, installApp, updateApp, uninstallApp, getAppJob, syncXui, syncXuiLatest } from '@/api/apps';
import { getNginxSites } from '@/api/nginx';
import { getCertificates } from '@/api/ssl';
import GlassCard from '@/components/common/GlassCard';
import LiquidButton from '@/components/common/LiquidButton';
import StatusBadge from '@/components/common/StatusBadge';
import LoadingState from '@/components/common/LoadingState';
import GlassModal from '@/components/common/GlassModal';
import { Globe, Server, Database, Cpu, Activity, Film, Package, Download, Trash, Check, ChevronDown, RefreshCw, Terminal, Shield, Box, ExternalLink, AlertTriangle } from '@/components/common/Icons';
import { useUIStore } from '@/components/common/uiStore';

const iconMap = { Globe, Server, Database, Cpu, Activity, Film, RefreshCw, Shield, Box };

// 需源码编译安装的版本（无二进制包，安装耗时较长）
const LONG_BUILD_VERSIONS = {
  php: ['官方:8.5'],
  redis: ['官方:8.0'],
  ffmpeg: ['官方:9.0.2'],
  fail2ban: ['官方:1.1.0'],
};

// 终端输出轮询间隔
const POLL_INTERVAL = 2000;

export default function Apps() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const uiConfirm = useUIStore((s) => s.confirm);
  const [data, setData] = useState({ pkg: 'unknown', apps: [] });
  const [initialLoading, setInitialLoading] = useState(true);
  const [installOpen, setInstallOpen] = useState(false);
  const [installKey, setInstallKey] = useState('');
  const [installName, setInstallName] = useState('');
  const [versions, setVersions] = useState([]);
  const [version, setVersion] = useState('latest');
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [startingKey, setStartingKey] = useState('');
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [activeKey, setActiveKey] = useState('');
  const [job, setJob] = useState(null);
  const [xuiPort, setXuiPort] = useState('2255');
  const [xuiSource, setXuiSource] = useState('github');
  const [xuiDomain, setXuiDomain] = useState('');
  const [xuiSsl, setXuiSsl] = useState(true);
  const [xuiKnownDomains, setXuiKnownDomains] = useState([]);
  const [xuiCertDomains, setXuiCertDomains] = useState([]);
  const [xuiSyncing, setXuiSyncing] = useState(false);
  const [xuiCached, setXuiCached] = useState([]);

  const logRef = useRef(null);
  // 本次操作是否由当前页面发起（决定结束时是否弹提示）
  const startedRef = useRef(false);
  const notifiedRef = useRef(false);

  async function fetchData() {
    try {
      const d = await getApps();
      setData(d);
    } catch (err) {
      console.error(err);
    }
  }

  useEffect(() => {
    setInitialLoading(true);
    fetchData().finally(() => setInitialLoading(false));
  }, []);

  // 终端输出轮询：任务结束后自动停止
  useEffect(() => {
    if (!terminalOpen || !activeKey) return undefined;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const { job: latest } = await getAppJob(activeKey);
        if (cancelled) return;
        setJob(latest);
        if (!latest.running) clearInterval(timer);
      } catch (err) {
        // 轮询失败不打断页面，等待下一次
      }
    }, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(timer); };
  }, [terminalOpen, activeKey]);

  // 任务结束：刷新列表并提示结果（仅对本页发起的任务提示）
  useEffect(() => {
    if (!job || job.running || !activeKey) return;
    if (!startedRef.current || notifiedRef.current) return;
    notifiedRef.current = true;
    fetchData();
    if (job.exitCode === 0) {
      toast(t('apps.taskComplete', { label: job.label || '' }), 'success');
    } else if (job.exitCode === null || job.exitCode === undefined) {
      toast(t('apps.taskUnknownCode', { label: job.label || '' }), 'error');
    } else {
      toast(t('apps.taskFailed', { label: job.label || '', code: job.exitCode }), 'error');
    }
  }, [job, activeKey]);

  // 有新输出时自动滚动到底部
  useEffect(() => {
    if (terminalOpen && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [job?.log, terminalOpen]);

  async function openInstall(app) {
    setInstallKey(app.key);
    setInstallName(app.name);
    setVersion('latest');
    setInstallOpen(true);
    setVersionsLoading(true);
    setXuiSource('github');
    setXuiDomain('');
    setXuiSsl(true);
    setXuiKnownDomains([]);
    setXuiCertDomains([]);
    setXuiCached([]);
    // 3x-ui：收集面板已有域名（站点 + 证书）供域名选择联想
    if (app.key === '3x-ui') {
      Promise.allSettled([getNginxSites(), getCertificates()])
        .then(([sitesRes, certsRes]) => {
          const siteDomains = (sitesRes.status === 'fulfilled' && sitesRes.value?.sites ? sitesRes.value.sites : [])
            .flatMap((site) => String(site.serverName || '').split(/\s+/))
            .filter((d) => d && d !== '_' && !d.includes('*'));
          const certDomains = (certsRes.status === 'fulfilled' && certsRes.value?.certificates ? certsRes.value.certificates : [])
            .map((cert) => cert.domain)
            .filter(Boolean);
          setXuiKnownDomains([...new Set([...siteDomains, ...certDomains])].sort());
          setXuiCertDomains(certDomains);
        })
        .catch(() => {});
    }
    try {
      const d = await getAppVersions(app.key);
      const list = d.versions || [];
      setVersions(list.length ? list : ['latest']);
      if (list.length) setVersion(list[0]);
      // 3x-ui：记录已缓存的版本
      if (app.key === '3x-ui' && d.cached) {
        setXuiCached(d.cached);
      }
    } catch (err) {
      setVersions(['latest']);
    } finally {
      setVersionsLoading(false);
    }
  }

  // 发起后台任务并打开终端弹窗
  async function launch(request, key) {
    setStartingKey(key);
    try {
      const res = await request;
      startedRef.current = true;
      notifiedRef.current = false;
      setActiveKey(key);
      setJob(res.job);
      setTerminalOpen(true);
      setInstallOpen(false);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setStartingKey('');
    }
  }

  async function handleInstall(e) {
    e.preventDefault();
    const config = installKey === '3x-ui'
      ? { port: xuiPort, source: xuiSource, domain: xuiDomain.trim(), ssl: xuiSsl }
      : {};
    await launch(installApp(installKey, version, config), installKey);
  }

  // 3x-ui 同步缓存：从 GitHub 下载版本包到面板本地（latest 由后端解析为具体版本号）
  async function handleSyncXui(v) {
    setXuiSyncing(true);
    try {
      const res = await syncXui(v);
      const tag = res?.version || v;
      toast(t('apps.xuiSyncSuccess', { version: tag }), 'success');
      setXuiCached((prev) => [...new Set([...prev, tag])]);
    } catch (err) {
      toast(t('apps.xuiSyncFailed', { error: err?.message || String(err) }), 'error');
    } finally {
      setXuiSyncing(false);
    }
  }

  // 3x-ui 一键同步最近 5 个版本到面板缓存
  async function handleSyncXuiLatest() {
    setXuiSyncing(true);
    try {
      const res = await syncXuiLatest();
      const synced = res?.synced || [];
      const failed = res?.failed || [];
      if (synced.length) {
        setXuiCached((prev) => [...new Set([...prev, ...synced])]);
      }
      if (failed.length) {
        toast(t('apps.xuiSyncLatestPartial', { failed: failed.map((f) => f.version).join(', ') }), 'error');
      } else {
        toast(t('apps.xuiSyncLatestSuccess', { count: synced.length }), 'success');
      }
    } catch (err) {
      toast(t('apps.xuiSyncFailed', { error: err?.message || String(err) }), 'error');
    } finally {
      setXuiSyncing(false);
    }
  }

  async function handleUpdate(app) {
    const ok = await uiConfirm({
      title: t('apps.updateConfirm'),
      message: t('apps.updateMsg', { name: app.name, from: app.version, to: app.latestVersion }),
    });
    if (!ok) return;
    await launch(updateApp(app.key), app.key);
  }

  // 系统更新：升级发行版全部软件包（可能包含内核，需重启生效）
  async function handleSystemUpdate(app) {
    const ok = await uiConfirm({
      title: t('apps.systemUpdateConfirm'),
      message: t('apps.systemUpdateMsg', {
        version: app.version,
        countMsg: app.updateCount > 0 ? `（${t('apps.updatesAvailable', { count: app.updateCount })}）` : '',
      }),
    });
    if (!ok) return;
    await launch(updateApp(app.key), app.key);
  }

  async function handleUninstall(key, name) {
    const ok = await uiConfirm({
      title: t('common.pleaseConfirm'),
      message: t('apps.uninstallMsg', { name }),
    });
    if (!ok) return;
    await launch(uninstallApp(key), key);
  }

  // 查看已在后台运行（或已结束）的任务终端
  async function openJob(key) {
    try {
      const { job: latest } = await getAppJob(key);
      startedRef.current = false;
      notifiedRef.current = true;
      setActiveKey(key);
      setJob(latest);
      setTerminalOpen(true);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  if (initialLoading) return <LoadingState />;

  return (
    <div className="space-y-6">
      <GlassCard>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('apps.title')}</h2>
            <p className="mt-1 text-sm text-white/60">{t('apps.desc', { pkg: data.pkg })}</p>
          </div>
        </div>
      </GlassCard>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {data.apps.map((app) => {
          const Icon = iconMap[app.icon] || Package;
          const busy = app.jobRunning || startingKey === app.key;
          return (
            <GlassCard key={app.key}>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="rounded-xl bg-cyan-500/10 p-2 text-cyan-300">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold">{app.name}</h3>
                    <p className="text-xs text-white/50">{app.desc}</p>
                  </div>
                </div>
                {app.systemUpdate ? (
                  <span className={`rounded-full px-2 py-0.5 text-xs ${app.updateAvailable ? 'bg-amber-500/10 text-amber-300' : 'bg-emerald-500/10 text-emerald-300'}`}>
                    {app.updateCount > 0 ? t('apps.updatesAvailable', { count: app.updateCount }) : app.updateCount === 0 ? t('apps.upToDate') : t('apps.checkFailed')}
                  </span>
                ) : app.installed && (
                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300">{t('apps.installed')}</span>
                )}
              </div>
              <div className="mt-4 space-y-2 text-sm text-white/70">
                {app.systemUpdate ? (
                  <div className="flex items-center justify-between">
                    <span>{t('apps.updateStatus')}</span>
                    <span className={app.updateAvailable ? 'text-amber-300' : 'text-emerald-300'}>
                      {app.updateCount > 0 ? t('apps.updatesAvailable', { count: app.updateCount }) : app.updateCount === 0 ? t('apps.upToDate') : t('apps.checkFailed')}
                    </span>
                  </div>
                ) : app.hasService !== false && (
                  <div className="flex items-center justify-between">
                    <span>{t('apps.serviceStatus')}</span>
                    <StatusBadge status={app.status} />
                  </div>
                )}
                {app.version && (
                  <div className="truncate text-xs text-white/50">
                    {app.systemUpdate ? t('apps.system') : t('apps.versionLabel')}{app.version}
                    {app.updateAvailable && !app.systemUpdate && (
                      <span className="ml-1 text-amber-300">{t('apps.updateAvailable', { version: app.latestVersion })}</span>
                    )}
                  </div>
                )}
              </div>
              <div className="mt-4 flex gap-2">
                {busy ? (
                  <div className="flex-1">
                    <LiquidButton onClick={() => openJob(app.key)} variant="ghost" className="w-full justify-center">
                      <Terminal className="w-4 h-4" /> {t('apps.viewProgress')}
                    </LiquidButton>
                  </div>
                ) : app.systemUpdate ? (
                  <LiquidButton onClick={() => handleSystemUpdate(app)} disabled={!!startingKey} className="w-full justify-center">
                    <RefreshCw className="w-4 h-4" /> {t('apps.oneClickUpdate')}
                  </LiquidButton>
                ) : app.installed ? (
                  <>
                    {app.page && (
                      <a href={app.page} className="flex-1">
                        <LiquidButton variant="ghost" className="w-full justify-center"><Package className="w-4 h-4" /> {t('common.manage')}</LiquidButton>
                      </a>
                    )}
                    {app.key === '3x-ui' && app.openUrl && (
                      <a
                        href={app.openUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1"
                      >
                        <LiquidButton variant="ghost" className="w-full justify-center">
                          <ExternalLink className="w-4 h-4" /> {t('apps.openPanel')}
                        </LiquidButton>
                      </a>
                    )}
                    {app.updateAvailable && (
                      <div className="flex-1">
                        <LiquidButton onClick={() => handleUpdate(app)} disabled={!!startingKey} className="w-full justify-center">
                          <RefreshCw className="w-4 h-4" /> {t('common.update')}
                        </LiquidButton>
                      </div>
                    )}
                    <div className="flex-1">
                      <LiquidButton onClick={() => handleUninstall(app.key, app.name)} disabled={!!startingKey} variant="danger" className="w-full justify-center">
                        <Trash className="w-4 h-4" /> {t('common.uninstall')}
                      </LiquidButton>
                    </div>
                  </>
                ) : (
                  <LiquidButton onClick={() => openInstall(app)} disabled={!!startingKey} className="w-full justify-center">
                    <Download className="w-4 h-4" /> {t('common.install')}
                  </LiquidButton>
                )}
              </div>
            </GlassCard>
          );
        })}
      </div>

      {/* 安装：版本选择弹窗 */}
      <GlassModal
        title={t('apps.installTitle', { name: installName })}
        subtitle={t('apps.installSubtitle')}
        open={installOpen}
        onClose={() => setInstallOpen(false)}
      >
        <form onSubmit={handleInstall} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm text-white/70">{t('apps.version')}</label>
            <div className="relative">
              <select
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                disabled={versionsLoading || versions.length <= 1}
                className="w-full appearance-none rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 pr-10 text-sm outline-none focus:border-cyan-400 disabled:opacity-50"
              >
                {versions.map((v) => {
                  const isOfficial = v.startsWith('官方:');
                  const label = isOfficial ? t('apps.officialSource', { version: v.slice(3) }) : v;
                  return (
                    <option key={v} value={v} className="bg-gray-900 text-white">
                      {v === 'latest' ? t('apps.followRepo') : label}
                    </option>
                  );
                })}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
            </div>
            {versionsLoading && <p className="mt-2 text-xs text-white/50">{t('apps.fetchingVersions')}</p>}
            {!versionsLoading && versions.length <= 1 && (
              <p className="mt-2 text-xs text-white/50">{t('apps.onlyDefaultVersion')}</p>
            )}
          </div>
          {installKey === '3x-ui' && (
            <div>
              <label className="mb-1.5 block text-sm text-white/70">{t('apps.xuiPort')}</label>
              <input
                type="number"
                value={xuiPort}
                onChange={(e) => setXuiPort(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm outline-none focus:border-cyan-400"
                placeholder="2255"
              />
              <p className="mt-1 text-xs text-white/40">{t('apps.xuiPortHint')}</p>
            </div>
          )}
          {installKey === '3x-ui' && (
            <div>
              <label className="mb-1.5 block text-sm text-white/70">{t('apps.xuiSource')}</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setXuiSource('github')}
                  className={`flex-1 rounded-xl border px-4 py-2.5 text-sm transition-all ${
                    xuiSource === 'github'
                      ? 'border-cyan-400 bg-cyan-500/10 text-cyan-200'
                      : 'border-white/10 bg-white/5 text-white/50 hover:border-white/20'
                  }`}
                >
                  GitHub {t('apps.xuiSourceGithub')}
                </button>
                <button
                  type="button"
                  onClick={() => setXuiSource('panel')}
                  className={`flex-1 rounded-xl border px-4 py-2.5 text-sm transition-all ${
                    xuiSource === 'panel'
                      ? 'border-cyan-400 bg-cyan-500/10 text-cyan-200'
                      : 'border-white/10 bg-white/5 text-white/50 hover:border-white/20'
                  }`}
                >
                  {t('apps.xuiSourcePanel')}
                </button>
              </div>
              <p className="mt-1 text-xs text-white/40">
                {xuiSource === 'github' ? t('apps.xuiSourceGithubHint') : t('apps.xuiSourcePanelHint')}
              </p>
              {xuiSource === 'panel' && version !== 'latest' && !xuiCached.includes(version) && (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2">
                  <AlertTriangle className="h-4 w-4 flex-none text-amber-300" />
                  <span className="text-xs text-amber-200">{t('apps.xuiNotCached')}</span>
                  <button
                    type="button"
                    onClick={() => handleSyncXui(version)}
                    disabled={xuiSyncing}
                    className="ml-auto flex-none rounded-lg bg-amber-500/20 px-3 py-1 text-xs text-amber-200 hover:bg-amber-500/30 disabled:opacity-50"
                  >
                    {xuiSyncing ? t('apps.xuiSyncing') : t('apps.xuiSyncCache')}
                  </button>
                </div>
              )}
              {xuiSource === 'panel' && version !== 'latest' && xuiCached.includes(version) && (
                <div className="mt-2 flex items-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-500/10 px-3 py-2">
                  <p className="text-xs text-emerald-300">{t('apps.xuiCached')}</p>
                  <button
                    type="button"
                    onClick={() => handleSyncXui(version)}
                    disabled={xuiSyncing}
                    className="ml-auto flex-none rounded-lg bg-emerald-500/20 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
                  >
                    {xuiSyncing ? t('apps.xuiSyncing') : t('apps.xuiResync')}
                  </button>
                </div>
              )}
              {xuiSource === 'panel' && version === 'latest' && (
                <div className="mt-2 flex items-center gap-2 rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2">
                  <AlertTriangle className="h-4 w-4 flex-none text-amber-300" />
                  <span className="text-xs text-amber-200">{t('apps.xuiLatestHint')}</span>
                  <button
                    type="button"
                    onClick={() => handleSyncXui('latest')}
                    disabled={xuiSyncing}
                    className="ml-auto flex-none rounded-lg bg-amber-500/20 px-3 py-1 text-xs text-amber-200 hover:bg-amber-500/30 disabled:opacity-50"
                  >
                    {xuiSyncing ? t('apps.xuiSyncing') : t('apps.xuiSyncCache')}
                  </button>
                </div>
              )}
              {xuiSource === 'panel' && (
                <div className="mt-3 flex items-center gap-3 rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-3 py-2">
                  <button
                    type="button"
                    onClick={handleSyncXuiLatest}
                    disabled={xuiSyncing}
                    className="flex-none rounded-lg bg-cyan-500/20 px-3 py-1 text-xs text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-50"
                  >
                    {xuiSyncing ? t('apps.xuiSyncing') : t('apps.xuiSyncRecent')}
                  </button>
                  <span className="text-xs text-white/40">{t('apps.xuiSyncRecentHint')}</span>
                </div>
              )}
            </div>
          )}
          {installKey === '3x-ui' && (
            <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4">
              <div>
                <label className="mb-1.5 block text-sm text-white/70">{t('apps.xuiDomain')}</label>
                <input
                  type="text"
                  list="xui-known-domains"
                  value={xuiDomain}
                  onChange={(e) => setXuiDomain(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm outline-none focus:border-cyan-400"
                  placeholder="xui.example.com"
                />
                <datalist id="xui-known-domains">
                  {xuiKnownDomains.map((d) => <option key={d} value={d} />)}
                </datalist>
                <p className="mt-1 text-xs text-white/40">{t('apps.xuiDomainHint')}</p>
                {!!xuiDomain && xuiCertDomains.includes(xuiDomain.trim()) && (
                  <p className="mt-1 text-xs text-emerald-300">{t('apps.xuiCertReuse')}</p>
                )}
                {!!xuiDomain && !xuiCertDomains.includes(xuiDomain.trim()) && xuiSsl && (
                  <p className="mt-1 text-xs text-amber-200">{t('apps.xuiCertNew')}</p>
                )}
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-white/70">
                <input
                  type="checkbox"
                  checked={xuiSsl}
                  onChange={(e) => setXuiSsl(e.target.checked)}
                  className="h-4 w-4 accent-cyan-400"
                />
                {t('apps.xuiSsl')}
              </label>
            </div>
          )}
          <div className="flex items-start gap-3 rounded-xl border border-cyan-400/20 bg-cyan-500/10 p-4">
            <Terminal className="mt-0.5 h-4 w-4 flex-none text-cyan-300" />
            <div className="text-sm">
              <p className="text-cyan-100">{t('apps.backgroundInstall')}</p>
              <p className="mt-1 text-xs text-white/50">
                {(LONG_BUILD_VERSIONS[installKey] || []).includes(version)
                  ? t('common.compileHint')
                  : t('common.downloadHint')}
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <LiquidButton type="button" onClick={() => setInstallOpen(false)} variant="ghost">{t('common.cancel')}</LiquidButton>
            <LiquidButton type="submit" disabled={versionsLoading || !!startingKey}>
              {startingKey ? t('apps.starting') : (<><Download className="w-4 h-4" /> {t('apps.startInstall')}</>)}
            </LiquidButton>
          </div>
        </form>
      </GlassModal>

      {/* 执行终端：实时显示安装/更新/卸载过程 */}
      <GlassModal
        title={job?.label ? t('apps.terminalTitle', { label: job.label }) : t('apps.terminalDefaultTitle')}
        subtitle={t('common.backgroundHint')}
        open={terminalOpen}
        onClose={() => setTerminalOpen(false)}
      >
        <div className="mb-3 flex items-center gap-3 text-sm">
          {job?.running ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-cyan-300/30 border-t-cyan-300" />
              <span className="text-cyan-200">{t('common.executing')}</span>
            </>
          ) : job ? (
            job.exitCode === 0
              ? <span className="text-emerald-300">{t('common.execComplete')}</span>
              : job.exitCode === null || job.exitCode === undefined
                ? <span className="text-amber-300">{t('common.execUnknownCode')}</span>
                : <span className="text-rose-300">{t('common.execFailed', { code: job.exitCode })}</span>
          ) : null}
        </div>
        <div
          ref={logRef}
          className="max-h-96 overflow-auto rounded-xl border border-white/10 bg-black/60 p-4 font-mono text-xs leading-relaxed text-emerald-200 whitespace-pre-wrap break-all"
        >
          {job?.log || t('common.waitingOutput')}
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-xs text-white/40">
            {job?.running ? t('common.closeAndCheck') : ''}
          </p>
          <LiquidButton onClick={() => setTerminalOpen(false)}>
            <Check className="w-4 h-4" /> {t('common.close')}
          </LiquidButton>
        </div>
      </GlassModal>
    </div>
  );
}