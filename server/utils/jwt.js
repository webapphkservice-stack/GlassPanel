const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const config = require('../config/default');

function sign(payload, options = {}) {
  return jwt.sign(
    { ...payload, jti: randomUUID() },
    config.jwtSecret,
    { expiresIn: options.expiresIn || config.jwtExpiresIn }
  );
}

function verify(token) {
  return jwt.verify(token, config.jwtSecret);
}

module.exports = { sign, verify };
