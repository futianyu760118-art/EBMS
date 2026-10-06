/**
 * F2 应用层：从结果指标的偏差穿透到原因项（PAND-80）。
 *
 * 编排：routes → 本服务 → repositories（读走 chainRepository，写走 attributionRepository）。
 * 归因所依据的专业事实一律来自 `result_metrics`（专业模块 Owner 供给的 Result 契约），
 * 本模块不重算专业指标、不新建专业事实源。
 */

import {
  ALLOWED_DIRECTIONS,
  ATTRIBUTION_STATUS,
  CONTRIBUTION_TOLERANCE_PCT,
  DIRECTION_LABELS,
  SEVERITY_LABELS,
  attributionIdFor,
  buildReasonTree,
  buildUnattributedState,
  classifyReasonInput,
  describeTypeVerdict,
  flattenTree,
  normalizeReasonNode,
  orphanParentIds,
  summarizeAttribution,
  unsupportedDirections,
} from '../domain/attribution.js';
import { SEVERITIES, navigationSegment } from '../domain/chain.js';
import { HttpError } from '../domain/httpError.js';
import { forwardTargetFor } from '../domain/reverseQuery.js';

export const DEFAULT_FACT_SAMPLE = 10;

/** 归因「影响因素」的取值域（判定标准：仅限 正向 / 负向 / 中性）。 */
const DIRECTION_OPTIONS = ALLOWED_DIRECTIONS.map((value) => ({
  value,
  label: DIRECTION_LABELS[value],
}));

const SEVERITY_OPTIONS = SEVERITIES.map((value) => ({
  value,
  label: SEVERITY_LABELS[value],
}));

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function resolveMetric(repo, metricRef) {
  const metric = repo.getMetric(metricRef) ?? repo.getMetricByCode(metricRef);
  if (!metric) {
    throw HttpError.notFound('METRIC_NOT_FOUND', `未找到结果指标: ${metricRef}`);
  }
  return metric;
}

/**
 * 偏差上下文。实际值来自专业模块 Owner 的 Result（EBMS 只消费），
 * 目标值来自 M03 管理目标；偏差 = 实际值 − 目标值，由 M03 做比较展示，
 * **不是**对专业指标的重算。
 */
function deviationOf(metric) {
  const hasActual = typeof metric.actual === 'number' && Number.isFinite(metric.actual);
  const hasTarget = typeof metric.target === 'number' && Number.isFinite(metric.target);
  const deviation = hasActual && hasTarget ? round2(metric.actual - metric.target) : null;
  return {
    target: hasTarget ? metric.target : null,
    actual: hasActual ? metric.actual : null,
    unit: metric.unit,
    deviation,
    deviationPct:
      deviation === null || metric.target === 0 ? null : round2((deviation / metric.target) * 100),
    hasDeviation: deviation !== null,
    formula: 'deviation = actual(Owner Result) − target(M03 Management Goal)',
  };
}

/** 归因所消费的专业 Result 声明（判定标准：可溯源、无 EBMS 自建事实源）。 */
function consumptionOf(metric) {
  return {
    contract: 'AEOS.Result.V1',
    resultId: metric.resultId,
    sourceSystem: metric.sourceSystem,
    calculationVersion: metric.calculationVersion,
    occurredAt: metric.occurredAt,
    ownedByEbms: metric.sourceSystem === 'M03',
    note:
      '归因所依据的专业事实一律消费专业模块 Result；EBMS 不重算专业指标、不自建专业事实源。',
  };
}

/**
 * 主入口（AC 场景 1）：从任一结果指标的偏差穿透到原因项。
 *
 * @param {string} metricRef 指标主键或指标 code
 * @param {{ maxDepth?: number }} [options] maxDepth 仅用于显式收窄，默认按归因关系展开
 */
export function createAttributionService({ chainRepository, attributionRepository }) {
  const read = chainRepository;
  const write = attributionRepository;

  function buildResultHeader(metric) {
    return {
      metricId: metric.id,
      resultId: metric.resultId,
      code: metric.code,
      name: metric.name,
      sourceSystem: metric.sourceSystem,
      objectType: metric.objectType,
      objectId: metric.objectId,
      periodType: metric.periodType,
      periodValue: metric.periodValue,
      unit: metric.unit,
      calculationVersion: metric.calculationVersion,
      status: metric.status,
      occurredAt: metric.occurredAt,
      forwardTarget: forwardTargetFor({ segmentKey: 'result', metricId: metric.id }),
    };
  }

  function integrityOf(attributions) {
    const unsupported = unsupportedDirections(attributions.map((item) => item.direction));
    const withoutImpact = attributions
      .filter(
        (item) =>
          !(typeof item.contributionPct === 'number' && Number.isFinite(item.contributionPct)) &&
          !(typeof item.impactValue === 'number' && Number.isFinite(item.impactValue)),
      )
      .map((item) => item.id);
    return {
      // 判定标准：影响方向取值仅限三者之一
      directionViolations: unsupported,
      directionCompliant: unsupported.length === 0,
      allowedDirections: DIRECTION_OPTIONS,
      // 每条原因项须有「影响量或贡献占比」至少一项
      missingImpactBasis: withoutImpact,
      impactBasisCompliant: withoutImpact.length === 0,
      orphanParentIds: orphanParentIds(attributions),
      // 归因层不因导航层级截断：展开深度由归因关系决定
      depthPolicy: 'depth determined by attribution relation (parent_id), not by navigation level',
    };
  }

  /**
   * AC 场景 1：指标 → 原因列表。
   * AC 边界：无关联原因时给出「未归因」空态与关联入口，不返回空列表。
   */
  function reasonsForMetric(metricRef, { maxDepth = Infinity } = {}) {
    const metric = resolveMetric(read, metricRef);
    const attributions = read.listAttributionsByMetric(metric.id);
    const summary = summarizeAttribution(attributions);

    const base = {
      result: buildResultHeader(metric),
      deviation: deviationOf(metric),
      consumption: consumptionOf(metric),
      chain: {
        navigation: [navigationSegment('result'), navigationSegment('reason')].map((segment) => ({
          ...segment,
        })),
        current: 'reason',
        reasonContract: 'Exception',
        reasonContractNote:
          '原因项以 AEOS Exception（归因）契约承载（reason_code / severity）；纯人工判断型原因标记为 M03 自有归因分析。',
      },
      directions: DIRECTION_OPTIONS,
      severities: SEVERITY_OPTIONS,
      tolerancePct: CONTRIBUTION_TOLERANCE_PCT,
      readOnly: true,
    };

    if (attributions.length === 0) {
      return {
        ...base,
        state: 'UNATTRIBUTED',
        ...buildUnattributedState({ metric, reasonCount: 0 }),
        reasons: [],
        reasonList: [],
        count: 0,
        rootCount: 0,
        maxDepthReached: 0,
        unfolding: { unbounded: true, maxDepthReached: 0, truncated: false },
        integrity: integrityOf([]),
        notices: [
          {
            code: 'UNATTRIBUTED',
            message: '该结果指标当前未归因，已提供关联入口；不显示空列表、不回落专业原始表。',
          },
        ],
        fallbackPolicy: 'none',
      };
    }

    const evidenceCounts = new Map(
      attributions.map((item) => [item.id, read.listEvidencesByAttribution(item.id).length]),
    );
    const tree = buildReasonTree(attributions, { maxDepth });
    const withCounts = (nodes) =>
      nodes.map((node) => ({
        ...node,
        evidenceCount: evidenceCounts.get(node.attributionId) ?? 0,
        children: withCounts(node.children ?? []),
      }));
    const reasons = withCounts(tree.roots);
    const reasonList = flattenTree(reasons);

    return {
      ...base,
      state: 'OK',
      status: summary.status,
      statusLabel: summary.statusLabel,
      attributionStatus: summary.status,
      empty: null,
      linkEntry: {
        label: '关联原因',
        method: 'POST',
        path: `/api/v1/results/${metric.id}/reasons`,
        accepts: ['exceptionRef', 'name', 'direction', 'contributionPct', 'impactValue', 'owner', 'parentId'],
      },
      summary,
      count: reasonList.length,
      rootCount: summary.rootCount,
      maxDepthReached: tree.maxDepthReached,
      unfolding: {
        unbounded: tree.unbounded,
        maxDepthReached: tree.maxDepthReached,
        // 展开深度由归因关系决定；仅在调用方显式传入 maxDepth 时才收窄
        truncated: !tree.unbounded,
        policy: 'by-relation',
      },
      reasons,
      reasonList,
      integrity: integrityOf(attributions),
      notices:
        summary.status === ATTRIBUTION_STATUS.FULLY
          ? []
          : [
              {
                code: 'PARTIALLY_ATTRIBUTED',
                message: `顶层贡献占比合计 ${summary.rootContributionPct}%，未达到 100%（容差 ${CONTRIBUTION_TOLERANCE_PCT}%），当前为部分归因。`,
              },
            ],
      fallbackPolicy: 'none',
    };
  }

  /** AC 场景 3：某一级原因项继续多级展开。 */
  function childrenOf(attributionId, { maxDepth = Infinity } = {}) {
    const target = read.getAttributionById(attributionId);
    if (!target) {
      throw HttpError.notFound('ATTRIBUTION_NOT_FOUND', `未找到原因项: ${attributionId}`);
    }
    const all = read.listAttributionsByMetric(target.metricId);
    const byId = new Map(all.map((item) => [item.id, item]));
    const parent = normalizeReasonNode(target, byId, {
      evidenceCount: read.listEvidencesByAttribution(target.id).length,
    });

    const subtree = all.filter((item) => {
      let cursor = item;
      const seen = new Set([item.id]);
      while (cursor.parentId) {
        if (cursor.parentId === target.id) return true;
        if (seen.has(cursor.parentId)) return false;
        seen.add(cursor.parentId);
        const next = byId.get(cursor.parentId);
        if (!next) return false;
        cursor = next;
      }
      return false;
    });

    const children = subtree.filter((item) => item.parentId === target.id);
    const tree = buildReasonTree(subtree.length ? [target, ...subtree] : [target], { maxDepth });
    const parentNode = tree.roots.find((node) => node.attributionId === target.id) ?? {
      ...parent,
      children: [],
    };

    // 「已细分 / 未细分」：子项贡献占比合计 vs 父项自身占比
    const childrenWithPct = children.filter((item) => typeof item.contributionPct === 'number');
    const childPctSum = round2(
      childrenWithPct.reduce((sum, item) => sum + item.contributionPct, 0),
    );
    const parentPct =
      typeof target.contributionPct === 'number' ? target.contributionPct : null;

    return {
      parent,
      children: parentNode.children,
      childCount: parentNode.children.length,
      metricId: target.metricId,
      breakdown: {
        parentContributionPct: parentPct,
        childrenWithContributionPct: childrenWithPct.length,
        childrenWithoutContributionPct: children.length - childrenWithPct.length,
        childContributionPctSum: childPctSum,
        // 已细分 = 子项合计；未细分 = 父项占比 − 子项合计（可能为负，表示子项超出父项）
        allocatedPct: childPctSum,
        unallocatedPct: parentPct === null ? null : round2(parentPct - childPctSum),
        subdivided: parentNode.children.length > 0,
        note: '子项只给影响量而未给贡献占比时，不计入已细分合计。',
      },
      unfolding: {
        unbounded: tree.unbounded,
        maxDepthReached: tree.maxDepthReached,
        policy: 'by-relation',
      },
      readOnly: true,
    };
  }

  /** AC 场景 4：单条原因项的类型判定结果。 */
  function typeVerdict(attributionId) {
    const target = read.getAttributionById(attributionId);
    if (!target) {
      throw HttpError.notFound('ATTRIBUTION_NOT_FOUND', `未找到原因项: ${attributionId}`);
    }
    return {
      ...describeTypeVerdict(target),
      // 兜底口径：不映射专业维度时显式标注
      professionalFactSource: target.kind === 'exception' ? target.exceptionSourceSystem : null,
      readOnly: true,
    };
  }

  /**
   * AC 判定标准：抽查不少于 10 条归因所引用的专业事实，
   * 均可溯源到专业模块 Result，且不存在 EBMS 自建专业事实源。
   */
  function professionalFactTrace(sample = DEFAULT_FACT_SAMPLE) {
    const rows = read.listAttributionFactSources();
    const checked = Number.isInteger(sample) && sample > 0 ? rows.slice(0, sample) : [];
    const items = checked.map((row) => {
      const traceable = Boolean(row.resultId && row.sourceSystem && row.calculationVersion);
      return {
        attributionId: row.attributionId,
        metricId: row.metricId,
        metricCode: row.metricCode,
        resultId: row.resultId,
        sourceSystem: row.sourceSystem,
        calculationVersion: row.calculationVersion,
        sourceOwnedByEbms: row.sourceSystem === 'M03',
        traceable,
      };
    });
    return {
      criteria: `抽查不少于 ${DEFAULT_FACT_SAMPLE} 条归因所引用的专业事实，均可溯源到专业模块 Result`,
      requiredSample: DEFAULT_FACT_SAMPLE,
      available: rows.length,
      compared: items.length,
      meetsRequiredSample: items.length >= DEFAULT_FACT_SAMPLE,
      allTraceable: items.every((item) => item.traceable),
      untraceable: items.filter((item) => !item.traceable),
      ebmsOwnedFactSources: items.filter((item) => item.sourceOwnedByEbms),
      // 结构性声明：EBMS 内不存在承载专业事实的自建表
      ebmsFactTables: [],
      readsProfessionalRawTables: false,
      items,
    };
  }

  /**
   * AC 边界（关联入口）：登记原因项。
   *
   * 兜底口径：引用不到已消费的 Exception 或缺少 reason_code / severity 时，
   * 一律按「M03 自有归因分析」登记并带回 fallback 标注；
   * 库层 CHECK 保证不存在无归属字段的原因项。
   */
  function linkReasons(metricRef, input, actor = 'anonymous') {
    const metric = resolveMetric(read, metricRef);
    const list = Array.isArray(input?.reasons) ? input.reasons : [input];
    if (!list.length || list.every((item) => !item || typeof item !== 'object')) {
      throw HttpError.badRequest('REASONS_REQUIRED', '至少需要一条原因项');
    }

    const at = new Date().toISOString();
    const created = [];
    const reused = [];

    for (const item of list) {
      const direction = item?.direction;
      if (!ALLOWED_DIRECTIONS.includes(direction)) {
        throw HttpError.badRequest(
          'INVALID_DIRECTION',
          `影响方向取值非法: ${direction}`,
          { allowedDirections: ALLOWED_DIRECTIONS },
        );
      }
      const contributionPct = item.contributionPct ?? null;
      const impactValue = item.impactValue ?? null;
      if (contributionPct === null && impactValue === null) {
        throw HttpError.badRequest(
          'IMPACT_BASIS_REQUIRED',
          '每条原因项需给出「影响量或贡献占比」至少一项',
        );
      }
      if (contributionPct !== null && (contributionPct <= 0 || contributionPct > 100)) {
        throw HttpError.badRequest('INVALID_CONTRIBUTION_PCT', '贡献占比须在 (0, 100] 区间');
      }
      const parentId = item.parentId ?? null;
      if (parentId) {
        const parent = read.getAttributionById(parentId);
        if (!parent || parent.metricId !== metric.id) {
          throw HttpError.badRequest('PARENT_NOT_IN_METRIC', `父原因项不属于该指标: ${parentId}`);
        }
      }

      // 兜底分类：映射至 Exception 或 M03 自有归因分析
      const classification = classifyReasonInput(
        { ...item, direction },
        { findException: (ref) => write.findException(ref) },
      );
      const displayName = classification.kind === 'exception'
        ? classification.exceptionId
        : classification.analysisName;
      const id = item.id ?? attributionIdFor(metric.id, displayName);

      const outcome = write.createAttribution(
        {
          id,
          metricId: metric.id,
          parentId,
          kind: classification.kind,
          exceptionId: classification.exceptionId,
          analysisName: classification.analysisName,
          direction,
          contributionPct,
          impactValue,
          owner: item.owner ?? (classification.kind === 'm03_analysis' ? 'M03' : '未指派'),
          orderNo: write.nextOrderNo(metric.id, parentId),
        },
        {
          actor,
          action: 'attribution.create',
          detail: JSON.stringify({
            metricId: metric.id,
            kind: classification.kind,
            fallback: classification.fallback?.code ?? null,
          }),
          at,
        },
      );

      // 回读落库结果再归一化，保证 Exception 型条目的 reason_code / severity 正确带出
      const stored = read.getAttributionById(outcome.row.id);
      const node = normalizeReasonNode(stored, new Map(), { evidenceCount: 0 });
      const payload = { ...node, fallback: classification.fallback ?? null };
      if (outcome.created) created.push(payload);
      else reused.push(payload);
    }

    const attributions = read.listAttributionsByMetric(metric.id);
    return {
      metricId: metric.id,
      created,
      reused,
      createdCount: created.length,
      reusedCount: reused.length,
      // 登记后重新给出状态，便于前端就地刷新
      summary: summarizeAttribution(attributions),
      reasonCount: attributions.length,
      fallbackPolicy: 'none',
      audit: created.length ? write.listAuditFor(created[0].attributionId) : [],
    };
  }

  return {
    reasonsForMetric,
    childrenOf,
    typeVerdict,
    linkReasons,
    professionalFactTrace,
    directionOptions: () => ({ directions: DIRECTION_OPTIONS, severities: SEVERITY_OPTIONS }),
  };
}
