import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCertificates, issueCertificate, renewCertificate, deleteCertificate } from '@/api/ssl';
import GlassCard from '@/components/common/GlassCard';
import LiquidButton from '@/components/common/LiquidButton';
import GlassModal from '@/components/common/GlassModal';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import { Lock, Key, Plus, RefreshCw, Trash, Check } from '@/components/common/Icons';
import { useUIStore } from '@/components/common/uiStore';

export default function Ssl() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const uiConfirm = useUIStore((s) => s.confirm);
  const [certificates, setCertificates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [issueOpen, setIssueOpen] = useState(false);
  const [domain, setDomain] = useState('');
  const [email, setEmail] = useState('');

  async function fetchData() {
    try {
      const data = await getCertificates();
      setCertificates(data.certificates || []);
    } catch (err) {
      console.error(err);
    }
  }

  useEffect(() => {
    setInitialLoading(true);
    fetchData().finally(() => setInitialLoading(false));
  }, []);

  async function handleIssue(e) {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await issueCertificate(domain, email);
      toast(result.success ? t('ssl.issueSuccess') : t('ssl.issueFailed', { error: result.output?.stderr || result.output?.stdout || '' }), result.success ? 'success' : 'error');
      if (result.success) {
        setIssueOpen(false);
        setDomain('');
        setEmail('');
        await fetchData();
      }
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleRenew(domain) {
    setLoading(true);
    try {
      const result = await renewCertificate(domain);
      toast(result.success ? t('ssl.renewSuccess') : t('ssl.renewFailed', { error: result.output?.stderr || result.output?.stdout || '' }), result.success ? 'success' : 'error');
      await fetchData();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(domain) {
    if (!(await uiConfirm({ title: t('common.pleaseConfirm'), message: t('ssl.deleteConfirm', { domain }) }))) return;
    setLoading(true);
    try {
      await deleteCertificate(domain);
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
            <h2 className="text-lg font-semibold">{t('ssl.certList')}</h2>
            <p className="mt-1 text-sm text-white/60">{t('ssl.certCount', { count: certificates.length })}</p>
          </div>
          <LiquidButton onClick={() => setIssueOpen(true)}>
            <Plus className="w-4 h-4" /> {t('ssl.applyCert')}
          </LiquidButton>
        </div>
      </GlassCard>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {certificates.map((cert) => (
          <GlassCard key={cert.domain}>
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-emerald-500/10 p-2 text-emerald-300">
                  <Lock className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-semibold">{cert.domain}</h3>
                  <p className="text-xs text-white/50">{cert.subject || cert.domain}</p>
                </div>
              </div>
              {cert.autoRenew && <span className="rounded-full bg-cyan-500/10 px-2 py-0.5 text-xs text-cyan-300">{t('ssl.autoRenew')}</span>}
            </div>
            <div className="mt-4 space-y-2 text-sm text-white/70">
              <div className="flex justify-between"><span>{t('ssl.validUntil')}</span><span>{cert.expiresAt || '-'}</span></div>
              <div className="flex justify-between"><span>{t('ssl.issuedAt')}</span><span>{cert.issuedAt || '-'}</span></div>
              <div className="truncate text-xs text-white/40">{cert.certPath}</div>
            </div>
            <div className="mt-4 flex gap-2">
              <LiquidButton onClick={() => handleRenew(cert.domain)} disabled={loading} variant="ghost" className="flex-1">
                <RefreshCw className="w-4 h-4" /> {t('ssl.renew')}
              </LiquidButton>
              <LiquidButton onClick={() => handleDelete(cert.domain)} disabled={loading} variant="danger" className="flex-1">
                <Trash className="w-4 h-4" /> {t('common.delete')}
              </LiquidButton>
            </div>
          </GlassCard>
        ))}
        {certificates.length === 0 && (
          <GlassCard className="md:col-span-2 lg:col-span-3">
            <EmptyState message={t('ssl.noCerts')} />
          </GlassCard>
        )}
      </div>

      <GlassModal title={t('ssl.applyCertModalTitle')} open={issueOpen} onClose={() => setIssueOpen(false)}>
        <form onSubmit={handleIssue} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-white/70">{t('ssl.domainPlaceholder')}</label>
            <input required value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400" />
          </div>
          <div>
            <label className="mb-1 block text-sm text-white/70">{t('ssl.emailPlaceholder')}</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@example.com" className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400" />
          </div>
          <p className="text-xs text-white/50">{t('ssl.applyHint')}</p>
          <div className="flex justify-end gap-3 pt-2">
            <LiquidButton type="button" onClick={() => setIssueOpen(false)} variant="ghost">{t('common.cancel')}</LiquidButton>
            <LiquidButton type="submit" disabled={loading}><Check className="w-4 h-4" /> {t('ssl.apply')}</LiquidButton>
          </div>
        </form>
      </GlassModal>
    </div>
  );
}