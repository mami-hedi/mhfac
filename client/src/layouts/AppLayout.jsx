import { Suspense } from 'react';
import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Header from './Header.jsx';
import Sidebar from './Sidebar.jsx';

export default function AppLayout() {
  const [menu, setMenu] = useState(false);
  return (
    <div className="min-h-screen bg-slate-50">
      <Sidebar open={menu} onClose={() => setMenu(false)} />
      <div className="lg:pl-64">
        <Header onMenu={() => setMenu(true)} />
        <main className="mx-auto max-w-7xl p-4 sm:p-6"><Suspense fallback={<div className="py-10 text-center text-sm text-slate-500" role="status">Chargement…</div>}><Outlet /></Suspense></main>
      </div>
    </div>
  );
}
