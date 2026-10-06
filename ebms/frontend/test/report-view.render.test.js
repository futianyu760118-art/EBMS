// F7（PAND-85）REPORT 视图：渲染断言。
// 用 Vite 的 SSR 模块加载器编译真实 SFC，再渲染成 HTML 断言，
// 覆盖 AC：卡片含结论与三类关联入口、无关联入口置灰文案可见、详情的关键指标与偏差真的渲染出来。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';

import { buildReportCard, buildReportDetailModel, buildReportListModel } from '../src/report-view.js';
import { NO_LINK_HINT } from '../src/view-nav.js';
import { REPORT_DETAIL, REPORT_DETAIL_ORPHAN, REPORT_LIST } from './fixtures/report-payload.js';

let vite;
let ReportCard;
let ResultMetricTable;
let ViewNavBar;

test.before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  ReportCard = (await vite.ssrLoadModule('/src/components/ReportCard.vue')).default;
  ResultMetricTable = (await vite.ssrLoadModule('/src/components/ResultMetricTable.vue')).default;
  ViewNavBar = (await vite.ssrLoadModule('/src/components/ViewNavBar.vue')).default;
});

test.after(async () => {
  await vite?.close();
});

function render(component, props) {
  return renderToString(createSSRApp(component, props));
}

function count(html, pattern) {
  return (html.match(pattern) || []).length;
}

const cards = buildReportListModel(REPORT_LIST).cards;
const linkedCard = cards[0];
const orphanCard = cards.find((card) => card.title.includes('渠道库存'));

test('场景 2：卡片渲染出结论、标题与「查看报告」落点按钮', async () => {
  const html = await render(ReportCard, { card: linkedCard });

  assert.ok(html.includes('9月经营月报：订单交付偏差'), '报告标题应渲染');
  assert.ok(html.includes('订单交付达成 87%'), '结论应渲染');
  assert.ok(html.includes('RPT-2026-09-01'), '报告编码应渲染');
  assert.ok(html.includes('交付'), '责任域标签应渲染');
  assert.equal(count(html, /data-testid="open-report"/g), 1, '每张卡片一个落点按钮');
});

test('判定标准：卡片上三类关联入口全部渲染（有关联显示条数）', async () => {
  const html = await render(ReportCard, { card: linkedCard });

  assert.equal(count(html, /data-entry="todo"/g), 1);
  assert.equal(count(html, /data-entry="decision"/g), 1);
  assert.equal(count(html, /data-entry="evidence"/g), 1);
  assert.ok(html.includes('关联入口'), '关联入口区标题应渲染');
  assert.equal(count(html, /class="view-nav-count"/g), 3, '三条入口均有关联');
});

test('边界：无关联报告卡片渲染出三个置灰入口与「无关联」提示', async () => {
  const html = await render(ReportCard, { card: orphanCard });

  assert.equal(count(html, /data-entry="/g), 3);
  assert.equal(count(html, /data-testid="entry-disabled"/g), 3, '三条入口均置灰');
  assert.equal(count(html, new RegExp(`>${NO_LINK_HINT}</span>`, 'g')), 3, '「无关联」文案可见');
  assert.equal(count(html, /class="view-nav-count"/g), 0, '置灰入口不显示条数');
});

test('场景 2：卡片的关键指标计数与无数据计数可见', async () => {
  const html = await render(ReportCard, { card: orphanCard });

  assert.equal(count(html, /data-testid="card-metrics"/g), 1);
  assert.ok(html.includes('关键结果指标'));
  assert.equal(count(html, /data-testid="card-nodata"/g), 1);
  assert.ok(html.includes('无数据'));
  assert.ok(html.includes('偏差超阈值'));
});

test('场景 2：详情的关键指标模型渲染出目标值 / 实际值 / 偏差（含超阈值标记）', async () => {
  const model = buildReportDetailModel(REPORT_DETAIL);
  const html = await render(ResultMetricTable, { model: model.metricModel });

  assert.equal(count(html, /data-testid="metric-row"/g), 2);
  assert.ok(html.includes('订单交付达成率'));
  assert.ok(html.includes('100%'), '目标值应渲染');
  assert.ok(html.includes('87%'), '实际值应渲染');
  assert.ok(html.includes('-13%'), '偏差值应渲染');
  assert.equal(count(html, /data-testid="metric-exceeded"/g), 1, '超阈值指标应打标');
  assert.ok(html.includes('报告不自己取数'), '取数口径红线在界面上可见');
  assert.equal(count(html, /data-testid="metric-nodata"/g), 0);
});

test('场景 2：详情的关键指标无数据时渲染「无数据」与成因，而不是 0', async () => {
  const model = buildReportDetailModel(REPORT_DETAIL_ORPHAN);
  const html = await render(ResultMetricTable, { model: model.metricModel });

  assert.equal(count(html, /data-testid="metric-nodata"/g), 1);
  assert.ok(html.includes('来源模块未同步本期数据'), '无数据成因应可见');
  assert.ok(html.includes('新增客户数'));
});

test('边界：详情中全部无关联时渲染出三个置灰入口', async () => {
  const model = buildReportDetailModel(REPORT_DETAIL_ORPHAN);
  const html = await render(ViewNavBar, { model: model.navModel });

  const disabledGroups = (html.match(/<div class="[^"]*\bview-nav-group\b[^"]*"/g) || []).filter((tag) =>
    /\bdisabled\b/.test(tag)
  );
  assert.equal(disabledGroups.length, 3);
  assert.equal(count(html, new RegExp(`>${NO_LINK_HINT}</span>`, 'g')), 3);
  assert.equal(count(html, /class="view-nav-link"/g), 0, '置灰入口不渲染落点');
});

test('场景 2：详情中有关系的入口渲染出可点击落点', async () => {
  const model = buildReportDetailModel(REPORT_DETAIL);
  const html = await render(ViewNavBar, { model: model.navModel });

  assert.equal(count(html, /class="view-nav-link"/g), 3);
  assert.ok(html.includes('2号线排产调整以补产能缺口'), 'TODO 落点标题应渲染');
  assert.ok(html.includes('采购框架合同 SC-2026-014'), 'Evidence 落点标题应渲染');
});
