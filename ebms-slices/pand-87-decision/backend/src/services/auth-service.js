'use strict';

const userRepo = require('../repositories/user-repo');
const auditRepo = require('../repositories/audit-repo');
const { verifyPassword } = require('../lib/password');
const { issueToken } = require('../lib/auth-token');
const { unauthorized } = require('../lib/errors');
const { resolveLanding } = require('./landing-service');

function publicUser(identity) {
  return {
    id: identity.userId,
    username: identity.username,
    displayName: identity.displayName,
    roles: identity.roles,
    scope: identity.scope,
  };
}

async function login({ username, password }) {
  const user = await userRepo.findByUsername((username || '').trim());
  if (!user || user.status !== 'active') throw unauthorized('用户名或密码错误');
  if (!verifyPassword(password, user.password_hash)) {
    throw unauthorized('用户名或密码错误');
  }

  const identity = await userRepo.loadIdentity(user.id);
  if (!identity) throw unauthorized('用户名或密码错误');

  await auditRepo.record({
    actorId: user.id,
    actorName: user.display_name,
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    detail: { username: user.username },
  });

  return {
    token: issueToken(user),
    user: publicUser(identity),
    landing: resolveLanding(identity),
  };
}

module.exports = { login, publicUser };
