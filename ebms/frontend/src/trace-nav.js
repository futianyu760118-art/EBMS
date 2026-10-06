// F5（PAND-83）四层链路 Result → Reason（归因）→ Evidence → Source：纯逻辑层，不依赖 DOM，可直接单测。
//
// 口径（与后端 layers.js 同源，PAND-97 返工后）：四段是 M03 的**视图导航段**，
// 不是新的跨域契约层级。段↔契约映射以后端随链路下发的 data.layers 为准，
// 前端只保留「四段骨架」用于面包屑在数据到达前也恒定显示四段（场景 3：不增减段数）。
//
// 导航状态机保证两件事，从而不依赖往返请求：
// · 连续下钻只走紧邻下一段（无跳段路径）→ 结果到来源恒为 3 次层间下钻（≤ 4 次操作）。
// · 各段停留位置单独保存，返回上一层不清空 → 返回后停留位置与操作前一致。

/** 边界文案：Evidence 缺失 source_system 时来源段的展示值。 */
export const SOURCE_UNMARKED_LABEL = '来源未标注';

/** AC 上限：从任一结果指标出发，连续操作 ≤ 4 次到达来源信息。 */
export const MAX_DRILL_OPS = 4;

/** 第 4 段取值的来源字段（字段化，不是独立层级/独立实体）。 */
export const SOURCE_FIELD_REF = 'Evidence.source_system';

/** 四段骨架：固定四段、顺序固定（场景 3 / 判定标准：面包屑段数与导航段数一致）。 */
export const TRACE_SEGMENTS = Object.freeze([
  Object.freeze({ key: 'result', index: 1, label: '结果' }),
  // 判定标准：第 2 段必须标注为「原因（归因）」
  Object.freeze({ key: 'reason', index: 2, label: '原因（归因）' }),
  Object.freeze({ key: 'evidence', index: 3, label: '证据' }),
  Object.freeze({ key: 'source', index: 4, label: '来源信息' }),
]);

export const SEGMENT_KEYS = Object.freeze(TRACE_SEGMENTS.map((s) => s.key));
export const SEGMENT_COUNT = TRACE_SEGMENTS.length;

/**
 * 补录入口的落点说明：缺段时给出的补录入口落在哪个既有模块，界面上写明。
 * 来源段缺口的补录落在来源标注，**不提供「查专业原始表」这类回落入口**（PAND-83 边界）。
 */
export const REFILL_TARGET_LABEL = Object.freeze({
  ATTR: 'F2 原因项登记',
  EVIDENCE: 'F3 证据挂载',
  SOURCE: 'F4 来源标注',
});

export function refillTargetLabel(refill) {
  return REFILL_TARGET_LABEL[refill?.action] || '待接入模块';
}

/** 段序号（0 起）；未知段返回 -1。 */
export function segmentIndex(key) {
  return SEGMENT_KEYS.indexOf(key);
}

/** hash 路由：`#/trace/<metricId>`（起点必须是 Result）。 */
export function hashForTrace(metricId) {
  return `#/trace/${metricId}`;
}

export function parseTraceHash(hash) {
  const match = String(hash ?? '')
    .replace(/^#/, '')
    .replace(/\/+$/, '')
    .match(
      /^\/trace\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/
    );
  return match ? match[1] : null;
}

/**
 * 初始导航态：落在结果段，段数不因数据缺失而增减。
 * positions 记录**各段停留位置**，返回上一层时不清空 —— 这是场景 2 的实现基础。
 */
export function createNav(metricId = null) {
  return {
    metricId,
    layerKey: 'result',
    positions: { result: metricId, reason: null, evidence: null, source: null },
  };
}

/** 只允许进入紧邻的下一段；已在末段返回 null（结构性禁止跳段与越界）。 */
export function nextSegmentKey(layerKey) {
  const i = segmentIndex(layerKey);
  return i >= 0 && i < SEGMENT_COUNT - 1 ? SEGMENT_KEYS[i + 1] : null;
}

/** 上一段；已在首段返回 null。 */
export function prevSegmentKey(layerKey) {
  const i = segmentIndex(layerKey);
  return i > 0 ? SEGMENT_KEYS[i - 1] : null;
}

export function canDrill(nav) {
  return nextSegmentKey(nav?.layerKey) !== null;
}

export function canReturn(nav) {
  return prevSegmentKey(nav?.layerKey) !== null;
}

/**
 * 进入某一段。位置缺省时沿用该段原有位置 ——
 * 「返回上一层」即 enterSegment(prev)，位置自然与操作前一致。
 */
export function enterSegment(nav, key, position) {
  if (!nav || segmentIndex(key) === -1) return nav;
  const positions = { ...nav.positions };
  if (position !== undefined && position !== null) positions[key] = position;
  return { ...nav, layerKey: key, positions };
}

/** 下钻一层（仅紧邻下一段），并记录该段停留位置。 */
export function drill(nav, position) {
  const next = nextSegmentKey(nav?.layerKey);
  if (!next) return nav;
  return enterSegment(nav, next, position);
}

/** 返回上一层；停留位置不变。 */
export function returnToPrev(nav) {
  const prev = prevSegmentKey(nav?.layerKey);
  if (!prev) return nav;
  return enterSegment(nav, prev);
}

/** 从当前段连续下钻到来源段所需的层间下钻次数（结果段出发恒为 3，≤ MAX_DRILL_OPS）。 */
export function drillsRemainingToSource(nav) {
  const i = segmentIndex(nav?.layerKey);
  return i === -1 ? null : SEGMENT_COUNT - 1 - i;
}

/** 是否已停留在来源段。 */
export function atSource(nav) {
  return nav?.layerKey === 'source';
}

/**
 * 面包屑：**恒为四段**，与导航段数一致。
 * 契约对应取后端下发的 segments（无第二套层级口径）；nav 相对当前位置标注。
 */
export function buildBreadcrumb(nav, segments = []) {
  const byKey = new Map((segments || []).map((s) => [s.key, s]));
  const current = segmentIndex(nav?.layerKey);

  return TRACE_SEGMENTS.map((seg, i) => {
    const backend = byKey.get(seg.key) || {};
    return {
      key: seg.key,
      index: seg.index,
      label: seg.label,
      contractRef: backend.contractRef ?? null,
      contractVersion: backend.contractVersion ?? null,
      kind: backend.kind ?? null,
      status: backend.status ?? 'OK',
      breakpoint: backend.breakpoint ?? null,
      // 已过 / 当前 / 仅紧邻下一段可进入 / 未达（不可跳段）
      nav: i < current ? 'visited' : i === current ? 'active' : i === current + 1 ? 'reachable' : 'ahead',
      position: nav?.positions?.[seg.key] ?? null,
    };
  });
}

/**
 * 来源段模型：取值**只**来自所挂载 Evidence 的 source_system 字段。
 * 字段为空即「来源未标注」，并显式声明未回落到专业原始表（fallbackToRawTables: false）；
 * 不产生独立来源实体（无 entityId / 无实体读取入口）。
 */
export function sourceModelOf(evidence) {
  const source = evidence?.source || {};
  const marked = Boolean(source.marked) && Boolean(source.sourceSystem);
  return {
    marked,
    resolvedFrom: SOURCE_FIELD_REF,
    fieldValue: marked ? source.sourceSystem : null,
    text: marked ? source.displayText ?? source.sourceSystem : SOURCE_UNMARKED_LABEL,
    // 未标注即到此为止：不回落原始表，也不生成独立来源实体
    fallbackToRawTables: false,
    entityId: null,
  };
}

/**
 * 后端链路载荷 → 视图模型。
 * 段数固定取四段骨架（不因载荷缺段而增减），段状态/断点取后端下发。
 */
export function buildChainModel(data) {
  const segments = Array.isArray(data?.segments) ? data.segments : [];
  const evidences = (data?.evidences || []).map((e) => ({ ...e, sourceView: sourceModelOf(e) }));

  return {
    metricId: data?.metricId ?? null,
    result: data?.result ?? null,
    reasons: data?.reasons || [],
    evidences,
    segments,
    segmentCount: SEGMENT_COUNT,
    // 判定标准：链路消费对象清点 = Result / Exception / Evidence + source_system 字段
    contractInventory: data?.contractInventory ?? null,
    sourceContract: data?.sourceContract ?? null,
    // 层间下钻次数（后端下发；缺省按固定四段推导）
    drillOpsToSource: data?.drillOpsToSource ?? SEGMENT_COUNT - 1,
  };
}

export function segmentOf(model, key) {
  return (model?.segments || []).find((s) => s.key === key) || null;
}

/** 该段是否处于断点（缺失），断点不阻断其余段查看。 */
export function isBreakpoint(model, key) {
  const seg = segmentOf(model, key);
  return Boolean(seg && seg.status === 'MISSING');
}

/** 某原因项下挂载的证据（含各自解析出的来源段）。 */
export function evidencesOfReason(model, reasonId) {
  return (model?.evidences || []).filter((e) => e.reasonId === reasonId);
}

/** 来源段当前展示的内容：已聚焦某条证据则展示该证据，否则展示该链路全部已标注来源。 */
export function sourceSegmentView(model, nav) {
  const focusedId = nav?.positions?.evidence;
  const focused = focusedId ? (model?.evidences || []).find((e) => e.id === focusedId) : null;
  if (focused) {
    return { focused: true, items: [{ evidenceId: focused.id, title: focused.title, ...focused.sourceView }] };
  }
  const items = (model?.evidences || []).map((e) => ({
    evidenceId: e.id,
    title: e.title,
    ...e.sourceView,
  }));
  return { focused: false, items };
}
