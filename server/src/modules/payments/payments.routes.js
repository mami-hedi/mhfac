// Règlements clients (logique partagée dans payments.factory.js).
import { paymentsFactory } from './payments.factory.js';
const { router, refreshPaid, cancelPayment } = paymentsFactory('client');
export { refreshPaid, cancelPayment };
export default router;
