'use strict';

const { query } = require('../../db/pool');

// 报告锚点字段（002 建）：本仓储只读这些列 + 关键指标/关联入口的聚合。
const SELECT_FIELDS = `
  r.id, r.code, r.title, r.conclusion, r.period_type, r.period_value,
  r.domain, r.owner, r.created_by, r.created_at
`;

/**
 * 报告清单（场景 3 筛选的落点）。
 * 筛选条件按「与」关系组合：同时给出周期与责任域时，两者都必须命中。
 * 排序：周期值倒序 → 创建时间倒序 → 编码升序（保证同周期内顺序稳定、可断言）。
 *   注：跨周期类型（month / week / day）的严格时间序需要 period_start 列，属后续范围，
 *   当前按 period_value 文本倒序，同一周期类型内正确。
 */
async function list({ periodType = null, periodValue = null, domain = null, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (periodType) {
    params.push(periodType);
    where.push(`r.period_type = $${params.length}`);
  }
  if (periodValue) {
    params.push(periodValue);
    where.push(`r.period_value = $${params.length}`);
  }
  if (domain) {
    params.push(domain);
    where.push(`r.domain = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countResult = await query(`SELECT COUNT(*)::int AS total FROM reports r ${whereSql}`, params);
  const total = countResult.rows[0]?.total ?? 0;

  const listParams = [...params, limit, offset];
  const { rows } = await query(
    `SELECT ${SELECT_FIELDS}
       FROM reports r
       ${whereSql}
      ORDER BY r.period_value DESC NULLS LAST, r.created_at DESC, r.code ASC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams
  );
  return { rows, total };
}

async function findById(id) {
  const { rows } = await query(`SELECT ${SELECT_FIELDS} FROM reports r WHERE r.id = $1`, [id]);
  return rows[0] || null;
}

/** 报告 → 关键结果指标 的显式清单（按 report_id 分组，保持报告内既定顺序）。 */
async function listMetricLinksByReportIds(reportIds) {
  if (!Array.isArray(reportIds) || reportIds.length === 0) return [];
  const { rows } = await query(
    `SELECT report_id, metric_id, order_no
       FROM report_metrics
      WHERE report_id = ANY($1::uuid[])
      ORDER BY report_id, order_no, created_at`,
    [reportIds]
  );
  return rows;
}

/**
 * 每份报告到其余三类视图的关联条数（列表卡片上的三类入口计数）。
 * 一行关联 = 双向可达，故报告在任一端都要计入。
 */
async function linkCountsByReportIds(reportIds) {
  if (!Array.isArray(reportIds) || reportIds.length === 0) return [];
  const { rows } = await query(
    `SELECT report_id, other_type, COUNT(*)::int AS count
       FROM (
         SELECT from_id AS report_id, to_type AS other_type
           FROM object_links
          WHERE from_type = 'report'::view_object_type AND from_id = ANY($1::uuid[])
         UNION ALL
         SELECT to_id AS report_id, from_type AS other_type
           FROM object_links
          WHERE to_type = 'report'::view_object_type AND to_id = ANY($1::uuid[])
       ) t
      GROUP BY report_id, other_type`,
    [reportIds]
  );
  return rows;
}

/** 已存在的报告周期清单（筛选栏的取值来源）。 */
async function listPeriods() {
  const { rows } = await query(
    `SELECT DISTINCT period_type, period_value
       FROM reports
      WHERE period_type IS NOT NULL AND period_value IS NOT NULL
      ORDER BY period_value DESC, period_type ASC`
  );
  return rows;
}

/** 已存在的责任域清单（筛选栏的取值来源）。 */
async function listDomains() {
  const { rows } = await query(
    `SELECT DISTINCT domain FROM reports
      WHERE domain IS NOT NULL AND btrim(domain) <> ''
      ORDER BY domain ASC`
  );
  return rows.map((row) => row.domain);
}

async function insert(client, payload) {
  const { rows } = await client.query(
    `INSERT INTO reports (code, title, conclusion, period_type, period_value, domain, owner, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, code, title, conclusion, period_type, period_value, domain, owner, created_by, created_at`,
    [
      payload.code,
      payload.title,
      payload.conclusion,
      payload.periodType,
      payload.periodValue,
      payload.domain,
      payload.owner,
      payload.createdBy,
    ]
  );
  return rows[0];
}

/** 追加指标关联（幂等：重复引用同一指标不报错、不重复计）。 */
async function attachMetrics(client, reportId, metricIds) {
  for (const [index, metricId] of metricIds.entries()) {
    await client.query(
      `INSERT INTO report_metrics (report_id, metric_id, order_no)
       VALUES ($1, $2, $3)
       ON CONFLICT (report_id, metric_id) DO NOTHING`,
      [reportId, metricId, index + 1]
    );
  }
}

module.exports = {
  list,
  findById,
  listMetricLinksByReportIds,
  linkCountsByReportIds,
  listPeriods,
  listDomains,
  insert,
  attachMetrics,
};
