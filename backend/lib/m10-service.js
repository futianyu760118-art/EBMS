/**
 * M10 POMS 微系统对接服务（EBMS / M03 侧）。
 *
 * 数据方向：
 *   EBMS -> M10：工作台 manifest、工作项（SOP Action / AI Action / 会话行动项）、结果引用。
 *   M10 -> EBMS：执行反馈（开始 / 阻塞 / 完成 + 证据引用 + 备注），写回原业务对象状态。
 *
 * 边界：
 *   - 不新建第二套待办事实源；工作项始终由 EBMS 原业务表实时派生。
 *   - M10 回传只更新 EBMS 所属的管理行动记录，不跨域写专业表。
 *   - 未完成/无证据的完成动作不会被伪造为 verified，结果验证仍由 EBMS 管理侧留痕。
 */
const { getTable, now, withTableLock } = require('../db');
const C = require('./m10-contract');
const store = require('./m10-store');

function asList(table) {
  const t = getTable(table);
  t._invalidate();
  return t.all();
}

function dateToIso(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + 'T18:00:00+08:00';
  return s;
}

function today() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function splitOwnerNames(value) {
  return String(value || '')
    .split(/[+,、/;；\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function loadUser(id) {
  if (id === undefined || id === null || id === '') return null;
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  return getTable('users').all().find(u => Number(u.id) === n) || null;
}

function roleCodesForUser(user) {
  const codes = new Set();
  if (!user) return codes;
  if (user.role) codes.add(String(user.role));
  const roleById = new Map(getTable('roles').all().map(r => [Number(r.id), r]));
  asList('user_roles')
    .filter(ur => Number(ur.user_id) === Number(user.id))
    .forEach(ur => {
      const r = roleById.get(Number(ur.role_id));
      if (r && r.code) codes.add(String(r.code));
    });
  return codes;
}

/**
 * 解析人员引用。支持：
 *   - m10_person_id（m10_person_link 显式映射）
 *   - ebms_user_id（数字用户 ID / 用户名 / 姓名）
 *   - emp_code（组织人员工号）
 *   - name（姓名，需唯一）
 */
function resolvePerson(ref) {
  const r = ref || {};
  const m10PersonId = r.m10_person_id !== undefined && r.m10_person_id !== null ? String(r.m10_person_id).trim() : '';
  const personId = r.person_id !== undefined && r.person_id !== null ? String(r.person_id).trim() : '';
  const ebmsUserId = r.ebms_user_id !== undefined && r.ebms_user_id !== null ? String(r.ebms_user_id).trim() : '';
  const empCode = r.emp_code !== undefined && r.emp_code !== null ? String(r.emp_code).trim() : '';
  const name = r.name !== undefined && r.name !== null ? String(r.name).trim() : '';

  const users = asList('users');
  const personnel = asList('org_personnel');

  let link = null;
  if (m10PersonId) link = store.findPersonLink(m10PersonId);
  if (!link && personId) link = store.findPersonLink(personId);

  let user = null;
  let person = null;
  if (link) {
    if (link.ebms_user_id) user = loadUser(link.ebms_user_id);
    if (link.ebms_personnel_id) person = personnel.find(p => Number(p.id) === Number(link.ebms_personnel_id)) || null;
    if (!user && person && person.linked_user_id) user = loadUser(person.linked_user_id);
  }

  // EBMS 自己输出的稳定人员标识可直接反解，避免 M10 必须额外保存映射。
  const uidMatch = /^ebms:user:(\d+)$/.exec(personId) || /^ebms:user:(\d+)$/.exec(m10PersonId);
  if (!user && uidMatch) user = loadUser(uidMatch[1]);
  const pidMatch = /^ebms:person:(\d+)$/.exec(personId) || /^ebms:person:(\d+)$/.exec(m10PersonId);
  if (!person && pidMatch) person = personnel.find(p => Number(p.id) === Number(pidMatch[1])) || null;

  const candidates = [ebmsUserId, personId, m10PersonId, empCode, name].filter(Boolean);
  if (!user) {
    for (const c of candidates) {
      user = users.find(u => String(u.id) === c || String(u.username) === c || String(u.name) === c) || null;
      if (user) break;
    }
  }
  if (!person) {
    for (const c of candidates) {
      person = personnel.find(p =>
        String(p.id) === c || String(p.emp_code) === c || String(p.name) === c
      ) || null;
      if (person) break;
    }
  }
  if (!person && user) {
    person = personnel.find(p => Number(p.linked_user_id) === Number(user.id) || String(p.name) === String(user.name)) || null;
  }
  if (!user && person && person.linked_user_id) user = loadUser(person.linked_user_id);

  if (!user && !person && !link) return null;

  const roleCodes = roleCodesForUser(user);
  const displayName = (link && link.name) || (user && (user.name || user.username)) || (person && person.name) || name || '';
  const effectiveM10Id = m10PersonId || (link && link.m10_person_id) || personId || (user ? 'ebms:user:' + user.id : 'ebms:person:' + (person && person.id));

  return {
    m10_person_id: effectiveM10Id,
    ebms_user_id: user ? Number(user.id) : (link && link.ebms_user_id) || null,
    ebms_personnel_id: person ? Number(person.id) : (link && link.ebms_personnel_id) || null,
    username: user ? String(user.username || '') : '',
    name: displayName,
    emp_code: (person && String(person.emp_code || '')) || (link && link.emp_code) || '',
    positions: person && person.position_name ? [String(person.position_name)] : [],
    department: person ? String(person.department_name || '') : '',
    role_codes: Array.from(roleCodes)
  };
}

function isAdminUser(user) {
  return !!(user && (String(user.role) === 'admin' || (user.username && String(user.username) === 'admin')));
}

function isOwnerName(ownerName, person) {
  if (!person) return false;
  const names = [person.name, person.username, person.emp_code].filter(Boolean).map(String);
  const parts = splitOwnerNames(ownerName);
  return parts.some(p => names.includes(p));
}

function matchesPerson(item, person, roleMap) {
  if (!person) return true;
  const names = [person.name, person.username, person.emp_code].filter(Boolean).map(String);
  const assignees = [item.assignee, item.assignee_name].filter(Boolean).map(String);
  if (assignees.some(n => names.includes(n))) return true;
  if (item.owner_name && isOwnerName(item.owner_name, person)) return true;
  if (item.assignee_name && isOwnerName(item.assignee_name, person)) return true;
  if (item.created_by !== undefined && person.ebms_user_id && String(item.created_by) === String(person.ebms_user_id)) return true;
  const roleCodes = new Set(person.role_codes || []);
  if (item.owner_role) {
    const mapped = (roleMap && roleMap[item.owner_role]) || [];
    if (mapped.some(code => roleCodes.has(code))) return true;
  }
  return false;
}

function sopToItem(a) {
  const display = C.SOP_TO_DISPLAY[String(a.status || '').toUpperCase()] || 'pending';
  return {
    work_item_id: C.workItemId('sop_action', a.id),
    source_system: C.SOURCE_SYSTEM,
    source_object_type: C.SOURCE_OBJECT_TYPES.SOP_ACTION,
    source_object_id: String(a.id),
    title: a.description || a.action_code || ('SOP Action #' + a.id),
    description: a.description || '',
    display_status: display,
    priority: a.priority || '',
    due_at: dateToIso(a.due_date),
    assignee_name: a.owner_name || '',
    assignee_role: a.owner_role || '',
    owner_name: a.owner_name || '',
    owner_role: a.owner_role || '',
    evidence_refs: a.evidence_url ? [String(a.evidence_url)] : [],
    deep_link: '/sop.html?actionId=' + encodeURIComponent(String(a.id)),
    allowed_action_refs: display === 'done' || display === 'cancelled' ? [] : ['ebms.work_item.start', 'ebms.work_item.complete'],
    updated_at: a.updated_at || a.created_at || ''
  };
}

function aiToItem(a) {
  const raw = String(a.status || '').toLowerCase();
  const display = raw === 'done' || raw === 'completed' || raw === 'closed' ? 'done'
    : raw === 'in_progress' || raw === 'processing' ? 'in_progress' : 'pending';
  return {
    work_item_id: C.workItemId('ai_action', a.id),
    source_system: C.SOURCE_SYSTEM,
    source_object_type: C.SOURCE_OBJECT_TYPES.AI_ACTION,
    source_object_id: String(a.id),
    title: a.title || a.content || ('AI Action #' + a.id),
    description: a.content || '',
    display_status: display,
    priority: a.priority || '',
    due_at: dateToIso(a.deadline),
    assignee_name: a.assignee || a.user || '',
    assignee_role: '',
    evidence_refs: [],
    deep_link: '/ai-assistant.html?actionId=' + encodeURIComponent(String(a.id)),
    allowed_action_refs: display === 'done' ? [] : ['ebms.work_item.start', 'ebms.work_item.complete'],
    updated_at: a.updated_at || a.created_at || ''
  };
}

function chatToItem(a) {
  const raw = String(a.status || '').toLowerCase();
  const display = raw === 'done' || raw === 'completed' || raw === 'closed' ? 'done'
    : raw === 'in_progress' || raw === 'processing' ? 'in_progress' : 'pending';
  return {
    work_item_id: C.workItemId('chat_action_item', a.id),
    source_system: C.SOURCE_SYSTEM,
    source_object_type: C.SOURCE_OBJECT_TYPES.CHAT_ACTION_ITEM,
    source_object_id: String(a.id),
    title: a.content || ('AI 会话行动项 #' + a.id),
    description: a.content || '',
    display_status: display,
    priority: a.priority || '',
    due_at: null,
    assignee_name: a.assignee || a.created_by || '',
    assignee_role: '',
    evidence_refs: [],
    deep_link: '/ai-assistant.html?actionItemId=' + encodeURIComponent(String(a.id)),
    allowed_action_refs: display === 'done' ? [] : ['ebms.work_item.complete'],
    updated_at: a.updated_at || a.created_at || ''
  };
}

function allItems(cfg) {
  const out = [];
  if (cfg.includeSopActions !== false) asList('sop_actions').forEach(a => out.push(sopToItem(a)));
  if (cfg.includeAiActions !== false) asList('ai_actions').forEach(a => out.push(aiToItem(a)));
  if (cfg.includeChatActions !== false) asList('chat_action_items').forEach(a => out.push(chatToItem(a)));
  return out;
}

function decorate(item) {
  const due = item.due_at ? String(item.due_at).slice(0, 10) : '';
  const overdue = !!due && due < today() && item.display_status !== 'done' && item.display_status !== 'cancelled';
  return Object.assign({}, item, { overdue });
}

function summarize(items) {
  return {
    total: items.length,
    pending: items.filter(i => i.display_status === 'pending').length,
    in_progress: items.filter(i => i.display_status === 'in_progress').length,
    awaiting_acceptance: items.filter(i => i.display_status === 'awaiting_acceptance').length,
    blocked: items.filter(i => i.display_status === 'blocked').length,
    overdue: items.filter(i => i.overdue).length,
    done: items.filter(i => i.display_status === 'done').length
  };
}

function collectWorkItems(person, opts) {
  const o = opts || {};
  if (!person && !o.allowAll) return [];
  const cfg = store.getConfig();
  const roleMap = cfg.roleMap || {};
  let items = allItems(cfg).filter(item => matchesPerson(item, person, roleMap));
  if (o.status) items = items.filter(item => item.display_status === o.status);
  else if (!o.include_done) items = items.filter(item => item.display_status !== 'done' && item.display_status !== 'cancelled');
  items = items.map(decorate);
  items.sort((a, b) => String(a.due_at || '9999').localeCompare(String(b.due_at || '9999')) ||
    String(a.priority || '').localeCompare(String(b.priority || '')));
  const limit = Math.max(1, Math.min(1000, parseInt(o.limit, 10) || cfg.pageSize || 200));
  return items.slice(0, limit);
}

function collectResults(person, opts) {
  const o = opts || {};
  if (!person && !o.allowAll) return [];
  const cfg = store.getConfig();
  const roleMap = cfg.roleMap || {};
  const out = [];

  if (cfg.includeSopActions !== false) {
    asList('sop_actions').filter(a => String(a.status || '').toUpperCase() === 'CLOSED').forEach(a => {
      const item = sopToItem(a);
      if (!matchesPerson(item, person, roleMap)) return;
      out.push({
        result_id: 'ebms:result:sop_action:' + a.id,
        source_system: C.SOURCE_SYSTEM,
        source_object_type: C.SOURCE_OBJECT_TYPES.SOP_ACTION,
        source_object_id: String(a.id),
        title: item.title,
        verification: (a.verified_by || a.verified_at) ? 'verified' : 'pending',
        evidence_refs: a.evidence_url ? [String(a.evidence_url)] : [],
        verified_by: a.verified_by || '',
        verified_at: a.verified_at || '',
        occurred_at: a.closed_at || a.updated_at || a.created_at || ''
      });
    });
  }
  if (cfg.includeAiActions !== false) {
    asList('ai_actions').filter(a => {
      const s = String(a.status || '').toLowerCase();
      return s === 'done' || s === 'completed' || s === 'closed';
    }).forEach(a => {
      const item = aiToItem(a);
      if (!matchesPerson(item, person, roleMap)) return;
      out.push({
        result_id: 'ebms:result:ai_action:' + a.id,
        source_system: C.SOURCE_SYSTEM,
        source_object_type: C.SOURCE_OBJECT_TYPES.AI_ACTION,
        source_object_id: String(a.id),
        title: item.title,
        verification: (a.verified_by || a.verified_at) ? 'verified' : 'pending',
        evidence_refs: [],
        verified_by: a.verified_by || '',
        verified_at: a.verified_at || '',
        occurred_at: a.updated_at || a.created_at || ''
      });
    });
  }
  if (cfg.includeChatActions !== false) {
    asList('chat_action_items').filter(a => String(a.status || '').toLowerCase() === 'done').forEach(a => {
      const item = chatToItem(a);
      if (!matchesPerson(item, person, roleMap)) return;
      out.push({
        result_id: 'ebms:result:chat_action_item:' + a.id,
        source_system: C.SOURCE_SYSTEM,
        source_object_type: C.SOURCE_OBJECT_TYPES.CHAT_ACTION_ITEM,
        source_object_id: String(a.id),
        title: item.title,
        verification: 'pending',
        evidence_refs: [],
        verified_by: '',
        verified_at: a.updated_at || '',
        occurred_at: a.updated_at || a.created_at || ''
      });
    });
  }

  out.sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')));
  const limit = Math.max(1, Math.min(1000, parseInt(o.limit, 10) || cfg.pageSize || 200));
  return out.slice(0, limit);
}

function buildWorkspace(person, opts) {
  const o = opts || {};
  const cfg = store.getConfig();
  const open = collectWorkItems(person, { include_done: false, limit: 1000 });
  const results = collectResults(person, { limit: 1000 });
  const summary = summarize(open);
  const actions = ['ebms.work_item.read'];
  if (person && open.length) actions.push('ebms.work_item.start', 'ebms.work_item.complete');
  if (person && results.length) actions.push('ebms.result.read');
  if (cfg.portalUrl) actions.push('ebms.portal.open');
  return {
    contract_version: C.CONTRACT_VERSION,
    tenant_id: 'EBMS',
    person_id: person ? person.m10_person_id : '',
    ebms_user_id: person ? person.ebms_user_id : null,
    name: person ? person.name : '',
    person_unmapped: !person,
    positions: person ? person.positions : [],
    department: person ? person.department : '',
    role_codes: person ? person.role_codes : [],
    policy_version: 'ebms-m10-v1',
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    industry_pack_ref: '',
    portal_url: cfg.portalUrl || '',
    widgets: [
      { id: 'future_todos', visible: true, count: summary.total, summary },
      { id: 'past_results', visible: true, count: results.length },
      { id: 'personal_agent', visible: false, hint: '个人 Agent 由 AEOS Hub 提供，EBMS 不重复建设' }
    ],
    actions,
    source: 'ebms'
  };
}

function findSource(slug, id) {
  const map = {
    sop_action: 'sop_actions',
    ai_action: 'ai_actions',
    chat_action_item: 'chat_action_items'
  };
  const table = map[slug];
  if (!table) return null;
  const row = getTable(table).findById(id);
  return row ? { slug, table, row } : null;
}

function isItemOwnedBy(source, person, cfg) {
  if (!person) return false;
  if (source.slug === 'sop_action') return matchesPerson(sopToItem(source.row), person, cfg.roleMap || {});
  if (source.slug === 'ai_action') return matchesPerson(aiToItem(source.row), person, cfg.roleMap || {});
  if (source.slug === 'chat_action_item') return matchesPerson(chatToItem(source.row), person, cfg.roleMap || {});
  return false;
}

function audit(action, tableName, recordId, payload, actor) {
  try {
    const r = getTable('audit_logs').insert({
      table_name: tableName,
      record_id: recordId,
      action: action,
      new_value_json: JSON.stringify(payload || {}),
      changed_by: actor || 0,
      changed_at: now(),
      change_reason: 'M10 POMS 执行反馈'
    });
    if (r && typeof r.catch === 'function') r.catch(e => console.error('[m10] 写审计日志失败:', e.message));
  } catch (e) {
    // 审计失败不阻断反馈主流程，但保留日志便于排查
    console.error('[m10] 写审计日志失败:', e.message);
  }
}

async function applySopFeedback(row, item) {
  const before = String(row.status || '').toUpperCase();
  if (before === 'CLOSED') {
    return item.status === 'done'
      ? { status: 'skipped', reason: 'ALREADY_CLOSED' }
      : { status: 'conflict', reason: 'SOP_ACTION_ALREADY_CLOSED' };
  }
  if (before === 'CANCELLED') return { status: 'conflict', reason: 'SOP_ACTION_CANCELLED' };

  const fields = { updated_at: now() };
  const next = C.DISPLAY_TO_SOP[item.status];
  if (next) fields.status = next;
  if (item.evidence_refs && item.evidence_refs.length) fields.evidence_url = item.evidence_refs[0];
  if (item.remark) fields.remark = item.remark;
  if (item.status === 'done') fields.closed_at = item.completed_at || now();
  await getTable('sop_actions').update(row.id, fields);
  return { status: 'applied', changes: fields };
}

async function applyAiFeedback(row, item) {
  const fields = { updated_at: now() };
  if (item.status === 'done') {
    fields.status = 'done';
    const result = item.remark || (item.evidence_refs || []).join('，');
    if (result) fields.result = result;
  } else if (item.status === 'in_progress' || item.status === 'blocked') {
    fields.status = 'in_progress';
    if (item.remark) fields.result = item.remark;
  } else if (item.status === 'pending') {
    fields.status = 'pending';
  } else if (item.status === 'cancelled') {
    fields.status = 'cancelled';
  } else {
    return { status: 'skipped', reason: 'AI_ACTION_STATUS_NOT_APPLICABLE' };
  }
  await getTable('ai_actions').update(row.id, fields);
  return { status: 'applied', changes: fields };
}

async function applyChatFeedback(row, item) {
  const fields = { updated_at: now() };
  if (item.status === 'done') fields.status = 'done';
  else if (item.status === 'in_progress' || item.status === 'blocked') fields.status = 'in_progress';
  else if (item.status === 'pending') fields.status = 'pending';
  else if (item.status === 'cancelled') fields.status = 'cancelled';
  else return { status: 'skipped', reason: 'CHAT_ACTION_STATUS_NOT_APPLICABLE' };
  await getTable('chat_action_items').update(row.id, fields);
  return { status: 'applied', changes: fields };
}

async function applyItem(item, person, opts) {
  const source = findSource(item.slug, item.source_object_id);
  if (!source) return { work_item_id: item.work_item_id, status: 'conflict', reason: 'SOURCE_NOT_FOUND' };
  if (!opts.allowAny && !isItemOwnedBy(source, person, store.getConfig())) {
    return { work_item_id: item.work_item_id, status: 'forbidden', reason: 'NOT_ASSIGNEE' };
  }

  let r;
  if (source.slug === 'sop_action') r = await applySopFeedback(source.row, item);
  else if (source.slug === 'ai_action') r = await applyAiFeedback(source.row, item);
  else r = await applyChatFeedback(source.row, item);

  if (r.status === 'applied') {
    audit('M10_FEEDBACK', source.table, source.row.id, {
      work_item_id: item.work_item_id,
      feedback_status: item.status,
      evidence_refs: item.evidence_refs,
      remark: item.remark,
      changes: r.changes
    }, person && person.ebms_user_id);
  }
  return Object.assign({ work_item_id: item.work_item_id, source_object_type: item.source_object_type, source_object_id: item.source_object_id }, r);
}

async function applyFeedback(envelope, person, opts) {
  const o = opts || {};
  const items = envelope.items || [];
  return withTableLock('m10_feedback_apply', async () => {
    const existing = store.findFeedbackByKey(envelope.idempotency_key);
    if (existing) {
      return {
        result: 'skipped',
        duplicate: true,
        feedback_id: existing.feedback_id,
        idempotency_key: existing.idempotency_key,
        applied: existing.applied_count,
        skipped: existing.skipped_count,
        conflicts: existing.conflict_count,
        items: []
      };
    }

    const results = [];
    for (const item of items) results.push(await applyItem(item, person, o));
    const applied = results.filter(r => r.status === 'applied').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const conflicts = results.filter(r => r.status === 'conflict' || r.status === 'forbidden').length;
    const status = conflicts > 0 ? (applied + skipped > 0 ? 'partial' : 'conflict') : (applied > 0 ? 'applied' : 'skipped');

    await store.logFeedback({
      feedback_id: envelope.feedback_id,
      idempotency_key: envelope.idempotency_key,
      person_id: person ? person.m10_person_id : '',
      ebms_user_id: person ? person.ebms_user_id : null,
      item_count: items.length,
      applied_count: applied,
      skipped_count: skipped,
      conflict_count: conflicts,
      status,
      items_json: JSON.stringify(results),
      request_payload: JSON.stringify(envelope),
      source_ip: o.source_ip || '',
      received_at: now()
    });

    return {
      result: status,
      feedback_id: envelope.feedback_id,
      idempotency_key: envelope.idempotency_key,
      applied,
      skipped,
      conflicts,
      items: results
    };
  });
}

module.exports = {
  resolvePerson,
  roleCodesForUser,
  isAdminUser,
  matchesPerson,
  collectWorkItems,
  collectResults,
  buildWorkspace,
  summarize,
  applyFeedback,
  findSource
};
