import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from '@/store';
import Layout from '@/components/layout/Layout';
import Login from '@/pages/Login';
import Dashboard from '@/pages/Dashboard';
import Nginx from '@/pages/Nginx';
import Php from '@/pages/Php';
import Mysql from '@/pages/Mysql';
import Redis from '@/pages/Redis';
import Supervisor from '@/pages/Supervisor';
import Firewall from '@/pages/Firewall';
import Ssl from '@/pages/Ssl';
import Apps from '@/pages/Apps';
import Fail2ban from '@/pages/Fail2ban';
import Security from '@/pages/Security';

function PrivateRoute({ children }) {
  const token = useAuthStore((state) => state.token);
  return token ? children : <Navigate to="/login" replace />;
}

export default function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <PrivateRoute>
            <Layout />
          </PrivateRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="nginx" element={<Nginx />} />
        <Route path="php" element={<Php />} />
        <Route path="mysql" element={<Mysql />} />
        <Route path="redis" element={<Redis />} />
        <Route path="supervisor" element={<Supervisor />} />
        <Route path="firewall" element={<Firewall />} />
        <Route path="fail2ban" element={<Fail2ban />} />
        <Route path="ssl" element={<Ssl />} />
        <Route path="apps" element={<Apps />} />
        <Route path="security" element={<Security />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
