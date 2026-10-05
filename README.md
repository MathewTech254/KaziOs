# KaziOS

## The AI-native operating system for African businesses

KaziOS is a business management platform designed to bring sales, point of sale, inventory, customers, purchasing, invoicing, payments, reporting and AI-powered business intelligence into one connected system.

Built in Kenya for African businesses, KaziOS is designed around real business operations including multiple branches, inventory management, digital payments, financial tracking, business reporting and the challenges of operating in markets where connectivity and infrastructure can vary.

The long-term goal is to build a complete operating platform that allows African businesses to run their day-to-day operations from one system.

---

## Overview

Many businesses depend on multiple disconnected systems for:

- Point of sale
- Inventory
- Customers
- Purchasing
- Invoicing
- Payments
- Expenses
- Accounting
- Reporting
- Business intelligence

KaziOS brings these workflows into a unified platform.

The core idea is simple:

```text
Sale
 |
 +-- Payment
 |
 +-- Inventory
 |
 +-- Customer
 |
 +-- Accounting
 |
 +-- Reporting
 |
 +-- AI Insights
````

A business transaction should not exist in isolation.

When a sale happens, the corresponding inventory, payment, customer history, financial records and reporting should remain connected.

---

## Core Platform

### Point of Sale

KaziOS is being developed around a complete business POS experience.

Capabilities include:

* Product search
* SKU support
* Barcode support
* Shopping cart
* Quantity management
* Customer selection
* Walk-in customers
* Discounts
* Tax handling
* Payment processing
* Sales records
* Receipts
* Returns and refunds
* Cashier workflows

The POS is designed to connect directly with inventory, customers, payments and financial records.

### Products and Inventory

KaziOS provides the foundation for managing products and stock.

Capabilities include:

* Products
* SKUs
* Barcodes
* Categories
* Brands
* Units
* Selling prices
* Cost prices
* Tax categories
* Reorder levels
* Warehouses
* Branches
* Stock movements
* Stock adjustments
* Inventory reporting

The inventory architecture is designed around traceable stock movements rather than simply storing a current quantity.

### Customers

Customer management includes:

* Individual customers
* Business customers
* Customer profiles
* Customer history
* Customer invoices
* Customer payments
* Outstanding balances
* Returns
* Business information

The POS is designed to support both existing customers and walk-in transactions.

### Sales and Invoicing

KaziOS connects sales with the rest of the business system.

Capabilities include:

* Sales
* Invoices
* Invoice line items
* Payments
* Partial payments
* Invoice status
* Invoice lifecycle
* Customer balances
* Payment tracking

### Purchasing

The purchasing system is designed around the complete supplier workflow:

```text
Supplier
   |
Purchase Order
   |
Receiving
   |
Inventory
   |
Supplier Balance
   |
Payment
```

The architecture is intended to support supplier management, purchase orders, receiving, inventory updates and supplier financial tracking.

### Branches and Warehouses

KaziOS supports organization-level business locations including:

* Branches
* Warehouses
* Branch-specific operations
* Branch users
* Warehouse management
* Stock allocation

The architecture is designed to support businesses operating from multiple locations.

### Roles and Permissions

KaziOS includes role-based access control.

Permissions are designed to control access to business operations such as:

* Sales
* Reports
* Inventory
* Settings
* Users
* Financial operations
* Organization management

Authorization is enforced at the application level rather than relying only on frontend visibility.

### Audit Logging

Important business mutations are recorded through an audit system.

This provides a foundation for tracking:

* Who performed an action
* What was changed
* When it happened
* Which organization was affected

---

## Payments

KaziOS uses Paystack as its primary payment integration.

The payment architecture is designed around:

* Server-side payment initialization
* Payment verification
* Transaction references
* Webhooks
* Idempotency
* Payment states
* Subscription billing
* Billing history

Payment credentials are never intended to be exposed to the frontend.

Payment status is determined by verified backend information rather than by client-side success messages.

---

## SaaS and Subscription Model

KaziOS is being developed with a SaaS business model.

The platform is intended to support:

* Free and community usage
* Paid plans
* Monthly billing
* Annual billing
* Feature entitlements
* Usage limits
* AI usage limits
* Subscription lifecycle management
* Billing history
* Plan upgrades
* Plan downgrades
* Subscription cancellation
* Payment recovery

The planned commercial model separates the core KaziOS platform from additional managed services, higher limits and advanced capabilities.

Planned plan structure:

```text
Community
    |
Starter
    |
Business
    |
Enterprise
```

Exact pricing and plan capabilities will evolve as the product moves through development and market validation.

---

## AI Business Intelligence

AI is intended to be one of KaziOS's major differentiators.

Rather than functioning only as a conversational chatbot, the AI layer is designed to work with authorized business data and tools.

Examples of business questions include:

```text
How much did we sell today?

Which products are running low?

Which products are selling fastest?

Why did profit decrease this month?

Who currently owes the business money?

Which customers have not purchased recently?

What should we reorder?

Which branch is performing best?

Summarize today's business.
```

The architecture is designed around controlled AI operations:

```text
User
  |
AI
  |
Intent
  |
Authorized Tool
  |
Business Data
  |
Validation
  |
Response
```

Sensitive operations should require appropriate authorization and confirmation.

The AI layer should never receive unrestricted database access.

---

## Designed for African Businesses

KaziOS is being designed with African business environments in mind.

The platform architecture considers:

* Kenyan businesses
* Kenyan Shillings
* Paystack
* M-PESA-compatible payment architecture
* eTIMS and KRA integration
* WhatsApp
* SMS
* Email
* Multi-branch operations
* Unreliable internet connectivity
* Small and medium businesses
* Local tax requirements

The payment and communication architecture is intended to remain extensible so additional providers can be integrated without rewriting the core business domain.

---

## Architecture

KaziOS is structured as an npm workspaces monorepo.

```text
KaziOS/
|
+-- apps/
|   |
|   +-- api/
|   |   +-- Express API
|   |
|   +-- web/
|   |   +-- React + Vite frontend
|   |
|   +-- worker/
|       +-- BullMQ background worker
|
+-- packages/
|   |
|   +-- types/
|   +-- validation/
|   +-- config/
|   +-- integrations/
|   +-- ai/
|   +-- ui/
|
+-- prisma/
+-- docker-compose.yml
+-- package.json
```

### Technology Stack

| Layer           | Technology                 |
| --------------- | -------------------------- |
| Frontend        | React, Vite                |
| Styling         | Tailwind CSS               |
| Backend         | Node.js, Express           |
| Database        | PostgreSQL                 |
| ORM             | Prisma                     |
| Background Jobs | BullMQ                     |
| Queue           | Redis                      |
| Validation      | Zod                        |
| Authentication  | JWT and Redis              |
| Payments        | Paystack                   |
| AI              | OpenAI-compatible AI layer |
| Architecture    | npm workspaces monorepo    |

---

## Current Status

KaziOS is actively under development.

The project currently contains working foundations for:

* Authentication
* Organization management
* Role-based permissions
* Tenant isolation
* Products
* Customers
* Invoices
* Payments
* Branches
* Warehouses
* Tax categories
* Settings
* Reports
* Audit logging
* Background workers
* Notifications
* Demo business data
* POS transaction infrastructure
* Paystack integration architecture

The remaining product work is focused on connecting and hardening these foundations into complete end-to-end business workflows.

Features listed in the roadmap are not necessarily production-ready.

---

## Demo Business

KaziOS includes a realistic demo organization for development and testing.

```text
Highlands Provisions
KaziOS Demo Organization
```

The demo environment contains:

* Multiple branches
* Warehouses
* Products
* SKUs
* Barcodes
* Tax categories
* Customers
* Suppliers
* Staff
* Roles
* Invoices
* Payments
* Purchase orders
* Stock transfers
* POS sales
* Low-stock scenarios
* Out-of-stock scenarios

The data is designed to represent connected business activity.

For example:

```text
Purchase
   |
Receiving
   |
Inventory Increase
   |
Customer Sale
   |
Payment
   |
Inventory Decrease
   |
Customer History
   |
Financial Records
   |
Reports
```

### Seed Demo Data

Preview the seed operation:

```powershell
node apps/api/scripts/seed-demo-org.mjs
```

Apply the demo data:

```powershell
node apps/api/scripts/seed-demo-org.mjs --apply
```

Demo credentials should only be used in an isolated development or demo environment.

---

## Real-Time Notifications

KaziOS uses Server-Sent Events and Redis pub/sub for real-time browser notifications.

```text
Business Event
      |
Notification Service
      |
PostgreSQL
      |
Redis Pub/Sub
      |
SSE
      |
Browser
```

The notification system is designed to support events such as:

* Completed sales
* Settled payments
* Low-stock conditions
* Overdue invoices

Notifications are stored and delivered through the application notification service.

---

## Development

### Requirements

* Node.js
* npm
* Docker Desktop
* PostgreSQL
* Redis

Docker is recommended for local PostgreSQL and Redis.

### Clone the Repository

```powershell
git clone <REPOSITORY_URL>
cd KaziOS
```

### Start Infrastructure

```powershell
docker compose up -d postgres redis
```

### Configure Environment

Create the required environment files using the project's environment examples.

Never commit real credentials or secrets.

### Prepare the Database

```powershell
cd apps/api

npx prisma migrate dev
npx prisma generate
```

### Start KaziOS

From the repository root:

```powershell
npm run dev
```

Development services:

```text
Web       http://localhost:3000
API       http://localhost:4000
Worker    BullMQ background processing
```

---

## Development Commands

| Command                     | Purpose                                   |
| --------------------------- | ----------------------------------------- |
| `npm run dev`               | Start the web application, API and worker |
| `npm run typecheck`         | Typecheck the workspaces                  |
| `npm test`                  | Run the test suite                        |
| `npm run build`             | Build the project                         |
| `npm run verify`            | Typecheck and build                       |
| `npm run lint`              | Lint the workspaces                       |
| `docker compose up --build` | Build and start the containers            |

---

## Testing

KaziOS includes multiple levels of testing.

### Unit Tests

Unit tests cover areas such as:

* Money calculations
* Validation
* Stock rules
* Audit redaction

### Integration Tests

Integration tests exercise real HTTP and database workflows, including:

* Tenant isolation
* Permissions
* Sales
* Ledger behavior
* Database operations

### UI Tests

The web workspace contains tests for React components.

### Browser Checks

Additional browser-level checks are available for functionality that cannot be detected through typechecking alone.

Run:

```powershell
npm test
```

or:

```powershell
npm run verify
```

---

## Security

KaziOS is designed to handle business and financial information.

Security considerations include:

* Tenant isolation
* Server-side authorization
* Role-based permissions
* Input validation
* Payment verification
* Webhook verification
* Audit logging
* Rate limiting
* Database constraints
* Transactional business operations
* Secret management

Never commit:

* API keys
* Database credentials
* Payment secrets
* Authentication secrets
* Private business data

---

## Roadmap

### Core Platform

* [x] Authentication
* [x] Organizations
* [x] Products
* [x] Customers
* [x] Invoices
* [x] Payments
* [x] Branches
* [x] Warehouses
* [x] Roles and permissions
* [x] Audit logging
* [x] Settings
* [x] Notifications

### Point of Sale

* [x] POS transaction foundation
* [ ] Complete cashier workflow
* [ ] Barcode scanning
* [ ] Hold and resume orders
* [ ] Returns and refunds
* [ ] Split payments
* [ ] Cashier shifts
* [ ] End-of-day reconciliation
* [ ] Offline POS

### Inventory

* [x] Product management
* [x] Stock foundations
* [ ] Complete inventory ledger
* [ ] Stock transfers
* [ ] Stocktaking
* [ ] Batch and lot tracking
* [ ] Automated replenishment
* [ ] Inventory forecasting

### Finance

* [ ] Complete accounting workflows
* [ ] General ledger
* [ ] Accounts receivable
* [ ] Accounts payable
* [ ] Profit and loss
* [ ] Balance sheet
* [ ] Cash flow
* [ ] Reconciliation

### Procurement

* [ ] Complete purchasing lifecycle
* [ ] Supplier management
* [ ] Receiving
* [ ] Supplier bills
* [ ] Purchase analytics
* [ ] Automated replenishment

### AI

* [ ] AI business copilot
* [ ] Finance intelligence
* [ ] Sales intelligence
* [ ] Inventory intelligence
* [ ] Procurement intelligence
* [ ] Executive insights
* [ ] Controlled AI actions

### SaaS

* [ ] Pricing system
* [ ] Free plan
* [ ] Paid plans
* [ ] Paystack subscription billing
* [ ] Usage limits
* [ ] Feature entitlements
* [ ] Billing portal
* [ ] Subscription lifecycle
* [ ] Platform administration

### African Integrations

* [x] Paystack architecture
* [ ] M-PESA integration
* [ ] eTIMS and KRA integration
* [ ] WhatsApp
* [ ] SMS
* [ ] Email providers

---

## Product Direction

The long-term goal of KaziOS is to provide one platform through which a business can:

```text
Sell
Buy
Track
Manage
Pay
Account
Analyze
Automate
Grow
```

The platform is being developed toward a model where operational data, financial information and AI-powered intelligence work together rather than existing as separate systems.

---

## Documentation

Additional documentation will cover:

* Architecture
* Database
* API
* Authentication
* Payments
* AI
* Integrations
* Deployment
* Self-hosting
* Contribution guidelines

Detailed technical documentation should live in the `docs/` directory rather than making the README unnecessarily large.

---

## Contributing

KaziOS is currently under active development.

Contribution policies and development guidelines will be documented as the project expands its contribution model.

Before submitting changes:

```powershell
npm run verify
npm test
```

Do not commit secrets, credentials or private business data.

---

## License

KaziOS is currently distributed under a proprietary source-available license.

The repository is publicly visible for development, transparency, evaluation and collaboration under the terms of the project's license.

Public visibility does not automatically make a project open source.

See [LICENSE](./LICENSE) for the applicable terms.

Copyright © 2026 Mathew Kioko. All rights reserved.
