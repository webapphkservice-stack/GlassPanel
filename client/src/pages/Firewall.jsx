import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getFirewallStatus, getFirewallRules, addFirewallRule, removeFirewallRule, controlFirewall } from '@/api/firewall';
import GlassCard from '@/components/common/GlassCard';
import LiquidButton from '@/components/common/LiquidButton';
import StatusBadge from '@/components/common/StatusBadge';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import { Shield, ShieldCheck, Plus, Trash, Play, Square } from '@/components/common/Icons';
import { useUIStore } from '@/components/common/uiStore';

export default function Firewall() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const uiConfirm = useUIStore((s) => s.confirm);
  const [status, setStatus] = useState({ backend: 'unknown', active: false });
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [port, setPort] = useState('');
  const [protocol, setProtocol] = useState('tcp');

  async function fetchData() {
    try {
      const s = await getFirewallStatus();
      setStatus(s);
      const r = await getFirewallRules();
      setRules(r.rules || []);
    } catch (err) {
      console.error(err);
    }
  }

  useEffect(() => {
    setInitialLoading(true);
    fetchData().finally(() => setInitialLoading(false));
  }, []);

  async function handleControl(action) {
    const confirmed = await uiConfirm({
      title: action === 'enable' ? t('firewall.enableFirewall') : t('firewall.disableFirewall'),
      message: action === 'enable' ? t('firewall.enableFirewallConfirm') : t('firewall.disableFirewallConfirm'),
    });
    if (!confirmed) return;
    setLoading(true);
    try {
      await controlFirewall(action);
      toast(t(action === 'enable' ? 'firewall.firewallEnabled' : 'firewall.firewallDisabled'), 'success');
      await fetchData();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd(e) {
    e.preventDefault();
    setLoading(true);
    try {
      await addFirewallRule({ port, protocol, action: 'allow' });
      setPort('');
      await fetchData();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleRemove(id) {
    if (!(await uiConfirm({ title: t('common.pleaseConfirm'), message: t('firewall.deleteConfirm') }))) return;
    setLoading(true);
    try {
      await removeFirewallRule(id);
      await fetchData();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  if (initialLoading) return <LoadingState />;

  return (
    <div className="space-y-6">
      <GlassCard>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('firewall.status')}</h2>
            <div className="mt-2 flex items-center gap-3">
              <StatusBadge status={status.active ? 'active' : 'inactive'} />
              <span className="text-sm text-white/60">{t('firewall.backend', { name: status.backend })}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <LiquidButton onClick={() => handleControl('enable')} disabled={loading} variant="success">
              <ShieldCheck className="w-4 h-4" /> {t('firewall.enable')}
            </LiquidButton>
            <LiquidButton onClick={() => handleControl('disable')} disabled={loading} variant="danger">
              <Square className="w-4 h-4" /> {t('firewall.disable')}
            </LiquidButton>
          </div>
        </div>
      </GlassCard>

      <div className="grid gap-6 lg:grid-cols-3">
        <GlassCard className="lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-cyan-300" />
              <h2 className="text-lg font-semibold">{t('firewall.rules')}</h2>
            </div>
            <span className="text-xs text-white/50">{t('firewall.ruleCount', { count: rules.length })}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 text-white/50">
                  <th className="pb-3 font-medium">{t('firewall.port')}</th>
                  <th className="pb-3 font-medium">{t('firewall.protocol')}</th>
                  <th className="pb-3 font-medium">{t('firewall.action')}</th>
                  <th className="pb-3 font-medium">{t('firewall.source')}</th>
                  <th className="pb-3 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id} className="border-b border-white/5 last:border-0">
                    <td className="py-3 font-medium">{rule.port}</td>
                    <td className="py-3 text-white/70">{rule.protocol}</td>
                    <td className="py-3"><span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-300 capitalize">{rule.action}</span></td>
                    <td className="py-3 text-white/70">{rule.from}</td>
                    <td className="py-3 text-right">
                      <button onClick={() => handleRemove(rule.id)} className="rounded-lg p-1.5 hover:bg-white/10 text-white/60" title={t('common.delete')}><Trash className="w-4 h-4" /></button>
                    </td>
                  </tr>
                ))}
                {rules.length === 0 && (
                  <tr><td colSpan={5}><EmptyState message={t('common.noRules')} /></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </GlassCard>

        <GlassCard>
          <h2 className="mb-4 text-lg font-semibold">{t('firewall.addRule')}</h2>
          <form onSubmit={handleAdd} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm text-white/70">{t('firewall.port')}</label>
              <input required value={port} onChange={(e) => setPort(e.target.value)} placeholder="例如 8080 或 1000:2000" className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400" />
            </div>
            <div>
              <label className="mb-1 block text-sm text-white/70">{t('firewall.protocol')}</label>
              <select value={protocol} onChange={(e) => setProtocol(e.target.value)} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400">
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
                <option value="any">Any</option>
              </select>
            </div>
            <LiquidButton type="submit" disabled={loading} className="w-full justify-center">
              <Plus className="w-4 h-4" /> {t('common.add')}
            </LiquidButton>
          </form>
        </GlassCard>
      </div>
    </div>
  );
}