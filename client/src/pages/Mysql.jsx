import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getMysqlStatus, controlMysql, resetDbPassword, deleteMysqlDatabase } from '@/api/mysql';
import GlassCard from '@/components/common/GlassCard';
import LiquidButton from '@/components/common/LiquidButton';
import StatusBadge from '@/components/common/StatusBadge';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import {
  Play, Square, RefreshCw, Database, Plus, Package, Copy, KeyRound, Eye, EyeOff, Trash2,
} from '@/components/common/Icons';
import { useUIStore } from '@/components/common/uiStore';
import CreateDatabaseModal from '@/components/mysql/CreateDatabaseModal';
import DbBackupModal from '@/components/mysql/DbBackupModal';

export default function Mysql() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const [data, setData] = useState({ status: 'unknown', info: '', databases: [] });
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const uiConfirm = useUIStore((s) => s.confirm);
  const [createOpen, setCreateOpen] = useState(false);
  // 当前打开备份弹窗的数据库名，空串表示未打开
  const [backupDb, setBackupDb] = useState('');
  // 已切换为明文显示的密码，键为库名
  const [revealed, setRevealed] = useState({});
  // 正在重置密码的库名
  const [resetting, setResetting] = useState('');
  // 正在删除的库名
  const [deleting, setDeleting] = useState('');

  async function fetchData() {
    try {
      const d = await getMysqlStatus();
      setData(d);
    } catch (err) {
      console.error(err);
    }
  }

  useEffect(() => {
    setInitialLoading(true);
    fetchData().finally(() => setInitialLoading(false));
  }, []);

  async function handleControl(action) {
    setLoading(true);
    try {
      await controlMysql(action);
      await fetchData();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast(t('mysql.copied'), 'success');
    } catch (err) {
      toast(t('mysql.copyFailed'), 'error');
    }
  }

  // 存量库密码未记录（MySQL 内只有哈希），重置后由面板保存并显示
  async function handleResetPassword(db) {
    const ok = await uiConfirm({
      title: t('mysql.resetPassword'),
      message: t('mysql.resetPasswordConfirm', { name: db.name, user: db.user }),
      confirmText: t('mysql.resetPassword'),
    });
    if (!ok) return;
    setResetting(db.name);
    try {
      const res = await resetDbPassword(db.name);
      // 刚重置的密码直接明文展示，便于立即复制
      setRevealed((prev) => ({ ...prev, [db.name]: true }));
      toast(t('mysql.resetPasswordDone', { name: res.dbName }), 'success');
      await fetchData();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setResetting('');
    }
  }

  // 删除数据库：连同同名用户删除，库内数据不可恢复；站点关联的库额外告警
  async function handleDelete(db) {
    const ok = await uiConfirm({
      title: t('mysql.dropDatabase'),
      message: `${
        db.site ? `${t('mysql.dropDatabaseSiteWarn', { site: db.site })}\n\n` : ''
      }${t('mysql.dropDatabaseConfirm', { name: db.name, user: db.user })}`,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    setDeleting(db.name);
    try {
      await deleteMysqlDatabase(db.name);
      // 库已删除，清掉其明文展示标记，避免同名的库后续被默认明文显示
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[db.name];
        return next;
      });
      toast(t('mysql.dropDatabaseDone', { name: db.name }), 'success');
      await fetchData();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setDeleting('');
    }
  }

  if (initialLoading) return <LoadingState />;

  return (
    <div className="space-y-6">
      <GlassCard>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('mysql.status')}</h2>
            <div className="mt-2">
              <StatusBadge status={data.status} />
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <LiquidButton onClick={() => handleControl('start')} disabled={loading} variant="success">
              <Play className="w-4 h-4" /> {t('common.start')}
            </LiquidButton>
            <LiquidButton onClick={() => handleControl('stop')} disabled={loading} variant="danger">
              <Square className="w-4 h-4" /> {t('common.stop')}
            </LiquidButton>
            <LiquidButton onClick={() => handleControl('restart')} disabled={loading}>
              <RefreshCw className="w-4 h-4" /> {t('common.restart')}
            </LiquidButton>
          </div>
        </div>
        {data.info && (
          <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-white/70 font-mono">
            {data.info}
          </div>
        )}
      </GlassCard>

      <GlassCard>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{t('mysql.databases')}</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-white/50">{t('mysql.dbCount', { count: data.databases.length })}</span>
            <LiquidButton
              onClick={() => setCreateOpen(true)}
              disabled={data.status !== 'active'}
              className="!px-4 !py-1.5 !text-xs"
            >
              <Plus className="h-4 w-4" /> {t('mysql.create')}
            </LiquidButton>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.databases.map((db) => {
            const shown = Boolean(revealed[db.name]);
            return (
              <div key={db.name} className="space-y-2 rounded-xl border border-white/10 bg-white/5 p-3 transition-colors hover:bg-white/10">
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 flex-none text-cyan-300" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium" title={db.name}>{db.name}</span>
                </div>
                {/* 操作行独立成行：三个按钮在窄卡片下自动换行，不挤压库名 */}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleResetPassword(db)}
                    disabled={resetting === db.name}
                    title={t('mysql.resetPassword')}
                    className="flex flex-none items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] text-white/70 transition-colors hover:bg-white/15 hover:text-white disabled:opacity-40"
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    {t('mysql.resetPassword')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setBackupDb(db.name)}
                    title={t('mysql.backup')}
                    className="flex flex-none items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300 transition-colors hover:bg-amber-500/20"
                  >
                    <Package className="h-3.5 w-3.5" />
                    {t('mysql.backup')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(db)}
                    disabled={deleting === db.name}
                    title={t('mysql.dropDatabase')}
                    className="flex flex-none items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-[11px] text-rose-300 transition-colors hover:bg-rose-500/20 disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('mysql.dropDatabase')}
                  </button>
                </div>

                <div className="space-y-1 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="w-10 flex-none text-white/40">{t('mysql.user')}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-white/80" title={db.user}>{db.user}</span>
                    <button
                      type="button"
                      onClick={() => copyText(db.user)}
                      title={t('mysql.copy')}
                      className="rounded-full border border-white/15 bg-white/5 p-1 text-white/60 transition-colors hover:bg-white/15 hover:text-white"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-10 flex-none text-white/40">{t('mysql.password')}</span>
                    {db.password ? (
                      <>
                        <span className="min-w-0 flex-1 truncate font-mono text-white/80" title={shown ? db.password : ''}>
                          {shown ? db.password : '••••••••••'}
                        </span>
                        <button
                          type="button"
                          onClick={() => setRevealed((prev) => ({ ...prev, [db.name]: !shown }))}
                          title={shown ? t('mysql.hidePassword') : t('mysql.showPassword')}
                          className="rounded-full border border-white/15 bg-white/5 p-1 text-white/60 transition-colors hover:bg-white/15 hover:text-white"
                        >
                          {shown ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => copyText(db.password)}
                          title={t('mysql.copy')}
                          className="rounded-full border border-white/15 bg-white/5 p-1 text-white/60 transition-colors hover:bg-white/15 hover:text-white"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate text-amber-300/80">{t('mysql.passwordUnrecorded')}</span>
                        <span className="flex-none text-white/30" title={t('mysql.passwordUnrecordedHint')}>?</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {data.databases.length === 0 && <EmptyState message={t('common.noDatabase')} className="col-span-full" />}
        </div>
      </GlassCard>

      <CreateDatabaseModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={fetchData}
      />
      <DbBackupModal db={backupDb || null} onClose={() => setBackupDb('')} />
    </div>
  );
}