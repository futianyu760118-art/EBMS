'use strict';

const { getDb } = require('../db');

// 决策「背景」可关联对象（Result / Reason）的解析与候选列表。
// 只读 F1 result_metrics / F2 result_reasons 的结论快照，不重算专业中心算法。

async function listMetricRefs() {
  const db = getDb();
  const { rows } = await db.query(
    `SELECT id, code, name, domain, period_type, period_value
       FROM result_metrics ORDER BY period_value DESC, code ASC`
  );
  return rows.map((row) => ({
    type: 'result',
    id: row.id,
    label: row.name,
    domain: row.domain,
    periodType: row.period_type,
    periodValue: row.period_value,
  }));
}

async function listReasonRefs() {
  const db = getDb();
  const { rows } = await db.query(
    `SELECT r.id, r.metric_id, r.name, r.direction, r.owner, m.name AS metric_name, m.domain
       FROM result_reasons r
       JOIN result_metrics m ON m.id = r.metric_id
      ORDER BY r.metric_id ASC, r.order_no ASC`
  );
  return rows.map((row) => ({
    type: 'reason',
    id: row.id,
    label: row.name,
    metricId: row.metric_id,
    metricName: row.metric_name,
    direction: row.direction,
    domain: row.domain,
  }));
}

async function findRef(type, id) {
  const db = getDb();
  if (type === 'result') {
    const { rows } = await db.query(
      'SELECT id, code, name, domain, period_type, period_value FROM result_metrics WHERE id = ?',
      [id]
    );
    if (!rows[0]) return null;
    const row = rows[0];
    return {
      type: 'result',
      id: row.id,
      label: row.name,
      domain: row.domain,
      periodType: row.period_type,
      periodValue: row.period_value,
    };
  }
  if (type === 'reason') {
    const { rows } = await db.query(
      `SELECT r.id, r.metric_id, r.name, r.direction, m.name AS metric_name, m.domain
         FROM result_reasons r
         JOIN result_metrics m ON m.id = r.metric_id
        WHERE r.id = ?`,
      [id]
    );
    if (!rows[0]) return null;
    const row = rows[0];
    return {
      type: 'reason',
      id: row.id,
      label: row.name,
      metricId: row.metric_id,
      metricName: row.metric_name,
      direction: row.direction,
      domain: row.domain,
    };
  }
  return null;
}

module.exports = { listMetricRefs, listReasonRefs, findRef };
