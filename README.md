# Kanz Corner Accounting

Accounting for Kanz Corner Trading: customers, suppliers, products & stock, sales invoices (15 % VAT,
ZATCA-style QR), purchases, cashbook, VAT / P&L / ageing reports, users and roles. Your Excel workbook
(`KanzCorner_Cashbook.xlsx`) was imported into `data/excel-export.json`.

## Run it

```bash
npm install
KANZ_ADMIN_PASSWORD='choose-a-strong-password' npm run seed   # one-time: creates data/kanz.db from your Excel data
npm start                                                       # http://localhost:3000   (user: owner)
npm test
```

Needs Node 22.13+. No external database server: data lives in one SQLite file (`KANZ_DB`, default `data/kanz.db`).
**Back this file up** (copy it daily) – it is your whole accounting record.

## Going live (hosted)
Deploy the `Dockerfile` to any host with a persistent disk mounted at `/data` (Render, Railway, Fly.io, a VPS).
Put it behind HTTPS (the host usually does this) and set `KANZ_ADMIN_PASSWORD` before the first start.

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
