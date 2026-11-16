# API MHFac — référence des routes

> Fichier **généré** par `npm run docs:api` depuis le code (343 routes). Ne pas éditer à la main.

## Conventions

- Base : `/api/v1`. JSON partout, sauf exports (CSV/XLSX/PDF) et téléversement de scan (corps brut).
- Authentification : `Authorization: Bearer <accessToken>` (durée courte). Le jeton de rafraîchissement est un cookie httpOnly `mhfac_rt` (SameSite=strict, chemin `/api/v1/auth`).
- Succès : `{ "data": ..., "meta": ... }`. Erreur : `{ "error": { "code", "message", "details" } }`.
- Codes courants : 400 `VALIDATION_ERROR` · 401 `UNAUTHENTICATED`/`INVALID_TOKEN` · 403 `FORBIDDEN` (permission), `SUBSCRIPTION_INACTIVE`, `PLAN_LIMIT_REACHED`, `FEATURE_NOT_IN_PLAN` · 404 (aussi pour une ressource d'une autre entreprise) · 409 conflit métier · 413/415 corps trop gros / encodage refusé · 422 règle métier · 429 trop de requêtes.
- Identifiants publics : UUID (`public_id`). Les identifiants internes ne sont jamais exposés. `company_id` vient toujours de la session.
- Montants : chaînes décimales à 3 décimales (ex. `"238.000"`), jamais des flottants. Tous les calculs sont faits par le serveur.
- Abonnement expiré/résilié : lecture et exports autorisés, écritures refusées (403 `SUBSCRIPTION_INACTIVE`).
- Permissions : `module.action` ; matrice complète par rôle : `GET /api/v1/users/permissions-matrix`.

## /auth

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| POST | `/auth/register-company` | Publique | — | — |
| POST | `/auth/login` | Publique | — | — |
| POST | `/auth/refresh` | Publique | — | — |
| POST | `/auth/logout` | Publique | — | — |
| POST | `/auth/switch-company` | Jeton utilisateur | — | — |
| POST | `/auth/forgot-password` | Publique | — | — |
| POST | `/auth/reset-password` | Publique | — | — |
| POST | `/auth/verify-email` | Publique | — | — |
| POST | `/auth/accept-invitation` | Publique | — | — |
| POST | `/auth/change-password` | Jeton utilisateur | — | — |
| PATCH | `/auth/me` | Jeton utilisateur | — | — |
| GET | `/auth/me` | Jeton utilisateur | — | — |

## /client-balances

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/client-balances/,/export` | Jeton utilisateur | `invoice.read` | — |
| GET | `/client-balances/:id` | Jeton utilisateur | `invoice.read` | — |
| GET | `/client-balances/:id/statement,/:id/statement/export` | Jeton utilisateur | `invoice.read` | — |

## /clients

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/clients/` | Jeton utilisateur | `client.read` | — |
| GET | `/clients/export.csv` | Jeton utilisateur | `client.read` | — |
| POST | `/clients/import` | Jeton utilisateur | `client.write` | — |
| POST | `/clients/` | Jeton utilisateur | `client.write` | — |
| GET | `/clients/:id` | Jeton utilisateur | `client.read` | — |
| PATCH | `/clients/:id` | Jeton utilisateur | `client.write` | — |
| DELETE | `/clients/:id` | Jeton utilisateur | `client.delete` | — |

## /companies

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/companies/current` | Jeton utilisateur | — | — |
| PATCH | `/companies/current` | Jeton utilisateur | `settings.write` | — |
| GET | `/companies/current/settings` | Jeton utilisateur | `settings.read` | — |
| PATCH | `/companies/current/settings` | Jeton utilisateur | `settings.write` | — |

## /credit-notes

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/credit-notes/` | Jeton utilisateur | `credit_note.read` | — |
| GET | `/credit-notes/export` | Jeton utilisateur | `credit_note.read` | — |
| GET | `/credit-notes/:id` | Jeton utilisateur | `credit_note.read` | — |
| GET | `/credit-notes/:id/history` | Jeton utilisateur | `credit_note.read` | — |
| GET | `/credit-notes/:id/pdf` | Jeton utilisateur | `credit_note.read` | — |
| POST | `/credit-notes/:id/send` | Jeton utilisateur | `credit_note.write` | — |
| GET | `/credit-notes/:id/emails` | Jeton utilisateur | `credit_note.read` | — |
| POST | `/credit-notes/` | Jeton utilisateur | `credit_note.write` | — |
| DELETE | `/credit-notes/:id` | Jeton utilisateur | `credit_note.delete` | — |
| POST | `/credit-notes/:id/issue` | Jeton utilisateur | `credit_note.validate` | — |

## /dashboard

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/dashboard/summary` | Jeton utilisateur | — | — |

## /delivery-notes

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/delivery-notes/,/export` | Jeton utilisateur | `delivery.read` | — |
| GET | `/delivery-notes/:id` | Jeton utilisateur | `delivery.read` | — |
| GET | `/delivery-notes/:id/history` | Jeton utilisateur | `delivery.read` | — |
| GET | `/delivery-notes/:id/pdf` | Jeton utilisateur | `delivery.read` | — |
| POST | `/delivery-notes/:id/send` | Jeton utilisateur | `delivery.write` | — |
| GET | `/delivery-notes/:id/emails` | Jeton utilisateur | `delivery.read` | — |
| POST | `/delivery-notes/` | Jeton utilisateur | `delivery.write` | — |
| PUT | `/delivery-notes/:id` | Jeton utilisateur | `delivery.write` | — |
| DELETE | `/delivery-notes/:id` | Jeton utilisateur | `delivery.delete` | — |
| POST | `/delivery-notes/:id/validate` | Jeton utilisateur | `delivery.validate` | — |
| POST | `/delivery-notes/:id/cancel` | Jeton utilisateur | `delivery.validate` | — |
| POST | `/delivery-notes/:id/invoice` | Jeton utilisateur | `delivery.validate` | — |

## /e-invoicing

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/e-invoicing/config` | Jeton utilisateur | `einvoice.read` | `einvoice` |
| PUT | `/e-invoicing/config` | Jeton utilisateur | `einvoice.write` | `einvoice` |
| GET | `/e-invoicing/transmissions` | Jeton utilisateur | `einvoice.read` | `einvoice` |
| GET | `/e-invoicing/transmissions/:id` | Jeton utilisateur | `einvoice.read` | `einvoice` |
| GET | `/e-invoicing/invoices/:invoiceId` | Jeton utilisateur | `einvoice.read` | `einvoice` |
| POST | `/e-invoicing/invoices/:invoiceId/prepare` | Jeton utilisateur | `einvoice.write` | `einvoice` |
| POST | `/e-invoicing/transmissions/:id/submit` | Jeton utilisateur | `einvoice.validate` | `einvoice` |
| POST | `/e-invoicing/transmissions/:id/retry` | Jeton utilisateur | `einvoice.validate` | `einvoice` |
| POST | `/e-invoicing/transmissions/:id/refresh` | Jeton utilisateur | `einvoice.validate` | `einvoice` |
| POST | `/e-invoicing/retry-due` | Jeton utilisateur | `einvoice.validate` | `einvoice` |

## /health

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/health/` | Publique | — | — |

## /invoices

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/invoices/` | Jeton utilisateur | `invoice.read` | — |
| GET | `/invoices/export` | Jeton utilisateur | `invoice.read` | — |
| GET | `/invoices/:id` | Jeton utilisateur | `invoice.read` | — |
| GET | `/invoices/:id/history` | Jeton utilisateur | `invoice.read` | — |
| GET | `/invoices/:id/pdf` | Jeton utilisateur | `invoice.read` | — |
| POST | `/invoices/:id/send` | Jeton utilisateur | `invoice.write` | — |
| GET | `/invoices/:id/emails` | Jeton utilisateur | `invoice.read` | — |
| POST | `/invoices/` | Jeton utilisateur | `invoice.write` | — |
| PUT | `/invoices/:id` | Jeton utilisateur | `invoice.write` | — |
| DELETE | `/invoices/:id` | Jeton utilisateur | `invoice.delete` | — |
| POST | `/invoices/:id/issue` | Jeton utilisateur | `invoice.validate` | — |
| POST | `/invoices/:id/cancel` | Jeton utilisateur | `invoice.validate` | — |
| POST | `/invoices/stock-check` | Jeton utilisateur | `invoice.write` | — |
| POST | `/invoices/:id/delivery-note` | Jeton utilisateur | `delivery.write` | — |

## /notifications

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/notifications/summary` | Jeton utilisateur | — | — |
| GET | `/notifications/` | Jeton utilisateur | — | — |
| POST | `/notifications/read-all` | Jeton utilisateur | — | — |
| GET | `/notifications/preferences` | Jeton utilisateur | — | — |
| PUT | `/notifications/preferences` | Jeton utilisateur | — | — |
| POST | `/notifications/:id/read` | Jeton utilisateur | — | — |

## /orders

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/orders/,/export` | Jeton utilisateur | `sales_order.read` | — |
| GET | `/orders/:id` | Jeton utilisateur | `sales_order.read` | — |
| GET | `/orders/:id/history` | Jeton utilisateur | `sales_order.read` | — |
| GET | `/orders/:id/pdf` | Jeton utilisateur | `sales_order.read` | — |
| POST | `/orders/:id/send` | Jeton utilisateur | `sales_order.write` | — |
| GET | `/orders/:id/emails` | Jeton utilisateur | `sales_order.read` | — |
| POST | `/orders/` | Jeton utilisateur | `sales_order.write` | — |
| POST | `/orders/from-quote/:id` | Jeton utilisateur | `sales_order.write` | — |
| PUT | `/orders/:id` | Jeton utilisateur | `sales_order.write` | — |
| POST | `/orders/:id/confirm` | Jeton utilisateur | `sales_order.validate` | — |
| POST | `/orders/:id/cancel` | Jeton utilisateur | `sales_order.validate` | — |
| DELETE | `/orders/:id` | Jeton utilisateur | `sales_order.delete` | — |
| POST | `/orders/:id/invoice` | Jeton utilisateur | `sales_order.validate` | — |
| POST | `/orders/:id/deposit` | Jeton utilisateur | `sales_order.validate` | — |

## /payments

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/payments/methods` | Jeton utilisateur | `payment.read` | — |
| GET | `/payments/,/export` | Jeton utilisateur | `payment.read` | — |
| GET | `/payments/:id` | Jeton utilisateur | `payment.read` | — |
| POST | `/payments/` | Jeton utilisateur | `payment.write` | — |
| POST | `/payments/:id/allocate` | Jeton utilisateur | `payment.write` | — |
| POST | `/payments/:id/cancel` | Jeton utilisateur | `payment.validate` | — |
| GET | `/payments/:id/history` | Jeton utilisateur | `payment.read` | — |

## /platform

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/platform/overview` | Super admin | — | — |
| GET | `/platform/plans` | Super admin | — | — |
| POST | `/platform/plans` | Super admin | — | — |
| PUT | `/platform/plans/:id` | Super admin | — | — |
| GET | `/platform/payment-info` | Super admin | — | — |
| PUT | `/platform/payment-info` | Super admin | — | — |
| GET | `/platform/payments` | Super admin | — | — |
| POST | `/platform/payments/:id/confirm` | Super admin | — | — |
| POST | `/platform/payments/:id/reject` | Super admin | — | — |
| GET | `/platform/companies` | Super admin | — | — |
| GET | `/platform/companies/:id` | Super admin | — | — |
| PUT | `/platform/companies/:id/subscription` | Super admin | — | — |
| POST | `/platform/companies/:id/suspend` | Super admin | — | — |
| POST | `/platform/companies/:id/reactivate` | Super admin | — | — |

## /product-categories

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/product-categories/` | Jeton utilisateur | `product.read` | — |
| POST | `/product-categories/` | Jeton utilisateur | `product.write` | — |
| PATCH | `/product-categories/:id` | Jeton utilisateur | `product.write` | — |
| DELETE | `/product-categories/:id` | Jeton utilisateur | `product.delete` | — |

## /products

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/products/` | Jeton utilisateur | `product.read` | — |
| GET | `/products/export.csv` | Jeton utilisateur | `product.read` | — |
| POST | `/products/import` | Jeton utilisateur | `product.write` | — |
| POST | `/products/` | Jeton utilisateur | `product.write` | — |
| GET | `/products/:id` | Jeton utilisateur | `product.read` | — |
| PATCH | `/products/:id` | Jeton utilisateur | `product.write` | — |
| DELETE | `/products/:id` | Jeton utilisateur | `product.delete` | — |

## /projects

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/projects/` | Jeton utilisateur | `project.read` | — |
| POST | `/projects/` | Jeton utilisateur | `project.write` | — |
| GET | `/projects/:id` | Jeton utilisateur | `project.read` | — |
| PUT | `/projects/:id` | Jeton utilisateur | `project.write` | — |
| DELETE | `/projects/:id` | Jeton utilisateur | `project.delete` | — |
| GET | `/projects/:id/linkable` | Jeton utilisateur | `project.read` | — |
| POST | `/projects/:id/documents` | Jeton utilisateur | `project.write` | — |
| DELETE | `/projects/:id/documents/:docType/:docId` | Jeton utilisateur | `project.write` | — |

## /purchase-credit-notes

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/purchase-credit-notes/` | Jeton utilisateur | `purchase.read` | — |
| GET | `/purchase-credit-notes/export` | Jeton utilisateur | `purchase.read` | — |
| GET | `/purchase-credit-notes/:id` | Jeton utilisateur | `purchase.read` | — |
| GET | `/purchase-credit-notes/:id/history` | Jeton utilisateur | `purchase.read` | — |
| POST | `/purchase-credit-notes/` | Jeton utilisateur | `purchase.write` | — |
| DELETE | `/purchase-credit-notes/:id` | Jeton utilisateur | `purchase.delete` | — |
| POST | `/purchase-credit-notes/:id/record` | Jeton utilisateur | `purchase.validate` | — |

## /purchase-expense-notes

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/purchase-expense-notes/,/export` | Jeton utilisateur | `expense_note.read` | — |
| GET | `/purchase-expense-notes/:id` | Jeton utilisateur | `expense_note.read` | — |
| GET | `/purchase-expense-notes/:id/history` | Jeton utilisateur | `expense_note.read` | — |
| POST | `/purchase-expense-notes/` | Jeton utilisateur | `expense_note.write` | — |
| PUT | `/purchase-expense-notes/:id` | Jeton utilisateur | `expense_note.write` | — |
| DELETE | `/purchase-expense-notes/:id` | Jeton utilisateur | `expense_note.delete` | — |
| POST | `/purchase-expense-notes/:id/validate` | Jeton utilisateur | `expense_note.validate` | — |
| POST | `/purchase-expense-notes/:id/cancel` | Jeton utilisateur | `expense_note.validate` | — |

## /purchase-invoices

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/purchase-invoices/` | Jeton utilisateur | `purchase.read` | — |
| GET | `/purchase-invoices/export` | Jeton utilisateur | `purchase.read` | — |
| GET | `/purchase-invoices/:id` | Jeton utilisateur | `purchase.read` | — |
| GET | `/purchase-invoices/:id/history` | Jeton utilisateur | `purchase.read` | — |
| POST | `/purchase-invoices/` | Jeton utilisateur | `purchase.write` | — |
| PUT | `/purchase-invoices/:id` | Jeton utilisateur | `purchase.write` | — |
| POST | `/purchase-invoices/from-order/:id` | Jeton utilisateur | `purchase.write` | — |
| POST | `/purchase-invoices/from-receipt/:id` | Jeton utilisateur | `purchase.write` | — |
| DELETE | `/purchase-invoices/:id` | Jeton utilisateur | `purchase.delete` | — |
| POST | `/purchase-invoices/:id/record` | Jeton utilisateur | `purchase.validate` | — |
| POST | `/purchase-invoices/:id/receipt` | Jeton utilisateur | `purchase_receipt.write` | — |
| POST | `/purchase-invoices/:id/cancel` | Jeton utilisateur | `purchase.validate` | — |

## /purchase-orders

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/purchase-orders/,/export` | Jeton utilisateur | `purchase.read` | — |
| GET | `/purchase-orders/:id` | Jeton utilisateur | `purchase.read` | — |
| GET | `/purchase-orders/:id/history` | Jeton utilisateur | `purchase.read` | — |
| GET | `/purchase-orders/:id/pdf` | Jeton utilisateur | `purchase.read` | — |
| POST | `/purchase-orders/:id/send` | Jeton utilisateur | `purchase.write` | — |
| GET | `/purchase-orders/:id/emails` | Jeton utilisateur | `purchase.read` | — |
| POST | `/purchase-orders/` | Jeton utilisateur | `purchase.write` | — |
| PUT | `/purchase-orders/:id` | Jeton utilisateur | `purchase.write` | — |
| POST | `/purchase-orders/:id/confirm` | Jeton utilisateur | `purchase.validate` | — |
| POST | `/purchase-orders/:id/cancel` | Jeton utilisateur | `purchase.validate` | — |
| DELETE | `/purchase-orders/:id` | Jeton utilisateur | `purchase.delete` | — |

## /purchase-receipts

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/purchase-receipts/,/export` | Jeton utilisateur | `purchase_receipt.read` | — |
| GET | `/purchase-receipts/:id` | Jeton utilisateur | `purchase_receipt.read` | — |
| GET | `/purchase-receipts/:id/history` | Jeton utilisateur | `purchase_receipt.read` | — |
| POST | `/purchase-receipts/` | Jeton utilisateur | `purchase_receipt.write` | — |
| PUT | `/purchase-receipts/:id` | Jeton utilisateur | `purchase_receipt.write` | — |
| DELETE | `/purchase-receipts/:id` | Jeton utilisateur | `purchase_receipt.delete` | — |
| POST | `/purchase-receipts/:id/validate` | Jeton utilisateur | `purchase_receipt.validate` | — |
| POST | `/purchase-receipts/:id/cancel` | Jeton utilisateur | `purchase_receipt.validate` | — |

## /purchase-returns

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/purchase-returns/,/export` | Jeton utilisateur | `purchase_return.read` | — |
| GET | `/purchase-returns/source/:id` | Jeton utilisateur | `purchase_return.read` | — |
| GET | `/purchase-returns/:id` | Jeton utilisateur | `purchase_return.read` | — |
| GET | `/purchase-returns/:id/history` | Jeton utilisateur | `purchase_return.read` | — |
| POST | `/purchase-returns/` | Jeton utilisateur | `purchase_return.write` | — |
| PUT | `/purchase-returns/:id` | Jeton utilisateur | `purchase_return.write` | — |
| DELETE | `/purchase-returns/:id` | Jeton utilisateur | `purchase_return.delete` | — |
| POST | `/purchase-returns/:id/validate` | Jeton utilisateur | `purchase_return.validate` | — |
| POST | `/purchase-returns/:id/cancel` | Jeton utilisateur | `purchase_return.validate` | — |

## /purchase-scans

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| POST | `/purchase-scans/` | Jeton utilisateur | `purchase.write` | — |
| GET | `/purchase-scans/` | Jeton utilisateur | `purchase.read` | — |
| GET | `/purchase-scans/:id` | Jeton utilisateur | `purchase.read` | — |
| GET | `/purchase-scans/:id/file` | Jeton utilisateur | `purchase.read` | — |
| POST | `/purchase-scans/:id/draft` | Jeton utilisateur | `purchase.write` | — |
| DELETE | `/purchase-scans/:id` | Jeton utilisateur | `purchase.write` | — |

## /purchases

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| POST | `/purchases/preview` | Jeton utilisateur | — | — |

## /quotes

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/quotes/,/export` | Jeton utilisateur | `quote.read` | — |
| GET | `/quotes/:id` | Jeton utilisateur | `quote.read` | — |
| GET | `/quotes/:id/history` | Jeton utilisateur | `quote.read` | — |
| GET | `/quotes/:id/pdf` | Jeton utilisateur | `quote.read` | — |
| POST | `/quotes/:id/send` | Jeton utilisateur | `quote.write` | — |
| GET | `/quotes/:id/emails` | Jeton utilisateur | `quote.read` | — |
| POST | `/quotes/` | Jeton utilisateur | `quote.write` | — |
| PUT | `/quotes/:id` | Jeton utilisateur | `quote.write` | — |
| POST | `/quotes/:id/status` | Jeton utilisateur | `quote.write` | — |
| POST | `/quotes/:id/duplicate` | Jeton utilisateur | `quote.write` | — |
| POST | `/quotes/:id/convert` | Jeton utilisateur | `quote.validate` | — |
| DELETE | `/quotes/:id` | Jeton utilisateur | `quote.delete` | — |

## /recurring-invoices

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/recurring-invoices/` | Jeton utilisateur | `invoice.read` | — |
| GET | `/recurring-invoices/:id` | Jeton utilisateur | `invoice.read` | — |
| GET | `/recurring-invoices/:id/history` | Jeton utilisateur | `invoice.read` | — |
| POST | `/recurring-invoices/` | Jeton utilisateur | `invoice.write` | — |
| PUT | `/recurring-invoices/:id` | Jeton utilisateur | `invoice.write` | — |
| POST | `/recurring-invoices/:id/pause` | Jeton utilisateur | `invoice.write` | — |
| POST | `/recurring-invoices/:id/resume` | Jeton utilisateur | `invoice.write` | — |
| POST | `/recurring-invoices/:id/end` | Jeton utilisateur | `invoice.write` | — |
| POST | `/recurring-invoices/run-due` | Jeton utilisateur | `invoice.write` | — |
| POST | `/recurring-invoices/:id/run` | Jeton utilisateur | `invoice.write` | — |
| DELETE | `/recurring-invoices/:id` | Jeton utilisateur | `invoice.delete` | — |

## /reminders

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/reminders/overdue` | Jeton utilisateur | `payment.read` | — |
| POST | `/reminders/send` | Jeton utilisateur | `payment.write` | — |
| GET | `/reminders/history` | Jeton utilisateur | `payment.read` | — |

## /reports

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/reports/` | Jeton utilisateur | `report.read` | — |
| GET | `/reports/:key` | Jeton utilisateur | `report.read` | — |

## /sales

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| POST | `/sales/preview` | Jeton utilisateur | — | — |
| POST | `/sales/sample-pdf` | Jeton utilisateur | — | — |

## /sales-expense-notes

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/sales-expense-notes/,/export` | Jeton utilisateur | `expense_note.read` | — |
| GET | `/sales-expense-notes/:id` | Jeton utilisateur | `expense_note.read` | — |
| GET | `/sales-expense-notes/:id/history` | Jeton utilisateur | `expense_note.read` | — |
| POST | `/sales-expense-notes/` | Jeton utilisateur | `expense_note.write` | — |
| PUT | `/sales-expense-notes/:id` | Jeton utilisateur | `expense_note.write` | — |
| DELETE | `/sales-expense-notes/:id` | Jeton utilisateur | `expense_note.delete` | — |
| POST | `/sales-expense-notes/:id/validate` | Jeton utilisateur | `expense_note.validate` | — |
| POST | `/sales-expense-notes/:id/cancel` | Jeton utilisateur | `expense_note.validate` | — |

## /sales-returns

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/sales-returns/,/export` | Jeton utilisateur | `sales_return.read` | — |
| GET | `/sales-returns/source/:id` | Jeton utilisateur | `sales_return.read` | — |
| GET | `/sales-returns/:id` | Jeton utilisateur | `sales_return.read` | — |
| GET | `/sales-returns/:id/history` | Jeton utilisateur | `sales_return.read` | — |
| POST | `/sales-returns/` | Jeton utilisateur | `sales_return.write` | — |
| PUT | `/sales-returns/:id` | Jeton utilisateur | `sales_return.write` | — |
| DELETE | `/sales-returns/:id` | Jeton utilisateur | `sales_return.delete` | — |
| POST | `/sales-returns/:id/validate` | Jeton utilisateur | `sales_return.validate` | — |
| POST | `/sales-returns/:id/cancel` | Jeton utilisateur | `sales_return.validate` | — |

## /stock

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/stock/warehouses` | Jeton utilisateur | `stock.read` | — |
| POST | `/stock/warehouses` | Jeton utilisateur | `stock.write` | — |
| PUT | `/stock/warehouses/:id` | Jeton utilisateur | `stock.write` | — |
| POST | `/stock/warehouses/:id/archive` | Jeton utilisateur | `stock.write` | — |
| POST | `/stock/warehouses/:id/restore` | Jeton utilisateur | `stock.write` | — |
| GET | `/stock/levels/export` | Jeton utilisateur | `stock.read` | — |
| GET | `/stock/levels` | Jeton utilisateur | `stock.read` | — |
| GET | `/stock/movements` | Jeton utilisateur | `stock.read` | — |
| GET | `/stock/movements/export` | Jeton utilisateur | `stock.read` | — |
| POST | `/stock/adjustments` | Jeton utilisateur | `stock.validate` | — |
| GET | `/stock/entries/,/export` | Jeton utilisateur | `stock.read` | — |
| GET | `/stock/entries/:id` | Jeton utilisateur | `stock.read` | — |
| GET | `/stock/entries/:id/history` | Jeton utilisateur | `stock.read` | — |
| POST | `/stock/entries/` | Jeton utilisateur | `stock.write` | — |
| PUT | `/stock/entries/:id` | Jeton utilisateur | `stock.write` | — |
| DELETE | `/stock/entries/:id` | Jeton utilisateur | `stock.delete` | — |
| POST | `/stock/entries/:id/validate` | Jeton utilisateur | `stock.validate` | — |
| POST | `/stock/entries/:id/cancel` | Jeton utilisateur | `stock.validate` | — |
| GET | `/stock/withdrawals/,/export` | Jeton utilisateur | `stock.read` | — |
| GET | `/stock/withdrawals/:id` | Jeton utilisateur | `stock.read` | — |
| GET | `/stock/withdrawals/:id/history` | Jeton utilisateur | `stock.read` | — |
| POST | `/stock/withdrawals/` | Jeton utilisateur | `stock.write` | — |
| PUT | `/stock/withdrawals/:id` | Jeton utilisateur | `stock.write` | — |
| DELETE | `/stock/withdrawals/:id` | Jeton utilisateur | `stock.delete` | — |
| POST | `/stock/withdrawals/:id/validate` | Jeton utilisateur | `stock.validate` | — |
| POST | `/stock/withdrawals/:id/cancel` | Jeton utilisateur | `stock.validate` | — |
| GET | `/stock/transfers/,/export` | Jeton utilisateur | `stock.read` | — |
| GET | `/stock/transfers/:id` | Jeton utilisateur | `stock.read` | — |
| GET | `/stock/transfers/:id/history` | Jeton utilisateur | `stock.read` | — |
| POST | `/stock/transfers/` | Jeton utilisateur | `stock.write` | — |
| PUT | `/stock/transfers/:id` | Jeton utilisateur | `stock.write` | — |
| DELETE | `/stock/transfers/:id` | Jeton utilisateur | `stock.delete` | — |
| POST | `/stock/transfers/:id/validate` | Jeton utilisateur | `stock.validate` | — |
| POST | `/stock/transfers/:id/cancel` | Jeton utilisateur | `stock.validate` | — |
| GET | `/stock/counts/` | Jeton utilisateur | `stock.read` | — |
| GET | `/stock/counts/:id` | Jeton utilisateur | `stock.read` | — |
| GET | `/stock/counts/:id/history` | Jeton utilisateur | `stock.read` | — |
| POST | `/stock/counts/` | Jeton utilisateur | `stock.write` | — |
| PUT | `/stock/counts/:id/lines` | Jeton utilisateur | `stock.write` | — |
| POST | `/stock/counts/:id/validate` | Jeton utilisateur | `stock.validate` | — |
| DELETE | `/stock/counts/:id` | Jeton utilisateur | `stock.delete` | — |

## /subscription

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/subscription/` | Jeton utilisateur | `subscription.read` | — |
| GET | `/subscription/plans` | Jeton utilisateur | `subscription.read` | — |
| GET | `/subscription/payment-info` | Jeton utilisateur | `subscription.read` | — |
| GET | `/subscription/payments` | Jeton utilisateur | `subscription.read` | — |
| POST | `/subscription/payments` | Jeton utilisateur | `subscription.write` | — |

## /supplier-balances

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/supplier-balances/,/export` | Jeton utilisateur | `purchase.read` | — |
| GET | `/supplier-balances/:id` | Jeton utilisateur | `purchase.read` | — |
| GET | `/supplier-balances/:id/statement,/:id/statement/export` | Jeton utilisateur | `purchase.read` | — |

## /supplier-payments

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/supplier-payments/methods` | Jeton utilisateur | `payment.read` | — |
| GET | `/supplier-payments/,/export` | Jeton utilisateur | `payment.read` | — |
| GET | `/supplier-payments/:id` | Jeton utilisateur | `payment.read` | — |
| POST | `/supplier-payments/` | Jeton utilisateur | `payment.write` | — |
| POST | `/supplier-payments/:id/allocate` | Jeton utilisateur | `payment.write` | — |
| POST | `/supplier-payments/:id/cancel` | Jeton utilisateur | `payment.validate` | — |
| GET | `/supplier-payments/:id/history` | Jeton utilisateur | `payment.read` | — |

## /suppliers

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/suppliers/` | Jeton utilisateur | `supplier.read` | — |
| GET | `/suppliers/export.csv` | Jeton utilisateur | `supplier.read` | — |
| POST | `/suppliers/import` | Jeton utilisateur | `supplier.write` | — |
| POST | `/suppliers/` | Jeton utilisateur | `supplier.write` | — |
| GET | `/suppliers/:id` | Jeton utilisateur | `supplier.read` | — |
| PATCH | `/suppliers/:id` | Jeton utilisateur | `supplier.write` | — |
| DELETE | `/suppliers/:id` | Jeton utilisateur | `supplier.delete` | — |

## /tax-rates

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/tax-rates/` | Jeton utilisateur | `tax_rate.read` | — |
| POST | `/tax-rates/` | Jeton utilisateur | `tax_rate.write` | — |
| PATCH | `/tax-rates/:id` | Jeton utilisateur | `tax_rate.write` | — |
| DELETE | `/tax-rates/:id` | Jeton utilisateur | `tax_rate.delete` | — |

## /treasury

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/treasury/accounts` | Jeton utilisateur | `treasury.read` | — |
| GET | `/treasury/accounts/:id` | Jeton utilisateur | `treasury.read` | — |
| POST | `/treasury/accounts` | Jeton utilisateur | `treasury.write` | — |
| PUT | `/treasury/accounts/:id` | Jeton utilisateur | `treasury.write` | — |
| POST | `/treasury/accounts/:id/archive` | Jeton utilisateur | `treasury.delete` | — |
| POST | `/treasury/accounts/:id/restore` | Jeton utilisateur | `treasury.delete` | — |
| GET | `/treasury/transactions` | Jeton utilisateur | `treasury.read` | — |
| POST | `/treasury/transactions` | Jeton utilisateur | `treasury.write` | — |
| POST | `/treasury/transfers` | Jeton utilisateur | `treasury.write` | — |
| POST | `/treasury/transactions/:id/cancel` | Jeton utilisateur | `treasury.validate` | — |
| POST | `/treasury/transactions/reconcile` | Jeton utilisateur | `treasury.validate` | — |
| GET | `/treasury/instruments` | Jeton utilisateur | `treasury.read` | — |
| POST | `/treasury/instruments/:id/deposit` | Jeton utilisateur | `treasury.validate` | — |
| POST | `/treasury/instruments/:id/clear` | Jeton utilisateur | `treasury.validate` | — |
| POST | `/treasury/instruments/:id/bounce` | Jeton utilisateur | `treasury.validate` | — |
| GET | `/treasury/summary` | Jeton utilisateur | `treasury.read` | — |

## /users

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/users/` | Jeton utilisateur | `user.read` | — |
| GET | `/users/permissions-matrix` | Jeton utilisateur | `user.read` | — |
| GET | `/users/roles` | Jeton utilisateur | `user.read` | — |
| GET | `/users/invitations` | Jeton utilisateur | `user.read` | — |
| POST | `/users/invitations` | Jeton utilisateur | `user.write` | — |
| DELETE | `/users/invitations/:id` | Jeton utilisateur | `user.write` | — |
| PATCH | `/users/:id/role` | Jeton utilisateur | `user.write` | — |
| PATCH | `/users/:id/status` | Jeton utilisateur | `user.write` | — |

## /withholdings

| Méthode | Chemin | Accès | Permission | Offre |
| --- | --- | --- | --- | --- |
| GET | `/withholdings/sales` | Jeton utilisateur | `withholding.read` | — |
| PUT | `/withholdings/sales/:id/certificate` | Jeton utilisateur | `withholding.write` | — |
| GET | `/withholdings/purchases` | Jeton utilisateur | `withholding.read` | — |
| PUT | `/withholdings/purchases/:id/certificate` | Jeton utilisateur | `withholding.write` | — |
| GET | `/withholdings/purchases/tej-prep` | Jeton utilisateur | `withholding.read` | — |
| GET | `/withholdings/purchases/tej-prep/export` | Jeton utilisateur | `withholding.read` | — |
| GET | `/withholdings/tej/codes` | Jeton utilisateur | `withholding.read` | — |
| PUT | `/withholdings/purchases/:id/tej-operation` | Jeton utilisateur | `withholding.write` | — |
| GET | `/withholdings/purchases/tej-prep/xml` | Jeton utilisateur | `withholding.read` | — |

