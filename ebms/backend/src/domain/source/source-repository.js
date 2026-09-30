'use strict';

const { query } = require('../../db/pool');

// 来源标注列（Field 化，非独立实体）：见 migrations/004_source_annotation.sql 文件头口径。
const SOURCE_COLUMNS = `
  e.source_type, e.source_system, e.source_document_no, e.source_data_time,
  e.source_update_cycle, e.source_provider, e.source_entered_by, e.source_entered_at
`;

const EVIDENCE_IDENTITY = `
  e.id, e.type, e.title, e.formed_at, e.owner, e.content, e.created_at
`;

/**
 * 写入来源标注（整块覆盖）：标注与「撤回标注」（全部传 null）走同一入口，
 * 保证来源永远整体存在或整体缺省，不会出现半截来源。
 * 返回 false 表示证据不存在（调用方据此给出 404，而非把 UPDATE 0 行当成成功）。
 */
async function updateSource(client, evidenceId, source) {
  const { rowCount } = await client.query(
    `UPDATE evidences
        SET source_type         = $2,
            source_system       = $3,
            source_document_no  = $4,
            source_data_time    = $5,
            source_update_cycle = $6,
            source_provider     = $7,
            source_entered_by   = $8,
            source_entered_at   = $9
      WHERE id = $1`,
    [
      evidenceId,
      source.sourceType ?? null,
      source.sourceSystem ?? null,
      source.sourceDocumentNo ?? null,
      source.sourceDataTime ?? null,
      source.updateCycle ?? null,
      source.sourceProvider ?? null,
      source.enteredBy ?? null,
      source.enteredAt ?? null,
    ]
  );
  return rowCount > 0;
}

/** 单条证据的来源明细（含证据身份，供场景 1/2/3 的明细视图使用）。 */
async function findById(evidenceId) {
  const { rows } = await query(
    `SELECT ${EVIDENCE_IDENTITY}, ${SOURCE_COLUMNS} FROM evidences e WHERE e.id = $1`,
    [evidenceId]
  );
  return rows[0] || null;
}

const MISSING_FILTER = 'e.source_type IS NULL';

/** 待补清单取数条件：标题关键字 + 证据类型（空值表示不过滤）。 */
const SCOPE_FILTER = `
  ($1::text IS NULL OR e.title ILIKE '%' || $1 || '%')
  AND ($2::text IS NULL OR e.type::text = $2::text)
`;

/**
 * 待补清单（边界）：尚未标注来源的证据。带出其关联原因项，
 * 使待补工作能定位到「卡在哪个归因上」。
 */
async function listMissing({ q = null, evidenceType = null, limit = 50, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT ${EVIDENCE_IDENTITY}, COALESCE(r.reasons, '[]'::jsonb) AS reasons
       FROM evidences e
       LEFT JOIN LATERAL (
              SELECT jsonb_agg(jsonb_build_object('id', rr.id, 'name', rr.name, 'direction', rr.direction)
                               ORDER BY rr.order_no, rr.name) AS reasons
                FROM reason_evidences re
                JOIN result_reasons rr ON rr.id = re.reason_id
               WHERE re.evidence_id = e.id
            ) r ON TRUE
      WHERE ${MISSING_FILTER}
        AND ${SCOPE_FILTER}
      ORDER BY e.formed_at DESC, e.created_at DESC
      LIMIT $3 OFFSET $4`,
    [q, evidenceType, limit, offset]
  );
  return rows;
}

async function countMissing({ q = null, evidenceType = null } = {}) {
  const { rows } = await query(
    `SELECT count(*)::int AS total FROM evidences e WHERE ${MISSING_FILTER} AND ${SCOPE_FILTER}`,
    [q, evidenceType]
  );
  return rows[0].total;
}

/**
 * 来源缺失率与覆盖分布（判定标准 1/2/3 的取数）。
 * 「缺失」以 source_type 是否为空判定，与明细/待补清单同一口径。
 */
async function stats({ q = null, evidenceType = null } = {}) {
  const { rows } = await query(
    `SELECT
       count(*)::int AS total_count,
       count(*) FILTER (WHERE e.source_type IS NULL)::int AS missing_count,
       count(*) FILTER (WHERE e.source_type = 'internal')::int AS internal_count,
       count(*) FILTER (WHERE e.source_type = 'external')::int AS external_count,
       count(*) FILTER (WHERE e.source_type = 'manual')::int   AS manual_count,
       count(*) FILTER (WHERE e.source_type = 'external'
                          AND e.source_provider IS NOT NULL
                          AND btrim(e.source_provider) <> '')::int AS external_with_provider,
       count(*) FILTER (WHERE e.source_type = 'manual'
                          AND e.source_entered_by IS NOT NULL
                          AND btrim(e.source_entered_by) <> ''
                          AND e.source_entered_at IS NOT NULL)::int AS manual_with_trace
     FROM evidences e
     WHERE ${SCOPE_FILTER}`,
    [q, evidenceType]
  );
  return rows[0];
}

module.exports = { updateSource, findById, listMissing, countMissing, stats };
