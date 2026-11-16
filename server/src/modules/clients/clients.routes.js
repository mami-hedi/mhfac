import { makePartiesModule } from '../parties/parties.js';
export default makePartiesModule({ table: 'clients', perm: 'client', prefix: 'CLI', label: 'Client', auditPrefix: 'client' });
