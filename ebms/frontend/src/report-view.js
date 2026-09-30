// F7（PAND-85）REPORT 视图：纯逻辑层，不依赖 DOM，可直接单测。
// 口径以后端返回为准：结论、关键结果指标（目标值/实际值/偏差）、关联的三类入口均由后端装配，
// 前端只做展示编排——不自行取数、不自行计算偏差、不自行维护入口类型清单。

import { NO_DATA_LABEL, buildMetricTile, periodLabel } from './result-overview.js';
import { NO_LINK_HINT, toNavEntry } from './view-nav.js';

/**
 * 默认落地模块（AC 场景 1：登录后到达任一份 Report 的点击次数 ≤ 1）。
 * 登录完成即渲染报告清单，清单上的每张卡片自带一次点击可达的落点。
 */
export const DEFAULT_LANDING_VIEW = 'report';

/** 空态文案：无 Report 时给出空态与创建入口，而不是空白页。 */
export const EMPTY_STATE = Object.freeze({
  title: '暂无报告',
  hint: '还没有任何报告。报告以「结论」为单位组织信息，汇总关键结果指标与偏差，并挂接 TODO / Decision / Evidence。',
  actionLabel: '创建报告',
});

/** 报告不自己取数：红线在界面上可见。 */
export const REPORT_SOURCE_NOTICE =
  '报告不自己取数：关键结果指标的实际值仍 100% 来自专业 Owner 模块（M05 销售 / M06 交付 / M09 财经）的 Result；' +
  '目标值来自 M03 管理目标；偏差值 = 实际值 − 目标值。';

/** 筛选态 → 查询串。周期必须成对给出（后端对不成对的周期参数直接报错），前端在此挡住。 */
export function reportQuery({ periodType, periodValue, domain } = {}) {
  const params = new URLSearchParams();
  if (periodType && periodValue) {
    params.set('period_type', periodType);
    params.set('period_value', periodValue);
  }
  if (domain) params.set('domain', domain);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** 周期下拉的取值编码：一个选项 = 一个 (periodType, periodValue) 组合。 */
export function periodOptionValue(periodType, periodValue) {
  return periodType && periodValue ? `${periodType}|${periodValue}` : '';
}

export function parsePeriodOptionValue(value) {
  const [periodType, periodValue] = String(value ?? '').split('|');
  return periodType && periodValue ? { periodType, periodValue } : { periodType: '', periodValue: '' };
}

/** 报告基础身份（清单卡片与详情页共用）。 */
export function buildReportBase(report) {
  return {
    id: report?.id ?? null,
    code: report?.code ?? '',
    title: report?.title ?? '',
    conclusion: report?.conclusion ?? '',
    periodType: report?.periodType ?? null,
    periodValue: report?.periodValue ?? null,
    periodLabel: periodLabel(report?.periodType, report?.periodValue),
    domainCode: report?.domain?.code ?? null,
    domainLabel: report?.domain?.label ?? report?.domain?.code ?? '未标注责任域',
    owner: report?.owner ?? null,
    // 一次点击可达的落点（后端下发，前端不拼装）
    landingHref: report?.landingHref ?? (report?.id ? `/report/${report.id}` : null),
  };
}

/** 一张报告卡片：结论 + 关键指标概览 + 三类关联入口（无关联也占位并置灰）。 */
export function buildReportCard(report) {
  const metrics = report?.keyMetrics ?? [];
  const tiles = metrics.map(buildMetricTile);
  const summary = report?.metricSummary ?? {};
  const suppliedCount = Number(summary.suppliedCount ?? metrics.filter((m) => m.hasData).length);

  return {
    ...buildReportBase(report),
    metrics: tiles,
    metricCount: Number(summary.count ?? tiles.length),
    suppliedCount,
    noDataCount: Number(summary.noDataCount ?? tiles.length - suppliedCount),
    // 判定标准：偏差超阈值项一眼可见
    exceededCount: Number(summary.exceededCount ?? tiles.filter((t) => t.exceeded).length),
    entries: (report?.entries ?? []).map(toNavEntry),
    noLinkHint: NO_LINK_HINT,
  };
}

/**
 * GET /reports 载荷 → 清单渲染模型。
 * 边界：无 Report 时 empty 为真（空集不是错误），并给出空态与创建入口文案。
 */
export function buildReportListModel(payload) {
  const items = payload?.items ?? [];
  const cards = items.map(buildReportCard);
  const total = Number(payload?.total ?? cards.length);

  return {
    total,
    limit: Number(payload?.limit ?? 50),
    offset: Number(payload?.offset ?? 0),
    filters: {
      periodType: payload?.filters?.periodType ?? null,
      periodValue: payload?.filters?.periodValue ?? null,
      domain: payload?.filters?.domain ?? null,
    },
    cards,
    empty: Boolean(payload?.empty ?? total === 0),
    emptyState: EMPTY_STATE,
  };
}

/** 筛选栏模型：责任域为口径清单（含未落库的取值），周期为已存在的报告周期。 */
export function buildFilterModel(options) {
  const domains = (options?.domains ?? []).map((d) => ({
    code: d.code,
    label: d.label ?? d.code,
  }));
  const periods = (options?.periods ?? []).map((p) => ({
    periodType: p.periodType,
    periodValue: p.periodValue,
    label: periodLabel(p.periodType, p.periodValue),
  }));
  return { domains, periods };
}

/** 详情页的关键指标表模型：复用 F1 的展示组件与同一条偏差口径。 */
export function buildReportMetricModel(metrics = []) {
  const tiles = metrics.map(buildMetricTile);
  const supplied = metrics.filter((m) => m.hasData);
  const noDataCount = tiles.length - supplied.length;
  const traceableCount = supplied.filter((m) => m.traceability?.complete).length;

  return {
    sourceNotice: REPORT_SOURCE_NOTICE,
    stats: [
      { key: 'configured', label: '关键结果指标', value: tiles.length },
      { key: 'supplied', label: '已供给实际值', value: supplied.length },
      { key: 'nodata', label: NO_DATA_LABEL, value: noDataCount },
      { key: 'exceeded', label: '偏差超阈值', value: tiles.filter((t) => t.exceeded).length },
    ],
    noDataCount,
    traceabilityNotice:
      supplied.length === 0
        ? null
        : `已供给 ${supplied.length} 项中，${traceableCount} 项的口径版本与证据引用无缺项`,
    tiles,
  };
}

/** 详情页的三类关联入口模型（形态与 F11 导航栏一致，直接喂给同一个渲染组件）。 */
export function buildReportNavModel(entries, entryTotal) {
  const list = (entries ?? []).map(toNavEntry);
  return {
    total: Number(entryTotal ?? list.reduce((sum, entry) => sum + entry.count, 0)),
    entries: list,
  };
}

/**
 * GET /reports/:id 载荷 → 详情渲染模型。
 * 场景 2：结论 + 关键结果指标 + 偏差 + 三类关联入口（均存在，无关联时置灰）。
 */
export function buildReportDetailModel(payload) {
  const report = payload?.report ?? null;
  const navModel = buildReportNavModel(payload?.entries, payload?.entryTotal);

  return {
    report: buildReportBase(report),
    metricModel: buildReportMetricModel(payload?.keyMetrics),
    navModel,
    entries: navModel.entries,
    entryTotal: navModel.total,
    allDisabled: navModel.entries.length > 0 && navModel.entries.every((entry) => entry.disabled),
    noLinkHint: NO_LINK_HINT,
  };
}
