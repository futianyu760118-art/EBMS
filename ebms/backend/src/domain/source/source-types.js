'use strict';

// ---------------------------------------------------------------- Source 口径唯一真源
// 业务方 2026-09-23 确认（最终口径）：Source 覆盖「内部系统」与「外部数据」两类，
// 外部数据必须标注提供方；另设「人工录入」承载判定标准中的录入人 / 录入时间要求。
const SOURCE_TYPES = Object.freeze({
  internal: '内部系统',
  external: '外部数据',
  manual: '人工录入',
});

// 口径：数据为周期更新（日/周/月），非实时，故须展示数据截止时间。
const UPDATE_CYCLES = Object.freeze({
  day: '日',
  week: '周',
  month: '月',
});

/** 无 Source 的证据在明细与清单中的统一标记文案。 */
const SOURCE_MISSING_MARKER = '来源缺失';

// 场景 1 的四个展示字段（顺序即展示顺序）；场景 2 在此基础上追加两项。
const SOURCE_DISPLAY_FIELDS = Object.freeze([
  { key: 'sourceSystem', label: '来源系统' },
  { key: 'sourceDocumentNo', label: '来源单据编号' },
  { key: 'sourceDataTime', label: '来源数据时间' },
  { key: 'sourceProvider', label: '提供方' },
]);

const MANUAL_DISPLAY_FIELDS = Object.freeze([
  { key: 'enteredBy', label: '录入人' },
  { key: 'enteredAt', label: '录入时间' },
]);

const UPDATE_CYCLE_FIELD = Object.freeze({ key: 'updateCycle', label: '更新周期' });

function isValidSourceType(code) {
  return Object.prototype.hasOwnProperty.call(SOURCE_TYPES, code);
}

function isValidUpdateCycle(code) {
  return Object.prototype.hasOwnProperty.call(UPDATE_CYCLES, code);
}

/**
 * 判定标准要求的必备字段（缺失即违反判定标准，写入被拒）：
 *   外部数据 → 提供方；人工录入 → 录入人 + 录入时间。
 * 来源系统与来源数据时间是场景 1 的展示字段，同为必备。
 */
function requiredFieldsOf(sourceType) {
  const fields = ['sourceSystem', 'sourceDataTime'];
  if (sourceType === 'external') fields.push('sourceProvider');
  if (sourceType === 'manual') fields.push('enteredBy', 'enteredAt');
  return fields;
}

/**
 * 非判定项的「待补」提示字段：缺失不阻断写入，但在明细中提示补齐
 * （外部数据与人工录入常无内部单据号，故不做判定项）。
 */
const ADVISORY_FIELDS = Object.freeze(['sourceDocumentNo']);

/** 证据尚未标注来源时的待补字段（全部场景 1 字段 + 该类别专属判定项）。 */
function pendingFieldsForMissing() {
  return [...requiredFieldsOf(null), ...ADVISORY_FIELDS];
}

/** 供接口返回的枚举清单（前端下拉、测试判定均取自此）。 */
function listSourceCatalog() {
  return {
    sourceTypes: Object.keys(SOURCE_TYPES).map((code) => ({ code, label: SOURCE_TYPES[code] })),
    updateCycles: Object.keys(UPDATE_CYCLES).map((code) => ({ code, label: UPDATE_CYCLES[code] })),
    missingMarker: SOURCE_MISSING_MARKER,
  };
}

module.exports = {
  SOURCE_TYPES,
  UPDATE_CYCLES,
  SOURCE_MISSING_MARKER,
  SOURCE_DISPLAY_FIELDS,
  MANUAL_DISPLAY_FIELDS,
  UPDATE_CYCLE_FIELD,
  ADVISORY_FIELDS,
  isValidSourceType,
  isValidUpdateCycle,
  requiredFieldsOf,
  pendingFieldsForMissing,
  listSourceCatalog,
};
