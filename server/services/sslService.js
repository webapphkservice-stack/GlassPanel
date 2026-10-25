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
    const { stdout } = await run('openssl', ['x509', '-in', certPath, '-noout', '-dates', '-subject', '-ext', 'subjectAltName']);
    const issuedAt = stdout.match(/notBefore=(.+)/)?.[1]?.trim() || '';
    const expiresAt = stdout.match(/notAfter=(.+)/)?.[1]?.trim() || '';
    const subject = stdout.match(/subject=.+CN\s*=\s*([^\n]+)/)?.[1]?.trim() || domain;
    // 证书覆盖的全部域名：多域名站点（如 www + 裸域名）共用同一张证书
    const domains = [...new Set([...stdout.matchAll(/DNS:([^,\s]+)/g)].map((m) => m[1]))];
    return {
      domain,
      certPath,
      keyPath: path.join(getLiveDir(), domain, 'privkey.pem'),
      issuedAt,
      expiresAt,
      subject,
      domains: domains.length > 0 ? domains : [subject || domain],
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

// 域名列表：支持空格/逗号分隔或数组，逐个校验，便于一张证书覆盖多域名站点
const DOMAIN_RE = /^[a-zA-Z0-9][\w\-.]*[a-zA-Z0-9]$/;

function normalizeDomains(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  const domains = [...new Set(list.map((d) => String(d).trim()).filter(Boolean))];
  if (domains.length === 0) throw new Error('缺少域名');
  for (const domain of domains) {
    if (!DOMAIN_RE.test(domain)) throw new Error(`非法域名：${domain}`);
  }
  return domains;
}

async function issueCertificate(input, email = '') {
  const domains = normalizeDomains(input);
  // 站点已占用 80 端口，必须使用 nginx 插件签发；--expand 让已有单域名证书补全新域名
  const args = ['--nginx'];
  for (const domain of domains) args.push('-d', domain);
  args.push('--agree-tos', '-n', '--redirect', '--expand');
  if (email) args.push('-m', email);
  return run('certbot', args, { timeout: 180000 });
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
  normalizeDomains,
  issueCertificate,
  renewCertificate,
  deleteCertificate,
};
