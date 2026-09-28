import request from './request';

export const getCertificates = () => request.get('/ssl/certificates');
export const issueCertificate = (domain, email = '') => request.post('/ssl/issue', { domain, email });
export const renewCertificate = (domain) => request.post(`/ssl/renew/${domain}`);
export const deleteCertificate = (domain) => request.delete(`/ssl/${domain}`);
