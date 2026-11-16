import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import AuthLayout from './layouts/AuthLayout.jsx';
import AppLayout from './layouts/AppLayout.jsx';
import { PublicOnly, RequireAuth, RequirePermission, RequirePlatformAdmin } from './routes/guards.jsx';
import { flatPages } from './config/nav.js';
import LoginPage from './pages/auth/LoginPage.jsx';
import RegisterPage from './pages/auth/RegisterPage.jsx';
import ComingSoonPage from './pages/ComingSoonPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';
import StatusPage from './pages/StatusPage.jsx';

// Chargement à la demande : chaque écran est un fichier séparé (le premier affichage télécharge beaucoup moins de code).
const LandingPage = lazy(() => import('./pages/landing/LandingPage.jsx'));
const NotificationsPage = lazy(() => import('./features/notifications/NotificationsPage.jsx'));
const ForgotPasswordPage = lazy(() => import('./pages/auth/ForgotPasswordPage.jsx'));
const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage.jsx'));
const VerifyEmailPage = lazy(() => import('./pages/auth/VerifyEmailPage.jsx'));
const AcceptInvitationPage = lazy(() => import('./pages/auth/AcceptInvitationPage.jsx'));
const DashboardPage = lazy(() => import('./pages/DashboardPage.jsx'));
const UsersPage = lazy(() => import('./pages/UsersPage.jsx'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx'));
const ClientsPage = lazy(() => import('./features/masterdata/ClientsPage.jsx'));
const SuppliersPage = lazy(() => import('./features/masterdata/SuppliersPage.jsx'));
const ProductsPage = lazy(() => import('./features/masterdata/ProductsPage.jsx'));
const TaxRatesPage = lazy(() => import('./features/masterdata/TaxRatesPage.jsx'));
const DocListPage = lazy(() => import('./features/sales/DocListPage.jsx'));
const DocEditorPage = lazy(() => import('./features/sales/DocEditorPage.jsx'));
const DocViewPage = lazy(() => import('./features/sales/DocViewPage.jsx'));
const DeliveryListPage = lazy(() => import('./features/sales/DeliveryPages.jsx').then((m) => ({ default: m.DeliveryListPage })));
const DeliveryViewPage = lazy(() => import('./features/sales/DeliveryPages.jsx').then((m) => ({ default: m.DeliveryViewPage })));
const RecurringPage = lazy(() => import('./features/sales/RecurringPage.jsx'));
const CountListPage = lazy(() => import('./features/stock/StockPages.jsx').then((m) => ({ default: m.CountListPage })));
const CountViewPage = lazy(() => import('./features/stock/StockPages.jsx').then((m) => ({ default: m.CountViewPage })));
const InventoryPage = lazy(() => import('./features/stock/StockPages.jsx').then((m) => ({ default: m.InventoryPage })));
const MovementsPage = lazy(() => import('./features/stock/StockPages.jsx').then((m) => ({ default: m.MovementsPage })));
const VoucherListPage = lazy(() => import('./features/stock/StockPages.jsx').then((m) => ({ default: m.VoucherListPage })));
const VoucherViewPage = lazy(() => import('./features/stock/StockPages.jsx').then((m) => ({ default: m.VoucherViewPage })));
const WarehousesPage = lazy(() => import('./features/stock/StockPages.jsx').then((m) => ({ default: m.WarehousesPage })));
const PurchaseEditor = lazy(() => import('./features/purchases/PurchasePages.jsx').then((m) => ({ default: m.PurchaseEditor })));
const PurchaseList = lazy(() => import('./features/purchases/PurchasePages.jsx').then((m) => ({ default: m.PurchaseList })));
const PurchaseView = lazy(() => import('./features/purchases/PurchasePages.jsx').then((m) => ({ default: m.PurchaseView })));
const BalancesPage = lazy(() => import('./features/balances/BalancesPages.jsx').then((m) => ({ default: m.BalancesPage })));
const BalanceDetailPage = lazy(() => import('./features/balances/BalancesPages.jsx').then((m) => ({ default: m.BalanceDetailPage })));
const SupplierPaymentsPage = lazy(() => import('./features/purchases/SupplierPaymentsPage.jsx'));
const PaymentsPage = lazy(() => import('./features/payments/PaymentsPage.jsx'));
const ReturnList = lazy(() => import('./features/stock/ReturnPages.jsx').then((m) => ({ default: m.ReturnList })));
const ReturnView = lazy(() => import('./features/stock/ReturnPages.jsx').then((m) => ({ default: m.ReturnView })));
const AccountsPage = lazy(() => import('./features/treasury/TreasuryPages.jsx').then((m) => ({ default: m.AccountsPage })));
const InstrumentsPage = lazy(() => import('./features/treasury/TreasuryPages.jsx').then((m) => ({ default: m.InstrumentsPage })));
const TransactionsPage = lazy(() => import('./features/treasury/TreasuryPages.jsx').then((m) => ({ default: m.TransactionsPage })));
const RemindersPage = lazy(() => import('./features/payments/RemindersPage.jsx'));
const WithholdingPage = lazy(() => import('./features/withholdings/WithholdingPages.jsx'));
const ExpenseEditor = lazy(() => import('./features/expenses/ExpensePages.jsx').then((m) => ({ default: m.ExpenseEditor })));
const ExpenseList = lazy(() => import('./features/expenses/ExpensePages.jsx').then((m) => ({ default: m.ExpenseList })));
const ExpenseView = lazy(() => import('./features/expenses/ExpensePages.jsx').then((m) => ({ default: m.ExpenseView })));
const ProjectList = lazy(() => import('./features/projects/ProjectPages.jsx').then((m) => ({ default: m.ProjectList })));
const ProjectView = lazy(() => import('./features/projects/ProjectPages.jsx').then((m) => ({ default: m.ProjectView })));
const ScanPage = lazy(() => import('./features/purchases/ScanPage.jsx'));
const SubscriptionPage = lazy(() => import('./features/subscription/SubscriptionPage.jsx'));
const PaymentPage = lazy(() => import('./features/subscription/PaymentPage.jsx'));
const PlatformHome = lazy(() => import('./features/platform/PlatformPages.jsx').then((m) => ({ default: m.PlatformHome })));
const PlatformCompanies = lazy(() => import('./features/platform/PlatformPages.jsx').then((m) => ({ default: m.PlatformCompanies })));
const PlatformCompany = lazy(() => import('./features/platform/PlatformPages.jsx').then((m) => ({ default: m.PlatformCompany })));
const PlatformPlans = lazy(() => import('./features/platform/PlatformPages.jsx').then((m) => ({ default: m.PlatformPlans })));
const PlatformPayments = lazy(() => import('./features/platform/PlatformPages.jsx').then((m) => ({ default: m.PlatformPayments })));
const ReportsPage = lazy(() => import('./features/reports/ReportsPage.jsx'));

// Modules du menu pas encore developpes : une route par entree, protegee par la permission de lecture.
const comingSoon = flatPages().filter((p) => !p.built);

export default function App() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center text-sm text-slate-500" role="status">Chargement…</div>}>
    <Routes>
      <Route path="/status" element={<StatusPage />} />
      <Route element={<AuthLayout />}>
        <Route element={<PublicOnly />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
        </Route>
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
      </Route>

      <Route element={<RequireAuth landing={<LandingPage />} />}>
        <Route element={<AppLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="/users" element={<RequirePermission perm="user.read"><UsersPage /></RequirePermission>} />
          <Route path="/clients" element={<RequirePermission perm="client.read"><ClientsPage /></RequirePermission>} />
          <Route path="/suppliers" element={<RequirePermission perm="supplier.read"><SuppliersPage /></RequirePermission>} />
          <Route path="/products" element={<RequirePermission perm="product.read"><ProductsPage /></RequirePermission>} />
          <Route path="/settings/taxes" element={<RequirePermission perm="tax_rate.read"><TaxRatesPage /></RequirePermission>} />
          <Route path="/purchases/orders" element={<RequirePermission perm="purchase.read"><PurchaseList key="p-order-list" kind="order" /></RequirePermission>} />
          <Route path="/purchases/orders/new" element={<RequirePermission perm="purchase.write"><PurchaseEditor key="p-order-edit" kind="order" /></RequirePermission>} />
          <Route path="/purchases/orders/:id/edit" element={<RequirePermission perm="purchase.write"><PurchaseEditor key="p-order-edit" kind="order" /></RequirePermission>} />
          <Route path="/purchases/orders/:id" element={<RequirePermission perm="purchase.read"><PurchaseView key="p-order-view" kind="order" /></RequirePermission>} />
          <Route path="/purchases/receipts" element={<RequirePermission perm="purchase_receipt.read"><PurchaseList key="p-receipt-list" kind="receipt" /></RequirePermission>} />
          <Route path="/purchases/receipts/:id" element={<RequirePermission perm="purchase_receipt.read"><PurchaseView key="p-receipt-view" kind="receipt" /></RequirePermission>} />
          <Route path="/purchases/scan" element={<RequirePermission perm="purchase.write"><ScanPage /></RequirePermission>} />
          <Route path="/purchases/invoices" element={<RequirePermission perm="purchase.read"><PurchaseList key="p-invoice-list" kind="invoice" /></RequirePermission>} />
          <Route path="/purchases/invoices/new" element={<RequirePermission perm="purchase.write"><PurchaseEditor key="p-invoice-edit" kind="invoice" /></RequirePermission>} />
          <Route path="/purchases/invoices/:id/edit" element={<RequirePermission perm="purchase.write"><PurchaseEditor key="p-invoice-edit" kind="invoice" /></RequirePermission>} />
          <Route path="/purchases/invoices/:id" element={<RequirePermission perm="purchase.read"><PurchaseView key="p-invoice-view" kind="invoice" /></RequirePermission>} />
          <Route path="/purchases/credit-notes" element={<RequirePermission perm="purchase.read"><PurchaseList key="p-credit_note-list" kind="credit_note" /></RequirePermission>} />
          <Route path="/purchases/credit-notes/:id" element={<RequirePermission perm="purchase.read"><PurchaseView key="p-credit_note-view" kind="credit_note" /></RequirePermission>} />
          <Route path="/purchases/balances" element={<RequirePermission perm="purchase.read"><BalancesPage side="supplier" /></RequirePermission>} />
          <Route path="/purchases/balances/:id" element={<RequirePermission perm="purchase.read"><BalanceDetailPage side="supplier" /></RequirePermission>} />
          <Route path="/sales/balances" element={<RequirePermission perm="invoice.read"><BalancesPage side="client" /></RequirePermission>} />
          <Route path="/sales/balances/:id" element={<RequirePermission perm="invoice.read"><BalanceDetailPage side="client" /></RequirePermission>} />
          <Route path="/purchases/payments" element={<RequirePermission perm="payment.read"><SupplierPaymentsPage /></RequirePermission>} />
          <Route path="/payments" element={<RequirePermission perm="payment.read"><PaymentsPage /></RequirePermission>} />
          <Route path="/sales/quotes" element={<RequirePermission perm="quote.read"><DocListPage key="quote-DocListPage" kind="quote" /></RequirePermission>} />
          <Route path="/sales/quotes/new" element={<RequirePermission perm="quote.write"><DocEditorPage key="quote-DocEditorPage" kind="quote" /></RequirePermission>} />
          <Route path="/sales/quotes/:id/edit" element={<RequirePermission perm="quote.write"><DocEditorPage key="quote-DocEditorPage" kind="quote" /></RequirePermission>} />
          <Route path="/sales/quotes/:id" element={<RequirePermission perm="quote.read"><DocViewPage key="quote-DocViewPage" kind="quote" /></RequirePermission>} />
          <Route path="/stock/inventory" element={<RequirePermission perm="stock.read"><InventoryPage /></RequirePermission>} />
          <Route path="/stock/movements" element={<RequirePermission perm="stock.read"><MovementsPage /></RequirePermission>} />
          <Route path="/stock/warehouses" element={<RequirePermission perm="stock.read"><WarehousesPage /></RequirePermission>} />
          <Route path="/stock/sheets" element={<RequirePermission perm="stock.read"><CountListPage /></RequirePermission>} />
          <Route path="/stock/sheets/:id" element={<RequirePermission perm="stock.read"><CountViewPage key="count-view" /></RequirePermission>} />
          {[['entries', 'entry'], ['withdrawals', 'withdrawal'], ['transfers', 'transfer']].flatMap(([path, type]) => [
            <Route key={`${type}-l`} path={`/stock/${path}`} element={<RequirePermission perm="stock.read"><VoucherListPage key={`${type}-list`} type={type} /></RequirePermission>} />,
            <Route key={`${type}-v`} path={`/stock/${path}/:id`} element={<RequirePermission perm="stock.read"><VoucherViewPage key={`${type}-view`} type={type} /></RequirePermission>} />,
          ])}
          <Route path="/treasury/accounts" element={<RequirePermission perm="treasury.read"><AccountsPage /></RequirePermission>} />
          <Route path="/treasury/transactions" element={<RequirePermission perm="treasury.read"><TransactionsPage /></RequirePermission>} />
          <Route path="/treasury/cheques" element={<RequirePermission perm="treasury.read"><InstrumentsPage /></RequirePermission>} />
          <Route path="/sales/reminders" element={<RequirePermission perm="payment.read"><RemindersPage /></RequirePermission>} />
          <Route path="/sales/expense-notes" element={<RequirePermission perm="expense_note.read"><ExpenseList key="en-l-sales" kind="sales" /></RequirePermission>} />
          <Route path="/sales/expense-notes/new" element={<RequirePermission perm="expense_note.write"><ExpenseEditor key="en-e-sales" kind="sales" /></RequirePermission>} />
          <Route path="/sales/expense-notes/:id/edit" element={<RequirePermission perm="expense_note.write"><ExpenseEditor key="en-e-sales" kind="sales" /></RequirePermission>} />
          <Route path="/sales/expense-notes/:id" element={<RequirePermission perm="expense_note.read"><ExpenseView key="en-v-sales" kind="sales" /></RequirePermission>} />
          <Route path="/purchases/expense-notes" element={<RequirePermission perm="expense_note.read"><ExpenseList key="en-l-purchase" kind="purchase" /></RequirePermission>} />
          <Route path="/purchases/expense-notes/new" element={<RequirePermission perm="expense_note.write"><ExpenseEditor key="en-e-purchase" kind="purchase" /></RequirePermission>} />
          <Route path="/purchases/expense-notes/:id/edit" element={<RequirePermission perm="expense_note.write"><ExpenseEditor key="en-e-purchase" kind="purchase" /></RequirePermission>} />
          <Route path="/purchases/expense-notes/:id" element={<RequirePermission perm="expense_note.read"><ExpenseView key="en-v-purchase" kind="purchase" /></RequirePermission>} />
          <Route path="/withholdings/sales" element={<RequirePermission perm="withholding.read"><WithholdingPage key="rs-s" kind="sales" /></RequirePermission>} />
          <Route path="/withholdings/purchases" element={<RequirePermission perm="withholding.read"><WithholdingPage key="rs-p" kind="purchases" /></RequirePermission>} />
          <Route path="/projects" element={<RequirePermission perm="project.read"><ProjectList /></RequirePermission>} />
          <Route path="/projects/:id" element={<RequirePermission perm="project.read"><ProjectView key="pj-v" /></RequirePermission>} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/subscription" element={<RequirePermission perm="subscription.read"><SubscriptionPage /></RequirePermission>} />
          <Route path="/subscription/pay" element={<RequirePermission perm="subscription.read"><PaymentPage /></RequirePermission>} />
          <Route path="/platform/payments" element={<RequirePlatformAdmin><PlatformPayments /></RequirePlatformAdmin>} />
          <Route path="/platform" element={<RequirePlatformAdmin><PlatformHome /></RequirePlatformAdmin>} />
          <Route path="/platform/companies" element={<RequirePlatformAdmin><PlatformCompanies /></RequirePlatformAdmin>} />
          <Route path="/platform/companies/:id" element={<RequirePlatformAdmin><PlatformCompany /></RequirePlatformAdmin>} />
          <Route path="/platform/plans" element={<RequirePlatformAdmin><PlatformPlans /></RequirePlatformAdmin>} />
          <Route path="/reports" element={<RequirePermission perm="report.read"><ReportsPage /></RequirePermission>} />
          <Route path="/sales/returns" element={<RequirePermission perm="sales_return.read"><ReturnList key="ret-sales" kind="sales" /></RequirePermission>} />
          <Route path="/sales/returns/:id" element={<RequirePermission perm="sales_return.read"><ReturnView key="retv-sales" kind="sales" /></RequirePermission>} />
          <Route path="/purchases/returns" element={<RequirePermission perm="purchase_return.read"><ReturnList key="ret-purchase" kind="purchase" /></RequirePermission>} />
          <Route path="/purchases/returns/:id" element={<RequirePermission perm="purchase_return.read"><ReturnView key="retv-purchase" kind="purchase" /></RequirePermission>} />
          <Route path="/sales/exit-vouchers" element={<RequirePermission perm="stock.read"><VoucherListPage key="exit-list" type="withdrawal" /></RequirePermission>} />
          <Route path="/sales/orders" element={<RequirePermission perm="sales_order.read"><DocListPage key="sales_order-DocListPage" kind="sales_order" /></RequirePermission>} />
          <Route path="/sales/orders/new" element={<RequirePermission perm="sales_order.write"><DocEditorPage key="sales_order-DocEditorPage" kind="sales_order" /></RequirePermission>} />
          <Route path="/sales/orders/:id/edit" element={<RequirePermission perm="sales_order.write"><DocEditorPage key="sales_order-DocEditorPage" kind="sales_order" /></RequirePermission>} />
          <Route path="/sales/orders/:id" element={<RequirePermission perm="sales_order.read"><DocViewPage key="sales_order-DocViewPage" kind="sales_order" /></RequirePermission>} />
          <Route path="/sales/delivery-notes" element={<RequirePermission perm="delivery.read"><DeliveryListPage /></RequirePermission>} />
          <Route path="/sales/delivery-notes/:id" element={<RequirePermission perm="delivery.read"><DeliveryViewPage key="bl-view" /></RequirePermission>} />
          <Route path="/sales/recurring" element={<RequirePermission perm="invoice.read"><RecurringPage /></RequirePermission>} />
          <Route path="/sales/invoices" element={<RequirePermission perm="invoice.read"><DocListPage key="invoice-DocListPage" kind="invoice" /></RequirePermission>} />
          <Route path="/sales/invoices/new" element={<RequirePermission perm="invoice.write"><DocEditorPage key="invoice-DocEditorPage" kind="invoice" /></RequirePermission>} />
          <Route path="/sales/invoices/:id/edit" element={<RequirePermission perm="invoice.write"><DocEditorPage key="invoice-DocEditorPage" kind="invoice" /></RequirePermission>} />
          <Route path="/sales/invoices/:id" element={<RequirePermission perm="invoice.read"><DocViewPage key="invoice-DocViewPage" kind="invoice" /></RequirePermission>} />
          <Route path="/sales/credit-notes" element={<RequirePermission perm="credit_note.read"><DocListPage key="credit_note-DocListPage" kind="credit_note" /></RequirePermission>} />
          <Route path="/sales/credit-notes/:id" element={<RequirePermission perm="credit_note.read"><DocViewPage key="credit_note-DocViewPage" kind="credit_note" /></RequirePermission>} />
          <Route path="/settings" element={<SettingsPage />} />
          {comingSoon.map((p) => (
            <Route key={p.path} path={p.path} element={<RequirePermission perm={p.perm}><ComingSoonPage /></RequirePermission>} />
          ))}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
    </Suspense>
  );
}
