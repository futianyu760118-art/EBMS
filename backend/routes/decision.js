/**
 * M03 EBMS · Decision 视图（决策背景 / 候选方案 / 所需证据 / 决策结论）
 * ------------------------------------------------------------------
 * 对应功能点：PAND-87 / F9「Decision 视图记录决策背景、候选方案、所需证据与决策结论」
 * AEOS 定位：M03 管理者工作面的 DECISION 层（契约 AEOS.Decision.V1）
 *
 * 边界（P0 红线）：
 *   - 只记录经营决策本身，不重算任何专业中心内部算法；
 *   - 背景关联（结果 / 原因）只做「引用 + 标注」，结果/原因的专业事实由 F1（M03 经营结果指标集）
 *     与 F2（归因 / Exception）供给，本模块不自建第二套事实源；
 *   - 执行项（TODO）的事实源是 F8 / AEOS.Action.V1 的 `todos` 表：本模块只按契约读写
 *     `decision_id` 关联字段与执行状态，不重算 F8 的状态流转算法；
 *   - 不做决策效果评价（2026-09-23 口径明确不要求）。
 *
 * 表结构：
 *   decisions         决策记录本体（含 background / options / required_evidence，结论与留痕分离）
 *   decision_changes  变更留痕（结论修改 + 执行 TODO 关联/解除），只追加不修改
 *   todos             执行项（F8 共享事实源，按 AEOS.Action.V1：decision_id 即关联键）
 *
 * 不变量（由 rules.assertDecidedInvariant 在返回前自检）：
 *   status='decided' ⇔ 结论 / 决策人 / 决策时间 三者同时非空；'pending' 时三者必须全空。
 */
const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm, extractUserId } = require('../auth-middleware');
const rules = require('../lib/decision-rules');

ensureTable('decisions');
ensureTable('decision_changes');
ensureTable('todos');

const {
  CONTRACT_VERSION, ACTION_CONTRACT_VERSION,
  STATUS_PENDING, STATUS_DECIDED, STATUS_LABELS,
  BACKGROUND_REF_TYPES, BACKGROUND_REF_TYPE_LABELS,
  TODO_STATUSES, TODO_STATUS_LABELS,
  DEFAULT_PAGE_SIZE, ALLOWED_PAGE_SIZES, ALLOWED_SORT_FIELDS,
  str, parsePage, parsePageSize, statusLabel,
  normalizeDecision, applyConclusion, assertDecidedInvariant,
  countsByStatus, conclusionChangeCount, sortChanges,
  deriveExecutionStatus, executionSummary, genDecisionCode,
  buildFilter, paginate
} = rules;

// ===== 通用取数 =====
function decisionsTable() { const t = getTable('decisions'); t._invalidate(); return t; }
function changesTable() { const t = getTable('decision_changes'); t._invalidate(); return t; }
function todosTable() { const t = getTable('todos'); t._invalidate(); return t; }

// 当前操作者：仅认服务端签发的 token（auth-middleware.extractUserId）
function currentActor(req) {
  const uid = extractUserId(req);
  if (!uid) return { id: '', name: '' };
  try {
    const user = getTable('users').findById(uid);
    if (user) return { id: String(user.id), name: str(user.name) || str(user.username) };
  } catch (e) { /* users 表不可用时退化为仅 id */ }
  return { id: String(uid), name: '' };
}

// 结论修改（同一事务语义）：先写结论再追加留痕，留痕写入失败则回滚结论，
// 保证「改了结论却没有变更记录」的路径不存在（AC 场景 2）。
async function commitConclusion(decisionTable, changeTable, decision, patch, change) {
  const prev = {
    status: decision.status, conclusion: decision.conclusion,
    decided_by: decision.decided_by, decided_at: decision.decided_at,
    updated_at: decision.updated_at
  };
  const res = await decisionTable.update(decision.id, patch);
  if (!res || res.changes === 0) return { error: '决策记录不存在', status: 404 };
  try {
    const seq = (changeTable.all().reduce((m, c) => Math.max(m, Number(c.seq || c.id || 0)), 0)) + 1;
    const info = await changeTable.insert(Object.assign({ decision_id: decision.id, seq }, change));
    return { changeId: info.lastID };
  } catch (e) {
    await decisionTable.update(decision.id, prev);
    return { error: '变更留痕写入失败，已回滚结论：' + e.message, status: 500 };
  }
}

// 执行项（todos）按决策聚合。列表页一次取回整页所需，避免逐条 N+1。
function todosByDecision(decisionIds) {
  const ids = new Set((decisionIds || []).map(Number));
  const out = new Map();
  (decisionIds || []).forEach(id => out.set(Number(id), []));
  try {
    todosTable().all().forEach(t => {
      const did = Number(t.decision_id);
      if (ids.has(did)) out.get(did).push(t);
    });
  } catch (e) { /* todos 表不可用时视为无执行项 */ }
  return out;
}

// ===== 列表 + 已决策 / 待决策汇总 =====
router.get('/', requirePerm('decision:view'), (req, res) => {
  const table = decisionsTable();
  const filter = buildFilter(req.query);
  const sortBy = ALLOWED_SORT_FIELDS.indexOf(str(req.query.sort_by)) >= 0 ? str(req.query.sort_by) : 'id';
  const sortOrder = str(req.query.sort_order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const page = parsePage(req.query.page);
  const limit = parsePageSize(req.query.limit);

  // 汇总口径与列表筛选一致；「待决策」不计入已决策数量
  const matched = table.all().filter(filter);
  const counts = countsByStatus(matched);
  const { records, total } = table.findWhere(filter, sortBy, sortOrder, limit, (page - 1) * limit);

  // 结论类变更条数：整页一次取回后分组，避免 N+1
  const idSet = new Set(records.map(r => Number(r.id)));
  const changeCount = {};
  changesTable().all().forEach(c => {
    const did = Number(c.decision_id);
    if (!idSet.has(did)) return;
    if (str(c.change_type) === 'conclusion') changeCount[did] = (changeCount[did] || 0) + 1;
  });

  const todoMap = todosByDecision(records.map(r => r.id));
  const today = now().substring(0, 10);

  res.json({
    data: records.map(r => {
      const todos = todoMap.get(Number(r.id)) || [];
      return {
        id: r.id,
        decision_code: r.decision_code,
        title: r.title,
        summary: r.summary,
        status: r.status,
        status_label: statusLabel(r.status),
        background: r.background || [],
        option_count: (r.options || []).length,
        adopted_option: (r.options || []).filter(o => o && o.selected).map(o => str(o.name))[0] || '',
        required_evidence_count: (r.required_evidence || []).length,
        conclusion: r.conclusion,
        decided_by: r.decided_by,
        decided_at: r.decided_at,
        conclusion_change_count: changeCount[Number(r.id)] || 0,
        execution_count: todos.length,
        execution_completion_rate: executionSummary(todos, today).completion_rate,
        created_at: r.created_at,
        updated_at: r.updated_at
      };
    }),
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    page_size_options: ALLOWED_PAGE_SIZES,
    counts: { matched: counts.total, decided: counts.decided, pending: counts.pending }
  });
});

// ===== 汇总（与列表同一筛选口径）=====
router.get('/stats', requirePerm('decision:view'), (req, res) => {
  const table = decisionsTable();
  const matched = table.all().filter(buildFilter(req.query));
  const counts = countsByStatus(matched);
  res.json({
    total: counts.total,
    decided: counts.decided,
    pending: counts.pending,
    pending_label: STATUS_LABELS[STATUS_PENDING],
    decided_label: STATUS_LABELS[STATUS_DECIDED]
  });
});

// ===== 创建表单候选（结果 / 原因 / 证据）=====
// F1（经营结果指标集）与 F2（归因）尚未在本仓库落地，候选主要来自：
//   1) 既有决策已引用过的结果 / 原因编码（决策自身的引用台账，非新事实源）；
//   2) Evidence 视图（F3 / F10）已登记的关联结果 / 原因编码——接入后自动出现。
router.get('/refs', requirePerm('decision:view'), (req, res) => {
  const resultSet = new Set();
  const reasonSet = new Set();
  const evidenceSet = new Set();

  decisionsTable().all().forEach(d => {
    (d.background || []).forEach(ref => {
      if (!ref || !str(ref.code)) return;
      if (ref.type === 'result') resultSet.add(str(ref.code));
      else if (ref.type === 'reason') reasonSet.add(str(ref.code));
    });
    (d.required_evidence || []).forEach(e => { if (e && str(e.evidence_code)) evidenceSet.add(str(e.evidence_code)); });
  });

  let evidenceUpstream = false;
  try {
    const evs = getTable('evidences');
    evs._invalidate();
    const all = evs.all();
    evidenceUpstream = all.length > 0;
    all.forEach(e => {
      (Array.isArray(e.result_codes) ? e.result_codes : []).forEach(c => { if (str(c)) resultSet.add(str(c)); });
      (Array.isArray(e.reason_codes) ? e.reason_codes : []).forEach(c => { if (str(c)) reasonSet.add(str(c)); });
      if (str(e.evidence_code)) evidenceSet.add(str(e.evidence_code));
    });
  } catch (e) { /* Evidence 视图未接入：忽略 */ }

  res.json({
    background_ref_types: BACKGROUND_REF_TYPES.map(t => ({ value: t, label: BACKGROUND_REF_TYPE_LABELS[t] })),
    results: [...resultSet].sort(),
    reasons: [...reasonSet].sort(),
    evidence_codes: [...evidenceSet].sort(),
    todo_statuses: TODO_STATUSES.map(s => ({ value: s, label: TODO_STATUS_LABELS[s] })),
    upstream: {
      result_source: 'F1 经营结果指标集',
      reason_source: 'F2 归因（Exception）',
      evidence_source: 'F3 / F10 Evidence 视图',
      // 结果 / 原因的专业事实源尚未在本仓库落地：候选为空是「上游未接入」，不是无候选
      result_source_ready: false,
      reason_source_ready: false,
      evidence_source_ready: evidenceUpstream
    }
  });
});

// ===== 可关联的执行项候选（AC 场景 3）=====
// 只列出尚未关联到任何决策的执行项，并标注其归属，避免重复关联。
router.get('/todo-candidates', requirePerm('decision:view'), (req, res) => {
  const keyword = str(req.query.keyword).toLowerCase();
  const unlinkedOnly = str(req.query.unlinked) !== '0';
  const today = now().substring(0, 10);
  const list = todosTable().all()
    .filter(t => {
      if (unlinkedOnly && t.decision_id) return false;
      if (!keyword) return true;
      return (str(t.title) + ' ' + str(t.action_code) + ' ' + str(t.assignee_name)).toLowerCase().indexOf(keyword) >= 0;
    })
    .slice(0, 200)
    .map(t => Object.assign({
      id: t.id,
      action_code: t.action_code,
      title: t.title,
      assignee_name: t.assignee_name,
      due_at: t.due_at
    }, deriveExecutionStatus(t, today)));

  res.json({ data: list, total: list.length, unlinked_only: unlinkedOnly });
});

// ===== 详情（必须注册在 /:id 之前的路由之后）=====
router.get('/:id', requirePerm('decision:view'), (req, res) => {
  const table = decisionsTable();
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '决策记录不存在' });

  // 返回前自检已决策不变量（判定标准：已决策条目 决策人、决策时间 均非空）
  const invariant = assertDecidedInvariant(row);
  if (invariant) {
    return res.status(500).json({ error: '决策记录数据异常：' + invariant, code: 'DECISION_INVARIANT_VIOLATION' });
  }

  const changes = sortChanges(changesTable().all().filter(c => Number(c.decision_id) === Number(row.id)));
  const todos = todosTable().all().filter(t => Number(t.decision_id) === Number(row.id));
  const today = now().substring(0, 10);

  // 所需证据的「是否已提供」：以 Evidence 视图（F3 / F10）现有登记为准，未接入时标注
  let evidenceIndex = null;
  try {
    const evs = getTable('evidences');
    evs._invalidate();
    const all = evs.all();
    if (all.length) {
      evidenceIndex = new Map();
      all.forEach(e => { if (str(e.evidence_code)) evidenceIndex.set(str(e.evidence_code), e); });
    }
  } catch (e) { /* 未接入 */ }

  res.json({
    id: row.id,
    contract_version: row.contract_version || CONTRACT_VERSION,
    decision_code: row.decision_code,
    title: row.title,
    summary: row.summary,
    status: row.status,
    status_label: statusLabel(row.status),
    background: (row.background || []).map(ref => Object.assign({}, ref, {
      type_label: BACKGROUND_REF_TYPE_LABELS[str(ref.type)] || str(ref.type),
      // 结果 / 原因的专业事实源（F1 / F2）尚未落地：引用保留、可读，但无法在本仓库内解析
      resolvable: false
    })),
    background_note: '结果 / 原因的专业事实由 F1 经营结果指标集与 F2 归因（Exception）供给，本仓库尚未接入；此处保留引用与标注，不隐藏来源已失效的引用。',
    options: (row.options || []).map(o => ({
      name: str(o.name), description: str(o.description),
      pros: str(o.pros), cons: str(o.cons), selected: o.selected === true
    })),
    required_evidence: (row.required_evidence || []).map(e => ({
      evidence_code: str(e.evidence_code),
      title: str(e.title),
      provided: evidenceIndex ? evidenceIndex.has(str(e.evidence_code)) : false
    })),
    required_evidence_note: evidenceIndex
      ? '已按 Evidence 视图（F3 / F10）现有登记回填 provided。'
      : 'Evidence 视图（F3 / F10）尚未接入，provided 一律为 false；字段为空数组表示本决策无需外部证据。',
    conclusion: str(row.conclusion),
    decided_by: str(row.decided_by),
    decided_at: str(row.decided_at),
    conclusion_change_count: conclusionChangeCount(changes),
    changes: changes.map(c => ({
      seq: c.seq, change_type: c.change_type,
      before_status: c.before_status, after_status: c.after_status,
      before_value: str(c.before_value), after_value: str(c.after_value),
      before_decided_by: str(c.before_decided_by), after_decided_by: str(c.after_decided_by),
      reason: str(c.reason), changed_by: str(c.changed_by), changed_at: str(c.changed_at)
    })),
    execution: {
      summary: executionSummary(todos, today),
      todos: todos.map(t => {
        const d = deriveExecutionStatus(t, today);
        return {
          id: t.id, action_code: t.action_code, title: t.title,
          assignee_id: t.assignee_id, assignee_name: t.assignee_name,
          due_at: t.due_at, status: d.raw_status, status_label: d.raw_status_label,
          exec_status: d.exec_status, exec_label: d.exec_label, overdue: d.overdue,
          completed_at: t.completed_at
        };
      }),
      note: '执行结果只读取 F8 / AEOS.Action.V1 执行项的现状，不重算其状态流转，也不做决策效果评价（口径明确不要求）。'
    },
    created_at: row.created_at,
    updated_at: row.updated_at
  });
});

// ===== 创建决策（初始「待决策」）=====
// 表写操作经 withTableLock 串行化，返回 Promise，必须 await。
router.post('/', requirePerm('decision:create'), async (req, res) => {
  const table = decisionsTable();
  const { record, error } = normalizeDecision(req.body || {});
  if (error) return res.status(400).json({ error });

  const code = record.decision_code || genDecisionCode(table.all(), now().substring(0, 7));
  if (table.all().some(r => str(r.decision_code) === code)) {
    return res.status(400).json({ error: '决策编码已存在：' + code });
  }
  const actor = currentActor(req);
  record.decision_code = code;
  record.created_by = actor.name || actor.id;
  record.created_at = now();
  record.updated_at = record.created_at;

  const info = await table.insert(record);
  res.json({ id: info.lastID, message: '决策已创建（待决策）', data: table.findById(info.lastID) });
});

// ===== 形成 / 修改决策结论（AC 场景 2）=====
router.patch('/:id/conclusion', requirePerm('decision:edit'), async (req, res) => {
  const table = decisionsTable();
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '决策记录不存在' });

  const at = now();
  const actor = currentActor(req);
  const result = applyConclusion(row, req.body || {}, actor, at);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });

  const written = await commitConclusion(table, changesTable(), row, result.patch, result.change);
  if (written.error) return res.status(written.status || 500).json({ error: written.error });

  res.json({ message: '决策结论已记录', data: table.findById(row.id), change_id: written.changeId });
});

// ===== 关联执行 TODO（已有执行项）或派发新执行项（AC 场景 3）=====
router.post('/:id/execution-todos', requirePerm('decision:edit'), async (req, res) => {
  const table = decisionsTable();
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '决策记录不存在' });

  const body = req.body || {};
  const actor = currentActor(req);
  const at = now();
  const decisionRef = { type: 'decision', code: str(row.decision_code), label: str(row.title) };
  const todos = todosTable();

  let todo;
  let changeType;
  if (body.todo_id !== undefined && body.todo_id !== null && str(body.todo_id) !== '') {
    // 关联已有执行项
    todo = todos.findById(body.todo_id);
    if (!todo) return res.status(404).json({ error: '执行项（TODO）不存在：' + body.todo_id });
    if (todo.decision_id && Number(todo.decision_id) !== Number(row.id)) {
      return res.status(409).json({ error: '该执行项已关联到其他决策（decision_id=' + todo.decision_id + '），请先解除关联' });
    }
    if (Number(todo.decision_id) === Number(row.id)) {
      return res.status(409).json({ error: '该执行项已关联到本决策，无需重复关联' });
    }
    await todos.update(todo.id, { decision_id: row.id, updated_at: at });
    changeType = 'todo_linked';
  } else {
    // 由决策派发新执行项：写入 F8 / AEOS.Action.V1 的 todos 表
    const title = str(body.title);
    if (!title) return res.status(400).json({ error: '派发执行项需提供 title，或提供 todo_id 关联已有执行项' });
    const status = str(body.status) || 'todo';
    if (TODO_STATUSES.indexOf(status) === -1) {
      return res.status(400).json({ error: '执行项状态取值非法：' + status + '（允许：' + TODO_STATUSES.join('、') + '）' });
    }
    const record = {
      contract_version: ACTION_CONTRACT_VERSION,
      action_code: str(body.action_code) || ('ACT' + row.decision_code.replace(/^DEC/, '') + '-' + String(Date.now()).slice(-4)),
      title,
      detail: str(body.detail),
      assignee_id: str(body.assignee_id),
      assignee_name: str(body.assignee_name),
      due_at: str(body.due_at),
      status,
      priority: str(body.priority) || 'normal',
      decision_id: row.id,
      // 携带决策的背景关联，供执行项回看决策依据（引用，不是新事实源）
      related_refs: [decisionRef],
      created_by: actor.name || actor.id,
      created_at: at,
      updated_at: at,
      completed_at: status === 'done' ? at : ''
    };
    const info = await todos.insert(record);
    todo = todos.findById(info.lastID);
    changeType = 'todo_dispatched';
  }

  // 关联 / 派发均留痕（操作人、时间、对象）
  const seq = changesTable().all().reduce((m, c) => Math.max(m, Number(c.seq || c.id || 0)), 0) + 1;
  const info = await changesTable().insert({
    decision_id: row.id,
    seq,
    change_type: changeType,
    before_status: str(row.status),
    after_status: str(row.status),
    before_value: '',
    after_value: str(todo.action_code) + ' ' + str(todo.title),
    reason: str(body.reason),
    changed_by: actor.name || actor.id,
    changed_at: at
  });

  await table.update(row.id, { updated_at: at });
  res.json({
    message: changeType === 'todo_linked' ? '执行项已关联' : '执行项已派发并关联',
    data: todo,
    change_id: info.lastID
  });
});

// ===== 解除执行项关联（留痕）=====
router.delete('/:id/execution-todos/:todoId', requirePerm('decision:edit'), async (req, res) => {
  const table = decisionsTable();
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '决策记录不存在' });

  const todos = todosTable();
  const todo = todos.findById(req.params.todoId);
  if (!todo) return res.status(404).json({ error: '执行项（TODO）不存在：' + req.params.todoId });
  if (Number(todo.decision_id) !== Number(row.id)) {
    return res.status(409).json({ error: '该执行项未关联到本决策' });
  }

  const actor = currentActor(req);
  const at = now();
  await todos.update(todo.id, { decision_id: null, updated_at: at });

  const seq = changesTable().all().reduce((m, c) => Math.max(m, Number(c.seq || c.id || 0)), 0) + 1;
  const info = await changesTable().insert({
    decision_id: row.id,
    seq,
    change_type: 'todo_unlinked',
    before_status: str(row.status),
    after_status: str(row.status),
    before_value: str(todo.action_code) + ' ' + str(todo.title),
    after_value: '',
    reason: str(req.body && req.body.reason),
    changed_by: actor.name || actor.id,
    changed_at: at
  });

  await table.update(row.id, { updated_at: at });
  res.json({ message: '执行项已解除关联', data: todos.findById(todo.id), change_id: info.lastID });
});

// ===== 删除决策（连同其留痕；已关联的执行项仅解除关联，不删除 F8 事实）=====
router.delete('/:id', requirePerm('decision:delete'), async (req, res) => {
  const table = decisionsTable();
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '决策记录不存在' });

  const todos = todosTable();
  const linked = todos.all().filter(t => Number(t.decision_id) === Number(row.id));
  for (const t of linked) await todos.update(t.id, { decision_id: null, updated_at: now() });
  await getTable('decision_changes').deleteWhereNoSave(c => Number(c.decision_id) === Number(row.id));
  await getTable('decision_changes').saveNow();
  await table.delete(row.id);

  res.json({ message: '决策已删除', unlinked_todos: linked.length });
});

module.exports = router;
