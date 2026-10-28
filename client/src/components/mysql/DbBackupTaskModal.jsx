import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import GlassModal from '@/components/common/GlassModal';
import LiquidButton from '@/components/common/LiquidButton';
import { createDbBackupTask, updateDbBackupTask } from '@/api/mysql';
import { Check } from '@/components/common/Icons';
import { useUIStore } from '@/components/common/uiStore';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];

function splitTime(value) {
  const [hour, minute] = String(value || '03:00').split(':');
  const h = Number(hour);
  const m = Number(minute);
  return {
    hour: Number.isInteger(h) && h >= 0 && h <= 23 ? h : 3,
    minute: Number.isInteger(m) && m >= 0 && m <= 59 ? m : 0,
  };
}

// 新建/编辑数据库定时备份任务
export default function DbBackupTaskModal({ open, onClose, onSaved, databases = [], task = null }) {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const [databaseName, setDatabaseName] = useState('');
  const [frequency, setFrequency] = useState('daily');
  const [time, setTime] = useState('03:00');
  const [weekday, setWeekday] = useState(1);
  const [keepCount, setKeepCount] = useState(7);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDatabaseName(task?.databaseName || databases[0] || '');
    setFrequency(task?.frequency || 'daily');
    const { hour, minute } = splitTime(
      task ? `${String(task.hour ?? 3).padStart(2, '0')}:${String(task.minute ?? 0).padStart(2, '0')}` : '03:00'
    );
    setTime(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    setWeekday(task?.weekday ?? 1);
    setKeepCount(task?.keepCount ?? 7);
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task]);

  async function handleSubmit() {
    if (!databaseName || saving) return;
    const { hour, minute } = splitTime(time);
    const payload = {
      databaseName,
      frequency,
      // 每小时任务只需要分钟位，小时位固定为 0
      hour: frequency === 'hourly' ? 0 : hour,
      minute: frequency === 'hourly' ? Number(time.split(':')[1] || 0) : minute,
      weekday: Number(weekday),
      keepCount: Number(keepCount),
    };
    setSaving(true);
    try {
      if (task) {
        await updateDbBackupTask(task.id, payload);
        toast(t('mysql.backupTaskSaved'), 'success');
      } else {
        await createDbBackupTask(payload);
        toast(t('mysql.backupTaskCreated'), 'success');
      }
      onSaved?.();
      onClose?.();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  const selectClass = 'w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-400';
  const labelClass = 'space-y-1.5';

  return (
    <GlassModal
      open={open}
      onClose={onClose}
      maxWidth="max-w-xl"
      title={task ? t('mysql.editBackupTask') : t('mysql.newBackupTask')}
      subtitle={t('mysql.backupTaskSubtitle')}
    >
      <div className="space-y-4">
        <div className={labelClass}>
          <label className="text-xs text-white/50">{t('mysql.backupTaskDatabase')}</label>
          <select
            value={databaseName}
            onChange={(e) => setDatabaseName(e.target.value)}
            className={selectClass}
          >
            {databases.map((name) => (
              <option key={name} value={name} className="bg-gray-900 text-white">{name}</option>
            ))}
          </select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className={labelClass}>
            <label className="text-xs text-white/50">{t('mysql.backupTaskFrequency')}</label>
            <select
              value={frequency}
              onChange={(e) => setFrequency(e.target.value)}
              className={selectClass}
            >
              <option value="hourly" className="bg-gray-900 text-white">{t('mysql.freqHourlyShort')}</option>
              <option value="daily" className="bg-gray-900 text-white">{t('mysql.freqDailyShort')}</option>
              <option value="weekly" className="bg-gray-900 text-white">{t('mysql.freqWeeklyShort')}</option>
            </select>
          </div>

          <div className={labelClass}>
            <label className="text-xs text-white/50">
              {frequency === 'hourly' ? t('mysql.backupTaskMinute') : t('mysql.backupTaskTime')}
            </label>
            {frequency === 'hourly' ? (
              <select
                value={Number(time.split(':')[1] || 0)}
                onChange={(e) => setTime(`00:${String(e.target.value).padStart(2, '0')}`)}
                className={selectClass}
              >
                {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                  <option key={m} value={m} className="bg-gray-900 text-white">
                    {String(m).padStart(2, '0')}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value || '03:00')}
                className={selectClass}
              />
            )}
          </div>
        </div>

        {frequency === 'weekly' && (
          <div className={labelClass}>
            <label className="text-xs text-white/50">{t('mysql.backupTaskWeekday')}</label>
            <select
              value={Number(weekday)}
              onChange={(e) => setWeekday(Number(e.target.value))}
              className={selectClass}
            >
              {WEEKDAYS.map((value) => (
                <option key={value} value={value} className="bg-gray-900 text-white">
                  {t(`mysql.weekday${value}`)}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className={labelClass}>
          <label className="text-xs text-white/50">{t('mysql.backupTaskKeep')}</label>
          <input
            type="number"
            min={1}
            max={60}
            value={keepCount}
            onChange={(e) => setKeepCount(e.target.value)}
            className={selectClass}
          />
          <p className="text-[11px] text-white/40">{t('mysql.backupTaskKeepHint')}</p>
        </div>

        <p className="text-[11px] text-white/40">{t('mysql.backupTaskTimezoneHint')}</p>

        <div className="flex items-center justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/80 transition-colors hover:bg-white/10"
          >
            {t('common.cancel')}
          </button>
          <LiquidButton onClick={handleSubmit} disabled={!databaseName || saving} className="!px-5 !py-2 !text-sm">
            <Check className="h-4 w-4" />
            {saving ? t('common.saving') : t('common.save')}
          </LiquidButton>
        </div>
      </div>
    </GlassModal>
  );
}
