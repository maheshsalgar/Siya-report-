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
const admin = require('firebase-admin');

// ---- required environment variables (set them in Render) ----
const { FIREBASE_SERVICE_ACCOUNT, JWT_SECRET, ADMIN_USER_ID, ADMIN_PASSWORD } = process.env;
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
    const token = jwt.sign({ userId: u.userId }, JWT_SECRET, { expiresIn: '12h' });
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

app.post('/api/employees', auth, only('admin'), async (req, res) => {
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

app.use('/api/reports', require('./reports')(auth));

app.use((err, req, res, next) => {
  const tooLarge = err && err.type === 'entity.too.large';
  res.status(tooLarge ? 413 : 500).json({ message: tooLarge ? 'Report is too large (too many photos).' : 'Server error.' });
});

const PORT = process.env.PORT || 3000;
seedAdmin()
  .catch((e) => console.error('Admin seed failed:', e))
  .finally(() => app.listen(PORT, () => console.log('SIYA backend listening on', PORT)));
