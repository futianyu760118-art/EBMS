'use strict';

const config = require('../config');
const decisionRepo = require('../repositories/decision-repo');
const auditRepo = require('../repositories/audit-repo');
const linkRepo = require('../repositories/link-repo');
const refRepo = require('../repositories/ref-repo');
const evidenceRepo = require('../repositories/evidence-repo');
const todoRepo = require('../repositories/todo-repo');
const {
  newId,
  nowIso,
  isDomain,
  isPeriodType,
  isBackgroundRefType,
  BACKGROUND_REF_TYPE_LABELS,
  EVIDENCE_TYPE_LABELS,
  domainVisible,
} = require('../lib/domain');
const {
  DECISION_STATUS,
  DECISION_STATUS_LABELS,
  REQUIRED_DECISION_STATUSES,
  DECISION_CHANGE_ACTION,
  isDecisionStatus,
  statusLabel,
  changeActionLabel,
  hasDecidedFields,
  assertDecidedInvariant,
  requiresChangeReason,
} = require('../lib/decision-status');
const {
  TODO_SOURCE,
  TODO_STATUS_LABELS,
  statusLabel: todoStatusLabel,
  sourceLabel: todoSourceLabel,
  isOverdue,
} = require('../lib/todo-status');
const { badRequest, unauthorized, forbidden, notFound, unprocessable } = require('../lib/errors');

const ENTITY_TYPE = 'decision';

// ---- 通用 ----

function actorNameOf(identity) {
  const name = (identity && identity.displayName ? String(identity.displayName) : '').trim();
  if (name) return name;
  const username = (identity && identity.username ? String(identity.username) : '').trim();
  return username || '未知操作人';
}

function requireIdentity(identity) {
  if (!identity || !identity.userId) throw unauthorized();
  return identity;
}

function assertVisible(identity, domain) {
  if (!domainVisible(identity.scope, domain)) throw forbidden('无权访问非本责任域的决策');
}

function assertIso(value, field) {
  if (!value) throw badRequest(`${field} 不能为空`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw badRequest(`${field} 不是合法时间`);
  return parsed.toISOString();
}

function normalizePaging({ page, limit }) {
  const rawLimit = Number(limit);
  const effective = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, config.pagination.maxLimit)
    : config.pagination.defaultLimit;
  const rawPage = Number(page);
  const effectivePage = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  return { limit: effective, offset: (effectivePage - 1) * effective, page: effectivePage };
}

// ---- 场景 1 入参：背景（关联结果 / 原因）· 候选方案（≥1）· 所需 Evidence ----

async function resolveBackgroundRefs(rawRefs) {
  if (!Array.isArray(rawRefs) || rawRefs.length === 0) {
    throw badRequest('related_refs（背景关联的结果 / 原因）必须至少 1 条');
  }
  const resolved = [];
  const seen = new Set();
  for (const ref of rawRefs) {
    if (!ref || !isBackgroundRefType(ref.type)) {
      throw badRequest('related_refs[].type 仅支持 result / reason', { allowed: ['result', 'reason'] });
    }
    if (!ref.id) throw badRequest('related_refs[].id 不能为空');
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const found = await refRepo.findRef(ref.type, ref.id);
    if (!found) {
      throw badRequest(`关联的${BACKGROUND_REF_TYPE_LABELS[ref.type]}不存在: ${ref.id}`);
    }
    resolved.push({ type: found.type, id: found.id, label: found.label, domain: found.domain || null });
  }
  return resolved;
}

function normalizeOptions(rawOptions) {
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
    throw badRequest('options（候选方案）必须为至少 1 条的列表');
  }
  return rawOptions.map((option, index) => {
    if (!option || typeof option !== 'object') {
      throw badRequest(`options[${index}] 必须为对象`);
    }
    const name = String(option.name || '').trim();
    if (!name) throw badRequest(`options[${index}].name（方案名称）不能为空`);
    return {
      id: option.id ? String(option.id) : newId(),
      name,
      summary: option.summary ? String(option.summary) : '',
      pros: Array.isArray(option.pros) ? option.pros.map((v) => String(v)) : [],
      cons: Array.isArray(option.cons) ? option.cons.map((v) => String(v)) : [],
    };
  });
}

async function resolveRequiredEvidence(rawIds) {
  if (rawIds === undefined || rawIds === null) return [];
  if (!Array.isArray(rawIds)) throw badRequest('required_evidence_ids（所需 Evidence）必须为列表');
  const ids = [...new Set(rawIds.map((v) => String(v)))];
  const found = await evidenceRepo.findByIds(ids);
  const missing = ids.filter((id) => !found.some((e) => e.id === id));
  if (missing.length) throw badRequest('存在无效的 required_evidence_ids', { missing });
  return ids;
}

// ---- 视图装配 ----

// 背景引用在读取时重新解析：中心结论快照可能已更新或被移除，
// 移除时保留创建时的标注并标 available=false（断点语义，不阻断查看）。
async function resolveStoredRefs(refs) {
  const out = [];
  for (const ref of refs || []) {
    const found = await refRepo.findRef(ref.type, ref.id);
    out.push({
      type: ref.type,
      typeLabel: BACKGROUND_REF_TYPE_LABELS[ref.type] || ref.type,
      id: ref.id,
      label: (found && found.label) || ref.label || ref.id,
      domain: (found && found.domain) || ref.domain || null,
      available: !!found,
    });
  }
  return out;
}

async function buildRequiredEvidence(ids) {
  const found = await evidenceRepo.findByIds(ids || []);
  const byId = new Map(found.map((e) => [e.id, e]));
  return (ids || []).map((id) => {
    const evidence = byId.get(id);
    return {
      id,
      provided: !!evidence,
      type: evidence ? evidence.type : null,
      typeLabel: evidence ? EVIDENCE_TYPE_LABELS[evidence.type] || evidence.type : null,
      title: evidence ? evidence.title : null,
      formedAt: evidence ? evidence.formedAt : null,
      owner: evidence ? evidence.owner : null,
    };
  });
}

function buildChanges(rows) {
  const changes = rows.map((row) => ({
    id: row.id,
    action: row.action,
    actionLabel: changeActionLabel(row.action),
    reason: row.reason,
    before: row.before,
    after: row.after,
    changedBy: row.changed_by,
    changedByName: row.changed_by_name,
    changedAt: row.changed_at,
    // 是否是一次「结论值」变更：判定标准「变更记录条数 ≥ 实际修改次数」按此口径核对
    conclusionChanged:
      row.action === DECISION_CHANGE_ACTION.DECIDED || row.action === DECISION_CHANGE_ACTION.REVISED,
  }));
  return changes;
}

// 场景 3：关联执行产生的 TODO 并可回看执行结果（读取 F8 域现状，不重算、不评价效果）
async function buildExecution(decisionId) {
  const linkIds = (await linkRepo.listFrom('decision', decisionId, 'todo')).map((l) => l.to_id);
  if (!linkIds.length) {
    return {
      total: 0,
      done: 0,
      inProgress: 0,
      pending: 0,
      overdue: 0,
      progressPct: 0,
      items: [],
      note: '尚未关联执行 TODO —— 决策可关联其执行产生的 TODO 并回看执行结果（不强制效果评价）',
    };
  }
  const rows = await todoRepo.findByIds(linkIds);
  const at = config.clock();
  const byId = new Map(rows.map((t) => [t.id, t]));
  const items = [];
  for (const id of linkIds) {
    const todo = byId.get(id);
    if (!todo) continue;
    const history = await auditRepo.listForEntity('todo', todo.id);
    items.push({
      id: todo.id,
      title: todo.title,
      status: todo.status,
      statusLabel: todoStatusLabel(todo.status),
      source: todo.source,
      sourceLabel: todoSourceLabel(todo.source),
      owner: todo.owner,
      dueAt: todo.due_at,
      overdue: isOverdue({ dueAt: todo.due_at, status: todo.status, now: at }),
      createdAt: todo.created_at,
      updatedAt: todo.updated_at,
      relatedRefs: todo.related_refs || [],
      // 执行轨迹：TODO 域的流转留痕（只读展示，用以「回看执行结果」）
      history: history.map((h) => ({
        action: h.action,
        actorName: h.actor_name,
        at: h.at,
        detail: h.detail,
      })),
    });
  }
  const done = items.filter((t) => t.status === 'done').length;
  const inProgress = items.filter((t) => t.status === 'in_progress').length;
  const pending = items.filter((t) => t.status === 'pending').length;
  const overdue = items.filter((t) => t.overdue).length;
  return {
    total: items.length,
    done,
    inProgress,
    pending,
    overdue,
    progressPct: items.length ? Math.round((done / items.length) * 100) : 0,
    items,
    note: '执行结果只读取 F8 TODO 域现状，不做决策效果评价（口径：不强制）',
  };
}

function baseView(decision) {
  return {
    id: decision.id,
    title: decision.title,
    domain: decision.domain,
    background: decision.background,
    status: decision.status,
    statusLabel: statusLabel(decision.status),
    decided: decision.status === DECISION_STATUS.DECIDED,
    // 待决策不计入已决策数量
    countsAsDecided: decision.status === DECISION_STATUS.DECIDED,
    conclusion: decision.conclusion,
    decider: decision.decider,
    decidedAt: decision.decided_at,
    optionCount: (decision.options || []).length,
    requiredEvidenceCount: (decision.required_evidence_ids || []).length,
    createdAt: decision.created_at,
    updatedAt: decision.updated_at,
  };
}

// ---- 用例 ----

async function listDecisions({ identity, query = {} }) {
  requireIdentity(identity);

  const status = query.status ? String(query.status) : null;
  if (status && !isDecisionStatus(status)) {
    throw badRequest(`status 仅支持 ${Object.values(DECISION_STATUS).join(' / ')}`, {
      allowed: Object.values(DECISION_STATUS),
    });
  }
  const domain = query.domain ? String(query.domain) : null;
  if (domain && !isDomain(domain)) {
    throw badRequest('domain 取值须为 sales / production / finance / supply_chain / all', { domain });
  }

  const paging = normalizePaging(query);
  const scope = identity.scope;

  const total = await decisionRepo.count({ status, domain, scope });
  const rows = await decisionRepo.list({
    status,
    domain,
    scope,
    limit: paging.limit,
    offset: paging.offset,
  });
  const [counts, changeCounts] = await Promise.all([
    decisionRepo.countsByStatus({ domain, scope }),
    decisionRepo.countChangesFor(rows.map((row) => row.id)),
  ]);

  return {
    // 列表即展示变更计数：场景 2 的「留痕情况」无需点进详情即可判断
    items: rows.map((row) => ({
      ...baseView(row),
      changeCount: 0,
      conclusionChangeCount: 0,
      ...(changeCounts.get(row.id) || {}),
    })),
    // 待决策不计入已决策数量（判定标准）
    summary: { total: counts.total, decided: counts.decided, pending: counts.pending },
    paging: { page: paging.page, limit: paging.limit, total },
    filters: { status, domain },
    meta: {
      statuses: Object.entries(DECISION_STATUS_LABELS).map(([value, label]) => ({ value, label })),
      required_statuses: REQUIRED_DECISION_STATUSES,
      background_ref_types: [
        { value: 'result', label: BACKGROUND_REF_TYPE_LABELS.result },
        { value: 'reason', label: BACKGROUND_REF_TYPE_LABELS.reason },
      ],
    },
  };
}

async function getDecision({ identity, id }) {
  requireIdentity(identity);
  const decision = await decisionRepo.findById(id);
  if (!decision) throw notFound('决策不存在');
  assertVisible(identity, decision.domain);

  const [relatedRefs, requiredEvidence, changeRows, execution] = await Promise.all([
    resolveStoredRefs(decision.related_refs),
    buildRequiredEvidence(decision.required_evidence_ids),
    decisionRepo.listChanges(id),
    buildExecution(id),
  ]);
  const changes = buildChanges(changeRows);

  // 判定标准自检：已决策条目 决策人、决策时间 均非空
  assertDecidedInvariant(decision);

  return {
    ...baseView(decision),
    options: decision.options || [],
    relatedRefs,
    requiredEvidence,
    changes,
    changeCount: changes.length,
    conclusionChangeCount: changes.filter((c) => c.conclusionChanged).length,
    execution,
    // 期望证据与实际执行情况对照，供前端提示「所需证据是否齐备」
    evidenceSummary: {
      required: requiredEvidence.length,
      provided: requiredEvidence.filter((e) => e.provided).length,
      missing: requiredEvidence.filter((e) => !e.provided).length,
    },
    decidedFieldsPresent: hasDecidedFields(decision),
  };
}

async function createDecision({ identity, body = {} }) {
  requireIdentity(identity);
  const actorName = actorNameOf(identity);

  const title = String(body.title || '').trim();
  if (!title) throw badRequest('title（决策事项）不能为空');

  const background = String(body.background || '').trim();
  if (!background) throw badRequest('background（决策背景）不能为空');

  const domain = body.domain;
  if (!isDomain(domain)) {
    throw badRequest('domain 必填，取值须为 sales / production / finance / supply_chain / all', { domain });
  }
  assertVisible(identity, domain);

  // 场景 1：背景（关联结果 / 原因）· 候选方案（≥ 1 条）· 所需 Evidence
  const relatedRefs = await resolveBackgroundRefs(body.related_refs);
  const options = normalizeOptions(body.options);
  const requiredEvidenceIds = await resolveRequiredEvidence(body.required_evidence_ids);

  const created = await decisionRepo.insert(
    {
      title,
      domain,
      background,
      related_refs: relatedRefs,
      options,
      required_evidence_ids: requiredEvidenceIds,
      created_by: identity.userId,
    },
    {
      action: DECISION_CHANGE_ACTION.CREATED,
      reason: body.reason ? String(body.reason).trim() : null,
      before: null,
      after: {
        title,
        domain,
        // 未形成结论 ⇒ 待决策
        status: DECISION_STATUS.PENDING,
        related_refs: relatedRefs.map((r) => ({ type: r.type, id: r.id, label: r.label })),
        option_names: options.map((o) => o.name),
        required_evidence_ids: requiredEvidenceIds,
      },
      changedBy: identity.userId,
      changedByName: actorName,
    }
  );

  await auditRepo.record({
    actorId: identity.userId,
    actorName,
    action: DECISION_CHANGE_ACTION.CREATED,
    entityType: ENTITY_TYPE,
    entityId: created.id,
    detail: { title, domain, status: DECISION_STATUS.PENDING },
  });

  return getDecision({ identity, id: created.id });
}

// 形成 / 修改决策结论。修改必须留痕且带变更理由 —— 决策结论不可静默修改。
async function decideConclusion({ identity, id, body = {} }) {
  requireIdentity(identity);
  const decision = await decisionRepo.findById(id);
  if (!decision) throw notFound('决策不存在');
  assertVisible(identity, decision.domain);

  const conclusion = String(body.conclusion ?? '').trim();
  if (!conclusion) throw badRequest('conclusion（决策结论）不能为空');

  const reason = body.reason === undefined || body.reason === null ? null : String(body.reason).trim();
  const hasExistingConclusion = typeof decision.conclusion === 'string' && decision.conclusion.trim().length > 0;

  let action;
  if (!hasExistingConclusion) {
    action = DECISION_CHANGE_ACTION.DECIDED;
  } else {
    if (decision.conclusion === conclusion) {
      throw unprocessable('决策结论未发生变化，无需修改', { conclusion });
    }
    if (requiresChangeReason({ hasExistingConclusion }) && !reason) {
      throw badRequest('修改已有决策结论必须提供 reason（变更理由）—— 决策结论不可静默修改');
    }
    action = DECISION_CHANGE_ACTION.REVISED;
  }

  const actorName = actorNameOf(identity);
  const changedAt = nowIso();
  const before = {
    conclusion: decision.conclusion,
    status: decision.status,
    decider: decision.decider,
    decided_at: decision.decided_at,
  };
  const after = {
    conclusion,
    status: DECISION_STATUS.DECIDED,
    decider: actorName,
    decided_at: changedAt,
  };

  const updated = await decisionRepo.updateConclusion({
    id,
    conclusion,
    status: DECISION_STATUS.DECIDED,
    decider: actorName,
    deciderId: identity.userId,
    decidedAt: changedAt,
    change: {
      action,
      reason,
      before,
      after,
      changedBy: identity.userId,
      changedByName: actorName,
    },
  });
  // 已决策不变量：结论 / 决策人 / 决策时间 三者同进
  assertDecidedInvariant(updated);

  await auditRepo.record({
    actorId: identity.userId,
    actorName,
    action,
    entityType: ENTITY_TYPE,
    entityId: id,
    detail: { before: before.conclusion, after: conclusion, reason },
  });

  return getDecision({ identity, id });
}

// 场景 3：关联执行产生的 TODO（可关联已有 TODO，也可由决策派发新 TODO）
async function linkExecutionTodos({ identity, id, body = {} }) {
  requireIdentity(identity);
  const decision = await decisionRepo.findById(id);
  if (!decision) throw notFound('决策不存在');
  assertVisible(identity, decision.domain);

  const rawIds = Array.isArray(body.todo_ids) ? body.todo_ids.map((v) => String(v)) : [];
  const toCreate = Array.isArray(body.todos) ? body.todos : [];
  if (!rawIds.length && !toCreate.length) {
    throw badRequest('todo_ids（关联已有 TODO）或 todos（派发新 TODO）至少提供一项');
  }

  const existing = await todoRepo.findByIds([...new Set(rawIds)]);
  const missing = [...new Set(rawIds)].filter((rid) => !existing.some((t) => t.id === rid));
  if (missing.length) throw badRequest('存在无效的 todo_ids', { missing });

  const actorName = actorNameOf(identity);
  const backgroundRefs = (decision.related_refs || []).map((r) => ({
    type: r.type,
    id: r.id,
    label: r.label,
  }));

  // 由决策派发的执行 TODO 走 F8 既有口径：source=manual，必须指定责任人
  const created = [];
  for (const [index, item] of toCreate.entries()) {
    const title = String((item && item.title) || '').trim();
    if (!title) throw badRequest(`todos[${index}].title 不能为空`);
    const owner = String((item && item.owner) || '').trim();
    if (!owner) throw badRequest(`todos[${index}].owner（责任人）不能为空`);
    const dueAt = assertIso(item && item.due_at, `todos[${index}].due_at`);
    created.push(
      await todoRepo.insert({
        title,
        source: TODO_SOURCE.MANUAL,
        trigger_basis: null,
        related_refs: backgroundRefs,
        owner,
        due_at: dueAt,
        created_by: identity.userId,
      })
    );
  }

  const beforeIds = (await linkRepo.listFrom('decision', id, 'todo')).map((l) => l.to_id);
  const linked = [];
  const skipped = [];
  for (const todo of [...existing, ...created]) {
    const already = await linkRepo.find('decision', id, 'todo', todo.id);
    if (already) {
      skipped.push(todo.id);
      continue;
    }
    await linkRepo.insert({ fromType: 'decision', fromId: id, toType: 'todo', toId: todo.id });
    linked.push(todo.id);
  }

  if (linked.length) {
    await decisionRepo.recordChange(id, {
      action: DECISION_CHANGE_ACTION.TODO_LINKED,
      reason: body.reason ? String(body.reason).trim() : null,
      before: { execution_todo_ids: beforeIds },
      after: {
        execution_todo_ids: [...beforeIds, ...linked],
        created_todo_ids: created.map((t) => t.id),
      },
      changedBy: identity.userId,
      changedByName: actorName,
    });
  }

  const detail = await getDecision({ identity, id });
  return { ...detail, linked, skipped };
}

async function unlinkExecutionTodo({ identity, id, todoId }) {
  requireIdentity(identity);
  const decision = await decisionRepo.findById(id);
  if (!decision) throw notFound('决策不存在');
  assertVisible(identity, decision.domain);

  const beforeIds = (await linkRepo.listFrom('decision', id, 'todo')).map((l) => l.to_id);
  const removed = await linkRepo.remove('decision', id, 'todo', todoId);
  if (!removed) throw notFound('该 TODO 未与本决策关联');

  await decisionRepo.recordChange(id, {
    action: DECISION_CHANGE_ACTION.TODO_UNLINKED,
    reason: null,
    before: { execution_todo_ids: beforeIds },
    after: { execution_todo_ids: beforeIds.filter((v) => v !== todoId), unlinked_todo_id: todoId },
    changedBy: identity.userId,
    changedByName: actorNameOf(identity),
  });

  return getDecision({ identity, id });
}

// 创建表单候选：可关联的结果 / 原因 / 证据
async function listCandidates({ identity }) {
  requireIdentity(identity);
  const [results, reasons, evidences] = await Promise.all([
    refRepo.listMetricRefs(),
    refRepo.listReasonRefs(),
    evidenceRepo.listAll(),
  ]);
  const scope = identity.scope;
  const visible = (item) => domainVisible(scope, item.domain);
  return {
    results: results.filter(visible),
    reasons: reasons.filter(visible),
    evidences: evidences.map((e) => ({
      ...e,
      typeLabel: EVIDENCE_TYPE_LABELS[e.type] || e.type,
    })),
    meta: {
      background_ref_types: [
        { value: 'result', label: BACKGROUND_REF_TYPE_LABELS.result },
        { value: 'reason', label: BACKGROUND_REF_TYPE_LABELS.reason },
      ],
      periods: ['day', 'week', 'month'].filter((p) => isPeriodType(p)),
    },
  };
}

// 供 Decision 视图选择要关联的执行 TODO。TODO 表本身不带责任域（F8 口径），
// 因此不做域过滤，只标注每条 TODO 当前已关联到哪个决策，避免重复关联。
async function listTodoCandidates({ identity, decisionId }) {
  requireIdentity(identity);
  const at = config.clock();
  const rows = await todoRepo.listCandidates({ limit: 100 });
  return {
    items: rows.map((todo) => ({
      id: todo.id,
      title: todo.title,
      status: todo.status,
      statusLabel: todoStatusLabel(todo.status),
      source: todo.source,
      sourceLabel: todoSourceLabel(todo.source),
      owner: todo.owner,
      dueAt: todo.due_at,
      overdue: isOverdue({ dueAt: todo.due_at, status: todo.status, now: at }),
      relatedRefs: todo.related_refs || [],
      linkedDecisionId: todo.linkedDecisionId,
      linkedHere: !!decisionId && todo.linkedDecisionId === decisionId,
    })),
    meta: { statuses: Object.entries(TODO_STATUS_LABELS || {}).map(([value, label]) => ({ value, label })) },
  };
}

module.exports = {
  ENTITY_TYPE,
  listDecisions,
  getDecision,
  createDecision,
  decideConclusion,
  linkExecutionTodos,
  unlinkExecutionTodo,
  listCandidates,
  listTodoCandidates,
};

