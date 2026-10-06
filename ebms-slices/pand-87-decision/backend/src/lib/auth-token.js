'use strict';

// 登录 token：沿用 sales.git `backend/lib/auth-token.js` 的既有契约
// （自签 HMAC-SHA256，不引入 jsonwebtoken）。
// 格式：base64url(JSON{uid,username,iat,exp}) . base64url(HMAC-SHA256(payloadJson))
const crypto = require('node:crypto');
const config = require('../config');

function sign(payload) {
  return crypto
    .createHmac('sha256', config.auth.jwtSecret)
    .update(payload)
    .digest('base64url');
}

function issueToken(user) {
  if (!user || user.id === undefined || user.id === null) {
    throw new Error('issueToken: 缺少用户 id');
  }
  const payload = Buffer.from(
    JSON.stringify({
      uid: user.id,
      username: user.username || '',
      iat: Date.now(),
      exp: Date.now() + config.auth.tokenTtlSeconds * 1000,
    })
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || token.length < 3) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;

  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || data.uid === undefined || data.uid === null) return null;
    if (typeof data.exp === 'number' && Date.now() > data.exp) return null;
    return data;
  } catch (_err) {
    return null;
  }
}

module.exports = { issueToken, verifyToken };
