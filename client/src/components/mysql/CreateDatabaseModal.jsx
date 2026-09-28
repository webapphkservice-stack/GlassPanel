import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import GlassModal from '@/components/common/GlassModal';
import LiquidButton from '@/components/common/LiquidButton';
import { createMysqlDatabase } from '@/api/mysql';
import { Database, KeyRound, Copy, Plus } from '@/components/common/Icons';
import { useUIStore } from '@/components/common/uiStore';

// 与后端 mysqlService.normalizeName 的规则保持一致，仅用于输入时预览派生结果
function deriveName(domain) {
  return String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

export default function CreateDatabaseModal({ open, onClose, onCreated }) {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const [domain, setDomain] = useState('');
  const [creating, setCreating] = useState(false);
  // 创建成功后展示一次的凭据：密码不再从任何接口返回
  const [created, setCreated] = useState(null);

  const dbName = deriveName(domain);

  function handleClose() {
    setDomain('');
    setCreated(null);
    setCreating(false);
    onClose();
  }

  async function handleSubmit() {
    if (!dbName || creating) return;
    setCreating(true);
    try {
      const res = await createMysqlDatabase(domain);
      setCreated(res);
      toast(t('mysql.createDone', { name: res.dbName }), 'success');
      onCreated?.();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setCreating(false);
    }
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast(t('mysql.copied'), 'success');
    } catch (err) {
      toast(t('mysql.copyFailed'), 'error');
    }
  }

  const rows = created
    ? [
        { key: 'db', Icon: Database, label: t('mysql.createDbName'), value: created.dbName },
        { key: 'user', Icon: Database, label: t('mysql.createUser'), value: created.user },
        { key: 'pwd', Icon: KeyRound, label: t('mysql.createPassword'), value: created.password },
      ]
    : [];

  return (
    <GlassModal
      open={open}
      onClose={handleClose}
      maxWidth="max-w-xl"
      title={t('mysql.createTitle')}
      subtitle={t('mysql.createSubtitle')}
    >
      {created ? (
        <div className="space-y-4">
          <p className="text-xs text-amber-300">{t('mysql.createCredentialHint')}</p>
          <div className="space-y-2">
            {rows.map(({ key, Icon, label, value }) => (
              <div
                key={key}
                className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5"
              >
                <Icon className="h-4 w-4 flex-none text-cyan-300" />
                <span className="w-20 flex-none text-xs text-white/50">{label}</span>
                <span className="min-w-0 flex-1 break-all font-mono text-sm text-white/90">{value}</span>
                <button
                  type="button"
                  onClick={() => copy(value)}
                  title={t('mysql.copy')}
                  className="rounded-full border border-white/15 bg-white/5 p-1.5 text-white/70 transition-colors hover:bg-white/15 hover:text-white"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <LiquidButton onClick={handleClose} className="!px-5 !py-2 !text-sm">
              {t('common.close')}
            </LiquidButton>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-white/50">{t('mysql.createDomain')}</label>
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder={t('mysql.createDomainPlaceholder')}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-400"
            />
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
            <p className="text-xs text-white/50">{t('mysql.createPreview')}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 font-mono text-sm">
              <span className="text-white/40">
                {t('mysql.createDbName')}：<span className="text-white/90">{dbName || '-'}</span>
              </span>
              <span className="text-white/40">
                {t('mysql.createUser')}：<span className="text-white/90">{dbName || '-'}</span>
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-white/40">{t('mysql.createPasswordHint')}</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/80 transition-colors hover:bg-white/10"
              >
                {t('common.cancel')}
              </button>
              <LiquidButton
                onClick={handleSubmit}
                disabled={!dbName || creating}
                className="!px-5 !py-2 !text-sm"
              >
                <Plus className="h-4 w-4" />
                {creating ? t('mysql.createCreating') : t('mysql.createSubmit')}
              </LiquidButton>
            </div>
          </div>
        </div>
      )}
    </GlassModal>
  );
}