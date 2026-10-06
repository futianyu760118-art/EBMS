'use strict';

const { getDb } = require('../db');
const { newId, nowIso } = require('../lib/domain');

// 四视图对象互相关联（F11/PAND-89 口径）。本切片写入 decision → todo（执行关联），
// PAND-89 的四视图交叉跳转直接复用这张表。

async function listFrom(fromType, fromId, toType) {
  const db = getDb();
  const params = [fromType, fromId];
  let sql =
    `SELECT id, from_type, from_id, to_type, to_id, created_at
       FROM object_links
      WHERE from_type = ? AND from_id = ?`;
  if (toType) {
    sql += ' AND to_type = ?';
    params.push(toType);
  }
  sql += ' ORDER BY created_at ASC';
  const { rows } = await db.query(sql, params);
  return rows;
}

async function find(fromType, fromId, toType, toId) {
  const db = getDb();
  const { rows } = await db.query(
    `SELECT id, from_type, from_id, to_type, to_id, created_at
       FROM object_links
      WHERE from_type = ? AND from_id = ? AND to_type = ? AND to_id = ?`,
    [fromType, fromId, toType, toId]
  );
  return rows[0] || null;
}

async function insert({ fromType, fromId, toType, toId }) {
  const db = getDb();
  const record = { id: newId(), fromType, fromId, toType, toId, createdAt: nowIso() };
  await db.execute(
    `INSERT INTO object_links (id, from_type, from_id, to_type, to_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [record.id, fromType, fromId, toType, toId, record.createdAt]
  );
  return record;
}

async function remove(fromType, fromId, toType, toId) {
  const db = getDb();
  const { rowCount } = await db.execute(
    `DELETE FROM object_links
      WHERE from_type = ? AND from_id = ? AND to_type = ? AND to_id = ?`,
    [fromType, fromId, toType, toId]
  );
  return rowCount;
}

module.exports = { listFrom, find, insert, remove };
