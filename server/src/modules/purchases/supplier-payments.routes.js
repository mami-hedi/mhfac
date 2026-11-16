// Règlements fournisseurs (logique partagée dans payments/payments.factory.js).
import { paymentsFactory } from '../payments/payments.factory.js';
const { router, refreshPaid, cancelPayment } = paymentsFactory('supplier');
export { refreshPaid, cancelPayment };
export default router;
