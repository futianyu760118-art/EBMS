'use strict';

const { getDb } = require('../db');

// 「所需 Evidence」的引用校验与摘要读取（F3/PAND-81 域的只读视图）

async function findByIds(ids) {
  if (!ids.length) return [];
  const db = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  const { rows } = await db.query(
    `SELECT id, type, title, formed_at, owner FROM evidences WHERE id IN (${placeholders})`,
    ids
  );
  return rows.map(toSummary);
}

async function listAll() {
  const db = getDb();
  const { rows } = await db.query(
    'SELECT id, type, title, formed_at, owner FROM evidences ORDER BY formed_at DESC'
  );
  return rows.map(toSummary);
}

function toSummary(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    formedAt: row.formed_at,
    owner: row.owner,
  };
}

module.exports = { findByIds, listAll };
