// F4（PAND-82）渲染判定：场景 1/2/3 的字段与边界标记必须真的出现在 HTML 里，
// 而不只是存在于模型对象中。用 Vite SSR 编译真实 SFC 后渲染断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';

import { buildSourceView, buildSourceStatsView, buildMissingListView } from '../src/source-view.js';

let vite;
let SourceDetailPanel;
let SourceMissingPanel;
let EvidenceDetailPanel;

test.before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  SourceDetailPanel = (await vite.ssrLoadModule('/src/components/SourceDetailPanel.vue')).default;
  SourceMissingPanel = (await vite.ssrLoadModule('/src/components/SourceMissingPanel.vue')).default;
  EvidenceDetailPanel = (await vite.ssrLoadModule('/src/components/EvidenceDetailPanel.vue')).default;
});

test.after(async () => {
  await vite?.close();
});

const MANUAL_DETAIL = {
  evidence: { id: 'e-manual', typeLabel: '人工说明', title: '线下登记：设备检修记录' },
  sourceMissing: false,
  missingMarker: null,
  sourceType: 'manual',
  sourceTypeLabel: '人工录入',
  sourceSystem: '线下登记表',
  sourceDocumentNo: null,
  sourceDataTime: '2026-09-28T16:00:00.000Z',
  sourceProvider: null,
  enteredBy: '钱厂长',
  enteredAt: '2026-09-30T01:20:00.000Z',
  updateCycle: 'week',
  updateCycleLabel: '周',
  dataCutoffAt: '2026-09-28T16:00:00.000Z',
  display: [
    { key: 'sourceSystem', label: '来源系统', value: '线下登记表' },
    { key: 'sourceDocumentNo', label: '来源单据编号', value: null },
    { key: 'sourceDataTime', label: '来源数据时间', value: '2026-09-28T16:00:00.000Z' },
    { key: 'sourceProvider', label: '提供方', value: null },
  ],
  manualDisplay: [
    { key: 'enteredBy', label: '录入人', value: '钱厂长' },
    { key: 'enteredAt', label: '录入时间', value: '2026-09-30T01:20:00.000Z' },
  ],
  pendingFields: ['sourceDocumentNo'],
  pendingFieldLabels: ['来源单据编号'],
};

const EXTERNAL_DETAIL = {
  ...MANUAL_DETAIL,
  evidence: { id: 'e-external', typeLabel: '合同', title: 'A 供应商年度供货合同' },
  sourceType: 'external',
  sourceTypeLabel: '外部数据',
  sourceSystem: 'A 供应商门户',
  sourceDocumentNo: 'SUP-A-2026-0901',
  sourceProvider: 'A 供应商（外部）',
  enteredBy: null,
  enteredAt: null,
  updateCycle: 'day',
  updateCycleLabel: '日',
  manualDisplay: [],
  display: [
    { key: 'sourceSystem', label: '来源系统', value: 'A 供应商门户' },
    { key: 'sourceDocumentNo', label: '来源单据编号', value: 'SUP-A-2026-0901' },
    { key: 'sourceDataTime', label: '来源数据时间', value: '2026-09-28T16:00:00.000Z' },
    { key: 'sourceProvider', label: '提供方', value: 'A 供应商（外部）' },
  ],
};

const MISSING_DETAIL = {
  evidence: { id: 'e-missing', typeLabel: '文档', title: '9月产能分析报告' },
  sourceMissing: true,
  missingMarker: '来源缺失',
  sourceType: null,
  sourceTypeLabel: null,
  sourceSystem: null,
  sourceDocumentNo: null,
  sourceDataTime: null,
  sourceProvider: null,
  enteredBy: null,
  enteredAt: null,
  updateCycle: null,
  updateCycleLabel: null,
  dataCutoffAt: null,
  display: [
    { key: 'sourceSystem', label: '来源系统', value: null },
    { key: 'sourceDocumentNo', label: '来源单据编号', value: null },
    { key: 'sourceDataTime', label: '来源数据时间', value: null },
    { key: 'sourceProvider', label: '提供方', value: null },
  ],
  manualDisplay: [],
  pendingFields: ['sourceSystem', 'sourceDataTime', 'sourceDocumentNo'],
  pendingFieldLabels: ['来源系统', '来源数据时间', '来源单据编号'],
};

function renderPanel(component, props) {
  return renderToString(createSSRApp(component, props));
}

test('场景 1：四项来源明细在面板上可见（含标签与取值）', async () => {
  const html = await renderPanel(SourceDetailPanel, { model: buildSourceView(EXTERNAL_DETAIL) });

  assert.ok(html.includes('来源（Source）'), '来源区块标题');
  for (const label of ['来源系统', '来源单据编号', '来源数据时间', '提供方']) {
    assert.ok(html.includes(`<dt>${label}</dt>`), `应渲染字段标签：${label}`);
  }
  assert.ok(html.includes('A 供应商门户'));
  assert.ok(html.includes('SUP-A-2026-0901'));
  assert.ok(html.includes('A 供应商（外部）'));
});

test('场景 2：人工录入来源渲染出录入人与录入时间', async () => {
  const html = await renderPanel(SourceDetailPanel, { model: buildSourceView(MANUAL_DETAIL) });

  assert.ok(html.includes('<dt>录入人</dt>'));
  assert.ok(html.includes('钱厂长'));
  assert.ok(html.includes('<dt>录入时间</dt>'));
  assert.ok(html.includes('source-manual-grid'), '追加字段自成一组，与场景 1 字段区分');
});

test('场景 2：非人工录入来源不出现录入人 / 录入时间', async () => {
  const html = await renderPanel(SourceDetailPanel, { model: buildSourceView(EXTERNAL_DETAIL) });

  assert.equal(html.includes('<dt>录入人</dt>'), false);
  assert.equal(html.includes('<dt>录入时间</dt>'), false);
});

test('场景 3：外部数据渲染提供方，内部系统渲染为待补而非编造', async () => {
  const external = await renderPanel(SourceDetailPanel, { model: buildSourceView(EXTERNAL_DETAIL) });
  assert.ok(external.includes('外部数据'));
  assert.ok(external.includes('A 供应商（外部）'));

  const internalMissingProvider = {
    ...MANUAL_DETAIL,
    sourceTypeLabel: '内部系统',
    manualDisplay: [],
    display: MANUAL_DETAIL.display.map((f) =>
      f.key === 'sourceProvider' ? { ...f, value: null } : f
    ),
  };
  const internal = await renderPanel(SourceDetailPanel, { model: buildSourceView(internalMissingProvider) });
  assert.ok(internal.includes('内部系统'));
  assert.ok(internal.includes('—'), '无提供方时渲染占位符');
});

test('口径：面板展示数据截止时间与周期更新说明（非实时）', async () => {
  const html = await renderPanel(SourceDetailPanel, { model: buildSourceView(EXTERNAL_DETAIL) });

  assert.ok(html.includes('按日更新'));
  assert.ok(html.includes('数据截止时间'));
  assert.ok(html.includes('周期更新，非实时'));
});

test('边界：无 Source 的证据渲染「来源缺失」标记与待补字段', async () => {
  const html = await renderPanel(SourceDetailPanel, { model: buildSourceView(MISSING_DETAIL) });

  assert.ok(html.includes('来源缺失'), '标记文案必须可见');
  assert.ok(html.includes('已计入待补清单'));
  assert.ok(html.includes('<dt>待补字段</dt>'));
  assert.ok(html.includes('来源系统、来源数据时间、来源单据编号'));
});

test('集成：证据详情面板内嵌来源区块', async () => {
  const html = await renderPanel(EvidenceDetailPanel, {
    evidence: { typeLabel: '合同', title: 'A 供应商年度供货合同', owner: '李采购', attachmentCount: 0, attachments: [] },
    source: EXTERNAL_DETAIL,
  });

  assert.ok(html.includes('证据详情'));
  assert.ok(html.includes('来源（Source）'), 'F4 区块应内嵌在证据详情中');
  assert.ok(html.includes('A 供应商门户'));
});

const STATS = {
  totalCount: 7,
  missingCount: 1,
  missingRate: 0.1429,
  missingRateLabel: '14.29%',
  coverage: { internal: 4, external: 1, manual: 1, missing: 1 },
  criteria: {
    externalProviderNonEmpty: { scope: '外部来源记录的「提供方」字段非空', externalCount: 1, providerNonEmptyCount: 1, satisfied: true },
    manualTraceNonEmpty: { scope: '人工录入来源的 录入人、录入时间 均非空', manualCount: 1, traceNonEmptyCount: 1, satisfied: true },
  },
};

const MISSING_LIST = {
  marker: '来源缺失',
  total: 1,
  items: [
    {
      evidenceId: 'e-missing',
      title: '9月产能分析报告',
      typeLabel: '文档',
      formedAt: '2026-09-28T16:00:00.000Z',
      owner: '钱厂长',
      pendingFieldLabels: ['来源系统', '来源数据时间', '来源单据编号'],
      reasons: [{ id: 'r1', name: '产能不足' }],
    },
  ],
};

test('判定标准 1：待补视图渲染缺失率及其算式', async () => {
  const html = await renderPanel(SourceMissingPanel, {
    stats: buildSourceStatsView(STATS),
    list: buildMissingListView(MISSING_LIST),
  });

  assert.ok(html.includes('14.29%'), '缺失率可统计且可见');
  assert.ok(html.includes('1 ÷ 7'), '算式可见，口径可核对');
  assert.ok(html.includes('证据总条数'));
  assert.ok(html.includes('7 条'));
});

test('判定标准 1：0/0 时渲染为「范围内无证据」，不显示 0%', async () => {
  const emptyStats = {
    totalCount: 0,
    missingCount: 0,
    missingRate: null,
    missingRateLabel: null,
    coverage: { internal: 0, external: 0, manual: 0, missing: 0 },
    criteria: {
      externalProviderNonEmpty: { scope: '外部来源记录的「提供方」字段非空', externalCount: 0, providerNonEmptyCount: 0, satisfied: true },
      manualTraceNonEmpty: { scope: '人工录入来源的 录入人、录入时间 均非空', manualCount: 0, traceNonEmptyCount: 0, satisfied: true },
    },
  };
  const html = await renderPanel(SourceMissingPanel, {
    stats: buildSourceStatsView(emptyStats),
    list: buildMissingListView({ marker: '来源缺失', total: 0, items: [] }),
  });

  assert.ok(html.includes('范围内无证据'));
  assert.equal(html.includes('0.00%'), false, '不得把 0/0 渲染成 0%');
});

test('判定标准 2/3：核对结果与满足状态在界面上可见', async () => {
  const html = await renderPanel(SourceMissingPanel, {
    stats: buildSourceStatsView(STATS),
    list: buildMissingListView(MISSING_LIST),
  });

  assert.ok(html.includes('外部来源记录的「提供方」字段非空'));
  assert.ok(html.includes('人工录入来源的 录入人、录入时间 均非空'));
  assert.ok(html.includes('满足'));
  assert.equal(html.includes('不满足'), false);
});

test('边界：待补清单渲染证据、待补字段与关联原因项', async () => {
  const html = await renderPanel(SourceMissingPanel, {
    stats: buildSourceStatsView(STATS),
    list: buildMissingListView(MISSING_LIST),
  });

  assert.ok(html.includes('待补清单'));
  assert.ok(html.includes('9月产能分析报告'));
  assert.ok(html.includes('来源系统、来源数据时间、来源单据编号'));
  assert.ok(html.includes('产能不足'));
  assert.ok(html.includes('查看来源'), '待补项可直接跳到来源明细');
});

test('边界：无缺失时清单为空单元格，而非留白', async () => {
  const html = await renderPanel(SourceMissingPanel, {
    stats: buildSourceStatsView({ ...STATS, missingCount: 0, missingRate: 0, missingRateLabel: '0.00%', coverage: { internal: 5, external: 1, manual: 1, missing: 0 } }),
    list: buildMissingListView({ marker: '来源缺失', total: 0, items: [] }),
  });

  assert.ok(html.includes('没有来源缺失的证据。'));
});

test('边界：清单未挂原因项时明确说明，不显示空白', async () => {
  const html = await renderPanel(SourceMissingPanel, {
    stats: buildSourceStatsView(STATS),
    list: buildMissingListView({
      marker: '来源缺失',
      total: 1,
      items: [{ evidenceId: 'e2', title: '孤立证据', typeLabel: '文档', formedAt: null, owner: null, pendingFieldLabels: [], reasons: [] }],
    }),
  });

  assert.ok(html.includes('未挂载原因项'));
  assert.ok(html.includes('孤立证据'));
});
