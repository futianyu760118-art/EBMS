'use strict';

const { query } = require('../../db/pool');

const COLUMNS = [
  'result_id',
  'contract_version',
  'source_system',
  'object_type',
  'object_id',
  'metric_code',
  'metric_name',
  'value',
  'unit',
  'period_type',
  'period_value',
  'calculation_version',
  'evidence_ids',
  'status',
  'occurred_at',
  'trace_id',
  'received_by',
  'received_at',
];

const RETURNING_FIELDS = COLUMNS.join(', ');
const SELECT_FIELDS = COLUMNS.map((c) => `o.${c}`).join(', ');

/**
 * 登记一条 Owner Result。同一 result_id 重复投递视为同一事实 → 幂等（返回 null 表示已登记）。
 * 字段原样入库，EBMS 不做任何换算。
 */
async function insert(client, payload) {
  const { rows } = await client.query(
    `INSERT INTO owner_results
       (result_id, contract_version, source_system, object_type, object_id, metric_code, metric_name,
        value, unit, period_type, period_value, calculation_version, evidence_ids, status,
        occurred_at, trace_id, received_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17)
     ON CONFLICT (result_id) DO NOTHING
     RETURNING id, ${RETURNING_FIELDS}`,
    [
      payload.resultId,
      payload.contractVersion,
      payload.sourceSystem,
      payload.objectType,
      payload.objectId,
      payload.metricCode,
      payload.metricName ?? null,
      payload.value,
      payload.unit ?? null,
      payload.periodType,
      payload.periodValue,
      payload.calculationVersion,
      JSON.stringify(payload.evidenceIds),
      payload.status,
      payload.occurredAt,
      payload.traceId,
      payload.receivedBy,
    ]
  );
  return rows[0] || null;
}

async function findByResultId(resultId) {
  const { rows } = await query(`SELECT ${SELECT_FIELDS} FROM owner_results o WHERE o.result_id = $1`, [resultId]);
  return rows[0] || null;
}

/** 核对/抽查用清单：可按指标编码与来源模块过滤。 */
async function list({ metricCode = null, sourceSystem = null, limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT ${SELECT_FIELDS}
       FROM owner_results o
      WHERE ($1::text IS NULL OR o.metric_code = $1)
        AND ($2::text IS NULL OR o.source_system = $2)
      ORDER BY o.occurred_at DESC, o.received_at DESC
      LIMIT $3`,
    [metricCode, sourceSystem, limit]
  );
  return rows;
}

module.exports = { insert, findByResultId, list, SELECT_FIELDS };
