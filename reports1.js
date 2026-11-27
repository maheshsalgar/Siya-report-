// reports.js — employee daily reports -> admin (Firebase Firestore version)
// Supports up to 55 photos per report. Photos are sent in small batches and stored in a
// sub-collection (Firestore documents are limited to 1 MB).

const express = require('express');
const admin = require('firebase-admin');

const MAX_PHOTOS = 55;
const MAX_GSM = 20;

const col = () => admin.firestore().collection('reports');

const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const iso = (ts) => (ts && ts.toDate ? ts.toDate().toISOString() : null);
const cleanId = (v) => str(v, 100).replace(/[^\w-]/g, '');
const photoOk = (p) => typeof p === 'string' && p.startsWith('data:image/jpeg;base64,') && p.length < 700000;

module.exports = function reportsRouter(auth, ext = {}) {
  const { needOtp, sendMail } = ext;
  const router = express.Router();

  const only = (role) => (req, res, next) =>
    req.user && req.user.role === role
      ? next()
      : res.status(403).json({ message: 'Not allowed' });

  // Employee step 1: send the report details (no photos here)
  router.post('/', auth, only('employee'), async (req, res) => {
    try {
      const b = req.body || {};
      const clientId = cleanId(b.clientId);
      if (!clientId || !b.siteId) {
        return res.status(400).json({ message: 'Site ID is required.' });
      }

      const materials = (Array.isArray(b.materials) ? b.materials : []).slice(0, 200).map((m) => ({
        name: str(m.name, 200),
        qty: num(m.qty),
        rate: num(m.rate),
        rrl: str(m.rrl, 30),
        amount: num(m.qty) * num(m.rate),
      }));

      const ref = col().doc(`${req.user.userId}_${clientId}`);
      const existing = await ref.get();

      await ref.set({
        employeeUserId: req.user.userId,
        employeeName: req.user.name || str(b.employeeName, 200),
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
        workTypes: (Array.isArray(b.workTypes) ? b.workTypes : []).slice(0, 10).map((x) => str(x, 50)),
        workOther: str(b.workOther, 200),
        installs: (Array.isArray(b.installs) ? b.installs : []).slice(0, 15).map((x) => str(x, 50)),
        installOther: str(b.installOther, 200),
        rrlNo: str(b.rrlNo, 60),
        tsp: str(b.tsp, 100),
        auditorName: str(b.auditorName, 100),
        auditorPhone: str(b.auditorPhone, 20),
        gps: b.gps && Number.isFinite(Number(b.gps.lat)) && Number.isFinite(Number(b.gps.lng))
          ? { lat: Number(b.gps.lat), lng: Number(b.gps.lng) } : null,
        capturedAt: str(b.capturedAt, 40),
        photoCount: Math.min(Math.max(Math.floor(num(b.photoCount)), 0), MAX_PHOTOS),
        gsmCount: Math.min(Math.max(Math.floor(num(b.gsmCount)), 0), MAX_GSM),
        createdAt: existing.exists
          ? existing.data().createdAt
          : admin.firestore.FieldValue.serverTimestamp(),
      });

      res.status(201).json({ message: 'Report received.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Could not save report.' });
    }
  });

  // Employee step 2: send photos in small batches  { start, photos:[dataURL, ...] }
  router.post('/:clientId/photos', auth, only('employee'), async (req, res) => {
    try {
      const ref = col().doc(`${req.user.userId}_${cleanId(req.params.clientId)}`);
      if (!(await ref.get()).exists) return res.status(404).json({ message: 'Report not found.' });

      const b = req.body || {};
      const start = Math.floor(num(b.start));
      const list = Array.isArray(b.photos) ? b.photos : [];

      if (start < 0 || start + list.length > MAX_PHOTOS || list.length === 0 || list.length > 8) {
        return res.status(400).json({ message: `Up to ${MAX_PHOTOS} photos are allowed.` });
      }
      if (!list.every(photoOk)) {
        return res.status(400).json({ message: 'A photo is invalid or too large.' });
      }

      const batch = admin.firestore().batch();
      list.forEach((data, i) => {
        const order = start + i;
        batch.set(ref.collection('photos').doc(String(order).padStart(3, '0')), { data, order });
      });
      await batch.commit();

      res.json({ message: 'Photos received.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Could not save photos.' });
    }
  });

  // Admin: list reports. Optional ?date=YYYY-MM-DD
  router.get('/', auth, only('admin'), async (req, res) => {
    try {
      let docs;
      if (req.query.from || req.query.to) {
        let q = col();
        if (req.query.from) q = q.where('date', '>=', str(req.query.from, 20));
        if (req.query.to) q = q.where('date', '<=', str(req.query.to, 20));
        docs = (await q.limit(500).get()).docs;
      } else if (req.query.date) {
        docs = (await col().where('date', '==', str(req.query.date, 20)).limit(200).get()).docs;
      } else {
        docs = (await col().orderBy('createdAt', 'desc').limit(200).get()).docs;
      }

      const reports = docs
        .map((d) => {
          const r = d.data();
          return {
            id: d.id,
            date: r.date,
            siteId: r.siteId,
            siteName: r.siteName,
            location: r.location,
            workTypes: r.workTypes || [],
            workOther: r.workOther || '',
            installs: r.installs || [],
            installOther: r.installOther || '',
            rrlNo: r.rrlNo || '',
            tsp: r.tsp || '',
            gsmCount: r.gsmCount || 0,
            auditorName: r.auditorName || '',
            auditorPhone: r.auditorPhone || '',
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

  // Admin: one report (details only; photos are loaded separately, a few at a time)
  router.get('/:id', auth, only('admin'), async (req, res) => {
    try {
      const snap = await col().doc(req.params.id).get();
      if (!snap.exists) return res.status(404).json({ message: 'Report not found.' });
      const r = snap.data();
      res.json({ report: { ...r, id: snap.id, createdAt: iso(r.createdAt) } });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Could not load report.' });
    }
  });

  // Admin: photos of a report, e.g. ?offset=0&limit=8
  router.get('/:id/photos', auth, only('admin'), async (req, res) => {
    try {
      const ref = col().doc(req.params.id);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ message: 'Report not found.' });

      const total = Math.min(snap.data().photoCount || 0, MAX_PHOTOS);
      const offset = Math.max(0, Math.floor(num(req.query.offset)));
      const limit = Math.min(12, Math.max(1, Math.floor(num(req.query.limit)) || 8));
      const end = Math.min(offset + limit, total);

      if (offset >= end) return res.json({ photos: [], total });

      const photos = await ref
        .collection('photos')
        .where('order', '>=', offset)
        .where('order', '<', end)
        .orderBy('order')
        .get();

      res.json({ photos: photos.docs.map((p) => p.data().data), total });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Could not load photos.' });
    }
  });

  // Employee: GSM photo / PDF files, sent in pieces { idx, name, mime, chunkCount, start, chunks:[base64,...] }
  const pad = (n) => String(n).padStart(3, '0');
  router.post('/:clientId/gsm', auth, only('employee'), async (req, res) => {
    try {
      const ref = col().doc(`${req.user.userId}_${cleanId(req.params.clientId)}`);
      if (!(await ref.get()).exists) return res.status(404).json({ message: 'Report not found.' });
      const b = req.body || {};
      const idx = Math.floor(num(b.idx));
      const start = Math.floor(num(b.start));
      const chunkCount = Math.floor(num(b.chunkCount));
      const chunks = Array.isArray(b.chunks) ? b.chunks : [];
      if (idx < 0 || idx >= MAX_GSM || !['application/pdf', 'image/jpeg'].includes(b.mime) ||
          chunkCount < 1 || chunkCount > 14 || start < 0 || !chunks.length || chunks.length > 4 || start + chunks.length > chunkCount) {
        return res.status(400).json({ message: 'Invalid GSM file.' });
      }
      if (!chunks.every((c) => typeof c === 'string' && c.length <= 700000 && /^[A-Za-z0-9+/=]*$/.test(c))) {
        return res.status(400).json({ message: 'Invalid GSM file data.' });
      }
      const batch = admin.firestore().batch();
      batch.set(ref.collection('gsmfiles').doc(pad(idx)), { idx, name: str(b.name, 150), mime: b.mime, chunkCount });
      chunks.forEach((data, i) => batch.set(ref.collection('gsm').doc(`${pad(idx)}_${pad(start + i)}`), { data }));
      await batch.commit();
      res.json({ message: 'GSM file received.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Could not save GSM file.' });
    }
  });

  // Admin: list of GSM files of a report, and one file
  router.get('/:id/gsm', auth, only('admin'), async (req, res) => {
    try {
      const snap = await col().doc(req.params.id).collection('gsmfiles').orderBy('idx').get();
      res.json({ files: snap.docs.map((d) => ({ idx: d.data().idx, name: d.data().name, mime: d.data().mime })) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Could not load GSM files.' });
    }
  });

  router.get('/:id/gsm/:idx', auth, only('admin'), async (req, res) => {
    try {
      const ref = col().doc(req.params.id);
      const idx = Math.floor(num(req.params.idx));
      const m = await ref.collection('gsmfiles').doc(pad(idx)).get();
      if (!m.exists) return res.status(404).json({ message: 'File not found.' });
      const { name, mime, chunkCount } = m.data();
      const refs = Array.from({ length: chunkCount }, (_, i) => ref.collection('gsm').doc(`${pad(idx)}_${pad(i)}`));
      const docs = await admin.firestore().getAll(...refs);
      res.json({ name, mime, data: docs.map((d) => (d.exists ? d.data().data : '')).join('') });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Could not load file.' });
    }
  });

  // Admin: edit a report (OTP required)
  router.put('/:id', auth, only('admin'), needOtp, async (req, res) => {
    try {
      const ref = col().doc(req.params.id);
      if (!(await ref.get()).exists) return res.status(404).json({ message: 'Report not found.' });
      const b = req.body || {};
      const upd = {
        date: str(b.date, 20),
        siteId: str(b.siteId, 200),
        siteName: str(b.siteName, 200),
        location: str(b.location, 300),
        employeeName: str(b.employeeName, 200),
        rrlNo: str(b.rrlNo, 60),
        tsp: str(b.tsp, 100),
        auditorName: str(b.auditorName, 100),
        auditorPhone: str(b.auditorPhone, 20),
        status: str(b.status, 50),
        siteInfo: str(b.siteInfo, 5000),
        remarks: str(b.remarks, 3000),
        editedAt: admin.firestore.FieldValue.serverTimestamp(),
        editedBy: req.user.userId,
      };
      if (Array.isArray(b.materials)) {
        upd.materials = b.materials.slice(0, 200).map((m) => ({
          name: str(m.name, 200), qty: num(m.qty), rate: num(m.rate), rrl: '', amount: num(m.qty) * num(m.rate),
        }));
        upd.total = upd.materials.reduce((s, m) => s + m.amount, 0);
      }
      if (!upd.siteId) return res.status(400).json({ message: 'Site ID is required.' });
      await ref.update(upd);
      res.json({ message: 'Report updated.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Could not update report.' });
    }
  });

  // Admin: e-mail a report (e.g. to the TSP) - OTP required
  router.post('/:id/email', auth, only('admin'), needOtp, async (req, res) => {
    try {
      const b = req.body || {};
      const to = str(b.to, 200).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ message: 'Invalid email address.' });
      if (!(await col().doc(req.params.id).get()).exists) return res.status(404).json({ message: 'Report not found.' });
      const attachments = (Array.isArray(b.attachments) ? b.attachments : [])
        .slice(0, 3)
        .filter((a) => a && typeof a.content === 'string' && a.content.length < 5500000)
        .map((a) => ({ name: str(a.name, 100).replace(/[^\w.-]/g, '_'), content: a.content }));
      await sendMail({ to, subject: str(b.subject, 200) || 'SIYA Daily Report', text: str(b.text, 8000), attachments });
      res.json({ message: 'Email sent.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: err.message || 'Could not send email.' });
    }
  });

  return router;
};
