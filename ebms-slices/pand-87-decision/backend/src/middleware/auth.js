'use strict';

const { verifyToken } = require('../lib/auth-token');
const { unauthorized } = require('../lib/errors');
const userRepo = require('../repositories/user-repo');

// 解析 Bearer token → req.identity = { userId, username, displayName, roles, scope }
// scope: { mode: 'all' } | { mode: 'domain', domains: [...] }
async function requireAuth(req, _res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = verifyToken(token);
    if (!payload) return next(unauthorized());

    const identity = await userRepo.loadIdentity(payload.uid);
    if (!identity) return next(unauthorized('账号不存在或已停用'));

    req.identity = identity;
    return next();
  } catch (err) {
    return next(err);
  }
}

// 角色门禁：任一命中即放行；未声明 requiredRoles 表示只校验登录
function requireRole(...requiredRoles) {
  return (req, _res, next) => {
    if (!requiredRoles.length) return next();
    const held = (req.identity && req.identity.roles) || [];
    if (requiredRoles.some((r) => held.includes(r))) return next();
    return next(unauthorized('当前角色无该操作权限'));
  };
}

module.exports = { requireAuth, requireRole };
