import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { BASE_CURRENCY, COUNTRIES, CURRENCIES, KYC_STAGES, SESSION_TTL_SECONDS } from './config.js';
import { setSetting } from './db.js';
import { hashPassword, verifyPassword, signToken, verifyToken, createLimiter } from './lib/auth.js';
import { toCsv } from './lib/csv.js';
import * as V from './lib/validate.js';
import * as S from './services.js';
import { DEMO_USER_EMAIL, DEMO_ADMIN_EMAIL, DEMO_NEWUSER_EMAIL } from './seed.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
};

const publicUser = (u) => ({
  id: u.id, email: u.email, name: u.name, country: u.country, preferredCurrency: u.preferred_currency,
  role: u.role, isDemo: !!u.is_demo, kycStage: u.kyc_stage, kycDemoName: u.kyc_demo_name, kycDemoDoc: u.kyc_demo_doc,
});

const publicTxn = (t, { admin = false } = {}) => {
  const { sender_email, user_id, ...rest } = t;
  return admin ? { ...rest, sender_email, user_id } : rest;
};

export function createApp({ db, secret, staticDir = null, demoMode = true, exchangeRateApiUrl = '', aiExplainEnabled = false, authLimit = 20 }) {
  if (!secret || secret.length < 16) throw new Error('SESSION_SECRET must be set (16+ characters).');
  const authLimiter = createLimiter(authLimit, 60_000);
  const routes = [];
  const route = (method, path, access, handler) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, access, handler });
  };

  const sessionFor = (user) => signToken({ uid: user.id }, secret, SESSION_TTL_SECONDS);
  const authResponse = (user) => ({ token: sessionFor(user), user: publicUser(user) });

  // ---------- public ----------
  route('GET', '/api/health', 'none', () => ({ ok: true, simulated: true }));

  route('GET', '/api/meta', 'none', () => {
    const { updatedAt, source } = S.getRates(db);
    const fee = S.getFeeModel(db);
    return {
      appName: 'UPI Bridge Global',
      simulated: true,
      baseCurrency: BASE_CURRENCY,
      countries: COUNTRIES,
      currencies: CURRENCIES,
      kycStages: KYC_STAGES,
      demoMode,
      limits: { min: fee.min_amount_inr, max: fee.max_amount_inr, unverified: fee.unverified_limit_inr },
      rates: { source, updatedAt, label: source === 'live' ? 'Live indicative rates' : 'SAMPLE rates (illustrative, not live market rates)' },
      aiExplainEnabled,
      liveRatesConfigured: !!exchangeRateApiUrl,
    };
  });

  route('GET', '/api/rates', 'none', () => {
    const r = S.getRates(db);
    return {
      base: BASE_CURRENCY, source: r.source, updatedAt: r.updatedAt,
      label: r.source === 'live' ? 'Live indicative rates' : 'SAMPLE rates (illustrative, not live market rates)',
      rates: r.rows.map((x) => ({ currency: x.currency, perInr: x.per_inr, source: x.source, updatedAt: x.updated_at })),
    };
  });

  route('POST', '/api/quote', 'none', ({ body }) => {
    const fee = S.getFeeModel(db);
    const country = V.validateDestination(body.country);
    const amount = V.validateAmount(body.amount, fee);
    return S.quote(db, amount, country);
  });

  // ---------- auth ----------
  route('POST', '/api/auth/register', 'none', ({ body, ip }) => {
    if (!authLimiter(`reg:${ip}`)) throw new S.HttpError(429, 'Too many attempts. Try again in a minute.');
    const email = V.validateEmail(body.email);
    const password = V.validatePassword(body.password);
    const name = V.validateName(body.name);
    const country = body.country ? V.validateCountryCode(body.country) : 'IN';
    const preferred = body.preferredCurrency ? V.validateCurrency(body.preferredCurrency) : 'INR';
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new S.HttpError(409, 'An account with this email already exists.');
    const info = db.prepare(
      "INSERT INTO users (email,password_hash,name,country,preferred_currency,role,is_demo,kyc_stage,created_at) VALUES (?,?,?,?,?,'user',0,'not_started',?)"
    ).run(email, hashPassword(password), name, country, preferred, new Date().toISOString());
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(Number(info.lastInsertRowid));
    return { status: 201, body: authResponse(user) };
  });

  route('POST', '/api/auth/login', 'none', ({ body, ip }) => {
    if (!authLimiter(`login:${ip}`)) throw new S.HttpError(429, 'Too many attempts. Try again in a minute.');
    const email = V.validateEmail(body.email);
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    const ok = user && user.password_hash && typeof body.password === 'string' && verifyPassword(body.password, user.password_hash);
    if (!ok) throw new S.HttpError(401, 'Incorrect email or password.');
    return authResponse(user);
  });

  route('POST', '/api/auth/demo', 'none', ({ body, ip }) => {
    if (!demoMode) throw new S.HttpError(403, 'Demo mode is disabled on this deployment.');
    if (!authLimiter(`demo:${ip}`)) throw new S.HttpError(429, 'Too many attempts. Try again in a minute.');
    const email = { user: DEMO_USER_EMAIL, admin: DEMO_ADMIN_EMAIL, new: DEMO_NEWUSER_EMAIL }[V.str(body.role) || 'user'];
    if (!email) throw new V.ValidationError('Choose user, admin or new.', 'role');
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!user) throw new S.HttpError(503, 'Demo data is not seeded. Run: npm run seed');
    return authResponse(user);
  });

  route('GET', '/api/auth/me', 'user', ({ user }) => ({ user: publicUser(user) }));

  route('PATCH', '/api/auth/profile', 'user', ({ user, body }) => {
    const name = body.name !== undefined ? V.validateName(body.name) : user.name;
    const country = body.country !== undefined ? V.validateCountryCode(body.country) : user.country;
    const cur = body.preferredCurrency !== undefined ? V.validateCurrency(body.preferredCurrency) : user.preferred_currency;
    db.prepare('UPDATE users SET name=?, country=?, preferred_currency=? WHERE id=?').run(name, country, cur, user.id);
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id)) };
  });

  // ---------- transfers ----------
  const parseTransferInput = (body, requireOutcome = false) => {
    const fee = S.getFeeModel(db);
    return {
      country: V.validateDestination(body.country),
      amountInr: V.validateAmount(body.amount, fee),
      recipientName: V.validateName(body.recipientName, 'recipientName'),
      identifier: V.validateIdentifier(body.identifier),
      outcome: requireOutcome ? V.validateOutcome(body.outcome) : undefined,
    };
  };

  route('POST', '/api/risk/assess', 'user', ({ user, body }) => {
    const input = parseTransferInput(body);
    const risk = S.riskCheck(db, user, input);
    return { ...risk, aiExplanation: null };
  });

  route('POST', '/api/transfers', 'user', ({ user, body }) => {
    const input = parseTransferInput(body, true);
    const result = S.createTransfer(db, user, input);
    return { status: 201, body: { transaction: publicTxn(result.transaction), risk: result.risk, quote: result.quote, simulated: true } };
  });

  const filtersFrom = (query, userId) => ({
    userId,
    country: query.country ? V.validateDestination(query.country) : null,
    status: query.status ? V.validateStatus(query.status) : null,
    from: V.validateDate(query.from, 'from'),
    to: V.validateDate(query.to, 'to'),
    q: query.q ? V.str(query.q).slice(0, 60) : null,
  });
  const pageFrom = (query) => ({
    page: Math.max(1, parseInt(query.page, 10) || 1),
    pageSize: Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 20)),
  });

  route('GET', '/api/transfers', 'user', ({ user, query }) => {
    const r = S.listTransactions(db, filtersFrom(query, user.id), pageFrom(query));
    return { ...r, rows: r.rows.map((t) => publicTxn(t)) };
  });

  route('GET', '/api/transfers/:txnId', 'user', ({ user, params }) => {
    const t = S.getTransaction(db, params.txnId);
    if (!t || (t.user_id !== user.id && user.role !== 'admin')) throw new S.HttpError(404, 'Transaction not found.');
    const alert = db.prepare('SELECT * FROM risk_alerts WHERE txn_id=?').get(t.txn_id);
    return {
      transaction: publicTxn(t, { admin: user.role === 'admin' }),
      alert: alert ? { ...alert, reasons: JSON.parse(alert.reasons) } : null,
      simulated: true,
    };
  });

  route('GET', '/api/summary', 'user', ({ user }) => S.summary(db, user.id));
  route('GET', '/api/alerts', 'user', ({ user }) => ({ alerts: S.listAlerts(db, { userId: user.id }) }));

  // ---------- KYC demo ----------
  route('GET', '/api/kyc', 'user', ({ user }) => ({
    stage: user.kyc_stage, stages: KYC_STAGES, demoName: user.kyc_demo_name, demoDoc: user.kyc_demo_doc,
    unverifiedLimitInr: S.getFeeModel(db).unverified_limit_inr,
  }));

  route('POST', '/api/kyc/submit', 'user', ({ user, body }) => {
    if (user.kyc_stage !== 'not_started') throw new S.HttpError(409, 'KYC demo already started. Use reset to try again.');
    const fullName = V.validateName(body.fullName, 'fullName');
    const docs = ['Placeholder passport (demo)', 'Placeholder national ID (demo)', 'Placeholder driving licence (demo)'];
    const doc = V.str(body.documentType);
    if (!docs.includes(doc)) throw new V.ValidationError('Choose one of the placeholder documents.', 'documentType');
    db.prepare("UPDATE users SET kyc_stage='submitted', kyc_demo_name=?, kyc_demo_doc=? WHERE id=?").run(fullName, doc, user.id);
    return { stage: 'submitted' };
  });

  route('POST', '/api/kyc/advance', 'user', ({ user }) => {
    if (user.kyc_stage === 'not_started') throw new S.HttpError(409, 'Submit the demo details first.');
    const next = S.nextKycStage(user.kyc_stage);
    db.prepare('UPDATE users SET kyc_stage=? WHERE id=?').run(next, user.id);
    return { stage: next, note: 'Demo control: in a real system a regulated KYC provider would decide this, not a button.' };
  });

  route('POST', '/api/kyc/reset', 'user', ({ user }) => {
    db.prepare("UPDATE users SET kyc_stage='not_started', kyc_demo_name=NULL, kyc_demo_doc=NULL WHERE id=?").run(user.id);
    return { stage: 'not_started' };
  });

  // ---------- admin ----------
  route('GET', '/api/admin/stats', 'admin', () => S.adminStats(db));

  route('GET', '/api/admin/transactions', 'admin', ({ query }) => {
    const r = S.listTransactions(db, filtersFrom(query, null), pageFrom(query));
    return { ...r, rows: r.rows.map((t) => publicTxn(t, { admin: true })) };
  });

  route('GET', '/api/admin/alerts', 'admin', ({ query }) => ({
    alerts: S.listAlerts(db, { status: query.status ? V.str(query.status) : null }),
  }));

  route('PATCH', '/api/admin/alerts/:id', 'admin', ({ user, params, body }) => {
    const status = V.str(body.reviewStatus);
    if (!['open', 'cleared', 'escalated'].includes(status)) throw new V.ValidationError('Invalid review status.', 'reviewStatus');
    const info = db.prepare('UPDATE risk_alerts SET review_status=?, reviewed_by=? WHERE id=?').run(status, user.id, Number(params.id) || 0);
    if (!info.changes) throw new S.HttpError(404, 'Alert not found.');
    return { ok: true, reviewStatus: status };
  });

  route('PATCH', '/api/admin/transactions/:txnId/status', 'admin', ({ params, body }) => {
    const t = S.updateStatus(db, params.txnId, V.validateStatus(body.status), V.str(body.reason).slice(0, 200) || null);
    return { transaction: publicTxn(t, { admin: true }) };
  });

  route('PUT', '/api/admin/rates/:currency', 'admin', ({ user, params, body }) => {
    const cur = V.validateCurrency(params.currency);
    if (cur === BASE_CURRENCY) throw new V.ValidationError('The base currency rate is fixed at 1.', 'currency');
    const rate = V.validateRate(body.rate);
    const now = new Date().toISOString();
    db.prepare("UPDATE rates SET per_inr=?, source='sample', updated_at=? WHERE currency=?").run(rate, now, cur);
    db.prepare("INSERT INTO rate_snapshots (currency,per_inr,source,changed_by,created_at) VALUES (?,?,'sample',?,?)").run(cur, rate, user.id, now);
    return { currency: cur, perInr: rate, source: 'sample', updatedAt: now };
  });

  route('POST', '/api/admin/rates/refresh', 'admin', async ({ user }) => {
    if (!exchangeRateApiUrl) throw new S.HttpError(400, 'No live exchange-rate API is configured (EXCHANGE_RATE_API_URL). Sample rates remain in use.');
    const res = await fetch(exchangeRateApiUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new S.HttpError(502, `Exchange-rate service returned ${res.status}.`);
    const data = await res.json();
    const live = data.rates || data.conversion_rates;
    if (!live || typeof live !== 'object') throw new S.HttpError(502, 'Unexpected exchange-rate response.');
    const now = new Date().toISOString();
    let updated = 0;
    for (const cur of Object.keys(CURRENCIES)) {
      if (cur === BASE_CURRENCY || !(live[cur] > 0)) continue;
      db.prepare("UPDATE rates SET per_inr=?, source='live', updated_at=? WHERE currency=?").run(live[cur], now, cur);
      db.prepare("INSERT INTO rate_snapshots (currency,per_inr,source,changed_by,created_at) VALUES (?,?, 'live',?,?)").run(cur, live[cur], user.id, now);
      updated++;
    }
    return { updated, updatedAt: now };
  });

  route('GET', '/api/admin/fee', 'admin', () => ({ fee: S.getFeeModel(db) }));

  route('PUT', '/api/admin/fee', 'admin', ({ body }) => {
    const next = V.validateFeeModel(body, S.getFeeModel(db));
    setSetting(db, 'fee_model', next);
    return { fee: next };
  });

  route('GET', '/api/admin/export.csv', 'admin', ({ query }) => {
    const rows = S.allTransactionsForExport(db, filtersFrom(query, null));
    const columns = [
      ['txn_id', 'Transaction ID'], ['created_at', 'Created at'], ['sender_email', 'Sender'], ['country', 'Country'],
      ['recipient_name', 'Recipient'], ['recipient_identifier', 'Identifier'], ['amount_inr', 'Amount INR'],
      ['fee_inr', 'Fee INR'], ['markup_cost_inr', 'Markup INR'], ['total_payable_inr', 'Total payable INR'],
      ['receive_currency', 'Receive currency'], ['recipient_amount', 'Recipient amount'], ['effective_rate', 'Effective rate'],
      ['rate_source', 'Rate source'], ['status', 'Status'], ['risk_level', 'Risk level'], ['risk_score', 'Risk score'],
    ].map(([key, header]) => ({ key, header }));
    const stamped = rows.map((r) => ({ ...r, rate_source: r.rate_source === 'live' ? 'live' : 'SAMPLE' }));
    return {
      raw: toCsv(columns, stamped),
      contentType: 'text/csv; charset=utf-8',
      headers: { 'Content-Disposition': 'attachment; filename="upi-bridge-demo-transactions.csv"' },
    };
  });

  // ---------- request handling ----------
  const baseHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 100_000) throw new S.HttpError(413, 'Request too large.');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      throw new V.ValidationError('Request body must be valid JSON.');
    }
  }

  function send(res, status, payload, extra = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { ...baseHeaders, 'Content-Type': 'application/json; charset=utf-8', ...extra });
    res.end(body);
  }

  async function handleApi(req, res, url) {
    const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!match) {
      if (routes.some((r) => r.re.test(url.pathname))) return send(res, 405, { error: 'Method not allowed.' });
      return send(res, 404, { error: 'Not found.' });
    }
    const m = url.pathname.match(match.re);
    const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    let user = null;
    if (match.access !== 'none') {
      const auth = req.headers.authorization || '';
      const payload = verifyToken(auth.startsWith('Bearer ') ? auth.slice(7) : '', secret);
      user = payload ? db.prepare('SELECT * FROM users WHERE id=?').get(payload.uid) : null;
      if (!user) throw new S.HttpError(401, 'Please sign in to continue.');
      // Role comes from the database on every request - never from the client or token.
      if (match.access === 'admin' && user.role !== 'admin') throw new S.HttpError(403, 'Administrator access required.');
    }
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const out = await match.handler({ req, user, params, body, query: Object.fromEntries(url.searchParams), ip: req.socket.remoteAddress || 'unknown' });
    if (out && out.raw !== undefined) {
      res.writeHead(200, { ...baseHeaders, 'Content-Type': out.contentType, ...(out.headers || {}) });
      return res.end(out.raw);
    }
    if (out && out.status && out.body) return send(res, out.status, out.body);
    return send(res, 200, out);
  }

  async function handleStatic(req, res, url) {
    if (!staticDir || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(404, baseHeaders);
      return res.end('Not found');
    }
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (rel.split(sep).includes('..')) rel = '';
    let file = join(staticDir, rel || 'index.html');
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, 'index.html');
    } catch {
      file = extname(rel) ? null : join(staticDir, 'index.html'); // SPA fallback for route paths only
    }
    if (!file) {
      res.writeHead(404, baseHeaders);
      return res.end('Not found');
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        ...baseHeaders,
        'Cache-Control': 'no-cache',
        'Content-Type': MIME[extname(file)] || 'application/octet-stream',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404, baseHeaders);
      res.end('Not found');
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return await handleStatic(req, res, url);
    } catch (err) {
      if (err instanceof V.ValidationError) return send(res, 400, { error: err.message, field: err.field });
      if (err instanceof S.HttpError) return send(res, err.status, { error: err.message, code: err.code });
      console.error('Unhandled error:', err);
      return send(res, 500, { error: 'Something went wrong. Please try again.' });
    }
  });
  return server;
}
// GlobalPay Backend Transaction API
app.post('/api/transactions', (req, res) => {
  const { sender_upi, receiver_upi, receiver_name, amount, note } = req.body;
  
  if (!amount || !receiver_upi) {
    return res.status(400).json({ success: false, error: 'Missing required payment fields' });
  }

  // Insert transaction into SQLite database ledger
  const query = `INSERT INTO transactions (sender_upi, receiver_upi, receiver_name, amount, note, status, created_at) VALUES (?, ?, ?, ?, ?, 'SUCCESS', datetime('now'))`;
  
  db.run(query, [sender_upi || 'user@globalpay', receiver_upi, receiver_name, amount, note || 'UPI Transfer'], function(err) {
    if (err) {
      console.error('DB Error:', err.message);
      return res.status(500).json({ success: false, error: 'Database transaction failed' });
    }
    
    res.json({
      success: true,
      transaction_id: this.lastID,
      utr: '6' + Math.floor(10000000000 + Math.random() * 90000000000),
      message: 'Payment processed and saved successfully'
    });
  });
});