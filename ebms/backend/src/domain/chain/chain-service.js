'use strict';

const chainRepo = require('./chain-repository');
const resultService = require('../results/result-service');
const { ownerModule } = require('../results/result-sources');
const { labelOf } = require('../evidence/evidence-types');
const {
  LAYERS,
  LAYER_COUNT,
  CONTRACT_INVENTORY,
  SOURCE_UNMARKED,
  BREAKPOINTS,
} = require('./layers');

/**
 * F5（PAND-83）四层链路读取用例：Result → Reason（归因）→ Evidence → Source。
 *
 * 设计要点：
 * · 一次请求返回整条链路，使 AC 的「≤4 次操作」「逐层返回位置一致」在**界面上**由导航状态机保证，
 *   而不是靠多次往返（往返会引入中途跳出上下文的可能）。
 * · 四层定义取自 layers.js（唯一口径），本文件不自行增删层级。
 * · 某段缺失一律返回断点（breakpoint）+ 补录入口，且 `blocked:false` —— 不阻断其余段查看。
 */

const SEVERITY_LABELS = { high: '高', medium: '中', low: '低' };
const DIRECTION_LABELS = { positive: '正向', negative: '负向', neutral: '中性' };

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sourceSystemLabel(code) {
  return ownerModule(code)?.label || code;
}

/**
 * 第 2 段的归因口径：或映射至 AEOS Exception（含 reason_code + severity），
 * 或显式标注为「M03 自有归因分析」（PAND-80 兜底口径）。
 * attribution_kind 是库内生成列，故不存在未归类的原因项。
 */
function serializeAttribution(row) {
  const isException = row.attribution_kind === 'exception';
  return {
    kind: row.attribution_kind,
    kindLabel: isException ? '映射至 Exception（归因）' : 'M03 自有归因分析',
    contractVersion: isException ? 'AEOS.Exception.V1' : null,
    reasonCode: row.reason_code,
    severity: row.severity,
    severityLabel: SEVERITY_LABELS[row.severity] || null,
    // 未映射到 Exception 的原因须显式标注其不属于任何专业维度
    ownedByProfessionalDomain: isException,
  };
}

function serializeReason(row) {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    direction: row.direction,
    directionLabel: DIRECTION_LABELS[row.direction] || row.direction,
    contributionPct: toNumber(row.contribution_pct),
    owner: row.owner,
    orderNo: row.order_no,
    evidenceCount: row.evidence_count,
    attribution: serializeAttribution(row),
    exceptionContract: row.attribution_kind === 'exception',
  };
}

/**
 * 第 4 段：来源。取值**只**来自 Evidence 的 source_system 字段。
 * 字段为空即「来源未标注」，并显式声明未回落到专业原始表（fallbackToRawTables: false）。
 */
function serializeSource(row) {
  const code = typeof row.source_system === 'string' && row.source_system.trim() !== '' ? row.source_system.trim() : null;
  if (!code) {
    return {
      marked: false,
      resolvedFrom: 'Evidence.source_system',
      sourceSystem: null,
      sourceSystemLabel: null,
      displayText: SOURCE_UNMARKED.label,
      fallbackToRawTables: SOURCE_UNMARKED.fallbackToRawTables,
    };
  }
  return {
    marked: true,
    resolvedFrom: 'Evidence.source_system',
    sourceSystem: code,
    sourceSystemLabel: sourceSystemLabel(code),
    displayText: sourceSystemLabel(code),
    fallbackToRawTables: false,
  };
}

function serializeEvidence(row) {
  return {
    id: row.id,
    reasonId: row.reason_id,
    type: row.type,
    typeLabel: labelOf(row.type),
    title: row.title,
    formedAt: row.formed_at,
    owner: row.owner,
    content: row.content,
    source: serializeSource(row),
  };
}

/**
 * 第 1 段：结果。复用 F1（PAND-79）的指标详情口径，保证「结果」这一段
 * 与经营结果指标集看到的是同一个值、同一份口径版本与同一组证据引用。
 */
function serializeResult(detail) {
  return {
    metricId: detail.id,
    code: detail.code,
    name: detail.name,
    unit: detail.unit,
    dimensionLabel: detail.dimensionLabel,
    periodType: detail.periodType,
    periodValue: detail.periodValue,
    dataCutoffAt: detail.dataCutoffAt,
    targetValue: detail.targetValue,
    actualValue: detail.actualValue,
    deviation: detail.deviation,
    hasData: detail.hasData,
    dataStatus: detail.dataStatus,
    noDataReason: detail.noDataReason,
    // Result 契约字段（无数据时 resultId 为 null：实际值只来自 Owner Result）
    contractVersion: detail.actual?.source?.contractVersion || 'AEOS.Result.V1',
    resultId: detail.traceability?.resultId || null,
    sourceSystem: detail.traceability?.sourceModule || null,
    sourceSystemLabel: detail.traceability?.sourceModule ? sourceSystemLabel(detail.traceability.sourceModule) : null,
    calculationVersion: detail.traceability?.calculationVersion || null,
    evidenceIds: detail.traceability?.evidenceIds || [],
    traceId: detail.actual?.source?.traceId || null,
    occurredAt: detail.actual?.source?.occurredAt || null,
  };
}

/**
 * 四段状态。某段缺失时给出断点与补录入口，并显式 `blocked:false`。
 * 断点不阻断导航：所有段始终出现在 segments 里，前端可照常逐层进入/返回。
 */
function buildSegments({ reasons, evidences }) {
  const hasReasons = reasons.length > 0;
  const hasEvidences = evidences.length > 0;
  const hasMarkedSource = evidences.some((e) => e.source.marked);

  const state = {
    result: { status: 'OK', breakpoint: null, itemCount: 1 },
    reason: hasReasons
      ? { status: 'OK', breakpoint: null, itemCount: reasons.length }
      : { status: 'MISSING', breakpoint: BREAKPOINTS.NO_ATTRIBUTION, itemCount: 0 },
    evidence: !hasReasons
      ? { status: 'MISSING', breakpoint: BREAKPOINTS.UPSTREAM_MISSING, itemCount: 0 }
      : hasEvidences
        ? { status: 'OK', breakpoint: null, itemCount: evidences.length }
        : { status: 'MISSING', breakpoint: BREAKPOINTS.NO_EVIDENCE, itemCount: 0 },
    source: !hasEvidences
      ? { status: 'MISSING', breakpoint: BREAKPOINTS.UPSTREAM_MISSING, itemCount: 0 }
      : hasMarkedSource
        ? { status: 'OK', breakpoint: null, itemCount: evidences.filter((e) => e.source.marked).length }
        : { status: 'MISSING', breakpoint: BREAKPOINTS.SOURCE_UNMARKED, itemCount: 0 },
  };

  return LAYERS.map((layer) => ({
    ...layer,
    ...state[layer.key],
    // 边界：断点只标注该段，不阻断其余段查看
    blocked: false,
  }));
}

/**
 * 读取一条完整链路的四段数据。
 * 从结果指标出发，结果段缺失即无链路可言 → 404；其余段的缺失均为断点，返回 200。
 */
async function getChain(metricId) {
  const detail = await resultService.getMetricDetail(metricId);

  const reasonRows = await chainRepo.listReasons(metricId);
  const reasons = reasonRows.map(serializeReason);
  const evidenceRows = await chainRepo.listEvidencesByReason(reasonRows.map((r) => r.id));
  const evidences = evidenceRows.map(serializeEvidence);

  const segments = buildSegments({ reasons, evidences });
  const sourceSegment = segments.find((s) => s.key === 'source');

  return {
    metricId,
    result: serializeResult(detail),
    reasons,
    evidences,
    // 四段定义随响应下发，前端面包屑与后端同源，不存在第二套层级口径
    layers: LAYERS,
    segmentCount: LAYER_COUNT,
    segments,
    // 判定标准：链路消费对象清点 = Result / Exception / Evidence + source_system 字段
    contractInventory: CONTRACT_INVENTORY,
    sourceContract: {
      field: 'Evidence.source_system',
      // 来源段是否可解析（某段缺失时给出断点，不回落专业原始表）
      status: sourceSegment.status,
      breakpoint: sourceSegment.breakpoint,
      fallbackToRawTables: SOURCE_UNMARKED.fallbackToRawTables,
    },
    // 从结果段进入来源段所需的层间下钻次数（固定四段 − 1 = 3，恒 ≤ 4）
    drillOpsToSource: LAYER_COUNT - 1,
  };
}

/** 链路入口清单：可穿透的结果指标（四层链路的起点必须是 Result）。 */
async function listAnchors({ periodType, periodValue } = {}) {
  const overview = await resultService.getOverview({ periodType, periodValue });
  return {
    period: overview.period,
    total: overview.items.length,
    items: overview.items.map((item) => ({
      metricId: item.id,
      code: item.code,
      name: item.name,
      unit: item.unit,
      hasData: item.hasData,
      dataStatus: item.dataStatus,
      noDataReason: item.noDataReason,
      actualValue: item.actualValue,
      targetValue: item.targetValue,
      deviation: item.deviation,
      resultId: item.traceability.resultId,
      sourceSystem: item.traceability.sourceModule,
    })),
  };
}

module.exports = { getChain, listAnchors, SEVERITY_LABELS, DIRECTION_LABELS };
