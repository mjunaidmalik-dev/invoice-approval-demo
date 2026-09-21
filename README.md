# Invoice Approval Demo

A working demonstration of a supplier-invoice approval system: multi-role login,
a two-stage approval chain with a full audit trail, Excel import with row-level
validation, and automatic matching of bank payments against invoices.

Built as a portfolio piece. Every name, vendor and figure in it is invented.

---

## What it does

Chain: **Raised → Manager → Finance → Paid**

- A manager approves at stage one, finance approves and settles at stage two.
- Returning an invoice requires a written reason and sends it back to the submitter.
- Every stage move is written to an append-only trail: who, what, from where, to where, when.
- Invoices are imported from a spreadsheet. Rows that cannot be trusted are refused and
  listed with the reason rather than being loaded and corrected afterwards.
- Bank payments are matched to invoices by number, then by causality (a payment cannot
  settle an invoice raised after it), then by closest amount. Anything that does not match
  is kept as an orphan with the reason shown.

---

## Run it locally

```bash
npm install
createdb invoicedemo

export DATABASE_URL=postgres://postgres:password@localhost:5432/invoicedemo
export JWT_SECRET=$(openssl rand -base64 48)

npm run seed      # applies schema.sql and loads the demo data
npm start         # http://localhost:4000
```

`node seed.js --files-only` regenerates just the two demo spreadsheets.

### Demo accounts — password `Demo@2026`

| Email | Role | What they see |
|---|---|---|
| submitter@demo.app | Submitter | Raises and imports invoices |
| manager@demo.app | Manager | Approves or returns at stage one |
| finance@demo.app | Finance | Approves, settles, imports bank files |
| admin@demo.app | Admin | Everything |

The login screen lists all four as buttons. A visitor who has to guess a password leaves.

---

## Deploy

Any host that runs Node and reaches a Postgres will do. On Render:

1. New Web Service from the repository. Build `npm install`, start `npm start`.
2. Create a Postgres instance (Render, Neon or Supabase all work).
3. Environment variables: `DATABASE_URL`, `JWT_SECRET`, and `PGSSL=true` if the database
   is hosted separately from the app.
4. Run the seed once against the deployed database.

Free tiers sleep after inactivity, so the first visit can take around 30 seconds. The
login screen says so if the server does not answer, rather than showing a dead button.

---

## Design decisions worth knowing

**Authentication is applied once, to everything.** `/api/health` and `/api/login` are the
only open routes; every other route goes through one middleware. Adding an endpoint
cannot accidentally leave it unprotected.

**Permissions are read from the database on every request, not from the token.** Change
someone's role and it takes effect on their next click, not when their token expires.

**The approve endpoint ignores any user identity in the request body.** The acting user
comes from the verified token. Validating a body field instead would leave it looking
meaningful to a caller.

**`from_stage` is recorded, never inferred.** If a move ever has to be undone, the trail
holds the evidence of where the invoice actually came from.

**Approvals lock the row.** Two approvers clicking at the same moment would otherwise
both read the same stage and advance it twice.

**The header map and the required-column check work off the same field names.** A map
that knows an alias while the check looks for a literal header is how a perfectly correct
file gets reported as missing a column.

**Import summaries are checked, not just stated.** Every response carries a `reconciles`
flag proving rows read equals imported plus refused plus skipped. A summary that does not
add up is worse than none, because it is believed.

**Dates are parsed explicitly and refused when ambiguous.** Excel hands back a serial
number for a date cell and a string for a text one; `31/02/2026` is rejected rather than
rolled into March. Dates coming out of the database are formatted in SQL, never by
slicing a JavaScript `Date` as text.

**Returning an invoice uses a dialog, not `prompt()`.** After a few dialogs the browser
offers to suppress them, and a suppressed prompt returns null — which reads as
"cancelled", so a run of rejections would silently not happen.

---

## The demo import files

`demo-files/demo-invoices-to-import.xlsx` — 30 rows, 8 deliberately broken and scattered
through the file: blank amount, amount as text, negative amount, blank invoice number,
duplicate of an invoice already in the system, duplicate within the same file,
unparseable date, and a due date before its invoice date.

`demo-files/demo-payments-to-import.xlsx` — 12 rows: 9 that match, one orphan, one payment
dated before its invoice was raised, and one repeated transaction ID. Importing the same
file twice is harmless; the second run matches nothing and skips all twelve.

---

## Stack

Node · Express · PostgreSQL · JWT · bcrypt · SheetJS · Chart.js. No front-end framework —
two HTML pages and one script.
