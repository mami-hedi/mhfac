import { Link } from 'react-router-dom';
import { SearchX } from 'lucide-react';
import { Card, EmptyState } from '../components/ui/index.jsx';

export default function NotFoundPage() {
  return (
    <Card><EmptyState icon={SearchX} title="Page introuvable" action={<Link to="/" className="text-sm text-brand-600 hover:underline">Retour au tableau de bord</Link>}>
      Cette adresse n'existe pas ou a été déplacée.
    </EmptyState></Card>
  );
}
