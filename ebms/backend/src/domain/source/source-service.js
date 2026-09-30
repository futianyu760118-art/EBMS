'use strict';

const { withTransaction } = require('../../db/pool');
const { badRequest, notFound } = require('../../http/errors');
const { labelOf } = require('../evidence/evidence-types');
const auditRepo = require('../audit/audit-repository');
const sourceRepo = require('./source-repository');
const {
  SOURCE_TYPES,
  UPDATE_CYCLES,
  SOURCE_MISSING_MARKER,
  SOURCE_DISPLAY_FIELDS,
  MANUAL_DISPLAY_FIELDS,
  UPDATE_CYCLE_FIELD,
  ADVISORY_FIELDS,
  isValidSourceType,
  isValidUpdateCycle,
  requiredFieldsOf,
  pendingFieldsForMissing,
  listSourceCatalog,
} = require('./source-types');

const FIELD_LABELS = Object.freeze({
  sourceSystem: '来源系统',
  sourceDocumentNo: '来源单据编号',
  sourceDataTime: '来源数据时间',
  sourceProvider: '提供方',
  enteredBy: '录入人',
  enteredAt: '录入时间',
  updateCycle: '更新周期',
});

function labelOfField(field) {
  return FIELD_LABELS[field] || field;
}

function isBlank(value) {
  return typeof value !== 'string' || value.trim() === '';
}

function parseDateTime(value, field, code) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest(code, `${labelOfField(field)}不是合法的日期时间`);
  }
  return parsed.toISOString();
}

/**
 * 校验一份完整的来源标注。
 * 判定标准（外部数据提供方非空、人工录入录入人与录入时间非空）在此拒绝，
 * 并由 004 迁移的 CHECK 约束兜底——接口层与存储层同一口径。
 */
function validateSourceInput(input) {
  const fields = {};
  const payload = {};

  if (!isValidSourceType(input?.sourceType)) {
    fields.sourceType = '来源类别必须是 internal（内部系统）/ external（外部数据）/ manual（人工录入）之一';
  } else {
    payload.sourceType = input.sourceType;
  }

  if (isBlank(input?.sourceSystem)) {
    fields.sourceSystem = '来源系统不能为空';
  } else {
    payload.sourceSystem = input.sourceSystem.trim();
  }

  if (input?.sourceDataTime === undefined || input?.sourceDataTime === null || input?.sourceDataTime === '') {
    fields.sourceDataTime = '来源数据时间不能为空';
  } else {
    payload.sourceDataTime = parseDateTime(
      input.sourceDataTime,
      'sourceDataTime',
      'SOURCE_DATA_TIME_INVALID'
    );
  }

  // 场景 3 / 判定标准 2：外部数据必须标注提供方（空串视为未标注）
  if (payload.sourceType === 'external' && isBlank(input?.sourceProvider)) {
    fields.sourceProvider = '外部数据的提供方不能为空';
  } else if (!isBlank(input?.sourceProvider)) {
    payload.sourceProvider = input.sourceProvider.trim();
  }

  // 场景 2 / 判定标准 3：人工录入必须标注录入人与录入时间
  if (payload.sourceType === 'manual') {
    if (isBlank(input?.enteredBy)) {
      fields.enteredBy = '人工录入的来源必须标注录入人';
    } else {
      payload.enteredBy = input.enteredBy.trim();
    }
    if (input?.enteredAt === undefined || input?.enteredAt === null || input?.enteredAt === '') {
      fields.enteredAt = '人工录入的来源必须标注录入时间';
    } else {
      payload.enteredAt = parseDateTime(input.enteredAt, 'enteredAt', 'SOURCE_ENTERED_AT_INVALID');
    }
  }

  // 非判定项：来源单据编号缺失不阻断写入，仅在明细中提示补齐
  if (!isBlank(input?.sourceDocumentNo)) {
    payload.sourceDocumentNo = input.sourceDocumentNo.trim();
  }

  // 更新周期：口径要求说明数据为周期更新（日/周/月），缺省不阻断
  if (input?.updateCycle !== undefined && input?.updateCycle !== null && input?.updateCycle !== '') {
    if (!isValidUpdateCycle(input.updateCycle)) {
      fields.updateCycle = '更新周期必须是 day / week / month 之一';
    } else {
      payload.updateCycle = input.updateCycle;
    }
  }

  if (Object.keys(fields).length === 0) return payload;

  const details = { fields };
  if (fields.sourceType) {
    details.received = input?.sourceType ?? null;
    details.allowed = Object.keys(SOURCE_TYPES);
  }

  const [field] = Object.keys(fields);
  const codes = {
    sourceType: isBlank(input?.sourceType) ? 'SOURCE_TYPE_REQUIRED' : 'SOURCE_TYPE_INVALID',
    sourceSystem: 'SOURCE_SYSTEM_REQUIRED',
    sourceDataTime:
      input?.sourceDataTime === undefined || input?.sourceDataTime === null || input?.sourceDataTime === ''
        ? 'SOURCE_DATA_TIME_REQUIRED'
        : 'SOURCE_DATA_TIME_INVALID',
    sourceProvider: 'SOURCE_PROVIDER_REQUIRED',
    enteredBy: 'SOURCE_ENTERED_BY_REQUIRED',
    enteredAt:
      input?.enteredAt === undefined || input?.enteredAt === null || input?.enteredAt === ''
        ? 'SOURCE_ENTERED_AT_REQUIRED'
        : 'SOURCE_ENTERED_AT_INVALID',
    updateCycle: 'SOURCE_UPDATE_CYCLE_INVALID',
  };
  throw badRequest(codes[field], fields[field], details);
}

// ---------------------------------------------------------------- 序列化

/**
 * 一份来源标注当前还缺哪些字段。
 * 已标注来源上，判定项由 DB 约束保证非空，实际只会剩下「非判定项」的待补提示；
 * 无来源时则列出场景 1 的全部字段，供待补清单直接展示。
 */
function pendingFieldsOf(row) {
  if (row.source_type === null) return pendingFieldsForMissing();

  const missingRequired = requiredFieldsOf(row.source_type).filter((field) => {
    if (field === 'enteredBy') return isBlank(row.source_entered_by);
    if (field === 'enteredAt') return row.source_entered_at === null;
    return false;
  });
  const advisory = ADVISORY_FIELDS.filter(() => isBlank(row.source_document_no));
  return [...missingRequired, ...advisory];
}

function displayBlock(doorFields, row) {
  return doorFields.map(({ key, label }) => ({
    key,
    label,
    value: rowValue(row, key),
  }));
}

function rowValue(row, key) {
  switch (key) {
    case 'sourceSystem':
      return row.source_system;
    case 'sourceDocumentNo':
      return row.source_document_no;
    case 'sourceDataTime':
      return row.source_data_time;
    case 'sourceProvider':
      return row.source_provider;
    case 'enteredBy':
      return row.source_entered_by;
    case 'enteredAt':
      return row.source_entered_at;
    case 'updateCycle':
      return row.source_update_cycle;
    default:
      return null;
  }
}

/**
 * 来源明细视图（场景 1/2/3 + 边界）。
 * 日期字段一律回传 ISO 字符串（前端负责本地化展示），中文标签由后端统一给出，
 * 避免同一份口径在前后端各写一遍。
 */
function serializeSourceDetail(row) {
  const missing = row.source_type === null;
  const manual = row.source_type === 'manual';
  const pendingFields = pendingFieldsOf(row);

  return {
    evidence: {
      id: row.id,
      type: row.type,
      typeLabel: labelOf(row.type),
      title: row.title,
      formedAt: row.formed_at,
      owner: row.owner,
    },
    // 边界：无 Source 的证据统一标记「来源缺失」
    sourceMissing: missing,
    missingMarker: missing ? SOURCE_MISSING_MARKER : null,
    sourceType: row.source_type,
    sourceTypeLabel: missing ? null : SOURCE_TYPES[row.source_type],
    sourceSystem: row.source_system,
    sourceDocumentNo: row.source_document_no,
    sourceDataTime: row.source_data_time,
    sourceProvider: row.source_provider,
    // 场景 2：仅人工录入来源带录入人与录入时间
    enteredBy: manual ? row.source_entered_by : null,
    enteredAt: manual ? row.source_entered_at : null,
    // 口径：数据为周期更新（日/周/月），非实时；数据截止时间与来源数据时间同源
    updateCycle: row.source_update_cycle,
    updateCycleLabel: row.source_update_cycle ? UPDATE_CYCLES[row.source_update_cycle] : null,
    dataCutoffAt: row.source_data_time,
    // 场景 1 的展示字段（顺序即展示顺序）
    display: displayBlock(SOURCE_DISPLAY_FIELDS, row),
    // 场景 2 的追加展示字段（非人工录入时为空）
    manualDisplay: manual ? displayBlock(MANUAL_DISPLAY_FIELDS, row) : [],
    updateCycleDisplay: { ...UPDATE_CYCLE_FIELD, value: row.source_update_cycle },
    // 待补提示：来源缺失时为场景 1 全字段；已标注时仅为非判定项的补齐提示
    pendingFields,
    pendingFieldLabels: pendingFields.map(labelOfField),
  };
}

/** 列表行的来源摘要：列表也要能一眼看出「来源缺失」。 */
function serializeSourceSummary(row) {
  const missing = row.source_type === null;
  return {
    sourceMissing: missing,
    missingMarker: missing ? SOURCE_MISSING_MARKER : null,
    sourceType: row.source_type,
    sourceTypeLabel: missing ? null : SOURCE_TYPES[row.source_type],
    sourceSystem: row.source_system,
    dataCutoffAt: row.source_data_time,
  };
}

function serializeAudit(row) {
  return {
    id: String(row.id),
    actor: row.actor,
    actorName: row.actor_name,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    at: row.at,
    before: row.before,
    after: row.after,
  };
}

function actorNameOf(actor) {
  return actor.displayName || actor.username || actor.id;
}

/** 留痕快照：字段名与接口入参保持一致，便于测试逐项比对。 */
function sourceSnapshot(input) {
  return {
    sourceType: input.sourceType,
    sourceSystem: input.sourceSystem,
    sourceDocumentNo: input.sourceDocumentNo ?? null,
    sourceDataTime: input.sourceDataTime,
    updateCycle: input.updateCycle ?? null,
    sourceProvider: input.sourceProvider ?? null,
    enteredBy: input.enteredBy ?? null,
    enteredAt: input.enteredAt ?? null,
  };
}

// ---------------------------------------------------------------- 用例

/** 场景 1/2/3 + 边界：单条证据的来源明细。 */
async function getEvidenceSource(evidenceId) {
  const row = await sourceRepo.findById(evidenceId);
  if (!row) {
    throw notFound('EVIDENCE_NOT_FOUND', `证据不存在：${evidenceId}`);
  }
  return serializeSourceDetail(row);
}

/**
 * 标注 / 更正来源（唯一写入入口）。写入与留痕同事务：
 * 首次标注记 annotate，已有来源再改记 update，使来源变更可追溯。
 */
async function annotateSource(actor, evidenceId, input) {
  const payload = validateSourceInput(input);

  const before = await sourceRepo.findById(evidenceId);
  if (!before) {
    throw notFound('EVIDENCE_NOT_FOUND', `证据不存在：${evidenceId}`);
  }

  const action = before.source_type === null ? 'evidence.source.annotate' : 'evidence.source.update';
  const beforeSnapshot = before.source_type === null ? null : sourceSnapshotOfRow(before);

  // 留痕行由事务内直接返回：同一证据被反复更正时，不能靠回读「第一条同 action」来认领本次留痕。
  const audit = await withTransaction(async (client) => {
    const updated = await sourceRepo.updateSource(client, evidenceId, payload);
    if (!updated) {
      throw notFound('EVIDENCE_NOT_FOUND', `证据不存在：${evidenceId}`);
    }
    return auditRepo.record(client, {
      actor: actor.id,
      actorName: actorNameOf(actor),
      action,
      entityType: 'evidence',
      entityId: evidenceId,
      reasonId: null,
      before: beforeSnapshot,
      after: sourceSnapshot(payload),
    });
  });

  const row = await sourceRepo.findById(evidenceId);
  return {
    ...serializeSourceDetail(row),
    audit: serializeAudit(audit),
  };
}

/** before 快照：字段名与 sourceSnapshot 完全一致，使「更正」的 before/after 可逐项对比。 */
function sourceSnapshotOfRow(row) {
  return {
    sourceType: row.source_type,
    sourceSystem: row.source_system,
    sourceDocumentNo: row.source_document_no,
    sourceDataTime: row.source_data_time,
    updateCycle: row.source_update_cycle,
    sourceProvider: row.source_provider,
    enteredBy: row.source_entered_by,
    enteredAt: row.source_entered_at,
  };
}

/** 边界：待补清单（尚未标注来源的证据）。 */
async function listMissingSources({ q = null, evidenceType = null, limit = 50, offset = 0 } = {}) {
  const scope = {
    q: typeof q === 'string' && q.trim() !== '' ? q.trim() : null,
    evidenceType: typeof evidenceType === 'string' && evidenceType.trim() !== '' ? evidenceType.trim() : null,
  };
  const size = Math.min(Number(limit) || 50, 200);
  const skip = Math.max(Number(offset) || 0, 0);

  const [rows, total] = await Promise.all([
    sourceRepo.listMissing({ ...scope, limit: size, offset: skip }),
    sourceRepo.countMissing(scope),
  ]);

  return {
    marker: SOURCE_MISSING_MARKER,
    total,
    limit: size,
    offset: skip,
    items: rows.map((row) => ({
      evidenceId: row.id,
      type: row.type,
      typeLabel: labelOf(row.type),
      title: row.title,
      formedAt: row.formed_at,
      owner: row.owner,
      createdAt: row.created_at,
      sourceMissing: true,
      missingMarker: SOURCE_MISSING_MARKER,
      pendingFields: pendingFieldsForMissing(),
      pendingFieldLabels: pendingFieldsForMissing().map(labelOfField),
      reasons: row.reasons || [],
    })),
  };
}

/** 判定标准：来源缺失率 = 缺失条数 ÷ 总条数，并给出内部/外部/人工覆盖分布。 */
async function getSourceStats({ q = null, evidenceType = null } = {}) {
  const scope = {
    q: typeof q === 'string' && q.trim() !== '' ? q.trim() : null,
    evidenceType: typeof evidenceType === 'string' && evidenceType.trim() !== '' ? evidenceType.trim() : null,
  };
  const row = await sourceRepo.stats(scope);
  const total = row.total_count;
  const missing = row.missing_count;

  // 0/0 语义：范围内没有证据时缺失率返回 null，避免被读成「无缺失」
  const missingRate = total === 0 ? null : Number((missing / total).toFixed(4));

  return {
    totalCount: total,
    missingCount: missing,
    missingRate,
    missingRateLabel: missingRate === null ? null : `${(missingRate * 100).toFixed(2)}%`,
    coverage: {
      internal: row.internal_count,
      external: row.external_count,
      manual: row.manual_count,
      missing,
    },
    // 判定标准 2/3 的计算结果：接口层与 DB 约束的双重保证在此可被直接核对
    criteria: {
      externalProviderNonEmpty: {
        scope: '外部来源记录的「提供方」字段非空',
        externalCount: row.external_count,
        providerNonEmptyCount: row.external_with_provider,
        satisfied: row.external_count === row.external_with_provider,
      },
      manualTraceNonEmpty: {
        scope: '人工录入来源的 录入人、录入时间 均非空',
        manualCount: row.manual_count,
        traceNonEmptyCount: row.manual_with_trace,
        satisfied: row.manual_count === row.manual_with_trace,
      },
    },
  };
}

module.exports = {
  listSourceCatalog,
  getEvidenceSource,
  annotateSource,
  listMissingSources,
  getSourceStats,
  serializeSourceDetail,
  serializeSourceSummary,
  validateSourceInput,
};
