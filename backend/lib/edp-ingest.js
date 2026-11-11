/**
 * EBMS → EDP 数据入库（E 通道：源记录推送，ingest:write）。
 *
 * 契约依据：edp-data-ingest SKILL（POST /api/v1/ingest/records → 202 + 批次轮询）。
 * 环境变量：
 *   EDP_BASE_URL    EDP 根地址（如 http://150.158.13.110:9090）
 *   EDP_PUSH_KEY    E 通道 SERVICE Key（scope ingest:write，绑定源系统）
 *
 * 红线：Key 明文只走环境变量；occurred_at 重试原样保留；不硬编码租户/源系统。
 */
const crypto = require('crypto');

function baseUrl() { return (process.env.EDP_BASE_URL || '').replace(/\/$/, ''); }
function pushKey() { return process.env.EDP_PUSH_KEY || ''; }

function configured() { return !!baseUrl() && !!pushKey(); }

async function httpFetch(method, path, body, headers) {
  const h = Object.assign({ 'X-API-Key': pushKey(), 'Content-Type': 'application/json' }, headers || {});
  const opts = { method, headers: h, timeout: 30000 };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(baseUrl() + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, body: json, text, headers: res.headers };
}

function healthz() {
  return httpFetch('GET', '/api/v1/health');
}

/**
 * 推送源记录（E 通道）。返回 202 的响应体 {batch_id, replayed, received, accepted, duplicated, rejected, errors[]}。
 * 429 按 Retry-After 退避并复用同一 Idempotency-Key（最多 5 次）。
 */
async function pushRecords(records, opts) {
  const o = opts || {};
  const idemKey = o.idemKey || ('ebms-' + crypto.randomBytes(8).toString('hex'));
  const maxAttempts = o.maxAttempts || 5;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const r = await httpFetch('POST', '/api/v1/ingest/records', { records }, { 'Idempotency-Key': idemKey });
    if (r.status === 429) {
      const retryAfter = parseInt((r.headers && r.headers['retry-after']) || '30', 10);
      await new Promise((res) => setTimeout(res, retryAfter * 1000 * (attempt + 1)));
      continue;
    }
    if (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 404) {
      const err = new Error('EDP ingest 请求被拒 ' + r.status + ': ' + JSON.stringify(r.body));
      err.status = r.status;
      err.body = r.body;
      throw err;
    }
    if (r.status !== 202) {
      const err = new Error('EDP ingest 非预期状态 ' + r.status + ': ' + r.text);
      err.status = r.status;
      throw err;
    }
    return r.body; // { batch_id, replayed, received, accepted, duplicated, rejected, errors[] }
  }
  throw new Error('持续 429：降速拆批后重试');
}

/**
 * 轮询批次状态直至终态 DONE / PARTIAL / FAILED。
 */
async function waitBatch(batchId, opts) {
  const o = opts || {};
  const timeoutS = o.timeoutS || 300;
  const intervalS = o.intervalS || 3;
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    const r = await httpFetch('GET', '/api/v1/ingest/batches/' + encodeURIComponent(batchId));
    if (r.status === 200 && r.body && ['DONE', 'PARTIAL', 'FAILED'].includes(r.body.status)) {
      return r.body;
    }
    await new Promise((res) => setTimeout(res, intervalS * 1000));
  }
  throw new Error('批次轮询超时：' + batchId);
}

// ===== 数据映射：EBMS 月度报告/管理对象 → EDP 源记录 =====

function toRecord(objectType, sourceId, occurredAt, payload) {
  return { object_type: objectType, source_id: sourceId, occurred_at: occurredAt || new Date().toISOString(), payload: payload || {} };
}

function buildIndicatorRecords(indicators, period) {
  return (indicators || []).map((i) => toRecord(
    'Indicator',
    'ind-' + (i.id || i.name),
    i.updated_at || undefined,
    { period, name: i.name, department: i.department, category: i.category, target: i.target, actual: i.actual, unit: i.unit, status: i.status, note: i.note }
  ));
}

function buildExceptionRecords(exceptions, period) {
  return (exceptions || []).map((x) => toRecord(
    'Exception',
    'exc-' + (x.id || x.title),
    x.updated_at || undefined,
    { period, level: x.level, title: x.title, owner: x.owner, deadline: x.deadline, problem: x.problem, actions: x.actions }
  ));
}

function buildDecisionRecords(decisions, period) {
  return (decisions || []).map((d) => toRecord(
    'Decision',
    'dec-' + (d.id || d.seq),
    d.updated_at || undefined,
    { period, seq: d.seq, level: d.level, title: d.title, owner: d.owner, deadline: d.deadline, problem: d.problem, action: d.action }
  ));
}

function buildTodoRecords(todos) {
  return (todos || []).map((t) => toRecord(
    'Action',
    'act-' + (t.work_item_id || t.source_object_type + '-' + t.id),
    undefined,
    { work_item_id: t.work_item_id, source_object_type: t.source_object_type, title: t.title, owner: t.owner, status: t.status, due_date: t.due_date }
  ));
}

module.exports = {
  baseUrl,
  pushKey,
  configured,
  healthz,
  pushRecords,
  waitBatch,
  toRecord,
  buildIndicatorRecords,
  buildExceptionRecords,
  buildDecisionRecords,
  buildTodoRecords
};
