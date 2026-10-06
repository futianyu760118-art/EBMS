'use strict';

const { getDb } = require('../db');
const { newId, nowIso } = require('../lib/domain');

// F8/PAND-86 域表的读写视图。PAND-87 只做两件事：
//   1) 读取执行产生的 TODO（回看执行结果）
//   2) 由决策派发新 TODO（写入 source='manual'）
// TODO 的状态流转算法归 F8（PAND-86），本切片不修改、不重算。

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toTodo(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    trigger_basis: parseJson(row.trigger_basis, null),
    related_refs: parseJson(row.related_refs, []),
    owner: row.owner,
    due_at: row.due_at,
    status: row.status,
    rule_key: row.rule_key,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function findByIds(ids) {
  if (!ids.length) return [];
  const db = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  const { rows } = await db.query(
    `SELECT * FROM todos WHERE id IN (${placeholders})`,
    ids
  );
  return rows.map(toTodo);
}

// 可被决策关联的 TODO 候选（未完成优先）。domain 字段在 F8 表上不存在，
// 因此按「是否已被任一决策关联」区分，供 Decision 视图选择要关联的执行项。
async function listCandidates({ limit = 100 } = {}) {
  const db = getDb();
  const { rows } = await db.query(
    `SELECT t.*,
            (SELECT l.from_id FROM object_links l
              WHERE l.from_type = 'decision' AND l.to_type = 'todo' AND l.to_id = t.id
              LIMIT 1) AS linked_decision_id
       FROM todos t
      ORDER BY CASE t.status WHEN 'done' THEN 1 ELSE 0 END ASC, t.due_at ASC
      LIMIT ?`,
    [limit]
  );
  return rows.map((row) => ({
    ...toTodo(row),
    linkedDecisionId: row.linked_decision_id || null,
  }));
}

async function insert(todo) {
  const db = getDb();
  const at = nowIso();
  const record = {
    id: todo.id || newId(),
    title: todo.title,
    source: todo.source,
    trigger_basis: todo.trigger_basis ? JSON.stringify(todo.trigger_basis) : null,
    related_refs: JSON.stringify(todo.related_refs || []),
    owner: todo.owner || null,
    due_at: todo.due_at,
    status: todo.status || 'pending',
    rule_key: todo.rule_key || null,
    created_by: todo.created_by || null,
    created_at: at,
    updated_at: at,
  };
  await db.execute(
    `INSERT INTO todos
       (id, title, source, trigger_basis, related_refs, owner, due_at, status, rule_key,
        created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id, record.title, record.source, record.trigger_basis, record.related_refs,
      record.owner, record.due_at, record.status, record.rule_key, record.created_by,
      record.created_at, record.updated_at,
    ]
  );
  return record;
}

module.exports = { findByIds, listCandidates, insert, toTodo };
