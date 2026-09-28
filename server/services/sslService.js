const fs = require('fs');
const path = require('path');
const { run } = require('./commandRunner');
const servicesConfig = require('../config/services').certbot;

function getLiveDir() {
  return servicesConfig.certsDir;
}

async function parseCertificate(domain) {
  const certPath = path.join(getLiveDir(), domain, 'fullchain.pem');
  if (!fs.existsSync(certPath)) return null;
  try {
    const { stdout } = await run('openssl', ['x509', '-in', certPath, '-noout', '-dates', '-subject']);
    const issuedAt = stdout.match(/notBefore=(.+)/)?.[1]?.trim() || '';
    const expiresAt = stdout.match(/notAfter=(.+)/)?.[1]?.trim() || '';
    const subject = stdout.match(/subject=.+CN\s*=\s*([^\n]+)/)?.[1]?.trim() || domain;
    return {
      domain,
      certPath,
      keyPath: path.join(getLiveDir(), domain, 'privkey.pem'),
      issuedAt,
      expiresAt,
      subject,
    };
  } catch (err) {
    return { domain, certPath, keyPath: path.join(getLiveDir(), domain, 'privkey.pem') };
  }
}

async function listCertificates() {
  const liveDir = getLiveDir();
  if (!fs.existsSync(liveDir)) return [];
  const domains = fs.readdirSync(liveDir).filter((d) => {
    const full = path.join(liveDir, d);
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'fullchain.pem'));
  });
  const certs = [];
  for (const domain of domains) {
    const cert = await parseCertificate(domain);
    if (cert) certs.push(cert);
  }
  return certs;
}

async function issueCertificate(domain, email = '') {
  if (!domain || !/^[a-zA-Z0-9][\w\-.]*[a-zA-Z0-9]$/.test(domain)) {
    throw new Error('非法域名');
  }
  const args = ['certonly', '--standalone', '-d', domain, '--agree-tos', '-n'];
  if (email) args.push('-m', email);
  return run('certbot', args, { timeout: 120000 });
}

async function renewCertificate(domain) {
  if (!domain) throw new Error('缺少域名');
  return run('certbot', ['renew', '--cert-name', domain, '--noninteractive'], { timeout: 120000 });
}

async function deleteCertificate(domain) {
  if (!domain) throw new Error('缺少域名');
  return run('certbot', ['delete', '--cert-name', domain, '--noninteractive'], { timeout: 60000 });
}

module.exports = {
  getLiveDir,
  listCertificates,
  issueCertificate,
  renewCertificate,
  deleteCertificate,
};
