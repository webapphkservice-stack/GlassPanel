import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getFail2banStatus, controlFail2ban, unbanFail2banIp,
  getFail2banServices, saveFail2banServices,
  getFail2banSites, saveFail2banSite,
  getFail2banWhitelist, addFail2banWhitelist, removeFail2banWhitelist, refreshFail2banAutoIps,
  getFail2banBlacklist, addFail2banBlacklist, removeFail2banBlacklist,
} from '@/api/fail2ban';
import GlassCard from '@/components/common/GlassCard';
import LiquidButton from '@/components/common/LiquidButton';
import StatusBadge from '@/components/common/StatusBadge';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import {
  Play, Square, RefreshCw, Trash, Plus, Shield, Lock, Ban,
} from '@/components/common/Icons';
import { useUIStore } from '@/components/common/uiStore';

const TABS = [
  { key: 'status', labelKey: 'fail2ban.status' },
  { key: 'sites', labelKey: 'fail2ban.siteProtection' },
  { key: 'services', labelKey: 'fail2ban.serviceProtection' },
  { key: 'whitelist', labelKey: 'fail2ban.whitelist' },
  { key: 'blacklist', labelKey: 'fail2ban.blacklist' },
];

const inputCls =
  'rounded-lg border border-white/10 bg-gray-900/60 px-3 py-2 text-sm text-white/90 outline-none focus:border-cyan-300/50';
const chipCls = 'rounded-full border px-3 py-1 text-xs transition-colors';

export default function Fail2ban() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const uiConfirm = useUIStore((s) => s.confirm);

  const [activeTab, setActiveTab] = useState('status');
  const [initialLoading, setInitialLoading] = useState(true);
  const [loading, setLoading] = useState(false);

  const [status, setStatus] = useState(null);
  const [services, setServices] = useState(null);
  const [serviceForm, setServiceForm] = useState({});
  const [sites, setSites] = useState(null);
  const [siteForm, setSiteForm] = useState({});
  const [whitelist, setWhitelist] = useState(null);
  const [whiteInput, setWhiteInput] = useState({ ip: '', note: '' });
  const [blacklist, setBlacklist] = useState(null);
  const [blackInput, setBlackInput] = useState({ ip: '', note: '' });

  async function loadStatus() {
    try {
      setStatus(await getFail2banStatus());
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  async function loadServices() {
    try {
      const data = await getFail2banServices();
      setServices(data);
      const form = {};
      for (const item of data.items || []) form[item.key] = item.enabled;
      setServiceForm(form);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  async function loadSites() {
    try {
      const data = await getFail2banSites();
      setSites(data);
      const form = {};
      for (const item of data.items || []) {
        form[item.name] = { enabled: item.enabled, filters: { ...item.filters } };
      }
      setSiteForm(form);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  async function loadWhitelist() {
    try {
      setWhitelist(await getFail2banWhitelist());
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  async function loadBlacklist() {
    try {
      setBlacklist(await getFail2banBlacklist());
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  async function loadTab(tab) {
    setLoading(true);
    try {
      if (tab === 'status') await loadStatus();
      else if (tab === 'services') await loadServices();
      else if (tab === 'sites') await loadSites();
      else if (tab === 'whitelist') await loadWhitelist();
      else if (tab === 'blacklist') await loadBlacklist();
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let mounted = true;
    (async () => {
      await Promise.all([loadStatus(), loadServices()]);
      if (mounted) setInitialLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  async function handleControl(action) {
    setLoading(true);
    try {
      const res = await controlFail2ban(action);
      toast(res.success ? t('fail2ban.controlSuccess', { action }) : t('fail2ban.controlFailed', { action }), res.success ? 'success' : 'error');
      await loadStatus();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleUnban(jail, ip) {
    try {
      await unbanFail2banIp(jail, ip);
      toast(t('fail2ban.ipUnbanned', { ip }), 'success');
      loadStatus();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  async function saveServices() {
    setLoading(true);
    try {
      const res = await saveFail2banServices(serviceForm);
      toast(res.reloaded ? t('fail2ban.servicesSavedReloaded') : t('fail2ban.servicesSavedNoReload'), res.reloaded ? 'success' : 'error');
      await Promise.all([loadServices(), loadStatus()]);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function saveSite(name, enabled) {
    const form = siteForm[name] || { enabled: false, filters: {} };
    const label = sites?.items?.find((s) => s.name === name);
    const ok = await uiConfirm({
      title: enabled ? t('fail2ban.enableSiteProtection') : t('fail2ban.disableSiteProtection'),
      message: enabled
        ? t('fail2ban.enableSiteMsg', { name: label?.serverName || name })
        : t('fail2ban.disableSiteMsg', { name: label?.serverName || name }),
      confirmText: enabled ? t('common.enable') : t('common.disable'),
    });
    if (!ok) return;
    setLoading(true);
    try {
      const res = await saveFail2banSite(name, enabled, form.filters || {});
      toast(res.reloaded ? t('fail2ban.siteProtectionApplied') : t('fail2ban.siteProtectionSaved'), res.reloaded ? 'success' : 'error');
      await Promise.all([loadSites(), loadStatus()]);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function addWhite() {
    try {
      await addFail2banWhitelist(whiteInput.ip, whiteInput.note);
      toast(t('fail2ban.ipAdded'), 'success');
      setWhiteInput({ ip: '', note: '' });
      await Promise.all([loadWhitelist(), loadStatus()]);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  async function removeWhite(ip) {
    const ok = await uiConfirm({
      title: t('fail2ban.removeFromWhitelist'),
      message: t('fail2ban.removeWhiteMsg', { ip }),
      confirmText: t('fail2ban.remove'),
    });
    if (!ok) return;
    try {
      await removeFail2banWhitelist(ip);
      toast(t('fail2ban.ipRemovedFromWhitelist', { ip }), 'success');
      await Promise.all([loadWhitelist(), loadStatus()]);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  async function refreshAuto() {
    try {
      const res = await refreshFail2banAutoIps();
      toast(t('fail2ban.autoRefreshDone', { count: (res.autoIps || []).length }), 'success');
      await Promise.all([loadWhitelist(), loadStatus()]);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  async function addBlack() {
    try {
      await addFail2banBlacklist(blackInput.ip, blackInput.note);
      toast(t('fail2ban.blacklisted'), 'success');
      setBlackInput({ ip: '', note: '' });
      await Promise.all([loadBlacklist(), loadStatus()]);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  async function removeBlack(ip) {
    const ok = await uiConfirm({
      title: t('fail2ban.removeBan'),
      message: t('fail2ban.unbanConfirm', { ip }),
      confirmText: t('fail2ban.unban'),
    });
    if (!ok) return;
    try {
      await removeFail2banBlacklist(ip);
      toast(t('fail2ban.ipUnbanned', { ip }), 'success');
      await Promise.all([loadBlacklist(), loadStatus()]);
    } catch (err) {
      toast(err?.message || String(err), 'error');
    }
  }

  if (initialLoading) return <LoadingState message={t('fail2ban.loadingStatus')} />;

  const statusActive = status?.status === 'active';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white/90">Fail2ban</h1>
          <p className="mt-1 text-sm text-white/50">{t('fail2ban.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={status?.status || 'unknown'} />
          {status?.version && <span className="text-xs text-white/50">v{status.version}</span>}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => {
              setActiveTab(tab.key);
              loadTab(tab.key);
            }}
            className={`
              rounded-full px-4 py-2 text-sm transition-all
              ${activeTab === tab.key
                ? 'bg-gradient-to-r from-cyan-500/30 to-cyan-400/30 border border-white/20 text-white'
                : 'bg-white/5 border border-white/10 text-white/60 hover:bg-white/10'}
            `}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {/* 服务状态 */}
      {activeTab === 'status' && (
        <div className="space-y-4">
          <GlassCard hover={false}>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Shield className="h-6 w-6 text-cyan-300" />
                <div>
                  <div className="text-sm font-medium text-white/90">{t('fail2ban.serviceLabel')}</div>
                  <div className="text-xs text-white/50">
                    {status?.version ? t('fail2ban.versionLabel', { version: status.version }) : t('fail2ban.versionUnknown')}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <LiquidButton variant="success" onClick={() => handleControl('start')} disabled={loading || statusActive}>
                  <Play className="h-4 w-4" />{t('common.start')}
                </LiquidButton>
                <LiquidButton variant="danger" onClick={() => handleControl('stop')} disabled={loading || !statusActive}>
                  <Square className="h-4 w-4" />{t('common.stop')}
                </LiquidButton>
                <LiquidButton variant="ghost" onClick={() => handleControl('restart')} disabled={loading}>
                  <RefreshCw className="h-4 w-4" />{t('common.restart')}
                </LiquidButton>
                <LiquidButton variant="ghost" onClick={() => handleControl('reload')} disabled={loading || !statusActive}>
                  <RefreshCw className="h-4 w-4" />{t('common.reload')}
                </LiquidButton>
              </div>
            </div>
            {status?.defaults && (
              <div className="mt-5 flex flex-wrap items-center gap-2 text-xs text-white/60">
                <span className={chipCls + ' border-white/10 bg-white/5'}>{t('fail2ban.banTimeLabel', { time: status.defaults.bantime })}</span>
                <span className={chipCls + ' border-white/10 bg-white/5'}>{t('fail2ban.findTimeLabel', { time: status.defaults.findtime })}</span>
                <span className={chipCls + ' border-white/10 bg-white/5'}>{t('fail2ban.maxRetryLabel', { count: status.defaults.maxretry })}</span>
                <span className={chipCls + ' border-white/10 bg-white/5'}>
                  {t('fail2ban.blacklistJailLabel', { jail: status.defaults.blacklistJail })}
                </span>
              </div>
            )}
          </GlassCard>

          {!statusActive ? (
            <GlassCard hover={false}>
              <EmptyState message={t('fail2ban.serviceNotRunning')} />
            </GlassCard>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {(status?.jails || []).map((jail) => (
                <GlassCard key={jail.name} hover={false}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <Lock className="h-4 w-4 text-cyan-300" />
                        <span className="text-sm font-medium text-white/90">{jail.name}</span>
                      </div>
                      <div className="mt-1 text-xs text-white/50">{jail.filter || '—'}</div>
                      <div className="mt-1 break-all text-xs text-white/40">{jail.logpath || '—'}</div>
                    </div>
                    <div className="text-right text-xs text-white/60">
                      <div>{t('fail2ban.currentlyBanned')} <span className="text-white/90">{jail.currentlyBanned}</span></div>
                      <div>{t('fail2ban.totalBanned')} <span className="text-white/90">{jail.totalBanned}</span></div>
                    </div>
                  </div>
                  {jail.bannedIps.length > 0 ? (
                    <div className="mt-4 space-y-2">
                      {jail.bannedIps.map((ip) => (
                        <div key={ip} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                          <span className="font-mono text-xs text-white/80">{ip}</span>
                          <button
                            onClick={() => handleUnban(jail.name, ip)}
                            className="rounded-full border border-rose-400/30 bg-rose-500/10 px-3 py-1 text-xs text-rose-200 hover:bg-rose-500/20"
                          >
                            {t('fail2ban.unban')}
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-3 text-xs text-white/40">{t('fail2ban.noBannedIps')}</div>
                  )}
                </GlassCard>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 站点保护 */}
      {activeTab === 'sites' && (
        <div className="space-y-4">
          {loading && !sites ? (
            <LoadingState message={t('fail2ban.loadingSites')} />
          ) : (sites?.items || []).length === 0 ? (
            <GlassCard hover={false}>
              <EmptyState message={t('fail2ban.noSites')} />
            </GlassCard>
          ) : (
            sites.items.map((site) => {
              const form = siteForm[site.name] || { enabled: false, filters: {} };
              return (
                <GlassCard key={site.name} hover={false}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-white/90">{site.serverName || site.name}</div>
                      <div className="mt-1 break-all text-xs text-white/40">{site.file}</div>
                      <div className="mt-1 text-xs text-white/50">
                        {site.logsInjected ? t('fail2ban.logInjected') : t('fail2ban.logNotInjected')}
                      </div>
                    </div>
                    <span
                      className={`${chipCls} ${
                        form.enabled
                          ? 'border-emerald-500/30 bg-emerald-500/20 text-emerald-200'
                          : 'border-white/10 bg-white/5 text-white/50'
                      }`}
                    >
                      {form.enabled ? t('common.enable') : t('common.disable')}
                    </span>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    {(sites.filterOptions || []).map((opt) => {
                      const active = !!form.filters?.[opt.key];
                      return (
                        <button
                          key={opt.key}
                          onClick={() =>
                            setSiteForm({
                              ...siteForm,
                              [site.name]: {
                                ...form,
                                filters: { ...form.filters, [opt.key]: !active },
                              },
                            })
                          }
                          className={`
                            ${chipCls}
                            ${active
                              ? 'border-cyan-300/40 bg-cyan-500/20 text-cyan-100'
                              : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10'}
                          `}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <LiquidButton
                      variant={form.enabled ? 'ghost' : 'success'}
                      onClick={() => saveSite(site.name, true)}
                      disabled={loading}
                    >
                      <Shield className="h-4 w-4" />{form.enabled ? t('fail2ban.saveFilters') : t('common.enable')}
                    </LiquidButton>
                    <LiquidButton
                      variant="danger"
                      onClick={() => saveSite(site.name, false)}
                      disabled={loading || !form.enabled}
                    >
                      <Square className="h-4 w-4" />{t('common.disable')}
                    </LiquidButton>
                  </div>
                </GlassCard>
              );
            })
          )}
        </div>
      )}

      {/* 服务保护 */}
      {activeTab === 'services' && (
        <div className="space-y-4">
          {loading && !services ? (
            <LoadingState message={t('fail2ban.loadingServices')} />
          ) : (
            <>
              <GlassCard hover={false}>
                <div className="space-y-3">
                  {(services?.items || []).map((item) => (
                    <div
                      key={item.key}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3"
                    >
                      <div>
                        <div className="text-sm text-white/90">{item.label}</div>
                        <div className="mt-1 text-xs text-white/40">
                          filter {item.filter} · {item.logpath} · port {item.port}
                        </div>
                      </div>
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-white/70">
                        <input
                          type="checkbox"
                          checked={!!serviceForm[item.key]}
                          onChange={(e) => setServiceForm({ ...serviceForm, [item.key]: e.target.checked })}
                        />
                        {t('common.enable')}
                      </label>
                    </div>
                  ))}
                </div>
                <div className="mt-4">
                  <LiquidButton onClick={saveServices} disabled={loading}>
                    <Shield className="h-4 w-4" />{t('common.saveAndApply')}
                  </LiquidButton>
                </div>
              </GlassCard>
            </>
          )}
        </div>
      )}

      {/* IP 白名单 */}
      {activeTab === 'whitelist' && (
        <div className="space-y-4">
          <GlassCard hover={false}>
            <div className="text-sm font-medium text-white/90">{t('fail2ban.addWhitelist')}</div>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                className={inputCls}
                placeholder={t('fail2ban.ipPlaceholder')}
                value={whiteInput.ip}
                onChange={(e) => setWhiteInput({ ...whiteInput, ip: e.target.value })}
              />
              <input
                className={inputCls}
                placeholder={t('fail2ban.noteOptional')}
                value={whiteInput.note}
                onChange={(e) => setWhiteInput({ ...whiteInput, note: e.target.value })}
              />
              <LiquidButton onClick={addWhite} disabled={loading || !whiteInput.ip}>
                <Plus className="h-4 w-4" />{t('common.add')}
              </LiquidButton>
              <LiquidButton variant="ghost" onClick={refreshAuto}>
                <RefreshCw className="h-4 w-4" />{t('fail2ban.refreshAutoIps')}
              </LiquidButton>
            </div>
            <div className="mt-2 text-xs text-white/40">
              {t('fail2ban.autoIpsHint')}
            </div>
          </GlassCard>

          {loading && !whitelist ? (
            <LoadingState message={t('fail2ban.loadingWhitelist')} />
          ) : (
            <GlassCard hover={false}>
              <div className="text-sm font-medium text-white/90">{t('fail2ban.builtinWhitelist')}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {(whitelist?.builtin || []).map((item) => (
                  <span key={item.ip} className={`${chipCls} border-white/10 bg-white/5 text-white/60`}>
                    {item.ip}
                  </span>
                ))}
              </div>

              <div className="mt-6 text-sm font-medium text-white/90">{t('fail2ban.manualWhitelist')}</div>
              {(whitelist?.items || []).length === 0 ? (
                <div className="mt-2 text-xs text-white/40">{t('fail2ban.noManualWhitelist')}</div>
              ) : (
                <div className="mt-3 space-y-2">
                  {whitelist.items.map((item) => (
                    <div key={item.ip} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                      <div>
                        <span className="font-mono text-xs text-white/80">{item.ip}</span>
                        {item.note && <span className="ml-3 text-xs text-white/40">{item.note}</span>}
                      </div>
                      <button
                        onClick={() => removeWhite(item.ip)}
                        className="rounded-full border border-rose-400/30 bg-rose-500/10 px-3 py-1 text-xs text-rose-200 hover:bg-rose-500/20"
                      >
                        {t('fail2ban.remove')}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-6 text-sm font-medium text-white/90">{t('fail2ban.autoIps')}</div>
              {(whitelist?.autoIps || []).length === 0 ? (
                <div className="mt-2 text-xs text-white/40">{t('fail2ban.noAutoIps')}</div>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  {whitelist.autoIps.map((ip) => (
                    <span key={ip} className={`${chipCls} border-white/10 bg-white/5 text-white/70`}>
                      {ip}
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-6 text-sm font-medium text-white/90">{t('fail2ban.currentIgnoreip')}</div>
              <pre className="mt-2 overflow-x-auto rounded-lg border border-white/10 bg-gray-900/60 p-3 text-xs text-white/70">
                {whitelist?.ignoreip || '—'}
              </pre>
            </GlassCard>
          )}
        </div>
      )}

      {/* IP 黑名单 */}
      {activeTab === 'blacklist' && (
        <div className="space-y-4">
          <GlassCard hover={false}>
            <div className="text-sm font-medium text-white/90">{t('fail2ban.addBlacklist')}</div>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                className={inputCls}
                placeholder={t('fail2ban.blackIpPlaceholder')}
                value={blackInput.ip}
                onChange={(e) => setBlackInput({ ...blackInput, ip: e.target.value })}
              />
              <input
                className={inputCls}
                placeholder={t('fail2ban.noteOptional')}
                value={blackInput.note}
                onChange={(e) => setBlackInput({ ...blackInput, note: e.target.value })}
              />
              <LiquidButton variant="danger" onClick={addBlack} disabled={loading || !blackInput.ip}>
                <Ban className="h-4 w-4" />{t('fail2ban.addBlacklist')}
              </LiquidButton>
            </div>
            <div className="mt-2 text-xs text-white/40">
              {t('fail2ban.blacklistHint')}
            </div>
          </GlassCard>

          <GlassCard hover={false}>
            {loading && !blacklist ? (
              <LoadingState message={t('fail2ban.loadingBlacklist')} />
            ) : (blacklist?.items || []).length === 0 ? (
              <EmptyState message={t('fail2ban.blacklistEmpty')} />
            ) : (
              <div className="space-y-2">
                {blacklist.items.map((item) => (
                  <div key={item.ip} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                    <div>
                      <span className="font-mono text-xs text-white/80">{item.ip}</span>
                      {item.note && <span className="ml-3 text-xs text-white/40">{item.note}</span>}
                      {item.addedAt && (
                        <span className="ml-3 text-xs text-white/30">
                          {new Date(item.addedAt).toLocaleString()}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => removeBlack(item.ip)}
                      className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-white/70 hover:bg-white/10"
                    >
                      <Trash className="mr-1 inline h-3 w-3" />{t('fail2ban.unban')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </GlassCard>
        </div>
      )}
    </div>
  );
}