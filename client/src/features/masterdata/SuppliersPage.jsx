import { Truck } from 'lucide-react';
import PartiesPage from './PartiesPage.jsx';
const cfg = { api: '/suppliers', perm: 'supplier', title: 'Fournisseurs', subtitle: 'Vos fournisseurs et leurs conditions de paiement.', one: 'fournisseur', article: 'un', plural: 'fournisseurs', file: 'fournisseurs', icon: Truck };
export default function SuppliersPage() { return <PartiesPage cfg={cfg} />; }
