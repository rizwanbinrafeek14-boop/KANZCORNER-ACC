# Kanz Corner Accounting

Accounting for Kanz Corner Trading: customers, suppliers, products & stock, sales invoices (15 % VAT,
ZATCA-style QR), purchases, cashbook, VAT / P&L / ageing reports, users and roles. Your Excel workbook
(`KanzCorner_Cashbook.xlsx`) was imported into `data/excel-export.json`.

## Run it

```bash
npm install
npm start        # http://localhost:3000 – first start imports your Excel data
npm test
```

Needs Node 18.18+ (Node 22 recommended).

## First sign-in
Open the site. The **first screen asks you to create the admin account** (name, username, password) – that user becomes the
owner. After that the screen never appears again; the owner adds staff under *Settings & users*.
To stop a stranger grabbing the admin account before you do, set `KANZ_SETUP_CODE` on the host first – the setup screen then
asks for that code. (Alternative: set `KANZ_ADMIN_USERNAME` + `KANZ_ADMIN_PASSWORD` and skip the screen.)

## Database
* **Hosted Postgres (Supabase, recommended for going live):** set `DATABASE_URL` to your connection string. Tables are created
  automatically on first start and your Excel data is imported once. Row-level security is switched on for every table so
  Supabase's public API cannot read them – only this server can.
* **No `DATABASE_URL`:** an embedded Postgres stores data in `KANZ_DATA_DIR` (default `data/pgdata`). Fine for trying it out;
  keep the folder backed up.

### Supabase setup
1. supabase.com → New project (save the database password).
2. **Connect** button → **Session pooler** connection string (works over IPv4 – most hosts need this), e.g.
   `postgres://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres`
3. On your host add the environment variables below. **Never commit the string or paste it in chat.**

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Supabase connection string |
| `KANZ_SETUP_CODE` | Optional: code required on the first-time setup screen |
| `KANZ_ADMIN_USERNAME` / `KANZ_ADMIN_PASSWORD` | Optional: create/reset the owner at every start (skips the setup screen) |
| `DATABASE_SSL` | `false` only for a local non-SSL Postgres |
| `DATABASE_POOL_MAX` | Max connections (default 5) |

## Going live (hosted)
Start command `npm start` (entry `server.js`), Node 22. With Supabase no persistent disk is needed. (Docker users: the `Dockerfile` uses the embedded database in `/data`.)
Put it behind HTTPS (the host usually does this) and set the admin variables before the first start.

## How the numbers work (same rules as your Excel)
* **Cashbook** is the source of truth for cash/bank. Cash sales and cash purchases made in the app write a cashbook line automatically.
* **Credit sales / credit bills** build what customers owe you / you owe suppliers; payments recorded with the
  *Customer Payment* / *Supplier Payment* category (or the Record payment buttons) reduce them (oldest invoice first).
* **Ageing** buckets are by invoice age; **overdue** is by due date.
* VAT is 15 % (Settings). Reports are cash-basis estimates – confirm with your accountant before ZATCA filing.

## Roles
owner (everything) · accountant (everything except users/settings) · cashier (sell, add cash entries, view).

## Review after import
Open **Import check** in the app: it lists every problem found in the Excel data (missing invoice numbers,
undated bills, a possible duplicate cash purchase, negative cash in hand, …).
