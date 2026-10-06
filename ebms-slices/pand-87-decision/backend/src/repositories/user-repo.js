'use strict';

const { getDb } = require('../db');

async function findByUsername(username) {
  const db = getDb();
  const { rows } = await db.query(
    'SELECT id, username, display_name, password_hash, status FROM users WHERE username = ?',
    [username]
  );
  return rows[0] || null;
}

async function findById(id) {
  const db = getDb();
  const { rows } = await db.query(
    'SELECT id, username, display_name, password_hash, status FROM users WHERE id = ?',
    [id]
  );
  return rows[0] || null;
}

// 返回 { userId, username, displayName, roles: [code], scope }
// scope.mode='all' → 全企业（决策者）；scope.mode='domain' → 限定责任域（管理责任人）
async function loadIdentity(userId) {
  const db = getDb();
  const user = await findById(userId);
  if (!user || user.status !== 'active') return null;

  const { rows: roleRows } = await db.query(
    `SELECT r.code, r.id
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ?`,
    [userId]
  );

  const roles = roleRows.map((r) => r.code);
  const roleIds = roleRows.map((r) => r.id);

  let scope = { mode: 'all' };
  if (roles.includes('domain_owner')) {
    const placeholders = roleIds.map(() => '?').join(', ');
    const { rows: scopeRows } = await db.query(
      `SELECT scope_value FROM role_scope
        WHERE scope_type = 'domain' AND role_id IN (${placeholders})`,
      roleIds
    );
    const domains = [...new Set(scopeRows.map((s) => s.scope_value))];
    // 同时具备决策者角色时，按更宽的全企业范围
    if (!roles.includes('decision_maker')) {
      scope = { mode: 'domain', domains };
    }
  }

  return {
    userId: user.id,
    username: user.username,
    displayName: user.display_name,
    roles,
    scope,
  };
}

module.exports = { findByUsername, findById, loadIdentity };
