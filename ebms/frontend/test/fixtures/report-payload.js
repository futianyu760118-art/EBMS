// F7（PAND-85）测试用载荷：形状与后端 GET /api/v1/reports、/reports/:id、/report-filters 的 data 一致。
// 模型单测与 SSR 渲染测试共用，避免两处各自臆造字段。
import { NO_LINK_HINT } from '../../src/view-nav.js';
import { DEVIATION_LABEL } from '../../src/result-overview.js';
import { M05, M06, M09, supplied } from './result-overview-payload.js';

export const LINKED_ID = 'cccccccc-0001-4000-8000-000000000001';
export const ORPHAN_ID = 'cccccccc-0002-4000-8000-000000000002';
export const FINANCE_SEP_ID = 'cccccccc-0003-4000-8000-000000000003';
export const TODO_ID = 'dddddddd-0001-4000-8000-000000000001';
export const DECISION_ID = 'eeeeeeee-0001-4000-8000-000000000001';
export const EVIDENCE_ID = 'bbbbbbbb-0001-4000-8000-000000000001';

function deviation(over) {
  return {
    formula: DEVIATION_LABEL,
    pctFormula: '（实际值 − 目标值）÷ |目标值| × 100%',
    direction: over.direction ?? 'higher_better',
    thresholdPct: 5,
    computable: true,
    value: over.value,
    pct: over.pct,
    exceeded: over.exceeded,
    attainment: over.attainment,
    reason: null,
  };
}

/** 三类入口之一：无关联时 count=0 / disabled / 提示「无关联」（与后端一致）。 */
function entry(targetType, label, fullLabel, landingPath, links = []) {
  return {
    targetType,
    label,
    fullLabel,
    landingPath,
    count: links.length,
    disabled: links.length === 0,
    hint: links.length === 0 ? NO_LINK_HINT : null,
    entries: links,
  };
}

const DELIVERY = { code: 'delivery', label: '交付' };
const SALES = { code: 'sales', label: '销售' };
const FINANCE = { code: 'finance', label: '财务' };

// ---------------------------------------------------------------- 报告（三份：有关联 / 无关联 / 部分关联）

const linkedMetrics = [
  supplied({
    id: 'm-od',
    code: 'order_delivery',
    name: '订单交付达成率',
    unit: '%',
    owner: M06,
    targetValue: 100,
    actualValue: 87,
    deviation: deviation({ value: -13, pct: -13, exceeded: true, attainment: 'MISSED' }),
  }),
  supplied({
    id: 'm-cap',
    code: 'capacity_utilization',
    name: '产能利用率',
    unit: '%',
    owner: M06,
    targetValue: 90,
    actualValue: 88,
    deviation: deviation({ value: -2, pct: -2.22, exceeded: false, attainment: 'MISSED' }),
  }),
];

const linkedReport = {
  id: LINKED_ID,
  code: 'RPT-2026-09-01',
  title: '9月经营月报：订单交付偏差',
  conclusion: '订单交付达成 87%，低于目标 13 个百分点，主因产能不足。',
  periodType: 'month',
  periodValue: '2026-09',
  domain: DELIVERY,
  owner: '经营管理部',
  createdAt: '2026-09-30T02:00:00.000Z',
  landingHref: `/report/${LINKED_ID}`,
  keyMetrics: linkedMetrics,
  metricSummary: { count: 2, suppliedCount: 2, noDataCount: 0, exceededCount: 1 },
  entries: [
    entry('todo', 'TODO', '待办事项', '/todo', [
      {
        id: TODO_ID,
        code: 'TODO-2026-0901',
        title: '2号线排产调整以补产能缺口',
        badge: 'TODO',
        subtitle: 'in_progress',
        landingHref: `/todo/${TODO_ID}`,
      },
    ]),
    entry('decision', 'Decision', '决策', '/decision', [
      {
        id: DECISION_ID,
        code: 'DEC-2026-0901',
        title: '是否追加2号线夜班产能',
        badge: 'Decision',
        subtitle: 'decided',
        landingHref: `/decision/${DECISION_ID}`,
      },
    ]),
    entry('evidence', 'Evidence', '证据', '/evidence', [
      {
        id: EVIDENCE_ID,
        code: '',
        title: '采购框架合同 SC-2026-014',
        badge: '合同',
        subtitle: '供应链中心 / 王采购',
        landingHref: `/evidence/${EVIDENCE_ID}`,
      },
    ]),
  ],
};

const orphanReport = {
  id: ORPHAN_ID,
  code: 'RPT-2026-09-02',
  title: '9月经营月报：渠道库存',
  conclusion: '渠道库存周转放缓，暂未形成偏差结论。',
  periodType: 'month',
  periodValue: '2026-09',
  domain: SALES,
  owner: '经营管理部',
  createdAt: '2026-09-30T02:10:00.000Z',
  landingHref: `/report/${ORPHAN_ID}`,
  keyMetrics: [
    supplied({
      id: 'm-oa',
      code: 'order_amount',
      name: '订单金额',
      owner: M05,
      targetValue: 13500,
      actualValue: 11800,
      deviation: deviation({ value: -1700, pct: -12.59, exceeded: true, attainment: 'MISSED' }),
    }),
    supplied({
      id: 'm-nc',
      code: 'new_customer_count',
      name: '新增客户数',
      unit: '家',
      owner: M05,
      hasData: false,
      dataStatus: 'NOT_SYNCED',
      noDataReason: '来源模块未同步本期数据',
    }),
  ],
  metricSummary: { count: 2, suppliedCount: 1, noDataCount: 1, exceededCount: 1 },
  entries: [
    entry('todo', 'TODO', '待办事项', '/todo'),
    entry('decision', 'Decision', '决策', '/decision'),
    entry('evidence', 'Evidence', '证据', '/evidence'),
  ],
};

const financeSepReport = {
  id: FINANCE_SEP_ID,
  code: 'RPT-2026-09-03',
  title: '9月财务月报：收入与成本偏差',
  conclusion: '营业收入 11280 万元，低于目标 6%；营业成本超目标 5.1%，毛利率承压。',
  periodType: 'month',
  periodValue: '2026-09',
  domain: FINANCE,
  owner: '财经管理部',
  createdAt: '2026-09-30T02:20:00.000Z',
  landingHref: `/report/${FINANCE_SEP_ID}`,
  keyMetrics: [
    supplied({
      id: 'm-rev',
      code: 'revenue',
      name: '营业收入',
      owner: M09,
      targetValue: 12000,
      actualValue: 11280,
      deviation: deviation({ value: -720, pct: -6, exceeded: true, attainment: 'MISSED' }),
    }),
  ],
  metricSummary: { count: 1, suppliedCount: 1, noDataCount: 0, exceededCount: 1 },
  entries: [
    entry('todo', 'TODO', '待办事项', '/todo'),
    entry('decision', 'Decision', '决策', '/decision'),
    entry('evidence', 'Evidence', '证据', '/evidence', [
      {
        id: EVIDENCE_ID,
        code: '',
        title: '财务月结报表导出（2026-09）',
        badge: '系统记录',
        subtitle: '财务中心 / 系统',
        landingHref: `/evidence/${EVIDENCE_ID}`,
      },
    ]),
  ],
};

/** 后端 serializeReportBase 只回身份字段，关键指标/入口在详情载荷的兄弟字段上。 */
function baseOf(report) {
  const { keyMetrics, metricSummary, entries, ...base } = report;
  return base;
}

// ---------------------------------------------------------------- 载荷

export const REPORT_LIST = {
  total: 3,
  limit: 50,
  offset: 0,
  filters: { periodType: null, periodValue: null, domain: null },
  items: [linkedReport, orphanReport, financeSepReport],
  empty: false,
};

export const REPORT_LIST_EMPTY = {
  total: 0,
  limit: 50,
  offset: 0,
  filters: { periodType: 'month', periodValue: '2026-08', domain: 'sales' },
  items: [],
  empty: true,
};

export const REPORT_DETAIL = {
  report: baseOf(linkedReport),
  keyMetrics: linkedReport.keyMetrics,
  metricSummary: linkedReport.metricSummary,
  entries: linkedReport.entries,
  entryTotal: 3,
};

export const REPORT_DETAIL_ORPHAN = {
  report: baseOf(orphanReport),
  keyMetrics: orphanReport.keyMetrics,
  metricSummary: orphanReport.metricSummary,
  entries: orphanReport.entries,
  entryTotal: 0,
};

export const REPORT_FILTERS = {
  domains: [
    { code: 'finance', label: '财务', ownerModule: 'M09' },
    { code: 'sales', label: '销售', ownerModule: 'M05' },
    { code: 'delivery', label: '交付', ownerModule: 'M06' },
    { code: 'supply_chain', label: '供应链', ownerModule: 'M06' },
  ],
  periods: [
    { periodType: 'month', periodValue: '2026-09' },
    { periodType: 'month', periodValue: '2026-08' },
  ],
};
