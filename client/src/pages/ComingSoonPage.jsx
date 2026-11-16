import { Link, useLocation } from 'react-router-dom';
import { Hammer } from 'lucide-react';
import { flatPages } from '../config/nav.js';
import { Badge, Card, EmptyState, PageHeader } from '../components/ui/index.jsx';
import NotFoundPage from './NotFoundPage.jsx';

const PHASES = {
  5: 'Phase 5 : clients, fournisseurs et articles',
  6: 'Phase 6 : devis et factures',
  7: 'Phase 7 : achats, paiements et stock',
  8: 'Phase 8 : rapports et facturation électronique',
  9: 'Phase 9 : abonnements, sécurité et finition',
};

// Module du menu dont le developpement n'a pas commence : la page l'indique clairement, aucune donnee fictive.
export default function ComingSoonPage() {
  const { pathname } = useLocation();
  const page = flatPages().find((p) => p.path === pathname);
  if (!page) return <NotFoundPage />;
  return (
    <>
      <PageHeader title={page.label} subtitle={page.group} actions={<Badge tone="orange">{page.soon ? 'Bientôt disponible' : 'En cours de développement'}</Badge>} />
      <Card>
        {page.soon ? (
          <EmptyState icon={Hammer} title="Ce module sera disponible bientôt" action={<Link to="/" className="text-sm text-brand-600 hover:underline">Retour au tableau de bord</Link>}>
            Il est en cours de préparation. En attendant, vos factures restent émises, numérotées et imprimables normalement.
          </EmptyState>
        ) : (
        <EmptyState icon={Hammer} title="Ce module n'est pas encore disponible" action={<Link to="/" className="text-sm text-brand-600 hover:underline">Retour au tableau de bord</Link>}>
          Il est prévu dans la {PHASES[page.phase] ?? 'suite du développement'}. Aucune donnée n'est affichée tant que le module n'existe pas.
        </EmptyState>
        )}
      </Card>
    </>
  );
}
