'use strict';

const { getDb } = require('../db');
const { newId, nowIso } = require('../lib/domain');
const { DECISION_CHANGE_ACTION } = require('../lib/decision-status');

// 决策域数据访问（F9/PAND-87）。
//
// 「结论不可静默修改」在本层结构上兜底：decisions.conclusion 只由
// updateConclusion() 写入，而该方法在同一事务内必定追加一条 decision_changes，
// 因此不存在「改了结论却没有变更记录」的路径。

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toDecision(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    domain: row.domain,
    background: row.background,
    related_refs: parseJson(row.related_refs, []),
    options: parseJson(row.options, []),
    required_evidence_ids: parseJson(row.required_evidence_ids, []),
    conclusion: row.conclusion,
    status: row.status,
    decider: row.decider,
    decider_id: row.decider_id,
    decided_at: row.decided_at,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toChange(row) {
  if (!row) return null;
  return {
    id: row.id,
    decision_id: row.decision_id,
    seq: Number(row.seq),
    action: row.action,
    reason: row.reason,
    before: parseJson(row.before, null),
    after: parseJson(row.after, null),
    changed_by: row.changed_by,
    changed_by_name: row.changed_by_name,
    changed_at: row.changed_at,
  };
}

function changeRow(change, seq) {
  return [
    change.id || newId(),
    change.decisionId,
    seq,
    change.action,
    change.reason || null,
    change.before ? JSON.stringify(change.before) : null,
    change.after ? JSON.stringify(change.after) : null,
    change.changedBy || null,
    change.changedByName,
    change.changedAt || nowIso(),
  ];
}

const CHANGE_COLUMNS =
  '(id, decision_id, seq, action, reason, before, after, changed_by, changed_by_name, changed_at)';
const CHANGE_PLACEHOLDERS = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

// 决策内写入序号。必须在事务内调用：先算出 seq 再插入，同一决策的并发写不会串号。
async function nextSeq(tx, decisionId) {
  const rows = await tx.query(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM decision_changes WHERE decision_id = ?',
    [decisionId]
  );
  return Number(rows[0].next);
}

// 责任域过滤：决策者（scope.mode='all'）不过滤；管理责任人仅见本责任域
function scopeClause(scope, params) {
  if (!scope || scope.mode === 'all') return '';
  const domains = scope.domains || [];
  if (!domains.length) return ' AND 1 = 0';
  params.push(...domains);
  return ` AND domain IN (${domains.map(() => '?').join(', ')})`;
}

async function insert(decision, initialChange) {
  const db = getDb();
  const at = nowIso();
  const record = {
    id: decision.id || newId(),
    title: decision.title,
    domain: decision.domain,
    background: decision.background,
    related_refs: decision.related_refs || [],
    options: decision.options || [],
    required_evidence_ids: decision.required_evidence_ids || [],
    conclusion: null,
    status: 'pending',
    decider: null,
    decider_id: null,
    decided_at: null,
    created_by: decision.created_by || null,
    created_at: at,
    updated_at: at,
  };
  await db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO decisions
         (id, title, domain, background, related_refs, options, required_evidence_ids,
          conclusion, status, decider, decider_id, decided_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id, record.title, record.domain, record.background,
        JSON.stringify(record.related_refs), JSON.stringify(record.options),
        JSON.stringify(record.required_evidence_ids), record.conclusion, record.status,
        record.decider, record.decider_id, record.decided_at, record.created_by,
        record.created_at, record.updated_at,
      ]
    );
    await tx.execute(
      `INSERT INTO decision_changes ${CHANGE_COLUMNS} VALUES ${CHANGE_PLACEHOLDERS}`,
      changeRow({ ...initialChange, decisionId: record.id, changedAt: at }, 1)
    );
  });
  return record;
}

async function findById(id) {
  const db = getDb();
  const { rows } = await db.query('SELECT * FROM decisions WHERE id = ?', [id]);
  return toDecision(rows[0]);
}

// 结论形成/修改：更新决策状态与结论字段，并在同一事务内追加变更留痕。
async function updateConclusion({ id, conclusion, status, decider, deciderId, decidedAt, change }) {
  const db = getDb();
  const at = nowIso();
  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE decisions
          SET conclusion = ?, status = ?, decider = ?, decider_id = ?, decided_at = ?, updated_at = ?
        WHERE id = ?`,
      [conclusion, status, decider, deciderId, decidedAt, at, id]
    );
    await tx.execute(
      `INSERT INTO decision_changes ${CHANGE_COLUMNS} VALUES ${CHANGE_PLACEHOLDERS}`,
      changeRow({ ...change, decisionId: id, changedAt: at }, await nextSeq(tx, id))
    );
  });
  return findById(id);
}

// 非结论类变更（关联/解除执行 TODO）：只追加留痕并更新 updated_at
async function recordChange(id, change) {
  const db = getDb();
  const at = nowIso();
  await db.transaction(async (tx) => {
    await tx.execute('UPDATE decisions SET updated_at = ? WHERE id = ?', [at, id]);
    await tx.execute(
      `INSERT INTO decision_changes ${CHANGE_COLUMNS} VALUES ${CHANGE_PLACEHOLDERS}`,
      changeRow({ ...change, decisionId: id, changedAt: at }, await nextSeq(tx, id))
    );
  });
}

// 按写入次序返回（seq），同一毫秒内的多条变更也能保持正确先后。
async function listChanges(decisionId) {
  const db = getDb();
  const { rows } = await db.query(
    'SELECT * FROM decision_changes WHERE decision_id = ? ORDER BY seq ASC',
    [decisionId]
  );
  return rows.map(toChange);
}

async function list({ status, domain, scope, limit, offset }) {
  const db = getDb();
  const params = [];
  const where = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (domain) {
    where.push('domain = ?');
    params.push(domain);
  }
  const scopeSql = scopeClause(scope, params);
  const whereSql = `WHERE 1 = 1${where.length ? ` AND ${where.join(' AND ')}` : ''}${scopeSql}`;

  const { rows } = await db.query(
    `SELECT * FROM decisions ${whereSql}
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END ASC, updated_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return rows.map(toDecision);
}

// 列表页需要的变更计数：一次分组查询取回整页，避免逐条 N+1。
// conclusionChangeCount 是「结论变更次数」，即判定标准「变更记录条数 ≥ 实际修改次数」的分子。
async function countChangesFor(ids) {
  if (!ids.length) return new Map();
  const db = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  const { rows } = await db.query(
    `SELECT decision_id,
            COUNT(*) AS total,
            SUM(CASE WHEN action IN (?, ?) THEN 1 ELSE 0 END) AS conclusion_changes
       FROM decision_changes
      WHERE decision_id IN (${placeholders})
      GROUP BY decision_id`,
    [DECISION_CHANGE_ACTION.DECIDED, DECISION_CHANGE_ACTION.REVISED, ...ids]
  );
  return new Map(
    rows.map((row) => [
      row.decision_id,
      { changeCount: Number(row.total), conclusionChangeCount: Number(row.conclusion_changes) },
    ])
  );
}

async function count({ status, domain, scope }) {
  const db = getDb();
  const params = [];
  const where = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (domain) {
    where.push('domain = ?');
    params.push(domain);
  }
  const scopeSql = scopeClause(scope, params);
  const whereSql = `WHERE 1 = 1${where.length ? ` AND ${where.join(' AND ')}` : ''}${scopeSql}`;
  const { rows } = await db.query(`SELECT COUNT(*) AS total FROM decisions ${whereSql}`, params);
  return Number(rows[0].total);
}

// 已决策 / 待决策 计数：待决策不计入已决策数量（判定标准）
async function countsByStatus({ domain, scope } = {}) {
  const db = getDb();
  const params = [];
  const where = [];
  if (domain) {
    where.push('domain = ?');
    params.push(domain);
  }
  const scopeSql = scopeClause(scope, params);
  const whereSql = `WHERE 1 = 1${where.length ? ` AND ${where.join(' AND ')}` : ''}${scopeSql}`;

  const { rows } = await db.query(
    `SELECT status, COUNT(*) AS total FROM decisions ${whereSql} GROUP BY status`,
    params
  );
  const counts = { pending: 0, decided: 0 };
  for (const row of rows) counts[row.status] = Number(row.total);
  return { ...counts, total: counts.pending + counts.decided };
}

module.exports = {
  insert,
  findById,
  updateConclusion,
  recordChange,
  listChanges,
  list,
  count,
  countsByStatus,
  countChangesFor,
};
