'use strict';

// F9/PAND-87 领域规则：决策状态、结论修改留痕、已决策不变量。
//
// 已确认口径（业务方 2026-09-23）：
//   · 未形成结论的记录状态为「待决策」，不计入已决策数量。
//   · 决策结论不可静默修改 —— 任何结论变更都必须落一条 decision_changes
//     （变更人、时间、变更前后值），且修改须给出变更理由。
//   · 不强制做决策效果评价；只需可关联执行产生的 TODO 并回看执行结果。

const DECISION_STATUS = Object.freeze({
  PENDING: 'pending',
  DECIDED: 'decided',
});

const DECISION_STATUS_LABELS = Object.freeze({
  [DECISION_STATUS.PENDING]: '待决策',
  [DECISION_STATUS.DECIDED]: '已决策',
});

// 必备两态（缺一即判定不通过）：未形成结论=待决策、已形成结论=已决策
const REQUIRED_DECISION_STATUSES = Object.freeze([
  DECISION_STATUS.PENDING,
  DECISION_STATUS.DECIDED,
]);

// decision_changes.action 取值
const DECISION_CHANGE_ACTION = Object.freeze({
  CREATED: 'decision.created',
  DECIDED: 'decision.decided', // 首次形成结论
  REVISED: 'decision.revised', // 结论修改（须带变更理由）
  TODO_LINKED: 'decision.todo_linked',
  TODO_UNLINKED: 'decision.todo_unlinked',
});

const DECISION_CHANGE_ACTION_LABELS = Object.freeze({
  [DECISION_CHANGE_ACTION.CREATED]: '创建决策',
  [DECISION_CHANGE_ACTION.DECIDED]: '形成结论',
  [DECISION_CHANGE_ACTION.REVISED]: '修改结论',
  [DECISION_CHANGE_ACTION.TODO_LINKED]: '关联执行 TODO',
  [DECISION_CHANGE_ACTION.TODO_UNLINKED]: '解除执行 TODO 关联',
});

function isDecisionStatus(value) {
  return Object.prototype.hasOwnProperty.call(DECISION_STATUS_LABELS, value);
}

function statusLabel(status) {
  return DECISION_STATUS_LABELS[status] || status;
}

function changeActionLabel(action) {
  return DECISION_CHANGE_ACTION_LABELS[action] || action;
}

// 「待决策」：未形成结论。判定标准要求未形成结论的记录一律标记为待决策。
function isPending(decision) {
  return !decision || decision.status === DECISION_STATUS.PENDING;
}

function isDecided(decision) {
  return !!decision && decision.status === DECISION_STATUS.DECIDED;
}

// 判定标准：已决策条目 决策人、决策时间 均非空。
function hasDecidedFields(decision) {
  if (!decision) return false;
  return (
    typeof decision.decider === 'string' &&
    decision.decider.trim().length > 0 &&
    typeof decision.decided_at === 'string' &&
    decision.decided_at.trim().length > 0
  );
}

// 已决策不变量：status=decided ⇔ 结论非空且决策人/决策时间非空。
// 服务层写入前后各校验一次，测试按判定标准再独立复核一次。
function assertDecidedInvariant(decision) {
  const decided = isDecided(decision);
  const fieldsOk = hasDecidedFields(decision);
  const conclusionOk = typeof decision.conclusion === 'string' && decision.conclusion.trim().length > 0;
  if (decided !== (fieldsOk && conclusionOk)) {
    throw new Error(
      `决策不变量被破坏：status=${decision && decision.status} 但 decider/decided_at/conclusion 不匹配`
    );
  }
  return true;
}

// 「不可静默修改」：结论已存在时再改，必须给出变更理由（非空）。
function requiresChangeReason({ hasExistingConclusion }) {
  return hasExistingConclusion === true;
}

module.exports = {
  DECISION_STATUS,
  DECISION_STATUS_LABELS,
  REQUIRED_DECISION_STATUSES,
  DECISION_CHANGE_ACTION,
  DECISION_CHANGE_ACTION_LABELS,
  isDecisionStatus,
  statusLabel,
  changeActionLabel,
  isPending,
  isDecided,
  hasDecidedFields,
  assertDecidedInvariant,
  requiresChangeReason,
};
