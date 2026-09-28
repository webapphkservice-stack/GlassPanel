import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import GlassModal from '@/components/common/GlassModal';
import LiquidButton from '@/components/common/LiquidButton';
import LoadingState from '@/components/common/LoadingState';
import { getSiteTraffic, enableSiteLog } from '@/api/nginx';
import { formatBytesSize } from '@/utils/format';
import { Activity, Download, AlertTriangle, RefreshCw } from '@/components/common/Icons';
import { useUIStore } from '@/components/common/uiStore';

// 请求数为 0 的小时也渲染一根极低的底柱，保证柱状图视觉连续
const MIN_BAR_PERCENT = 2;
// 横轴仅在这些下标处标注小时，避免 24 个标签拥挤
const AXIS_TICKS = [0, 6, 12, 18, 23];

export default function SiteTrafficModal({ site, onClose }) {
  const { t, i18n } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const uiConfirm = useUIStore((s) => s.confirm);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const open = Boolean(site);

  useEffect(() => {
    if (!open || !site) return undefined;
    let cancelled = false;
    setLoading(true);
    setData(null);
    getSiteTraffic(site.name)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) toast(err?.message || String(err), 'error');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, site?.name]);

  // 存量站点补写独立访问日志指令：会修改站点配置并重载 Nginx，需二次确认
  async function handleEnableLog() {
    if (!site) return;
    const ok = await uiConfirm({
      title: t('nginx.trafficEnableLog'),
      message: t('nginx.trafficEnableLogConfirm', { name: site.serverName || site.name }),
      confirmText: t('common.confirm'),
    });
    if (!ok) return;
    setEnabling(true);
    try {
      const res = await enableSiteLog(site.name);
      if (res.injected === false) {
        toast(t('nginx.trafficEnableLogExists'), 'info');
      } else {
        toast(t('nginx.trafficEnableLogDone'), 'success');
        // 刚开始记录，24 小时内数据可能很少甚至为 0，属预期行为
        const fresh = await getSiteTraffic(site.name);
        setData(fresh);
      }
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setEnabling(false);
    }
  }

  const locale = i18n.language;
  const available = data?.available === true;
  const hourly = data?.hourly || [];
  const maxRequests = hourly.reduce((max, h) => Math.max(max, h.requests || 0), 0);

  const cards = [
    { key: 'requests', Icon: Activity, label: t('nginx.trafficRequests'), value: data?.total?.requests ?? 0, cls: 'text-cyan-300' },
    { key: 'bytes', Icon: Download, label: t('nginx.trafficBytes'), value: formatBytesSize(data?.total?.bytes ?? 0), cls: 'text-emerald-300' },
    { key: 'errors', Icon: AlertTriangle, label: t('nginx.trafficErrors'), value: data?.total?.errors ?? 0, cls: 'text-rose-300' },
  ];

  return (
    <GlassModal
      open={open}
      onClose={onClose}
      maxWidth="max-w-3xl"
      title={t('nginx.trafficTitle', { name: site?.serverName || site?.name || '' })}
      subtitle={t('nginx.trafficSubtitle')}
    >
      {loading ? (
        <LoadingState />
      ) : !available ? (
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-none text-amber-300" />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium text-amber-100">{t('nginx.trafficNoLog')}</p>
              <p className="text-xs text-amber-100/80">{t('nginx.trafficNoLogHint')}</p>
              {data?.expectedLogPath && (
                <p className="break-all font-mono text-xs text-amber-100/60">
                  {t('nginx.trafficLogPath', { path: data.expectedLogPath })}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <LiquidButton
                  onClick={handleEnableLog}
                  disabled={enabling}
                  className="!px-4 !py-1.5 !text-xs"
                >
                  <RefreshCw className={`w-4 h-4 ${enabling ? 'animate-spin' : ''}`} />
                  {t('nginx.trafficEnableLog')}
                </LiquidButton>
                <span className="text-xs text-amber-100/70">{t('nginx.trafficEnableLogHint')}</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* 统计卡 */}
          <div className="grid gap-3 sm:grid-cols-3">
            {cards.map(({ key, Icon, label, value, cls }) => (
              <div key={key} className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
                <div className={`flex items-center gap-2 text-xs text-white/50 ${cls}`}>
                  <Icon className="h-4 w-4" />
                  <span className="text-white/50">{label}</span>
                </div>
                <p className="mt-2 text-xl font-semibold text-white/90">{value}</p>
              </div>
            ))}
          </div>

          {/* 24 小时柱状图 */}
          <div>
            <p className="mb-2 text-xs text-white/50">{t('nginx.trafficHourly')}</p>
            <div className="flex h-44 items-end gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-3">
              {hourly.map((h) => {
                const requests = h.requests || 0;
                const percent = maxRequests > 0
                  ? Math.max((requests / maxRequests) * 100, MIN_BAR_PERCENT)
                  : MIN_BAR_PERCENT;
                const time = new Date(h.ts).toLocaleString(locale);
                const title = requests === 0
                  ? `${time}｜${t('nginx.trafficEmptyHour')}`
                  : `${time}｜${t('nginx.trafficRequests')} ${requests}｜${t('nginx.trafficBytes')} ${formatBytesSize(h.bytes)}`;
                return (
                  <div key={h.ts} className="flex h-full flex-1 flex-col justify-end" title={title}>
                    <div
                      className={`w-full rounded-t ${
                        requests === 0
                          ? 'bg-white/15'
                          : 'bg-gradient-to-t from-cyan-500/40 to-cyan-300/80'
                      }`}
                      style={{ height: `${percent}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-1 flex gap-1 px-3">
              {hourly.map((h, idx) => (
                <span key={h.ts} className="flex-1 text-center text-[10px] text-white/35">
                  {AXIS_TICKS.includes(idx) ? String(new Date(h.ts).getHours()).padStart(2, '0') : ''}
                </span>
              ))}
            </div>
          </div>

          {/* 日志说明 */}
          <div className="space-y-1">
            <p className="break-all text-xs text-white/40">
              {t('nginx.trafficLogPath', { path: data.logPath || '-' })}
            </p>
            {data.truncated && <p className="text-xs text-amber-300">{t('nginx.trafficTruncated')}</p>}
          </div>
        </div>
      )}
    </GlassModal>
  );
}