// SIYA Daily Report — backend (Express + Firebase Firestore)
// Endpoints used by the app:
//   POST /api/auth/login        { userId, password }  -> { token, user:{ userId, name, role } }
//   GET  /api/employees         (admin)               -> { employees:[{ userId, name, active }] }
//   POST /api/employees         (admin) { userId, name, password }
//   POST /api/reports           (employee)            -> sends a daily report
//   GET  /api/reports[?date=]   (admin)               -> list of reports
//   GET  /api/reports/:id       (admin)               -> one report with photos

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const admin = require('firebase-admin');

// ---- required environment variables (set them in Render) ----
const { FIREBASE_SERVICE_ACCOUNT, JWT_SECRET, ADMIN_USER_ID, ADMIN_PASSWORD, BREVO_API_KEY, MAIL_FROM, ADMIN_EMAIL } = process.env;
if (!FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
if (!JWT_SECRET || JWT_SECRET.length < 24) throw new Error('JWT_SECRET must be set (at least 24 characters)');

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const users = db.collection('users');

const app = express();
app.use(cors());                                   // app uses Bearer tokens, not cookies
app.use(express.json({ limit: '25mb' }));          // reports can include photos

const normId = (v) => String(v || '').trim().toLowerCase();
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// ---- create the first admin automatically (only if it does not exist yet) ----
async function seedAdmin() {
  if (!ADMIN_USER_ID || !ADMIN_PASSWORD) return;
  const id = normId(ADMIN_USER_ID);
  const ref = users.doc(id);
  if ((await ref.get()).exists) return;
  if (ADMIN_PASSWORD.length < 12) {
    console.error('ADMIN_PASSWORD must be at least 12 characters; admin not created.');
    return;
  }
  await ref.set({
    userId: id,
    name: 'Admin',
    role: 'admin',
    active: true,
    passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log('Admin account created:', id);
}

// ---- simple brute-force protection for login ----
const attempts = new Map();
function tooManyAttempts(key) {
  const a = attempts.get(key);
  return a && a.resetAt > Date.now() && a.count >= 8;
}
function noteFailure(key) {
  const a = attempts.get(key);
  if (!a || a.resetAt <= Date.now()) attempts.set(key, { count: 1, resetAt: Date.now() + 15 * 60 * 1000 });
  else a.count++;
}

// ---- auth middleware (also blocks accounts that were disabled) ----
async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ message: 'Please login again.' });
    const payload = jwt.verify(token, JWT_SECRET);
    const snap = await users.doc(payload.userId).get();
    if (!snap.exists || snap.data().active === false) {
      return res.status(401).json({ message: 'Account is disabled.' });
    }
    req.user = { userId: payload.userId, name: snap.data().name, role: snap.data().role };
    next();
  } catch (err) {
    res.status(401).json({ message: 'Please login again.' });
  }
}
const only = (role) => (req, res, next) =>
  req.user && req.user.role === role ? next() : res.status(403).json({ message: 'Not allowed' });

// ---- email (Brevo HTTP API; works on Render free plan) ----
async function sendMail({ to, subject, text, attachments }) {
  if (!BREVO_API_KEY || !MAIL_FROM) throw new Error('Email is not configured on the server.');
  const body = { sender: { name: 'Siya Daily Report', email: MAIL_FROM }, to: [{ email: to }], subject, textContent: text };
  if (attachments && attachments.length) body.attachment = attachments.map((a) => ({ name: a.name, content: a.content }));
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    console.error('Brevo error', r.status, await r.text().catch(() => ''));
    throw new Error('Could not send email.');
  }
}

// ---- OTP for admin changes (code is emailed to ADMIN_EMAIL) ----
const otpHash = (userId, code) => crypto.createHmac('sha256', JWT_SECRET).update(`${userId}:${code}`).digest('hex');

app.post('/api/admin/otp/request', auth, only('admin'), async (req, res) => {
  try {
    if (!ADMIN_EMAIL) return res.status(500).json({ message: 'Admin email is not configured on the server.' });
    const ref = db.collection('otps').doc(req.user.userId);
    const snap = await ref.get();
    if (snap.exists && Date.now() - (snap.data().sentAt || 0) < 60000) {
      return res.status(429).json({ message: 'Please wait a minute before requesting another OTP.' });
    }
    const code = String(crypto.randomInt(100000, 1000000));
    await ref.set({ hash: otpHash(req.user.userId, code), expiresAt: Date.now() + 10 * 60 * 1000, sentAt: Date.now(), attempts: 0 });
    await sendMail({
      to: ADMIN_EMAIL,
      subject: 'Siya Daily Report - Admin OTP',
      text: `Your admin OTP is ${code}. It is valid for 10 minutes. Do not share it with anyone.`,
    });
    res.json({ message: 'OTP sent to the admin email.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not send OTP. Check the email settings on the server.' });
  }
});

app.post('/api/admin/otp/verify', auth, only('admin'), async (req, res) => {
  try {
    const code = String((req.body && req.body.code) || '').trim();
    const ref = db.collection('otps').doc(req.user.userId);
    const snap = await ref.get();
    const o = snap.exists ? snap.data() : null;
    if (!o || o.expiresAt < Date.now()) return res.status(400).json({ message: 'OTP expired. Request a new one.' });
    if (o.attempts >= 5) { await ref.delete(); return res.status(429).json({ message: 'Too many wrong attempts. Request a new OTP.' }); }
    const a = Buffer.from(otpHash(req.user.userId, code));
    const b = Buffer.from(o.hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      await ref.update({ attempts: o.attempts + 1 });
      return res.status(400).json({ message: 'Wrong OTP.' });
    }
    await ref.delete();
    res.json({ changeToken: jwt.sign({ userId: req.user.userId, scope: 'admin-change' }, JWT_SECRET, { expiresIn: '15m' }), minutes: 15 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not verify OTP.' });
  }
});

// must be used after `auth`: the admin has to have verified an OTP in the last 15 minutes
function needOtp(req, res, next) {
  // OTP is enforced only once e-mail is configured (BREVO_API_KEY, MAIL_FROM, ADMIN_EMAIL)
  if (!(BREVO_API_KEY && MAIL_FROM && ADMIN_EMAIL)) return next();
  try {
    const p = jwt.verify(String(req.headers['x-change-token'] || ''), JWT_SECRET);
    if (p.scope === 'admin-change' && p.userId === req.user.userId) return next();
  } catch (e) { /* fall through */ }
  res.status(403).json({ message: 'OTP required', code: 'OTP_REQUIRED' });
}

// ---- TSP e-mail directory ----
app.get('/api/tsp', auth, only('admin'), async (req, res) => {
  try {
    const snap = await db.collection('tsp').get();
    res.json({ tsp: snap.docs.map((d) => ({ name: d.data().name, email: d.data().email || '' })) });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Could not load TSP list.' }); }
});

app.put('/api/tsp', auth, only('admin'), needOtp, async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim().slice(0, 100);
    const email = String((req.body && req.body.email) || '').trim().slice(0, 200);
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: 'Valid TSP name and email are required.' });
    await db.collection('tsp').doc(name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).set({ name, email });
    res.json({ message: 'TSP email saved.' });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Could not save TSP email.' }); }
});

// ---- dropdown lists the admin can manage (TSP names, installation items) ----
const DEFAULT_OPTIONS = {
  tsp: ['Infratech', 'Rencom', 'Higlaj'],
  installs: ['DCDP', 'SMPS', 'SPS', 'HEXS', 'RACK', 'TX RACK', 'GSM'],
};
const cleanList = (v) =>
  [...new Set((Array.isArray(v) ? v : []).map((x) => String(x || '').trim().slice(0, 50)).filter((x) => x && x.toLowerCase() !== 'other'))].slice(0, 40);

app.get('/api/options', auth, async (req, res) => {
  try {
    const snap = await db.collection('settings').doc('options').get();
    const d = snap.exists ? snap.data() : {};
    res.json({
      tsp: Array.isArray(d.tsp) ? d.tsp : DEFAULT_OPTIONS.tsp,
      installs: Array.isArray(d.installs) ? d.installs : DEFAULT_OPTIONS.installs,
    });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Could not load lists.' }); }
});

app.put('/api/options', auth, only('admin'), needOtp, async (req, res) => {
  try {
    const b = req.body || {};
    await db.collection('settings').doc('options').set({ tsp: cleanList(b.tsp), installs: cleanList(b.installs) });
    res.json({ message: 'Lists saved.' });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Could not save lists.' }); }
});

// ---- routes ----
app.get('/', (req, res) => res.send('SIYA backend running'));

app.post('/api/auth/login', async (req, res) => {
  try {
    const userId = normId(req.body && req.body.userId);
    const password = String((req.body && req.body.password) || '');
    if (!userId || !password) return res.status(400).json({ message: 'Enter User ID and Password.' });

    const key = `${req.ip}|${userId}`;
    if (tooManyAttempts(key)) return res.status(429).json({ message: 'Too many attempts. Try again in 15 minutes.' });

    const snap = await users.doc(userId).get();
    const u = snap.exists ? snap.data() : null;
    const ok = await bcrypt.compare(password, u ? u.passwordHash : DUMMY_HASH);

    if (!u || !ok) {
      noteFailure(key);
      return res.status(401).json({ message: 'Invalid User ID or password.' });
    }
    if (u.active === false) return res.status(403).json({ message: 'Account is disabled.' });

    attempts.delete(key);
    const token = jwt.sign({ userId: u.userId }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { userId: u.userId, name: u.name, role: u.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Login failed. Try again.' });
  }
});

app.get('/api/employees', auth, only('admin'), async (req, res) => {
  try {
    const snap = await users.where('role', '==', 'employee').get();
    const employees = snap.docs
      .map((d) => ({ userId: d.data().userId, name: d.data().name, active: d.data().active !== false }))
      .sort((a, b) => a.userId.localeCompare(b.userId));
    res.json({ employees });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load employees.' });
  }
});

app.post('/api/employees', auth, only('admin'), needOtp, async (req, res) => {
  try {
    const userId = normId(req.body && req.body.userId);
    const name = String((req.body && req.body.name) || '').trim().slice(0, 100);
    const password = String((req.body && req.body.password) || '');

    if (!/^[a-z0-9._-]{3,30}$/.test(userId)) {
      return res.status(400).json({ message: 'User ID: 3-30 letters, numbers, . _ - only.' });
    }
    if (!name) return res.status(400).json({ message: 'Employee name is required.' });
    if (password.length < 12) return res.status(400).json({ message: 'Password must be at least 12 characters.' });

    const ref = users.doc(userId);
    if ((await ref.get()).exists) return res.status(409).json({ message: 'This User ID already exists.' });

    await ref.set({
      userId,
      name,
      role: 'employee',
      active: true,
      passwordHash: await bcrypt.hash(password, 10),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.status(201).json({ message: 'Employee created successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not create employee.' });
  }
});

app.use('/api/reports', require('./reports')(auth, { needOtp, sendMail }));

app.use((err, req, res, next) => {
  const tooLarge = err && err.type === 'entity.too.large';
  res.status(tooLarge ? 413 : 500).json({ message: tooLarge ? 'Report is too large (too many photos).' : 'Server error.' });
});

const PORT = process.env.PORT || 3000;
seedAdmin()
  .catch((e) => console.error('Admin seed failed:', e))
  .finally(() => app.listen(PORT, () => console.log('SIYA backend listening on', PORT)));
