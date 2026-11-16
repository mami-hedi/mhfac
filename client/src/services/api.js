import axios from 'axios';

const BASE = `${import.meta.env.VITE_API_URL ?? ''}/api/v1`;

// Jeton d'acces gardé EN MÉMOIRE uniquement (jamais localStorage) ; le jeton de rafraîchissement est un
// cookie httpOnly que JavaScript ne peut pas lire.
let accessToken = null;
let onAuthLost = () => {};
export const setAccessToken = (t) => { accessToken = t; };
export const setAuthLostHandler = (fn) => { onAuthLost = fn; };

export const api = axios.create({ baseURL: BASE, timeout: 15000, withCredentials: true });

api.interceptors.request.use((cfg) => {
  if (accessToken) cfg.headers.Authorization = `Bearer ${accessToken}`;
  return cfg;
});

// Un seul rafraîchissement à la fois : les requêtes simultanées partagent la même promesse
// (indispensable : un jeton de rafraîchissement ne peut servir qu'une fois).
let refreshing = null;
export function refreshSession() {
  refreshing ??= axios
    .post(`${BASE}/auth/refresh`, null, { withCredentials: true, timeout: 15000 })
    .then((r) => { setAccessToken(r.data.data.accessToken); return r.data.data; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

const NO_RETRY = ['/auth/login', '/auth/refresh', '/auth/register-company', '/auth/accept-invitation'];

api.interceptors.response.use((r) => r, async (err) => {
  const cfg = err.config;
  if (err.response?.status === 401 && cfg && !cfg._retried && !NO_RETRY.some((p) => cfg.url?.startsWith(p))) {
    cfg._retried = true;
    try {
      await refreshSession();
      return api(cfg);
    } catch {
      setAccessToken(null);
      onAuthLost();
    }
  }
  return Promise.reject(err);
});

export const errorMessage = (err) =>
  err?.response?.data?.error?.message ??
  (err?.code === 'ECONNABORTED' || err?.message === 'Network Error' ? 'Serveur injoignable, réessayez.' : 'Une erreur est survenue.');
export const errorCode = (err) => err?.response?.data?.error?.code;

export const getHealth = () => api.get('/health').then((r) => r.data.data);
