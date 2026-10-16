/**
 * AEOS 通道的 HTTP 处理核心（与 Express 解耦，便于自检脚本直接调用）。
 *
 * 契约约定（架构方案 §5.1/§5.2 通道冻结）：
 *   入站  POST /api/aeos/ingest      Authorization: Bearer {EBMS_INGEST_TOKEN}
 *                                    X-Idempotency-Key / X-Contract-Version / X-Event-Type
 *   返回  200 {"result":"applied"|"skipped"} · 401 凭据 · 422 契约校验失败 · 400 无法判定契约
 *
 * 管理面（供运维与 EBMS 前端调用，权限码沿用 system:config）：
 *   status / config / outbox / flush / retry / export / reconcile / logs
 */
const crypto = require('crypto');
const secrets = require('./secrets');
const store = require('./aeos-store');
const ingest = require('./aeos-ingest');
const outbox = require('./aeos-outbox');
const C = require('./aeos-contract');

function lower(h) {
  const out = {};
  Object.keys(h || {}).forEach(k => { out[String(k).toLowerCase()] = h[k]; });
  return out;
}

/** 定长比较，避免时序侧信道（对齐 routes/external-service.js 的做法）。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (e) { return false; }
}

function invalid(errors, kind) {
  return { status: 422, body: { result: 'invalid', kind: kind || 'event', errors } };
}

// ============================ 入站 ============================
/**
 * @param {{headers?:object, body?:any}} req body 可为已解析对象或原始字符串
 * @returns {Promise<{status:number, body:object}>}
 */
async function handleIngest(req) {
  const headers = lower(req && req.headers);
  const configured = secrets.aeosIngestToken();
  if (!configured) {
    // 未配置凭据时不放行：宁可不可用，也不能无鉴权写入业务库
    return { status: 503, body: { error: 'AEOS 入站未启用：未配置 EBMS_INGEST_TOKEN' } };
  }
  const m = /^Bearer\s+(.+)$/i.exec(String(headers['authorization'] || ''));
  if (!m) return { status: 401, body: { error: '缺少 Authorization: Bearer <token>' } };
  if (!safeEqual(m[1].trim(), configured)) return { status: 401, body: { error: '凭据无效' } };

  let body = req && req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch (e) { return { status: 400, body: { error: '报文不是合法 JSON: ' + e.message } }; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { error: '报文必须是 JSON 对象' } };
  }

  // 头/体一致性（§5.1 头字段为契约事实，二者不一致即拒收，避免「头说 A 体说 B」）。
  // 头值按 RFC 3986 百分号编码承载（非 ASCII 业务键无法原样放进 HTTP 头，见 aeos-outbox 说明）：
  // 解码后再比对，兼容编码态与纯 ASCII 原样两种形态。
  for (const [hname, field] of [['x-contract-version', 'contract_version'], ['x-event-type', 'event_type'], ['x-idempotency-key', 'idempotency_key']]) {
    const hv = headers[hname];
    if (hv !== undefined && String(hv) !== '' && decodeHeader(hv) !== String(body[field] === undefined ? '' : body[field])) {
      return invalid([{ field, message: hname + ' 与报文不一致：头 ' + hv + '，体 ' + body[field] }]);
    }
  }

  const v = C.validateAny(body);
  if (!v.ok) return { status: v.status, body: { result: 'invalid', kind: v.kind, errors: v.errors, warnings: v.warnings || [] } };

  try {
    return await ingest.applyEnvelope(body);
  } catch (e) {
    return { status: 500, body: { result: 'error', error: e.message } };
  }
}

/** 头值归一：百分号编码态解码回原值；纯 ASCII 原样返回。 */
function decodeHeader(v) {
  const s = String(v === undefined || v === null ? '' : v);
  if (!s.includes('%')) return s;
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

// ============================ 管理面 ============================
function handleStatus() {
  store.init();
  const cfg = store.getConfig();
  const st = store.transportStatus();
  const counts = outbox.byStatusCounts();
  return {
    status: 200,
    body: {
      contract_version: C.CONTRACT_VERSION,
      transport: st,
      config: {
        enabled: cfg.enabled, mode: cfg.mode, url: cfg.url, batchSize: cfg.batchSize, owner: cfg.owner
      },
      missing_env: secrets.missingAeos(cfg.mode),
      outbox: counts,
      ingest_registered: !!secrets.aeosIngestToken(),
      server_time: require('../db').now()
    }
  };
}

function handleConfigGet() {
  store.init();
  return { status: 200, body: store.getConfig() };
}

async function handleConfigPut(body) {
  store.init();
  if (!body || typeof body !== 'object') return { status: 400, body: { error: '参数必须是对象' } };
  const next = await store.setConfig(body);
  return { status: 200, body: { ok: true, config: next, transport: store.transportStatus() } };
}

function handleList(query) {
  store.init();
  const q = query || {};
  return { status: 200, body: outbox.list(q) };
}

async function handleFlush(body) {
  store.init();
  const b = body || {};
  const r = await outbox.flush({ limit: b.limit, force: !!b.force });
  return { status: 200, body: r };
}

async function handleRetry(id) {
  store.init();
  const r = await outbox.retryOne(id);
  return { status: r.ok ? 200 : (r.noRetryNeeded ? 200 : 409), body: r };
}

async function handleDismiss(id) {
  store.init();
  const ok = await outbox.dismiss(id);
  return { status: ok ? 200 : 404, body: { ok } };
}

async function handleExport(body) {
  store.init();
  const b = body || {};
  const r = await outbox.exportAll({
    deliver: !!b.deliver,
    objects: Array.isArray(b.objects) ? b.objects : null,
    limit: b.limit
  });
  return { status: 200, body: r };
}

function handleReconcile(query) {
  store.init();
  const q = query || {};
  let remote = null;
  if (q.remote) {
    try { remote = typeof q.remote === 'string' ? JSON.parse(q.remote) : q.remote; } catch (e) { remote = null; }
  }
  return { status: 200, body: outbox.reconcile({ remote }) };
}

function handleLogs(query) {
  store.init();
  const q = query || {};
  let rows = store.all('inbound').slice().sort((a, b) => (b.id || 0) - (a.id || 0));
  if (q.status) rows = rows.filter(r => r.status === q.status);
  if (q.object_type) rows = rows.filter(r => r.object_type === q.object_type);
  if (q.kind) rows = rows.filter(r => r.kind === q.kind);
  const total = rows.length;
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const pageSize = Math.max(1, Math.min(500, parseInt(q.pageSize, 10) || 50));
  return {
    status: 200,
    body: { total, page, pageSize, rows: rows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize) }
  };
}

function handleConflicts(query) {
  store.init();
  const q = query || {};
  let rows = store.all('conflict').slice().sort((a, b) => (b.id || 0) - (a.id || 0));
  if (q.object_type) rows = rows.filter(r => r.object_type === q.object_type);
  if (q.resolution) rows = rows.filter(r => r.resolution === q.resolution);
  const total = rows.length;
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const pageSize = Math.max(1, Math.min(500, parseInt(q.pageSize, 10) || 50));
  return {
    status: 200,
    body: { total, page, pageSize, rows: rows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize) }
  };
}

/** 单条入站原始报文反查（AC-S8）。 */
function handleInboundDetail(id) {
  store.init();
  const row = store.t('inbound').findById(id);
  if (!row) return { status: 404, body: { error: '记录不存在' } };
  let payload = null;
  try { payload = JSON.parse(row.request_payload); } catch (e) {}
  return { status: 200, body: { record: row, payload } };
}

module.exports = {
  lower, safeEqual, decodeHeader,
  handleIngest, handleStatus, handleConfigGet, handleConfigPut,
  handleList, handleFlush, handleRetry, handleDismiss, handleExport,
  handleReconcile, handleLogs, handleConflicts, handleInboundDetail
};
