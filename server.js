/* ============================================================
 * Invoice Approval Demo — API
 *
 *   npm install
 *   DATABASE_URL=postgres://... JWT_SECRET=... node server.js
 *
 * Chain: SUBMITTED -> MANAGER -> FINANCE -> PAID
 * ============================================================ */

const express  = require('express');
const path     = require('path');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const XLSX     = require('xlsx');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 4000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false
});

// A missing secret is a deployment mistake, not something to paper
// over with a default — a hardcoded fallback that ships is a key
// anyone can read off the repository.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('JWT_SECRET is not set. Refusing to start.'); process.exit(1); }

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const CHAIN = ['SUBMITTED', 'MANAGER', 'FINANCE', 'PAID'];
const nextStage = s => CHAIN[CHAIN.indexOf(s) + 1] || null;

// ============================================================
// AUTH
// Only /api/health and /api/login are open. Everything else goes
// through requireAuth — added once here rather than per route, so
// a new endpoint cannot be forgotten.
// ============================================================
async function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  try {
    const { user_id } = jwt.verify(h.slice(7), JWT_SECRET);
    // Role and permissions are re-read from the database on every
    // request, never taken from the token. A permission change then
    // takes effect on the next click instead of when the token expires.
    const r = await pool.query(
      `SELECT user_id, full_name, email, role, acts_at_stage,
              can_approve, can_reject, can_import, is_active
         FROM users WHERE user_id = $1`, [user_id]);
    if (!r.rows.length || !r.rows[0].is_active) return res.status(403).json({ error: 'Account is not active' });
    req.user = r.rows[0];
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired — sign in again' });
  }
}

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, db: 'connected' }); }
  catch { res.status(500).json({ ok: false, db: 'unreachable' }); }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Enter an email and password' });
  const r = await pool.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  const u = r.rows[0];
  if (!u || !u.is_active || !(await bcrypt.compare(password, u.password_hash))) {
    // One message for both cases — a different reply for "no such
    // user" tells a stranger which addresses are real.
    return res.status(401).json({ error: 'Email or password is not correct' });
  }
  const token = jwt.sign({ user_id: u.user_id }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: shape(u) });
});

const shape = u => ({
  user_id: u.user_id, full_name: u.full_name, email: u.email, role: u.role,
  acts_at_stage: u.acts_at_stage, can_approve: u.can_approve,
  can_reject: u.can_reject, can_import: u.can_import
});

app.use('/api', (req, res, next) =>
  (req.path === '/health' || req.path === '/login') ? next() : requireAuth(req, res, next));

app.get('/api/me', (req, res) => res.json(shape(req.user)));

// ============================================================
// INVOICES
// ============================================================
const LIST_SQL = `
  SELECT i.*, u.full_name AS submitted_by_name,
         a.action AS last_action, a.note AS last_note,
         a.acted_at AS last_action_at, au.full_name AS last_action_by
    FROM invoices i
    LEFT JOIN users u ON u.user_id = i.submitted_by
    LEFT JOIN LATERAL (
      SELECT action, note, acted_at, user_id FROM approvals
       WHERE invoice_id = i.invoice_id ORDER BY acted_at DESC, approval_id DESC LIMIT 1
    ) a ON true
    LEFT JOIN users au ON au.user_id = a.user_id`;

app.get('/api/invoices', async (req, res) => {
  const r = await pool.query(LIST_SQL + ' ORDER BY i.invoice_date DESC, i.invoice_id DESC');
  // Everyone can SEE every invoice — an approver needs to know what
  // is coming. What changes by role is what they can ACT on, which
  // is decided per invoice below and again on the server at approve time.
  res.json(r.rows.map(row => ({ ...row, actionable: canAct(req.user, row) })));
});

function canAct(user, inv) {
  if (inv.stage === 'PAID' || inv.status === 'Rejected') return false;
  if (user.role === 'ADMIN') return true;
  return user.acts_at_stage === inv.stage && (user.can_approve || user.can_reject);
}

app.get('/api/invoices/:id/history', async (req, res) => {
  const r = await pool.query(
    `SELECT a.*, u.full_name, u.role FROM approvals a
       JOIN users u ON u.user_id = a.user_id
      WHERE a.invoice_id = $1 ORDER BY a.acted_at, a.approval_id`, [req.params.id]);
  res.json(r.rows);
});

app.post('/api/invoices/:id/approve', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE — two approvers clicking the same invoice at the
    // same moment would otherwise both read stage MANAGER and move
    // it twice.
    const r = await client.query('SELECT * FROM invoices WHERE invoice_id = $1 FOR UPDATE', [req.params.id]);
    const inv = r.rows[0];
    if (!inv) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No such invoice' }); }
    if (!canAct(req.user, inv) || !req.user.can_approve) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: `You cannot approve an invoice at stage ${inv.stage}` });
    }
    const to = nextStage(inv.stage);
    if (!to) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Already at the end of the chain' }); }

    await client.query(
      `UPDATE invoices SET stage = $1, status = $2 WHERE invoice_id = $3`,
      [to, to === 'PAID' ? 'Paid' : 'Pending', inv.invoice_id]);
    await client.query(
      `INSERT INTO approvals (invoice_id,user_id,action,from_stage,to_stage,note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      // from_stage is read off the row, never assumed from the role —
      // if a move ever has to be undone, this column is the evidence.
      [inv.invoice_id, req.user.user_id, to === 'PAID' ? 'PAY' : 'APPROVE',
       inv.stage, to, req.body.note || null]);
    await client.query('COMMIT');
    res.json({ ok: true, from: inv.stage, to });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.post('/api/invoices/:id/reject', async (req, res) => {
  const note = (req.body.note || '').trim();
  if (!note) return res.status(400).json({ error: 'A rejection needs a reason — the submitter has to know what to fix' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM invoices WHERE invoice_id = $1 FOR UPDATE', [req.params.id]);
    const inv = r.rows[0];
    if (!inv) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No such invoice' }); }
    if (!canAct(req.user, inv) || !req.user.can_reject) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: `You cannot reject an invoice at stage ${inv.stage}` });
    }
    await client.query(
      `UPDATE invoices SET stage = 'SUBMITTED', status = 'Rejected' WHERE invoice_id = $1`, [inv.invoice_id]);
    await client.query(
      `INSERT INTO approvals (invoice_id,user_id,action,from_stage,to_stage,note)
       VALUES ($1,$2,'REJECT',$3,'SUBMITTED',$4)`,
      [inv.invoice_id, req.user.user_id, inv.stage, note]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// ============================================================
// DASHBOARD
// ============================================================
app.get('/api/stats', async (_req, res) => {
  const [byStage, byVendor, byMonth, totals, pay] = await Promise.all([
    pool.query(`SELECT stage, status, COUNT(*)::int n, SUM(amount)::float value
                  FROM invoices GROUP BY stage, status`),
    pool.query(`SELECT vendor, SUM(amount)::float value, COUNT(*)::int n
                  FROM invoices GROUP BY vendor ORDER BY value DESC`),
    pool.query(`SELECT to_char(invoice_date,'YYYY-MM') AS month,
                       SUM(amount)::float value,
                       SUM(CASE WHEN stage='PAID' THEN amount ELSE 0 END)::float paid
                  FROM invoices GROUP BY 1 ORDER BY 1`),
    pool.query(`SELECT COUNT(*)::int n, SUM(amount)::float value,
                       SUM(paid_amount)::float paid,
                       COUNT(*) FILTER (WHERE stage <> 'PAID' AND status <> 'Rejected')::int open,
                       COUNT(*) FILTER (WHERE status = 'Rejected')::int rejected
                  FROM invoices`),
    pool.query(`SELECT COUNT(*) FILTER (WHERE invoice_id IS NULL)::int orphans,
                       COUNT(*)::int total FROM payments`)
  ]);
  res.json({
    byStage: byStage.rows, byVendor: byVendor.rows, byMonth: byMonth.rows,
    totals: totals.rows[0], payments: pay.rows[0]
  });
});

app.get('/api/payments', async (_req, res) => {
  const r = await pool.query(
    `SELECT p.*, i.amount AS invoice_amount, i.vendor
       FROM payments p LEFT JOIN invoices i ON i.invoice_id = p.invoice_id
      ORDER BY p.paid_date DESC NULLS LAST, p.payment_id DESC`);
  res.json(r.rows);
});

// ============================================================
// IMPORT — shared helpers
//
// The header map and the required-column check must agree, so both
// work off the same FIELD names. A map that knows an alias while the
// check looks for a literal header is how "missing column" gets
// reported for a file that is perfectly correct.
// ============================================================
const INVOICE_FIELDS = {
  invoice_no:   ['invoice no', 'invoice number', 'invoice #', 'inv no', 'invoiceno'],
  vendor:       ['vendor', 'supplier', 'vendor name', 'supplier name'],
  description:  ['description', 'details', 'narration'],
  amount:       ['amount', 'total', 'invoice amount', 'value'],
  invoice_date: ['invoice date', 'date', 'issue date'],
  due_date:     ['due date', 'payment due', 'due']
};
const INVOICE_REQUIRED = ['invoice_no', 'vendor', 'amount', 'invoice_date'];

const PAYMENT_FIELDS = {
  txn_id:     ['txn id', 'transaction id', 'txn', 'tr. id.', 'tr id', 'reference'],
  invoice_no: ['invoice no', 'invoice number', 'invoice #', 'inv no'],
  amount:     ['amount paid', 'amount', 'paid amount', 'value'],
  paid_date:  ['paid date', 'payment date', 'date'],
  bank:       ['bank', 'bank name', 'source']
};
const PAYMENT_REQUIRED = ['txn_id', 'invoice_no', 'amount'];

const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Human names for the fields, so a refusal can say "Vendor" instead of "vendor".
const FIELD_LABELS = {
  invoice_no: 'Invoice No', vendor: 'Vendor', description: 'Description',
  amount: 'Amount', invoice_date: 'Invoice Date', due_date: 'Due Date',
  txn_id: 'Txn ID', paid_date: 'Paid Date', bank: 'Bank'
};

function buildHeaderMap(headers, fields) {
  const map = {};
  headers.forEach(h => {
    const n = norm(h);
    for (const [field, aliases] of Object.entries(fields)) {
      if (aliases.includes(n) && !(field in map)) map[field] = h;
    }
  });
  return map;
}

// Scans every sheet rather than taking the first one. A template with
// an "Instructions" tab in front of the data is a correct file, and
// failing it teaches the user to distrust the importer.
function findSheet(wb, fields, required) {
  const tried = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '', raw: true });
    if (!rows.length) { tried.push({ sheet: name, headers: [], reason: 'empty' }); continue; }
    const headers = Object.keys(rows[0]);
    const map = buildHeaderMap(headers, fields);
    const missing = required.filter(f => !(f in map));
    if (!missing.length) return { name, rows, map };
    tried.push({ sheet: name, headers, missing, missing_labels: missing.map(f => FIELD_LABELS[f] || f) });
  }
  return { error: 'Could not find the required columns on any sheet', tried };
}

// Excel hands back a serial number for a real date cell and a string
// for a text one. Both have to be handled, and anything else has to be
// refused rather than guessed at.
function parseDate(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (v instanceof Date) return isNaN(v) ? undefined : v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return undefined;
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);        // dd/mm/yyyy
  if (m) return validDate(+m[3], +m[2], +m[1]);
  return undefined;                                               // undefined = unparseable
}
function validDate(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
  return dt.toISOString().slice(0, 10);
}

function parseMoney(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

// ============================================================
// IMPORT — invoices
// ============================================================
app.post('/api/import/invoices', upload.single('file'), async (req, res) => {
  if (!req.user.can_import) return res.status(403).json({ error: 'Your role cannot import' });
  if (!req.file) return res.status(400).json({ error: 'Choose a file first' });

  let wb;
  try { wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true }); }
  catch { return res.status(400).json({ error: 'That file is not a readable Excel workbook' }); }

  const found = findSheet(wb, INVOICE_FIELDS, INVOICE_REQUIRED);
  if (found.error) {
    if (!findSheet(wb, PAYMENT_FIELDS, PAYMENT_REQUIRED).error) found.looks_like = 'payments';
    return res.status(400).json(found);
  }

  const { rows, map } = found;
  const get = (r, f) => (f in map ? r[map[f]] : '');
  const refused = [], ok = [];
  const seen = new Set();

  rows.forEach((r, i) => {
    const line = i + 2;                       // +2: header row, and Excel is 1-based
    const no = String(get(r, 'invoice_no') || '').trim().replace(/^'/, '');
    const amount = parseMoney(get(r, 'amount'));
    const invDate = parseDate(get(r, 'invoice_date'));
    const dueDate = parseDate(get(r, 'due_date'));
    const why = [];

    if (!no) why.push('Invoice number is blank');
    if (amount === null) why.push('Amount is blank');
    else if (amount === undefined) why.push(`Amount "${get(r, 'amount')}" is not a number`);
    else if (amount <= 0) why.push('Amount is zero or negative');
    if (invDate === null) why.push('Invoice date is blank');
    else if (invDate === undefined) why.push(`Invoice date "${get(r, 'invoice_date')}" is not a valid date`);
    if (dueDate && invDate && dueDate < invDate) why.push('Due date is before the invoice date');
    if (no && seen.has(no)) why.push('Appears more than once in this file');
    if (no) seen.add(no);

    if (why.length) refused.push({ line, invoice_no: no || '(blank)', reasons: why });
    else ok.push({ no, vendor: String(get(r, 'vendor') || '').trim() || 'Unknown vendor',
                   description: String(get(r, 'description') || '').trim() || null,
                   amount, invDate, dueDate });
  });

  let inserted = 0;
  const duplicates = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const v of ok) {
      const r = await client.query(
        `INSERT INTO invoices (invoice_no,vendor,description,amount,invoice_date,due_date,stage,status,submitted_by)
         VALUES ($1,$2,$3,$4,$5,$6,'MANAGER','Pending',$7)
         ON CONFLICT (invoice_no) DO NOTHING
         RETURNING invoice_id`,
        [v.no, v.vendor, v.description, v.amount, v.invDate, v.dueDate, req.user.user_id]);
      if (r.rows.length) {
        inserted++;
        await client.query(
          `INSERT INTO approvals (invoice_id,user_id,action,from_stage,to_stage,note)
           VALUES ($1,$2,'IMPORT',NULL,'MANAGER',$3)`,
          [r.rows[0].invoice_id, req.user.user_id, 'Imported from ' + req.file.originalname]);
      } else {
        duplicates.push({ invoice_no: v.no, reasons: ['Already in the system'] });
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); return res.status(500).json({ error: e.message }); }
  finally { client.release(); }

  res.json({
    sheet: found.name,
    rows_read: rows.length,
    imported: inserted,
    refused: refused.concat(duplicates),
    // Stated explicitly so the three figures can be checked against
    // each other on screen instead of being taken on trust.
    reconciles: rows.length === inserted + refused.length + duplicates.length
  });
});

// ============================================================
// IMPORT — payments, and the matching rule
// ============================================================
app.post('/api/import/payments', upload.single('file'), async (req, res) => {
  if (!req.user.can_import) return res.status(403).json({ error: 'Your role cannot import' });
  if (!req.file) return res.status(400).json({ error: 'Choose a file first' });

  let wb;
  try { wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true }); }
  catch { return res.status(400).json({ error: 'That file is not a readable Excel workbook' }); }

  const found = findSheet(wb, PAYMENT_FIELDS, PAYMENT_REQUIRED);
  if (found.error) {
    if (!findSheet(wb, INVOICE_FIELDS, INVOICE_REQUIRED).error) found.looks_like = 'invoices';
    return res.status(400).json(found);
  }

  const { rows, map } = found;
  const get = (r, f) => (f in map ? r[map[f]] : '');
  const refused = [], matched = [], orphans = [];
  let skipped = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], line = i + 2;
      const txn = String(get(r, 'txn_id') || '').trim();
      const no = String(get(r, 'invoice_no') || '').trim().replace(/^'/, '');
      const amount = parseMoney(get(r, 'amount'));
      const paidDate = parseDate(get(r, 'paid_date'));
      const why = [];

      if (!txn) why.push('Transaction ID is blank — nothing to deduplicate on');
      if (amount === null || amount === undefined) why.push('Paid amount is missing or not a number');
      else if (amount <= 0) why.push('Paid amount is zero or negative');
      if (paidDate === undefined) why.push(`Paid date "${get(r, 'paid_date')}" is not a valid date`);
      if (why.length) { refused.push({ line, txn_id: txn || '(blank)', reasons: why }); continue; }

      const dup = await client.query('SELECT 1 FROM payments WHERE txn_id = $1', [txn]);
      if (dup.rows.length) { skipped++; continue; }   // re-uploading the same file is harmless

      // THE MATCHING RULE, in order:
      //  1. same invoice number
      //  2. the invoice must already have existed — a payment cannot
      //     settle an invoice raised after it. This filters causality
      //     BEFORE amount, which is what stops a plausible-looking
      //     wrong match.
      //  3. of what survives, the closest amount, newest first.
      const m = await client.query(
        `SELECT invoice_id, amount, paid_amount, invoice_date, stage
           FROM invoices
          WHERE invoice_no = $1
            AND ($2::date IS NULL OR invoice_date <= $2::date)
          ORDER BY ABS(amount - paid_amount - $3::numeric) ASC, invoice_date DESC
          LIMIT 1`, [no, paidDate, amount]);

      let invoiceId = null, reason = null;
      if (m.rows.length) invoiceId = m.rows[0].invoice_id;
      else {
        const exists = await client.query(
          `SELECT to_char(invoice_date,'YYYY-MM-DD') AS raised FROM invoices WHERE invoice_no = $1`, [no]);
        reason = exists.rows.length
          // Formatted by the database, not by slicing a JS Date as text —
          // String(dateObject).slice(0,10) yields "Thu Jul 09", and anything
          // comparing those strings ends up sorting weekday names.
          ? `Paid on ${paidDate}, but invoice ${no} was not raised until ${exists.rows[0].raised}`
          : `No invoice numbered ${no}`;
      }

      await client.query(
        `INSERT INTO payments (txn_id,invoice_no,invoice_id,amount,paid_date,bank,orphan_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [txn, no, invoiceId, amount, paidDate, String(get(r, 'bank') || '').trim() || null, reason]);

      if (invoiceId) {
        const u = await client.query(
          `UPDATE invoices
              SET paid_amount = paid_amount + $1, paid_date = $2,
                  payment_state = CASE WHEN paid_amount + $1 < amount THEN 'partial'
                                       WHEN paid_amount + $1 > amount THEN 'over'
                                       ELSE 'full' END,
                  stage  = CASE WHEN paid_amount + $1 >= amount THEN 'PAID' ELSE stage END,
                  status = CASE WHEN paid_amount + $1 >= amount THEN 'Paid' ELSE status END
            WHERE invoice_id = $3
            RETURNING invoice_no, payment_state, stage`, [amount, paidDate, invoiceId]);
        matched.push({ txn_id: txn, ...u.rows[0] });
      } else {
        orphans.push({ line, txn_id: txn, invoice_no: no, amount, reason });
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); return res.status(500).json({ error: e.message }); }
  finally { client.release(); }

  res.json({
    sheet: found.name, rows_read: rows.length,
    matched: matched.length, orphans, refused, skipped_duplicates: skipped,
    reconciles: rows.length === matched.length + orphans.length + refused.length + skipped
  });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.listen(PORT, () => console.log(`Invoice demo listening on ${PORT}`));
