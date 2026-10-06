export const DOMAIN_LABELS = {
  sales: '销售',
  production: '生产/交付',
  finance: '财务',
  supply_chain: '供应链',
  all: '全企业',
};

export const PERIOD_LABELS = {
  day: '日',
  week: '周',
  month: '月',
};

const STATUS_LABELS = {
  ok: '已更新',
  no_data: '无数据',
  stale: '数据未更新',
};

export function domainLabel(domain) {
  return DOMAIN_LABELS[domain] || domain || '';
}

export function periodLabel(periodType, periodValue) {
  const type = PERIOD_LABELS[periodType] || periodType || '';
  return `${periodValue || ''} ${type}`.trim();
}

export function formatNumber(value, unit) {
  if (value === null || value === undefined) return '—';
  const text = Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return unit ? `${text} ${unit}` : text;
}

export function formatDeviation(deviation, unit) {
  if (!deviation || (deviation.abs === null && deviation.pct === null)) return '—';
  const parts = [];
  if (deviation.abs !== null && deviation.abs !== undefined) {
    const sign = deviation.abs > 0 ? '+' : '';
    parts.push(`${sign}${Number(deviation.abs).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`);
  }
  if (deviation.pct !== null && deviation.pct !== undefined) {
    const sign = deviation.pct > 0 ? '+' : '';
    parts.push(`(${sign}${deviation.pct}%)`);
  }
  return parts.join(' ');
}

// 边界：本期无数据时必须显示「无数据」+ 原因，不得显示 0 或空白（PAND-79 口径）
export function metricStatusText(metric) {
  if (metric.dataStatus === 'ok') return STATUS_LABELS.ok;
  const base = STATUS_LABELS[metric.dataStatus] || metric.dataStatus;
  return metric.missingReason ? `${base}（${metric.missingReason}）` : base;
}

export function isMissing(metric) {
  return metric.dataStatus !== 'ok';
}

// 决策人/决策时间、变更时间等均按本地时区展示到分钟
export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

// 逾期天数：仅用于提示，不参与任何判定
export function overdueDays(dueAt, now = new Date()) {
  if (!dueAt) return 0;
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return 0;
  return Math.max(0, Math.floor((now.getTime() - due.getTime()) / (24 * 3600 * 1000)));
}
