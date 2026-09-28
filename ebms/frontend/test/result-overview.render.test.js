// F1（PAND-79）经营结果指标集：SSR 渲染断言。
// 用 Vite 的 SSR 模块加载器编译真实 SFC，再渲染成 HTML 断言，避免「只测模型不测展示」。
// 断言的是 AC 要求「看得见」的东西：指标集条目、目标值/实际值/偏差值、
// 无数据（来源模块未供给/未同步）、口径版本与证据引用、超阈值提示。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';

import { DEVIATION_LABEL, NO_DATA_LABEL, buildOverviewModel } from '../src/result-overview.js';
import { OVERVIEW } from './fixtures/result-overview-payload.js';

let vite;
let ResultMetricTable;

test.before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  const mod = await vite.ssrLoadModule('/src/components/ResultMetricTable.vue');
  ResultMetricTable = mod.default;
});

test.after(async () => {
  await vite?.close();
});

function render(payload = OVERVIEW) {
  return renderToString(createSSRApp(ResultMetricTable, { model: buildOverviewModel(payload) }));
}

/** 每条指标占一行；按行切分，避免跨行误判。 */
function rowsOf(html) {
  return html.split('<tr data-testid="metric-row"').slice(1).map((chunk) => chunk.split('</tr>')[0]);
}

function countTestId(html, testid) {
  return (html.match(new RegExp(`data-testid="${testid}"`, 'g')) || []).length;
}

/** 取某行内某个 data-testid 单元格的内容（到该 </td> 为止）。 */
function cellAfter(rowHtml, testid) {
  const idx = rowHtml.indexOf(`data-testid="${testid}"`);
  if (idx === -1) return null;
  return rowHtml.slice(idx).split('</td>')[0];
}

test('场景 1：指标集的每一条都渲染成一行，含名称、代码、归属模块与数据截止时间', async () => {
  const html = await render();
  const rows = rowsOf(html);

  assert.equal(rows.length, OVERVIEW.configuredCount, '条目数 = 配置的指标集条目数');
  assert.ok(html.includes('营业收入'), '指标名称应可见');
  assert.ok(html.includes('revenue'), '指标代码应可见');
  assert.ok(html.includes('M09 财经自治'), '归属模块应可见（实际值来源）');
  assert.ok(html.includes('2026-09-26'), '数据截止时间应可见');
  assert.ok(html.includes('目标值与实际值均为专业 Owner 模块口径'), '口径自述应可见');
  assert.equal(countTestId(html, 'metric-target'), OVERVIEW.configuredCount, '每条指标都有目标值列');
  assert.equal(countTestId(html, 'metric-actual'), OVERVIEW.configuredCount, '每条指标都有实际值列');
  assert.equal(countTestId(html, 'metric-deviation'), OVERVIEW.configuredCount, '每条指标都有偏差值列');
});

test('场景 1：目标值、实际值、偏差值三列同时渲染，偏差按「实际值 − 目标值」计算', async () => {
  const html = await render();
  const [revenue] = rowsOf(html);

  assert.ok(cellAfter(revenue, 'metric-target').includes('12000000元'), '目标值应可见');
  assert.ok(cellAfter(revenue, 'metric-actual').includes('11280000元'), '实际值应可见');
  const deviation = cellAfter(revenue, 'metric-deviation');
  assert.ok(deviation.includes('-720000元'), '偏差值应可见');
  assert.ok(deviation.includes('-6%'), '偏差率应可见');
  assert.ok(deviation.includes('未达标'), '达标判定应可见');
  assert.ok(html.includes(DEVIATION_LABEL), '偏差口径应写明');
});

test('判定：|偏差率| 超过阈值的指标带醒目提示，未超过的不带', async () => {
  const html = await render();
  const rows = rowsOf(html);
  const [revenue, grossMargin, cost] = rows;

  assert.equal(countTestId(html, 'metric-exceeded'), 2, '收入 -6%、成本 +13.67% 各提示一次');
  assert.ok(revenue.includes('超阈值'));
  assert.ok(cost.includes('超阈值'));
  assert.ok(!grossMargin.includes('超阈值'), '毛利率 +3.2% 未超阈值，不应提示');
});

test('边界：无数据的指标渲染「无数据」与「来源模块未供给/未同步」，不渲染 0 或空白', async () => {
  const html = await render();
  const rows = rowsOf(html);
  const [revenue, , , newCustomer, capacity] = rows;

  assert.equal(countTestId(html, 'metric-nodata'), 2, '两条无数据指标各有一处「无数据」实际值');
  assert.equal(countTestId(html, 'metric-nodata-reason'), 2);
  assert.ok(newCustomer.includes('来源模块未同步本期数据'));
  assert.ok(capacity.includes('来源模块未供给'));
  // 逐条核对实际值单元格：只有「无数据」与原因说明，不含任何数字（绝不显示 0）
  for (const [row, reason] of [
    [newCustomer, '来源模块未同步本期数据'],
    [capacity, '来源模块未供给'],
  ]) {
    const actual = cellAfter(row, 'metric-actual');
    assert.ok(actual.includes(NO_DATA_LABEL));
    assert.ok(actual.includes(reason));
    assert.equal(/\d/.test(actual), false, `无数据实际值不得含数字：${actual}`);
    assert.ok(cellAfter(row, 'metric-deviation').includes(NO_DATA_LABEL), '偏差一并显示「无数据」');
  }
  // 无数据行不得出现超阈值提示
  assert.ok(!newCustomer.includes('超阈值') && !capacity.includes('超阈值'));
  // 醒目提示条渲染，并说明 EBMS 不兜底计算
  assert.ok(html.includes('EBMS 不兜底计算'));
  assert.ok(!revenue.includes(NO_DATA_LABEL), '已供给的指标不应出现「无数据」');
});

test('场景 4：口径版本、结果标识与证据引用在每一行可见，且证据引用可点击定位', async () => {
  const html = await render();
  const rows = rowsOf(html);

  assert.equal(countTestId(html, 'metric-version'), OVERVIEW.items.length, '每行都展示口径版本');
  assert.equal(countTestId(html, 'metric-result-id'), OVERVIEW.items.length, '每行都展示 Owner Result 标识');
  assert.ok(html.includes('FIN-2026.09.1'), '口径版本应可见');
  assert.ok(html.includes('RES-M09-REV-202609'), 'Owner Result 标识应可见');
  assert.ok(html.includes('9月财务结算报表'), '证据标题应可见');
  assert.equal(countTestId(html, 'evidence-chip'), 3, '三条已供给指标各有一个可点击证据引用');
  assert.ok(
    html.includes('href="#/evidence/bbbbbbbb-0006-4000-8000-000000000006"'),
    '证据引用须指向可定位的落点'
  );
  assert.equal(countTestId(html, 'evidence-chip-unresolved'), 0);
  // 已供给行不出现「无证据引用」占位
  assert.equal(countTestId(html, 'metric-evidence-empty'), 2, '仅两条无数据指标无证据引用');

  assert.ok(rows[0].includes('FIN-2026.09.1'));
});

test('边界：来源证据未在本系统登记时渲染为不可点击的说明，不生成死链', async () => {
  const payload = {
    ...OVERVIEW,
    items: [
      {
        ...OVERVIEW.items[0],
        traceability: {
          ...OVERVIEW.items[0].traceability,
          evidenceIds: ['ffffffff-0001-4000-8000-000000000001'],
          evidence: [
            {
              id: 'ffffffff-0001-4000-8000-000000000001',
              resolved: false,
              typeLabel: null,
              title: '来源证据未在本系统登记',
              formedAt: null,
              owner: null,
              viewPath: null,
            },
          ],
        },
      },
    ],
  };
  const html = await render(payload);

  assert.equal(countTestId(html, 'evidence-chip-unresolved'), 1);
  assert.equal(countTestId(html, 'evidence-chip'), 0, '未登记的来源证据不得渲染成链接');
  assert.ok(html.includes('来源证据未在本系统登记'));
});

test('红线：界面自述数据来源口径，Owner Result / M03 目标值 / 不重算均可见', async () => {
  const html = await render();

  assert.ok(html.includes('实际值 100% 来自专业 Owner 模块'), '来源口径须在界面上可见');
  assert.ok(html.includes('目标值来自 M03'));
  assert.ok(html.includes('EBMS 不重算专业指标'));
  assert.ok(html.includes('抽查 100% 无缺项'), '可追溯性结论须可见');
});

test('场景 1：统计条渲染出配置条目数与已供给/无数据/可追溯计数', async () => {
  const html = await render();

  assert.ok(html.includes('>5</span>'), '配置指标数 5 应渲染');
  assert.ok(html.includes('>3</span>'), '已供给 3 应渲染');
  assert.ok(html.includes('>2</span>'), '无数据 2 应渲染');
  assert.ok(html.includes('口径版本+证据无缺项'), '可追溯计数标签应渲染');
});
