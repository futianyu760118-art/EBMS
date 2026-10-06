'use strict';

/**
 * F5（PAND-83）四层链路口径的**唯一真源**。
 *
 * 四层是 M03 的**视图导航段**，不是新的跨域契约层级；每一段对应到 AEOS 已有对象/字段：
 *   第 1 段 结果 → Result 契约
 *   第 2 段 原因 → Exception（归因）契约
 *   第 3 段 证据 → Evidence 契约
 *   第 4 段 来源 → Evidence 的 source_system 字段（字段化，不是独立层级）
 *
 * 冻结以保证：段数固定为 4（不增减）、顺序固定、契约对应固定。
 * service / 路由 / 前端面包屑均由此读取，不存在第二套层级定义。
 */

const LAYERS = Object.freeze([
  Object.freeze({
    key: 'result',
    index: 1,
    label: '结果',
    // 段对应的契约对象或字段；用于「链路消费对象清点」
    contractRef: 'Result',
    contractVersion: 'AEOS.Result.V1',
    kind: 'object',
  }),
  Object.freeze({
    key: 'reason',
    index: 2,
    label: '原因（归因）',
    contractRef: 'Exception',
    contractVersion: 'AEOS.Exception.V1',
    kind: 'object',
  }),
  Object.freeze({
    key: 'evidence',
    index: 3,
    label: '证据',
    contractRef: 'Evidence',
    contractVersion: 'AEOS.Evidence.V1',
    kind: 'object',
  }),
  Object.freeze({
    key: 'source',
    index: 4,
    label: '来源信息',
    // 第 4 段不是一个契约对象，而是 Evidence 上的字段
    contractRef: 'Evidence.source_system',
    contractVersion: null,
    kind: 'field',
  }),
]);

const LAYER_KEYS = Object.freeze(LAYERS.map((layer) => layer.key));

/** 段数固定为 4（AC 场景 3 / 判定标准：面包屑段数与导航段数一致）。 */
const LAYER_COUNT = LAYERS.length;

/**
 * 链路消费的跨域契约对象清点结果。
 * 判定标准要求 = Result / Exception / Evidence 三类 + source_system 字段，无额外对象。
 */
const CONTRACT_INVENTORY = Object.freeze({
  objects: LAYERS.filter((layer) => layer.kind === 'object').map((layer) => layer.contractRef),
  fields: LAYERS.filter((layer) => layer.kind === 'field').map((layer) => layer.contractRef),
  extras: [],
});

/** 来源段缺失时的口径：不得回落到专业原始表查询（PAND-83 边界）。 */
const SOURCE_UNMARKED = Object.freeze({
  label: '来源未标注',
  // 显式声明「没有回落」，使「未标注」与「回退到原始表」在数据上可区分
  fallbackToRawTables: false,
});

/** 断点类型枚举：每一段缺失时的提示与补录入口描述。 */
const BREAKPOINTS = Object.freeze({
  NO_ATTRIBUTION: Object.freeze({
    code: 'NO_ATTRIBUTION',
    layer: 'reason',
    label: '未归因',
    message: '该结果指标尚未关联任何原因项，原因段为断点。',
    // 补录入口：落到 PAND-80（F2）的归因登记
    refill: Object.freeze({ action: 'ATTR', label: '登记原因项', targetLayer: 'reason' }),
  }),
  NO_EVIDENCE: Object.freeze({
    code: 'NO_EVIDENCE',
    layer: 'evidence',
    label: '无证据支撑',
    message: '该原因项尚未挂载任何证据，证据段为断点。',
    // 补录入口：落到 PAND-81（F3）的证据挂载
    refill: Object.freeze({ action: 'EVIDENCE', label: '补录证据', targetLayer: 'evidence' }),
  }),
  UPSTREAM_MISSING: Object.freeze({
    code: 'UPSTREAM_MISSING',
    layer: 'evidence',
    label: '上游原因段缺失',
    message: '原因段缺失，证据段暂无挂载锚点；该段仅为断点，不阻断其余段查看。',
    refill: Object.freeze({ action: 'ATTR', label: '先登记原因项', targetLayer: 'reason' }),
  }),
  SOURCE_UNMARKED: Object.freeze({
    code: 'SOURCE_UNMARKED',
    layer: 'source',
    label: SOURCE_UNMARKED.label,
    message: '该证据未标注来源系统（source_system），来源段为断点。',
    // 补录入口：落到 PAND-82（F4）的来源标注；不提供「查原始表」这类回落入口
    refill: Object.freeze({ action: 'SOURCE', label: '补录来源', targetLayer: 'source' }),
  }),
});

function layerAt(key) {
  return LAYERS.find((layer) => layer.key === key) || null;
}

/**
 * 下一段的唯一合法取值：只允许进入紧邻的下一层，越层返回 null。
 * 这是「连续下钻」的结构性保证 —— 不存在跳过某段直达更深层的路径。
 */
function nextLayerKey(key) {
  const layer = layerAt(key);
  if (!layer || layer.index >= LAYER_COUNT) return null;
  return LAYER_KEYS[layer.index];
}

module.exports = {
  LAYERS,
  LAYER_KEYS,
  LAYER_COUNT,
  CONTRACT_INVENTORY,
  SOURCE_UNMARKED,
  BREAKPOINTS,
  layerAt,
  nextLayerKey,
};
