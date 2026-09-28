import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import GlassModal from './GlassModal';
import LiquidButton from './LiquidButton';
import LoadingState from './LoadingState';
import { scanCleanup, runCleanup } from '@/api/cleanup';
import { formatBytesSize } from '@/utils/format';
import { Trash2, RefreshCw, Package, FileText, HardDrive, Check } from './Icons';
import { useUIStore } from './uiStore';

// 四项清理的图标，键与后端 cleanupService 的 CATEGORIES 一致
const CATEGORY_ICONS = {
  junk: Trash2,
  residue: Package,
  syslog: FileText,
  temp: HardDrive,
};

export default function CleanupModal({ open, onClose }) {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const uiConfirm = useUIStore((s) => s.confirm);
  const [items, setItems] = useState([]);
  const [retainDays, setRetainDays] = useState(7);
  // 勾选项：默认全选，扫描后按可清理体重复位
  const [selected, setSelected] = useState({});
  const [scanning, setScanning] = useState(false);
  const [running, setRunning] = useState(false);

  async function handleScan() {
    setScanning(true);
    try {
      const data = await scanCleanup();
      const list = data.items || [];
      setItems(list);
      setRetainDays(data.retainDays || 7);
      // 无可清理内容项默认不勾选，避免用户误以为会清到东西
      setSelected(Object.fromEntries(list.map((item) => [item.key, item.bytes > 0])));
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setItems([]);
    setSelected({});
    handleScan();
    // 仅在打开时扫描一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const picked = items.filter((item) => selected[item.key] && item.bytes > 0);
  const pickedBytes = picked.reduce((sum, item) => sum + item.bytes, 0);

  function toggle(key) {
    setSelected((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function handleRun() {
    const keys = picked.map((item) => item.key);
    if (!keys.length) return;
    const ok = await uiConfirm({
      title: t('cleanup.run'),
      message: t('cleanup.confirm', { size: formatBytesSize(pickedBytes) }),
      confirmText: t('cleanup.run'),
    });
    if (!ok) return;
    setRunning(true);
    try {
      const res = await runCleanup(keys);
      toast(t('cleanup.done', { size: formatBytesSize(res.totalBytes) }), 'success');
      const failed = (res.results || []).reduce((sum, r) => sum + (r.failed || []).length, 0);
      if (failed > 0) toast(t('cleanup.failedCount', { n: failed }), 'warning');
      await handleScan();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setRunning(false);
    }
  }

  return (
    <GlassModal
      title={t('cleanup.title')}
      subtitle={t('cleanup.subtitle')}
      open={open}
      onClose={onClose}
      maxWidth="max-w-2xl"
    >
      {scanning && items.length === 0 ? (
        <LoadingState message={t('cleanup.scanning')} />
      ) : (
        <>
          <div className="space-y-3">
            {items.map((item) => {
              const Icon = CATEGORY_ICONS[item.key] || Trash2;
              const empty = !item.bytes;
              const active = Boolean(selected[item.key]) && !empty;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => !empty && toggle(item.key)}
                  disabled={empty || running}
                  className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
                    active ? 'border-cyan-400/50 bg-cyan-500/10' : 'border-white/10 bg-white/5 hover:bg-white/10'
                  } ${empty ? 'opacity-50' : ''}`}
                >
                  <span
                    className={`flex h-4 w-4 flex-none items-center justify-center rounded border ${
                      active ? 'border-cyan-400 bg-cyan-400/20 text-cyan-200' : 'border-white/25'
                    }`}
                  >
                    {active && <Check className="h-3 w-3" />}
                  </span>
                  <Icon className="h-4 w-4 flex-none text-cyan-300" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{t(`cleanup.${item.key}`)}</span>
                    <span className="block text-xs text-white/45">{t(`cleanup.${item.key}Desc`)}</span>
                  </span>
                  <span className="flex-none text-right">
                    <span className="block text-sm font-medium">
                      {empty ? t('cleanup.nothing') : formatBytesSize(item.bytes)}
                    </span>
                    {!empty && (
                      <span className="block text-xs text-white/45">
                        {t('cleanup.items', { n: item.count })}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          {items.some((item) => item.samples?.length) && (
            <div className="mt-4 space-y-2 rounded-xl border border-white/10 bg-white/5 p-3">
              {items
                .filter((item) => item.samples?.length)
                .map((item) => (
                  <div key={item.key} className="text-xs">
                    <span className="text-white/50">{t(`cleanup.${item.key}`)}</span>
                    {item.samples.map((sample) => (
                      <div key={sample.path} className="mt-1 flex items-center gap-2 font-mono text-white/70">
                        <span className="min-w-0 flex-1 truncate" title={sample.path}>{sample.path}</span>
                        <span className="flex-none text-white/40">{formatBytesSize(sample.bytes)}</span>
                      </div>
                    ))}
                  </div>
                ))}
            </div>
          )}

          <p className="mt-4 text-xs text-white/45">{t('cleanup.retainNote', { days: retainDays })}</p>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
            <span className="text-xs text-white/55">
              {t('cleanup.selectHint', { n: picked.length, size: formatBytesSize(pickedBytes) })}
            </span>
            <div className="flex items-center gap-3">
              <LiquidButton onClick={handleScan} disabled={scanning || running} className="!px-4 !py-1.5 !text-xs">
                <RefreshCw className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`} /> {t('cleanup.rescan')}
              </LiquidButton>
              <LiquidButton
                onClick={handleRun}
                disabled={!picked.length || running || scanning}
                variant="danger"
                className="!px-4 !py-1.5 !text-xs"
              >
                <Trash2 className="h-4 w-4" /> {running ? t('cleanup.running') : t('cleanup.run')}
              </LiquidButton>
            </div>
          </div>
        </>
      )}
    </GlassModal>
  );
}