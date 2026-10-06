'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

// 驱动契约（repository 层只依赖这些方法，保证 PG / SQLite 可替换）：
//   query(sql, params)   -> { rows }
//   execute(sql, params) -> { rowCount }
//   transaction(fn)      -> fn(tx) 的返回值，异常回滚
//   dialect              -> 'pg' | 'sqlite'
// SQL 统一用 `?` 占位符书写，pg 驱动内部翻译为 $1..$n。

function translatePlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function createPgDriver() {
  const { Pool } = require('pg');
  const pool = new Pool(config.db.pg);
  return {
    dialect: 'pg',
    async query(sql, params = []) {
      const res = await pool.query(translatePlaceholders(sql), params);
      return { rows: res.rows };
    },
    async execute(sql, params = []) {
      const res = await pool.query(translatePlaceholders(sql), params);
      return { rowCount: res.rowCount };
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({
          query: async (sql, params = []) =>
            (await client.query(translatePlaceholders(sql), params)).rows,
          execute: async (sql, params = []) =>
            (await client.query(translatePlaceholders(sql), params)).rowCount,
        });
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async runScript(sqlText) {
      await pool.query(sqlText);
    },
    async close() {
      await pool.end();
    },
  };
}

function createSqliteDriver() {
  const { DatabaseSync } = require('node:sqlite');
  const file = config.db.sqliteFile === ':memory:'
    ? ':memory:'
    : path.resolve(process.cwd(), config.db.sqliteFile);
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');

  return {
    dialect: 'sqlite',
    async query(sql, params = []) {
      return { rows: db.prepare(sql).all(...params) };
    },
    async execute(sql, params = []) {
      const info = db.prepare(sql).run(...params);
      return { rowCount: Number(info.changes) };
    },
    async transaction(fn) {
      db.exec('BEGIN');
      try {
        const out = await fn({
          query: async (sql, params = []) => db.prepare(sql).all(...params),
          execute: async (sql, params = []) => Number(db.prepare(sql).run(...params).changes),
        });
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    async runScript(sqlText) {
      db.exec(sqlText);
    },
    async close() {
      db.close();
    },
  };
}

let driver = null;

function getDb() {
  if (!driver) {
    driver = config.db.driver === 'sqlite' ? createSqliteDriver() : createPgDriver();
  }
  return driver;
}

async function closeDb() {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

function schemaText(dialect) {
  const file = dialect === 'sqlite' ? 'schema.sqlite.sql' : 'schema.pg.sql';
  return fs.readFileSync(path.join(__dirname, file), 'utf8');
}

module.exports = { getDb, closeDb, schemaText };
