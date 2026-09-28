// F1（PAND-79）经营结果指标集：纯逻辑层，不依赖 DOM，可直接单测。
// 口径以后端返回为准（不自行判定来源是否合法、不自行计算偏差），前端只做展示编排。

/** 边界文案：Owner 模块未供给时，实际值与偏差都显示「无数据」。 */
export const NO_DATA_LABEL = '无数据';

/** 偏差口径自述（与后端一致）。 */
export const DEVIATION_LABEL = '偏差（实际值 − 目标值）';

export function periodLabel(periodType, periodValue) {
  if (!periodValue) return '未配置周期';
  if (periodType === 'month') return String(periodValue).replace(/^(\d{4})-(\d{2})$/, '$1年$2月');
  if (periodType === 'week') return String(periodValue).replace(/^(\d{4})-W(\d{1,2})$/, '$1年第$2周');
  return String(periodValue);
}

/** 数据截止时间：只取日期部分，避免浏览器时区把日期显示偏移一天。 */
export function cutoffText(iso) {
  if (!iso) return null;
  const text = String(iso);
  return text.length >= 10 ? text.slice(0, 10) : text;
}

function numberText(value) {
  if (value === null || value === undefined) return null;
  return String(Number(value));
}

function withUnit(value, unit) {
  const text = numberText(value);
  if (text === null) return NO_DATA_LABEL;
  return unit ? `${text}${unit}` : text;
}

function signed(value) {
  const text = numberText(value);
  if (text === null) return null;
  return value > 0 ? `+${text}` : text;
}

function attainmentLabel(item) {
  if (!item.hasData || !item.deviation?.computable) return null;
  return item.deviation.attainment === 'ACHIEVED' ? '达标' : '未达标';
}

/** 单条指标 → 展示卡片模型。无数据时实际值/偏差一律「无数据」，绝不留空或显示 0。 */
export function buildMetricTile(item) {
  const unit = item.unit;
  const noData = !item.hasData;

  return {
    id: item.id,
    code: item.code,
    name: item.name,
    unit,
    ownerModule: item.owner?.module ?? null,
    ownerLabel: item.owner ? item.owner.label ?? item.owner.module : '未声明归属模块',
    ownerScope: item.owner?.scope ?? null,
    dimensionLabel: item.dimensionLabel,
    cutoff: cutoffText(item.dataCutoffAt),
    targetText: withUnit(item.targetValue, unit),
    actualText: noData ? NO_DATA_LABEL : withUnit(item.actualValue, unit),
    deviationText: noData || !item.deviation?.computable ? NO_DATA_LABEL : withUnit(item.deviation.value, unit),
    deviationPctText:
      noData || item.deviation?.pct === null || item.deviation?.pct === undefined
        ? null
        : `${signed(item.deviation.pct)}%`,
    deviationFormula: item.deviation?.formula ?? DEVIATION_LABEL,
    thresholdPct: item.deviation?.thresholdPct ?? null,
    attainmentLabel: attainmentLabel(item),
    // 判定标准：|偏差率| 超过阈值 → 醒目提示
    exceeded: Boolean(item.deviation?.exceeded),
    noData,
    noDataReason: noData ? item.noDataReason : null,
    dataStatusLabel: item.dataStatusLabel,
    // 场景 4：口径版本与证据引用可查看
    calculationVersion: item.traceability?.calculationVersion ?? null,
    resultId: item.traceability?.resultId ?? null,
    sourceModule: item.traceability?.sourceModule ?? null,
    evidenceIds: item.traceability?.evidenceIds ?? [],
    evidence: (item.traceability?.evidence ?? []).map((ref) => ({
      id: ref.id,
      resolved: Boolean(ref.resolved),
      title: ref.title,
      typeLabel: ref.typeLabel,
      href: ref.resolved ? ref.viewPath : null,
    })),
  };
}

/** 后端 GET /results 载荷 → 总览渲染模型。 */
export function buildOverviewModel(payload) {
  const items = payload?.items ?? [];
  const tiles = items.map(buildMetricTile);
  const configuredCount = Number(payload?.configuredCount ?? tiles.length);
  const suppliedCount = Number(payload?.suppliedCount ?? tiles.filter((t) => !t.noData).length);
  const noDataCount = Number(payload?.noDataCount ?? tiles.filter((t) => t.noData).length);
  const traceableCount = Number(payload?.traceableCount ?? 0);
  const periodType = payload?.period?.periodType ?? null;
  const periodValue = payload?.period?.periodValue ?? null;

  return {
    periodLabel: periodLabel(periodType, periodValue),
    periodType,
    periodValue,
    configuredCount,
    suppliedCount,
    noDataCount,
    traceableCount,
    allTraceable: Boolean(payload?.allTraceable),
    stats: [
      { key: 'configured', label: '配置指标', value: configuredCount },
      { key: 'supplied', label: '已供给实际值', value: suppliedCount },
      { key: 'nodata', label: NO_DATA_LABEL, value: noDataCount },
      { key: 'traceable', label: '口径版本+证据无缺项', value: traceableCount },
    ],
    // 红线自述：让数据来源口径在界面上可见，而不是只写在接口里
    sourceNotice:
      '实际值 100% 来自专业 Owner 模块（M05 销售 / M06 交付 / M09 财经）的 Result；' +
      '目标值来自 M03 管理目标（EBMS 自有）；偏差值 = 实际值 − 目标值。EBMS 不重算专业指标。',
    traceabilityNotice:
      suppliedCount === 0
        ? null
        : `已供给 ${suppliedCount} 项中，${traceableCount} 项的口径版本与证据引用无缺项` +
          (payload?.allTraceable ? '（抽查 100% 无缺项）' : ''),
    tiles,
  };
}
