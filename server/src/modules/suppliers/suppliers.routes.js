import { makePartiesModule } from '../parties/parties.js';
export default makePartiesModule({ table: 'suppliers', perm: 'supplier', prefix: 'FOU', label: 'Fournisseur', auditPrefix: 'supplier' });
