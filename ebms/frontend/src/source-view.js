// PAND-82（F4 来源标注）展示模型。
// 口径：Source 是 Evidence 上的字段（非独立实体）；标签由后端给出，此处只做展示整形，
// 使「场景 1/2/3 + 边界」的渲染与接口口径始终同源。
// 带扩展名：该模块同时被 node --test 直接加载（Vite 对带扩展名的导入同样解析）
import { formatDateTime } from './format.js';

export const SOURCE_MISSING_MARKER = '来源缺失';
const EMPTY_TEXT = '—';

/** 场景 1 的四个字段（顺序即展示顺序）；场景 2 追加录入人 / 录入时间。 */
export const SOURCE_FIELD_ORDER = ['sourceSystem', 'sourceDocumentNo', 'sourceDataTime', 'sourceProvider'];
export const MANUAL_FIELD_ORDER = ['enteredBy', 'enteredAt'];

const DATE_KEYS = new Set(['sourceDataTime', 'enteredAt']);

export function fieldText(key, value) {
  if (value === null || value === undefined || value === '') return EMPTY_TEXT;
  if (DATE_KEYS.has(key)) return formatDateTime(value);
  return String(value);
}

function toRows(display) {
  return (display || []).map((field) => ({
    key: field.key,
    label: field.label,
    value: fieldText(field.key, field.value),
    empty: field.value === null || field.value === undefined || field.value === '',
  }));
}

/** 单条证据的来源明细（场景 1/2/3 + 边界）。 */
export function buildSourceView(detail) {
  if (!detail) return null;
  const missing = Boolean(detail.sourceMissing);
  const pendingLabels = detail.pendingFieldLabels || [];

  return {
    evidence: detail.evidence,
    missing,
    marker: missing ? detail.missingMarker || SOURCE_MISSING_MARKER : null,
    typeLabel: detail.sourceTypeLabel,
    rows: toRows(detail.display),
    // 场景 2：仅人工录入来源带录入人与录入时间
    manualRows: toRows(detail.manualDisplay),
    cycleText: detail.updateCycleLabel ? `按${detail.updateCycleLabel}更新` : EMPTY_TEXT,
    cutoffText: fieldText('sourceDataTime', detail.dataCutoffAt),
    pendingLabels,
    pendingText: pendingLabels.length > 0 ? pendingLabels.join('、') : '',
  };
}

/** 证据列表行里的来源摘要（含「来源缺失」标记）。 */
export function buildSourceSummary(source) {
  if (!source) return { label: EMPTY_TEXT, missing: false, marker: null };
  if (source.sourceMissing) {
    return { label: EMPTY_TEXT, missing: true, marker: source.missingMarker || SOURCE_MISSING_MARKER };
  }
  return {
    label: source.sourceSystem || EMPTY_TEXT,
    typeLabel: source.sourceTypeLabel,
    missing: false,
    marker: null,
  };
}

/** 判定标准：来源缺失率与覆盖分布。 */
export function buildSourceStatsView(stats) {
  if (!stats) return null;
  return {
    totalText: `${stats.totalCount} 条`,
    missingText: `${stats.missingCount} 条`,
    hasMissing: stats.missingCount > 0,
    // 0/0 语义：范围内无证据时缺失率为 null，展示为「不适用」而非 0%
    rateText: stats.missingRate === null ? `${EMPTY_TEXT}（范围内无证据）` : stats.missingRateLabel,
    rateFormula: `${stats.missingCount} ÷ ${stats.totalCount}`,
    coverageRows: [
      { key: 'internal', label: '内部系统', count: stats.coverage.internal },
      { key: 'external', label: '外部数据', count: stats.coverage.external },
      { key: 'manual', label: '人工录入', count: stats.coverage.manual },
      { key: 'missing', label: SOURCE_MISSING_MARKER, count: stats.coverage.missing, alert: true },
    ],
    criteriaRows: [
      {
        key: 'externalProvider',
        label: stats.criteria.externalProviderNonEmpty.scope,
        ok: stats.criteria.externalProviderNonEmpty.satisfied,
        detail: `${stats.criteria.externalProviderNonEmpty.providerNonEmptyCount} / ${stats.criteria.externalProviderNonEmpty.externalCount}`,
      },
      {
        key: 'manualTrace',
        label: stats.criteria.manualTraceNonEmpty.scope,
        ok: stats.criteria.manualTraceNonEmpty.satisfied,
        detail: `${stats.criteria.manualTraceNonEmpty.traceNonEmptyCount} / ${stats.criteria.manualTraceNonEmpty.manualCount}`,
      },
    ],
  };
}

/** 边界：待补清单。 */
export function buildMissingListView(list) {
  if (!list) return null;
  return {
    marker: list.marker || SOURCE_MISSING_MARKER,
    total: list.total,
    items: (list.items || []).map((item) => ({
      id: item.evidenceId,
      title: item.title,
      typeLabel: item.typeLabel,
      formedAtText: formatDateTime(item.formedAt),
      owner: item.owner || EMPTY_TEXT,
      pendingText: (item.pendingFieldLabels || []).join('、'),
      reasonText:
        (item.reasons || []).length > 0
          ? item.reasons.map((r) => r.name).join('、')
          : '未挂载原因项',
    })),
  };
}
