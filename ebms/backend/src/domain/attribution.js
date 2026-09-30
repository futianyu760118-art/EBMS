/**
 * F2 归因穿透领域逻辑（PAND-80）。
 *
 * 口径（2026-09-26 P0 边界重核 PAND-96 / PAND-97 修订后）：
 *   - 原因项以 AEOS **Exception（归因）** 契约承载，每条至少含 reason_code 与 severity；
 *   - 无法映射到 Exception 的纯人工判断型原因，显式定义为 **M03 自有归因分析**；
 *   - **影响方向与贡献占比** 归 M03 归因元数据，基于消费到的专业 Result 判断得出，
 *     M03 不新建专业事实源、不重算专业指标；
 *   - 归因所依据的专业事实一律消费专业模块 Result（`result_metrics` 携带
 *     `source_system` + `calculation_version`）。
 *
 * 本模块为纯函数：不触库、不写库。多级展开的深度由归因关系（`parent_id` 链）决定，
 * 默认不受导航层级限制 —— 这是「展开深度不因导航层级而截断」的结构性保证。
 */

import {
  DIRECTIONS,
  M03_ANALYSIS_LABEL,
  SEVERITIES,
  describeAttributionKind,
  navigationSegment,
} from './chain.js';

export const DIRECTION_LABELS = Object.freeze({
  positive: '正向',
  negative: '负向',
  neutral: '中性',
});

export const SEVERITY_LABELS = Object.freeze({
  high: '高',
  medium: '中',
  low: '低',
});

/** 影响方向取值域（AC 判定标准：仅限 正向 / 负向 / 中性 三者之一）。 */
export const ALLOWED_DIRECTIONS = DIRECTIONS;

/** 贡献占比合计的判定容差：|合计 − 100| ≤ 1 视为完全归因（AC：四舍五入误差 ≤ 1%）。 */
export const CONTRIBUTION_TOLERANCE_PCT = 1;

export const ATTRIBUTION_STATUS = Object.freeze({
  FULLY: 'FULLY_ATTRIBUTED',
  PARTIAL: 'PARTIALLY_ATTRIBUTED',
  UNATTRIBUTED: 'UNATTRIBUTED',
});

export const ATTRIBUTION_STATUS_LABELS = Object.freeze({
  FULLY_ATTRIBUTED: '完全归因',
  PARTIALLY_ATTRIBUTED: '部分归因',
  UNATTRIBUTED: '未归因',
});

/** 未归因空态：必须给出「关联入口」，且明确不回落到专业原始表。 */
export const UNATTRIBUTED_EMPTY = Object.freeze({
  CODE: 'UNATTRIBUTED',
  TITLE: '未归因',
  MESSAGE: '该结果指标当前没有任何关联原因项。',
  HINT: '请通过下方关联入口登记原因项；系统不回落到专业原始表查询。',
});

/**
 * 兜底口径（AC 边界）：原因项缺少 `reason_code` 或 `severity` 时，
 * 按「M03 自有归因分析」处理并标注 —— 不得留下无归属字段的原因项。
 */
export const FALLBACK_REASONS = Object.freeze({
  NO_EXCEPTION_REF: {
    code: 'NO_EXCEPTION_REF',
    message: '未引用已消费的 Exception，按 M03 自有归因分析登记',
  },
  EXCEPTION_NOT_FOUND: {
    code: 'EXCEPTION_NOT_FOUND',
    message: '引用的 Exception 不在本系统已消费范围内，按 M03 自有归因分析登记',
  },
  MISSING_REASON_CODE: {
    code: 'MISSING_REASON_CODE',
    message: '缺少 reason_code，按 M03 自有归因分析登记',
  },
  MISSING_SEVERITY: {
    code: 'MISSING_SEVERITY',
    message: '缺少 severity，按 M03 自有归因分析登记',
  },
});

/** 幂等/可读 id：由指标 + 名称派生，避免调用方填主键。 */
export function attributionIdFor(metricId, name) {
  const slug = String(name ?? '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w一-龥-]/g, '')
    .slice(0, 40);
  return `A-${metricId}-${slug || 'NEW'}`;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * 归因状态与贡献占比合计。
 *
 * 合计口径：仅**顶层**原因项计入合计，子项是对父项的细分（多级展开不重复计入）。
 */
export function summarizeAttribution(attributions) {
  const roots = attributions.filter((item) => item.parentId === null || item.parentId === undefined);
  const rootsWithPct = roots.filter(
    (item) => typeof item.contributionPct === 'number' && Number.isFinite(item.contributionPct),
  );
  const total = round2(rootsWithPct.reduce((sum, item) => sum + item.contributionPct, 0));
  const complete = roots.length > 0 && rootsWithPct.length === roots.length;
  const withinTolerance = complete && Math.abs(total - 100) <= CONTRIBUTION_TOLERANCE_PCT;

  let status = ATTRIBUTION_STATUS.FULLY;
  if (roots.length === 0) {
    status = ATTRIBUTION_STATUS.UNATTRIBUTED;
  } else if (!withinTolerance) {
    status = ATTRIBUTION_STATUS.PARTIAL;
  }

  return {
    status,
    statusLabel: ATTRIBUTION_STATUS_LABELS[status],
    reasonCount: attributions.length,
    rootCount: roots.length,
    childCount: attributions.length - roots.length,
    // 顶层合计（子项不重复计入）
    rootContributionPct: total,
    rootsWithContributionPct: rootsWithPct.length,
    rootsWithoutContributionPct: roots.length - rootsWithPct.length,
    tolerancePct: CONTRIBUTION_TOLERANCE_PCT,
    sumsTo100: complete && total === 100,
    sumsTo100WithinTolerance: withinTolerance,
    fullyAttributed: status === ATTRIBUTION_STATUS.FULLY,
  };
}

/** 影响方向合规校验：返回不在取值域内的取值（AC 判定标准）。 */
export function unsupportedDirections(values) {
  const allowed = new Set(ALLOWED_DIRECTIONS);
  return [...new Set(values)].filter((value) => !allowed.has(value));
}

/** 归因关系决定的层深（0 = 顶层），与导航层级无关。 */
export function depthOf(attribution, byId, seen = new Set()) {
  if (!attribution.parentId || seen.has(attribution.id)) return 0;
  seen.add(attribution.id);
  const parent = byId.get(attribution.parentId);
  if (!parent) return 0;
  return 1 + depthOf(parent, byId, seen);
}

/** 断裂的父引用（父项不在同一结果指标的归因集合内）。 */
export function orphanParentIds(attributions) {
  const ids = new Set(attributions.map((item) => item.id));
  return attributions
    .filter((item) => item.parentId && !ids.has(item.parentId))
    .map((item) => item.id);
}

/**
 * 原因项展示模型（AC 场景 1 / 场景 4）。
 *
 * 每条含：原因名称（reason_code 或 M03 分析名）、严重度、影响方向、
 * 影响量或贡献占比、责任方，以及类型判定结果。
 */
export function normalizeReasonNode(attribution, byId, { evidenceCount = null } = {}) {
  const kind = describeAttributionKind(attribution);
  const usesException = kind.kind === 'exception';
  const hasPct = typeof attribution.contributionPct === 'number' && Number.isFinite(attribution.contributionPct);
  const hasImpact = typeof attribution.impactValue === 'number' && Number.isFinite(attribution.impactValue);

  return {
    attributionId: attribution.id,
    metricId: attribution.metricId,
    parentId: attribution.parentId ?? null,
    depth: depthOf(attribution, byId),
    // 原因名称：映射至 Exception 取 reason_code；M03 自有归因分析取分析名
    name: usesException ? kind.reasonCode : attribution.analysisName,
    kind: kind.kind,
    kindLabel: usesException ? `映射至 Exception（${kind.reasonCode}）` : M03_ANALYSIS_LABEL,
    reasonCode: kind.reasonCode,
    severity: kind.severity,
    severityLabel: kind.severity ? (SEVERITY_LABELS[kind.severity] ?? kind.severity) : null,
    direction: attribution.direction,
    directionLabel: DIRECTION_LABELS[attribution.direction] ?? attribution.direction,
    contributionPct: hasPct ? attribution.contributionPct : null,
    impactValue: hasImpact ? attribution.impactValue : null,
    // 「影响量或贡献占比」至少一项（库层 CHECK 兜底）
    impactDisplay: hasPct
      ? { basis: 'contribution_pct', label: '贡献占比', text: `${attribution.contributionPct}%` }
      : hasImpact
        ? { basis: 'impact_value', label: '影响量', text: String(attribution.impactValue) }
        : null,
    owner: attribution.owner,
    evidenceCount,
    forwardTarget: {
      ...navigationSegment('reason'),
      view: 'forward',
      path: `#/trace/forward/reason/${attribution.metricId}/${attribution.id}`,
      params: { metricId: attribution.metricId, attributionId: attribution.id },
    },
  };
}

/**
 * 多级归因树。深度由 `parent_id` 链决定，默认不设上限
 * （`maxDepth` 仅用于显式收窄到「最多展示几层」，不设为导航层级）。
 */
export function buildReasonTree(attributions, { maxDepth = Infinity } = {}) {
  const byId = new Map(attributions.map((item) => [item.id, item]));
  const nodes = new Map(
    attributions.map((item) => [
      item.id,
      { ...normalizeReasonNode(item, byId), children: [] },
    ]),
  );
  const roots = [];
  for (const item of attributions) {
    const node = nodes.get(item.id);
    const parent = item.parentId ? nodes.get(item.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  if (Number.isFinite(maxDepth)) {
    // 展示层数上限：level 从 0 起，故 level + 1 为该节点所在层。
    const prune = (list, level) => {
      for (const node of list) {
        node.truncated = false;
        if (level + 1 >= maxDepth && node.children.length > 0) {
          node.truncated = true;
          node.children = [];
        } else {
          prune(node.children, level + 1);
        }
      }
    };
    prune(roots, 0);
  }
  return {
    roots,
    maxDepthReached: attributions.length === 0
      ? 0
      : Math.max(...attributions.map((item) => depthOf(item, byId))) + 1,
    unbounded: !Number.isFinite(maxDepth),
  };
}

/** 扁平化树（深度优先），供列表渲染与判定统计复用。 */
export function flattenTree(roots) {
  const out = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      out.push(node);
      walk(node.children ?? []);
    }
  };
  walk(roots);
  return out;
}

/** 类型判定结果（AC 场景 4）：映射至 Exception，还是 M03 自有归因分析。 */
export function describeTypeVerdict(attribution) {
  const kind = describeAttributionKind(attribution);
  if (kind.kind === 'exception') {
    return {
      attributionId: attribution.id,
      verdict: 'MAPPED_TO_EXCEPTION',
      verdictLabel: '映射至 Exception',
      isException: true,
      exceptionId: attribution.exceptionId ?? null,
      exceptionCode: attribution.exceptionCode ?? null,
      reasonCode: kind.reasonCode,
      severity: kind.severity,
      // 判定依据：Exception 契约的必填字段齐备
      basis:
        kind.reasonCode && kind.severity
          ? 'Exception 契约必填字段齐备（reason_code + severity）'
          : 'Exception 字段不齐备，应改判为 M03 自有归因分析',
      belongsToProfessionalDimension: true,
    };
  }
  return {
    attributionId: attribution.id,
    verdict: 'M03_OWN_ANALYSIS',
    verdictLabel: M03_ANALYSIS_LABEL,
    isException: false,
    exceptionId: null,
    exceptionCode: null,
    reasonCode: null,
    severity: null,
    analysisName: attribution.analysisName ?? null,
    basis: '纯人工判断型原因，不映射专业 Exception',
    // 兜底口径：显式标注其不属于任何专业维度
    belongsToProfessionalDimension: false,
    notBelongingNote: '不属于任何专业维度（纯人工判断，非专业事实源）',
  };
}

/**
 * 写入侧兜底分类（AC 边界）：把原因项输入判为
 * 「映射至 Exception」或「M03 自有归因分析」。
 *
 * 只有引用到本系统**已消费**的 Exception（含 reason_code + severity）时才判为 exception；
 * 其余情形（未引用 / 引用不到 / 缺少 reason_code 或 severity）一律落到
 * M03 自有归因分析并带回 `fallback` 标注 —— 不留无归属字段的原因项。
 *
 * @param {{ name?: string, exceptionRef?: string, direction: string,
 *           contributionPct?: number, impactValue?: number, owner: string }} input
 * @param {{ findException: (ref: string) => object | null }} deps
 */
export function classifyReasonInput(input, { findException }) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const ref = typeof input.exceptionRef === 'string' ? input.exceptionRef.trim() : '';
  const exception = ref ? findException(ref) : null;
  const analysisName = name || ref || '未命名原因';

  if (!exception) {
    const fallback = !ref
      ? FALLBACK_REASONS.NO_EXCEPTION_REF
      : FALLBACK_REASONS.EXCEPTION_NOT_FOUND;
    return {
      kind: 'm03_analysis',
      exceptionId: null,
      analysisName,
      fallback,
    };
  }
  if (!exception.reasonCode) {
    return { kind: 'm03_analysis', exceptionId: null, analysisName, fallback: FALLBACK_REASONS.MISSING_REASON_CODE };
  }
  if (!exception.severity) {
    return { kind: 'm03_analysis', exceptionId: null, analysisName, fallback: FALLBACK_REASONS.MISSING_SEVERITY };
  }
  return {
    kind: 'exception',
    exceptionId: exception.id,
    analysisName: null,
    fallback: null,
  };
}

/** 未归因空态：提供关联入口，不返回空列表、不回落专业原始表。 */
export function buildUnattributedState({ metric, reasonCount = 0 }) {
  return {
    status: ATTRIBUTION_STATUS.UNATTRIBUTED,
    statusLabel: ATTRIBUTION_STATUS_LABELS[ATTRIBUTION_STATUS.UNATTRIBUTED],
    empty: {
      code: UNATTRIBUTED_EMPTY.CODE,
      title: UNATTRIBUTED_EMPTY.TITLE,
      message: UNATTRIBUTED_EMPTY.MESSAGE,
      hint: UNATTRIBUTED_EMPTY.HINT,
    },
    // 关联入口：必须可操作，而不是一个死链
    linkEntry: {
      label: '关联原因',
      method: 'POST',
      path: `/api/v1/results/${metric.id}/reasons`,
      accepts: ['exceptionRef', 'name', 'direction', 'contributionPct', 'impactValue', 'owner'],
    },
    reasonCount,
    attributionStatus: ATTRIBUTION_STATUS.UNATTRIBUTED,
    directions: ALLOWED_DIRECTIONS.map((value) => ({ value, label: DIRECTION_LABELS[value] })),
    severities: SEVERITIES.map((value) => ({ value, label: SEVERITY_LABELS[value] })),
  };
}
