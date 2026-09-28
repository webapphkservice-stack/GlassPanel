import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store';
import { login, verifyTotp } from '@/api/auth';
import GlassCard from '@/components/common/GlassCard';
import LiquidButton from '@/components/common/LiquidButton';
import { Lock, Server, KeyRound, ArrowLeft, Globe, Check } from '@/components/common/Icons';
import i18n from '@/i18n';

const LANGUAGES = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en', label: 'English' },
];

export default function Login() {
  const { t, i18n: i18nInstance } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [tempToken, setTempToken] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [step, setStep] = useState('credentials'); // credentials | totp
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { token, setAuth } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (token) navigate('/', { replace: true });
  }, [token, navigate]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    if (!username || !password) {
      setError(t('login.enterCredentials'));
      return;
    }
    setLoading(true);
    try {
      const data = await login(username, password);
      if (data.requiresTotp && data.tempToken) {
        setTempToken(data.tempToken);
        setStep('totp');
        setLoading(false);
        return;
      }
      localStorage.setItem('panel_token', data.token);
      setAuth(data.token, data.user);
      navigate('/', { replace: true });
    } catch (err) {
      setError(typeof err === 'string' ? err : t('login.loginFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyTotp = async (e) => {
    e.preventDefault();
    setError('');
    if (!code) {
      setError(t('login.enterCode', { type: useRecovery ? t('login.recoveryCode') : t('login.totpCode') }));
      return;
    }
    setLoading(true);
    try {
      const data = await verifyTotp(tempToken, code);
      localStorage.setItem('panel_token', data.token);
      setAuth(data.token, data.user);
      navigate('/', { replace: true });
    } catch (err) {
      setError(typeof err === 'string' ? err : t('login.codeError'));
    } finally {
      setLoading(false);
    }
  };

  const backToCredentials = () => {
    setStep('credentials');
    setTempToken('');
    setCode('');
    setError('');
    setUseRecovery(false);
  };

  const currentLang = i18nInstance.language || 'zh-CN';

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* 语言切换 */}
        <div className="mb-4 flex items-center justify-center gap-1">
          <Globe className="h-4 w-4 text-white/40" />
          {LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              onClick={() => i18n.changeLanguage(lang.code)}
              className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${
                currentLang === lang.code
                  ? 'bg-cyan-500/20 text-cyan-300'
                  : 'text-white/40 hover:text-white/70 hover:bg-white/5'
              }`}
            >
              {lang.label}
            </button>
          ))}
        </div>

        <GlassCard className="relative overflow-hidden" hover={false}>
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-400/30 to-cyan-500/30 backdrop-blur-md border border-white/20">
              <Server className="h-8 w-8 text-cyan-300" />
            </div>
            <h1 className="text-2xl font-bold">{t('login.title')}</h1>
            <p className="mt-2 text-sm text-white/60">{t('login.subtitle')}</p>
          </div>

          {step === 'credentials' ? (
            <form onSubmit={handleLogin} className="space-y-5">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-white/80">{t('login.username')}</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder-white/40 backdrop-blur-md transition-colors focus:border-cyan-400/50 focus:bg-white/10"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-white/80">{t('login.password')}</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder-white/40 backdrop-blur-md transition-colors focus:border-cyan-400/50 focus:bg-white/10"
                />
              </div>

              {error && (
                <div className="rounded-lg bg-rose-500/10 px-4 py-2.5 text-sm text-rose-300 border border-rose-500/20">
                  {error}
                </div>
              )}

              <LiquidButton type="submit" disabled={loading} className="w-full">
                <Lock className="w-4 h-4" />
                {loading ? t('login.loggingIn') : t('login.login')}
              </LiquidButton>
            </form>
          ) : (
            <form onSubmit={handleVerifyTotp} className="space-y-5">
              <button
                type="button"
                onClick={backToCredentials}
                className="flex items-center gap-1 text-sm text-white/50 hover:text-white/80 transition-colors"
              >
                <ArrowLeft className="w-4 h-4" /> {t('login.backToCredentials')}
              </button>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-white/80">
                  {useRecovery ? t('login.recoveryCode') : t('login.totpCode')}
                </label>
                <input
                  type="text"
                  inputMode={useRecovery ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder-white/40 backdrop-blur-md transition-colors focus:border-cyan-400/50 focus:bg-white/10"
                  placeholder={useRecovery ? t('login.recoveryCodePlaceholder') : t('login.totpCodePlaceholder')}
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  id="use-recovery"
                  type="checkbox"
                  checked={useRecovery}
                  onChange={(e) => {
                    setUseRecovery(e.target.checked);
                    setCode('');
                  }}
                  className="h-4 w-4 rounded border-white/20 bg-white/5 text-cyan-400 focus:ring-cyan-400/50"
                />
                <label htmlFor="use-recovery" className="text-sm text-white/70">
                  {t('login.useRecovery')}
                </label>
              </div>

              {error && (
                <div className="rounded-lg bg-rose-500/10 px-4 py-2.5 text-sm text-rose-300 border border-rose-500/20">
                  {error}
                </div>
              )}

              <LiquidButton type="submit" disabled={loading} className="w-full">
                <KeyRound className="w-4 h-4" />
                {loading ? t('login.verifying') : t('login.verifyAndLogin')}
              </LiquidButton>
            </form>
          )}
        </GlassCard>
      </div>
    </div>
  );
}