# KaziOS API Reference

> Hand-maintained catalogue of the HTTP surface exposed by `apps/api`. Source of truth is the route files under `apps/api/src/routes/`. There is no OpenAPI/Swagger spec yet — request/response shapes are defined by the Zod schemas in `packages/validation/src/index.ts`.

- **Base URL (local)**: `http://localhost:4000`
- **API prefix**: `/api/v1`
- **Health check**: `GET /health`
- **API root**: `GET /` (returns service metadata + resource list)

---

## 1. Base URL & versioning

All business endpoints live under `/api/v1/<resource>`. Webhook endpoints live under `/api/v1/webhooks/*` and do **not** require a session.

```
http://localhost:4000/api/v1/<resource>
```

In production the host is the deployed API origin (see `DEPLOY_FREE.md` / `DEPLOYMENT_CHECKLIST.md`).

---

## 2. Authentication

KaziOS uses **session-based auth** with a signed cookie plus an optional bearer token.

- Sign in via `POST /api/v1/auth/login` returns a session token and sets a signed `sid` cookie.
- Subsequent requests authenticate with **one** of:
  - `Authorization: Bearer <token>` header
  - signed `sid` cookie (sent automatically by browsers with `credentials: true`)
  - `?access_token=<token>` query param — **only** honoured by the notification stream (`GET /api/v1/notifications/stream`), because `EventSource` cannot set headers.
- Sessions are stored in Redis and expire after 7 days (rolling).

### Roles & permissions

Every user has one or more `UserRole` rows linking to a `Role` with a `permissions` array (e.g. `["*"]` for Owner, or scoped like `invoices.send`, `inventory.adjust`). Endpoints that need a specific permission are guarded by `requirePermission(...)` and return `403` otherwise. Routes guarded only by `requireAuth` require any signed-in active user of the org.

---

## 3. Request / response format

- All request bodies are JSON (`Content-Type: application/json`), max 10 MB.
- Responses are JSON. Successful reads return the entity or an array; mutations return the created/updated entity.
- Dates are ISO-8601 strings. Money is returned as numbers (KES by default for the seeded org).
- Pagination (where supported): query params `page` (default 1), `limit` (default 50, max 100), `sortBy`, `sortOrder` (`asc`/`desc`, default `desc`). Date ranges use `startDate`/`endDate` (ISO datetime).

---

## 4. Error format

```json
{ "error": "Human readable message", "code": "MACHINE_READABLE_CODE" }
```

Common status codes:

| Code | Meaning |
|------|---------|
| 400 | Validation failure / bad input |
| 401 | Not authenticated (missing/invalid/expired session or inactive account) |
| 403 | Insufficient permissions / role / entitlement |
| 404 | Resource not found |
| 409 | Conflict (e.g. duplicate email, duplicate slug) |
| 429 | Rate limited |
| 500 | Server error |

Validation errors surface Zod's message text in `error`.

---

## 5. Rate limiting

- General API: 1000 requests / 60 s per IP (`RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`).
- Auth endpoints (`/api/v1/auth/*`): 30 failed attempts / 15 min per IP (`AUTH_RATE_LIMIT_*`), successful logins not counted.
- Webhooks are **not** rate limited (provider retries must not be throttled).

---

## 6. Webhooks (unauthenticated, signature-verified)

Mounted at `/api/v1/webhooks/*`:

| Method | Path | Provider | Notes |
|--------|------|----------|-------|
| POST | `/api/v1/webhooks/paystack` | Paystack | HMAC signature on raw body. Settles card payments. |
| POST | `/api/v1/webhooks/mpesa` | Safaricom Daraja | Cannot settle on its own; only triggers a re-query. |
| GET  | `/api/v1/webhooks/whatsapp` | Meta | Verification challenge. |
| POST | `/api/v1/webhooks/whatsapp` | Meta | Signed with `X-Hub-Signature-256`. |

---

## 7. Endpoint catalogue

Legend: 🔒 = requires `requireAuth`. 🔑 = requires a specific permission (shown). 🌐 = public.
### Auth — `/api/v1/auth`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/register` | 🌐 | Create a new organization + owner account, branch, warehouse, default chart of accounts & tax categories. |
| POST | `/login` | 🌐 | Sign in; returns session token + sets `sid` cookie. |
| POST | `/logout` | 🔒 | Destroy the current session. |
| GET  | `/me` | 🔒 | Current user + roles + organization. |
| POST | `/forgot-password` | 🌐 | Start a password reset (response identical whether or not the email exists). |
| POST | `/reset-password/verify` | 🌐 | Verify a reset token. |
| POST | `/reset-password` | 🌐 | Complete the password reset. |

### Organization — `/api/v1/org`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | 🔒 | Get the current organization. |
| PATCH | `/` | 🔒 | Update org profile. |
| GET | `/whatsapp-number` | 🔒 | Get configured WhatsApp number. |
| PATCH | `/whatsapp-number` | 🔒 | Set WhatsApp number. |
| DELETE | `/whatsapp-number` | 🔒 | Remove WhatsApp number. |
| GET | `/branches` | 🔒 | List branches. |
| POST | `/branches` | 🔒 | Create a branch. |
| PATCH | `/branches/:id` | 🔒 | Update a branch. |
| DELETE | `/branches/:id` | 🔒 | Delete a branch. |
| GET | `/warehouses` | 🔒 | List warehouses. |
| POST | `/warehouses` | 🔒 | Create a warehouse. |
| PATCH | `/warehouses/:id` | 🔒 | Update a warehouse. |
| DELETE | `/warehouses/:id` | 🔒 | Delete a warehouse. |

### Products — `/api/v1/products`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | 🔒 | List products (search, filter, paginate). |
| POST | `/` | 🔒 | Create a product. |
| GET | `/:id` | 🔒 | Get a product. |
| PATCH | `/:id` | 🔒 | Update a product. |
| DELETE | `/:id` | 🔒 | Delete a product. |

### Customers — `/api/v1/customers`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | 🔒 | List customers. |
| POST | `/` | 🔒 | Create a customer. |
| GET | `/:id` | 🔒 | Get a customer (with invoices/balance). |
| PATCH | `/:id` | 🔒 | Update a customer. |
| DELETE | `/:id` | 🔒 | Delete a customer. |

### Suppliers — `/api/v1/suppliers`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | 🔒 | List suppliers. |
| GET | `/:id` | 🔒 | Get a supplier. |
| POST | `/` | 🔒 | Create a supplier. |
| PATCH | `/:id` | 🔒 | Update a supplier. |
| DELETE | `/:id` | 🔒 | Delete a supplier. |

### Invoices — `/api/v1/invoices`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | 🔒 | List invoices. |
| POST | `/` | 🔒 | Create an invoice. |
| GET | `/:id` | 🔒 | Get an invoice. |
| POST | `/:id/send` | 🔒 | Mark/send an invoice. |
| POST | `/:id/void` | 🔒 | Void an invoice. |

### Payments — `/api/v1/payments`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | 🔒 | List payments. |
| POST | `/` | 🔒 | Record a payment against an invoice. |
| GET | `/:id` | 🔒 | Get a payment. |

### POS — `/api/v1/pos`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/context` | 🔒 | Till context (branch, warehouse, currency, tax). |
| GET | `/products` | 🔒 | POS product search (barcode/SKU/name). |
| POST | `/sale` | 🔒 | Post a sale (creates invoice + payments + stock movements). |
| POST | `/sales/:id/return` | 🔒 | Process a return/refund. |
| GET | `/receipt/:invoiceId` | 🔒 | Render a receipt (PDF/text). |
| POST | `/sales/:invoiceId/mpesa` | 🔒 | Initiate M-PESA STK push for a sale. |
| POST | `/mpesa/confirm` | 🔒 | Confirm an M-PESA sale after polling. |

### Inventory — `/api/v1/inventory`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/summary` | 🔒 | Stock summary (totals, low/out counts). |
| GET | `/` | 🔒 | List inventory rows (product × warehouse). |
| GET | `/movements` | 🔒 | Stock movement ledger. |
| POST | `/adjustments` | 🔒 | Stock adjustment (opening stock, corrections). |
| GET | `/transfers` | 🔒 | List stock transfers. |
| POST | `/transfers` | 🔒 | Create a stock transfer. |
| POST | `/transfers/:id/complete` | 🔒 | Complete a transfer. |
| POST | `/transfers/:id/cancel` | 🔒 | Cancel a pending transfer. |

### Purchase orders — `/api/v1/purchase-orders`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | 🔒 | List purchase orders. |
| POST | `/` | 🔒 | Create a purchase order. |
| GET | `/:id` | 🔒 | Get a purchase order. |
| PATCH | `/:id` | 🔒 | Update a PO. |
| POST | `/:id/send` | 🔒 | Send a PO to supplier. |
| POST | `/:id/cancel` | 🔒 | Cancel a PO. |
| DELETE | `/:id` | 🔒 | Delete a PO. |

### Expenses — `/api/v1/expenses`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/summary` | 🔒 | Expense summary. |
| GET | `/` | 🔒 | List expenses. |
| POST | `/` | 🔒 | Record an expense. |
| POST | `/:id/void` | 🔒 | Void an expense. |
| GET | `/categories` | 🔒 | List expense categories. |
| POST | `/categories` | 🔒 | Create an expense category. |
| DELETE | `/categories/:id` | 🔒 | Delete an expense category. |

### Reports — `/api/v1/reports`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/search` | 🔒 | Global search across entities. |
| GET | `/dashboard` | 🔒 | Dashboard KPIs. |
| GET | `/sales-summary` | 🔒 | Sales summary (by period/product/etc.). |

### Tax categories — `/api/v1/tax-categories`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | 🔒 | List tax categories. |
| POST | `/` | 🔒 | Create a tax category. |
| PATCH | `/:id` | 🔒 | Update a tax category. |
| DELETE | `/:id` | 🔒 | Delete a tax category. |

### Users — `/api/v1/users`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | 🔒 | List users. |
| POST | `/` | 🔒 | Create a user. |
| POST | `/:id/roles` | 🔒 | Assign a role to a user. |
| DELETE | `/:id/roles/:userRoleId` | 🔒 | Remove a role from a user. |

### Roles — `/api/v1/roles`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/permissions` | 🔒 | List all available permissions. |
| GET | `/` | 🔒 | List roles. |
| POST | `/` | 🔒 | Create a role. |
| PATCH | `/:id` | 🔒 | Update a role. |
| DELETE | `/:id` | 🔒 | Delete a role. |

### Settings — `/api/v1/settings`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | 🔒 | Get all settings for the org. |
| PUT | `/:key` | 🔒 | Set a setting (key must be one of `invoicing`, `pos`, `notifications`, `accounting`, `payments`). |
| DELETE | `/:key` | 🔒 | Reset a setting to default. |

### Notifications — `/api/v1/notifications`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | 🔒 | List notifications. |
| POST | `/read` | 🔒 | Mark notifications as read. |
| GET | `/stream` | 🔒 (token via query) | SSE stream of real-time notifications. |

### Card payments — `/api/v1/card-payments`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/methods` | 🔒 | Available card payment methods. |
| POST | `/initialize` | 🔒 | Initialize a Paystack charge. |
| POST | `/confirm` | 🔒 | Confirm a card payment. |
| POST | `/paystack` | 🌐 (webhook) | Paystack webhook (mounted under `/webhooks` too). |

### M-PESA — `/api/v1/mpesa`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/mpesa` | 🌐 (webhook) | Daraja callback. |

### AI — `/api/v1/ai`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/status` | 🔒 | AI feature status. |
| POST | `/ask` | 🔒 | Ask the AI copilot a question. |
| GET | `/whatsapp` | 🌐 | WhatsApp webhook verification. |
| POST | `/whatsapp` | 🌐 | WhatsApp inbound message handler. |

### Plans — `/api/v1/plans` (public catalogue)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | 🌐 | List plans. |
| GET | `/:key` | 🌐 | Get a plan by key. |

### Billing — `/api/v1/billing`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/summary` | 🔒 | Billing summary. |
| GET | `/payments` | 🔒 | Billing payment history. |
| GET | `/history` | 🔒 | Subscription history. |
| GET | `/entitlements` | 🔒 | Current entitlements/limits. |
| POST | `/checkout` | 🔒 | Start a checkout. |
| POST | `/checkout/confirm` | 🔒 | Confirm a checkout. |
| POST | `/checkout/mpesa` | 🔒 | M-PESA checkout. |
| POST | `/checkout/mpesa/confirm` | 🔒 | Confirm M-PESA checkout. |
| GET | `/change-plan/:key` | 🔒 | Preview a plan change. |
| POST | `/downgrade` | 🔒 | Schedule a downgrade. |
| DELETE | `/downgrade` | 🔒 | Cancel a scheduled downgrade. |
| POST | `/cancel` | 🔒 | Cancel subscription. |
| POST | `/resume` | 🔒 | Resume subscription. |

### Platform admin — `/api/v1/platform`
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/businesses` | 🔒 platform admin | List businesses. |
| GET | `/subscriptions` | 🔒 platform admin | List subscriptions. |
| GET | `/overview` | 🔒 platform admin | Platform overview. |
| POST | `/overrides` | 🔒 platform admin | Apply an override. |

---

## 8. Notes & caveats

- **No OpenAPI spec** ships with the repo; this document is hand-maintained from the route files. Regenerate the endpoint list with: `grep -rhoE "Router\.(get|post|put|patch|delete)\([^)]*" apps/api/src/routes | sort -u`.
- Request/response field shapes live in `packages/validation/src/index.ts` (Zod schemas such as `zRegisterSchema`, `zOrganizationSchema`, `zPaginationSchema`, etc.) and in the Prisma schema (`apps/api/prisma/schema.prisma`).
- Errors always use `{ error, code? }`. See `apps/api/src/middleware/errorHandler.ts`.
- CORS is allow-list based (`CORS_ORIGIN` env, comma-separated). Credentials must be enabled on the client.
- The API trusts one proxy hop (`trust proxy = 1`) for client IP resolution behind Render/Railway/Fly/Koyeb.
- Card-payments webhook is also mounted at `/api/v1/webhooks` (see section 6).

