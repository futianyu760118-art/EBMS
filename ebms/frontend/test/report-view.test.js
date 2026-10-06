// F7（PAND-85）REPORT 视图：展示模型单测。
// 覆盖 AC：≤1 click 落点、结论/关键结果指标/偏差、三类关联入口均存在（无关联也占位）、
// 按周期与责任域筛选、无 Report 时的空态与创建入口。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LANDING_VIEW,
  EMPTY_STATE,
  buildFilterModel,
  buildReportCard,
  buildReportDetailModel,
  buildReportListModel,
  buildReportNavModel,
  parsePeriodOptionValue,
  periodOptionValue,
  reportQuery,
} from '../src/report-view.js';
import { NO_LINK_HINT } from '../src/view-nav.js';
import {
  FINANCE_SEP_ID,
  LINKED_ID,
  ORPHAN_ID,
  REPORT_DETAIL,
  REPORT_DETAIL_ORPHAN,
  REPORT_FILTERS,
  REPORT_LIST,
  REPORT_LIST_EMPTY,
  TODO_ID,
} from './fixtures/report-payload.js';

// ------------------------------------------------------------------ 场景 1：≤1 click

test('场景 1：默认落地视图即报告清单（登录后无需再点菜单）', () => {
  assert.equal(DEFAULT_LANDING_VIEW, 'report');
});

test('场景 1：每张卡片自带一次点击可达的落点', () => {
  const model = buildReportListModel(REPORT_LIST);

  assert.equal(model.cards.length, 3);
  for (const card of model.cards) {
    assert.equal(card.landingHref, `/report/${card.id}`);
  }
  assert.equal(model.cards[0].landingHref, `/report/${LINKED_ID}`);
});

// ------------------------------------------------------------------ 场景 2：结论 + 关键指标 + 偏差

test('场景 2：卡片含结论，且关键指标/已供给/超阈值/无数据逐项计数', () => {
  const model = buildReportListModel(REPORT_LIST);
  const linked = model.cards[0];

  assert.equal(linked.title, '9月经营月报：订单交付偏差');
  assert.match(linked.conclusion, /订单交付达成 87%/);

  assert.equal(linked.metricCount, 2);
  assert.equal(linked.suppliedCount, 2);
  assert.equal(linked.noDataCount, 0);
  assert.equal(linked.exceededCount, 1, '偏差超阈值项应被计数（|−13%| > 5%）');
});

test('场景 2：无实际值的指标计入「无数据」，不倒扣为已供给', () => {
  const model = buildReportListModel(REPORT_LIST);
  const orphan = model.cards.find((c) => c.id === ORPHAN_ID);

  assert.equal(orphan.metricCount, 2);
  assert.equal(orphan.suppliedCount, 1);
  assert.equal(orphan.noDataCount, 1);

  const noData = orphan.metrics.find((m) => m.code === 'new_customer_count');
  assert.equal(noData.actualText, '无数据');
  assert.equal(noData.noDataReason, '来源模块未同步本期数据');
});

test('场景 2：报告周期与责任域以可读标签呈现', () => {
  const model = buildReportListModel(REPORT_LIST);
  const finance = model.cards.find((c) => c.id === FINANCE_SEP_ID);

  assert.equal(finance.periodLabel, '2026年09月');
  assert.equal(finance.domainCode, 'finance');
  assert.equal(finance.domainLabel, '财务');
});

test('场景 2：责任域缺失时不丢弃报告，按「未标注责任域」呈现', () => {
  const card = buildReportCard({
    id: 'x',
    code: 'RPT-X',
    title: '无域报告',
    conclusion: '结论',
    periodType: 'month',
    periodValue: '2026-09',
    domain: null,
  });
  assert.equal(card.domainLabel, '未标注责任域');
  assert.equal(card.landingHref, '/report/x');
});

// ------------------------------------------------------------------ 判定标准：三类入口均存在

test('判定标准：每张卡片都含 TODO / Decision / Evidence 三类入口', () => {
  const model = buildReportListModel(REPORT_LIST);

  for (const card of model.cards) {
    assert.deepEqual(
      card.entries.map((e) => e.targetType),
      ['todo', 'decision', 'evidence']
    );
    for (const entry of card.entries) {
      assert.ok(entry.label.length > 0);
      assert.ok(entry.landingPath.startsWith('/'));
    }
  }
});

test('判定标准：无关联的入口占位并置灰（提示「无关联」），不因缺关联而消失', () => {
  const model = buildReportListModel(REPORT_LIST);
  const orphan = model.cards.find((c) => c.id === ORPHAN_ID);

  assert.equal(orphan.entries.length, 3);
  for (const entry of orphan.entries) {
    assert.equal(entry.count, 0);
    assert.equal(entry.disabled, true);
    assert.equal(entry.hint, NO_LINK_HINT);
  }
  assert.equal(orphan.noLinkHint, NO_LINK_HINT);
});

test('判定标准：部分关联时逐入口判定（仅未关联的入口置灰）', () => {
  const model = buildReportListModel(REPORT_LIST);
  const finance = model.cards.find((c) => c.id === FINANCE_SEP_ID);
  const byType = new Map(finance.entries.map((e) => [e.targetType, e]));

  assert.equal(byType.get('evidence').disabled, false);
  assert.equal(byType.get('evidence').count, 1);
  assert.equal(byType.get('evidence').links[0].href, `/evidence/bbbbbbbb-0001-4000-8000-000000000001`);
  assert.equal(byType.get('todo').disabled, true);
  assert.equal(byType.get('decision').disabled, true);
});

test('判定标准：有关联入口的落点可点击（href 来自后端下发的 landingHref）', () => {
  const model = buildReportListModel(REPORT_LIST);
  const linked = model.cards[0];
  const todo = linked.entries.find((e) => e.targetType === 'todo');

  assert.equal(todo.disabled, false);
  assert.equal(todo.hint, null);
  assert.equal(todo.links[0].href, `/todo/${TODO_ID}`);
});

// ------------------------------------------------------------------ 场景 3：筛选

test('场景 3：筛选态编码为查询串（周期成对，责任域单独生效）', () => {
  assert.equal(reportQuery({}), '');
  assert.equal(reportQuery({ domain: 'finance' }), '?domain=finance');
  assert.equal(
    reportQuery({ periodType: 'month', periodValue: '2026-08' }),
    '?period_type=month&period_value=2026-08'
  );
  assert.equal(
    reportQuery({ periodType: 'month', periodValue: '2026-09', domain: 'delivery' }),
    '?period_type=month&period_value=2026-09&domain=delivery'
  );
  // 周期不成对时不发周期条件（后端对不成对参数直接报错，前端在此挡住）
  assert.equal(reportQuery({ periodType: 'month' }), '');
  assert.equal(reportQuery({ periodValue: '2026-09' }), '');
});

test('场景 3：清单模型回显当前筛选条件，便于界面保持选中态', () => {
  const model = buildReportListModel({
    ...REPORT_LIST,
    filters: { periodType: 'month', periodValue: '2026-09', domain: 'delivery' },
  });

  assert.deepEqual(model.filters, { periodType: 'month', periodValue: '2026-09', domain: 'delivery' });
  assert.equal(model.total, 3);
});

test('场景 3：周期下拉取值可往返编码（选项 = 周期类型 + 周期取值）', () => {
  const value = periodOptionValue('month', '2026-09');
  assert.equal(value, 'month|2026-09');
  assert.deepEqual(parsePeriodOptionValue(value), { periodType: 'month', periodValue: '2026-09' });
  assert.deepEqual(parsePeriodOptionValue(''), { periodType: '', periodValue: '' });
});

test('场景 3：筛选栏取值为责任域口径清单 + 已存在的报告周期（周期标签本地化）', () => {
  const model = buildFilterModel(REPORT_FILTERS);

  assert.deepEqual(
    model.domains.map((d) => d.code),
    ['finance', 'sales', 'delivery', 'supply_chain']
  );
  assert.equal(model.domains[0].label, '财务');
  assert.deepEqual(
    model.periods.map((p) => p.label),
    ['2026年09月', '2026年08月']
  );
});

// ------------------------------------------------------------------ 边界：空态 + 创建入口

test('边界：无 Report 时给出空态与创建入口（空集不是错误）', () => {
  const model = buildReportListModel(REPORT_LIST_EMPTY);

  assert.equal(model.total, 0);
  assert.equal(model.empty, true);
  assert.deepEqual(model.cards, []);
  assert.equal(model.emptyState.title, EMPTY_STATE.title);
  assert.ok(model.emptyState.hint.length > 0);
  assert.equal(model.emptyState.actionLabel, '创建报告');
  assert.deepEqual(model.filters, { periodType: 'month', periodValue: '2026-08', domain: 'sales' });
});

test('边界：载荷缺字段时按空清单处理，不抛错', () => {
  const model = buildReportListModel(undefined);
  assert.equal(model.total, 0);
  assert.equal(model.empty, true);
});

// ------------------------------------------------------------------ 详情：结论 + 指标 + 偏差 + 三类入口

test('场景 2：详情模型含结论、关键指标表模型与三类关联入口', () => {
  const model = buildReportDetailModel(REPORT_DETAIL);

  assert.equal(model.report.title, '9月经营月报：订单交付偏差');
  assert.match(model.report.conclusion, /主因产能不足/);
  assert.equal(model.report.periodLabel, '2026年09月');
  assert.equal(model.report.domainLabel, '交付');

  // 关键指标：复用 F1 的展示模型（目标值/实际值/偏差）
  assert.equal(model.metricModel.tiles.length, 2);
  assert.equal(model.metricModel.noDataCount, 0);
  assert.deepEqual(
    model.metricModel.stats.map((s) => [s.key, s.value]),
    [
      ['configured', 2],
      ['supplied', 2],
      ['nodata', 0],
      ['exceeded', 1],
    ]
  );
  const delivery = model.metricModel.tiles.find((t) => t.code === 'order_delivery');
  assert.equal(delivery.targetText, '100%');
  assert.equal(delivery.actualText, '87%');
  assert.equal(delivery.deviationText, '-13%');
  assert.equal(delivery.deviationPctText, '-13%');
  assert.equal(delivery.attainmentLabel, '未达标');
  assert.equal(delivery.exceeded, true);
  assert.match(model.metricModel.sourceNotice, /报告不自己取数/);

  // 三类关联入口
  assert.deepEqual(
    model.entries.map((e) => e.targetType),
    ['todo', 'decision', 'evidence']
  );
  assert.equal(model.entryTotal, 3);
  assert.equal(model.allDisabled, false);
});

test('场景 2：详情的关键指标无数据时偏差一并「无数据」', () => {
  const model = buildReportDetailModel(REPORT_DETAIL_ORPHAN);
  const noData = model.metricModel.tiles.find((t) => t.code === 'new_customer_count');

  assert.equal(noData.noData, true);
  assert.equal(noData.actualText, '无数据');
  assert.equal(noData.deviationText, '无数据');
  assert.equal(noData.deviationPctText, null);
  assert.equal(model.metricModel.noDataCount, 1);
});

test('边界：全部无关联的报告在详情中标记三个入口全置灰', () => {
  const model = buildReportDetailModel(REPORT_DETAIL_ORPHAN);

  assert.equal(model.entryTotal, 0);
  assert.equal(model.allDisabled, true);
  assert.ok(model.entries.every((e) => e.disabled && e.hint === NO_LINK_HINT));
  assert.equal(model.noLinkHint, NO_LINK_HINT);
});

test('边界：缺省 entryTotal 时按三类入口的条数合计', () => {
  const model = buildReportNavModel(REPORT_DETAIL.entries);

  assert.equal(model.entries.length, 3);
  assert.equal(model.total, 3);
  assert.deepEqual(
    model.entries.map((e) => e.count),
    [1, 1, 1]
  );
});

test('边界：详情载荷缺字段时按空模型处理，不抛错', () => {
  const model = buildReportDetailModel(undefined);

  assert.equal(model.report.id, null);
  assert.deepEqual(model.metricModel.tiles, []);
  assert.deepEqual(model.entries, []);
  assert.equal(model.entryTotal, 0);
  assert.equal(model.allDisabled, false);
});
