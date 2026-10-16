/**
 * AEOS 同步通道的存储层（EBMS 侧）—— 出站队列、入站日志、同步态 sidecar、冲突留痕、
 * 驾驶舱消费表（Result/Exception）与字典组。所有表均为「同步专用」sidecar 表，
 * 不改动任何 EBMS 业务表结构，也不参与 EBMS 业务规则计算（红线）。
 *
 * 表清单：
 *   aeos_outbox            出站队列（Outbox 模式，对齐 lib/material-outbox.js）
 *   aeos_inbound_log       入站处理日志（幂等判重 + AC-S8 可反查原始报文）
 *   aeos_sync_state        对象级同步态 sidecar（external_id / sync_status / last_sync_at，§2 通则）
 *   aeos_sync_conflict     冲突留痕（对齐 CRM sync_conflict，§6 / AC-S7）
 *   aeos_results           AEOS.Result.V1 落地（供 M03 驾驶舱消费）
 *   aeos_exceptions        AEOS.Exception.V1 落地（供 M03 驾驶舱消费）
 *   aeos_dictionary        dictionary.upserted（P1）字典组 sidecar
 *   aeos_dictionary_entry  字典组条目 sidecar
 *   aeos_export_log        迁移导出批次日志
 */
const { getTable, ensureTable, now } = require('../db');
const secrets = require('./secrets');

const TABLES = {
  outbox: 'aeos_outbox',
  inbound: 'aeos_inbound_log',
  state: 'aeos_sync_state',
  conflict: 'aeos_sync_conflict',
  results: 'aeos_results',
  exceptions: 'aeos_exceptions',
  dictionary: 'aeos_dictionary',
  dictionaryEntry: 'aeos_dictionary_entry',
  exportLog: 'aeos_export_log'
};

const CFG_KEY = 'aeos_sync_config';

function init() {
  Object.values(TABLES).forEach(ensureTable);
}

function t(key) { return getTable(TABLES[key]); }

function all(key) {
  const tb = t(key);
  return tb.all();
}

function insert(key, rec) { return t(key).insert(rec); }
function update(key, id, fields) { return t(key).update(id, fields); }
function del(key, id) { return t(key).delete(id); }

// ============================ 同步配置（system_settings，与 material_write_config 同模式）============================
const DEFAULT_CONFIG = {
  enabled: false,
  mode: 'http',            // http | spool | dry_run
  url: '',                 // CRM 入站端点，默认 https://<crm>/api/v1/integrations/ebms/ingest
  tokenRef: '',            // 仅记录「凭据来自环境变量 EBMS_INBOUND_TOKEN」的说明，不落明文
  spoolDir: '',            // mode=spool 时的落盘目录
  batchSize: 200,          // 单次 flush 最多投递条数
  owner: ''                // 操作说明/审计用备注
};

function getConfigRaw() {
  const rows = getTable('system_settings').all();
  const row = rows.find(r => r.key === CFG_KEY);
  if (!row || !row.value) return null;
  try { return JSON.parse(row.value); } catch (e) { return null; }
}

/** 对外生效配置：环境变量优先（部署期注入，不进库），其次 system_settings。 */
function getConfig() {
  const stored = getConfigRaw() || {};
  const cfg = Object.assign({}, DEFAULT_CONFIG, stored);
  const envUrl = secrets.aeosCrmIngestUrl();
  const envSpool = secrets.aeosSpoolDir();
  if (envUrl) cfg.url = envUrl;
  if (envSpool) cfg.spoolDir = envSpool;
  return cfg;
}

/** 写入配置：仅允许非机密项入库；token 一律走环境变量。 */
async function setConfig(patch) {
  const next = Object.assign({}, DEFAULT_CONFIG, getConfigRaw() || {}, patch || {});
  delete next.token; // 防误写密钥（约束：不写入密钥/token/密码）
  const val = JSON.stringify({
    enabled: !!next.enabled,
    mode: ['http', 'spool', 'dry_run'].includes(next.mode) ? next.mode : 'http',
    url: String(next.url || ''),
    tokenRef: String(next.tokenRef || ''),
    spoolDir: String(next.spoolDir || ''),
    batchSize: Math.max(1, Math.min(2000, parseInt(next.batchSize, 10) || 200)),
    owner: String(next.owner || '')
  });
  const tb = getTable('system_settings');
  const existing = tb.all().find(r => r.key === CFG_KEY);
  if (existing) await tb.update(existing.id, { value: val, updated_at: now() });
  else await tb.insert({ key: CFG_KEY, value: val, created_at: now(), updated_at: now() });
  return getConfig();
}

/** 投递是否已就绪（配置齐备）。未就绪时队列只暂存，不消耗重试次数。 */
function transportStatus() {
  const cfg = getConfig();
  const token = secrets.aeosOutboundToken();
  if (cfg.mode === 'dry_run') return { ready: true, mode: 'dry_run', reason: '演练模式' };
  if (cfg.mode === 'spool') {
    return { ready: !!cfg.spoolDir, mode: 'spool', reason: cfg.spoolDir ? '' : '未配置 spoolDir' };
  }
  const reasons = [];
  if (!cfg.url) reasons.push('未配置 CRM 入站地址（EBMS_CRM_INGEST_URL 或 system_settings.aeos_sync_config.url）');
  if (!token) reasons.push('未配置出站凭据（环境变量 EBMS_INBOUND_TOKEN）');
  return { ready: reasons.length === 0, mode: 'http', reason: reasons.join('；') };
}

// ============================ 对象同步态 sidecar（§2 通则）============================
/**
 * 一条 (object_type, object_id) 对应一行，承载：
 *   local_table/local_id  ← EBMS 本地落点（双向定位，AC-S6）
 *   sync_status           ← PENDING/SYNCING/SYNCED/CONFLICT（DELETE 保护判定，§6.5）
 *   last_sync_at          ← 乱序判定基准（§6.4）
 */
function findState(objectType, objectId) {
  const tb = t('state');
  return tb.all().find(r => r.object_type === objectType && String(r.object_id) === String(objectId)) || null;
}

async function upsertState(objectType, objectId, patch) {
  const tb = t('state');
  const existing = findState(objectType, objectId);
  const stamp = now();
  if (existing) {
    await tb.update(existing.id, Object.assign({ updated_at: stamp }, patch || {}));
    return findState(objectType, objectId);
  }
  const rec = Object.assign({
    object_type: objectType,
    object_id: String(objectId),
    local_table: '', local_id: null,
    external_id: String(objectId),
    sync_status: 'PENDING',
    last_sync_at: '',
    last_direction: '',
    last_event_id: '',
    idempotency_key: '',
    created_at: stamp, updated_at: stamp
  }, patch || {});
  await tb.insert(rec);
  return findState(objectType, objectId);
}

function markStateSynced(objectType, objectId, patch) {
  return upsertState(objectType, objectId, Object.assign({
    sync_status: 'SYNCED',
    last_sync_at: now()
  }, patch || {}));
}

function markStatePending(objectType, objectId, patch) {
  return upsertState(objectType, objectId, Object.assign({ sync_status: 'PENDING' }, patch || {}));
}

function markStateConflict(objectType, objectId, patch) {
  return upsertState(objectType, objectId, Object.assign({ sync_status: 'CONFLICT' }, patch || {}));
}

/** 该对象是否有尚未同步出去的本地变更（§6.5 DELETE 保护判定）。 */
function hasPendingLocalChange(objectType, objectId) {
  const st = findState(objectType, objectId);
  if (st && st.sync_status === 'PENDING') return true;
  const ob = t('outbox');
  return ob.all().some(r =>
    r.object_type === objectType && String(r.object_id) === String(objectId) &&
    (r.status === 'pending' || r.status === 'failed'));
}

async function removeState(objectType, objectId) {
  const tb = t('state');
  const st = findState(objectType, objectId);
  if (st) await tb.delete(st.id);
  return !!st;
}

// ============================ 冲突留痕（对齐 CRM sync_conflict）============================
function recordConflict(a) {
  return insert('conflict', {
    object_type: a.object_type,
    object_id: String(a.object_id),
    field: a.field || '',
    source_system: a.source_system || 'M05',
    incoming_value: stringifySafe(a.incoming_value),
    local_value: stringifySafe(a.local_value),
    resolution: a.resolution,
    event_id: a.event_id || '',
    idempotency_key: a.idempotency_key || '',
    remark: a.remark || '',
    occurred_at: a.occurred_at || '',
    created_at: now()
  });
}

function stringifySafe(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

// ============================ 入站日志（幂等判重 + AC-S8）============================
function findInboundByIdempotency(idempotencyKey) {
  if (!idempotencyKey) return null;
  const tb = t('inbound');
  return tb.all().slice().reverse()
    .find(r => r.idempotency_key === idempotencyKey && (r.status === 'applied' || r.status === 'skipped')) || null;
}

function logInbound(a) {
  return insert('inbound', {
    direction: 'IN',
    contract_version: a.contract_version || '',
    kind: a.kind || 'event',
    event_id: a.event_id || '',
    event_type: a.event_type || '',
    object_type: a.object_type || '',
    object_id: a.object_id !== undefined && a.object_id !== null ? String(a.object_id) : '',
    operation: a.operation || '',
    idempotency_key: a.idempotency_key || '',
    source_system: a.source_system || '',
    status: a.status,                 // applied | skipped | conflict | failed
    resolution: a.resolution || '',
    applied_fields: a.applied_fields ? JSON.stringify(a.applied_fields) : '',
    conflict_count: a.conflict_count || 0,
    retry_count: a.retry_count || 0,
    last_error: a.last_error || '',
    request_payload: a.request_payload || '',   // 原始报文，可反查（AC-S8）
    trace_id: a.trace_id || '',
    occurred_at: a.occurred_at || '',
    started_at: a.started_at || now(),
    finished_at: now(),
    created_at: now()
  });
}

module.exports = {
  TABLES, CFG_KEY, DEFAULT_CONFIG,
  init, t, all, insert, update, del,
  getConfig, getConfigRaw, setConfig, transportStatus,
  findState, upsertState, markStateSynced, markStatePending, markStateConflict,
  hasPendingLocalChange, removeState,
  recordConflict, stringifySafe,
  findInboundByIdempotency, logInbound
};
