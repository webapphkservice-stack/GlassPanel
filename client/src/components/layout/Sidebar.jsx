import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useLocation } from 'react-router-dom';
import { useUIStore, useAuthStore } from '@/store';
import {
  Home, Globe, Server, Database, Cpu, Shield, Lock,
  Activity, Package, LogOut, Ban, Pencil,
} from '@/components/common/Icons';
import GlassModal from '@/components/common/GlassModal';
import LiquidButton from '@/components/common/LiquidButton';
import { useUIStore as useToastStore } from '@/components/common/uiStore';
import { getPanelSettings, savePanelSettings } from '@/api/system';

// 面板名称长度上限：与后端校验保持一致
const PANEL_NAME_MAX = 32;

export default function Sidebar() {
  const { t } = useTranslation();
  const { sidebarCollapsed } = useUIStore();
  const { clearAuth } = useAuthStore();
  const toast = useToastStore((s) => s.toast);
  const location = useLocation();
  // 自定义面板名称：为空时回退到默认品牌名，保存在服务端设置中
  const [panelName, setPanelName] = useState('');
  const [nameOpen, setNameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);

  const displayName = panelName || t('sidebar.brand');

  useEffect(() => {
    getPanelSettings()
      .then((data) => setPanelName(String(data?.settings?.panelName || '').trim()))
      .catch(() => {
        // 读取失败时保留默认品牌名，不阻塞界面
      });
  }, []);

  // 页面标题跟随自定义面板名称与当前语言
  useEffect(() => {
    document.title = `${displayName} - ${t('sidebar.panelTitleSuffix')}`;
  }, [displayName, t]);

  function openNameEditor() {
    setNameDraft(panelName);
    setNameOpen(true);
  }

  async function handleSaveName(e) {
    e.preventDefault();
    const next = nameDraft.trim();
    if (next.length > PANEL_NAME_MAX) {
      toast(t('sidebar.panelNameTooLong', { max: PANEL_NAME_MAX }), 'warning');
      return;
    }
    setSavingName(true);
    try {
      const data = await savePanelSettings({ panelName: next });
      setPanelName(String(data?.settings?.panelName || '').trim());
      setNameOpen(false);
      toast(t('sidebar.panelNameSaved'), 'success');
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setSavingName(false);
    }
  }

  const menuItems = [
    { path: '/', label: t('sidebar.overview'), icon: Home },
    { path: '/apps', label: t('sidebar.apps'), icon: Package },
    { path: '/nginx', label: t('sidebar.nginx'), icon: Globe },
    { path: '/php', label: t('sidebar.php'), icon: Server },
    { path: '/mysql', label: t('sidebar.mysql'), icon: Database },
    { path: '/redis', label: t('sidebar.redis'), icon: Cpu },
    { path: '/supervisor', label: t('sidebar.supervisor'), icon: Activity },
    { path: '/firewall', label: t('sidebar.firewall'), icon: Shield },
    { path: '/fail2ban', label: t('sidebar.fail2ban'), icon: Ban },
    { path: '/ssl', label: t('sidebar.ssl'), icon: Lock },
  ];

  const handleLogout = () => {
    clearAuth();
    window.location.href = '/login';
  };

  return (
    <aside
      className={`
        fixed left-0 top-0 z-40 flex h-screen flex-col border-r border-white/10
        bg-[rgba(15,21,38,0.55)] backdrop-blur-2xl backdrop-saturate-150
        transition-all duration-300
        ${sidebarCollapsed ? 'w-20' : 'w-64'}
      `}
    >
      <div className="flex h-16 items-center justify-center border-b border-white/10 px-2">
        <button
          type="button"
          onClick={openNameEditor}
          title={t('sidebar.editPanelName')}
          className="group flex max-w-full items-center gap-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-white/[0.07]"
        >
          <span className="truncate text-lg font-bold bg-gradient-to-r from-cyan-300 to-cyan-500 bg-clip-text text-transparent">
            {displayName}
          </span>
          <Pencil className="h-3.5 w-3.5 flex-none text-white/30 opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
        {menuItems.map((item) => {
          const Icon = item.icon;
          const active = location.pathname === item.path;
          return (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) => `
                group relative flex items-center rounded-xl border px-3 py-2.5 transition-all duration-300
                ${isActive
                  ? 'border-cyan-400/25 bg-gradient-to-b from-cyan-500/25 to-cyan-600/10 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]'
                  : 'border-transparent text-white/70 hover:bg-white/[0.07] hover:text-white'}
                ${sidebarCollapsed ? 'justify-center' : 'gap-3'}
              `}
            >
              <Icon className="w-5 h-5 flex-shrink-0" />
              {!sidebarCollapsed && <span className="text-sm font-medium">{item.label}</span>}
            </NavLink>
          );
        })}
      </nav>

      <div className="border-t border-white/10 p-4 space-y-3">
        {!sidebarCollapsed && (
          <div className="px-3 text-xs text-white/40">{t('sidebar.version')} 20260926.1.0.0</div>
        )}
        <button
          onClick={handleLogout}
          className={`
            flex w-full items-center rounded-xl px-3 py-3 text-rose-300
            hover:bg-rose-500/10 transition-colors
            ${sidebarCollapsed ? 'justify-center' : 'gap-3'}
          `}
        >
          <LogOut className="w-5 h-5 flex-shrink-0" />
          {!sidebarCollapsed && <span className="text-sm font-medium">{t('sidebar.logout')}</span>}
        </button>
      </div>

      <GlassModal
        title={t('sidebar.panelNameTitle')}
        subtitle={t('sidebar.panelNameSubtitle')}
        open={nameOpen}
        onClose={() => setNameOpen(false)}
        maxWidth="max-w-md"
      >
        <form onSubmit={handleSaveName} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-white/70">{t('sidebar.panelNameLabel')}</label>
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              maxLength={PANEL_NAME_MAX}
              placeholder={t('sidebar.brand')}
              autoFocus
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm outline-none focus:border-cyan-400"
            />
            <p className="mt-1 text-xs text-white/40">{t('sidebar.panelNameHint', { max: PANEL_NAME_MAX })}</p>
          </div>
          <div className="flex justify-end gap-3">
            <LiquidButton type="button" variant="ghost" onClick={() => setNameOpen(false)}>
              {t('common.cancel')}
            </LiquidButton>
            <LiquidButton type="submit" disabled={savingName}>
              {savingName ? t('common.saving') : t('common.save')}
            </LiquidButton>
          </div>
        </form>
      </GlassModal>
    </aside>
  );
}
