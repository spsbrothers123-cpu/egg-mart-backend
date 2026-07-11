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

# 5. Seed initial data (products, users, customers)
npm run seed

# 6. Start dev server (with file watching)
npm run dev
```

Server runs at **http://localhost:3001**

---

## Default Credentials (after seed)

| Role    | Username | Password  |
|---------|----------|-----------|
| Admin   | admin    | admin123  |
| Cashier | cashier  | 1234      |

---

## API Endpoints

### Auth
| Method | Path                        | Role    | Description           |
|--------|-----------------------------|---------|-----------------------|
| POST   | /api/auth/login             | Public  | Login, get JWT token  |
| GET    | /api/auth/me                | Any     | Get current user      |
| POST   | /api/auth/change-password   | Any     | Change own password   |

### Products
| Method | Path                        | Role    | Description           |
|--------|-----------------------------|---------|-----------------------|
| GET    | /api/products               | Any     | List products         |
| GET    | /api/products/:id           | Any     | Get one product       |
| POST   | /api/products               | Admin   | Create product        |
| PUT    | /api/products/:id           | Admin   | Update product        |
| DELETE | /api/products/:id           | Admin   | Soft delete product   |
| GET    | /api/products/categories/list | Any   | List categories       |

### Bills (POS)
| Method | Path                        | Role    | Description           |
|--------|-----------------------------|---------|-----------------------|
| GET    | /api/bills                  | Any     | List bills            |
| GET    | /api/bills/:id              | Any     | Get bill with items   |
| POST   | /api/bills                  | Any     | Create bill (sale)    |
| PATCH  | /api/bills/:id/void         | Admin   | Void a bill           |

### Customers
| Method | Path                        | Role    | Description           |
|--------|-----------------------------|---------|-----------------------|
| GET    | /api/customers              | Any     | List customers        |
| GET    | /api/customers/:id          | Any     | Get customer + history|
| POST   | /api/customers              | Any     | Add customer          |
| PUT    | /api/customers/:id          | Any     | Update customer       |
| DELETE | /api/customers/:id          | Admin   | Soft delete           |

### Inventory
| Method | Path                            | Role    | Description         |
|--------|---------------------------------|---------|---------------------|
| GET    | /api/inventory                  | Any     | Stock levels        |
| GET    | /api/inventory/low-stock        | Any     | Low stock items     |
| POST   | /api/inventory/adjust           | Admin   | Adjust stock        |
| GET    | /api/inventory/:id/history      | Admin   | Stock history       |

### Expenses
| Method | Path                        | Role    | Description           |
|--------|-----------------------------|---------|-----------------------|
| GET    | /api/expenses               | Admin   | List expenses         |
| POST   | /api/expenses               | Admin   | Add expense           |
| PUT    | /api/expenses/:id           | Admin   | Update expense        |
| DELETE | /api/expenses/:id           | Admin   | Delete expense        |

### Reports
| Method | Path                        | Role    | Description           |
|--------|-----------------------------|---------|-----------------------|
| GET    | /api/reports/summary        | Admin   | Daily summary         |
| GET    | /api/reports/range          | Admin   | Date range report     |
| GET    | /api/reports/products       | Admin   | Product sales report  |
| GET    | /api/reports/expenses       | Admin   | Expense report        |

### Suppliers
| Method | Path                        | Role    | Description           |
|--------|-----------------------------|---------|-----------------------|
| GET    | /api/suppliers              | Admin   | List suppliers        |
| POST   | /api/suppliers              | Admin   | Add supplier          |
| PUT    | /api/suppliers/:id          | Admin   | Update supplier       |
| DELETE | /api/suppliers/:id          | Admin   | Soft delete           |

### Users
| Method | Path                            | Role    | Description         |
|--------|---------------------------------|---------|---------------------|
| GET    | /api/users                      | Admin   | List users          |
| POST   | /api/users                      | Admin   | Create cashier      |
| PUT    | /api/users/:id                  | Admin   | Update user         |
| POST   | /api/users/:id/reset-password   | Admin   | Reset password      |
| GET    | /api/users/activity-logs        | Admin   | Activity logs       |

### Sessions
| Method | Path                        | Role    | Description           |
|--------|-----------------------------|---------|-----------------------|
| GET    | /api/sessions/current       | Any     | Get open session      |
| POST   | /api/sessions/open          | Any     | Open cash session     |
| POST   | /api/sessions/:id/close     | Any     | Close cash session    |

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
