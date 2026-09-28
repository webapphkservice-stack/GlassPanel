const express = require('express');
const ssl = require('../services/sslService');
const store = require('../models/store');

const router = express.Router();

router.get('/certificates', async (req, res, next) => {
  try {
    const certificates = await ssl.listCertificates();
    const stored = store.getCertificates();
    const map = new Map(stored.map((c) => [c.domain, c]));
    const merged = certificates.map((c) => ({ ...c, autoRenew: map.get(c.domain)?.autoRenew ?? 1 }));
    res.json({ certificates: merged });
  } catch (err) {
    next(err);
  }
});

router.post('/issue', async (req, res, next) => {
  try {
    const { domain, email } = req.body || {};
    const result = await ssl.issueCertificate(domain, email);
    if (result.exitCode === 0) {
      const cert = (await ssl.listCertificates()).find((c) => c.domain === domain);
      if (cert) {
        store.saveCertificate(domain, cert.certPath, cert.keyPath, cert.issuedAt, cert.expiresAt, true);
      }
    }
    store.addLog(req.user.username, 'ssl_issue', domain);
    res.json({ success: result.exitCode === 0, output: result });
  } catch (err) {
    next(err);
  }
});

router.post('/renew/:domain', async (req, res, next) => {
  try {
    const { domain } = req.params;
    const result = await ssl.renewCertificate(domain);
    if (result.exitCode === 0) {
      const cert = (await ssl.listCertificates()).find((c) => c.domain === domain);
      if (cert) {
        store.saveCertificate(domain, cert.certPath, cert.keyPath, cert.issuedAt, cert.expiresAt, true);
      }
    }
    store.addLog(req.user.username, 'ssl_renew', domain);
    res.json({ success: result.exitCode === 0, output: result });
  } catch (err) {
    next(err);
  }
});

router.delete('/:domain', async (req, res, next) => {
  try {
    const { domain } = req.params;
    const result = await ssl.deleteCertificate(domain);
    store.deleteCertificate(domain);
    store.addLog(req.user.username, 'ssl_delete', domain);
    res.json({ success: result.exitCode === 0, output: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
