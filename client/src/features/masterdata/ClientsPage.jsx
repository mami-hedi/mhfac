import { Users } from 'lucide-react';
import PartiesPage from './PartiesPage.jsx';
const cfg = { api: '/clients', perm: 'client', title: 'Clients', subtitle: 'Vos clients, leurs coordonnées fiscales et conditions de paiement.', one: 'client', article: 'un', plural: 'clients', file: 'clients', icon: Users };
export default function ClientsPage() { return <PartiesPage cfg={cfg} />; }
