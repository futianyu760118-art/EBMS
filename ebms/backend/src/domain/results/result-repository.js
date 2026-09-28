'use strict';

const { query } = require('../../db/pool');

/**
 * 指标集 + 其实际值来源。实际值通过 LATERAL 子查询从 owner_results 取「最新一条已核验结果」，
 * 而不是存在 result_metrics 上——EBMS 没有存放/推导实际值的列，故不存在兜底计算的可能。
 *
 * `owner_has_supplied` 区分两种「无数据」：Owner 模块从未供给（未供给），
 * 还是只供给过其它周期（未同步本期）。
 */
const SELECT_FIELDS = `
  m.id, m.code, m.name, m.dimension, m.period_type, m.period_value, m.as_of,
  m.unit, m.owner_module, m.direction, m.target_value, m.target_source_module,
  m.target_source_ref, m.threshold_pct, m.order_no,
  r.result_id, r.contract_version AS result_contract_version,
  r.source_system AS result_source_system, r.object_type AS result_object_type,
  r.object_id AS result_object_id, r.value AS result_value, r.unit AS result_unit,
  r.calculation_version, r.evidence_ids AS result_evidence_ids, r.status AS result_status,
  r.occurred_at AS result_occurred_at, r.trace_id AS result_trace_id,
  COALESCE(s.supplied, false) AS owner_has_supplied
`;

// 最新一条已核验的 Owner Result：先按口径截止时间，再按登记时间，保证同口径下结果稳定。
const LATEST_OWNER_RESULT_JOIN = `
  LEFT JOIN LATERAL (
    SELECT o.*
      FROM owner_results o
     WHERE o.metric_code = m.code
       AND o.source_system = m.owner_module
       AND o.period_type = m.period_type
       AND o.period_value = m.period_value
       AND o.status = 'VERIFIED'
     ORDER BY o.occurred_at DESC, o.received_at DESC
     LIMIT 1
  ) r ON TRUE
`;

const OWNER_SUPPLIED_JOIN = `
  LEFT JOIN LATERAL (
    SELECT TRUE AS supplied
      FROM owner_results x
     WHERE x.metric_code = m.code
       AND x.source_system = m.owner_module
       AND x.status = 'VERIFIED'
     LIMIT 1
  ) s ON TRUE
`;

/** 某周期「配置的指标集」全量条目（含无数据条目——无数据的条目同样占位，不得被过滤掉）。 */
async function listConfigured(periodType, periodValue) {
  const { rows } = await query(
    `SELECT ${SELECT_FIELDS}
       FROM result_metrics m
       ${LATEST_OWNER_RESULT_JOIN}
       ${OWNER_SUPPLIED_JOIN}
      WHERE m.is_active = TRUE
        AND m.period_type = $1
        AND m.period_value = $2
      ORDER BY m.order_no, m.created_at`,
    [periodType, periodValue]
  );
  return rows;
}

async function findById(id) {
  const { rows } = await query(
    `SELECT ${SELECT_FIELDS}
       FROM result_metrics m
       ${LATEST_OWNER_RESULT_JOIN}
       ${OWNER_SUPPLIED_JOIN}
      WHERE m.id = $1`,
    [id]
  );
  return rows[0] || null;
}

/** 未指定周期时的落地周期：取已配置的最新周期，使决策者登录即可看到指标集。 */
async function findLatestPeriod() {
  const { rows } = await query(
    `SELECT period_type, period_value
       FROM result_metrics
      WHERE is_active = TRUE
      ORDER BY period_value DESC, period_type DESC
      LIMIT 1`
  );
  return rows[0] || null;
}

module.exports = { listConfigured, findById, findLatestPeriod };
