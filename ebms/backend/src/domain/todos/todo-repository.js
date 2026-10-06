'use strict';

// F8（PAND-86）TODO 数据访问层。
// 逾期筛选与判定一律以「截止时间 vs 当前时间」比较得出（AC 判定标准），
// 当前时间由用例层显式传入（$5），使筛选、标记与测试断言共享同一时刻。

const { query } = require('../../db/pool');

const COLUMNS = `id, code, title, source, status, owner, due_at,
                 related_refs, trigger_basis, rule_key, created_by, created_at, updated_at`;

/**
 * 未完成且已过截止时间 —— 列表与详情共用的同一个判定表达式。
 * 当前时间的占位符位置由调用方传入：SQL 中必须出现该参数，否则 PG 无法推断其类型（42P18）。
 */
const overdueExpr = (param) => `(due_at IS NOT NULL AND status <> 'done' AND due_at < ${param}::timestamptz)`;

const OVERDUE_EXPR = overdueExpr('$5');

/**
 * 列表查询（场景 4：按责任人 / 状态 / 截止时间筛选，逾期项可单独筛出）。
 * 未过滤时排序：未完成在前，其次按截止时间由近及远，无截止时间者最后。
 */
async function list({
  owner = null,
  status = null,
  source = null,
  dueBefore = null,
  overdue = null,
  limit = 200,
  now = new Date(),
} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const { rows } = await query(
    `SELECT ${COLUMNS}
       FROM todos
      WHERE ($1::text IS NULL OR owner = $1)
        AND ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR source = $3)
        AND ($4::timestamptz IS NULL OR (due_at IS NOT NULL AND due_at <= $4::timestamptz))
        AND ($7::boolean IS NULL OR ${OVERDUE_EXPR} = $7::boolean)
      ORDER BY (status = 'done') ASC, due_at ASC NULLS LAST, created_at DESC, code ASC
      LIMIT $6`,
    [owner, status, source, dueBefore, now, safeLimit, overdue === null ? null : overdue === true || overdue === 'true']
  );
  return rows;
}

/** 汇总计数（列表页顶部汇总；逾期数同样以传入时刻判定）。 */
async function summary({ now = new Date() } = {}) {
  const { rows } = await query(
    `SELECT count(*)::int                                                       AS total,
            count(*) FILTER (WHERE status = 'pending')::int                     AS pending,
            count(*) FILTER (WHERE status = 'in_progress')::int                 AS in_progress,
            count(*) FILTER (WHERE status = 'done')::int                        AS done,
            count(*) FILTER (WHERE source = 'rule')::int                        AS rule_sourced,
            count(*) FILTER (WHERE source = 'manual')::int                      AS manual_sourced,
            count(*) FILTER (WHERE ${overdueExpr('$1')})::int                    AS overdue
       FROM todos`,
    [now]
  );
  return rows[0];
}

async function findById(id, { client = null } = {}) {
  const runner = client || { query };
  const { rows } = await runner.query(`SELECT ${COLUMNS} FROM todos WHERE id = $1`, [id]);
  return rows[0] || null;
}

/**
 * 写入一条待办。带 rule_key 时按该键幂等（重复扫描返回 null，调用方转为「已存在」）。
 * 人工派发不带 rule_key，每次都产生新事项。
 */
async function insert(client, payload) {
  const { rows } = await client.query(
    `INSERT INTO todos
       (code, title, source, status, owner, due_at, related_refs, trigger_basis, rule_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
     ON CONFLICT (rule_key) WHERE rule_key IS NOT NULL DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      payload.code,
      payload.title,
      payload.source,
      payload.status,
      payload.owner,
      payload.dueAt,
      JSON.stringify(payload.relatedRefs || []),
      payload.triggerBasis ? JSON.stringify(payload.triggerBasis) : null,
      payload.ruleKey || null,
      payload.createdBy,
    ]
  );
  return rows[0] || null;
}

/** 认领 / 指派：只改责任人，不改状态（认领不等于开工）。 */
async function updateOwner(client, id, owner, at) {
  const { rows } = await client.query(
    `UPDATE todos SET owner = $2, updated_at = $3 WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, owner, at]
  );
  return rows[0] || null;
}

/** 状态流转：只改状态。 */
async function updateStatus(client, id, status, at) {
  const { rows } = await client.query(
    `UPDATE todos SET status = $2, updated_at = $3 WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, status, at]
  );
  return rows[0] || null;
}

async function findByRuleKey(ruleKey) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM todos WHERE rule_key = $1`, [ruleKey]);
  return rows[0] || null;
}

/** 规则引擎一次扫描涉及的既有键集合（避免逐条回查）。 */
async function listRuleKeys() {
  const { rows } = await query(`SELECT rule_key FROM todos WHERE rule_key IS NOT NULL`);
  return new Set(rows.map((r) => r.rule_key));
}

module.exports = {
  COLUMNS,
  overdueExpr,
  list,
  summary,
  findById,
  insert,
  updateOwner,
  updateStatus,
  findByRuleKey,
  listRuleKeys,
};
