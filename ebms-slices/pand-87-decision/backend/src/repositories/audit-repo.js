'use strict';

const { getDb } = require('../db');
const { newId, nowIso } = require('../lib/domain');

function parseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// 通用留痕（决策域外的写操作，如登录）。决策的关键变更另行落 decision_changes。
async function record({ actorId, actorName, action, entityType, entityId, detail }) {
  const db = getDb();
  await db.execute(
    `INSERT INTO audit_log (id, actor_id, actor_name, action, entity_type, entity_id, detail, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      actorId || null,
      actorName || '',
      action,
      entityType,
      entityId || null,
      JSON.stringify(detail || {}),
      nowIso(),
    ]
  );
}

// 某对象的留痕（升序）。PAND-87 用它回看执行 TODO 的流转轨迹。
async function listForEntity(entityType, entityId) {
  const db = getDb();
  const { rows } = await db.query(
    'SELECT * FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY at ASC, id ASC',
    [entityType, entityId]
  );
  return rows.map((row) => ({
    id: row.id,
    actor_id: row.actor_id,
    actor_name: row.actor_name,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    detail: parseJson(row.detail),
    at: row.at,
  }));
}

module.exports = { record, listForEntity };
