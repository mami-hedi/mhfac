import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, refreshSession, setAccessToken, setAuthLostHandler } from '../services/api.js';

const AuthContext = createContext(null);
const ANON = { status: 'anonymous', user: null, company: null, role: null, permissions: new Set(), memberships: [] };

export function AuthProvider({ children }) {
  const [state, setState] = useState({ ...ANON, status: 'loading' });
  const booted = useRef(false);

  const loadMe = useCallback(async () => {
    const { data } = await api.get('/auth/me');
    const d = data.data;
    setState({ status: 'authenticated', user: d.user, company: d.company, role: d.role, permissions: new Set(d.permissions), memberships: d.memberships });
  }, []);

  const applySession = useCallback(async (session) => {
    setAccessToken(session.accessToken);
    await loadMe();
  }, [loadMe]);

  useEffect(() => {
    setAuthLostHandler(() => setState(ANON));
    if (booted.current) return;
    booted.current = true;
    refreshSession().then(loadMe).catch(() => setState(ANON));
  }, [loadMe]);

  const value = useMemo(() => ({
    ...state,
    can: (p) => state.permissions.has(p),
    reload: loadMe,
    async login({ email, password, companyId }) {
      const r = await api.post('/auth/login', { email, password, companyId });
      await applySession(r.data.data);
    },
    async register(payload) {
      const r = await api.post('/auth/register-company', payload);
      await applySession(r.data.data);
    },
    async acceptInvitation(payload) {
      const r = await api.post('/auth/accept-invitation', payload);
      await applySession(r.data.data);
    },
    async switchCompany(companyId) {
      const r = await api.post('/auth/switch-company', { companyId });
      await applySession(r.data.data);
    },
    async logout() {
      try { await api.post('/auth/logout'); } catch { /* la session locale est supprimée quoi qu'il arrive */ }
      setAccessToken(null);
      setState(ANON);
    },
  }), [state, loadMe, applySession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
