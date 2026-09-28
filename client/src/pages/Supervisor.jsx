import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getSupervisorStatus,
  getSupervisorProcesses,
  controlSupervisorProcess,
  addSupervisorProgram,
  removeSupervisorProgram,
  addPm2Process,
} from '@/api/supervisor';
import GlassCard from '@/components/common/GlassCard';
import LiquidButton from '@/components/common/LiquidButton';
import StatusBadge from '@/components/common/StatusBadge';
import GlassModal from '@/components/common/GlassModal';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import { Play, Square, RefreshCw, Activity, Terminal, Plus, Trash } from '@/components/common/Icons';
import { useUIStore } from '@/components/common/uiStore';

export default function Supervisor() {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const uiConfirm = useUIStore((s) => s.confirm);
  const [status, setStatus] = useState('unknown');
  const [supervisorProcesses, setSupervisorProcesses] = useState([]);
  const [pm2Processes, setPm2Processes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [addSupervisorOpen, setAddSupervisorOpen] = useState(false);
  const [addPm2Open, setAddPm2Open] = useState(false);
  const [form, setForm] = useState({ name: '', command: '', directory: '', user: '', autostart: true, autorestart: true });
  const [pm2Form, setPm2Form] = useState({ name: '', script: '', cwd: '' });

  async function fetchData() {
    try {
      const s = await getSupervisorStatus();
      setStatus(s.status);
      const procs = await getSupervisorProcesses();
      setSupervisorProcesses(procs.supervisor || []);
      setPm2Processes(procs.pm2 || []);
    } catch (err) {
      console.error(err);
    }
  }

  useEffect(() => {
    setInitialLoading(true);
    fetchData().finally(() => setInitialLoading(false));
  }, []);

  async function handleControl(type, action, name) {
    setLoading(true);
    try {
      await controlSupervisorProcess(type, action, name);
      await fetchData();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleAddSupervisor(e) {
    e.preventDefault();
    setLoading(true);
    try {
      await addSupervisorProgram(form);
      setAddSupervisorOpen(false);
      setForm({ name: '', command: '', directory: '', user: '', autostart: true, autorestart: true });
      await fetchData();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleRemoveSupervisor(name) {
    if (!(await uiConfirm({ title: t('common.pleaseConfirm'), message: t('supervisor.deleteConfirm', { name }) }))) return;
    setLoading(true);
    try {
      await removeSupervisorProgram(name);
      await fetchData();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleAddPm2(e) {
    e.preventDefault();
    setLoading(true);
    try {
      await addPm2Process(pm2Form);
      setAddPm2Open(false);
      setPm2Form({ name: '', script: '', cwd: '' });
      await fetchData();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  function ProcessTable({ title, icon: Icon, processes, type }) {
    return (
      <GlassCard className="mt-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className="h-5 w-5 text-cyan-300" />
            <h2 className="text-lg font-semibold">{title}</h2>
          </div>
          <span className="text-xs text-white/50">{t('supervisor.processCount', { count: processes.length })}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-white/50">
                <th className="pb-3 font-medium">{t('supervisor.processName')}</th>
                <th className="pb-3 font-medium">{t('supervisor.processStatus')}</th>
                <th className="pb-3 font-medium">{t('supervisor.processDetail')}</th>
                <th className="pb-3 font-medium text-right">{t('supervisor.processActions')}</th>
              </tr>
            </thead>
            <tbody>
              {processes.map((p, idx) => (
                <tr key={idx} className="border-b border-white/5 last:border-0">
                  <td className="py-3 font-medium">{p.name}</td>
                  <td className="py-3"><StatusBadge status={p.state} /></td>
                  <td className="py-3 text-white/60 text-xs">{p.detail || `PID: ${p.pid || '-'} ${p.uptime ? new Date(p.uptime).toLocaleString() : ''}`}</td>
                  <td className="py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => handleControl(type, 'start', p.name)} className="rounded-lg p-1.5 hover:bg-white/10 text-emerald-300" title={t('common.start')}><Play className="w-4 h-4" /></button>
                      <button onClick={() => handleControl(type, 'stop', p.name)} className="rounded-lg p-1.5 hover:bg-white/10 text-rose-300" title={t('common.stop')}><Square className="w-4 h-4" /></button>
                      <button onClick={() => handleControl(type, 'restart', p.name)} className="rounded-lg p-1.5 hover:bg-white/10 text-cyan-300" title={t('common.restart')}><RefreshCw className="w-4 h-4" /></button>
                      {type === 'supervisor' && (
                        <button onClick={() => handleRemoveSupervisor(p.name)} className="rounded-lg p-1.5 hover:bg-white/10 text-white/60" title={t('common.delete')}><Trash className="w-4 h-4" /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {processes.length === 0 && (
                  <tr><td colSpan={4}><EmptyState message={t('supervisor.noProcesses')} /></td></tr>
                )}
            </tbody>
          </table>
        </div>
      </GlassCard>
    );
  }

  if (initialLoading) return <LoadingState />;

  return (
    <div className="space-y-6">
      <GlassCard>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('supervisor.supervisorStatus')}</h2>
            <div className="mt-2"><StatusBadge status={status} /></div>
          </div>
          <div className="flex flex-wrap gap-3">
            <LiquidButton onClick={() => setAddSupervisorOpen(true)}><Plus className="w-4 h-4" /> {t('supervisor.addSupervisor')}</LiquidButton>
            <LiquidButton onClick={() => setAddPm2Open(true)} variant="ghost"><Plus className="w-4 h-4" /> {t('supervisor.addPm2')}</LiquidButton>
          </div>
        </div>
      </GlassCard>

      <ProcessTable title={t('supervisor.supervisorProcesses')} icon={Activity} processes={supervisorProcesses} type="supervisor" />
      <ProcessTable title={t('supervisor.pm2Processes')} icon={Terminal} processes={pm2Processes} type="pm2" />

      <GlassModal title={t('supervisor.addSupervisorTitle')} open={addSupervisorOpen} onClose={() => setAddSupervisorOpen(false)}>
        <form onSubmit={handleAddSupervisor} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-white/70">{t('supervisor.programName')}</label>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400" />
          </div>
          <div>
            <label className="mb-1 block text-sm text-white/70">{t('supervisor.commandLabel')}</label>
            <input required value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400" />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm text-white/70">{t('supervisor.directory')}</label>
              <input value={form.directory} onChange={(e) => setForm({ ...form, directory: e.target.value })} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400" />
            </div>
            <div>
              <label className="mb-1 block text-sm text-white/70">{t('supervisor.runUser')}</label>
              <input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400" />
            </div>
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-white/70">
              <input type="checkbox" checked={form.autostart} onChange={(e) => setForm({ ...form, autostart: e.target.checked })} /> {t('supervisor.autoStart')}
            </label>
            <label className="flex items-center gap-2 text-sm text-white/70">
              <input type="checkbox" checked={form.autorestart} onChange={(e) => setForm({ ...form, autorestart: e.target.checked })} /> {t('supervisor.autoRestart')}
            </label>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <LiquidButton type="button" onClick={() => setAddSupervisorOpen(false)} variant="ghost">{t('common.cancel')}</LiquidButton>
            <LiquidButton type="submit" disabled={loading}>{t('common.save')}</LiquidButton>
          </div>
        </form>
      </GlassModal>

      <GlassModal title={t('supervisor.addPm2Title')} open={addPm2Open} onClose={() => setAddPm2Open(false)}>
        <form onSubmit={handleAddPm2} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-white/70">{t('supervisor.processNameLabel')}</label>
            <input required value={pm2Form.name} onChange={(e) => setPm2Form({ ...pm2Form, name: e.target.value })} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400" />
          </div>
          <div>
            <label className="mb-1 block text-sm text-white/70">{t('supervisor.scriptLabel')}</label>
            <input required value={pm2Form.script} onChange={(e) => setPm2Form({ ...pm2Form, script: e.target.value })} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400" />
          </div>
          <div>
            <label className="mb-1 block text-sm text-white/70">{t('supervisor.directory')}</label>
            <input value={pm2Form.cwd} onChange={(e) => setPm2Form({ ...pm2Form, cwd: e.target.value })} className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400" />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <LiquidButton type="button" onClick={() => setAddPm2Open(false)} variant="ghost">{t('common.cancel')}</LiquidButton>
            <LiquidButton type="submit" disabled={loading}>{t('common.save')}</LiquidButton>
          </div>
        </form>
      </GlassModal>
    </div>
  );
}