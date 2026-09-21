-- ============================================================
-- Invoice Approval Demo — schema
-- Four tables. Chain: SUBMITTED -> MANAGER -> FINANCE -> PAID
-- ============================================================

DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS invoices;
DROP TABLE IF EXISTS users;

-- ------------------------------------------------------------
-- users
-- role drives BOTH what you can see and what you can do.
-- Keep the permission flags as columns, not as if-statements in
-- the code: adding a role later is then a row, not a rebuild.
-- ------------------------------------------------------------
CREATE TABLE users (
  user_id       SERIAL PRIMARY KEY,
  full_name     TEXT        NOT NULL,
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL
                CHECK (role IN ('SUBMITTER','MANAGER','FINANCE','ADMIN')),
  -- the stage this role acts at; NULL for roles outside the chain
  acts_at_stage TEXT        CHECK (acts_at_stage IN ('SUBMITTED','MANAGER','FINANCE')),
  can_approve   BOOLEAN     NOT NULL DEFAULT false,
  can_reject    BOOLEAN     NOT NULL DEFAULT false,
  can_import    BOOLEAN     NOT NULL DEFAULT false,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- invoices
-- invoice_no is UNIQUE — it is the dedup key on import.
-- stage = where it is in the chain. status = the outcome.
-- Keeping them separate means a REJECTED invoice can sit back
-- at SUBMITTED without losing the fact that it was rejected.
-- ------------------------------------------------------------
CREATE TABLE invoices (
  invoice_id    SERIAL PRIMARY KEY,
  invoice_no    TEXT        NOT NULL UNIQUE,
  vendor        TEXT        NOT NULL,
  description   TEXT,
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  invoice_date  DATE        NOT NULL,
  due_date      DATE,
  stage         TEXT        NOT NULL DEFAULT 'SUBMITTED'
                CHECK (stage IN ('SUBMITTED','MANAGER','FINANCE','PAID')),
  status        TEXT        NOT NULL DEFAULT 'Pending'
                CHECK (status IN ('Pending','Approved','Rejected','Paid')),
  paid_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid_date     DATE,
  payment_state TEXT        CHECK (payment_state IN ('full','partial','over')),
  submitted_by  INTEGER     REFERENCES users(user_id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoices_stage   ON invoices(stage);
CREATE INDEX idx_invoices_vendor  ON invoices(vendor);
CREATE INDEX idx_invoices_date    ON invoices(invoice_date);

-- ------------------------------------------------------------
-- approvals — the audit trail. Append only; nothing is updated.
-- from_stage is RECORDED, never guessed. If you ever need to
-- undo a move, this column is the evidence of where it came from.
-- ------------------------------------------------------------
CREATE TABLE approvals (
  approval_id SERIAL PRIMARY KEY,
  invoice_id  INTEGER     NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  user_id     INTEGER     NOT NULL REFERENCES users(user_id),
  action      TEXT        NOT NULL
              CHECK (action IN ('SUBMIT','APPROVE','REJECT','PAY','IMPORT')),
  from_stage  TEXT,
  to_stage    TEXT,
  note        TEXT,
  acted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_approvals_invoice ON approvals(invoice_id, acted_at);

-- ------------------------------------------------------------
-- payments
-- txn_id UNIQUE is what makes re-uploading the same bank file
-- harmless. invoice_id NULL = an ORPHAN: money received that
-- matches no invoice. Orphans are kept and shown, never dropped.
-- ------------------------------------------------------------
CREATE TABLE payments (
  payment_id   SERIAL PRIMARY KEY,
  txn_id       TEXT        NOT NULL UNIQUE,
  invoice_no   TEXT,
  invoice_id   INTEGER     REFERENCES invoices(invoice_id),
  amount       NUMERIC(14,2) NOT NULL,
  paid_date    DATE,
  bank         TEXT,
  orphan_reason TEXT,
  imported_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_invoice_no ON payments(invoice_no);
CREATE INDEX idx_payments_invoice_id ON payments(invoice_id);

-- ------------------------------------------------------------
-- Role definitions, seeded here so the app never hardcodes them
-- ------------------------------------------------------------
COMMENT ON TABLE users IS 'SUBMITTER raises invoices; MANAGER approves at stage 1; FINANCE approves and pays at stage 2; ADMIN sees everything.';
