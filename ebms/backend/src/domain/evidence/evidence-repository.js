'use strict';

const { query } = require('../../db/pool');

const SELECT_FIELDS = `
  e.id, e.type, e.title, e.formed_at, e.owner, e.content,
  e.attachment_refs, e.created_by, e.created_at,
  e.source_type, e.source_system, e.source_document_no, e.source_data_time,
  e.source_update_cycle, e.source_provider, e.source_entered_by, e.source_entered_at,
  u.display_name AS created_by_name
`;

// 录入人展示名：外键以文本保存，回退到原始值以免历史数据失去可读性。
const CREATOR_JOIN = 'LEFT JOIN ebms_users u ON u.id::text = e.created_by';

/** 来源标注可随新增一并写入（PAND-82），缺省则证据处于「来源缺失」待补状态。 */
async function insert(client, { type, title, formedAt, owner, content, attachmentRefs, createdBy, source = null }) {
  const s = source || {};
  const { rows } = await client.query(
    `INSERT INTO evidences (type, title, formed_at, owner, content, attachment_refs, created_by,
                            source_type, source_system, source_document_no, source_data_time,
                            source_update_cycle, source_provider, source_entered_by, source_entered_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id, type, title, formed_at, owner, content, attachment_refs, created_by, created_at,
               source_type, source_system, source_document_no, source_data_time,
               source_update_cycle, source_provider, source_entered_by, source_entered_at`,
    [
      type,
      title,
      formedAt,
      owner,
      content ?? null,
      JSON.stringify(attachmentRefs || []),
      createdBy,
      s.sourceType ?? null,
      s.sourceSystem ?? null,
      s.sourceDocumentNo ?? null,
      s.sourceDataTime ?? null,
      s.updateCycle ?? null,
      s.sourceProvider ?? null,
      s.enteredBy ?? null,
      s.enteredAt ?? null,
    ]
  );
  return rows[0];
}

async function findById(id) {
  const { rows } = await query(
    `SELECT ${SELECT_FIELDS} FROM evidences e ${CREATOR_JOIN} WHERE e.id = $1`,
    [id]
  );
  return rows[0] || null;
}

/** 原因项下的证据列表，按形成时间倒序；同时带出关联操作信息。 */
async function listByReason(reasonId) {
  const { rows } = await query(
    `SELECT ${SELECT_FIELDS}, re.linked_by, re.linked_at
       FROM reason_evidences re
       JOIN evidences e ON e.id = re.evidence_id
       ${CREATOR_JOIN}
      WHERE re.reason_id = $1
      ORDER BY e.formed_at DESC, e.created_at DESC`,
    [reasonId]
  );
  return rows;
}

async function link(client, { reasonId, evidenceId, linkedBy }) {
  const { rows } = await client.query(
    `INSERT INTO reason_evidences (reason_id, evidence_id, linked_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (reason_id, evidence_id) DO NOTHING
     RETURNING reason_id, evidence_id, linked_by, linked_at`,
    [reasonId, evidenceId, linkedBy]
  );
  return rows[0] || null; // null 表示本就已关联（幂等）
}

async function unlink(client, { reasonId, evidenceId }) {
  const { rowCount } = await client.query(
    `DELETE FROM reason_evidences WHERE reason_id = $1 AND evidence_id = $2`,
    [reasonId, evidenceId]
  );
  return rowCount > 0;
}

async function isLinked(reasonId, evidenceId) {
  const { rows } = await query(
    `SELECT 1 FROM reason_evidences WHERE reason_id = $1 AND evidence_id = $2`,
    [reasonId, evidenceId]
  );
  return rows.length > 0;
}

async function countByReason(reasonId) {
  const { rows } = await query(
    `SELECT count(*)::int AS total FROM reason_evidences WHERE reason_id = $1`,
    [reasonId]
  );
  return rows[0].total;
}

/**
 * 证据候选清单：为「关联已有证据」提供可选目标。
 * 完整的按维度检索与浏览（类型/责任人/来源/时间过滤 + 分页）由 F10（PAND-88）交付。
 */
async function listCandidates({ q = null, unlinkedToReason = null, limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT ${SELECT_FIELDS}
       FROM evidences e
       ${CREATOR_JOIN}
      WHERE ($1::text IS NULL OR e.title ILIKE '%' || $1 || '%' OR e.owner ILIKE '%' || $1 || '%')
        AND ($2::uuid IS NULL OR NOT EXISTS (
              SELECT 1 FROM reason_evidences re
               WHERE re.evidence_id = e.id AND re.reason_id = $2::uuid))
      ORDER BY e.formed_at DESC, e.created_at DESC
      LIMIT $3`,
    [q, unlinkedToReason, limit]
  );
  return rows;
}

/**
 * 按 id 批量读取证据，用于把外部引用（如 Owner Result 的 evidence_ids）解析成本系统的证据实体。
 * 以 `id::text = ANY(...)` 匹配：来源侧给出非法 uuid 时不会抛错，而是解析不到（由调用方显式标注）。
 */
async function listByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const { rows } = await query(
    `SELECT ${SELECT_FIELDS} FROM evidences e ${CREATOR_JOIN} WHERE e.id::text = ANY($1::text[])`,
    [ids]
  );
  return rows;
}

module.exports = { insert, findById, listByReason, listCandidates, listByIds, link, unlink, isLinked, countByReason };
