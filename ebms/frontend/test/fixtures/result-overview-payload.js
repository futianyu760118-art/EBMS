// F1（PAND-79）测试用载荷：形状与后端 GET /api/v1/results 的 data 一致。
// 模型单测与 SSR 渲染测试共用，避免两处各自臆造字段。
import { DEVIATION_LABEL } from '../../src/result-overview.js';

export const M09 = { module: 'M09', label: 'M09 财经自治', scope: '收入 / 成本 / 毛利 / 现金 / 应收应付' };
export const M05 = { module: 'M05', label: 'M05 销售自治', scope: '订单 / 客户 / 报价' };
export const M06 = { module: 'M06', label: 'M06 交付自治', scope: '交付 / 产能 / 库存 / 物料' };

export function supplied(over = {}) {
  const owner = over.owner ?? M09;
  const hasData = over.hasData !== false;

  return {
    id: over.id ?? 'm-1',
    code: over.code ?? 'revenue',
    name: over.name ?? '营业收入',
    dimension: 'finance',
    dimensionLabel: '财务',
    periodType: 'month',
    periodValue: '2026-09',
    dataCutoffAt: '2026-09-26T03:00:00.000Z',
    unit: over.unit ?? '元',
    owner,
    target: {
      value: over.targetValue ?? 12000000,
      unit: over.unit ?? '元',
      direction: over.direction ?? 'higher_better',
      source: { module: 'M03', ref: 'GOAL-2026-09-REV' },
    },
    actual: hasData
      ? {
          value: over.actualValue ?? 11280000,
          unit: over.unit ?? '元',
          source: {
            module: owner.module,
            resultId: over.resultId ?? 'RES-M09-REV-202609',
            contractVersion: 'AEOS.Result.V1',
            objectType: 'BusinessMetric',
            objectId: over.code ?? 'revenue',
            calculationVersion: over.calculationVersion ?? 'FIN-2026.09.1',
            status: 'VERIFIED',
            occurredAt: '2026-09-26T02:30:00.000Z',
            traceId: 'trace-1',
          },
          evidenceIds: over.evidenceIds ?? ['bbbbbbbb-0006-4000-8000-000000000006'],
        }
      : null,
    targetValue: over.targetValue ?? 12000000,
    actualValue: hasData ? over.actualValue ?? 11280000 : null,
    // 后端契约：实际值无数据 → deviation 不可计算（exceeded / attainment 均为 null）
    deviation:
      over.deviation ??
      (hasData
        ? {
            formula: DEVIATION_LABEL,
            pctFormula: '（实际值 − 目标值）÷ |目标值| × 100%',
            direction: 'higher_better',
            thresholdPct: 5,
            computable: true,
            value: -720000,
            pct: -6,
            exceeded: true,
            attainment: 'MISSED',
            reason: null,
          }
        : {
            formula: DEVIATION_LABEL,
            pctFormula: '（实际值 − 目标值）÷ |目标值| × 100%',
            direction: 'higher_better',
            thresholdPct: 5,
            computable: false,
            value: null,
            pct: null,
            exceeded: null,
            attainment: null,
            reason: '实际值无数据，无法计算偏差',
          }),
    dataStatus: over.dataStatus ?? (hasData ? 'SUPPLIED' : 'NOT_SUPPLIED'),
    dataStatusLabel: hasData ? '已供给' : '无数据',
    noDataReason: hasData ? null : over.noDataReason ?? '来源模块未供给',
    hasData,
    exceeded: over.deviation ? over.deviation.exceeded : hasData ? true : null,
    attainment: over.attainment ?? (hasData ? 'MISSED' : null),
    traceability: {
      resultId: hasData ? over.resultId ?? 'RES-M09-REV-202609' : null,
      sourceModule: hasData ? owner.module : owner.module,
      calculationVersion: hasData ? over.calculationVersion ?? 'FIN-2026.09.1' : null,
      evidenceIds: hasData ? over.evidenceIds ?? ['bbbbbbbb-0006-4000-8000-000000000006'] : [],
      evidence:
        over.evidence ??
        (hasData
          ? [
              {
                id: 'bbbbbbbb-0006-4000-8000-000000000006',
                resolved: true,
                typeLabel: '财务凭证',
                title: '9月财务结算报表',
                formedAt: '2026-09-26T02:00:00.000Z',
                owner: '财务中心',
                viewPath: '#/evidence/bbbbbbbb-0006-4000-8000-000000000006',
              },
            ]
          : []),
      complete: hasData ? true : null,
    },
  };
}

/** 5 条指标：3 条已供给（含超阈值/未超阈值/下向指标），2 条无数据（未同步 / 未供给）。 */
export const OVERVIEW = {
  period: { periodType: 'month', periodValue: '2026-09' },
  configuredCount: 5,
  suppliedCount: 3,
  noDataCount: 2,
  traceableCount: 3,
  allTraceable: true,
  items: [
    supplied({ id: 'm-rev', code: 'revenue', name: '营业收入' }),
    supplied({
      id: 'm-gm',
      code: 'gross_margin_rate',
      name: '毛利率',
      unit: '%',
      targetValue: 25,
      actualValue: 25.8,
      resultId: 'RES-M09-GM-202609',
      deviation: {
        formula: DEVIATION_LABEL,
        pctFormula: '（实际值 − 目标值）÷ |目标值| × 100%',
        direction: 'higher_better',
        thresholdPct: 5,
        computable: true,
        value: 0.8,
        pct: 3.2,
        exceeded: false,
        attainment: 'ACHIEVED',
        reason: null,
      },
      evidence: [
        {
          id: 'bbbbbbbb-0006-4000-8000-000000000006',
          resolved: true,
          typeLabel: '财务凭证',
          title: '9月财务结算报表',
          viewPath: '#/evidence/bbbbbbbb-0006-4000-8000-000000000006',
        },
      ],
    }),
    supplied({
      id: 'm-cost',
      code: 'operating_cost',
      name: '营业成本',
      targetValue: 3000000,
      actualValue: 3410000,
      resultId: 'RES-M09-COST-202609',
      direction: 'lower_better',
      deviation: {
        formula: DEVIATION_LABEL,
        pctFormula: '（实际值 − 目标值）÷ |目标值| × 100%',
        direction: 'lower_better',
        thresholdPct: 5,
        computable: true,
        value: 410000,
        pct: 13.67,
        exceeded: true,
        attainment: 'MISSED',
        reason: null,
      },
      evidence: [
        {
          id: 'bbbbbbbb-0006-4000-8000-000000000006',
          resolved: true,
          typeLabel: '财务凭证',
          title: '9月财务结算报表',
          viewPath: '#/evidence/bbbbbbbb-0006-4000-8000-000000000006',
        },
      ],
    }),
    supplied({
      id: 'm-nc',
      code: 'new_customer_count',
      name: '新增客户数',
      unit: '个',
      targetValue: 30,
      owner: M05,
      hasData: false,
      dataStatus: 'NOT_SYNCED',
      noDataReason: '来源模块未同步本期数据',
    }),
    supplied({
      id: 'm-cap',
      code: 'capacity_utilization',
      name: '产能利用率',
      unit: '%',
      targetValue: 85,
      owner: M06,
      hasData: false,
    }),
  ],
};
