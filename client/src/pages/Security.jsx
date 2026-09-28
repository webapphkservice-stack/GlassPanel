import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { useAuthStore } from '@/store';
import { getMe, setupTotp, confirmTotp, disableTotp, resetTotp } from '@/api/auth';
import GlassCard from '@/components/common/GlassCard';
import LiquidButton from '@/components/common/LiquidButton';
import GlassModal from '@/components/common/GlassModal';
import LoadingState from '@/components/common/LoadingState';
import { useUIStore } from '@/components/common/uiStore';
import { Shield, ShieldCheck, Copy, AlertTriangle, RefreshCw, Trash2 } from '@/components/common/Icons';

export default function Security() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useUIStore((s) => s.toast);
  const uiConfirm = useUIStore((s) => s.confirm);
  const { user, setAuth, clearAuth } = useAuthStore();

  const [loading, setLoading] = useState(true);
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [qrUrl, setQrUrl] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [setupOpen, setSetupOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pendingAction, setPendingAction] = useState(null); // confirm | disable | reset

  async function fetchStatus() {
    try {
      const data = await getMe();
      setTotpEnabled(data.user?.totpEnabled);
      setAuth(localStorage.getItem('panel_token'), data.user);
    } catch (err) {
      toast(t('security.fetchFailed'), 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchStatus();
  }, []);

  useEffect(() => {
    if (qrUrl) {
      QRCode.toDataURL(qrUrl, { width: 240, margin: 2 }).then(setQrDataUrl);
    } else {
      setQrDataUrl('');
    }
  }, [qrUrl]);

  async function handleSetup() {
    setLoading(true);
    try {
      const data = await setupTotp();
      setQrUrl(data.qrUrl);
      setRecoveryCodes(data.recoveryCodes || []);
      setSetupOpen(true);
      setPendingAction('confirm');
      setConfirmOpen(true);
      toast(t('security.scanQr'), 'info');
    } catch (err) {
      toast(err?.message || t('security.setupFailed'), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm() {
    if (!password || !code) {
      toast(t('security.passwordAndCodeRequired'), 'warning');
      return;
    }
    setLoading(true);
    try {
      await confirmTotp(password, code);
      setTotpEnabled(true);
      setConfirmOpen(false);
      setSetupOpen(false);
      setPassword('');
      setCode('');
      setRecoveryCodes([]);
      setQrUrl('');
      toast(t('security.totpEnabled'), 'success');
      await fetchStatus();
    } catch (err) {
      toast(typeof err === 'string' ? err : (err?.message || t('security.invalidCode')), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleDisable() {
    if (!password || !code) {
      toast(t('security.passwordAndCodeRequired'), 'warning');
      return;
    }
    const ok = await uiConfirm({
      title: t('security.disableTotp'),
      message: t('security.disableTotpMsg'),
      confirmText: t('security.confirmDisable'),
    });
    if (!ok) return;

    setLoading(true);
    try {
      await disableTotp(password, code);
      toast(t('security.totpDisabled'), 'success');
      await clearAuth();
      navigate('/login', { replace: true });
    } catch (err) {
      toast(typeof err === 'string' ? err : (err?.message || t('security.disableFailed')), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleReset() {
    if (!password || !code) {
      toast(t('security.passwordAndCodeRequired'), 'warning');
      return;
    }
    const ok = await uiConfirm({
      title: t('security.resetTotp'),
      message: t('security.resetTotpMsg'),
      confirmText: t('security.confirmReset'),
    });
    if (!ok) return;

    setLoading(true);
    try {
      const data = await resetTotp(password, code);
      setQrUrl(data.qrUrl);
      setRecoveryCodes(data.recoveryCodes || []);
      setTotpEnabled(false);
      setSetupOpen(true);
      setPendingAction('confirm');
      setConfirmOpen(true);
      toast(t('security.totpReset'), 'info');
      await clearAuth();
    } catch (err) {
      toast(typeof err === 'string' ? err : (err?.message || t('security.resetFailed')), 'error');
    } finally {
      setLoading(false);
    }
  }

  function copyCodes() {
    const text = recoveryCodes.join('\n');
    navigator.clipboard.writeText(text).then(() => toast(t('security.copied'), 'success'));
  }

  function closeConfirm() {
    setConfirmOpen(false);
    setPassword('');
    setCode('');
    if (pendingAction !== 'confirm') {
      setSetupOpen(false);
      setQrUrl('');
      setRecoveryCodes([]);
    }
  }

  const actionLabel = loading
    ? t('security.processing')
    : pendingAction === 'disable'
    ? t('security.confirmDisable')
    : pendingAction === 'reset'
    ? t('security.confirmReset')
    : t('security.confirmEnable');

  if (loading && !totpEnabled && !setupOpen) return <LoadingState />;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">{t('security.title')}</h2>

      <GlassCard>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className={`flex h-12 w-12 items-center justify-center rounded-xl border ${totpEnabled ? 'border-emerald-400/30 bg-emerald-500/10' : 'border-white/10 bg-white/5'}`}>
              {totpEnabled ? <ShieldCheck className="h-6 w-6 text-emerald-300" /> : <Shield className="h-6 w-6 text-white/60" />}
            </div>
            <div>
              <h3 className="font-medium">{t('security.totp')}</h3>
              <p className="text-sm text-white/50">
                {totpEnabled ? t('security.totpEnabledDesc') : t('security.totpDesc')}
              </p>
            </div>
          </div>
          <div className="flex gap-3">
            {totpEnabled ? (
              <>
                <LiquidButton variant="ghost" onClick={() => { setPendingAction('reset'); setConfirmOpen(true); }}>
                  <RefreshCw className="w-4 h-4" /> {t('security.resetTotp')}
                </LiquidButton>
                <LiquidButton variant="danger" onClick={() => { setPendingAction('disable'); setConfirmOpen(true); }}>
                  <Trash2 className="w-4 h-4" /> {t('security.disableTotp')}
                </LiquidButton>
              </>
            ) : (
              <LiquidButton onClick={handleSetup}>
                <ShieldCheck className="w-4 h-4" /> {t('common.enable')}
              </LiquidButton>
            )}
          </div>
        </div>
      </GlassCard>

      <GlassModal
        title={setupOpen ? t('security.bindAuthenticator') : t('security.verifyIdentity')}
        subtitle={setupOpen ? t('security.bindAuthenticatorSubtitle') : t('security.verifyIdentitySubtitle')}
        open={setupOpen || confirmOpen}
        onClose={closeConfirm}
      >
        <div className="space-y-5">
          {setupOpen && (
            <div className="flex flex-col items-center gap-4">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="TOTP QR Code" className="rounded-xl border border-white/10 bg-white p-2" />
              ) : (
                <div className="h-60 w-60 animate-pulse rounded-xl bg-white/5" />
              )}
              <div className="w-full rounded-xl border border-amber-400/20 bg-amber-500/10 p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-200">
                  <AlertTriangle className="h-4 w-4" /> {t('security.recoveryCodes')}
                </div>
                <div className="grid grid-cols-2 gap-2 font-mono text-xs text-white/80">
                  {recoveryCodes.map((c) => (
                    <div key={c} className="rounded bg-white/5 px-2 py-1.5 text-center">{c}</div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={copyCodes}
                  className="mt-3 flex items-center gap-1 text-xs text-cyan-300 hover:text-cyan-200"
                >
                  <Copy className="h-3.5 w-3.5" /> {t('security.copyAll')}
                </button>
              </div>
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-sm font-medium text-white/80">{t('security.enterPassword')}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-white/40 backdrop-blur-md transition-colors focus:border-cyan-400/50 focus:bg-white/10"
              placeholder={t('security.passwordPlaceholder')}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-white/80">
              {setupOpen ? t('security.authenticatorCode') : t('security.currentTotpCode')}
            </label>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-white/40 backdrop-blur-md transition-colors focus:border-cyan-400/50 focus:bg-white/10"
              placeholder={t('security.codePlaceholder')}
            />
          </div>

          <div className="flex gap-3">
            <LiquidButton variant="ghost" onClick={closeConfirm} className="flex-1">
              {t('common.cancel')}
            </LiquidButton>
            <LiquidButton
              onClick={pendingAction === 'disable' ? handleDisable : pendingAction === 'reset' ? handleReset : handleConfirm}
              disabled={loading}
              variant={pendingAction === 'disable' ? 'danger' : 'primary'}
              className="flex-1"
            >
              {actionLabel}
            </LiquidButton>
          </div>
        </div>
      </GlassModal>
    </div>
  );
}