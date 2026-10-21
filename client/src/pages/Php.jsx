import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getPhpStatus, controlPhp, uninstallPhpVersion,
  getPhpSettings, savePhpSettings,
  getPhpExtensions, installPhpExtension, uninstallPhpExtension, getPhpJob,
  getPhpLogs, clearPhpLogs, setPhpSlowlog,
} from '@/api/php';
import { installApp, getAppVersions } from '@/api/apps';
import GlassCard from '@/components/common/GlassCard';
import LiquidButton from '@/components/common/LiquidButton';
import StatusBadge from '@/components/common/StatusBadge';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import GlassModal from '@/components/common/GlassModal';
import {
  Play, Square, RefreshCw, Server, Check, Package, Trash, Lock, FileText, Terminal, Download,
} from '@/components/common/Icons';
import { useUIStore } from '@/components/common/uiStore';

const POLL_INTERVAL = 2000;

const TABS = [
  { key: 'versions', labelKey: 'php.versionManagement' },
  { key: 'ext', labelKey: 'php.installExt' },
  { key: 'upload', labelKey: 'php.uploadLimit' },
  { key: 'disabled', labelKey: 'php.disabledFunctions' },
  { key: 'config', labelKey: 'php.configEdit' },
  { key: 'logs', labelKey: 'php.logs' },
];

const UPLOAD_PRESETS = ['2M', '8M', '16M', '32M', '64M', '128M', '256M'];
const UPLOAD_FIELDS = [
  { key: 'upload_max_filesize', labelKey: 'php.uploadMaxFilesize' },
  { key: 'post_max_size', labelKey: 'php.postMaxSize' },
  { key: 'memory_limit', labelKey: 'php.memoryLimit' },
];
const DISABLE_PRESETS = [
  'exec', 'shell_exec', 'system', 'passthru', 'proc_open', 'popen',
  'pcntl_exec', 'eval', 'assert', 'phpinfo', 'putenv', 'symlink',
];
const CONFIG_FIELDS = [
  { key: 'memory_limit', labelKey: 'php.memoryLimitLabel', hint: '如 128M' },
  { key: 'max_execution_time', labelKey: 'php.maxExecTime', hint: '秒，如 30' },
  { key: 'max_input_time', labelKey: 'php.maxInputTime', hint: '秒，如 60' },
  { key: 'max_input_vars', labelKey: 'php.maxInputVars', hint: '如 1000' },
  { key: 'display_errors', labelKey: 'php.displayErrors', hint: 'On / Off' },
  { key: 'error_reporting', labelKey: 'php.errorReporting', hint: '如 E_ALL & ~E_DEPRECATED' },
  { key: 'date.timezone', labelKey: 'php.timezone', hint: '如 Asia/Shanghai' },
  { key: 'default_charset', labelKey: 'php.defaultCharset', hint: '如 UTF-8' },
  { key: 'expose_php', labelKey: 'php.exposePhp', hint: 'On / Off' },
  { key: 'allow_url_fopen', labelKey: 'php.allowUrlFopen', hint: 'On / Off' },
  { key: 'file_uploads', labelKey: 'php.allowFileUpload', hint: 'On / Off' },
  { key: 'max_file_uploads', labelKey: 'php.maxFileUploads', hint: '如 20' },
  { key: 'opcache.enable', labelKey: 'php.opcacheEnable', hint: '1 开启 / 0 关闭' },
  { key: 'opcache.memory_consumption', labelKey: 'php.opcacheMemory', hint: 'MB，如 128' },
];

const inputCls =
  'rounded-lg border border-white/10 bg-gray-900/60 px-3 py-2 text-sm text-white/90 outline-none focus:border-cyan-300/50';
const chipCls =
  'rounded-full border px-3 py-1 text-xs transition-colors';

// 解析 2M / 512K / 1G 为字节数，用于校验 post_max_size 与 upload_max_filesize 的大小关系
function sizeToBytes(v) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([KMG]?)B?\s*$/i.exec(String(v));
  if (!m) return null;
  const unit = (m[2] || '').toUpperCase();
  const mul = unit === 'G' ? 1024 ** 3 : unit === 'M' ? 1024 ** 2 : unit === 'K' ? 1024 : 1;
  return parseFloat(m[1]) * mul;
}

export default function Php() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const uiConfirm = useUIStore((s) => s.confirm);

  const [data, setData] = useState({ status: 'unknown', versions: [], defaultVersion: '' });
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('versions');
  const [version, setVersion] = useState('');

  // 配置（上传限制 / 禁用函数 / 配置修改 共用）
  const [settings, setSettings] = useState(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadForm, setUploadForm] = useState({});
  const [disableText, setDisableText] = useState('');
  const [configForm, setConfigForm] = useState({});

  // 扩展
  const [extData, setExtData] = useState(null);
  const [extLoading, setExtLoading] = useState(false);

  // 日志
  const [logType, setLogType] = useState('error');
  const [logLines, setLogLines] = useState(200);
  const [logData, setLogData] = useState(null);
  const [logLoading, setLogLoading] = useState(false);
  const [slowForm, setSlowForm] = useState({ enabled: false, timeout: 5 });
  const [slowSaving, setSlowSaving] = useState(false);

  // 扩展安装终端
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [jobKey, setJobKey] = useState('');
  const [job, setJob] = useState(null);
  // 是否正在跟踪一个扩展安装任务（用于持续刷新列表，保住「查看进度」入口）
  const [watchingJob, setWatchingJob] = useState(false);
  // 安装其他版本（从应用中心移入本页）
  const [installOpen, setInstallOpen] = useState(false);
  const [installVersions, setInstallVersions] = useState([]);
  const [installVersion, setInstallVersion] = useState('');
  const [installVersionsLoading, setInstallVersionsLoading] = useState(false);
  const [installStarting, setInstallStarting] = useState(false);
  const logRef = useRef(null);
  const startedRef = useRef(false);
  const notifiedRef = useRef(false);

  async function fetchData() {
    try {
      const d = await getPhpStatus();
      setData(d);
      return d;
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  useEffect(() => {
    setInitialLoading(true);
    fetchData()
      .then((d) => {
        if (d && d.versions.length && !version) setVersion(d.versions[0].version);
      })
      .finally(() => setInitialLoading(false));
  }, []);

  // 切页签 / 换版本时按需加载数据
  useEffect(() => {
    if (!version || activeTab === 'versions') return;
    loadSettings(version);
    if (activeTab === 'ext') loadExtensions(version);
    if (activeTab === 'logs') loadLogs(version, logType, logLines);
  }, [version, activeTab]);

  async function handleControl(action, v = '') {
    setLoading(true);
    try {
      const result = await controlPhp(action, v);
      if (result && result.success === false) {
        toast(`操作失败：${result.output?.stderr || result.output?.stdout || '未知错误'}`, 'error');
      }
      setTimeout(fetchData, 600);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function loadSettings(v = version) {
    if (!v) return;
    setSettingsLoading(true);
    try {
      const d = await getPhpSettings(v);
      setSettings(d);
      setUploadForm({
        upload_max_filesize: d.settings.upload_max_filesize || '',
        post_max_size: d.settings.post_max_size || '',
        memory_limit: d.settings.memory_limit || '',
      });
      setDisableText(
        (d.settings.disable_functions || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .join('\n'),
      );
      const cf = {};
      CONFIG_FIELDS.forEach((f) => { cf[f.key] = d.settings[f.key] || ''; });
      setConfigForm(cf);
      setSlowForm({ enabled: !!d.slowlog?.enabled, timeout: d.slowlog?.timeout || 5 });
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setSettingsLoading(false);
    }
  }

  async function loadExtensions(v = version) {
    if (!v) return;
    setExtLoading(true);
    try {
      setExtData(await getPhpExtensions(v));
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setExtLoading(false);
    }
  }

  async function loadLogs(v = version, type = logType, lines = logLines) {
    if (!v) return;
    setLogLoading(true);
    try {
      setLogData(await getPhpLogs(v, type, lines));
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLogLoading(false);
    }
  }

  async function applySettings(patch, okMessage) {
    if (!Object.keys(patch).length) {
      toast(t('php.noChange'), 'info');
      return;
    }
    setSaving(true);
    try {
      const res = await savePhpSettings(version, patch);
      toast(res.reloaded ? t('php.savedReloaded', { msg: okMessage }) : t('php.savedReloadFailed', { msg: okMessage }), res.reloaded ? 'success' : 'error');
      await loadSettings(version);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  function handleSaveUpload() {
    const patch = {};
    UPLOAD_FIELDS.forEach((f) => {
      const v = (uploadForm[f.key] || '').trim();
      if (v) patch[f.key] = v;
    });
    const upload = sizeToBytes(patch.upload_max_filesize);
    const post = sizeToBytes(patch.post_max_size);
    if (upload && post && post < upload) {
      toast(t('php.postMaxSizeError'), 'error');
      return;
    }
    applySettings(patch, t('php.uploadSaved'));
  }

  function handleSaveDisabled() {
    const value = disableText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(',');
    applySettings({ disable_functions: value }, t('php.disabledSaved'));
  }

  function handleSaveConfig() {
    const patch = {};
    CONFIG_FIELDS.forEach((f) => {
      const v = (configForm[f.key] || '').trim();
      if (v && v !== (settings?.settings?.[f.key] || '')) patch[f.key] = v;
    });
    applySettings(patch, t('php.configSaved'));
  }

  // 安装其他版本：拉取可选版本列表并弹窗（默认选中尚未安装的版本）
  async function openInstallOtherVersion() {
    setInstallOpen(true);
    setInstallVersionsLoading(true);
    try {
      const d = await getAppVersions('php');
      const list = d.versions || [];
      setInstallVersions(list);
      const installed = (data.versions || []).map((v) => v.version);
      const notInstalled = list.find((v) => {
        const rel = v.replace('官方:', '');
        return !installed.some((i) => i === rel || i.startsWith(`${rel}.`));
      });
      setInstallVersion(notInstalled || list[0] || '');
    } catch (err) {
      toast(err?.message || String(err), 'error');
      setInstallOpen(false);
    } finally {
      setInstallVersionsLoading(false);
    }
  }

  async function handleInstallOtherVersion(e) {
    e.preventDefault();
    if (!installVersion) return;
    setInstallStarting(true);
    try {
      const res = await installApp('php', installVersion);
      startedRef.current = true;
      notifiedRef.current = false;
      setJobKey(res.job?.key || 'php');
      setJob(res.job);
      setTerminalOpen(true);
      setInstallOpen(false);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setInstallStarting(false);
    }
  }

  // 卸载指定 PHP 版本：转后台任务，终端弹窗跟踪进度
  async function handleUninstallVersion(v) {
    const ok = await uiConfirm({
      title: t('php.uninstallVersionTitle'),
      message: t('php.uninstallVersionMsg', { version: v.version, service: v.service }),
      confirmText: t('common.uninstall'),
    });
    if (!ok) return;
    try {
      const res = await uninstallPhpVersion(v.version);
      startedRef.current = true;
      notifiedRef.current = false;
      setJobKey(res.job?.key || `php-uninstall-${v.version}`);
      setJob(res.job);
      setTerminalOpen(true);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  async function handleInstallExt(ext) {
    try {
      const res = await installPhpExtension(version, ext.module);
      startedRef.current = true;
      notifiedRef.current = false;
      setJobKey(res.job?.key || `php-ext-${version}-${ext.module}`);
      setJob(res.job);
      setTerminalOpen(true);
      // 立即开始刷新列表，使卡片马上切到「查看进度」，关掉弹窗也不会丢入口
      setWatchingJob(true);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  // 重新打开进行中的扩展安装终端（关闭弹窗后仍可回到安装状态）
  async function openJob(key) {
    try {
      const { job: latest } = await getPhpJob(key);
      startedRef.current = false;
      notifiedRef.current = true;
      setJobKey(key);
      setJob(latest);
      setTerminalOpen(true);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  async function handleUninstallExt(ext) {
    const ok = await uiConfirm({
      title: t('php.uninstallExtTitle'),
      message: t('php.uninstallExtMsg', { name: ext.name, file: ext.enabledFile || `${ext.module}.ini` }),
      confirmText: t('common.uninstall'),
    });
    if (!ok) return;
    try {
      const res = await uninstallPhpExtension(version, ext.module);
      toast(res.reloaded ? t('php.extUninstalled', { name: ext.name }) : t('php.extUninstalledNoReload', { name: ext.name }), res.reloaded ? 'success' : 'error');
      loadExtensions(version);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  async function handleClearLogs() {
    const ok = await uiConfirm({
      title: t('php.clearLogTitle'),
      message: t('php.clearLogMsg', { type: logType === 'slow' ? t('php.slowLog') : t('php.errorLog') }),
      confirmText: t('php.clearLogs'),
    });
    if (!ok) return;
    try {
      await clearPhpLogs(version, logType, 0);
      toast(t('php.logsCleared'), 'success');
      loadLogs(version, logType, logLines);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  async function handleSaveSlowlog() {
    setSlowSaving(true);
    try {
      const res = await setPhpSlowlog(version, slowForm.enabled, slowForm.timeout);
      toast(res.reloaded ? t('php.slowlogSaved') : t('php.slowlogSavedNoReload'), res.reloaded ? 'success' : 'error');
      await loadSettings(version);
      if (activeTab === 'logs') loadLogs(version, logType, logLines);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setSlowSaving(false);
    }
  }

  // 扩展安装任务轮询
  useEffect(() => {
    if (!terminalOpen || !jobKey) return undefined;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const { job: latest } = await getPhpJob(jobKey);
        if (cancelled) return;
        setJob(latest);
        if (!latest.running) clearInterval(timer);
      } catch (err) {
        // 轮询失败不打断页面
      }
    }, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(timer); };
  }, [terminalOpen, jobKey]);

  useEffect(() => {
    if (!job || job.running || !jobKey) return;
    if (!startedRef.current || notifiedRef.current) return;
    notifiedRef.current = true;
    // 版本卸载 / 版本安装任务：刷新版本列表，并把已卸载的版本从当前选中中切走
    if (jobKey.startsWith('php-uninstall-') || jobKey === 'php') {
      refreshVersionsAfterJob(job);
      return;
    }
    loadExtensions(version);
    if (job.exitCode === 0) toast(t('apps.taskComplete', { label: job.label || '' }), 'success');
    else toast(t('apps.taskFailed', { label: job.label || '', code: job.exitCode }), 'error');
  }, [job, jobKey]);

  async function refreshVersionsAfterJob(job) {
    let next = [];
    try {
      const d = await getPhpStatus();
      setData(d);
      next = d.versions || [];
    } catch (err) {
      // 忽略刷新失败
    }
    setVersion((cur) => (next.some((x) => x.version === cur) ? cur : (next[0]?.version || '')));
    if (job.exitCode === 0) toast(t('apps.taskComplete', { label: job.label || '' }), 'success');
    else toast(t('apps.taskFailed', { label: job.label || '', code: job.exitCode }), 'error');
  }

  // 扩展安装任务进行中：持续刷新扩展列表，保证卡片始终保留「查看进度」入口。
  // 列表只在切页签时拉取，任务启动后不刷新的话卡片会一直停留在「安装」按钮，
  // 用户关掉终端弹窗后就再也回不到运行状态；任务结束后自动停止并同步最终状态。
  const anyJobRunning = (extData?.catalog || []).some((e) => e.jobRunning);
  useEffect(() => {
    if (!watchingJob && !anyJobRunning) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const d = await getPhpExtensions(version);
        if (cancelled) return;
        setExtData(d);
        if (!(d.catalog || []).some((e) => e.jobRunning)) setWatchingJob(false);
      } catch (err) {
        // 轮询失败不打断页面，等待下一次
      }
    };
    tick();
    const timer = setInterval(tick, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(timer); };
  }, [watchingJob, anyJobRunning, version]);

  useEffect(() => {
    if (terminalOpen && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.log, terminalOpen]);

  if (initialLoading) return <LoadingState />;

  const hasVersion = data.versions.length > 0;

  return (
    <div className="space-y-6">
      <GlassCard>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('php.status')}</h2>
            <div className="mt-2 flex items-center gap-3">
              <StatusBadge status={data.status} />
              {data.defaultVersion && (
                <span className="text-sm text-white/60">{t('php.defaultVersion', { version: data.defaultVersion })}</span>
              )}
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
            <LiquidButton onClick={() => handleControl('reload')} disabled={loading} variant="ghost">
              <RefreshCw className="w-4 h-4" /> {t('common.reload')}
            </LiquidButton>
          </div>
        </div>
      </GlassCard>

      <div className="flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`rounded-full px-4 py-2 text-sm transition-all ${
              activeTab === tab.key
                ? 'bg-gradient-to-r from-cyan-400 to-cyan-500 text-white shadow-lg'
                : 'border border-white/10 bg-white/5 text-white/70 hover:bg-white/10'
            }`}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {activeTab !== 'versions' && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-white/50">{t('php.operateVersion')}</span>
          <select
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            className={`${inputCls} min-w-[12rem]`}
          >
            {data.versions.map((v) => (
              <option key={v.version} value={v.version}>
                PHP {v.version}（{v.source === 'compiled' ? t('php.compiled') : t('php.packageManager')}）
              </option>
            ))}
          </select>
          {settings?.iniPath && (
            <span className="text-xs text-white/40 break-all">php.ini：{settings.iniPath}</span>
          )}
        </div>
      )}

      {activeTab === 'versions' && (
        <GlassCard>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">{t('php.installedVersions')}</h2>
            <div className="flex items-center gap-2">
              <LiquidButton onClick={openInstallOtherVersion} disabled={installVersionsLoading || installStarting}>
                <Download className="w-4 h-4" /> {t('apps.installOtherVersion')}
              </LiquidButton>
              <LiquidButton onClick={fetchData} variant="ghost">
                <RefreshCw className="w-4 h-4" /> {t('common.refresh')}
              </LiquidButton>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {data.versions.map((v) => (
              <div key={`${v.source}-${v.version}`} className="rounded-xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <Server className="h-5 w-5 text-cyan-300" />
                    <div>
                      <div className="font-medium">PHP {v.version}</div>
                      <div className="text-xs text-white/50">
                        {v.source === 'compiled' ? t('php.compiled') : t('php.packageManager')} · {v.service}
                      </div>
                    </div>
                  </div>
                  <StatusBadge status={v.status} />
                </div>
                <div className="mt-3 flex gap-2">
                  <div className="flex-1">
                    <button
                      onClick={() => handleControl('start', v.version)}
                      disabled={loading}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 py-1.5 text-xs text-emerald-300 hover:bg-white/10 disabled:opacity-50"
                    >
                      <Play className="w-3.5 h-3.5" /> {t('common.start')}
                    </button>
                  </div>
                  <div className="flex-1">
                    <button
                      onClick={() => handleControl('restart', v.version)}
                      disabled={loading}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 py-1.5 text-xs text-white/80 hover:bg-white/10 disabled:opacity-50"
                    >
                      <RefreshCw className="w-3.5 h-3.5" /> {t('common.restart')}
                    </button>
                  </div>
                  <div className="flex-1">
                    <button
                      onClick={() => handleControl('stop', v.version)}
                      disabled={loading}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 py-1.5 text-xs text-rose-300 hover:bg-white/10 disabled:opacity-50"
                    >
                      <Square className="w-3.5 h-3.5" /> {t('common.stop')}
                    </button>
                  </div>
                </div>
                <button
                  onClick={() => handleUninstallVersion(v)}
                  disabled={loading}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-rose-400/20 py-1.5 text-xs text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
                >
                  <Trash className="w-3.5 h-3.5" /> {t('common.uninstall')}
                </button>
              </div>
            ))}
            {data.versions.length === 0 && (
              <div className="col-span-full">
                <EmptyState message={t('php.noPhpVersion')} />
              </div>
            )}
          </div>
        </GlassCard>
      )}

      {activeTab !== 'versions' && !hasVersion && (
        <GlassCard>
          <EmptyState message={t('php.noPhpVersion')} />
        </GlassCard>
      )}

      {activeTab === 'ext' && hasVersion && (
        <GlassCard>
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">{t('php.installExt')}</h2>
              <p className="mt-1 text-xs text-white/50">
                {t('php.extDesc')}
              </p>
            </div>
            <LiquidButton onClick={() => loadExtensions(version)} variant="ghost" disabled={extLoading}>
              <RefreshCw className="w-4 h-4" /> {t('common.refresh')}
            </LiquidButton>
          </div>
          {extLoading && !extData ? (
            <LoadingState />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {(extData?.catalog || []).map((ext) => {
                const canUninstall = ext.installed && ext.enabledFile;
                return (
                  <div key={ext.module} className="flex flex-col rounded-xl border border-white/10 bg-white/5 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <Package className="h-5 w-5 text-cyan-300" />
                        <div>
                          <div className="font-medium">{ext.name}</div>
                          <div className="text-xs text-white/50">
                            {ext.module} · {ext.kind === 'pecl' ? t('php.pecl') : t('php.phpBuiltin')}
                          </div>
                        </div>
                      </div>
                      <span className={`rounded-full px-2.5 py-1 text-xs ${
                        ext.installed
                          ? 'border border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                          : 'border border-white/10 bg-white/5 text-white/50'
                      }`}>
                        {ext.installed ? (ext.enabledFile ? t('php.installedExt') : t('php.builtinEnabled')) : t('php.notInstalled')}
                      </span>
                    </div>
                    <p className="mt-2 flex-1 text-xs text-white/50">{ext.desc}</p>
                    <div className="mt-3">
                      {ext.jobRunning ? (
                        <button
                          onClick={() => openJob(ext.jobKey)}
                          className="flex w-full items-center justify-center gap-2 rounded-lg border border-cyan-300/30 bg-cyan-400/10 py-1.5 text-xs text-cyan-200 hover:bg-cyan-400/20"
                        >
                          <Terminal className="w-3.5 h-3.5" /> {t('apps.viewProgress')}
                        </button>
                      ) : canUninstall ? (
                        <button
                          onClick={() => handleUninstallExt(ext)}
                          className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 py-1.5 text-xs text-rose-300 hover:bg-white/10"
                        >
                          <Trash className="w-3.5 h-3.5" /> {t('common.uninstall')}
                        </button>
                      ) : ext.installed ? (
                        <div className="rounded-lg border border-white/10 py-1.5 text-center text-xs text-white/40">
                          {t('php.builtinNoNeed')}
                        </div>
                      ) : (
                        <button
                          onClick={() => handleInstallExt(ext)}
                          className="flex w-full items-center justify-center gap-2 rounded-lg border border-cyan-300/30 bg-cyan-400/10 py-1.5 text-xs text-cyan-200 hover:bg-cyan-400/20"
                        >
                          <Package className="w-3.5 h-3.5" /> {t('common.install')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </GlassCard>
      )}

      {activeTab === 'upload' && hasVersion && (
        <GlassCard>
          <h2 className="text-lg font-semibold">{t('php.uploadLimit')}</h2>
          <p className="mt-1 text-xs text-white/50">{t('php.uploadHint')}</p>
          {settingsLoading && !settings ? (
            <LoadingState />
          ) : (
            <div className="mt-5 space-y-6">
              {UPLOAD_FIELDS.map((f) => (
                <div key={f.key}>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
                    <span className="text-sm text-white/80">
                      {t(f.labelKey)}
                      <span className="ml-2 text-xs text-white/40">{f.key}</span>
                    </span>
                    <input
                      value={uploadForm[f.key] || ''}
                      onChange={(e) => setUploadForm((s) => ({ ...s, [f.key]: e.target.value }))}
                      placeholder="如 64M"
                      className={`${inputCls} w-36`}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {UPLOAD_PRESETS.map((p) => (
                      <button
                        key={p}
                        onClick={() => setUploadForm((s) => ({ ...s, [f.key]: p }))}
                        className={`${chipCls} ${
                          uploadForm[f.key] === p
                            ? 'border-cyan-300/50 bg-cyan-400/20 text-cyan-100'
                            : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10'
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <p className="text-xs text-white/40">
                {t('php.uploadTip')}
              </p>
              <LiquidButton onClick={handleSaveUpload} disabled={saving}>
                <Check className="w-4 h-4" /> {saving ? t('common.saving') : t('common.saveAndApply')}
              </LiquidButton>
            </div>
          )}
        </GlassCard>
      )}

      {activeTab === 'disabled' && hasVersion && (
        <GlassCard>
          <h2 className="text-lg font-semibold">{t('php.disabledFunctions')}</h2>
          <p className="mt-1 text-xs text-white/50">{t('php.disabledHint')}</p>
          {settingsLoading && !settings ? (
            <LoadingState />
          ) : (
            <div className="mt-5 space-y-4">
              <div className="flex flex-wrap gap-2">
                {DISABLE_PRESETS.map((fn) => {
                  const active = disableText.split(/[\n,]+/).map((s) => s.trim()).includes(fn);
                  return (
                    <button
                      key={fn}
                      onClick={() => {
                        const list = disableText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
                        const next = active ? list.filter((x) => x !== fn) : [...list, fn];
                        setDisableText(next.join('\n'));
                      }}
                      className={`${chipCls} ${
                        active
                          ? 'border-rose-300/40 bg-rose-400/15 text-rose-200'
                          : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10'
                      }`}
                    >
                      {fn}
                    </button>
                  );
                })}
              </div>
              <textarea
                rows={10}
                value={disableText}
                onChange={(e) => setDisableText(e.target.value)}
                placeholder="每行一个函数名，例如：exec"
                className={`${inputCls} w-full font-mono text-xs`}
              />
              <div className="flex items-center gap-3">
                <LiquidButton onClick={handleSaveDisabled} disabled={saving}>
                  <Lock className="w-4 h-4" /> {saving ? t('common.saving') : t('common.saveAndApply')}
                </LiquidButton>
                <span className="text-xs text-white/40">
                  {settings?.disabledFunctions
                    ? t('php.currentDisabled', { functions: settings.disabledFunctions })
                    : t('php.currentDisabled', { functions: t('php.noDisabledFunctions') })}
                </span>
              </div>
            </div>
          )}
        </GlassCard>
      )}

      {activeTab === 'config' && hasVersion && (
        <GlassCard>
          <h2 className="text-lg font-semibold">{t('php.configEdit')}</h2>
          <p className="mt-1 text-xs text-white/50">{t('php.configHint')}</p>
          {settingsLoading && !settings ? (
            <LoadingState />
          ) : (
            <div className="mt-5 space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                {CONFIG_FIELDS.map((f) => (
                  <div key={f.key}>
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="text-sm text-white/80">{t(f.labelKey)}</span>
                      <span className="text-xs text-white/35">{f.key}</span>
                    </div>
                    <input
                      value={configForm[f.key] || ''}
                      onChange={(e) => setConfigForm((s) => ({ ...s, [f.key]: e.target.value }))}
                      placeholder={f.hint}
                      className={`${inputCls} w-full`}
                    />
                  </div>
                ))}
              </div>
              <LiquidButton onClick={handleSaveConfig} disabled={saving}>
                <Check className="w-4 h-4" /> {saving ? t('common.saving') : t('common.saveAndApply')}
              </LiquidButton>
            </div>
          )}
        </GlassCard>
      )}

      {activeTab === 'logs' && hasVersion && (
        <GlassCard>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">{t('php.logs')}</h2>
              <p className="mt-1 text-xs text-white/40 break-all">
                {t('php.logPath', { path: logData?.path || '—' })}
                {logData?.exists ? ` · ${logData.size} 字节` : ''}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex gap-2">
                {[['error', t('php.errorLog')], ['slow', t('php.slowLog')]].map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => { setLogType(k); loadLogs(version, k, logLines); }}
                    className={`${chipCls} ${
                      logType === k
                        ? 'border-cyan-300/50 bg-cyan-400/20 text-cyan-100'
                        : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <select
                value={logLines}
                onChange={(e) => { const n = Number(e.target.value); setLogLines(n); loadLogs(version, logType, n); }}
                className={inputCls}
              >
                {[100, 200, 500, 1000, 2000].map((n) => (
                  <option key={n} value={n}>{t('php.lastLines', { n })}</option>
                ))}
              </select>
              <LiquidButton onClick={() => loadLogs(version, logType, logLines)} variant="ghost" disabled={logLoading}>
                <RefreshCw className="w-4 h-4" /> {t('common.refresh')}
              </LiquidButton>
              <LiquidButton onClick={handleClearLogs} variant="danger">
                <Trash className="w-4 h-4" /> {t('php.clearLogs')}
              </LiquidButton>
            </div>
          </div>

          <div className="mt-5 rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex items-center gap-3">
                <FileText className="h-5 w-5 text-cyan-300" />
                <div>
                  <div className="text-sm font-medium">{t('php.slowLog')}</div>
                  <div className="text-xs text-white/50">{t('php.slowLogDesc')}</div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-white/70">
                  <input
                    type="checkbox"
                    checked={slowForm.enabled}
                    onChange={(e) => setSlowForm((s) => ({ ...s, enabled: e.target.checked }))}
                    className="h-4 w-4 accent-cyan-400"
                  />
                  {t('common.enable')}
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-white/50">{t('php.timeoutSec')}</span>
                  <input
                    value={slowForm.timeout}
                    onChange={(e) => setSlowForm((s) => ({ ...s, timeout: e.target.value }))}
                    className={`${inputCls} w-20`}
                  />
                </div>
                <LiquidButton onClick={handleSaveSlowlog} disabled={slowSaving}>
                  <Check className="w-4 h-4" /> {slowSaving ? t('common.saving') : t('common.save')}
                </LiquidButton>
              </div>
            </div>
          </div>

          <div
            className="mt-4 max-h-[28rem] overflow-auto rounded-xl border border-white/10 bg-black/60 p-4 font-mono text-xs leading-relaxed text-emerald-200 whitespace-pre-wrap break-all"
          >
            {logLoading && !logData
              ? t('common.loading')
              : logData?.content?.trim()
                ? logData.content
                : (logData?.exists ? t('php.logEmpty') : t('php.noLogFile'))}
          </div>
        </GlassCard>
      )}

      <GlassModal
        title={job?.label ? t('php.terminalTitle', { label: job.label }) : t('php.terminalDefaultTitle')}
        subtitle={t('php.terminalHint')}
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
            {job?.running ? t('common.closeAndReopen') : ''}
          </p>
          <LiquidButton onClick={() => setTerminalOpen(false)}>
            <Check className="w-4 h-4" /> {t('common.close')}
          </LiquidButton>
        </div>
      </GlassModal>

      {/* 安装其他版本：版本选择弹窗 */}
      <GlassModal
        title={t('apps.installTitle', { name: 'PHP' })}
        subtitle={t('apps.installSubtitle')}
        open={installOpen}
        onClose={() => setInstallOpen(false)}
      >
        <form onSubmit={handleInstallOtherVersion} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm text-white/70">{t('apps.version')}</label>
            <div className="relative">
              <select
                value={installVersion}
                onChange={(e) => setInstallVersion(e.target.value)}
                disabled={installVersionsLoading || installVersions.length <= 1}
                className="w-full appearance-none rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 pr-10 text-sm outline-none focus:border-cyan-400 disabled:opacity-50"
              >
                {installVersions.map((v) => (
                  <option key={v} value={v} className="bg-gray-900 text-white">
                    {v.startsWith('官方:') ? t('apps.officialSource', { version: v.slice(3) }) : v}
                  </option>
                ))}
              </select>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40"><path d="m6 9 6 6 6-6" /></svg>
            </div>
            {installVersionsLoading && <p className="mt-2 text-xs text-white/50">{t('apps.fetchingVersions')}</p>}
          </div>
          <div className="flex items-start gap-3 rounded-xl border border-cyan-400/20 bg-cyan-500/10 p-4">
            <Terminal className="mt-0.5 h-4 w-4 flex-none text-cyan-300" />
            <div className="text-sm">
              <p className="text-cyan-100">{t('apps.backgroundInstall')}</p>
              <p className="mt-1 text-xs text-white/50">{t('common.compileHint')}</p>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <LiquidButton type="button" variant="ghost" onClick={() => setInstallOpen(false)}>{t('common.cancel')}</LiquidButton>
            <LiquidButton type="submit" disabled={installVersionsLoading || !installVersion || installStarting}>
              {installStarting ? t('apps.starting') : (<><Download className="w-4 h-4" /> {t('apps.startInstall')}</>)}
            </LiquidButton>
          </div>
        </form>
      </GlassModal>
    </div>
  );
}