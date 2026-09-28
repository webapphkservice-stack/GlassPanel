import React from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useLocation } from 'react-router-dom';
import { useUIStore, useAuthStore } from '@/store';
import {
  Home, Globe, Server, Database, Cpu, Shield, Lock,
  Activity, Package, LogOut, Ban,
} from '@/components/common/Icons';

export default function Sidebar() {
  const { t } = useTranslation();
  const { sidebarCollapsed } = useUIStore();
  const { clearAuth } = useAuthStore();
  const location = useLocation();

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
      <div className="flex h-16 items-center justify-center px-4 border-b border-white/10">
        <span className="text-lg font-bold bg-gradient-to-r from-cyan-300 to-cyan-500 bg-clip-text text-transparent">
          {t('sidebar.brand')}
        </span>
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
    </aside>
  );
}
