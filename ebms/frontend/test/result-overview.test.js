// F1（PAND-79）经营结果指标集：展示模型单测。
// 覆盖 AC：目标值/实际值/偏差值、无数据（来源模块未供给）不显示 0 或空白、
// 口径版本与证据引用可见、偏差超阈值醒目提示。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVIATION_LABEL,
  NO_DATA_LABEL,
  buildMetricTile,
  buildOverviewModel,
  cutoffText,
  periodLabel,
} from '../src/result-overview.js';
import { OVERVIEW, supplied } from './fixtures/result-overview-payload.js';

test('场景 1：指标集逐条渲染出代码、名称、归属模块与数据截止时间', () => {
  const model = buildOverviewModel(OVERVIEW);

  assert.equal(model.tiles.length, 5);
  assert.equal(model.configuredCount, 5, '配置的指标集条目数');
  assert.equal(model.tiles[0].code, 'revenue');
  assert.equal(model.tiles[0].name, '营业收入');
  assert.equal(model.tiles[0].ownerModule, 'M09');
  assert.equal(model.tiles[0].ownerLabel, 'M09 财经自治');
  assert.equal(model.tiles[0].ownerScope, '收入 / 成本 / 毛利 / 现金 / 应收应付', '模块职责范围可作补充说明');
  assert.equal(model.tiles[0].dimensionLabel, '财务');
  assert.equal(model.tiles[0].cutoff, '2026-09-26', '每条指标都有数据截止时间');
  assert.ok(model.periodLabel.length > 0);

  // 无数据的两条同样占位呈现，不得被过滤掉
  for (const tile of model.tiles) {
    assert.ok(tile.name && tile.code);
    assert.ok(tile.cutoff, `${tile.code} 缺数据截止时间`);
  }
});

test('场景 1：目标值、实际值、偏差值三者同时可见，偏差 = 实际值 − 目标值', () => {
  const model = buildOverviewModel(OVERVIEW);
  const revenue = model.tiles.find((t) => t.code === 'revenue');

  assert.equal(revenue.targetText, '12000000元');
  assert.equal(revenue.actualText, '11280000元');
  assert.equal(revenue.deviationText, '-720000元');
  assert.equal(revenue.deviationPctText, '-6%');
  assert.equal(revenue.deviationFormula, DEVIATION_LABEL);
  assert.equal(revenue.attainmentLabel, '未达标');
  // 抽查：偏差值确实等于 实际值 − 目标值
  assert.equal(Number(revenue.deviationText.replace('元', '')), 11280000 - 12000000);
});

test('判定：|偏差率| 超过阈值 → 醒目提示；未超过 → 不提示', () => {
  const model = buildOverviewModel(OVERVIEW);
  // 收入 -6% 超 5% 阈值
  assert.equal(model.tiles.find((t) => t.code === 'revenue').exceeded, true);
  // 成本对 lower_better 而言 +13.67% 仍是不利偏差，超阈值
  const cost = model.tiles.find((t) => t.code === 'operating_cost');
  assert.equal(cost.exceeded, true);
  assert.equal(cost.attainmentLabel, '未达标');
  assert.equal(cost.deviationText, '410000元');
  // 毛利率 +3.2% 未超阈值
  const gm = model.tiles.find((t) => t.code === 'gross_margin_rate');
  assert.equal(gm.exceeded, false);
  assert.equal(gm.attainmentLabel, '达标');
  assert.equal(gm.thresholdPct, 5);
});

test('边界：无数据时实际值与偏差都显示「无数据」，绝不显示 0 或空白', () => {
  const model = buildOverviewModel(OVERVIEW);
  const noDataTiles = model.tiles.filter((t) => t.noData);

  assert.equal(noDataTiles.length, 2);
  for (const tile of noDataTiles) {
    assert.equal(tile.noData, true);
    assert.equal(tile.actualText, NO_DATA_LABEL);
    assert.equal(tile.deviationText, NO_DATA_LABEL);
    assert.equal(tile.deviationPctText, null);
    assert.equal(tile.attainmentLabel, null);
    assert.equal(tile.exceeded, false);
    assert.notEqual(tile.actualText, '0');
    assert.ok(tile.actualText.length > 0, '不得为空白');
    assert.ok(tile.noDataReason, '必须给出无数据的原因说明');
    assert.ok(tile.noDataReason.includes('来源模块未'), '原因须指向来源模块未供给/未同步');
  }
});

test('边界：无数据的两种原因可区分（未供给 / 未同步本期）', () => {
  const model = buildOverviewModel(OVERVIEW);

  assert.equal(model.tiles.find((t) => t.code === 'new_customer_count').noDataReason, '来源模块未同步本期数据');
  assert.equal(model.tiles.find((t) => t.code === 'capacity_utilization').noDataReason, '来源模块未供给');
  assert.equal(model.noDataCount, 2);
  assert.equal(model.suppliedCount, 3);
});

test('场景 4：每条指标可查看口径版本与证据引用，且由证据可达', () => {
  const model = buildOverviewModel(OVERVIEW);
  const revenue = model.tiles.find((t) => t.code === 'revenue');

  assert.equal(revenue.calculationVersion, 'FIN-2026.09.1');
  assert.equal(revenue.resultId, 'RES-M09-REV-202609');
  assert.equal(revenue.sourceModule, 'M09');
  assert.deepEqual(revenue.evidenceIds, ['bbbbbbbb-0006-4000-8000-000000000006']);
  assert.equal(revenue.evidence.length, 1);
  assert.equal(revenue.evidence[0].href, '#/evidence/bbbbbbbb-0006-4000-8000-000000000006', '证据引用须可定位');
  assert.equal(revenue.evidence[0].title, '9月财务结算报表');

  // 已供给的 3 项均有口径版本与证据引用，抽查无缺项
  const suppliedTiles = model.tiles.filter((t) => !t.noData);
  assert.equal(suppliedTiles.length, 3);
  for (const tile of suppliedTiles) {
    assert.ok(tile.calculationVersion, `${tile.code} 缺 calculation_version`);
    assert.ok(tile.evidenceIds.length > 0, `${tile.code} 缺 evidence_ids`);
    assert.ok(tile.resultId, `${tile.code} 缺 Owner Result 标识`);
  }
  assert.equal(model.traceableCount, 3);
  assert.equal(model.allTraceable, true);
  assert.ok(model.traceabilityNotice.includes('抽查 100% 无缺项'));
});

test('边界：来源证据未在本系统登记时给出可读说明而非死链', () => {
  const tile = buildMetricTile(
    supplied({
      evidence: [
        {
          id: 'ffffffff-0001-4000-8000-000000000001',
          resolved: false,
          title: '来源证据未在本系统登记',
          typeLabel: null,
          viewPath: null,
        },
      ],
    })
  );

  assert.equal(tile.evidence[0].resolved, false);
  assert.equal(tile.evidence[0].href, null, '未登记的来源证据不得生成跳转链接');
  assert.equal(tile.evidence[0].title, '来源证据未在本系统登记');
});

test('红线：界面自述数据来源口径（实际值来自 Owner Result、偏差不重算）', () => {
  const model = buildOverviewModel(OVERVIEW);

  assert.ok(model.sourceNotice.includes('实际值 100% 来自专业 Owner 模块'));
  assert.ok(model.sourceNotice.includes('M05 销售 / M06 交付 / M09 财经'));
  assert.ok(model.sourceNotice.includes('目标值来自 M03'));
  assert.ok(model.sourceNotice.includes('偏差值 = 实际值 − 目标值'));
  assert.ok(model.sourceNotice.includes('EBMS 不重算专业指标'));
});

test('场景 1：统计条给出配置条目数 / 已供给 / 无数据 / 可追溯计数', () => {
  const model = buildOverviewModel(OVERVIEW);
  const byKey = Object.fromEntries(model.stats.map((s) => [s.key, s.value]));

  assert.deepEqual(byKey, { configured: 5, supplied: 3, nodata: 2, traceable: 3 });
});

test('边界：目标值为 0 时偏差率不显示，但绝对偏差仍可读', () => {
  const model = buildOverviewModel({
    period: { periodType: 'month', periodValue: '2026-09' },
    items: [
      supplied({
        targetValue: 0,
        actualValue: 500,
        deviation: {
          formula: DEVIATION_LABEL,
          pctFormula: '（实际值 − 目标值）÷ |目标值| × 100%',
          direction: 'higher_better',
          thresholdPct: 5,
          computable: true,
          value: 500,
          pct: null,
          exceeded: null,
          attainment: 'ACHIEVED',
          reason: null,
        },
      }),
    ],
  });

  const tile = model.tiles[0];
  assert.equal(tile.targetText, '0元');
  assert.equal(tile.actualText, '500元');
  assert.equal(tile.deviationText, '500元');
  assert.equal(tile.deviationPctText, null, '目标值为 0 时偏差率无意义，不得显示 Infinity/NaN');
});

test('周期文案：月/周/缺失各有可读标签', () => {
  assert.equal(periodLabel('month', '2026-09'), '2026年09月');
  assert.equal(periodLabel('week', '2026-W36'), '2026年第36周');
  assert.equal(periodLabel('day', '2026-09-26'), '2026-09-26');
  assert.equal(periodLabel('month', null), '未配置周期');
});

test('数据截止：只取日期部分，避免时区把日期显示偏移一天', () => {
  assert.equal(cutoffText('2026-09-26T03:00:00.000Z'), '2026-09-26');
  assert.equal(cutoffText('2026-09-26'), '2026-09-26');
  assert.equal(cutoffText(null), null);
});
