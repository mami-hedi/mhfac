import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { Card, EmptyState } from '../components/ui/index.jsx';

export default function ForbiddenPage() {
  return (
    <Card><EmptyState icon={Lock} title="Accès non autorisé" action={<Link to="/" className="text-sm text-brand-600 hover:underline">Retour au tableau de bord</Link>}>
      Votre rôle ne donne pas accès à cette page. Contactez le propriétaire de l'entreprise si vous en avez besoin.
    </EmptyState></Card>
  );
}
