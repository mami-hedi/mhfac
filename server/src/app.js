import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { errorHandler, notFound } from './middlewares/error.js';
import healthRoutes from './modules/health/health.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import companiesRoutes from './modules/companies/companies.routes.js';
import usersRoutes from './modules/users/users.routes.js';
import clientsRoutes from './modules/clients/clients.routes.js';
import suppliersRoutes from './modules/suppliers/suppliers.routes.js';
import productsRoutes from './modules/products/products.routes.js';
import categoriesRoutes from './modules/product-categories/categories.routes.js';
import taxRatesRoutes from './modules/tax-rates/tax-rates.routes.js';
import previewRoutes from './modules/sales/preview.routes.js';
import quotesRoutes from './modules/sales/quotes.routes.js';
import ordersRoutes from './modules/sales/orders.routes.js';
import deliveryRoutes from './modules/sales/delivery.routes.js';
import recurringRoutes from './modules/sales/recurring.routes.js';
import stockRoutes from './modules/stock/stock.routes.js';
import purchaseOrdersRoutes from './modules/purchases/orders.routes.js';
import purchaseReceiptsRoutes from './modules/purchases/receipts.routes.js';
import { purchaseInvoicesRouter, purchaseCreditNotesRouter } from './modules/purchases/invoices.routes.js';
import { salesReturnsRouter, purchaseReturnsRouter } from './modules/stock/returns.routes.js';
import treasuryRoutes from './modules/treasury/treasury.routes.js';
import remindersRoutes from './modules/payments/reminders.routes.js';
import withholdingsRoutes from './modules/withholdings/withholdings.routes.js';
import { salesExpenseRouter, purchaseExpenseRouter } from './modules/expenses/expenses.routes.js';
import projectsRoutes from './modules/projects/projects.routes.js';
import reportsRoutes from './modules/reports/reports.routes.js';
import einvoiceRoutes from './modules/einvoice/einvoice.routes.js';
import publicRoutes from './modules/public/public.routes.js';
import subscriptionRoutes from './modules/subscription/subscription.routes.js';
import platformRoutes from './modules/platform/platform.routes.js';
import purchaseScanRoutes from './modules/purchase-scan/scan.routes.js';
import purchasePreviewRoutes from './modules/purchases/preview.routes.js';
import { balancesRouter } from './modules/balances/balances.routes.js';
import supplierPaymentsRoutes from './modules/purchases/supplier-payments.routes.js';
import paymentsRoutes from './modules/payments/payments.routes.js';
import { invoicesRouter, creditNotesRouter } from './modules/sales/invoices.routes.js';
import notificationsRoutes from './modules/notifications/notifications.routes.js';
import dashboardRoutes from './modules/dashboard/dashboard.routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(helmet());
  app.use(cors({ origin: env.clientOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(rateLimit({ windowMs: 60_000, limit: env.API_RATE_LIMIT_PER_MIN, standardHeaders: true, legacyHeaders: false }));

  if (env.NODE_ENV !== 'test') {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        console.log(JSON.stringify({ level: 'info', method: req.method, url: req.originalUrl, status: res.statusCode, ms: Date.now() - start }));
      });
      next();
    });
  }

  const v1 = express.Router();
  v1.use('/health', healthRoutes);
  v1.use('/auth', authRoutes);
  v1.use('/companies', companiesRoutes);
  v1.use('/users', usersRoutes);
  v1.use('/dashboard', dashboardRoutes);
  v1.use('/clients', clientsRoutes);
  v1.use('/suppliers', suppliersRoutes);
  v1.use('/products', productsRoutes);
  v1.use('/product-categories', categoriesRoutes);
  v1.use('/tax-rates', taxRatesRoutes);
  v1.use('/sales', previewRoutes);
  v1.use('/quotes', quotesRoutes);
  v1.use('/orders', ordersRoutes);
  v1.use('/delivery-notes', deliveryRoutes);
  v1.use('/recurring-invoices', recurringRoutes);
  v1.use('/stock', stockRoutes);
  v1.use('/invoices', invoicesRouter);
  v1.use('/credit-notes', creditNotesRouter);
  v1.use('/payments', paymentsRoutes);
  v1.use('/purchases', purchasePreviewRoutes);
  v1.use('/treasury', treasuryRoutes);
  v1.use('/reminders', remindersRoutes);
  v1.use('/withholdings', withholdingsRoutes);
  v1.use('/sales-expense-notes', salesExpenseRouter);
  v1.use('/purchase-expense-notes', purchaseExpenseRouter);
  v1.use('/projects', projectsRoutes);
  v1.use('/reports', reportsRoutes);
  v1.use('/e-invoicing', einvoiceRoutes);
  v1.use('/purchase-scans', purchaseScanRoutes);
  v1.use('/public', publicRoutes);
  v1.use('/subscription', subscriptionRoutes);
  v1.use('/notifications', notificationsRoutes);
  v1.use('/platform', platformRoutes);
  v1.use('/sales-returns', salesReturnsRouter);
  v1.use('/purchase-returns', purchaseReturnsRouter);
  v1.use('/purchase-orders', purchaseOrdersRoutes);
  v1.use('/purchase-receipts', purchaseReceiptsRoutes);
  v1.use('/purchase-invoices', purchaseInvoicesRouter);
  v1.use('/purchase-credit-notes', purchaseCreditNotesRouter);
  v1.use('/supplier-payments', supplierPaymentsRoutes);
  v1.use('/supplier-balances', balancesRouter('supplier'));
  v1.use('/client-balances', balancesRouter('client'));
  // Phase 7+ : achats, stock, ...
  app.use('/api/v1', v1);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
