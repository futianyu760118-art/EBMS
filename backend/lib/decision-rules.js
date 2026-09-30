'use strict';

/**
 * Decision 视图（PAND-87 / F9）纯规则层：状态口径、背景关联、候选方案、所需证据、
 * 结论不可静默修改的判定、变更留痕构造、执行 TODO 回看、编码与分页。
 *
 * 与 HTTP / 存储解耦，便于按 AC 逐条做单元验证（scripts/decision-view-regression.test.js）。
 *
 * 契约对齐：
 *   - Decision 本体 → AEOS.Decision.V1（contracts/aeos-contracts-v1.examples.json 的 decision 成员）
 *   - 执行 TODO    → AEOS.Action.V1（其 decision_id 即「决策派生的执行项」关联键）
 *   - 背景关联的结果/原因只做「引用 + 标注」，不自建专业事实源（P0 边界红线）。
 */

const CONTRACT_VERSION = 'AEOS.Decision.V1';
const ACTION_CONTRACT_VERSION = 'AEOS.Action.V1';

// ===== 状态口径（AC 边界 / 判定标准）=====
// 状态只有两种：未形成结论 = pending（待决策），已形成结论 = decided（已决策）。
// 「待决策」不计入已决策数量（countsByStatus）。
const STATUS_PENDING = 'pending';
const STATUS_DECIDED = 'decided';
const STATUSES = Object.freeze([STATUS_PENDING, STATUS_DECIDED]);
const STATUS_LABELS = Object.freeze({ pending: '待决策', decided: '已决策' });

// ===== 背景关联（AC 场景 1：背景 = 关联结果 / 原因）=====
const BACKGROUND_REF_TYPES = Object.freeze(['result', 'reason']);
const BACKGROUND_REF_TYPE_LABELS = Object.freeze({ result: '结果', reason: '原因' });

// ===== 执行 TODO 状态（AC 场景 3：关联执行产生的 TODO 并回看结果）=====
// 取值为执行项自身的事实（F8 / AEOS.Action.V1），Decision 侧只读取不重算。
const TODO_STATUSES = Object.freeze(['todo', 'doing', 'done', 'cancelled']);
const TODO_STATUS_LABELS = Object.freeze({ todo: '待办', doing: '进行中', done: '已完成', cancelled: '已取消' });
const EXEC_OVERDUE_LABEL = '逾期';

const DEFAULT_PAGE_SIZE = 20;
const ALLOWED_PAGE_SIZES = Object.freeze([10, 20, 50, 100, 200]);
const MAX_PAGE_SIZE = 200;
const ALLOWED_SORT_FIELDS = Object.freeze([
  'id', 'decision_code', 'title', 'status', 'decided_at', 'created_at', 'updated_at'
]);

function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function parsePage(raw) {
  const n = parseInt(raw, 10);
  return isNaN(n) || n <= 0 ? 1 : n;
}

function parsePageSize(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PAGE_SIZE;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

function statusLabel(status) {
  return STATUS_LABELS[str(status)] || str(status);
}

function isDecided(record) {
  return str(record && record.status) === STATUS_DECIDED;
}

// ===== 背景关联 =====
// 入参为 [{type:'result'|'reason', code, label}]；接受字符串 "result:gross_margin"。
// 至少 1 条（AC 场景 1「每条含 背景（关联结果 / 原因）」）。
function normalizeBackgroundRefs(v) {
  const raw = v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]);
  const refs = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    let type, code, label;
    if (item && typeof item === 'object') {
      type = str(item.type);
      code = str(item.code);
      label = str(item.label);
    } else {
      const text = str(item);
      const sep = text.indexOf(':');
      type = sep > 0 ? text.substring(0, sep) : '';
      code = sep > 0 ? text.substring(sep + 1) : text;
      label = '';
    }
    if (!type && !code) continue;
    if (BACKGROUND_REF_TYPES.indexOf(type) === -1) {
      return { error: '背景关联第 ' + (i + 1) + ' 条的关联类型必须是 result（结果）或 reason（原因），实际为：' + (type || '空') };
    }
    if (!code) {
      return { error: '背景关联第 ' + (i + 1) + ' 条缺少关联编码' };
    }
    if (refs.some(r => r.type === type && r.code === code)) continue;
    refs.push({ type, code, label, type_label: BACKGROUND_REF_TYPE_LABELS[type] });
  }
  if (!refs.length) {
    return { error: '背景必填：至少关联 1 条结果或原因' };
  }
  return { refs };
}

// ===== 候选方案（AC 场景 1：候选方案 ≥ 1 条）=====
function normalizeOptions(v) {
  const raw = v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]);
  const options = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const o = item && typeof item === 'object' ? item : { name: str(item) };
    const name = str(o.name);
    if (!name) {
      return { error: '候选方案第 ' + (i + 1) + ' 条缺少方案名称' };
    }
    options.push({
      name,
      description: str(o.description),
      pros: str(o.pros),
      cons: str(o.cons),
      selected: o.selected === true || str(o.selected).toLowerCase() === 'true'
    });
  }
  if (!options.length) {
    return { error: '候选方案必填：至少 1 条' };
  }
  if (options.filter(o => o.selected).length > 1) {
    return { error: '候选方案中至多 1 条可标记为采纳方案（selected）' };
  }
  return { options };
}

// ===== 所需 Evidence =====
// 允许为空数组：字段存在但为空表示「本决策无需外部证据」，不算缺失。
// 只引用证据标识与标题，证据事实本身归 Evidence 视图（F3/F10）。
function normalizeRequiredEvidence(v) {
  if (v === undefined || v === null || v === '') return { evidence: [] };
  const raw = Array.isArray(v) ? v : String(v).split(/[,，、]/);
  const out = [];
  for (const item of raw) {
    let code, title;
    if (item && typeof item === 'object') {
      code = str(item.evidence_code || item.code);
      title = str(item.title);
    } else {
      code = str(item);
      title = '';
    }
    if (!code) continue;
    if (out.some(e => e.evidence_code === code)) continue;
    out.push({ evidence_code: code, title });
  }
  return { evidence: out };
}

// ===== 决策记录归一化（创建）=====
function normalizeDecision(body) {
  const input = body || {};
  const title = str(input.title);
  if (!title) return { error: '决策标题必填' };

  const bg = normalizeBackgroundRefs(input.background);
  if (bg.error) return { error: bg.error };

  const opt = normalizeOptions(input.options);
  if (opt.error) return { error: opt.error };

  const ev = normalizeRequiredEvidence(input.required_evidence);

  return {
    record: {
      contract_version: CONTRACT_VERSION,
      decision_code: str(input.decision_code),
      title,
      summary: str(input.summary),
      background: bg.refs,
      options: opt.options,
      required_evidence: ev.evidence,
      // 创建即「待决策」：结论/决策人/决策时间一律为空，由形成结论接口写入
      status: STATUS_PENDING,
      conclusion: '',
      decided_by: '',
      decided_at: ''
    }
  };
}

/**
 * 形成 / 修改决策结论（AC 场景 2：不可静默修改，修改须留痕）。
 * @param {object} existing 现有决策记录
 * @param {object} body     请求体（conclusion / reason / decided_by / decided_at）
 * @param {object} actor    当前操作者 { id, name }
 * @param {string} at       本次操作时间（db.now()）
 * @returns {{error:string, status:number} | {patch:object, change:object}}
 */
function applyConclusion(existing, body, actor, at) {
  const input = body || {};
  const conclusion = str(input.conclusion);
  if (!conclusion) return { error: '决策结论必填', status: 400 };

  const actorName = str(actor && actor.name) || str(actor && actor.id) || '';
  const decidedBy = str(input.decided_by) || actorName;
  if (!decidedBy) return { error: '决策人必填', status: 400 };
  const decidedAt = str(input.decided_at) || at;
  const reason = str(input.reason);

  const already = isDecided(existing);

  // 结论未变化：不落变更记录（AC 判定「变更记录条数 ≥ 实际修改次数」，不得虚增）
  if (already && conclusion === str(existing.conclusion)) {
    return { error: '新结论与当前结论相同，未产生变更', status: 422 };
  }
  // 已形成结论后修改：必须留理由，否则即为「静默修改」
  if (already && !reason) {
    return { error: '决策结论不可静默修改：修改已形成的结论必须填写变更理由', status: 400 };
  }

  return {
    patch: {
      status: STATUS_DECIDED,
      conclusion,
      decided_by: decidedBy,
      decided_at: decidedAt,
      updated_at: at
    },
    change: {
      change_type: 'conclusion',
      before_status: already ? STATUS_DECIDED : STATUS_PENDING,
      after_status: STATUS_DECIDED,
      before_value: already ? str(existing.conclusion) : '',
      after_value: conclusion,
      before_decided_by: already ? str(existing.decided_by) : '',
      after_decided_by: decidedBy,
      reason,
      // 变更人：当前操作者（决策人可以代填，但留痕记实操作者）
      changed_by: actorName || decidedBy,
      changed_at: at
    }
  };
}

// ===== 已决策不变量自检（判定标准：已决策条目 决策人、决策时间 均非空）=====
function assertDecidedInvariant(record) {
  const status = str(record && record.status);
  if (STATUSES.indexOf(status) === -1) return '状态取值非法：' + (status || '空') + '（允许：' + STATUSES.join('、') + '）';
  const hasConclusion = !!str(record.conclusion);
  const hasBy = !!str(record.decided_by);
  const hasAt = !!str(record.decided_at);
  if (status === STATUS_DECIDED && !(hasConclusion && hasBy && hasAt)) {
    return '已决策记录必须同时具备 决策结论 / 决策人 / 决策时间';
  }
  if (status === STATUS_PENDING && (hasConclusion || hasBy || hasAt)) {
    return '待决策记录不应带 决策结论 / 决策人 / 决策时间';
  }
  return null;
}

// ===== 汇总（边界：待决策不计入已决策数量）=====
function countsByStatus(records) {
  let decided = 0;
  let pending = 0;
  (records || []).forEach(r => { if (isDecided(r)) decided++; else pending++; });
  return { total: decided + pending, decided, pending };
}

// 结论类变更条数（判定标准：变更记录条数 ≥ 实际修改次数）
function conclusionChangeCount(changes) {
  return (changes || []).filter(c => str(c && c.change_type) === 'conclusion').length;
}

function sortChanges(changes) {
  return (changes || []).slice().sort((a, b) => Number(a.seq || a.id || 0) - Number(b.seq || b.id || 0));
}

// ===== 执行 TODO 回看（AC 场景 3）=====
// 只读取执行项自身状态与到期时间，输出完成/进行中/待办/逾期与完成度；
// 不重算 F8 的状态流转算法，也不做决策效果评价（口径明确不要求）。
function deriveExecutionStatus(todo, today) {
  const raw = str(todo && todo.status).toLowerCase() || 'todo';
  const dueAt = str(todo && todo.due_at).substring(0, 10);
  const isDone = raw === 'done' || raw === 'cancelled';
  const overdue = !isDone && !!dueAt && !!today && dueAt < today;
  return {
    raw_status: raw,
    raw_status_label: TODO_STATUS_LABELS[raw] || raw,
    exec_status: overdue ? 'overdue' : raw,
    exec_label: overdue ? EXEC_OVERDUE_LABEL : (TODO_STATUS_LABELS[raw] || raw),
    overdue
  };
}

function executionSummary(todos, today) {
  const list = todos || [];
  let done = 0;
  let doing = 0;
  let pending = 0;
  let overdue = 0;
  let cancelled = 0;
  list.forEach(t => {
    const d = deriveExecutionStatus(t, today);
    if (d.raw_status === 'cancelled') { cancelled++; return; }
    if (d.raw_status === 'done') { done++; return; }
    // 逾期是独立状态桶：逾期项只计入 overdue，不同时计入 进行中 / 待办，四个桶互不重叠
    if (d.overdue) { overdue++; return; }
    if (d.raw_status === 'doing') doing++;
    else pending++;
  });
  const denominator = list.length - cancelled;
  return {
    total: list.length,
    done,
    doing,
    todo: pending,
    overdue,
    cancelled,
    completion_rate: denominator > 0 ? Math.round(done / denominator * 1000) / 10 : 0
  };
}

// ===== 编码 =====
// DEC + 年月 + 4 位流水号（按同前缀已有编码递增）
function genDecisionCode(records, periodYYYYMM) {
  const ym = str(periodYYYYMM).replace('-', '');
  const prefix = 'DEC' + ym;
  let maxSeq = 0;
  (records || []).forEach(r => {
    const code = str(r && r.decision_code);
    if (code.startsWith(prefix + '-')) {
      const seq = parseInt(code.substring(prefix.length + 1), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  });
  return prefix + '-' + String(maxSeq + 1).padStart(4, '0');
}

// ===== 检索条件 =====
function buildFilter(q) {
  const query = q || {};
  const status = str(query.status);
  const keyword = str(query.keyword).toLowerCase();
  const decidedBy = str(query.decided_by);
  const bgCode = str(query.background_code);
  const createdFrom = str(query.created_from);
  const createdTo = str(query.created_to);
  const decidedFrom = str(query.decided_from);
  const decidedTo = str(query.decided_to);

  return (r) => {
    if (!r) return false;
    // 状态筛选：仅认「待决策 / 已决策」两种口径
    if (status) {
      if (status !== STATUS_PENDING && status !== STATUS_DECIDED) return false;
      if (str(r.status) !== status) return false;
    }
    if (decidedBy && str(r.decided_by) !== decidedBy) return false;
    if (bgCode) {
      const refs = Array.isArray(r.background) ? r.background : [];
      if (!refs.some(x => str(x && x.code) === bgCode)) return false;
    }
    if (createdFrom && str(r.created_at).substring(0, 10) < createdFrom) return false;
    if (createdTo && str(r.created_at).substring(0, 10) > createdTo) return false;
    if (decidedFrom && str(r.decided_at).substring(0, 10) < decidedFrom) return false;
    if (decidedTo && str(r.decided_at).substring(0, 10) > decidedTo) return false;
    if (keyword) {
      const hay = [
        r.decision_code, r.title, r.summary, r.conclusion,
        (r.background || []).map(x => x && (x.code + ' ' + x.label)).join(' '),
        (r.options || []).map(x => x && x.name).join(' ')
      ].join(' ').toLowerCase();
      if (hay.indexOf(keyword) === -1) return false;
    }
    return true;
  };
}

function paginate(records, page, limit) {
  const list = records || [];
  const p = parsePage(page);
  const l = parsePageSize(limit);
  const pages = Math.max(1, Math.ceil(list.length / l));
  const start = (p - 1) * l;
  return { items: list.slice(start, start + l), total: list.length, page: p, limit: l, pages };
}

module.exports = {
  CONTRACT_VERSION,
  ACTION_CONTRACT_VERSION,
  STATUS_PENDING,
  STATUS_DECIDED,
  STATUSES,
  STATUS_LABELS,
  BACKGROUND_REF_TYPES,
  BACKGROUND_REF_TYPE_LABELS,
  TODO_STATUSES,
  TODO_STATUS_LABELS,
  DEFAULT_PAGE_SIZE,
  ALLOWED_PAGE_SIZES,
  MAX_PAGE_SIZE,
  ALLOWED_SORT_FIELDS,
  str,
  parsePage,
  parsePageSize,
  statusLabel,
  isDecided,
  normalizeBackgroundRefs,
  normalizeOptions,
  normalizeRequiredEvidence,
  normalizeDecision,
  applyConclusion,
  assertDecidedInvariant,
  countsByStatus,
  conclusionChangeCount,
  sortChanges,
  deriveExecutionStatus,
  executionSummary,
  genDecisionCode,
  buildFilter,
  paginate
};
