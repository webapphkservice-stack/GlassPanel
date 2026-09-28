import React from 'react';
import { useTranslation } from 'react-i18next';
import GlassModal from '@/components/common/GlassModal';
import LiquidButton from '@/components/common/LiquidButton';
import {
  Folder,
  ShieldCheck,
  Database,
  Clock,
  RefreshCw,
  Check,
  X,
  Ban,
} from '@/components/common/Icons';

// 步骤顺序需与后端 nginxService.PROVISION_STEPS 一致
const STEP_DEFS = [
  { key: 'directory', labelKey: 'nginx.provisionStepDirectory', Icon: Folder },
  { key: 'ssl', labelKey: 'nginx.provisionStepSsl', Icon: ShieldCheck },
  { key: 'database', labelKey: 'nginx.provisionStepDatabase', Icon: Database },
];

// 步骤状态视觉：等待中 / 进行中 / 完成 / 失败 / 已跳过
const STATE_STYLE = {
  pending: { Icon: Clock, labelKey: 'nginx.provisionStatePending', cls: 'text-white/45' },
  running: { Icon: RefreshCw, labelKey: 'nginx.provisionStateRunning', cls: 'text-cyan-300', spin: true },
  done: { Icon: Check, labelKey: 'nginx.provisionStateDone', cls: 'text-emerald-300' },
  failed: { Icon: X, labelKey: 'nginx.provisionStateFailed', cls: 'text-rose-300' },
  skipped: { Icon: Ban, labelKey: 'nginx.provisionStateSkipped', cls: 'text-white/35' },
};

function StepItem({ def, step, isLast }) {
  const { t } = useTranslation();
  const state = step?.state || 'pending';
  const style = STATE_STYLE[state] || STATE_STYLE.pending;
  const StateIcon = style.Icon;
  const { Icon } = def;

  // 跳过原因由后端给出（disabled=未勾选 / blocked=前置步骤失败）
  const message = state === 'skipped'
    ? t(step?.skippedReason === 'blocked' ? 'nginx.provisionSkippedBlocked' : 'nginx.provisionSkippedDisabled')
    : String(step?.message || '');

  const dimmed = state === 'pending' || state === 'skipped';

  return (
    <li className="flex gap-4">
      <div className="flex flex-none flex-col items-center">
        <span
          className={`
            flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.06]
            ${state === 'running' ? 'ring-1 ring-cyan-400/40' : ''}
            ${dimmed ? 'opacity-60' : ''}
          `}
        >
          <Icon className={`h-4 w-4 ${state === 'running' ? 'text-cyan-300' : 'text-white/70'}`} />
        </span>
        {!isLast && <span className="mt-1 w-px flex-1 bg-white/10" />}
      </div>
      <div className={`min-w-0 flex-1 pb-5 ${dimmed ? 'opacity-60' : ''}`}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-white/90">{t(def.labelKey)}</span>
          <span className={`flex items-center gap-1.5 text-xs ${style.cls}`}>
            <StateIcon className={`h-3.5 w-3.5 ${style.spin ? 'animate-spin' : ''}`} />
            {t(style.labelKey)}
          </span>
        </div>
        {message && <p className="mt-1 break-words text-xs text-white/50">{message}</p>}
      </div>
    </li>
  );
}

export default function ProvisionFlowModal({
  open,
  onClose,
  form,
  snapshot,
  postError,
  connLost,
  expired,
  onViewFiles,
}) {
  const { t } = useTranslation();
  const status = snapshot?.status;
  const result = snapshot?.result || null;
  const steps = snapshot?.steps || STEP_DEFS.map((def) => ({ key: def.key, state: 'pending', message: '' }));
  const stepMap = new Map(steps.map((step) => [step.key, step]));
  const warnings = snapshot?.warnings || [];
  const running = !expired && !connLost && (status === undefined || status === 'running');
  const hasRoot = Boolean(result?.root);

  return (
    <GlassModal
      open={open}
      onClose={onClose}
      maxWidth="max-w-lg"
      title={t('nginx.provisionTitle')}
      subtitle={t('nginx.provisionSubtitle', { name: form?.name || '', domain: form?.serverName || '' })}
    >
      <ol className="mt-1">
        {STEP_DEFS.map((def, index) => (
          <StepItem
            key={def.key}
            def={def}
            step={stepMap.get(def.key)}
            isLast={index === STEP_DEFS.length - 1}
          />
        ))}
      </ol>

      {running && (
        <p className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-xs text-white/55">
          {t('nginx.provisionRunningHint')}
        </p>
      )}

      {expired && (
        <p className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-xs text-amber-200">
          {t('nginx.provisionExpired')}
        </p>
      )}

      {connLost && (
        <p className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-xs text-amber-200">
          {t('nginx.provisionConnLost')}
        </p>
      )}

      {!running && status === 'failed' && (
        <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3">
          <p className="text-sm font-medium text-rose-200">{t('nginx.provisionFailedTitle')}</p>
          <p className="mt-1 break-words text-xs text-rose-100/80">{snapshot?.error || postError || ''}</p>
        </div>
      )}

      {!running && status === undefined && postError && (
        <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3">
          <p className="text-sm font-medium text-rose-200">{t('nginx.provisionFailedTitle')}</p>
          <p className="mt-1 break-words text-xs text-rose-100/80">{postError}</p>
        </div>
      )}

      {status === 'done' && (
        <div
          className={`
            rounded-2xl border px-4 py-3
            ${warnings.length > 0
              ? 'border-amber-400/20 bg-amber-400/10'
              : 'border-emerald-400/20 bg-emerald-400/10'}
          `}
        >
          <p className={`text-sm font-medium ${warnings.length > 0 ? 'text-amber-200' : 'text-emerald-200'}`}>
            {warnings.length > 0 ? t('nginx.provisionPartialTitle') : t('nginx.provisionSuccessTitle')}
          </p>
          <ul className="mt-2 space-y-1 text-xs text-white/70">
            {result?.root && <li>{t('nginx.provisionResultRoot', { path: result.root })}</li>}
            {result?.defaultPage && <li>{t('nginx.defaultPage', { path: result.defaultPage })}</li>}
            {result?.ssl?.success && <li>{t('nginx.provisionResultSsl', { domain: result.ssl.domain })}</li>}
            {result?.database?.password && (
              <li>
                {t('nginx.dbCreated', {
                  dbName: result.database.dbName,
                  user: result.database.user,
                  password: result.database.password,
                })}
              </li>
            )}
          </ul>
          {warnings.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-amber-100/80">
              {warnings.map((item) => (
                <li key={item} className="break-words">· {item}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-5 flex justify-end gap-3">
        {status === 'done' ? (
          <>
            <LiquidButton variant="ghost" onClick={onClose} className="!px-5 !py-2 text-sm">
              {t('common.close')}
            </LiquidButton>
            {hasRoot && (
              <LiquidButton onClick={() => onViewFiles?.(result.name)} className="!px-5 !py-2 text-sm">
                {t('nginx.provisionViewFiles')}
              </LiquidButton>
            )}
          </>
        ) : (
          !running && (
            <LiquidButton variant="ghost" onClick={onClose} className="!px-5 !py-2 text-sm">
              {t('common.close')}
            </LiquidButton>
          )
        )}
      </div>
    </GlassModal>
  );
}