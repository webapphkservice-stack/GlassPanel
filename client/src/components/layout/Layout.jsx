import React from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import { ConfirmDialog, ToastContainer } from '@/components/common/GlobalUI';
import { useUIStore } from '@/store';

export default function Layout() {
  const { t } = useTranslation();
  const { sidebarCollapsed } = useUIStore();
  const location = useLocation();

  const titles = {
    '/': t('layout.systemOverview'),
    '/apps': t('sidebar.apps'),
    '/nginx': t('layout.nginxManagement'),
    '/php': t('layout.phpManagement'),
    '/mysql': t('layout.mysqlManagement'),
    '/redis': t('layout.redisManagement'),
    '/supervisor': t('layout.processGuard'),
    '/firewall': t('layout.firewallSettings'),
    '/fail2ban': t('layout.fail2banManagement'),
    '/ssl': t('layout.sslCert'),
  };
  const title = titles[location.pathname] || t('layout.managementPanel');

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div
        className={`
          flex flex-1 flex-col transition-all duration-300
          ${sidebarCollapsed ? 'ml-20' : 'ml-64'}
        `}
      >
        <Header title={title} />
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
      <ToastContainer />
      <ConfirmDialog />
    </div>
  );
}