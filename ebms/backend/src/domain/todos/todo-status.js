'use strict';

// F8（PAND-86）TODO 状态机与逾期判定 —— 领域核心，纯函数，无 IO。
//
// 口径：
//   · 状态三类齐备（待处理 / 处理中 / 已完成），可扩展但不可缺（AC 判定标准）。
//   · 状态取值与 002 建立时 todos.status 的 CHECK 一致，本文件是「标签 + 流转图」的
//     唯一出处，接口与前端均取自此，避免各处硬编码漂移。
//   · 流转必须留痕（操作人 / 时间 / before / after），由 todo-service 与 audit_log 保证。
//   · 逾期以 due_at 与「当前时间」比较得出；已完成项不再判逾期（终态不参与逾期统计）。

const TODO_STATUSES = Object.freeze({
  pending: Object.freeze({
    code: 'pending',
    label: '待处理',
    order: 1,
    // 允许流转到的下一状态（终态为空数组）
    next: Object.freeze(['in_progress']),
    terminal: false,
  }),
  in_progress: Object.freeze({
    code: 'in_progress',
    label: '处理中',
    order: 2,
    next: Object.freeze(['pending', 'done']),
    terminal: false,
  }),
  done: Object.freeze({
    code: 'done',
    label: '已完成',
    order: 3,
    // 已完成是终态：不提供回流路径，避免「已结案的事项被静默改回未完成」
    next: Object.freeze([]),
    terminal: true,
  }),
});

const TODO_STATUS_CODES = Object.freeze(Object.keys(TODO_STATUSES));
const DEFAULT_STATUS = 'pending';

// 来源两类并存（业务方 2026-09-23 确认的最终口径）
const TODO_SOURCES = Object.freeze({
  rule: Object.freeze({ code: 'rule', label: '规则自动产生', auto: true }),
  manual: Object.freeze({ code: 'manual', label: '人工派发', auto: false }),
});

const TODO_SOURCE_CODES = Object.freeze(Object.keys(TODO_SOURCES));

function isValidStatus(code) {
  return Object.prototype.hasOwnProperty.call(TODO_STATUSES, code);
}

function isValidSource(code) {
  return Object.prototype.hasOwnProperty.call(TODO_SOURCES, code);
}

function statusLabel(code) {
  return TODO_STATUSES[code] ? TODO_STATUSES[code].label : code;
}

function sourceLabel(code) {
  return TODO_SOURCES[code] ? TODO_SOURCES[code].label : code;
}

/** 状态枚举清单（接口下发的唯一取值来源，前端不自行维护）。 */
function listStatuses() {
  return TODO_STATUS_CODES.map((code) => ({
    code,
    label: TODO_STATUSES[code].label,
    order: TODO_STATUSES[code].order,
    terminal: TODO_STATUSES[code].terminal,
    next: [...TODO_STATUSES[code].next],
  }));
}

function listSources() {
  return TODO_SOURCE_CODES.map((code) => ({
    code,
    label: TODO_SOURCES[code].label,
    auto: TODO_SOURCES[code].auto,
  }));
}

/** 某状态可流转到的目标状态（含标签，供前端只渲染合法动作）。 */
function allowedTransitions(code) {
  if (!isValidStatus(code)) return [];
  return TODO_STATUSES[code].next.map((next) => ({
    code: next,
    label: TODO_STATUSES[next].label,
  }));
}

/** 流转是否合法 —— 非法（含原地不动与终态回流）一律拒绝，由用例层抛错。 */
function canTransition(from, to) {
  if (!isValidStatus(from) || !isValidStatus(to)) return false;
  return TODO_STATUSES[from].next.includes(to);
}

/**
 * 逾期判定：截止时间存在 + 未完成 + 截止时间早于当前时间。
 * 不传 now 时取当前时间；显式注入便于测试与「可复现」判定。
 */
function isOverdue({ dueAt, status }, now = new Date()) {
  if (!dueAt) return false;
  if (!TODO_STATUSES[status] || TODO_STATUSES[status].terminal) return false;
  const due = dueAt instanceof Date ? dueAt : new Date(dueAt);
  if (Number.isNaN(due.getTime())) return false;
  const current = now instanceof Date ? now : new Date(now);
  return due.getTime() < current.getTime();
}

/** 距截止时间的自然日差（负数=已逾期），无截止时间返回 null。 */
function daysUntilDue(dueAt, now = new Date()) {
  if (!dueAt) return null;
  const due = dueAt instanceof Date ? dueAt : new Date(dueAt);
  if (Number.isNaN(due.getTime())) return null;
  const current = now instanceof Date ? now : new Date(now);
  const DAY = 24 * 60 * 60 * 1000;
  return Math.floor((due.getTime() - current.getTime()) / DAY);
}

/** 逾期项的区分标记（列表行与详情共用同一份文案）。 */
function overdueBadge({ dueAt, status }, now = new Date()) {
  // 已完成的项即使曾经过期也不打逾期标记（终态离开逾期统计口径）
  if (!isOverdue({ dueAt, status }, now)) return { overdue: false, label: null, tone: null };
  const days = Math.abs(daysUntilDue(dueAt, now));
  return {
    overdue: true,
    label: days === 0 ? '今日到期未完成' : `逾期 ${days} 天`,
    tone: 'danger',
  };
}

module.exports = {
  TODO_STATUSES,
  TODO_STATUS_CODES,
  TODO_SOURCES,
  TODO_SOURCE_CODES,
  DEFAULT_STATUS,
  isValidStatus,
  isValidSource,
  statusLabel,
  sourceLabel,
  listStatuses,
  listSources,
  allowedTransitions,
  canTransition,
  isOverdue,
  daysUntilDue,
  overdueBadge,
};
