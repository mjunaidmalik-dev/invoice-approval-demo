/* Invoice Approval Demo — front end */

const TOKEN = localStorage.getItem('demo_token');
if (!TOKEN) location.href = '/login.html';
let ME = JSON.parse(localStorage.getItem('demo_user') || '{}');

const $  = s => document.querySelector(s);
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h !== undefined) n.innerHTML = h; return n; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = n => n >= 1000 ? '$' + Math.round(n / 1000).toLocaleString() + 'k' : '$' + Math.round(n || 0);
const day   = d => d ? String(d).slice(0, 10) : '—';

/* ---------- one fetch wrapper: every call carries the token, and a
   dead session lands back on the login screen instead of a blank page ---------- */
async function api(url, opts = {}) {
  const headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + TOKEN });
  if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, Object.assign({}, opts, { headers }));
  if (r.status === 401) { localStorage.clear(); location.href = '/login.html'; return; }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(d.error || 'Something went wrong'); err.data = d; throw err; }
  return d;
}

function toast(text, bad) {
  const t = el('div', 'toast' + (bad ? ' bad' : ''), esc(text));
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

/* ---------- state ---------- */
let INVOICES = [], PAYMENTS = [], STATS = null, TAB = 'dashboard', CHARTS = [];

async function loadAll() {
  [INVOICES, PAYMENTS, STATS] = await Promise.all([
    api('/api/invoices'), api('/api/payments'), api('/api/stats')
  ]);
  $('#queueCount').textContent = '(' + INVOICES.filter(i => i.actionable).length + ')';
}

/* ---------- chain rail ---------- */
const CHAIN = ['SUBMITTED', 'MANAGER', 'FINANCE', 'PAID'];
const LABEL = { SUBMITTED: 'Raised', MANAGER: 'Manager', FINANCE: 'Finance', PAID: 'Paid' };
function chain(inv) {
  const at = CHAIN.indexOf(inv.stage);
  return '<span class="chain">' + CHAIN.map((s, i) => {
    const cls = inv.status === 'Rejected' ? (i === 0 ? 'here' : '')
              : i < at ? 'done' : i === at ? 'here' : '';
    return `<i class="${cls}">${LABEL[s]}</i>`;
  }).join('') + '</span>';
}

function statusTag(inv) {
  if (inv.status === 'Rejected') return '<span class="tag reject">Returned</span>';
  if (inv.payment_state === 'partial') return '<span class="tag part">Part paid</span>';
  if (inv.payment_state === 'over') return '<span class="tag part">Overpaid</span>';
  if (inv.stage === 'PAID') return '<span class="tag paid">Paid</span>';
  return '<span class="tag pending">With ' + LABEL[inv.stage] + '</span>';
}

/* ============================================================
   TABS
   ============================================================ */
function switchTab(tab) {
  TAB = tab;
  location.hash = tab;                       // survives a refresh, and is bookmarkable
  document.querySelectorAll('#nav button').forEach(b =>
    b.setAttribute('aria-current', b.dataset.tab === tab ? 'true' : 'false'));
  CHARTS.forEach(c => c.destroy()); CHARTS = [];
  ({ dashboard: renderDashboard, queue: renderQueue, invoices: renderInvoices,
     payments: renderPayments, import: renderImport }[tab] || renderDashboard)();
  window.scrollTo(0, 0);
}

/* ---------- 1. Overview ---------- */
function renderDashboard() {
  const t = STATS.totals, p = STATS.payments;
  const main = $('#main');
  main.innerHTML = '';
  main.append(
    el('h2', null, 'Overview'),
    el('p', 'lede', 'Every invoice in the system, where it sits, and what has been paid against it.')
  );

  const fig = el('dl', 'figures');
  [['Invoices', t.n], ['Total value', money(t.value), true], ['Paid', money(t.paid), true],
   ['Awaiting approval', t.open], ['Returned', t.rejected],
   ['Unmatched payments', p.orphans]
  ].forEach(([k, v, m]) => {
    const d = el('div');
    d.append(el('dt', null, k), el('dd', m ? 'money' : null, v));
    fig.append(d);
  });
  main.append(fig);

  const charts = el('div', 'charts');
  const c1 = el('div', 'chart-box', '<h3>Invoiced and paid by month</h3><canvas id="cMonth"></canvas>');
  const c2 = el('div', 'chart-box', '<h3>Where invoices are sitting</h3><canvas id="cStage"></canvas>');
  charts.append(c1, c2);
  main.append(charts);

  const c3 = el('div', 'chart-box', '<h3>Value by supplier</h3><canvas id="cVendor"></canvas>');
  c3.style.marginTop = '22px';
  main.append(c3);

  const base = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: { x: { grid: { display: false } }, y: { grid: { display: false }, ticks: { callback: short } } }
  };

  CHARTS.push(new Chart($('#cMonth'), {
    type: 'bar',
    data: {
      labels: STATS.byMonth.map(r => r.month),
      datasets: [
        { label: 'Invoiced', data: STATS.byMonth.map(r => r.value), backgroundColor: '#c3ccd4' },
        { label: 'Paid',     data: STATS.byMonth.map(r => r.paid),  backgroundColor: '#14614a' }
      ]
    },
    options: Object.assign({}, base, { plugins: { legend: { display: true, position: 'bottom' } } })
  }));

  const stages = {};
  STATS.byStage.forEach(r => {
    const k = r.status === 'Rejected' ? 'Returned' : LABEL[r.stage];
    stages[k] = (stages[k] || 0) + r.n;
  });
  // Colour belongs to the STAGE, never to its position. Handing colours out
  // in whatever order the database returns rows let "Manager" come out red —
  // the colour this app uses for rejection — whenever it happened to be listed
  // fourth. Fixed order, fixed colour: the chart reads the same every time.
  const STAGE_ORDER  = ['Raised', 'Manager', 'Finance', 'Paid', 'Returned'];
  const STAGE_COLOUR = { Raised: '#c3ccd4', Manager: '#15202b', Finance: '#7b8895',
                         Paid: '#14614a', Returned: '#a32b23' };
  const shown = STAGE_ORDER.filter(k => stages[k])
    .concat(Object.keys(stages).filter(k => !STAGE_ORDER.includes(k)));   // anything unforeseen still appears
  CHARTS.push(new Chart($('#cStage'), {
    type: 'doughnut',
    data: { labels: shown, datasets: [{ data: shown.map(k => stages[k]),
            backgroundColor: shown.map(k => STAGE_COLOUR[k] || '#c3ccd4') }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '58%',
               plugins: { legend: { position: 'bottom' } } }
  }));

  CHARTS.push(new Chart($('#cVendor'), {
    type: 'bar',
    data: { labels: STATS.byVendor.map(r => r.vendor),
            datasets: [{ data: STATS.byVendor.map(r => r.value), backgroundColor: '#15202b' }] },
    options: Object.assign({}, base, { indexAxis: 'y',
      scales: { x: { grid: { display: false }, ticks: { callback: short } }, y: { grid: { display: false } } } })
  }));
}

/* ---------- 2 & 3. Queue and all invoices ---------- */
function invoiceTable(rows, opts = {}) {
  const panel = el('div', 'panel');
  const head = el('header');
  head.append(el('h3', null, opts.title || 'Invoices'), el('div', 'spacer'));

  const search = el('input');
  search.type = 'text'; search.id = 'invFilter'; search.placeholder = 'Filter by number or supplier';
  search.style.width = '240px'; search.style.margin = '0';
  head.append(search);
  panel.append(head);

  const scroll = el('div', 'tbl-scroll');
  const table = el('table');
  table.innerHTML = `<thead><tr>
      <th>Invoice</th><th>Supplier</th><th class="num">Amount</th>
      <th>Dated</th><th>Status</th><th>Progress</th>
      ${opts.showActions ? '<th>Action</th>' : '<th></th>'}
    </tr></thead>`;
  const tbody = el('tbody');
  table.append(tbody);
  scroll.append(table);
  panel.append(scroll);

  function paint() {
    const q = search.value.trim().toLowerCase();
    const list = q ? rows.filter(r =>
      r.invoice_no.toLowerCase().includes(q) || r.vendor.toLowerCase().includes(q)) : rows;

    tbody.innerHTML = '';
    if (!list.length) {
      tbody.append(el('tr', null, `<td colspan="7" class="empty">${esc(opts.empty || 'Nothing here.')}</td>`));
      return;
    }
    list.forEach(inv => {
      const tr = el('tr', inv.status === 'Rejected' ? 'returned' : '');
      const why = inv.status === 'Rejected' && inv.last_note
        ? `<span class="why">Returned by ${esc(inv.last_action_by || '')}: ${esc(inv.last_note)}</span>` : '';
      tr.innerHTML = `
        <td><b>${esc(inv.invoice_no)}</b>${why}</td>
        <td>${esc(inv.vendor)}<br><span class="muted">${esc(inv.description || '')}</span></td>
        <td class="num">${money(inv.amount)}${
          inv.payment_state === 'partial'
            ? `<br><span class="muted">paid ${money(inv.paid_amount)}</span>` : ''}</td>
        <td>${day(inv.invoice_date)}</td>
        <td>${statusTag(inv)}</td>
        <td>${chain(inv)}</td>
        <td class="acts"></td>`;
      const acts = tr.querySelector('.acts');

      if (opts.showActions && inv.actionable) {
        if (ME.can_approve) {
          const a = el('button', 'btn btn-approve btn-sm', inv.stage === 'FINANCE' ? 'Mark paid' : 'Approve');
          a.onclick = () => approve(inv);
          acts.append(a);
        }
        if (ME.can_reject) {
          const j = el('button', 'btn btn-reject btn-sm', 'Return');
          j.onclick = () => askReject(inv);
          acts.append(j);
        }
      }
      const h = el('button', 'btn btn-quiet btn-sm', 'History');
      h.onclick = () => showHistory(inv);
      acts.append(h);
      tbody.append(tr);
    });
  }

  // Only the tbody is rebuilt on a keystroke, so the input is never
  // destroyed and the caret cannot jump out of it.
  search.addEventListener('input', paint);
  paint();
  return panel;
}

function renderQueue() {
  const mine = INVOICES.filter(i => i.actionable);
  const main = $('#main');
  main.innerHTML = '';
  main.append(
    el('h2', null, 'My queue'),
    el('p', 'lede', ME.role === 'ADMIN'
      ? 'As an admin you can act at any stage.'
      : `Invoices waiting at the ${LABEL[ME.acts_at_stage] || ''} stage. Approving moves an invoice on; returning it sends it back to the person who raised it with your reason attached.`),
    invoiceTable(mine, { title: `Waiting on you (${mine.length})`, showActions: true,
      empty: 'Nothing is waiting on you right now.' })
  );
}

function renderInvoices() {
  const main = $('#main');
  main.innerHTML = '';
  main.append(
    el('h2', null, 'All invoices'),
    el('p', 'lede', 'Everyone can see every invoice. What changes by role is what you can act on.'),
    invoiceTable(INVOICES, { title: `${INVOICES.length} invoices`, showActions: true })
  );
}

/* ---------- 4. Payments ---------- */
function renderPayments() {
  const main = $('#main');
  const orphans = PAYMENTS.filter(p => !p.invoice_id);
  main.innerHTML = '';
  main.append(
    el('h2', null, 'Payments'),
    el('p', 'lede', 'Every transaction read from a bank file. A payment that matches no invoice is kept and shown with the reason — never dropped quietly.')
  );

  const fig = el('dl', 'figures');
  [['Transactions', PAYMENTS.length],
   ['Matched', PAYMENTS.length - orphans.length],
   ['Unmatched', orphans.length],
   ['Value received', money(PAYMENTS.reduce((s, p) => s + Number(p.amount), 0)), true]
  ].forEach(([k, v, m]) => { const d = el('div'); d.append(el('dt', null, k), el('dd', m ? 'money' : null, v)); fig.append(d); });
  main.append(fig);

  const panel = el('div', 'panel');
  panel.append(el('header', null, '<h3>Transactions</h3>'));
  const scroll = el('div', 'tbl-scroll');
  const table = el('table');
  table.innerHTML = `<thead><tr>
    <th>Transaction</th><th>Invoice</th><th class="num">Amount</th>
    <th>Paid</th><th>Bank</th><th>Matched</th></tr></thead>`;
  const tb = el('tbody');
  PAYMENTS.forEach(p => {
    const tr = el('tr', p.invoice_id ? '' : 'returned');
    tr.innerHTML = `
      <td>${esc(p.txn_id)}</td>
      <td>${esc(p.invoice_no || '—')}${p.vendor ? '<br><span class="muted">' + esc(p.vendor) + '</span>' : ''}</td>
      <td class="num">${money(p.amount)}</td>
      <td>${day(p.paid_date)}</td>
      <td>${esc(p.bank || '—')}</td>
      <td>${p.invoice_id
            ? '<span class="tag paid">Matched</span>'
            : '<span class="tag reject">Unmatched</span><span class="why">' + esc(p.orphan_reason || '') + '</span>'}</td>`;
    tb.append(tr);
  });
  table.append(tb); scroll.append(table); panel.append(scroll);
  main.append(panel);
}

/* ---------- 5. Import ---------- */
function renderImport() {
  const main = $('#main');
  main.innerHTML = '';
  main.append(el('h2', null, 'Import'), el('p', 'lede',
    ME.can_import
      ? 'Upload a spreadsheet of invoices or a bank payment file. Rows that cannot be trusted are refused and listed with the reason, rather than being loaded and fixed later.'
      : 'Your role cannot import files. Sign in as the submitter or finance account to try this.'));

  if (!ME.can_import) return;

  [['invoices', 'Invoices', 'Columns needed: Invoice No, Vendor, Amount, Invoice Date. Due Date and Description are optional.'],
   ['payments', 'Bank payments', 'Columns needed: Txn ID, Invoice No, Amount Paid. Paid Date and Bank are optional but recommended.']
  ].forEach(([kind, title, hint]) => {
    const panel = el('div', 'panel');
    panel.append(el('header', null, `<h3>${title}</h3>`));
    const body = el('div'); body.style.padding = '16px';

    const drop = el('div', 'drop');
    drop.append(el('p', 'muted', hint));
    const input = el('input'); input.type = 'file'; input.accept = '.xlsx,.xls,.csv';
    const btn = el('button', 'btn', 'Import ' + title.toLowerCase());
    btn.disabled = true;
    input.onchange = () => { btn.disabled = !input.files.length; };
    drop.append(input, btn);

    const out = el('div', 'result');
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = 'Reading…';
      const fd = new FormData(); fd.append('file', input.files[0]);
      try {
        const d = await api('/api/import/' + kind, { method: 'POST', body: fd });
        showImportResult(out, kind, d);
        await loadAll();
        toast('Import finished');
      } catch (e) {
        out.innerHTML = refusalHtml(e, kind);
      }
      btn.disabled = false; btn.textContent = 'Import ' + title.toLowerCase();
    };

    body.append(drop, out);
    panel.append(body);
    main.append(panel);
  });
}

/* A refused file gets an explanation, not just a verdict: which box it
   belongs in if it's the other kind, otherwise what each sheet had and
   what it was missing. The wrong-file check is decided on the server. */
function refusalHtml(e, kind) {
  const d = e.data || {};
  if (d.looks_like) {
    const where = d.looks_like === 'payments'
      ? 'the <b>Bank payments</b> box below' : 'the <b>Invoices</b> box above';
    const what  = d.looks_like === 'payments' ? 'a bank payments file' : 'an invoice file';
    const isnt  = kind === 'invoices' ? 'an invoice file' : 'a bank payments file';
    return `<div class="reconcile no">This looks like ${what}, not ${isnt}. Upload it in ${where}.</div>`;
  }
  if (!Array.isArray(d.tried) || !d.tried.length)
    return `<div class="reconcile no">${esc(e.message)}</div>`;

  const sheets = d.tried.map(t => t.reason === 'empty'
    ? `<p style="margin:6px 0 0">Sheet <b>${esc(t.sheet)}</b> is empty.</p>`
    : `<p style="margin:6px 0 0">Sheet <b>${esc(t.sheet)}</b> is missing
         <b>${(t.missing_labels || t.missing || []).map(esc).join(', ')}</b>.
         <span class="muted">Columns found: ${(t.headers || []).map(h => esc(h) || '(blank)').join(', ') || 'none'}.</span></p>`
  ).join('');
  return `<div class="reconcile no">${esc(e.message)}.${sheets}</div>`;
}

function showImportResult(out, kind, d) {
  out.innerHTML = '';
  const lines = kind === 'invoices'
    ? [['Sheet read', d.sheet], ['Rows in the file', d.rows_read],
       ['Imported', d.imported], ['Refused', d.refused.length]]
    : [['Sheet read', d.sheet], ['Rows in the file', d.rows_read],
       ['Matched to an invoice', d.matched], ['Unmatched (kept as orphans)', d.orphans.length],
       ['Refused', d.refused.length], ['Already imported, skipped', d.skipped_duplicates]];

  lines.forEach(([k, v]) => {
    const l = el('div', 'line');
    l.append(el('b', null, esc(k)), el('span', null, esc(v)));
    out.append(l);
  });

  // The counts are stated AND checked. A summary that does not add up
  // is worse than no summary, because it is believed.
  out.append(el('div', 'reconcile ' + (d.reconciles ? 'ok' : 'no'),
    d.reconciles
      ? 'Every row in the file is accounted for.'
      : 'These figures do not add up to the rows read — do not trust this run.'));

  const problems = (d.refused || []).concat(kind === 'payments'
    ? (d.orphans || []).map(o => ({ line: o.line ?? '—', invoice_no: o.invoice_no, txn_id: o.txn_id, reasons: [o.reason] }))
    : []);
  if (!problems.length) return;

  const p = el('div', 'panel');
  p.append(el('header', null, `<h3>${problems.length} rows need attention</h3>`));
  const table = el('table');
  table.innerHTML = '<thead><tr><th>Row</th><th>Reference</th><th>Why</th></tr></thead>';
  const tb = el('tbody');
  problems.forEach(r => tb.append(el('tr', null,
    `<td>${esc(r.line ?? '—')}</td>
     <td>${esc(r.invoice_no || r.txn_id || '—')}</td>
     <td>${r.reasons.map(x => esc(x)).join('<br>')}</td>`)));
  table.append(tb);
  const wrap = el('div', 'tbl-scroll');
  wrap.append(table);
  p.append(wrap);
  out.append(p);
}

/* ---------- actions ---------- */
async function approve(inv) {
  try {
    const r = await api(`/api/invoices/${inv.invoice_id}/approve`, { method: 'POST', body: JSON.stringify({}) });
    toast(`${inv.invoice_no} moved to ${LABEL[r.to]}`);
    await loadAll(); switchTab(TAB);
  } catch (e) { toast(e.message, true); }
}

const CANNED = ['PO number missing', 'Amount differs from the quote',
                'Wrong cost centre', 'Duplicate submission', 'Supporting document missing'];

function askReject(inv) {
  // A dialog, not prompt(). Chrome offers to block repeated prompts,
  // and a blocked prompt returns null — which reads as "cancelled",
  // so a row of rejections would silently not happen.
  const back = el('div', 'backdrop');
  const dlg = el('div', 'dialog');
  dlg.innerHTML = `<header>Return ${esc(inv.invoice_no)} to the submitter</header>
    <div class="body">
      <p class="muted" style="margin-top:0">${esc(inv.vendor)} · ${money(inv.amount)}</p>
      <div class="reasons">${CANNED.map(c => `<button type="button">${esc(c)}</button>`).join('')}</div>
      <label for="rejNote">Reason — the submitter sees this</label>
      <textarea id="rejNote" placeholder="What needs to change before this can be approved?"></textarea>
    </div>
    <footer><button class="btn btn-quiet" data-x>Cancel</button>
            <button class="btn btn-reject" data-go disabled>Return invoice</button></footer>`;
  back.append(dlg);
  document.body.append(back);

  const note = dlg.querySelector('#rejNote');
  const go = dlg.querySelector('[data-go]');
  note.addEventListener('input', () => { go.disabled = !note.value.trim(); });
  dlg.querySelectorAll('.reasons button').forEach(b => b.onclick = () => {
    note.value = b.textContent; go.disabled = false; note.focus();
  });
  dlg.querySelector('[data-x]').onclick = () => back.remove();
  note.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) go.click(); });
  // Deliberately no click-outside dismissal: returning an invoice is
  // destructive enough that a stray click should not reach it.
  go.onclick = async () => {
    go.disabled = true;
    try {
      await api(`/api/invoices/${inv.invoice_id}/reject`,
                { method: 'POST', body: JSON.stringify({ note: note.value.trim() }) });
      back.remove(); toast(`${inv.invoice_no} returned`);
      await loadAll(); switchTab(TAB);
    } catch (e) { toast(e.message, true); go.disabled = false; }
  };
  note.focus();
}

async function showHistory(inv) {
  const back = el('div', 'backdrop');
  const dlg = el('div', 'dialog');
  dlg.style.maxWidth = '580px';
  dlg.innerHTML = `<header>${esc(inv.invoice_no)} — full trail</header>
    <div class="body"><p class="muted">Loading…</p></div>
    <footer><button class="btn btn-quiet" data-x>Close</button></footer>`;
  back.append(dlg); document.body.append(back);
  dlg.querySelector('[data-x]').onclick = () => back.remove();
  back.onclick = e => { if (e.target === back) back.remove(); };

  try {
    const rows = await api(`/api/invoices/${inv.invoice_id}/history`);
    const body = dlg.querySelector('.body');
    body.innerHTML = '';
    const table = el('table');
    table.innerHTML = '<thead><tr><th>When</th><th>Who</th><th>Did</th><th>Note</th></tr></thead>';
    const tb = el('tbody');
    rows.forEach(r => tb.append(el('tr', null,
      `<td>${day(r.acted_at)}</td>
       <td>${esc(r.full_name)}<br><span class="muted">${esc(r.role)}</span></td>
       <td>${esc(r.action)}${r.from_stage ? '<br><span class="muted">' + esc(r.from_stage) + ' &rarr; ' + esc(r.to_stage) + '</span>' : ''}</td>
       <td>${esc(r.note || '—')}</td>`)));
    table.append(tb);
    body.append(table);
  } catch (e) { dlg.querySelector('.body').innerHTML = `<p style="color:var(--red)">${esc(e.message)}</p>`; }
}

/* ---------- boot ---------- */
document.querySelectorAll('#nav button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
$('#signOut').onclick = () => { localStorage.clear(); location.href = '/login.html'; };

(async () => {
  try {
    ME = await api('/api/me');
    localStorage.setItem('demo_user', JSON.stringify(ME));
    $('#whoName').textContent = ME.full_name;
    $('#whoRole').textContent = ME.role.charAt(0) + ME.role.slice(1).toLowerCase() +
      (ME.acts_at_stage ? ' · acts at ' + LABEL[ME.acts_at_stage] : '');
    await loadAll();
    const want = (location.hash || '').slice(1);
    switchTab(['dashboard','queue','invoices','payments','import'].includes(want) ? want : 'dashboard');
  } catch (e) {
    $('#main').innerHTML = `<h2>Could not load</h2><p class="lede">${esc(e.message)}</p>`;
  }
})();
