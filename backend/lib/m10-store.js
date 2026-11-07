/**
 * M10 POMS 微系统对接的存储层（EBMS / M03 侧）。
 *
 * 只新增同步专用 sidecar 表，不改动任何 EBMS 业务表结构，也不参与 EBMS 业务规则计算：
 *   m10_feedback       M10 执行反馈幂等日志（一次反馈一块，items 结果留档）
 *   m10_person_link    M10 人员标识到 EBMS 用户/组织人员的显式映射
 *
 * 配置写入 system_settings.m10_sync_config（与 aeos_sync_config 同模式，密钥一律走环境变量）。
 */
const { getTable, ensureTable, now, withTableLock } = require('../db');
const secrets = require('./secrets');

const TABLES = {
  feedback: 'm10_feedback',
  personLink: 'm10_person_link'
};

const CFG_KEY = 'm10_sync_config';

const DEFAULT_ROLE_MAP = Object.freeze({
  PURCHASE_HEAD: ['purchase', 'purchase_manager'],
  QUALITY_HEAD: ['engineer', 'rd_manager'],
  DEPT_HEAD: ['project_manager', 'rd_manager', 'sales_manager'],
  SALES_DIRECTOR: ['sales_director', 'sales_manager'],
  ENGINEER_HEAD: ['engineer', 'rd_manager'],
  IT_ADMIN: ['admin']
});

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  portalUrl: '',
  allowFeedback: true,
  includeSopActions: true,
  includeAiActions: true,
  includeChatActions: true,
  pageSize: 200,
  roleMap: DEFAULT_ROLE_MAP,
  owner: ''
});

function init() {
  Object.values(TABLES).forEach(ensureTable);
}

function t(key) { return getTable(TABLES[key]); }

function all(key) { return t(key).all(); }

function findById(key, id) { return t(key).findById(id); }

function insert(key, rec) { return t(key).insert(rec); }

function update(key, id, fields) { return t(key).update(id, fields); }

function del(key, id) { return t(key).delete(id); }

// ============================ 配置 ============================
function getConfigRaw() {
  const rows = getTable('system_settings').all();
  const row = rows.find(r => r.key === CFG_KEY);
  if (!row || !row.value) return null;
  try { return JSON.parse(row.value); } catch (e) { return null; }
}

function getConfig() {
  const stored = getConfigRaw() || {};
  const cfg = Object.assign({}, DEFAULT_CONFIG, stored);
  cfg.roleMap = Object.assign({}, DEFAULT_ROLE_MAP, (stored && stored.roleMap) || {});
  const envPortal = secrets.m10PortalUrl();
  if (envPortal) cfg.portalUrl = envPortal;
  return cfg;
}

function sanitizeRoleMap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return Object.assign({}, DEFAULT_ROLE_MAP);
  const out = {};
  Object.keys(input).forEach(k => {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(k)) return;
    const v = input[k];
    if (!Array.isArray(v)) return;
    out[k] = v.filter(x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x)).slice(0, 20);
  });
  return out;
}

function boolOr(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (value === false || value === 0) return false;
  const s = String(value).trim().toLowerCase();
  return !(s === 'false' || s === '0' || s === 'no' || s === 'off');
}

/** 写入配置：只允许非机密项入库；任何 token / password 字段一律丢弃。 */
async function setConfig(patch) {
  const next = Object.assign({}, DEFAULT_CONFIG, getConfigRaw() || {}, patch || {});
  delete next.token;
  delete next.apiKey;
  delete next.password;
  const value = {
    enabled: boolOr(next.enabled, true),
    portalUrl: String(next.portalUrl || ''),
    allowFeedback: boolOr(next.allowFeedback, true),
    includeSopActions: boolOr(next.includeSopActions, true),
    includeAiActions: boolOr(next.includeAiActions, true),
    includeChatActions: boolOr(next.includeChatActions, true),
    pageSize: Math.max(1, Math.min(500, parseInt(next.pageSize, 10) || 200)),
    roleMap: sanitizeRoleMap(next.roleMap),
    owner: String(next.owner || '')
  };
  const val = JSON.stringify(value);
  const tb = getTable('system_settings');
  const existing = tb.all().find(r => r.key === CFG_KEY);
  if (existing) await tb.update(existing.id, { value: val, updated_at: now() });
  else await tb.insert({ key: CFG_KEY, value: val, created_at: now(), updated_at: now() });
  return getConfig();
}

function transportStatus() {
  const cfg = getConfig();
  const token = secrets.m10PartnerToken();
  const missing = secrets.missingM10();
  return {
    enabled: !!cfg.enabled,
    ready: !!cfg.enabled && !!token,
    token_configured: !!token,
    portal_url: cfg.portalUrl || '',
    missing_env: missing,
    reason: !cfg.enabled ? 'M10 对接已在配置中停用'
      : (!token ? '未配置 M10_PARTNER_TOKEN（M10 入站/出站均不可用）' : '')
  };
}

// ============================ 人员映射 ============================
function findPersonLink(m10PersonId) {
  const id = String(m10PersonId || '');
  if (!id) return null;
  return t('personLink').all().find(r => String(r.m10_person_id) === id) || null;
}

function listPersonLinks() {
  return t('personLink').all().slice().sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
}

async function upsertPersonLink(rec) {
  const m10PersonId = String((rec && rec.m10_person_id) || '').trim();
  if (!m10PersonId) throw new Error('m10_person_id 必填');
  return withTableLock('m10_person_link_upsert', async () => {
    const tb = t('personLink');
    const existing = tb.all().find(r => String(r.m10_person_id) === m10PersonId);
    const stamp = now();
    const fields = {
      m10_person_id: m10PersonId,
      ebms_user_id: rec.ebms_user_id !== undefined && rec.ebms_user_id !== null && rec.ebms_user_id !== '' ? Number(rec.ebms_user_id) : null,
      ebms_personnel_id: rec.ebms_personnel_id !== undefined && rec.ebms_personnel_id !== null && rec.ebms_personnel_id !== '' ? Number(rec.ebms_personnel_id) : null,
      name: String(rec.name || ''),
      emp_code: String(rec.emp_code || ''),
      updated_at: stamp
    };
    if (existing) {
      await tb.update(existing.id, fields);
      return tb.findById(existing.id);
    }
    await tb.insert(Object.assign({ created_at: stamp }, fields));
    return tb.all().find(r => String(r.m10_person_id) === m10PersonId) || null;
  });
}

async function removePersonLink(id) {
  const row = t('personLink').findById(id);
  if (!row) return false;
  await t('personLink').delete(row.id);
  return true;
}

// ============================ 执行反馈幂等日志 ============================
function findFeedbackByKey(idempotencyKey) {
  const key = String(idempotencyKey || '');
  if (!key) return null;
  return t('feedback').all().slice().reverse()
    .find(r => r.idempotency_key === key && (r.status === 'applied' || r.status === 'partial' || r.status === 'skipped')) || null;
}

function logFeedback(rec) {
  return insert('feedback', {
    feedback_id: rec.feedback_id || '',
    idempotency_key: rec.idempotency_key || '',
    person_id: rec.person_id || '',
    ebms_user_id: rec.ebms_user_id || null,
    item_count: rec.item_count || 0,
    applied_count: rec.applied_count || 0,
    skipped_count: rec.skipped_count || 0,
    conflict_count: rec.conflict_count || 0,
    status: rec.status || 'received',
    items_json: rec.items_json || '[]',
    request_payload: rec.request_payload || '',
    source_ip: rec.source_ip || '',
    received_at: rec.received_at || now(),
    created_at: now()
  });
}

function listFeedback(query) {
  const q = query || {};
  let rows = t('feedback').all().slice().sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
  if (q.status) rows = rows.filter(r => r.status === q.status);
  if (q.person_id) rows = rows.filter(r => String(r.person_id) === String(q.person_id));
  const total = rows.length;
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const pageSize = Math.max(1, Math.min(500, parseInt(q.pageSize, 10) || 50));
  return {
    total,
    page,
    pageSize,
    rows: rows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize)
  };
}

function feedbackCounts() {
  const rows = t('feedback').all();
  return {
    total: rows.length,
    applied: rows.filter(r => r.status === 'applied').length,
    partial: rows.filter(r => r.status === 'partial').length,
    skipped: rows.filter(r => r.status === 'skipped').length,
    conflict: rows.filter(r => r.status === 'conflict').length
  };
}

module.exports = {
  TABLES,
  CFG_KEY,
  DEFAULT_CONFIG,
  DEFAULT_ROLE_MAP,
  init,
  t,
  all,
  findById,
  insert,
  update,
  del,
  getConfig,
  getConfigRaw,
  setConfig,
  sanitizeRoleMap,
  transportStatus,
  findPersonLink,
  listPersonLinks,
  upsertPersonLink,
  removePersonLink,
  findFeedbackByKey,
  logFeedback,
  listFeedback,
  feedbackCounts
};
