import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getSystemInfo, getServiceStatuses } from '@/api/system';
import GlassCard from '@/components/common/GlassCard';
import StatusBadge from '@/components/common/StatusBadge';
import EmptyState from '@/components/common/EmptyState';
import { Cpu, Database, HardDrive, Clock, Activity, Network, ArrowUp, ArrowDown } from '@/components/common/Icons';
import { formatUptime, formatBytesSize, formatSpeed } from '@/utils/format';

function StatCard({ icon: Icon, label, value, subtext }) {
  return (
    <GlassCard>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-white/60">{label}</p>
          <p className="mt-2 text-3xl font-bold">{value}</p>
          {subtext && <p className="mt-1 text-xs text-white/50">{subtext}</p>}
        </div>
        <div className="rounded-xl bg-white/5 p-3">
          <Icon className="h-6 w-6 text-cyan-300" />
        </div>
      </div>
    </GlassCard>
  );
}

function NetStat({ icon: Icon, label, value, subtext }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-white/60">
        {Icon && <Icon className="h-4 w-4 text-cyan-300" />}
        {label}
      </div>
      <p className="mt-2 text-xl font-semibold">{value}</p>
      {subtext && <p className="mt-1 text-xs text-white/45">{subtext}</p>}
    </div>
  );
}

export default function Dashboard() {
  const { t } = useTranslation();
  const [info, setInfo] = useState(null);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function fetchData() {
      try {
        const [sys, svc] = await Promise.all([getSystemInfo(), getServiceStatuses()]);
        if (mounted) {
          setInfo(sys);
          setServices(svc.services);
        }
      } catch (err) {
        console.error(err);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    fetchData();
    return () => { mounted = false; };
  }, []);

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center text-white/60">
        <Activity className="mr-2 h-5 w-5 animate-spin" />
        {t('common.loading')}
      </div>
    );
  }

  const rootDisk = info?.disk?.[0];
  const net = info?.network || { available: false, up: 0, down: 0, sent: 0, received: 0 };

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Cpu}
          label={t('dashboard.cpuUsage')}
          value={`${info?.cpu?.usage ?? 0}%`}
          subtext={info?.cpuModel}
        />
        <StatCard
          icon={Database}
          label={t('dashboard.memoryUsage')}
          value={`${info?.memory?.percent ?? 0}%`}
          subtext={`${info?.memory?.used ?? 0} / ${info?.memory?.total ?? 0} GB`}
        />
        <StatCard
          icon={HardDrive}
          label={t('dashboard.diskUsage')}
          value={rootDisk ? `${rootDisk.percent}%` : '--'}
          subtext={rootDisk ? `${rootDisk.used} / ${rootDisk.size}` : t('dashboard.noData')}
        />
        <StatCard
          icon={Clock}
          label={t('dashboard.uptime')}
          value={info?.uptime ? formatUptime(info.uptime) : '--'}
          subtext={info?.hostname}
        />
      </div>

      <GlassCard>
        <div className="mb-4 flex items-center gap-2">
          <Network className="h-5 w-5 text-cyan-300" />
          <h2 className="text-lg font-semibold">{t('dashboard.network')}</h2>
        </div>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <NetStat
            icon={ArrowUp}
            label={t('dashboard.upload')}
            value={net.available ? formatSpeed(net.up) : '--'}
            subtext={t('dashboard.uploadRealtime')}
          />
          <NetStat
            icon={ArrowDown}
            label={t('dashboard.download')}
            value={net.available ? formatSpeed(net.down) : '--'}
            subtext={t('dashboard.downloadRealtime')}
          />
          <NetStat
            label={t('dashboard.sent')}
            value={net.available ? formatBytesSize(net.sent) : '--'}
            subtext={t('dashboard.sentTotal')}
          />
          <NetStat
            label={t('dashboard.received')}
            value={net.available ? formatBytesSize(net.received) : '--'}
            subtext={t('dashboard.receivedTotal')}
          />
        </div>
      </GlassCard>

      <GlassCard>
        <div className="mb-4 flex items-center gap-2">
          <Cpu className="h-5 w-5 text-cyan-300" />
          <h2 className="text-lg font-semibold">{t('dashboard.cpuDetail')}</h2>
        </div>
        <div className="grid gap-3 text-sm text-white/70 md:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 break-words">
            <span className="text-white/50">{t('dashboard.model')}</span>
            {info?.cpuModel}
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
            <span className="text-white/50">{t('dashboard.cores')}</span>
            {info?.cpuCount} {t('dashboard.core')}
          </div>
        </div>
        <div className="mt-4">
          <div className="grid gap-2 md:grid-cols-4">
            {(info?.cpus || []).map((cpu, idx) => (
              <div key={idx} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs">
                <span className="text-white/50">{t('dashboard.core')} {idx + 1}</span>
                <span className="ml-2 text-white/70">{cpu.speed ? `${cpu.speed} MHz` : '--'}</span>
              </div>
            ))}
          </div>
        </div>
      </GlassCard>

      <div className="grid gap-6 lg:grid-cols-3">
        <GlassCard className="lg:col-span-2">
          <h2 className="mb-4 text-lg font-semibold">{t('dashboard.loadAverage')}</h2>
          <div className="space-y-3">
            {info?.loadAverage?.map((load, idx) => (
              <div key={idx} className="flex items-center gap-4">
                <span className="w-16 text-sm text-white/60">
                  {idx === 0 ? t('dashboard.1min') : idx === 1 ? t('dashboard.5min') : t('dashboard.15min')}
                </span>
                <div className="flex-1 rounded-full bg-white/5 h-2.5">
                  <div
                    className="h-2.5 rounded-full bg-gradient-to-r from-cyan-400 to-cyan-500"
                    style={{ width: `${Math.min(load * 10, 100)}%` }}
                  />
                </div>
                <span className="w-16 text-right text-sm font-medium">{load.toFixed(2)}</span>
              </div>
            )) || <EmptyState message={t('common.noData')} />}
          </div>
        </GlassCard>

        <GlassCard>
          <h2 className="mb-4 text-lg font-semibold">{t('dashboard.serviceStatus')}</h2>
          <div className="space-y-3">
            {services.map((svc) => (
              <div key={svc.name} className="flex items-center justify-between">
                <span className="text-sm font-medium capitalize">{svc.name}</span>
                <StatusBadge status={svc.status} />
              </div>
            ))}
            {services.length === 0 && <EmptyState message={t('common.noServiceData')} />}
          </div>
        </GlassCard>
      </div>

      <GlassCard>
        <h2 className="mb-2 text-lg font-semibold">{t('dashboard.envInfo')}</h2>
        <div className="grid gap-4 text-sm text-white/70 md:grid-cols-3">
          <div>
            <span className="text-white/50">{t('dashboard.os')}</span>
            {info?.platform} {info?.arch}
          </div>
          <div>
            <span className="text-white/50">{t('dashboard.cpuCores')}</span>
            {info?.cpuCount} {t('dashboard.core')}
          </div>
          <div>
            <span className="text-white/50">{t('dashboard.hostname')}</span>
            {info?.hostname}
          </div>
        </div>
      </GlassCard>
    </div>
  );
}