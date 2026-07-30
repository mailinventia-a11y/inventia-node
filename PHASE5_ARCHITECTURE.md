# Inventia Phase 5

Phase 5 extends the existing Express and vanilla JavaScript application. The current design tokens, component classes, navigation, dark mode, and Phase 1–4 compatibility routes remain in place.

## Local compatibility mode

```powershell
npm install
npm start
```

When PostgreSQL and Redis variables are absent, the control plane uses `data/control.db`, the default organization uses the existing `pos.db`, cache/events use in-process fallbacks, and the application remains available at `http://localhost:3000`.

Development seed accounts are `admin / admin123` and `vivin / manager123`. Change or disable them before a production rollout.

## Production-shaped Docker mode

Set strong values for `JWT_SECRET`, `TENANT_MASTER_KEY`, and `POSTGRES_PASSWORD`, then run:

```powershell
docker compose up -d --build
```

The Compose stack contains:

- Express/Socket.IO application
- PostgreSQL control database
- a separately provisioned PostgreSQL database for each organization
- Redis cache and event transport
- BullMQ worker

Tenant connection records and integration credentials are AES-256-GCM encrypted. Production startup rejects the built-in development secrets.

## Migration

Always run a dry run first:

```powershell
npm run migrate:dry-run
```

The dry run copies the legacy SQLite database to an isolated temporary directory, applies Phase 5 migrations, and compares record counts, sales totals, and stock totals. Apply mode creates a timestamped backup under `data/backups/` before migrating:

```powershell
npm run migrate:apply
```

Rollback consists of stopping application traffic, restoring the generated database backup, and restoring the previous connection configuration.

## Security and transaction rules

- `/api/v1` uses Argon2id, signed access JWTs, rotating refresh sessions, organization claims, and permission grants.
- Every state-changing `/api/v1` request requires `Idempotency-Key`.
- Inventory quantity changes only through the immutable movement ledger.
- Sales-order approval reserves stock; fulfilment consumes it; cancellation releases it.
- PO receipt creates a GRN and stock receipt in one transaction.
- AI and business search read only from the active tenant. AI write requests remain proposals until an authorized approval.
- Razorpay returns `503 integration_not_configured` when credentials are missing. The browser never simulates successful payment.
- The webhook route verifies the raw request body before processing and records duplicate events.
- `POST /api/v1/pos/checkout` is the only checkout mutation path. It commits sale, stock, immutable GST snapshot, payment allocations, and customer ledger entries together.
- Invoice values are authoritative integer minor units. `decimal.js` handles quantities, discounts, GST allocation, and paise rounding.
- Invoice PDF rendering happens after the commercial transaction commits. Failed renders create a durable `invoice.pdf.generate` job and can be retried without duplicating financial or stock records.
- Local invoice PDFs use `uploads/invoices/{organizationId}/{year}/{invoiceNumber}-v{n}.pdf`; clients retrieve them only through authenticated tenant-scoped endpoints.
- Legacy `/api` routes are restricted to the default organization while clients migrate to `/api/v1`.

## Verification

```powershell
npm run check
npm test
npm audit --audit-level=high
```

API documentation is available at `/api/v1/docs` and `/api/v1/openapi.json`.
