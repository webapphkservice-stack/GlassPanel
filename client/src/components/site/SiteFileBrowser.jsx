import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import GlassModal from '@/components/common/GlassModal';
import LiquidButton from '@/components/common/LiquidButton';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import {
  getSiteFiles,
  createSiteDir,
  uploadSiteFile,
  downloadSiteFile,
  deleteSiteFile,
} from '@/api/nginx';
import { Upload, Download, Folder, FolderOpen, File, Home, Plus, RefreshCw, Trash2 } from '@/components/common/Icons';
import { useUIStore } from '@/components/common/uiStore';

function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

function formatSize(bytes) {
  if (bytes === undefined || bytes === null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = -1;
  do {
    value /= 1024;
    i += 1;
  } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

export default function SiteFileBrowser({ site, onClose }) {
  const { t, i18n } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const uiConfirm = useUIStore((s) => s.confirm);
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState('');
  const [newDirName, setNewDirName] = useState('');
  const [creatingDir, setCreatingDir] = useState(false);
  const fileInputRef = useRef(null);
  const open = Boolean(site);

  useEffect(() => {
    if (site) {
      setDir('');
      setNewDirName('');
    }
  }, [site?.name]);

  async function fetchList(targetDir = dir) {
    if (!site) return;
    setLoading(true);
    try {
      const data = await getSiteFiles(site.name, targetDir);
      setDir(data.path || '');
      setEntries(data.entries || []);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open && site) fetchList('');
    // 打开或切换站点时从根目录重新加载；目录导航由调用方显式触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, site?.name]);

  async function navigate(nextDir) {
    setLoading(true);
    await fetchList(nextDir);
  }

  async function handleUpload(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setUploading(files[0].name);
    let done = 0;
    for (const file of files) {
      try {
        const conflict = entries.find((e) => e.name === file.name && e.type === 'file');
        let overwrite = true;
        if (conflict) {
          overwrite = await uiConfirm({
            title: t('nginx.files.overwriteTitle'),
            message: t('nginx.files.overwriteConfirm', { name: file.name }),
            confirmText: t('common.confirm'),
          });
          if (!overwrite) continue;
        }
        setUploading(file.name);
        await uploadSiteFile(site.name, dir, file, overwrite);
        done += 1;
      } catch (err) {
        toast(t('nginx.files.uploadFailed', { name: file.name, error: err?.message || String(err) }), 'error');
      }
    }
    setUploading('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (done > 0) {
      toast(t('nginx.files.uploadDone', { count: done }), 'success');
      await fetchList();
    }
  }

  async function handleDownload(entry) {
    try {
      const blob = await downloadSiteFile(site.name, joinPath(dir, entry.name));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = entry.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast(t('nginx.files.downloadFailed', { error: err?.message || String(err) }), 'error');
    }
  }

  async function handleDelete(entry) {
    const isDir = entry.type === 'dir';
    const ok = await uiConfirm({
      title: t('nginx.files.deleteTitle'),
      message: isDir
        ? t('nginx.files.deleteDirConfirm', { name: entry.name })
        : t('nginx.files.deleteConfirm', { name: entry.name }),
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await deleteSiteFile(site.name, joinPath(dir, entry.name));
      toast(t('nginx.files.deleted', { name: entry.name }), 'success');
      await fetchList();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  async function handleCreateDir() {
    const name = newDirName.trim();
    if (!name) return;
    setCreatingDir(true);
    try {
      await createSiteDir(site.name, joinPath(dir, name));
      toast(t('nginx.files.dirCreated', { name }), 'success');
      setNewDirName('');
      await fetchList();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setCreatingDir(false);
    }
  }

  const segments = dir ? dir.split('/') : [];
  const locale = i18n.language;

  return (
    <GlassModal
      open={open}
      onClose={onClose}
      maxWidth="max-w-3xl"
      title={t('nginx.files.title', { name: site?.serverName || site?.name || '' })}
      subtitle={`${t('nginx.files.subtitle')}：${site?.root || ''}`}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* 面包屑 */}
          <div className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
            <button
              type="button"
              onClick={() => navigate('')}
              disabled={!dir || loading}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-cyan-300 hover:bg-white/10 disabled:cursor-default disabled:text-white/40 disabled:hover:bg-transparent"
            >
              <Home className="w-4 h-4" />
              <span className="max-w-[180px] truncate">{site?.root || '/'}</span>
            </button>
            {segments.map((seg, idx) => {
              const target = segments.slice(0, idx + 1).join('/');
              const last = idx === segments.length - 1;
              return (
                <span key={target} className="flex items-center gap-1">
                  <span className="text-white/30">/</span>
                  {last ? (
                    <span className="rounded-lg px-2 py-1 text-white/80">{seg}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => navigate(target)}
                      disabled={loading}
                      className="rounded-lg px-2 py-1 text-cyan-300 hover:bg-white/10"
                    >
                      {seg}
                    </button>
                  )}
                </span>
              );
            })}
          </div>
          {/* 操作区 */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fetchList()}
              disabled={loading || Boolean(uploading)}
              className="rounded-full border border-white/15 bg-white/5 p-2 text-white/70 transition-colors hover:bg-white/10 disabled:opacity-40"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading || Boolean(uploading)}
              className="flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-4 py-1.5 text-xs text-cyan-300 transition-colors hover:bg-cyan-500/20 disabled:opacity-40"
            >
              <Upload className="w-4 h-4" />
              {uploading ? t('nginx.files.uploading', { name: uploading }) : t('nginx.files.upload')}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => handleUpload(e.target.files)}
            />
          </div>
        </div>

        {/* 新建目录 */}
        <div className="flex items-center gap-2">
          <input
            value={newDirName}
            onChange={(e) => setNewDirName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleCreateDir();
              }
            }}
            placeholder={t('nginx.files.newDirPlaceholder')}
            className="w-56 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-sm outline-none focus:border-cyan-400"
          />
          <LiquidButton
            onClick={handleCreateDir}
            disabled={!newDirName.trim() || creatingDir}
            className="!px-4 !py-1.5 !text-xs"
          >
            <Plus className="w-4 h-4" /> {t('nginx.files.newDir')}
          </LiquidButton>
        </div>

        {/* 文件列表 */}
        <div className="max-h-[45vh] overflow-y-auto rounded-xl border border-white/10">
          {loading && entries.length === 0 ? (
            <LoadingState />
          ) : entries.length === 0 ? (
            <EmptyState message={t('nginx.files.empty')} />
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-gray-950/90 backdrop-blur">
                <tr className="border-b border-white/10 text-white/50">
                  <th className="px-4 py-2.5 font-medium">{t('nginx.files.name')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('nginx.files.size')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('nginx.files.modified')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('nginx.files.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {segments.length > 0 && (
                  <tr className="border-b border-white/5">
                    <td colSpan={4} className="px-4 py-2">
                      <button
                        type="button"
                        onClick={() => navigate(segments.slice(0, -1).join('/'))}
                        className="flex items-center gap-2 text-white/60 hover:text-white"
                      >
                        <Folder className="w-4 h-4 text-amber-300/80" />
                        <span>../</span>
                      </button>
                    </td>
                  </tr>
                )}
                {entries.map((entry) => (
                  <tr key={entry.name} className="border-b border-white/5 last:border-0 hover:bg-white/[0.03]">
                    <td className="px-4 py-2.5">
                      {entry.type === 'dir' ? (
                        <button
                          type="button"
                          onClick={() => navigate(joinPath(dir, entry.name))}
                          disabled={loading || Boolean(uploading)}
                          className="flex items-center gap-2 text-cyan-300 hover:underline disabled:opacity-50"
                        >
                          <FolderOpen className="w-4 h-4 flex-none text-amber-300/90" />
                          <span className="truncate">{entry.name}</span>
                        </button>
                      ) : (
                        <span className="flex items-center gap-2 text-white/85">
                          <File className="w-4 h-4 flex-none text-white/40" />
                          <span className="truncate" title={entry.name}>{entry.name}</span>
                          {entry.type === 'link' && <span className="text-xs text-white/40">→ link</span>}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-white/50">
                      {entry.type === 'dir' ? '-' : formatSize(entry.size)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-white/50">
                      {entry.mtime ? new Date(entry.mtime).toLocaleString(locale) : '-'}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-2">
                        {entry.type === 'file' && (
                          <button
                            type="button"
                            onClick={() => handleDownload(entry)}
                            className="rounded-full border border-white/15 bg-white/5 p-1.5 text-white/70 transition-colors hover:bg-white/15 hover:text-white"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDelete(entry)}
                          className="rounded-full border border-rose-500/30 bg-rose-500/10 p-1.5 text-rose-300 transition-colors hover:bg-rose-500/20"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="text-xs text-white/40">{t('nginx.files.hint')}</p>
      </div>
    </GlassModal>
  );
}
