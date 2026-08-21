# 🥚 Egg Mart POS — Backend API

Fastify + PostgreSQL REST API for the Egg Mart POS system.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env with your PostgreSQL credentials and JWT secret

# 3. Create database
createdb egg_mart

# 4. Run migrations (creates all tables)
npm run migrate

# 4b. Apply schema alterations (multi-shop, split payments, and other
#     incremental changes) — safe to run repeatedly, backfills existing data
npm run alter

# 5. Seed initial data (products, users, customers, a default shop)
npm run seed

# 6. Start dev server (with file watching)
npm run dev

# (optional) Run the unit test suite
npm test
```

Server runs at **http://localhost:3001**

---

## Default Credentials (after seed)

| Role    | Username | Password  | Shop        |
|---------|----------|-----------|-------------|
| Admin   | admin    | admin123  | owns "Main Shop" |
| Cashier | cashier  | 1234      | Main Shop   |

`npm run seed` also creates and assigns a default "Main Shop" so the seeded cashier can log in and bill immediately. Additional admins register via `POST /api/auth/register-admin`; additional shops/cashiers are created by an admin via `POST /api/shops` and `POST /api/users`.

---

## API Endpoints

### Auth
| Method | Path                        | Role    | Description                          |
|--------|-----------------------------|---------|---------------------------------------|
| POST   | /api/auth/register-admin    | Public  | Register a new Admin account (no shops yet) |
| POST   | /api/auth/login             | Public  | Login, get JWT token (includes shop_id for cashiers) |
| GET    | /api/auth/me                | Any     | Get current user (+ shop, for cashiers) |
| POST   | /api/auth/change-password   | Any     | Change own password                  |

### Shops
| Method | Path                        | Role    | Description                          |
|--------|-----------------------------|---------|---------------------------------------|
| GET    | /api/shops                  | Admin   | List own shops (with cashier counts) |
| GET    | /api/shops/:id              | Admin   | Get own shop + its cashiers          |
| POST   | /api/shops                  | Admin   | Create a shop                        |
| PUT    | /api/shops/:id              | Admin   | Update own shop                      |
| DELETE | /api/shops/:id              | Admin   | Deactivate own shop (soft)           |

### Products
| Method | Path                        | Role    | Description           |
|--------|-----------------------------|---------|-----------------------|
| GET    | /api/products               | Any     | List products in your shop scope |
| GET    | /api/products/:id           | Any     | Get one product (own shop scope) |
| POST   | /api/products               | Admin   | Create product (body requires `shop_id`, must be owned) |
| PUT    | /api/products/:id           | Admin   | Update product (own shop) |
| DELETE | /api/products/:id           | Admin   | Soft delete product (own shop) |
| GET    | /api/products/categories/list | Any   | List categories (shared, unscoped) |

### Bills (POS)
| Method | Path                        | Role    | Description           |
|--------|-----------------------------|---------|-----------------------|
| GET    | /api/bills                  | Any     | List bills in your shop scope (`?shop_id=` to narrow, admin only) |
| GET    | /api/bills/:id              | Any     | Get bill with items + split-payment breakdown |
| POST   | /api/bills                  | Any     | Create bill. Cashiers bill their own shop automatically; admins must pass `shop_id`. Supports `payment_method: "split"` with a `payments[]` array — see below. |
| PATCH  | /api/bills/:id/settle-credit| Admin   | Mark a credit sale as paid |
| PATCH  | /api/bills/:id/void         | Admin   | Void a bill (restores stock, releases pending credit) |

### Customers
| Method | Path                        | Role    | Description           |
|--------|-----------------------------|---------|-----------------------|
| GET    | /api/customers              | Any     | List customers in your shop scope |
| GET    | /api/customers/:id          | Any     | Get customer + history (own shop scope) |
| POST   | /api/customers              | Any     | Add customer (cashiers use own shop; admins must pass `shop_id`) |
| PUT    | /api/customers/:id          | Any     | Update customer (own shop scope) |
| DELETE | /api/customers/:id          | Admin   | Soft delete (own shop scope) |

### Inventory
| Method | Path                            | Role    | Description         |
|--------|----------------------------------|---------|---------------------|
| GET    | /api/inventory                  | Any     | Stock levels (own shop scope) |
| GET    | /api/inventory/low-stock        | Any     | Low stock items (own shop scope) |
| POST   | /api/inventory/adjust           | Admin   | Adjust stock (product must be in an owned shop) |
| GET    | /api/inventory/:id/history      | Admin   | Stock history (product must be in an owned shop) |

### Expenses
| Method | Path                        | Role    | Description           |
|--------|-----------------------------|---------|-----------------------|
| GET    | /api/expenses               | Admin   | List expenses in your shops |
| POST   | /api/expenses               | Admin   | Add expense (requires `shop_id`, must be owned) |
| PUT    | /api/expenses/:id           | Admin   | Update expense (own shop scope) |
| DELETE | /api/expenses/:id           | Admin   | Delete expense (own shop scope) |

### Reports
| Method | Path                          | Role    | Description           |
|--------|-------------------------------|---------|-----------------------|
| GET    | /api/reports/summary          | Admin   | Daily summary (`?shop_id=` to narrow) |
| GET    | /api/reports/range            | Admin   | Date range report (`?shop_id=`) |
| GET    | /api/reports/products         | Admin   | Product sales report (`?shop_id=`) |
| GET    | /api/reports/expenses         | Admin   | Expense report (`?shop_id=`) |
| GET    | /api/reports/payment-methods  | Admin   | Cash/Card/UPI breakdown, decomposing split-payment bills into their real component methods (`?shop_id=`) |

### Suppliers
| Method | Path                        | Role    | Description           |
|--------|-----------------------------|---------|-----------------------|
| GET    | /api/suppliers              | Admin   | List suppliers in your shops |
| POST   | /api/suppliers              | Admin   | Add supplier (requires `shop_id`, must be owned) |
| PUT    | /api/suppliers/:id          | Admin   | Update supplier (own shop scope) |
| DELETE | /api/suppliers/:id          | Admin   | Soft delete (own shop scope) |

### Users & Sessions
| Method | Path                            | Role    | Description         |
|--------|----------------------------------|---------|---------------------|
| GET    | /api/users                      | Admin   | List cashiers across your shops |
| POST   | /api/users                      | Admin   | Create a cashier (requires `shop_id`, must be owned — admin accounts can only be created via `/api/auth/register-admin`) |
| PUT    | /api/users/:id                  | Admin   | Edit a cashier's name/username (own shop scope) |
| POST   | /api/users/:id/reset-password   | Admin   | Reset a cashier's password (own shop scope) |
| GET    | /api/users/:userId/sessions     | Admin   | A cashier's session history (own shop scope) |
| GET    | /api/users/activity-logs        | Admin   | Activity logs — your own actions + your cashiers' |

### Sessions
| Method | Path                        | Role    | Description           |
|--------|-----------------------------|---------|-----------------------|
| GET    | /api/sessions                | Admin   | List sessions across your shops |
| GET    | /api/sessions/current        | Any     | Get open session (own)|
| GET    | /api/sessions/my             | Any     | Own session history   |
| POST   | /api/sessions/open           | Any     | Open cash session (cashier must be assigned to a shop) |
| POST   | /api/sessions/:id/close      | Any     | Close cash session    |

---

## Multi-Shop Model

```
Admin
 ├── Shop A
 │     ├── Cashier 1
 │     └── Cashier 2
 └── Shop B
       └── Cashier 3
```

- One Admin can own many Shops (`POST /api/shops`); each Shop can have many Cashiers.
- Every cashier is assigned to exactly one shop (`users.shop_id`), embedded in their JWT at login.
- All shop-scoped data (products, customers, suppliers, bills, expenses, purchases, sessions) carries a `shop_id`. Reads and writes are always scoped to the authenticated user's own shop(s) — a cashier only ever sees their own shop; an admin only ever sees shops they own. Client-supplied `shopId`/`userId` values are never trusted for authorization.
- **Admin accounts** are created via the public `POST /api/auth/register-admin` (there is no super-admin — each admin is an independent tenant). **Cashier accounts** are always created by an authenticated admin via `POST /api/users`, scoped to one of that admin's own shops.
- Existing pre-migration data (from before this feature) was backfilled into a "Main Shop" owned by the earliest existing admin account — see `src/db/alter.js`.

### Split Payments

`POST /api/bills` accepts a normal single `payment_method` (`cash` / `card` / `upi` / `net_banking` / `credit`), or `payment_method: "split"` with exactly two portions:

```json
{
  "items": [{ "name": "Eggs (30 pc tray)", "price": 80, "qty": 1 }],
  "payment_method": "split",
  "payments": [
    { "method": "card", "amount": 60 },
    { "method": "cash", "amount": 20 }
  ]
}
```

The server independently re-derives the bill total from `items` and rejects the request (400) if the portions under- or over-pay it — the frontend total is never trusted. `gpay` is accepted as an input alias for `upi` so split sales report in the same bucket as regular UPI sales. Each portion is persisted individually in `bill_payments`, so `GET /api/reports/payment-methods` can report true Cash/Card/UPI totals even for split bills.

---

## Authentication

All protected endpoints require a Bearer token:

```
Authorization: Bearer <token>
```

Get a token via `POST /api/auth/login`.

---

## Tech Stack

- **Runtime**: Node.js (ESM)
- **Framework**: Fastify 4
- **Database**: PostgreSQL via `postgres` (node-postgres)
- **Auth**: JWT via `@fastify/jwt`
- **Password hashing**: bcryptjs
- **Dev server**: `node --watch`
