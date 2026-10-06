'use strict';

const crypto = require('node:crypto');

// scrypt 口令散列（复用 sales 系统 password 思路，不写入任何明文/密钥）
function hashPassword(plain, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(plain, salt, 32).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, salt, derived] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !derived) return false;
  const candidate = crypto.scryptSync(plain, salt, 32).toString('hex');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(derived, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { hashPassword, verifyPassword };
