import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import GlassModal from '@/components/common/GlassModal';
import LiquidButton from '@/components/common/LiquidButton';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import {
  getSiteBackups,
  createSiteBackup,
  downloadSiteBackup,
  restoreSiteBackup,
  deleteSiteBackup,
} from '@/api/nginx';
import { formatBytesSize } from '@/utils/format';
import { Download, RefreshCw, Trash2, Package, Plus } from '@/components/common/Icons';
import { useUIStore } from '@/components/common/uiStore';

export default function SiteBackupModal({ site, onClose }) {
  const { t, i18n } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const uiConfirm = useUIStore((s) => s.confirm);
  const [items, setItems] = useState([]);
  const [dir, setDir] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  // 正在下载/恢复/删除的文件名，用于禁用对应行的操作
  const [busyFile, setBusyFile] = useState('');
  const open = Boolean(site);

  async function fetchList() {
    if (!site) return;
    setLoading(true);
    try {
      const data = await getSiteBackups(site.name);
      setItems(data.items || []);
      setDir(data.dir || '');
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open && site) {
      setItems([]);
      setDir('');
      fetchList();
    }
    // 打开或切换站点时重新加载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, site?.name]);

  async function handleCreate() {
    if (!site) return;
    setCreating(true);
    try {
      const res = await createSiteBackup(site.name);
      toast(t('nginx.backupCreated', { file: res.file }), 'success');
      if (res.warning) toast(res.warning, 'warning');
      await fetchList();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setCreating(false);
    }
  }

  async function handleDownload(item) {
    try {
      const blob = await downloadSiteBackup(site.name, item.file);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = item.file;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  async function handleRestore(item) {
    const ok = await uiConfirm({
      title: t('nginx.backupRestore'),
      message: t('nginx.backupRestoreConfirm', { file: item.file }),
      confirmText: t('nginx.backupRestore'),
    });
    if (!ok) return;
    setBusyFile(item.file);
    try {
      const res = await restoreSiteBackup(site.name, item.file);
      toast(t('nginx.backupRestored', { file: res.file || item.file, count: res.entries ?? 0 }), 'success');
    } catch (err) {
      toast(t('nginx.backupRestoreFailed', { error: err?.message || String(err) }), 'error');
    } finally {
      setBusyFile('');
    }
  }

  async function handleDelete(item) {
    const ok = await uiConfirm({
      title: t('common.delete'),
      message: t('nginx.backupDeleteConfirm', { file: item.file }),
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    setBusyFile(item.file);
    try {
      await deleteSiteBackup(site.name, item.file);
      toast(t('nginx.backupDeleted', { file: item.file }), 'success');
      await fetchList();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setBusyFile('');
    }
  }

  const locale = i18n.language;

  return (
    <GlassModal
      open={open}
      onClose={onClose}
      maxWidth="max-w-3xl"
      title={t('nginx.backupTitle', { name: site?.serverName || site?.name || '' })}
      subtitle={t('nginx.backupSubtitle')}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-white/50">{t('nginx.backupList')}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={fetchList}
              disabled={loading || creating || Boolean(busyFile)}
              className="rounded-full border border-white/15 bg-white/5 p-2 text-white/70 transition-colors hover:bg-white/10 disabled:opacity-40"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <LiquidButton
              onClick={handleCreate}
              disabled={creating}
              className="!px-5 !py-2 !text-sm"
            >
              {creating ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" /> {t('nginx.backupCreating')}
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" /> {t('nginx.backupCreate')}
                </>
              )}
            </LiquidButton>
          </div>
        </div>

        <div className="max-h-[45vh] overflow-y-auto rounded-xl border border-white/10">
          {loading && items.length === 0 ? (
            <LoadingState />
          ) : items.length === 0 ? (
            <EmptyState message={t('nginx.backupEmpty')} />
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-gray-950/90 backdrop-blur">
                <tr className="border-b border-white/10 text-white/50">
                  <th className="px-4 py-2.5 font-medium">{t('nginx.backupFile')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('nginx.backupSize')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('nginx.backupTime')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('nginx.files.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const busy = busyFile === item.file;
                  return (
                    <tr key={item.file} className="border-b border-white/5 last:border-0 hover:bg-white/[0.03]">
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-2 text-white/85">
                          <Package className="w-4 h-4 flex-none text-amber-300/80" />
                          <span className="truncate" title={item.file}>{item.file}</span>
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-white/50">
                        {formatBytesSize(item.size)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-white/50">
                        {item.createdAt ? new Date(item.createdAt).toLocaleString(locale) : '-'}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => handleDownload(item)}
                            disabled={busy}
                            title={t('nginx.backupDownload')}
                            className="rounded-full border border-white/15 bg-white/5 p-1.5 text-white/70 transition-colors hover:bg-white/15 hover:text-white disabled:opacity-40"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRestore(item)}
                            disabled={busy || creating}
                            title={t('nginx.backupRestore')}
                            className="rounded-full border border-emerald-500/30 bg-emerald-500/10 p-1.5 text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-40"
                          >
                            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(item)}
                            disabled={busy || creating}
                            title={t('common.delete')}
                            className="rounded-full border border-rose-500/30 bg-rose-500/10 p-1.5 text-rose-300 transition-colors hover:bg-rose-500/20 disabled:opacity-40"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="space-y-1">
          {dir && <p className="break-all text-xs text-white/40">{t('nginx.backupDir', { path: dir })}</p>}
          <p className="text-xs text-white/40">{t('nginx.backupRestoreHint')}</p>
          {!site?.root && <p className="text-xs text-white/40">{t('nginx.backupProxyOnly')}</p>}
        </div>
      </div>
    </GlassModal>
  );
}