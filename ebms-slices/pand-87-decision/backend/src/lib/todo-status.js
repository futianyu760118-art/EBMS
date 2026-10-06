'use strict';

// F8/PAND-86 领域规则：TODO 状态枚举与逾期判定。
// PAND-87 只读取（回看决策执行结果），不重算、不修改 TODO 域算法。

const TODO_STATUS = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  DONE: 'done',
});

const TODO_STATUS_LABELS = Object.freeze({
  [TODO_STATUS.PENDING]: '待处理',
  [TODO_STATUS.IN_PROGRESS]: '处理中',
  [TODO_STATUS.DONE]: '已完成',
});

const REQUIRED_TODO_STATUSES = Object.freeze([
  TODO_STATUS.PENDING,
  TODO_STATUS.IN_PROGRESS,
  TODO_STATUS.DONE,
]);

const TODO_SOURCE = Object.freeze({
  RULE: 'rule',
  MANUAL: 'manual',
});

const TODO_SOURCE_LABELS = Object.freeze({
  [TODO_SOURCE.RULE]: '规则自动产生',
  [TODO_SOURCE.MANUAL]: '人工派发',
});

function isTodoStatus(value) {
  return Object.prototype.hasOwnProperty.call(TODO_STATUS_LABELS, value);
}

function statusLabel(status) {
  return TODO_STATUS_LABELS[status] || status;
}

function sourceLabel(source) {
  return TODO_SOURCE_LABELS[source] || source;
}

// 判定标准：逾期判定以截止时间与当前时间比较得出（已完成的项不再判为逾期）
function isOverdue({ dueAt, status, now = new Date() }) {
  if (!dueAt) return false;
  if (status === TODO_STATUS.DONE) return false;
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return false;
  const current = now instanceof Date ? now : new Date(now);
  return due.getTime() < current.getTime();
}

module.exports = {
  TODO_STATUS,
  TODO_STATUS_LABELS,
  REQUIRED_TODO_STATUSES,
  TODO_SOURCE,
  TODO_SOURCE_LABELS,
  isTodoStatus,
  statusLabel,
  sourceLabel,
  isOverdue,
};
