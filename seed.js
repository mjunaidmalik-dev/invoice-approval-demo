#!/usr/bin/env node
/* ============================================================
 * Invoice Approval Demo — seed script
 *
 *   node seed.js              load the database AND write the Excel files
 *   node seed.js --files-only just write the Excel files
 *   node seed.js --reset      drop and recreate the tables first
 *
 * Connection comes from DATABASE_URL, e.g.
 *   DATABASE_URL=postgres://user:pass@localhost:5432/invoicedemo node seed.js --reset
 * ============================================================ */

const fs     = require('fs');
const path   = require('path');
const bcrypt = require('bcryptjs');
const XLSX   = require('xlsx');

const FILES_ONLY = process.argv.includes('--files-only');
const RESET      = process.argv.includes('--reset');
const OUT_DIR    = path.join(__dirname, 'demo-files');

const DEMO_PASSWORD = 'Demo@2026';

// ---------- deterministic RNG -------------------------------
// A fixed seed means every reset produces the SAME demo. When a
// buyer asks "what happens if I approve this one", you want the
// same invoice to be there next time.
let _s = 20260913;
function rnd() { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; }
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100;

// ---------- reference data ----------------------------------
const VENDORS = [
  'Northwind Supplies',
  'Orbit Logistics',
  'Cedar Office Solutions',
  'Vertex IT Services',
  'Harbour Facilities Ltd',
  'Blue Ridge Printing'
];

const DESCRIPTIONS = [
  'Office consumables — monthly',
  'Courier and freight charges',
  'Software licence renewal',
  'Cleaning and maintenance',
  'Print and stationery',
  'Hardware purchase',
  'Consultancy — professional fees',
  'Warehouse rental'
];

const USERS = [
  { full_name: 'Ayesha Karim',  email: 'submitter@demo.app', role: 'SUBMITTER', acts_at_stage: 'SUBMITTED', can_approve: false, can_reject: false, can_import: true  },
  { full_name: 'Daniel Okafor', email: 'manager@demo.app',   role: 'MANAGER',   acts_at_stage: 'MANAGER',   can_approve: true,  can_reject: true,  can_import: false },
  { full_name: 'Mei Tanaka',    email: 'finance@demo.app',   role: 'FINANCE',   acts_at_stage: 'FINANCE',   can_approve: true,  can_reject: true,  can_import: true  },
  { full_name: 'Demo Admin',    email: 'admin@demo.app',     role: 'ADMIN',     acts_at_stage: null,        can_approve: true,  can_reject: true,  can_import: true  }
];

const iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// ---------- build the invoice set ---------------------------
// 80 invoices over three months, spread across the chain so every
// screen has something on it the moment the demo loads.
function buildInvoices() {
  const months = [
    { y: 2026, m: 5 },   // June 2026  — all settled
    { y: 2026, m: 6 },   // July 2026  — mostly settled
    { y: 2026, m: 7 }    // August 2026 — live queue
  ];

  const rows = [];
  let n = 1001;

  months.forEach((mo, mi) => {
    const count = mi === 2 ? 30 : 25;
    for (let i = 0; i < count; i++) {
      const invDate = new Date(Date.UTC(mo.y, mo.m, 1 + Math.floor(rnd() * 27)));
      const amount  = between(180, 14500);

      // Stage mix by month
      let stage, status;
      if (mi === 0) { stage = 'PAID'; status = 'Paid'; }
      else if (mi === 1) {
        const r = rnd();
        stage  = r < 0.75 ? 'PAID' : (r < 0.9 ? 'FINANCE' : 'MANAGER');
        status = stage === 'PAID' ? 'Paid' : 'Pending';
      } else {
        // NOTE: there is no SUBMITTED + Pending state. Submitting moves an
        // invoice straight to MANAGER, so an invoice is only ever back at
        // SUBMITTED because it was REJECTED and returned.
        const r = rnd();
        if (r < 0.50)      { stage = 'MANAGER';   status = 'Pending';  }
        else if (r < 0.78) { stage = 'FINANCE';   status = 'Pending';  }
        else if (r < 0.90) { stage = 'SUBMITTED'; status = 'Rejected'; }
        else               { stage = 'PAID';      status = 'Paid';     }
      }

      rows.push({
        invoice_no:   'INV-' + (n++),
        vendor:       pick(VENDORS),
        description:  pick(DESCRIPTIONS),
        amount,
        invoice_date: iso(invDate),
        due_date:     iso(addDays(invDate, 30)),
        stage,
        status
      });
    }
  });
  return rows;
}

// ---------- approvals trail ---------------------------------
// Written from the invoice's own stage, so the trail and the
// stage can never disagree. Every stage move has a row; a
// rejection carries a reason and bounces to SUBMITTED.
const REJECT_REASONS = [
  'PO number missing — please attach and resubmit',
  'Amount differs from the quotation on file',
  'Wrong cost centre',
  'Duplicate of an invoice already submitted'
];

function buildApprovals(invoices, userIds) {
  const out = [];
  const chain = ['SUBMITTED', 'MANAGER', 'FINANCE', 'PAID'];

  invoices.forEach((inv, idx) => {
    const base = new Date(inv.invoice_date + 'T09:00:00Z');
    let t = 0;
    const at = () => iso(addDays(base, ++t)) + ' 10:' + String(10 + (idx % 45)).padStart(2, '0') + ':00';

    out.push({ invoice_no: inv.invoice_no, email: 'submitter@demo.app', action: 'SUBMIT',
               from_stage: null, to_stage: 'MANAGER', note: null, acted_at: at() });

    if (inv.status === 'Rejected') {
      out.push({ invoice_no: inv.invoice_no, email: 'manager@demo.app', action: 'REJECT',
                 from_stage: 'MANAGER', to_stage: 'SUBMITTED',
                 note: pick(REJECT_REASONS), acted_at: at() });
      return;
    }

    const target = chain.indexOf(inv.stage);
    for (let s = 1; s <= target; s++) {
      const from = chain[s - 1], to = chain[s];
      if (to === 'FINANCE') {
        out.push({ invoice_no: inv.invoice_no, email: 'manager@demo.app', action: 'APPROVE',
                   from_stage: 'MANAGER', to_stage: 'FINANCE', note: null, acted_at: at() });
      } else if (to === 'PAID') {
        out.push({ invoice_no: inv.invoice_no, email: 'finance@demo.app', action: 'PAY',
                   from_stage: 'FINANCE', to_stage: 'PAID', note: 'Settled by bank transfer', acted_at: at() });
      }
    }
  });
  return out;
}

// ---------- payments ----------------------------------------
// One payment per PAID invoice, plus the awkward cases that make
// the reconciliation screen worth showing.
function buildPayments(invoices) {
  const out = [];
  let t = 900001;
  const txn = () => 'TXN' + (t++);

  invoices.filter(i => i.stage === 'PAID').forEach((inv, i) => {
    let amount = inv.amount;
    if (i % 17 === 0) amount = Math.round(inv.amount * 0.6 * 100) / 100;  // partial
    if (i % 23 === 0) amount = Math.round(inv.amount * 1.05 * 100) / 100; // over
    out.push({
      txn_id: txn(), invoice_no: inv.invoice_no, amount,
      paid_date: iso(addDays(new Date(inv.invoice_date + 'T00:00:00Z'), 18 + (i % 14))),
      bank: i % 3 === 0 ? 'First Commercial' : 'Meridian Bank'
    });
  });

  // Orphan — money in, no such invoice
  out.push({ txn_id: txn(), invoice_no: 'INV-9999', amount: 2400.00,
             paid_date: '2026-08-14', bank: 'Meridian Bank' });
  // Orphan — vendor reference, not an invoice number at all
  out.push({ txn_id: txn(), invoice_no: 'REF/ORBIT/AUG', amount: 850.00,
             paid_date: '2026-08-19', bank: 'First Commercial' });

  return out;
}

// ---------- import files ------------------------------------
// The point of this file is the ERRORS. A buyer clicks Import and
// watches 8 bad rows get named and refused while 22 good ones load.
function buildImportSheet(existingNos) {
  const rows = [];
  let n = 2001;
  const good = () => {
    const d = new Date(Date.UTC(2026, 7, 5 + Math.floor(rnd() * 20)));
    return {
      'Invoice No':  'INV-' + (n++),
      'Vendor':      pick(VENDORS),
      'Description': pick(DESCRIPTIONS),
      'Amount':      between(200, 9000),
      'Invoice Date': iso(d),
      'Due Date':    iso(addDays(d, 30))
    };
  };

  for (let i = 0; i < 22; i++) rows.push(good());

  // --- the eight deliberate defects, one of each kind ---
  const bad = [];

  // 1. no amount at all
  bad.push({ ...good(), 'Amount': '' });
  // 2. amount is text
  bad.push({ ...good(), 'Amount': 'TBC' });
  // 3. negative amount
  bad.push({ ...good(), 'Amount': -450 });
  // 4. missing invoice number
  bad.push({ ...good(), 'Invoice No': '' });
  // 5. duplicate of an invoice already in the database
  bad.push({ ...good(), 'Invoice No': existingNos[3] });
  // 6. duplicate WITHIN this file
  bad.push({ ...rows[0] });
  // 7. unparseable date
  bad.push({ ...good(), 'Invoice Date': '31/02/2026' });
  // 8. due date before the invoice date
  const b8 = good(); b8['Due Date'] = '2026-01-01'; bad.push(b8);

  // Interleave so they aren't all at the bottom — a buyer should
  // see the error list pick them out, not scroll to a bad block.
  const mixed = [];
  rows.forEach((r, i) => { mixed.push(r); if (i % 3 === 1 && bad.length) mixed.push(bad.shift()); });
  return mixed.concat(bad);
}

function buildPaymentSheet(invoices) {
  const rows = [];
  let t = 950001;
  const pending = invoices.filter(i => i.stage === 'FINANCE').slice(0, 12);

  pending.forEach((inv, i) => {
    rows.push({
      'Txn ID':      'TXN' + (t++),
      'Invoice No':  inv.invoice_no,
      'Amount Paid': i === 2 ? Math.round(inv.amount * 0.5 * 100) / 100 : inv.amount,
      'Paid Date':   iso(addDays(new Date(inv.invoice_date + 'T00:00:00Z'), 21)),
      'Bank':        'Meridian Bank'
    });
  });

  // orphan — no matching invoice
  rows.push({ 'Txn ID': 'TXN' + (t++), 'Invoice No': 'INV-8888',
              'Amount Paid': 1750.00, 'Paid Date': '2026-08-22', 'Bank': 'Meridian Bank' });
  // paid BEFORE the invoice was raised — must be refused, not matched
  if (pending[0]) {
    rows.push({ 'Txn ID': 'TXN' + (t++), 'Invoice No': pending[0].invoice_no,
                'Amount Paid': pending[0].amount,
                'Paid Date': iso(addDays(new Date(pending[0].invoice_date + 'T00:00:00Z'), -9)),
                'Bank': 'First Commercial' });
  }
  // duplicate txn id — the second copy must be skipped, not double-counted
  rows.push({ ...rows[0] });

  return rows;
}

function writeWorkbook(file, sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
  }
  XLSX.writeFile(wb, file);
  console.log('  wrote', path.relative(__dirname, file));
}

// ---------- database load -----------------------------------
async function loadDatabase(invoices, approvals, payments) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  if (RESET) {
    console.log('  applying schema.sql');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  }

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const userIds = {};
  for (const u of USERS) {
    const r = await client.query(
      `INSERT INTO users (full_name,email,password_hash,role,acts_at_stage,can_approve,can_reject,can_import)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash
       RETURNING user_id`,
      [u.full_name, u.email, hash, u.role, u.acts_at_stage, u.can_approve, u.can_reject, u.can_import]);
    userIds[u.email] = r.rows[0].user_id;
  }
  console.log(`  ${USERS.length} users`);

  const invIds = {};
  for (const v of invoices) {
    const r = await client.query(
      `INSERT INTO invoices (invoice_no,vendor,description,amount,invoice_date,due_date,stage,status,submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING invoice_id`,
      [v.invoice_no, v.vendor, v.description, v.amount, v.invoice_date, v.due_date,
       v.stage, v.status, userIds['submitter@demo.app']]);
    invIds[v.invoice_no] = r.rows[0].invoice_id;
  }
  console.log(`  ${invoices.length} invoices`);

  for (const a of approvals) {
    await client.query(
      `INSERT INTO approvals (invoice_id,user_id,action,from_stage,to_stage,note,acted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [invIds[a.invoice_no], userIds[a.email], a.action, a.from_stage, a.to_stage, a.note, a.acted_at]);
  }
  console.log(`  ${approvals.length} approval rows`);

  for (const p of payments) {
    const id = invIds[p.invoice_no] || null;
    await client.query(
      `INSERT INTO payments (txn_id,invoice_no,invoice_id,amount,paid_date,bank,orphan_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (txn_id) DO NOTHING`,
      [p.txn_id, p.invoice_no, id, p.amount, p.paid_date, p.bank,
       id ? null : 'No invoice with this number']);

    if (id) {
      await client.query(
        `UPDATE invoices
            SET paid_amount = paid_amount + $1,
                paid_date = $2,
                payment_state = CASE
                  WHEN paid_amount + $1 <  amount THEN 'partial'
                  WHEN paid_amount + $1 >  amount THEN 'over'
                  ELSE 'full' END
          WHERE invoice_id = $3`, [p.amount, p.paid_date, id]);
    }
  }
  console.log(`  ${payments.length} payments`);

  await client.end();
}

// ---------- main --------------------------------------------
(async () => {
  const invoices  = buildInvoices();
  const approvals = buildApprovals(invoices);
  const payments  = buildPayments(invoices);

  if (!FILES_ONLY) {
    if (!process.env.DATABASE_URL) {
      console.error('DATABASE_URL is not set. Use --files-only to just write the Excel files.');
      process.exit(1);
    }
    console.log('Loading database...');
    await loadDatabase(invoices, approvals, payments);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('Writing demo files...');
  writeWorkbook(path.join(OUT_DIR, 'demo-invoices-to-import.xlsx'),
                { Invoices: buildImportSheet(invoices.map(i => i.invoice_no)) });
  writeWorkbook(path.join(OUT_DIR, 'demo-payments-to-import.xlsx'),
                { Payments: buildPaymentSheet(invoices) });

  const paid = invoices.filter(i => i.stage === 'PAID').length;
  console.log(`
Done.
  Invoices ......... ${invoices.length}  (${paid} paid, ${invoices.length - paid} in the chain)
  Login password ... ${DEMO_PASSWORD}   (all four accounts)
  Accounts ......... ${USERS.map(u => u.email).join(', ')}
`);
})();
