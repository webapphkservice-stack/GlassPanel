import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Editor from '@monaco-editor/react';
import {
  getNginxStatus,
  controlNginx,
  testNginxConfig,
  getNginxSites,
  createNginxSite,
  getNginxConfig,
  saveNginxConfig,
  getSiteRelations,
  deleteNginxSite,
  getProvisionStatus,
} from '@/api/nginx';
import GlassCard from '@/components/common/GlassCard';
import LiquidButton from '@/components/common/LiquidButton';
import StatusBadge from '@/components/common/StatusBadge';
import GlassModal from '@/components/common/GlassModal';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import { getMysqlStatus } from '@/api/mysql';
import SiteFileBrowser from '@/components/site/SiteFileBrowser';
import ProvisionFlowModal from '@/components/site/ProvisionFlowModal';
import { Play, Square, RefreshCw, FileText, Globe, Check, Plus } from '@/components/common/Icons';
import { useUIStore } from '@/components/common/uiStore';

// 站点配置目录（RHEL 系 nginx 通过 conf.d/*.conf 引入）
const SITE_DIR = '/etc/nginx/conf.d';

// 伪静态预设，需与后端 nginxService.REWRITE_PRESETS 保持一致
const REWRITE_OPTIONS = [
  { value: 'none', labelKey: 'nginx.rewriteNone' },
  { value: 'wordpress', label: 'WordPress' },
  { value: 'laravel', label: 'Laravel' },
  { value: 'thinkphp', label: 'ThinkPHP' },
];

const EMPTY_FORM = {
  name: '',
  serverName: '',
  listen: '80',
  root: '',
  runDir: '',
  rewrite: 'none',
  type: 'html',
  ssl: false,
  email: '',
  createDb: false,
  proxyPass: '',
};

// 站点类型，需与后端 nginxService 的 type 取值保持一致
const TYPE_OPTIONS = [
  { value: 'html', labelKey: 'nginx.staticHtml', hintKey: 'nginx.staticHint' },
  { value: 'php', labelKey: 'nginx.php', hintKey: 'nginx.phpHint' },
];

// 开通进度标识：与后端 OP_ID_RE 保持一致（8-64 位字母数字与 _ -）
function genOpId() {
  const raw = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

export default function Nginx() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const uiConfirm = useUIStore((s) => s.confirm);
  const [status, setStatus] = useState('unknown');
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorPath, setEditorPath] = useState('/etc/nginx/nginx.conf');
  const [editorContent, setEditorContent] = useState('');
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorReload, setEditorReload] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [rootTouched, setRootTouched] = useState(false);
  const [mysqlStatus, setMysqlStatus] = useState('unknown');
  const [deletingSite, setDeletingSite] = useState('');
  const [sitesRefreshing, setSitesRefreshing] = useState(false);
  const [filesSite, setFilesSite] = useState(null);
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [provision, setProvision] = useState(null);
  const [provisionForm, setProvisionForm] = useState(EMPTY_FORM);
  const [provisionError, setProvisionError] = useState('');
  const [provisionExpired, setProvisionExpired] = useState(false);
  const [provisionLost, setProvisionLost] = useState(false);
  // appliedRef：终态只处理一次（toast / 重置表单 / 刷新列表），避免轮询反复触发
  const appliedRef = useRef(false);

  async function fetchStatus() {
    try {
      const data = await getNginxStatus();
      setStatus(data.status);
    } catch (err) {
      console.error(err);
    }
  }

  // 刷新失败必须显式提示：创建/删除站点后若静默失败，列表会停留在旧数据
  async function fetchSites() {
    setSitesRefreshing(true);
    try {
      const data = await getNginxSites();
      setSites(data.sites);
      return true;
    } catch (err) {
      toast(t('nginx.refreshFailed', { error: err?.message || String(err) }), 'warning');
      return false;
    } finally {
      setSitesRefreshing(false);
    }
  }

  useEffect(() => {
    setInitialLoading(true);
    Promise.all([fetchStatus(), fetchSites()]).finally(() => setInitialLoading(false));
  }, []);

  // 开通进度轮询：创建期间每秒拉取只读快照，抵达终态或进度过期后自动停止。
  // 依赖只取 opId，因此用户关掉进度弹窗后仍会继续刷新，列表不会停留在旧数据。
  useEffect(() => {
    const opId = provision?.opId;
    if (!opId) return undefined;
    let stopped = false;
    let timer = null;

    const handleTerminal = (snap) => {
      if (appliedRef.current) return;
      appliedRef.current = true;
      // 创建请求可能已因反代超时（504）提前中断，此时靠终态快照补一次列表刷新
      fetchSites();
      if (snap.status !== 'done') return;
      const output = snap.result || {};
      const warnings = snap.warnings || [];
      if (warnings.length > 0) {
        toast(t('nginx.siteCreatedWarning', { warnings: warnings.join('；') }), 'warning');
      } else {
        toast(t('nginx.siteCreated', { name: output.name || snap.name }), 'success');
      }
      if (output.database?.password) {
        toast(
          t('nginx.dbCreated', {
            dbName: output.database.dbName,
            user: output.database.user,
            password: output.database.password,
          }),
          'info'
        );
      }
      if (output.defaultPage) {
        toast(t('nginx.defaultPage', { path: output.defaultPage }), 'info');
      }
      setForm(EMPTY_FORM);
      setRootTouched(false);
    };

    const tick = async () => {
      const res = await getProvisionStatus(opId);
      if (stopped) return;
      if (res.ok) {
        setProvisionExpired(false);
        setProvisionLost(false);
        if (res.provision) {
          setProvision(res.provision);
          if (res.provision.status !== 'running') {
            handleTerminal(res.provision);
            return;
          }
        }
      } else if (res.expired) {
        setProvisionExpired(true);
        return;
      } else {
        // 单次查询失败多为网络抖动，保留轮询继续重试
        setProvisionLost(true);
      }
      timer = setTimeout(tick, 1000);
    };

    timer = setTimeout(tick, 300);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [provision?.opId]);

  async function handleControl(action) {
    setLoading(true);
    try {
      await controlNginx(action);
      await fetchStatus();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  // 删除站点：先查询关联资源，确认弹窗中逐项列出将被删除的内容
  async function handleDeleteSite(site) {
    let relations;
    try {
      const data = await getSiteRelations(site.name);
      relations = data.relations;
    } catch (err) {
      toast(err?.message || String(err), 'error');
      return;
    }

    const dbInfo = relations.dbExists
      ? t('nginx.dbExists', { name: relations.dbName })
      : t('nginx.noDb');
    const certInfo = relations.certExists
      ? t('nginx.certExists', { name: relations.certName })
      : t('nginx.noCert');

    const message = t('nginx.deleteSiteConfirm', {
      name: relations.serverName || relations.name,
      file: relations.file,
      dbInfo,
      certInfo,
    });

    const ok = await uiConfirm({ title: t('nginx.deleteSite'), message, confirmText: t('nginx.confirmDelete') });
    if (!ok) return;

    setDeletingSite(site.name);
    try {
      const data = await deleteNginxSite(site.name);
      const output = data.output || {};
      if (output.warnings?.length) {
        toast(t('nginx.deletePartially', { warnings: output.warnings.join('；') }), 'warning');
        return;
      }
      const parts = [t('nginx.siteDeleted')];
      if (output.database) parts.push(t('nginx.dbDeleted', { name: output.database.dbName }));
      if (output.certificate?.deleted) parts.push(t('nginx.certDeleted', { domain: output.certificate.domain }));
      toast(parts.join('，'), 'success');
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      // 删除耗时较长（证书清理），即使请求超时/中断也要拉一次最新列表
      await fetchSites();
      setDeletingSite('');
    }
  }

  async function handleTest() {
    try {
      const data = await testNginxConfig();
      setTestResult(data);
      toast(data.valid ? t('nginx.configTestPass') : t('nginx.configTestFail', { error: data.output?.stderr || '' }), data.valid ? 'success' : 'error');
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  async function openEditor(path) {
    setEditorPath(path);
    setEditorOpen(true);
    try {
      const data = await getNginxConfig(path);
      setEditorContent(data.content);
    } catch (err) {
      setEditorContent(`# 无法读取：${err}\n`);
    }
  }

  async function handleSaveConfig() {
    setEditorSaving(true);
    try {
      const data = await saveNginxConfig(editorPath, editorContent, editorReload);
      if (data?.reloadFailed) {
        toast(t('nginx.savedReloadFailed'), 'warning');
      } else {
        toast(data?.reloaded ? t('nginx.saveReloadSuccess') : t('nginx.saveSuccess'), 'success');
      }
      setEditorOpen(false);
      setEditorReload(false);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setEditorSaving(false);
    }
  }

  async function openAddSite() {
    setForm(EMPTY_FORM);
    setRootTouched(false);
    setAddOpen(true);
    try {
      const data = await getMysqlStatus();
      setMysqlStatus(data.status);
    } catch (err) {
      setMysqlStatus('unknown');
    }
  }

  // 填写域名时自动补全网站根目录，用户手动改过根目录后不再覆盖
  function handleDomainChange(value) {
    setForm((prev) => {
      const next = { ...prev, serverName: value };
      if (!rootTouched) {
        const first = value.trim().split(/\s+/)[0] || '';
        next.root = first ? `/var/www/${first}` : '';
      }
      return next;
    });
  }

  async function handleCreateSite(e) {
    e.preventDefault();
    const opId = genOpId();
    const payload = { ...form, opId };
    // 先切到进度弹窗：后端按「创建目录 → 部署 SSL → 创建数据库」逐步推进，前端轮询实时展示
    appliedRef.current = false;
    setProvisionForm(form);
    setProvision({ opId, status: 'running', steps: [], name: form.name, domain: form.serverName });
    setProvisionError('');
    setProvisionExpired(false);
    setProvisionLost(false);
    setProvisionOpen(true);
    setAddOpen(false);
    setCreating(true);
    try {
      await createNginxSite(payload);
      // 结果提示与表单重置统一由轮询的终态快照处理，避免重复提示
    } catch (err) {
      const message = err?.message || String(err);
      setProvisionError(message);
      toast(message, 'error');
    } finally {
      // 创建站点包含证书签发，整体耗时可能超过反向代理的读超时（表现为 504）。
      // 此时站点配置其实已落盘，所以无论成功还是失败都必须刷新列表，避免“要手动刷新才能看到站点”。
      await fetchSites();
      setCreating(false);
    }
  }

  // 从进度弹窗直接进入文件管理：列表可能尚未刷新，直接用快照里的站点信息构造
  function handleViewProvisionFiles() {
    const result = provision?.result;
    if (!result?.root) return;
    setProvisionOpen(false);
    setFilesSite({ name: result.name, serverName: provision.domain, root: result.root });
  }

  // 数据库创建需要 MySQL 已运行，未运行时禁用并提示
  const mysqlReady = mysqlStatus === 'active';

  if (initialLoading) return <LoadingState />;

  return (
    <div className="space-y-6">
      <GlassCard>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('nginx.status')}</h2>
            <div className="mt-2">
              <StatusBadge status={status} />
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
            <LiquidButton onClick={handleTest} variant="ghost">
              <Check className="w-4 h-4" /> {t('nginx.testConfig')}
            </LiquidButton>
          </div>
        </div>
      </GlassCard>

      <div className="grid gap-6 lg:grid-cols-3">
        <GlassCard className="lg:col-span-2">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">{t('nginx.sites')}</h2>
            <div className="flex items-center gap-3">
              <span className="text-xs text-white/50">{t('nginx.siteCount', { count: sites.length })}</span>
              <LiquidButton variant="ghost" onClick={fetchSites} disabled={sitesRefreshing}>
                <RefreshCw className={`w-4 h-4 ${sitesRefreshing ? 'animate-spin' : ''}`} /> {t('nginx.refreshSites')}
              </LiquidButton>
              <LiquidButton onClick={openAddSite}>
                <Plus className="w-4 h-4" /> {t('nginx.addSite')}
              </LiquidButton>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 text-white/50">
                  <th className="pb-3 font-medium">{t('nginx.serverName')}</th>
                  <th className="pb-3 font-medium">{t('nginx.listen')}</th>
                  <th className="pb-3 font-medium">{t('nginx.rootProxy')}</th>
                  <th className="pb-3 font-medium">{t('nginx.ssl')}</th>
                  <th className="pb-3 font-medium">{t('nginx.configFile')}</th>
                  <th className="pb-3 font-medium">{t('nginx.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((site, idx) => (
                  <tr key={idx} className="border-b border-white/5 last:border-0">
                    <td className="py-3 font-medium">{site.serverName}</td>
                    <td className="py-3 text-white/70">{site.listen}</td>
                    <td className="py-3 text-white/70">{site.root || site.proxyPass || '-'}</td>
                    <td className="py-3">
                      {site.ssl ? (
                        <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-300">Yes</span>
                      ) : (
                        <span className="text-white/40">-</span>
                      )}
                    </td>
                    <td className="py-3">
                      {site.file ? (
                        <button
                          type="button"
                          onClick={() => openEditor(site.file)}
                          className="text-xs text-cyan-300 hover:text-cyan-200 hover:underline"
                        >
                          {site.name}.conf
                        </button>
                      ) : (
                        <span className="text-white/40">-</span>
                      )}
                    </td>
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setFilesSite(site)}
                          disabled={!site.root}
                          title={site.root || t('nginx.noRootForFiles')}
                          className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-xs text-cyan-300 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {t('nginx.openFiles')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteSite(site)}
                          disabled={!site.file || deletingSite === site.name}
                          title="删除站点，并同步删除关联的数据库与 SSL 证书"
                          className="rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-xs text-rose-300 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {deletingSite === site.name ? t('common.deleting') : t('common.delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {sites.length === 0 && (
                  <tr>
                    <td colSpan={6}><EmptyState message={t('common.noSites')} /></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </GlassCard>

        <GlassCard>
          <h2 className="mb-4 text-lg font-semibold">{t('nginx.commonConfig')}</h2>
          <div className="space-y-3">
            <button
              onClick={() => openEditor('/etc/nginx/nginx.conf')}
              className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left text-sm hover:bg-white/10 transition-colors"
            >
              <FileText className="h-4 w-4 text-cyan-300" />
              nginx.conf
            </button>
            <button
              onClick={() => openEditor('/etc/nginx/sites-enabled/default')}
              className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left text-sm hover:bg-white/10 transition-colors"
            >
              <Globe className="h-4 w-4 text-cyan-300" />
              {t('nginx.defaultSite')}
            </button>
          </div>
        </GlassCard>
      </div>

      <GlassModal
        title={t('nginx.addSiteTitle')}
        subtitle={t('nginx.addSiteSubtitle', { dir: SITE_DIR, name: form.name || '<站点名称>' })}
        open={addOpen}
        onClose={() => setAddOpen(false)}
      >
        <form onSubmit={handleCreateSite} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm text-white/70">{t('nginx.siteNameLabel')}</label>
              <input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="myblog"
                className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-white/70">{t('nginx.listenPort')}</label>
              <input
                required
                value={form.listen}
                onChange={(e) => setForm({ ...form, listen: e.target.value })}
                placeholder="80"
                className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm text-white/70">{t('nginx.siteType')}</label>
            <div className="flex flex-wrap gap-2">
              {TYPE_OPTIONS.map((opt) => {
                const active = form.type === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setForm({ ...form, type: opt.value })}
                    className={`
                      rounded-full border px-4 py-2 text-sm transition-colors
                      ${active
                        ? 'border-cyan-300/40 bg-cyan-500/20 text-cyan-100'
                        : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10'}
                    `}
                  >
                    {t(opt.labelKey)}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-white/40">
              {t(TYPE_OPTIONS.find((o) => o.value === form.type)?.hintKey)}
            </p>
          </div>
          <div>
            <label className="mb-1 block text-sm text-white/70">{t('nginx.domain')}</label>
            <input
              required
              value={form.serverName}
              onChange={(e) => handleDomainChange(e.target.value)}
              placeholder="example.com www.example.com"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400"
            />
            <p className="mt-1 text-xs text-white/40">{t('nginx.domainHint')}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm text-white/70">{t('nginx.rootDir')}</label>
              <input
                value={form.root}
                onChange={(e) => {
                  setRootTouched(true);
                  setForm({ ...form, root: e.target.value });
                }}
                placeholder="/var/www/example.com"
                className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-white/70">{t('nginx.runDir')}</label>
              <input
                value={form.runDir}
                onChange={(e) => setForm({ ...form, runDir: e.target.value })}
                placeholder="public"
                className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400"
              />
              <p className="mt-1 text-xs text-white/40">
                {t('nginx.runDirHint', {
                  path: form.runDir.trim()
                    ? `${form.root || '/var/www/<域名>'}/${form.runDir.trim().replace(/^\/+|\/+$/g, '')}`
                    : (form.root || '/var/www/<域名>')
                })}
              </p>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm text-white/70">{t('nginx.rewrite')}</label>
            <select
              value={form.rewrite}
              onChange={(e) => setForm({ ...form, rewrite: e.target.value })}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400"
            >
              {REWRITE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value} className="bg-slate-900">
                  {opt.labelKey ? t(opt.labelKey) : opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm text-white/70">{t('nginx.proxyPass')}</label>
            <input
              value={form.proxyPass}
              onChange={(e) => setForm({ ...form, proxyPass: e.target.value })}
              placeholder="http://127.0.0.1:3000"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400"
            />
          </div>

          <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4">
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={form.ssl}
                onChange={(e) => setForm({ ...form, ssl: e.target.checked })}
                className="h-4 w-4 rounded border-white/20 bg-white/10 accent-cyan-400"
              />
              <span>{t('nginx.sslApply')}</span>
            </label>
            {form.ssl && (
              <input
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder={t('nginx.sslEmail')}
                className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400"
              />
            )}
            <label className={`flex items-center gap-3 text-sm ${mysqlReady ? '' : 'opacity-50'}`}>
              <input
                type="checkbox"
                checked={form.createDb}
                disabled={!mysqlReady}
                onChange={(e) => setForm({ ...form, createDb: e.target.checked })}
                className="h-4 w-4 rounded border-white/20 bg-white/10 accent-cyan-400"
              />
              <span>{t('nginx.createDb')}</span>
            </label>
            {!mysqlReady && (
              <p className="text-xs text-amber-300">
                {t('nginx.mysqlWarning', { status: mysqlStatus })}
              </p>
            )}
          </div>

          <p className="text-xs text-white/50">
            {t('nginx.siteCreateHint')}
          </p>
          <div className="flex justify-end gap-3 pt-2">
            <LiquidButton type="button" onClick={() => setAddOpen(false)} variant="ghost">{t('common.cancel')}</LiquidButton>
            <LiquidButton type="submit" disabled={creating}><Check className="w-4 h-4" /> {t('nginx.createSite')}</LiquidButton>
          </div>
        </form>
      </GlassModal>

      <GlassModal title={t('nginx.editConfig', { path: editorPath })} open={editorOpen} onClose={() => setEditorOpen(false)}>
        <div className="h-[400px] rounded-xl overflow-hidden border border-white/10">
          <Editor
            height="100%"
            defaultLanguage="nginx"
            value={editorContent}
            onChange={(v) => setEditorContent(v || '')}
            theme="vs-dark"
            options={{ minimap: { enabled: false }, fontSize: 14 }}
          />
        </div>
        <div className="mt-4 flex items-center justify-between">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-white/70">
            <input
              type="checkbox"
              checked={editorReload}
              onChange={(e) => setEditorReload(e.target.checked)}
              className="h-4 w-4 rounded border-white/20 bg-white/10 text-cyan-500 focus:ring-cyan-500/50"
            />
            {t('nginx.saveReloadNginx')}
          </label>
          <div className="flex gap-3">
            <LiquidButton onClick={() => setEditorOpen(false)} variant="ghost">{t('common.cancel')}</LiquidButton>
            <LiquidButton onClick={handleSaveConfig} disabled={editorSaving}>
              {editorReload ? t('common.saveAndReload') : t('common.save')}
            </LiquidButton>
          </div>
        </div>
      </GlassModal>

      <SiteFileBrowser site={filesSite} onClose={() => setFilesSite(null)} />

      <ProvisionFlowModal
        open={provisionOpen}
        onClose={() => setProvisionOpen(false)}
        form={provisionForm}
        snapshot={provision}
        postError={provisionError}
        connLost={provisionLost}
        expired={provisionExpired}
        onViewFiles={handleViewProvisionFiles}
      />
    </div>
  );
}