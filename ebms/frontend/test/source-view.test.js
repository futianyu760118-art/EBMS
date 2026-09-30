// F4（PAND-82）展示模型：逐条覆盖 场景 1/2/3 + 边界 + 判定标准 的界面口径。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSourceView,
  buildSourceSummary,
  buildSourceStatsView,
  buildMissingListView,
  SOURCE_MISSING_MARKER,
} from '../src/source-view.js';
import { formatDateTime } from '../src/format.js';

const DATA_TIME = '2026-09-28T16:00:00.000Z';
const ENTERED_AT = '2026-09-30T01:20:00.000Z';

/** 场景 3-a：内部系统来源（无提供方、无录入人）。 */
const INTERNAL_DETAIL = {
  evidence: { id: 'e-internal', typeLabel: '系统记录', title: 'ERP 出库流水' },
  sourceMissing: false,
  missingMarker: null,
  sourceType: 'internal',
  sourceTypeLabel: '内部系统',
  sourceSystem: 'ERP',
  sourceDocumentNo: 'ERP-OUT-2026-0901',
  sourceDataTime: DATA_TIME,
  sourceProvider: null,
  enteredBy: null,
  enteredAt: null,
  updateCycle: 'day',
  updateCycleLabel: '日',
  dataCutoffAt: DATA_TIME,
  display: [
    { key: 'sourceSystem', label: '来源系统', value: 'ERP' },
    { key: 'sourceDocumentNo', label: '来源单据编号', value: 'ERP-OUT-2026-0901' },
    { key: 'sourceDataTime', label: '来源数据时间', value: DATA_TIME },
    { key: 'sourceProvider', label: '提供方', value: null },
  ],
  manualDisplay: [],
  pendingFields: ['sourceDocumentNo'],
  pendingFieldLabels: ['来源单据编号'],
};

/** 场景 3-b：外部数据来源（提供方必填）。 */
const EXTERNAL_DETAIL = {
  ...INTERNAL_DETAIL,
  sourceType: 'external',
  sourceTypeLabel: '外部数据',
  sourceSystem: 'A 供应商门户',
  sourceProvider: 'A 供应商（外部）',
  display: [
    { key: 'sourceSystem', label: '来源系统', value: 'A 供应商门户' },
    { key: 'sourceDocumentNo', label: '来源单据编号', value: 'ERP-OUT-2026-0901' },
    { key: 'sourceDataTime', label: '来源数据时间', value: DATA_TIME },
    { key: 'sourceProvider', label: '提供方', value: 'A 供应商（外部）' },
  ],
};

/** 场景 2：人工录入来源（额外带录入人 / 录入时间）。 */
const MANUAL_DETAIL = {
  ...INTERNAL_DETAIL,
  sourceType: 'manual',
  sourceTypeLabel: '人工录入',
  sourceSystem: '线下登记表',
  updateCycle: 'week',
  updateCycleLabel: '周',
  enteredBy: '钱厂长',
  enteredAt: ENTERED_AT,
  manualDisplay: [
    { key: 'enteredBy', label: '录入人', value: '钱厂长' },
    { key: 'enteredAt', label: '录入时间', value: ENTERED_AT },
  ],
};

/** 边界：无 Source 的证据。 */
const MISSING_DETAIL = {
  evidence: { id: 'e-missing', typeLabel: '文档', title: '9月产能分析报告' },
  sourceMissing: true,
  missingMarker: SOURCE_MISSING_MARKER,
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

test('场景 1：来源系统、来源单据编号、来源数据时间、提供方四项明细齐全', () => {
  const model = buildSourceView(EXTERNAL_DETAIL);

  assert.deepEqual(
    model.rows.map((r) => r.label),
    ['来源系统', '来源单据编号', '来源数据时间', '提供方'],
    '四项展示字段（顺序固定）'
  );
  assert.equal(model.rows[0].value, 'A 供应商门户');
  assert.equal(model.rows[1].value, 'ERP-OUT-2026-0901');
  assert.equal(model.rows[2].value, formatDateTime(DATA_TIME), '来源数据时间按本地时区展示');
  assert.equal(model.rows[3].value, 'A 供应商（外部）');
  assert.equal(model.rows.some((r) => r.empty), false);
});

test('场景 1：字段缺失时展示占位符而非空白（不把「没值」渲染成「有值」）', () => {
  const model = buildSourceView(INTERNAL_DETAIL);
  const provider = model.rows.find((r) => r.key === 'sourceProvider');

  assert.equal(provider.value, '—');
  assert.equal(provider.empty, true, '空字段需带 empty 标记，供渲染区分');
});

test('口径：数据为周期更新，展示更新周期与数据截止时间', () => {
  const model = buildSourceView(EXTERNAL_DETAIL);

  assert.equal(model.cycleText, '按日更新');
  assert.equal(model.cutoffText, formatDateTime(DATA_TIME));
});

test('场景 2：人工录入来源额外展示录入人与录入时间', () => {
  const model = buildSourceView(MANUAL_DETAIL);

  assert.deepEqual(model.manualRows.map((r) => r.label), ['录入人', '录入时间']);
  assert.equal(model.manualRows[0].value, '钱厂长');
  assert.equal(model.manualRows[1].value, formatDateTime(ENTERED_AT));
});

test('场景 2：非人工录入来源不展示录入人 / 录入时间', () => {
  for (const detail of [INTERNAL_DETAIL, EXTERNAL_DETAIL]) {
    assert.equal(buildSourceView(detail).manualRows.length, 0, `${detail.sourceType} 不应有追加字段`);
  }
});

test('场景 3：内部系统与外部数据可通过类别标签区分，外部数据带提供方', () => {
  const internal = buildSourceView(INTERNAL_DETAIL);
  const external = buildSourceView(EXTERNAL_DETAIL);

  assert.equal(internal.typeLabel, '内部系统');
  assert.equal(external.typeLabel, '外部数据');
  assert.notEqual(internal.typeLabel, external.typeLabel);
  assert.equal(external.rows.find((r) => r.key === 'sourceProvider').value, 'A 供应商（外部）');
});

test('边界：无 Source 的证据标记「来源缺失」并列出全部待补字段', () => {
  const model = buildSourceView(MISSING_DETAIL);

  assert.equal(model.missing, true);
  assert.equal(model.marker, SOURCE_MISSING_MARKER);
  assert.equal(model.pendingText, '来源系统、来源数据时间、来源单据编号');
  assert.equal(model.rows.every((r) => r.empty), true);
});

test('边界：列表行摘要也能一眼看出「来源缺失」', () => {
  assert.deepEqual(buildSourceSummary(null), { label: '—', missing: false, marker: null });
  assert.deepEqual(
    buildSourceSummary({ sourceMissing: true, missingMarker: SOURCE_MISSING_MARKER }),
    { label: '—', missing: true, marker: SOURCE_MISSING_MARKER }
  );
  assert.deepEqual(
    buildSourceSummary({ sourceMissing: false, sourceTypeLabel: '外部数据', sourceSystem: 'A 供应商门户' }),
    { label: 'A 供应商门户', typeLabel: '外部数据', missing: false, marker: null }
  );
});

test('判定标准 1：来源缺失率 = 缺失条数 ÷ 总条数，并给出覆盖分布', () => {
  const model = buildSourceStatsView({
    totalCount: 7,
    missingCount: 1,
    missingRate: 0.1429,
    missingRateLabel: '14.29%',
    coverage: { internal: 4, external: 1, manual: 1, missing: 1 },
    criteria: {
      externalProviderNonEmpty: { scope: '外部来源记录的「提供方」字段非空', externalCount: 1, providerNonEmptyCount: 1, satisfied: true },
      manualTraceNonEmpty: { scope: '人工录入来源的 录入人、录入时间 均非空', manualCount: 1, traceNonEmptyCount: 1, satisfied: true },
    },
  });

  assert.equal(model.totalText, '7 条');
  assert.equal(model.missingText, '1 条');
  assert.equal(model.rateText, '14.29%');
  assert.equal(model.rateFormula, '1 ÷ 7', '公式可见，口径可核对');
  assert.equal(model.hasMissing, true);
  assert.deepEqual(
    model.coverageRows.map((r) => [r.label, r.count]),
    [['内部系统', 4], ['外部数据', 1], ['人工录入', 1], [SOURCE_MISSING_MARKER, 1]]
  );
});

test('判定标准 1：范围内无证据时缺失率不展示为 0%（0/0 不是「无缺失」）', () => {
  const model = buildSourceStatsView({
    totalCount: 0,
    missingCount: 0,
    missingRate: null,
    missingRateLabel: null,
    coverage: { internal: 0, external: 0, manual: 0, missing: 0 },
    criteria: {
      externalProviderNonEmpty: { scope: '外部来源记录的「提供方」字段非空', externalCount: 0, providerNonEmptyCount: 0, satisfied: true },
      manualTraceNonEmpty: { scope: '人工录入来源的 录入人、录入时间 均非空', manualCount: 0, traceNonEmptyCount: 0, satisfied: true },
    },
  });

  assert.equal(model.rateText, '—（范围内无证据）');
  assert.match(model.rateText, /不适用|范围内无证据/);
  assert.equal(model.hasMissing, false);
});

test('判定标准 2/3：核对项直接暴露不满足状态', () => {
  const model = buildSourceStatsView({
    totalCount: 2,
    missingCount: 0,
    missingRate: 0,
    missingRateLabel: '0.00%',
    coverage: { internal: 0, external: 2, manual: 0, missing: 0 },
    criteria: {
      externalProviderNonEmpty: { scope: '外部来源记录的「提供方」字段非空', externalCount: 2, providerNonEmptyCount: 1, satisfied: false },
      manualTraceNonEmpty: { scope: '人工录入来源的 录入人、录入时间 均非空', manualCount: 0, traceNonEmptyCount: 0, satisfied: true },
    },
  });

  const external = model.criteriaRows.find((r) => r.key === 'externalProvider');
  const manual = model.criteriaRows.find((r) => r.key === 'manualTrace');
  assert.equal(external.ok, false);
  assert.equal(external.detail, '1 / 2');
  assert.equal(manual.ok, true);
});

test('边界：待补清单带上待补字段与关联原因项，便于直接补齐', () => {
  const model = buildMissingListView({
    marker: SOURCE_MISSING_MARKER,
    total: 1,
    items: [
      {
        evidenceId: 'e-missing',
        title: '9月产能分析报告',
        typeLabel: '文档',
        formedAt: DATA_TIME,
        owner: '钱厂长',
        pendingFieldLabels: ['来源系统', '来源数据时间', '来源单据编号'],
        reasons: [{ id: 'r1', name: '产能不足' }, { id: 'r2', name: '排产失衡' }],
      },
    ],
  });

  assert.equal(model.total, 1);
  assert.equal(model.marker, SOURCE_MISSING_MARKER);
  assert.equal(model.items[0].id, 'e-missing');
  assert.equal(model.items[0].formedAtText, formatDateTime(DATA_TIME));
  assert.equal(model.items[0].pendingText, '来源系统、来源数据时间、来源单据编号');
  assert.equal(model.items[0].reasonText, '产能不足、排产失衡');
});

test('边界：待补清单为空时语义明确', () => {
  const model = buildMissingListView({ marker: SOURCE_MISSING_MARKER, total: 0, items: [] });

  assert.equal(model.total, 0);
  assert.deepEqual(model.items, []);
});
