'use strict';

const { withTransaction } = require('../../db/pool');
const { badRequest, notFound } = require('../../http/errors');
const {
  OWNER_MODULES,
  OWNER_MODULE_CODES,
  TARGET_SOURCE_MODULE,
  PERIOD_TYPES,
  RESULT_STATUSES,
  OWNER_RESULT_CONTRACT,
  ownerModule,
} = require('./result-sources');
const resultRepo = require('./result-repository');
const ownerResultRepo = require('./owner-result-repository');
const evidenceRepo = require('../evidence/evidence-repository');
const { labelOf } = require('../evidence/evidence-types');
const auditRepo = require('../audit/audit-repository');

// ---------------------------------------------------------------- 口径常量

const DIMENSION_LABELS = { finance: '财务', business: '业务' };

/**
 * 「无数据」的三种成因。判定标准要求无数据时必须标明「来源模块未供给」——
 * 这里区分「未供给」与「未同步本期」，两者在界面上同为「无数据」，成因不同。
 */
const DATA_STATUS = {
  SUPPLIED: { label: '已供给', reason: null },
  NOT_SUPPLIED: { label: '无数据', reason: '来源模块未供给' },
  NOT_SYNCED: { label: '无数据', reason: '来源模块未同步本期数据' },
  NOT_DECLARED: { label: '无数据', reason: '未声明来源模块' },
};

const DEVIATION_FORMULA = '实际值 − 目标值';
const DEVIATION_PCT_FORMULA = '（实际值 − 目标值）÷ |目标值| × 100%';

function round(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function actorNameOf(actor) {
  return actor.displayName || actor.username || actor.id;
}

// ---------------------------------------------------------------- 序列化

/**
 * 实际值只可能来自 Owner Result：row.result_id 为空即「无数据」，绝不退化为 0 或空白。
 * 无数据时 actualValue 为 null，偏差一并不可计算。
 */
function resolveDataStatus(row) {
  if (!row.owner_module) return 'NOT_DECLARED';
  if (row.result_id) return 'SUPPLIED';
  return row.owner_has_supplied ? 'NOT_SYNCED' : 'NOT_SUPPLIED';
}

function buildDeviation(row, actualValue, targetValue) {
  const thresholdPct = toNumber(row.threshold_pct);
  const shape = {
    formula: DEVIATION_FORMULA,
    pctFormula: DEVIATION_PCT_FORMULA,
    direction: row.direction,
    thresholdPct,
  };

  if (actualValue === null || targetValue === null) {
    return {
      ...shape,
      computable: false,
      value: null,
      pct: null,
      exceeded: null,
      attainment: null,
      reason: targetValue === null ? '目标值缺失，无法计算偏差' : '实际值无数据，无法计算偏差',
    };
  }

  const value = round(actualValue - targetValue, 2);
  // 目标值为 0 时偏差率无定义（分母为 0），只给绝对偏差
  const pct = targetValue === 0 ? null : round(((actualValue - targetValue) / Math.abs(targetValue)) * 100, 2);
  const attained = row.direction === 'lower_better' ? actualValue <= targetValue : actualValue >= targetValue;

  return {
    ...shape,
    computable: true,
    value,
    pct,
    exceeded: pct === null ? null : Math.abs(pct) > thresholdPct,
    attainment: attained ? 'ACHIEVED' : 'MISSED',
    reason: null,
  };
}

function serializeMetric(row, evidenceById) {
  const dataStatus = resolveDataStatus(row);
  const hasData = dataStatus === 'SUPPLIED';
  const targetValue = toNumber(row.target_value);
  const actualValue = hasData ? toNumber(row.result_value) : null;
  const evidenceIds = Array.isArray(row.result_evidence_ids) ? row.result_evidence_ids : [];
  const owner = ownerModule(row.owner_module);
  const deviation = buildDeviation(row, actualValue, targetValue);

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    dimension: row.dimension,
    dimensionLabel: DIMENSION_LABELS[row.dimension] || row.dimension,
    periodType: row.period_type,
    periodValue: row.period_value,
    // 数据截止时间：每条指标都必须有，前端逐条展示
    dataCutoffAt: row.as_of,
    unit: row.unit,
    // 归属声明：该指标实际值的 Owner 模块
    owner: owner ? { module: owner.code, label: owner.label, scope: owner.scope } : null,
    target: {
      value: targetValue,
      unit: row.unit,
      direction: row.direction,
      source: { module: row.target_source_module, ref: row.target_source_ref },
    },
    actual: hasData
      ? {
          value: actualValue,
          unit: row.result_unit || row.unit,
          source: {
            module: row.result_source_system,
            resultId: row.result_id,
            contractVersion: row.result_contract_version,
            objectType: row.result_object_type,
            objectId: row.result_object_id,
            calculationVersion: row.calculation_version,
            status: row.result_status,
            occurredAt: row.result_occurred_at,
            traceId: row.result_trace_id,
          },
          evidenceIds,
        }
      : null,
    targetValue,
    actualValue,
    deviation,
    dataStatus,
    dataStatusLabel: DATA_STATUS[dataStatus].label,
    noDataReason: DATA_STATUS[dataStatus].reason,
    hasData,
    exceeded: deviation.exceeded,
    attainment: deviation.attainment,
    // 场景 4：计算口径版本 + 证据引用（可直接定位到证据）
    traceability: {
      resultId: hasData ? row.result_id : null,
      sourceModule: hasData ? row.result_source_system : row.owner_module || null,
      calculationVersion: hasData ? row.calculation_version : null,
      evidenceIds,
      evidence: evidenceIds.map((id) => serializeEvidenceRef(id, evidenceById.get(String(id)))),
      // 红线核对：是否「Owner Result 标识 + calculation_version + evidence_ids」无缺项
      complete: hasData ? Boolean(row.result_id && row.calculation_version && evidenceIds.length > 0) : null,
    },
  };
}

/**
 * 由 evidence_ids 定位证据。未在本系统登记的来源证据显式标注（resolved=false），不静默丢弃，
 * 使「证据引用」与「可查看证据」之间的落差始终可见。
 */
function serializeEvidenceRef(id, row) {
  if (!row) {
    return { id: String(id), resolved: false, type: null, typeLabel: null, title: '来源证据未在本系统登记', formedAt: null, owner: null, viewPath: null };
  }
  return {
    id: row.id,
    resolved: true,
    type: row.type,
    typeLabel: labelOf(row.type),
    title: row.title,
    formedAt: row.formed_at,
    owner: row.owner,
    viewPath: `#/evidence/${row.id}`,
  };
}

function serializeOwnerResult(row) {
  return {
    id: row.id,
    resultId: row.result_id,
    contractVersion: row.contract_version,
    sourceSystem: row.source_system,
    sourceLabel: ownerModule(row.source_system)?.label || row.source_system,
    objectType: row.object_type,
    objectId: row.object_id,
    metricCode: row.metric_code,
    metricName: row.metric_name,
    value: toNumber(row.value),
    unit: row.unit,
    periodType: row.period_type,
    periodValue: row.period_value,
    calculationVersion: row.calculation_version,
    evidenceIds: Array.isArray(row.evidence_ids) ? row.evidence_ids : [],
    status: row.status,
    occurredAt: row.occurred_at,
    traceId: row.trace_id,
    receivedBy: row.received_by,
    receivedAt: row.received_at,
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
    after: row.after,
  };
}

// ---------------------------------------------------------------- 用例：读取

async function resolvePeriod(periodType, periodValue) {
  const hasType = periodType !== undefined && periodType !== null && periodType !== '';
  const hasValue = periodValue !== undefined && periodValue !== null && periodValue !== '';

  if (hasType && hasValue) {
    if (!PERIOD_TYPES.includes(periodType)) {
      throw badRequest('RESULT_PERIOD_TYPE_INVALID', '数据周期取值不合法', {
        fields: { periodType: '数据周期只能是 day / week / month' },
        received: periodType,
        allowed: PERIOD_TYPES,
      });
    }
    return { periodType, periodValue: String(periodValue) };
  }

  if (hasType || hasValue) {
    throw badRequest('RESULT_PERIOD_INCOMPLETE', '数据周期必须同时给出 period_type 与 period_value');
  }

  // 未指定周期时落到已配置的最新周期，使决策者登录即可看到指标集
  const latest = await resultRepo.findLatestPeriod();
  return latest ? { periodType: latest.period_type, periodValue: latest.period_value } : { periodType: null, periodValue: null };
}

async function loadEvidenceMap(rows) {
  const ids = [...new Set(rows.flatMap((r) => (Array.isArray(r.result_evidence_ids) ? r.result_evidence_ids : [])))];
  const evidences = await evidenceRepo.listByIds(ids);
  return new Map(evidences.map((e) => [e.id, e]));
}

/**
 * 场景 1~3 + 边界：指标集总览。条目数与「配置的指标集条目数」一致——
 * 无数据的条目同样占位（不会因为没数据就从指标集里消失）。
 */
async function getOverview({ periodType, periodValue } = {}) {
  const period = await resolvePeriod(periodType, periodValue);
  if (period.periodType === null) {
    return {
      period: { periodType: null, periodValue: null },
      configuredCount: 0,
      suppliedCount: 0,
      noDataCount: 0,
      traceableCount: 0,
      allTraceable: false,
      items: [],
    };
  }

  const rows = await resultRepo.listConfigured(period.periodType, period.periodValue);
  const evidenceById = await loadEvidenceMap(rows);
  const items = rows.map((row) => serializeMetric(row, evidenceById));
  const supplied = items.filter((item) => item.hasData);

  return {
    period,
    // 配置的指标集条目数（= 配置的指标集条目数，判定标准以此为基准）
    configuredCount: items.length,
    suppliedCount: supplied.length,
    noDataCount: items.length - supplied.length,
    traceableCount: supplied.filter((item) => item.traceability.complete).length,
    allTraceable: supplied.length > 0 && supplied.every((item) => item.traceability.complete),
    items,
  };
}

/** 场景 4：单指标详情 —— 口径版本与证据引用可逐条查看并定位到证据。 */
async function getMetricDetail(metricId) {
  const row = await resultRepo.findById(metricId);
  if (!row) {
    throw notFound('RESULT_METRIC_NOT_FOUND', `指标不存在：${metricId}`);
  }
  const evidenceById = await loadEvidenceMap([row]);
  const metric = serializeMetric(row, evidenceById);

  return {
    ...metric,
    ownerResult: metric.actual ? metric.actual.source : null,
    // 目标值同样可追溯（M03 Management Goal）
    targetTrace: {
      module: row.target_source_module,
      ref: row.target_source_ref,
      value: toNumber(row.target_value),
      unit: row.unit,
      direction: row.direction,
    },
  };
}

/** 来源声明口径（逐指标核对来源声明时的唯一取值来源）。 */
function listSourceModules() {
  return {
    contractVersion: OWNER_RESULT_CONTRACT.version,
    targetSourceModule: TARGET_SOURCE_MODULE,
    ownerModules: OWNER_MODULES,
    contractFields: OWNER_RESULT_CONTRACT.requiredFields,
    periodTypes: PERIOD_TYPES,
    resultStatuses: RESULT_STATUSES,
  };
}

/** 核对/抽查用：已登记的 Owner Result 清单。 */
async function listOwnerResults({ metricCode = null, sourceSystem = null, limit = 100 } = {}) {
  if (sourceSystem && !OWNER_MODULE_CODES.includes(sourceSystem)) {
    throw badRequest('OWNER_RESULT_SOURCE_INVALID', '来源模块不在 Owner 模块白名单内', {
      fields: { sourceSystem: '来源模块必须是 M05 / M06 / M09' },
      received: sourceSystem,
      allowed: OWNER_MODULE_CODES,
    });
  }
  const rows = await ownerResultRepo.list({
    metricCode: metricCode || null,
    sourceSystem: sourceSystem || null,
    limit: Math.min(Number(limit) || 100, 500),
  });
  return { total: rows.length, items: rows.map(serializeOwnerResult) };
}

// ---------------------------------------------------------------- 用例：登记 Owner Result

function validateOwnerResultInput(input) {
  const fields = {};
  const payload = {};

  const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

  payload.resultId = text(input.resultId);
  if (!payload.resultId) fields.resultId = 'Owner Result 标识（resultId）不能为空';

  if (!OWNER_MODULE_CODES.includes(input.sourceSystem)) {
    fields.sourceSystem = '来源模块不在 Owner 模块白名单内（只能是 M05 / M06 / M09）';
  } else {
    payload.sourceSystem = input.sourceSystem;
  }

  payload.objectType = text(input.objectType) || 'BusinessMetric';
  payload.objectId = text(input.objectId);
  if (!payload.objectId) fields.objectId = '契约 object_id 不能为空';

  payload.metricCode = text(input.metricCode);
  if (!payload.metricCode) fields.metricCode = '指标编码（metricCode）不能为空';

  payload.metricName = text(input.metricName);
  payload.unit = text(input.unit);

  const value = toNumber(input.value);
  if (value === null) fields.value = '指标值必须是有效数字';
  else payload.value = value;

  if (!PERIOD_TYPES.includes(input.periodType)) {
    fields.periodType = '数据周期只能是 day / week / month';
  } else {
    payload.periodType = input.periodType;
  }

  payload.periodValue = text(input.periodValue);
  if (!payload.periodValue) fields.periodValue = '数据周期取值（periodValue）不能为空';

  payload.calculationVersion = text(input.calculationVersion);
  if (!payload.calculationVersion) {
    fields.calculationVersion = '口径版本（calculationVersion）不能为空：专业指标必须记录口径版本';
  }

  // 证据引用为可追溯性的硬要求：无证据引用的实际值不接受登记
  const evidenceIds = Array.isArray(input.evidenceIds)
    ? input.evidenceIds.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
    : null;
  if (!evidenceIds || evidenceIds.length === 0) {
    fields.evidenceIds = '证据引用（evidenceIds）必须至少含 1 个证据标识';
  } else {
    payload.evidenceIds = evidenceIds;
  }

  if (!RESULT_STATUSES.includes(input.status)) {
    fields.status = '结果状态只能是 VERIFIED / DRAFT / REJECTED';
  } else {
    payload.status = input.status;
  }

  if (input.occurredAt === undefined || input.occurredAt === null || input.occurredAt === '') {
    fields.occurredAt = '口径截止时间（occurredAt）不能为空';
  } else {
    const parsed = new Date(input.occurredAt);
    if (Number.isNaN(parsed.getTime())) fields.occurredAt = '口径截止时间不是合法的日期时间';
    else payload.occurredAt = parsed.toISOString();
  }

  payload.traceId = text(input.traceId);
  if (!payload.traceId) fields.traceId = 'trace_id 不能为空（缺少则无法跨系统追踪）';

  if (Object.keys(fields).length === 0) {
    payload.contractVersion = text(input.contractVersion) || OWNER_RESULT_CONTRACT.version;
    return payload;
  }

  const details = { fields };
  if (fields.sourceSystem) details.allowedSourceSystems = OWNER_MODULE_CODES;
  if (fields.periodType) details.allowedPeriodTypes = PERIOD_TYPES;
  if (fields.status) details.allowedStatuses = RESULT_STATUSES;

  const codes = {
    resultId: 'OWNER_RESULT_ID_REQUIRED',
    sourceSystem: 'OWNER_RESULT_SOURCE_INVALID',
    objectId: 'OWNER_RESULT_OBJECT_ID_REQUIRED',
    metricCode: 'OWNER_RESULT_METRIC_CODE_REQUIRED',
    value: 'OWNER_RESULT_VALUE_INVALID',
    periodType: 'OWNER_RESULT_PERIOD_TYPE_INVALID',
    periodValue: 'OWNER_RESULT_PERIOD_VALUE_REQUIRED',
    calculationVersion: 'OWNER_RESULT_CALCULATION_VERSION_REQUIRED',
    evidenceIds: 'OWNER_RESULT_EVIDENCE_IDS_REQUIRED',
    status: 'OWNER_RESULT_STATUS_INVALID',
    occurredAt:
      input.occurredAt === undefined || input.occurredAt === null || input.occurredAt === ''
        ? 'OWNER_RESULT_OCCURRED_AT_REQUIRED'
        : 'OWNER_RESULT_OCCURRED_AT_INVALID',
    traceId: 'OWNER_RESULT_TRACE_ID_REQUIRED',
  };

  const [field] = Object.keys(fields);
  throw badRequest(codes[field], fields[field], details);
}

/**
 * 登记一条 Owner Result（实际值进入 EBMS 的唯一通道）。写入 + 留痕同事务。
 * 同一 result_id 重复投递幂等：不重复入库，也不重复留痕。
 */
async function receiveOwnerResult(actor, input) {
  const payload = { ...validateOwnerResultInput(input || {}), receivedBy: actor.id };

  const created = await withTransaction(async (client) => {
    const row = await ownerResultRepo.insert(client, payload);
    if (!row) return null;

    const audit = await auditRepo.record(client, {
      actor: actor.id,
      actorName: actorNameOf(actor),
      action: 'owner_result.receive',
      entityType: 'owner_result',
      entityId: row.id,
      after: {
        resultId: row.result_id,
        sourceSystem: row.source_system,
        metricCode: row.metric_code,
        value: toNumber(row.value),
        periodType: row.period_type,
        periodValue: row.period_value,
        calculationVersion: row.calculation_version,
        evidenceIds: row.evidence_ids,
      },
    });

    return { row, audit };
  });

  if (!created) {
    const existing = await ownerResultRepo.findByResultId(payload.resultId);
    return { changed: false, alreadyReceived: true, result: serializeOwnerResult(existing), audit: null };
  }

  return { changed: true, alreadyReceived: false, result: serializeOwnerResult(created.row), audit: serializeAudit(created.audit) };
}

module.exports = {
  getOverview,
  getMetricDetail,
  listSourceModules,
  listOwnerResults,
  receiveOwnerResult,
  serializeMetric,
  DATA_STATUS,
};
