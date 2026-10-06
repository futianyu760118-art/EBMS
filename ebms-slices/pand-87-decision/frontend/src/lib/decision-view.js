// Decision 视图的表现层口径（F9/PAND-87）。
// 状态与变更类型的取值/文案以领域层 lib/decision-status.js 为准，
// 前端只做展示映射，不自行判定业务规则。

export const DECISION_STATUS = {
  PENDING: 'pending',
  DECIDED: 'decided',
};

export const STATUS_LABELS = {
  pending: '待决策',
  decided: '已决策',
};

export const CHANGE_ACTION_LABELS = {
  'decision.created': '创建决策',
  'decision.decided': '形成决策结论',
  'decision.revised': '修改决策结论',
  'decision.todo_linked': '关联执行 TODO',
  'decision.todo_unlinked': '解除执行 TODO 关联',
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || status || '';
}

export function changeActionLabel(action) {
  return CHANGE_ACTION_LABELS[action] || action || '';
}

export function isDecided(decision) {
  return !!decision && decision.status === DECISION_STATUS.DECIDED;
}

// 变更前后的结论值：只有确实改了结论值才展示前后对照，
// 避免「关联 TODO」这类变更被误读为结论变化。
export function conclusionDiff(change) {
  if (!change || !change.conclusionChanged) return null;
  const before = change.before && change.before.conclusion ? change.before.conclusion : '';
  const after = change.after && change.after.conclusion ? change.after.conclusion : '';
  return { before, after };
}

export function executionSummary(execution) {
  if (!execution || !execution.total) return '尚未关联执行 TODO';
  const parts = [`共 ${execution.total} 条`, `已完成 ${execution.done}`];
  if (execution.inProgress) parts.push(`进行中 ${execution.inProgress}`);
  if (execution.pending) parts.push(`未开始 ${execution.pending}`);
  if (execution.overdue) parts.push(`已逾期 ${execution.overdue}`);
  return `${parts.join(' · ')}（完成度 ${execution.progressPct}%）`;
}

// 候选方案互斥展示用：编号 A/B/C…
export function optionLabel(index) {
  return String.fromCharCode(65 + index);
}
