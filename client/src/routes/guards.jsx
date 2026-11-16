import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { Spinner } from '../components/ui/index.jsx';
import ForbiddenPage from '../pages/ForbiddenPage.jsx';

// `landing` : page publique affichée à la racine « / » pour un visiteur non connecté (les autres adresses redirigent vers la connexion).
export function RequireAuth({ landing = null }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <div className="grid min-h-screen place-items-center"><Spinner /></div>;
  if (status === 'anonymous' && landing && location.pathname === '/') return landing;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

export function PublicOnly() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <div className="grid min-h-screen place-items-center"><Spinner /></div>;
  if (status === 'authenticated') return <Navigate to={location.state?.from ?? '/'} replace />;
  return <Outlet />;
}

// Contrôle d'affichage uniquement : le serveur reste la seule autorité sur chaque endpoint.
export function RequirePlatformAdmin({ children }) {
  const { user } = useAuth();
  return user?.isPlatformAdmin ? children : <ForbiddenPage />;
}

export function RequirePermission({ perm, children }) {
  const { can } = useAuth();
  return !perm || can(perm) ? children : <ForbiddenPage />;
}
