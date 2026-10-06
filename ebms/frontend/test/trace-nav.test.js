// F5（PAND-83）四层链路穿透：导航状态机与来源段口径的逐条 AC 验证。
// 纯逻辑层（src/trace-nav.js）不依赖 DOM，故此处直接单测状态迁移，渲染断言另见
// trace-breadcrumb.render.test.js。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_DRILL_OPS,
  SEGMENT_COUNT,
  SEGMENT_KEYS,
  SOURCE_UNMARKED_LABEL,
  TRACE_SEGMENTS,
  buildBreadcrumb,
  buildChainModel,
  canDrill,
  canReturn,
  createNav,
  drill,
  drillsRemainingToSource,
  enterSegment,
  evidencesOfReason,
  hashForTrace,
  isBreakpoint,
  nextSegmentKey,
  parseTraceHash,
  prevSegmentKey,
  refillTargetLabel,
  returnToPrev,
  segmentIndex,
  sourceModelOf,
  sourceSegmentView,
} from '../src/trace-nav.js';

const M1 = '11111111-1111-4111-8111-111111111111';
const R1 = '22222222-2222-4222-8222-222222222222';
const R2 = '22222222-2222-4222-8222-222222222223';
const E1 = '33333333-3333-4333-8333-333333333333';
const E2 = '33333333-3333-4333-8333-333333333334';

const SEGMENTS = [
  { key: 'result', index: 1, label: '结果', contractRef: 'Result', contractVersion: 'AEOS.Result.V1', kind: 'object', status: 'OK', breakpoint: null },
  { key: 'reason', index: 2, label: '原因（归因）', contractRef: 'Exception', contractVersion: 'AEOS.Exception.V1', kind: 'object', status: 'OK', breakpoint: null },
  { key: 'evidence', index: 3, label: '证据', contractRef: 'Evidence', contractVersion: 'AEOS.Evidence.V1', kind: 'object', status: 'OK', breakpoint: null },
  { key: 'source', index: 4, label: '来源信息', contractRef: 'Evidence.source_system', contractVersion: null, kind: 'field', status: 'OK', breakpoint: null },
];

const CHAIN = {
  metricId: M1,
  result: { name: '订单交付周期', code: 'order_delivery', hasData: true, actualValue: 12, unit: '天' },
  layers: SEGMENTS,
  segmentCount: 4,
  segments: SEGMENTS,
  contractInventory: { objects: ['Result', 'Exception', 'Evidence'], fields: ['Evidence.source_system'], extras: [] },
  sourceContract: { field: 'Evidence.source_system', fallbackToRawTables: false },
  drillOpsToSource: 3,
  reasons: [
    { id: R1, name: '产能不足', attribution: { kind: 'exception', kindLabel: '映射至 Exception（归因）' } },
    { id: R2, name: '渠道压货', attribution: { kind: 'm03_analysis', kindLabel: 'M03 自有归因分析' } },
  ],
  evidences: [
    { id: E1, reasonId: R1, title: '采购合同 A', source: { marked: true, sourceSystem: 'SUPPLIER-A', displayText: 'SUPPLIER-A' } },
    { id: E2, reasonId: R1, title: '系统记录', source: { marked: true, sourceSystem: 'M06', displayText: 'M06 交付自治' } },
  ],
};

// ------------------------------------------------------------------ 场景 3 / 判定标准：固定四段

test('场景 3：导航段固定四段，顺序固定且不可增减（定义已冻结）', () => {
  assert.equal(SEGMENT_COUNT, 4);
  assert.deepEqual(SEGMENT_KEYS, ['result', 'reason', 'evidence', 'source']);
  assert.deepEqual(TRACE_SEGMENTS.map((s) => s.index), [1, 2, 3, 4]);
  assert.equal(Object.isFrozen(TRACE_SEGMENTS), true, '段定义必须冻结，运行时无法增删');
  assert.equal(TRACE_SEGMENTS.every(Object.isFrozen), true);
  assert.equal(segmentIndex('source'), 3);
  assert.equal(segmentIndex('nonexistent'), -1);
});

test('判定标准：面包屑段数与导航段数一致（固定四段），第 2 段标注为「原因（归因）」', () => {
  const nav = createNav(M1);
  const crumbs = buildBreadcrumb(nav, SEGMENTS);

  assert.equal(crumbs.length, SEGMENT_COUNT, '面包屑段数 = 导航段数 = 4');
  assert.equal(crumbs.length, 4);
  assert.deepEqual(crumbs.map((c) => c.key), ['result', 'reason', 'evidence', 'source']);
  assert.equal(crumbs[1].label, '原因（归因）');
  assert.deepEqual(crumbs.map((c) => c.label), ['结果', '原因（归因）', '证据', '来源信息']);

  // 数据未到达时同样渲染四段（不因缺段而增减）
  assert.equal(buildBreadcrumb(nav, []).length, 4);
  assert.equal(buildBreadcrumb(nav, [{ key: 'result', contractRef: 'Result', status: 'OK' }]).length, 4);
});

test('判定标准：段↔契约映射固定（段 2 = Exception、段 4 = source_system 字段而非独立层级）', () => {
  const crumbs = buildBreadcrumb(createNav(M1), SEGMENTS);
  assert.deepEqual(crumbs.map((c) => c.contractRef), [
    'Result',
    'Exception',
    'Evidence',
    'Evidence.source_system',
  ]);
  assert.equal(crumbs[3].kind, 'field', '第 4 段是字段');
  assert.equal(crumbs[3].contractVersion, null, '来源段不是契约对象，无独立契约版本');
  assert.deepEqual(crumbs.slice(0, 3).map((c) => c.kind), ['object', 'object', 'object']);
});

test('判定标准：面包屑相对当前位置的导航态正确（已过 / 当前 / 仅紧邻可进入 / 未达）', () => {
  const atResult = buildBreadcrumb(createNav(M1), SEGMENTS);
  assert.deepEqual(atResult.map((c) => c.nav), ['active', 'reachable', 'ahead', 'ahead']);

  const atEvidence = enterSegment(enterSegment(createNav(M1), 'reason', R1), 'evidence', E1);
  assert.deepEqual(buildBreadcrumb(atEvidence, SEGMENTS).map((c) => c.nav), [
    'visited',
    'visited',
    'active',
    'reachable',
  ]);
});

// ------------------------------------------------------------------ 场景 1：连续下钻 ≤ 4 次

test('场景 1 / 判定标准：从任一结果指标出发，3 次层间下钻（≤ 4 次操作）到达来源信息', () => {
  let nav = createNav(M1);
  assert.equal(nav.layerKey, 'result');
  assert.equal(drillsRemainingToSource(nav), 3);

  let ops = 0;
  while (canDrill(nav)) {
    const next = nextSegmentKey(nav.layerKey);
    nav = drill(nav, next === 'reason' ? R1 : next === 'evidence' ? E1 : null);
    ops += 1;
    assert.ok(ops <= MAX_DRILL_OPS, '操作次数不得超过 4');
  }

  assert.equal(ops, 3, '结果 → 原因 → 证据 → 来源 = 3 次层间下钻');
  assert.equal(ops <= MAX_DRILL_OPS, true);
  assert.equal(nav.layerKey, 'source');
  assert.equal(drillsRemainingToSource(nav), 0);
  assert.equal(canDrill(nav), false, '来源段是末段，无处可下钻');
});

test('场景 1：下钻不跳段——只允许进入紧邻的下一段', () => {
  assert.equal(nextSegmentKey('result'), 'reason');
  assert.equal(nextSegmentKey('reason'), 'evidence');
  assert.equal(nextSegmentKey('evidence'), 'source');
  assert.equal(nextSegmentKey('source'), null);

  // 连续下钻的落点序列固定，不存在跳过某段的路径
  const visited = [];
  let nav = createNav(M1);
  while (canDrill(nav)) {
    nav = drill(nav);
    visited.push(nav.layerKey);
  }
  assert.deepEqual(visited, ['reason', 'evidence', 'source']);
});

test('场景 1：中途不跳出当前上下文——链路由一次读取承载，导航态只含链路起点与各段位置', () => {
  const nav = drill(drill(createNav(M1), R1), E1);
  assert.deepEqual(Object.keys(nav).sort(), ['layerKey', 'metricId', 'positions']);
  assert.equal(nav.metricId, M1, '贯穿四段始终是同一条链路的起点');
  assert.deepEqual(Object.keys(nav.positions).sort(), ['evidence', 'reason', 'result', 'source']);
});

// ------------------------------------------------------------------ 场景 2：逐层返回

test('场景 2 / 判定标准：任意层级可返回上一层，返回后停留位置与操作前一致', () => {
  // 走到来源段，沿途逐段留下停留位置
  let nav = createNav(M1);
  const path = [{ layerKey: nav.layerKey, positions: { ...nav.positions } }];
  for (const [key, pos] of [['reason', R1], ['evidence', E1], ['source', null]]) {
    nav = drill(nav, pos);
    path.push({ layerKey: nav.layerKey, positions: { ...nav.positions } });
  }
  assert.deepEqual(path.map((p) => p.layerKey), ['result', 'reason', 'evidence', 'source']);
  assert.deepEqual(nav.positions, { result: M1, reason: R1, evidence: E1, source: null });

  // 逐层返回：退到某层后，该层及更浅各层的停留位置与进入该层时完全一致。
  // 更深层的停留位置作为「记忆」保留（再次下钻即回到原处），不影响本判定。
  const upTo = (positions, layerKey) =>
    Object.fromEntries(SEGMENT_KEYS.slice(0, segmentIndex(layerKey) + 1).map((k) => [k, positions[k]]));

  for (let i = path.length - 2; i >= 0; i -= 1) {
    nav = returnToPrev(nav);
    assert.equal(nav.layerKey, path[i].layerKey);
    assert.deepEqual(
      upTo(nav.positions, nav.layerKey),
      upTo(path[i].positions, nav.layerKey),
      `返回 ${nav.layerKey} 后停留位置应一致`
    );
  }

  assert.equal(nav.layerKey, 'result');
  assert.equal(nav.positions.reason, R1, '原因段停留位置未被返回清空');
  assert.equal(nav.positions.evidence, E1);
  assert.equal(canReturn(nav), false, '首段无处可返回');
});

test('场景 2：返回后再下钻，仍回到原停留的上一层（位置不丢）', () => {
  let nav = createNav(M1);
  nav = drill(nav, R2);
  nav = drill(nav, E1);
  nav = returnToPrev(nav);
  assert.equal(nav.positions.reason, R2);

  nav = drill(nav); // 再次下钻到证据段：沿用原位置 E1（未传新位置）
  assert.equal(nav.layerKey, 'evidence');
  assert.equal(nav.positions.evidence, E1, '再次进入证据段应停留在原位置');
});

test('场景 2：返回不改变链路数据本身（纯函数，不改动原对象）', () => {
  const base = createNav(M1);
  const drilled = drill(base, R1);
  assert.notEqual(drilled, base);
  assert.equal(base.layerKey, 'result', '原导航态不被改写');
  assert.equal(base.positions.reason, null);
  assert.equal(drilled.positions.reason, R1);
});

// ------------------------------------------------------------------ 场景 4 / 边界：来源段取值

test('场景 4：来源段取值只来自所挂载 Evidence 的 source_system 字段，不打开独立来源实体', () => {
  const src = sourceModelOf({ source: { marked: true, sourceSystem: 'M06', displayText: 'M06 交付自治' } });

  assert.equal(src.resolvedFrom, 'Evidence.source_system');
  assert.equal(src.fieldValue, 'M06');
  assert.equal(src.text, 'M06 交付自治');
  assert.equal(src.entityId, null, '不生成独立来源实体标识');
  assert.equal(src.fallbackToRawTables, false);
});

test('边界：Evidence 缺失 source_system 时显示「来源未标注」，且不回落专业原始表查询', () => {
  for (const evidence of [
    { source: { marked: false, sourceSystem: null } },
    { source: { marked: true, sourceSystem: null } },
    { source: {} },
    {},
  ]) {
    const src = sourceModelOf(evidence);
    assert.equal(src.marked, false);
    assert.equal(src.text, SOURCE_UNMARKED_LABEL);
    assert.equal(src.text, '来源未标注');
    assert.equal(src.fieldValue, null);
    assert.equal(src.fallbackToRawTables, false, '不得回落到专业原始表');
    assert.equal(src.entityId, null);
  }
});

test('场景 4：来源段已聚焦某条证据时只展示该证据的 source_system，不展开成实体清单', () => {
  const model = buildChainModel(CHAIN);
  const nav = drill(drill(createNav(M1), R1), E1);

  const focused = sourceSegmentView(model, nav);
  assert.equal(focused.focused, true);
  assert.equal(focused.items.length, 1);
  assert.equal(focused.items[0].evidenceId, E1);
  assert.equal(focused.items[0].fieldValue, 'SUPPLIER-A');

  // 未聚焦证据时按链路汇总，仍逐条只给字段值
  const all = sourceSegmentView(model, createNav(M1));
  assert.equal(all.focused, false);
  assert.equal(all.items.length, model.evidences.length);
  assert.equal(all.items.every((i) => i.resolvedFrom === 'Evidence.source_system'), true);
});

// ------------------------------------------------------------------ 边界：断点不阻断

test('边界：某段缺失时该段标断点，其余段照常可进入（断点不阻断导航）', () => {
  const brokenSegments = SEGMENTS.map((s) =>
    s.key === 'reason'
      ? { ...s, status: 'MISSING', breakpoint: { code: 'NO_ATTRIBUTION', label: '未归因', message: '…', refill: { action: 'ATTR', label: '登记原因项', targetLayer: 'reason' } } }
      : s
  );
  const model = buildChainModel({ ...CHAIN, segments: brokenSegments });

  assert.equal(isBreakpoint(model, 'reason'), true);
  assert.equal(isBreakpoint(model, 'result'), false);

  const crumbs = buildBreadcrumb(createNav(M1), brokenSegments);
  assert.equal(crumbs.length, 4, '断点不改变段数');
  assert.equal(crumbs[1].status, 'MISSING');
  assert.equal(crumbs[1].breakpoint.code, 'NO_ATTRIBUTION');
  assert.equal(crumbs[1].breakpoint.refill.label, '登记原因项');

  // 仍可逐层进入（断点只是提示，不挡路）
  let nav = createNav(M1);
  nav = drill(nav);
  assert.equal(nav.layerKey, 'reason');
  assert.equal(canDrill(nav), true, '断点段仍可继续下钻');
});

test('边界：来源段断点给出补录入口，且补录落点是来源标注而非「查原始表」', () => {
  const sourceBreakpoint = {
    code: 'SOURCE_UNMARKED',
    label: '来源未标注',
    message: '该证据未标注来源系统（source_system），来源段为断点。',
    refill: { action: 'SOURCE', label: '补录来源', targetLayer: 'source' },
  };
  assert.equal(refillTargetLabel(sourceBreakpoint.refill), 'F4 来源标注');
  assert.equal(refillTargetLabel({ action: 'ATTR' }), 'F2 原因项登记');
  assert.equal(refillTargetLabel({ action: 'EVIDENCE' }), 'F3 证据挂载');
  // 不提供任何形式的原始表回落入口
  assert.equal(/原始表|raw/i.test(refillTargetLabel(sourceBreakpoint.refill)), false);
});

// ------------------------------------------------------------------ 载荷装配与路由

test('载荷装配：段数恒为四段（不因后端缺段而增减），来源段取值逐条解析', () => {
  const model = buildChainModel({ ...CHAIN, segments: [{ key: 'result', status: 'OK' }] });
  assert.equal(model.segmentCount, 4);
  assert.equal(model.drillOpsToSource <= MAX_DRILL_OPS, true);
  assert.equal(model.evidences.every((e) => e.sourceView.resolvedFrom === 'Evidence.source_system'), true);

  // 空载荷不抛错，段数仍为四段
  const empty = buildChainModel(null);
  assert.equal(empty.segmentCount, 4);
  assert.deepEqual(empty.reasons, []);
  assert.deepEqual(empty.evidences, []);
});

test('载荷装配：原因项下的证据按 reasonId 归档', () => {
  const model = buildChainModel(CHAIN);
  assert.deepEqual(evidencesOfReason(model, R1).map((e) => e.id), [E1, E2]);
  assert.deepEqual(evidencesOfReason(model, R2), []);
});

test('路由：链路起点地址为 #/trace/<metricId>，且只识别链路形状的 hash', () => {
  assert.equal(hashForTrace(M1), `#/trace/${M1}`);
  assert.equal(parseTraceHash(`#/trace/${M1}`), M1);
  assert.equal(parseTraceHash(`#/trace/${M1}/`), M1);
  assert.equal(parseTraceHash('#/report/' + M1), null, '四视图落点不得被识别为链路起点');
  assert.equal(parseTraceHash('#/trace/not-a-uuid'), null);
  assert.equal(parseTraceHash(''), null);
});
