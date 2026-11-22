// reports.js — employee daily reports -> admin (Firebase Firestore version)
//
// Needs: firebase-admin already initialised in your server
//        (admin.initializeApp(...) is called once in server.js, same as for your users).
// Photos are stored in a sub-collection (Firestore documents are limited to 1 MB).

const express = require('express');
const admin = require('firebase-admin');

const col = () => admin.firestore().collection('reports');

const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const iso = (ts) => (ts && ts.toDate ? ts.toDate().toISOString() : null);

// `auth` = your existing middleware that verifies the Bearer token and sets
// req.user = { userId, name, role }   (role is 'employee' or 'admin')
module.exports = function reportsRouter(auth) {
  const router = express.Router();

  const only = (role) => (req, res, next) =>
    req.user && req.user.role === role
      ? next()
      : res.status(403).json({ message: 'Not allowed' });

  // Employee: send a report
  router.post('/', auth, only('employee'), async (req, res) => {
    try {
      const b = req.body || {};
      const clientId = str(b.clientId, 100).replace(/[^\w-]/g, '');
      if (!clientId || !b.siteId) {
        return res.status(400).json({ message: 'Site ID is required.' });
      }

      const photos = (Array.isArray(b.photos) ? b.photos : [])
        .filter((p) => typeof p === 'string' && p.startsWith('data:image/jpeg;base64,') && p.length < 700000)
        .slice(0, 8);

      const materials = (Array.isArray(b.materials) ? b.materials : []).slice(0, 200).map((m) => ({
        name: str(m.name, 200),
        qty: num(m.qty),
        rate: num(m.rate),
        amount: num(m.qty) * num(m.rate),
      }));

      // same employee + same clientId = same document, so a retry never makes a duplicate
      const ref = col().doc(`${req.user.userId}_${clientId}`);
      const existing = await ref.get();

      const doc = {
        employeeUserId: req.user.userId,
        employeeName: req.user.name || str(b.employeeName, 200),   // identity comes from the token
        date: str(b.date, 20),
        siteId: str(b.siteId, 200),
        siteName: str(b.siteName, 200),
        location: str(b.location, 300),
        status: str(b.status, 50),
        siteInfo: str(b.siteInfo, 5000),
        materials,
        total: materials.reduce((s, m) => s + m.amount, 0),
        remarks: str(b.remarks, 3000),
        reportBy: str(b.reportBy, 200),
        photoCount: photos.length,
        createdAt: existing.exists
          ? existing.data().createdAt
          : admin.firestore.FieldValue.serverTimestamp(),
      };

      const batch = admin.firestore().batch();
      batch.set(ref, doc);
      photos.forEach((data, i) => {
        batch.set(ref.collection('photos').doc(String(i).padStart(2, '0')), { data, order: i });
      });
      await batch.commit();

      res.status(201).json({ message: 'Report received.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Could not save report.' });
    }
  });

  // Admin: list reports (no photos, so it loads fast). Optional ?date=YYYY-MM-DD
  router.get('/', auth, only('admin'), async (req, res) => {
    try {
      let rows;
      if (req.query.date) {
        const snap = await col().where('date', '==', str(req.query.date, 20)).limit(200).get();
        rows = snap.docs;
      } else {
        const snap = await col().orderBy('createdAt', 'desc').limit(200).get();
        rows = snap.docs;
      }

      const reports = rows
        .map((d) => {
          const r = d.data();
          return {
            id: d.id,
            date: r.date,
            siteId: r.siteId,
            siteName: r.siteName,
            employeeName: r.employeeName,
            employeeUserId: r.employeeUserId,
            status: r.status,
            total: r.total,
            photoCount: r.photoCount || 0,
            createdAt: iso(r.createdAt),
          };
        })
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

      res.json({ reports });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Could not load reports.' });
    }
  });

  // Admin: one full report with photos
  router.get('/:id', auth, only('admin'), async (req, res) => {
    try {
      const ref = col().doc(req.params.id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ message: 'Report not found.' });

      const photosSnap = await ref.collection('photos').orderBy('order').get();
      const r = snap.data();

      res.json({
        report: {
          ...r,
          id: snap.id,
          createdAt: iso(r.createdAt),
          photos: photosSnap.docs.map((p) => p.data().data),
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Could not load report.' });
    }
  });

  return router;
};

/*
  HOW TO ADD IT IN YOUR server.js / app.js

    // allow bigger JSON bodies (photos) — put this BEFORE your routes
    app.use(express.json({ limit: '25mb' }));

    // replace `authMiddleware` with the function your /api/employees route already uses
    app.use('/api/reports', require('./reports')(authMiddleware));

  Then push to GitHub; Render redeploys automatically.
*/
