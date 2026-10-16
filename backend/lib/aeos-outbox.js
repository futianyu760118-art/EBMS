/**
 * AEOS 出站通道（EBMS→CRM）—— Outbox 模式，对齐 lib/material-outbox.js 的成熟做法。
 *
 * 职责（架构方案 §4.1 / §5.1 / §5.3 / §8-2）：
 *   1. 本地销售 6 模块 CRUD 变更 → 按契约剪裁 payload → 写 aeos_outbox 队列；
 *   2. flush 投递到 CRM 入站端点（POST /api/v1/integrations/ebms/ingest），
 *      带 Authorization: Bearer {EBMS_INBOUND_TOKEN} 与 X-Idempotency-Key / X-Contract-Version / X-Event-Type；
 *   3. 指数退避重试 min(2^n × 30, 3600) 秒、max_retry=5、确定性错误直接死信（AC-S4）；
 *   4. 对账（AC-S5）；
 *   5. 迁移一次性批量导出（§7，依赖序）。
 *
 * 红线：只走契约通道，绝不直写 CRM 库；不改 EBMS 业务规则。本模块的所有写操作
 * 都只作用于 aeos_* sidecar 表，业务表的写入由各路由自己完成。
 *
 * 回环防护：只有「本地 CRUD 路由」与「迁移导出」调用 enqueue*；外部同步落库
 * （aeos-ingest / external-sync / external-api）一律不入队（同 material-outbox.js:3 原则）。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const logger = require('./logger');
const db = require('../db');
const { now } = db;
const store = require('./aeos-store');
const secrets = require('./secrets');
const C = require('./aeos-contract');

const TARGET = C.TARGET_SYSTEM.outbound;   // 'M05' —— 事件目的地（CRM）

// 入队「读-判-写」临界段的独立锁名：表名同名会导致内层 insert 等外层释放而死锁。
const ENQUEUE_LOCK = 'aeos:outbox-enqueue';
const MAX_RETRY = 5;
const BASE_BACKOFF_SEC = 30;
const MAX_BACKOFF_SEC = 3600;

const OUTBOX_STATUS = {
  PENDING: 'pending',
  SUCCESS: 'success',
  FAILED: 'failed',
  DEAD_LETTER: 'dead_letter'
};

/** 退避秒数 = min(2^n × 30, 3600)，n 为已失败次数（AC-S4）。 */
function backoffSeconds(attempts) {
  const n = Math.max(0, Number(attempts) || 0);
  return Math.min(Math.pow(2, n) * BASE_BACKOFF_SEC, MAX_BACKOFF_SEC);
}

function backoffDeadline(attempts) {
  const d = new Date(Date.now() + backoffSeconds(attempts) * 1000 + 8 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

// ============================ 入队 ============================
function outboxTable() { return store.t('outbox'); }

function outboxAll() {
  const tb = outboxTable();
  return tb.all();
}

/**
 * 入队一条完整信封。
 *
 * 临界段（判重 → 合并 → 插入 → 同步态）整段在 ENQUEUE_LOCK 内串行：
 * 表写本身是异步的，若不锁，两次并发入队会各自读到「尚无重复」而写入两条同一幂等键。
 *
 * @returns {Promise<{queued:boolean, reason?:string, id?:number, event?:object}>}
 */
function enqueueEvent(event) {
  return db.withTableLock(ENQUEUE_LOCK, () => enqueueEventLocked(event));
}

async function enqueueEventLocked(event) {
  try {
    const objectType = event.object_type;
    const objectId = String(event.object_id);
    const operation = event.operation;
    const tb = outboxTable();
    const rows = outboxAll();

    // 1) 同内容重复：指纹幂等吸收（AC-S3 / §5.3「同内容重复保存被指纹幂等吸收」）
    if (rows.some(r => r.idempotency_key === event.idempotency_key &&
      (r.status === OUTBOX_STATUS.PENDING || r.status === OUTBOX_STATUS.SUCCESS))) {
      return { queued: false, reason: 'duplicate' };
    }

    // 2) 合并：同一对象已有未投递的出站记录
    const openRows = rows.filter(r =>
      r.object_type === objectType && String(r.object_id) === objectId &&
      (r.status === OUTBOX_STATUS.PENDING || r.status === OUTBOX_STATUS.FAILED));
    if (openRows.length) {
      if (operation === 'DELETE') {
        // 删除：丢弃该对象尚未发出的增/改记录，只留一条 deleted
        for (const r of openRows) await tb.delete(r.id);
      } else {
        const keep = openRows[0];
        // 增/改：以最新内容覆盖（后写胜出），保留首次入队时间
        await tb.update(keep.id, {
          event_id: event.event_id,
          event_type: event.event_type,
          operation: operation,
          payload: JSON.stringify(event),
          idempotency_key: event.idempotency_key,
          occurred_at: event.occurred_at,
          trace_id: event.trace_id,
          status: OUTBOX_STATUS.PENDING,
          attempts: 0,
          next_retry_at: '',
          last_error: '',
          updated_at: now()
        });
        for (const r of openRows.slice(1)) await tb.delete(r.id);
        await store.markStatePending(objectType, objectId, {
          last_event_id: event.event_id, idempotency_key: event.idempotency_key
        });
        return { queued: true, merged: true, id: keep.id, event };
      }
    }

    const rec = {
      direction: 'OUT',
      target_system: TARGET,
      object_type: objectType,
      object_id: objectId,
      event_id: event.event_id,
      event_type: event.event_type,
      operation,
      idempotency_key: event.idempotency_key,
      contract_version: event.contract_version,
      source_system: event.source_system,
      trace_id: event.trace_id,
      occurred_at: event.occurred_at,
      payload: JSON.stringify(event),
      status: OUTBOX_STATUS.PENDING,
      attempts: 0,
      max_retry: MAX_RETRY,
      next_retry_at: '',
      last_error: '',
      sent_at: '',
      first_attempt_at: '',
      finished_at: '',
      created_at: now(),
      updated_at: now()
    };
    const r = await tb.insert(rec);
    await store.markStatePending(objectType, objectId, {
      last_event_id: event.event_id, idempotency_key: event.idempotency_key
    });
    return { queued: true, id: r.lastID, event };
  } catch (e) {
    logger.error('[aeos-outbox] 入队失败:', e.message);
    return { queued: false, reason: 'error: ' + e.message };
  }
}

/**
 * 由 EBMS 业务记录构造并入队一条实体事件。
 * @param {string} objectType Customer|Inquiry|QuoteLibrary|Order|Sample|Feedback|Dictionary
 * @param {object} record     EBMS 记录（或 Inquiry 用行数组，见下）
 * @param {object} [opts]     {operation:'UPSERT'|'DELETE', occurredAt, payloadOverride}
 */
async function enqueueEntity(objectType, record, opts) {
  const o = opts || {};
  const operation = (o.operation || 'UPSERT').toUpperCase();
  try {
    let objectId, payload, occurredAt, warnings = [];
    if (o.payloadOverride) {
      payload = o.payloadOverride.payload !== undefined ? o.payloadOverride.payload : o.payloadOverride;
      warnings = o.payloadOverride.warnings || [];
      objectId = o.objectId || C.objectIdOf(objectType, payload);
      occurredAt = o.occurredAt || payload.updated_at || payload.created_at;
    } else if (objectType === 'Inquiry' && Array.isArray(record)) {
      const built = buildInquiryPayload(record);
      objectId = built.objectId;
      payload = built.payload;
      warnings = built.warnings;
      occurredAt = o.occurredAt || payload.updated_at;
    } else {
      objectId = o.objectId || C.objectIdOf(objectType, record);
      const built = C.buildPayload(objectType, record, { objectId });
      payload = built.payload;
      warnings = built.warnings;
      Object.assign(payload, buildEmbedded(objectType, record));
      // Feedback 无稳定业务键：payload 必须带上两侧约定的 feedback_no（§2）
      if (objectType === 'Feedback') payload.feedback_no = objectId;
      occurredAt = o.occurredAt || record.updated_at || record.created_at;
    }

    // DELETE 只携带业务键分量：报文最小、且指纹与「删除时刻的残余内容」无关，
    // 保证同一对象反复删除/重试得到同一幂等键（接收侧 §6.5 只需键即可定位）。
    const deletePayload = Object.assign({}, C.decodeObjectId(objectType, objectId));
    if (objectType === 'Feedback') deletePayload.feedback_no = objectId;
    const event = C.buildEvent({
      sourceSystem: 'EBMS',
      objectType,
      objectId,
      operation,
      payload: operation === 'DELETE' ? deletePayload : payload,
      occurredAt,
      targetSystem: TARGET
    });
    // DELETE 事件的幂等/指纹只依赖键，不依赖对象当前内容
    const res = await enqueueEvent(event);
    return Object.assign({ warnings }, res);
  } catch (e) {
    logger.error('[aeos-outbox] enqueueEntity(' + objectType + ') 构造失败:', e.message);
    return { queued: false, reason: 'construct error: ' + e.message, warnings: [] };
  }
}

/**
 * 内嵌组构造（§4.1）：反馈跟进以 payload.followups[] 全量快照随主事件出站，
 * 不做独立事件；侧不存在内嵌组时返回 {}。
 */
function buildEmbedded(objectType, record) {
  const spec = C.OBJECT_SPECS[objectType];
  const out = {};
  if (!spec || !record || !record.id) return out;
  (spec.embedded || []).forEach(g => {
    if (!g.table || !g.parentField) return;
    let rows = [];
    try { rows = db.getTable(g.table).all(); } catch (e) { return; }
    const mine = rows.filter(r => Number(r[g.parentField]) === Number(record.id));
    out[g.key] = mine.map(r => {
      const item = {};
      g.fields.forEach(f => {
        let raw = r[f.name];
        if (f.meta) { item[f.name] = raw === undefined || raw === null ? '' : String(raw); return; }
        if (f.enum && f.wire === 'str') {
          const domain = C.ENUMS[f.enum] || [];
          if (raw && domain.length && !domain.includes(raw)) raw = '';
        }
        item[f.name] = C.toWireValue(f, raw);
      });
      return item;
    });
  });
  return out;
}

/**
 * 询价出站聚合（§4.3）：EBMS inquiries 一行一个产品行，
 * 按基号（去掉 -NN 后缀）聚合成一条 inquiry.upserted 事件，items[] 逐行。
 */
function buildInquiryPayload(rows) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  if (!list.length) throw new Error('询价聚合需要至少一行');
  const baseOf = (sn) => String(sn || '').replace(/-\d{2,}$/, '');
  const base = baseOf(list[0].serial_number);
  // 同一基号下的行按 serial_number 升序（首行无后缀）
  const sorted = list.slice().sort((a, b) => String(a.serial_number || '').localeCompare(String(b.serial_number || '')));
  const head = sorted[0];
  const warnings = [];
  const ctx = { objectType: 'Inquiry', objectId: base };
  const payload = {
    serial_number: base,
    items: []
  };
  const spec = C.OBJECT_SPECS.Inquiry;
  const itemFieldNames = spec.itemFields.map(f => f.name);
  // header：以首行取值（EBMS 现状同一基号的 header 一致）
  for (const f of spec.fields) {
    const name = f.name;
    if (name === 'serial_number') continue;
    if (itemFieldNames.includes(name)) continue;      // item 级字段不进 header
    if (f.wire === 'bool') { payload[name] = C.toWireValue(f, head[name]); continue; }
    let raw = head[name];
    if (f.enum && f.wire === 'str') {
      const domain = C.ENUMS[f.enum] || [];
      if (raw && domain.length && !domain.includes(raw)) {
        warnings.push({ object_type: 'Inquiry', object_id: base, field: name, value: raw, reason: '取值不在冻结取值域 ' + f.enum + ' 内，已丢弃该字段值' });
        raw = '';
      }
    }
    payload[name] = C.toWireValue(f, raw === undefined || raw === null ? '' : raw);
  }
  // items：每行一个 item，仅契约声明字段
  for (const row of sorted) {
    const item = {};
    for (const f of spec.itemFields) {
      let raw = row[f.name];
      if (f.enum && f.wire === 'str') {
        const domain = C.ENUMS[f.enum] || [];
        if (raw && domain.length && !domain.includes(raw)) {
          warnings.push({ object_type: 'Inquiry', object_id: base, field: 'items.' + f.name, value: raw, reason: '取值不在冻结取值域 ' + f.enum + ' 内，已丢弃该字段值' });
          raw = '';
        }
      }
      item[f.name] = C.toWireValue(f, raw === undefined || raw === null ? '' : raw);
    }
    payload.items.push(item);
  }
  // 成本块（owner=EBMS，出站照传；入站不被 CRM 反向覆盖）
  for (const f of spec.fields) {
    if (f.owner !== 'EBMS') continue;
    payload[f.name] = C.toWireValue(f, head[f.name]);
  }
  const updated = sorted.reduce((m, r) => (String(r.updated_at || '') > m ? String(r.updated_at || '') : m), '');
  payload.updated_at = updated || '';
  payload.created_at = String(head.created_at || '');
  return { objectId: base, payload, warnings, objectType: 'Inquiry' };
}

// ============================ 投递 ============================
function classifyHttpStatus(status) {
  // 确定性错误：契约/参数/权限类 4xx —— 重试无意义，直接死信（AC-S4）
  if (status >= 200 && status < 300) return 'success';
  if ([400, 401, 403, 404, 405, 409, 410, 422].includes(status)) return 'deterministic';
  return 'retryable';   // 408/429/5xx 及未知状态
}

/**
 * 头字段值的传输编码。
 *
 * 契约 §4/§5.1 冻结的 idempotency_key 内嵌 object_id，而 object_id 可能是中文业务键
 * （Customer=customers.name、Inquiry=serial_number 等）。HTTP 头只能承载 ASCII
 * （Node 客户端遇 >0xFF 字符直接抛 ERR_INVALID_CHAR），因此头部一律按 RFC 3986
 * 百分号编码后传输；**键本身的取值不变**，仅传输表示变化，接收侧解码后比对。
 * 纯 ASCII 键编码后与原值相同，不影响既有同值比对。
 */
function encodeHeaderValue(v) {
  return encodeURIComponent(String(v === undefined || v === null ? '' : v));
}

/** 接收侧归一：兼容百分号编码与（理论上不可达的）原样取值两种形态。 */
function decodeHeaderValue(v) {
  const s = String(v === undefined || v === null ? '' : v);
  if (!s.includes('%')) return s;
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

function _postJson(urlStr, token, event) {
  return new Promise((resolve) => {
    let urlObj;
    try { urlObj = new URL(urlStr); } catch (e) {
      return resolve({ ok: false, kind: 'deterministic', error: '无效的入站地址: ' + urlStr });
    }
    const body = JSON.stringify(event);
    const data = Buffer.from(body, 'utf8');
    const isHttps = urlObj.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request({
      method: 'POST',
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + (urlObj.search || ''),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        Authorization: 'Bearer ' + token,
        'X-Idempotency-Key': encodeHeaderValue(event.idempotency_key),
        'X-Contract-Version': encodeHeaderValue(event.contract_version),
        'X-Event-Type': encodeHeaderValue(event.event_type)
      },
      agent: isHttps ? new https.Agent({ rejectUnauthorized: false }) : undefined,
      timeout: 30000
    }, (res) => {
      let chunk = '';
      res.on('data', c => chunk += c);
      res.on('end', () => {
        const kind = classifyHttpStatus(res.statusCode);
        let parsed = null;
        try { parsed = JSON.parse(chunk); } catch (e) {}
        const skipped = !!(parsed && (parsed.result === 'skipped' || parsed.skipped === true));
        if (kind === 'success') {
          resolve({ ok: true, status: res.statusCode, skipped, body: chunk.substring(0, 500) });
        } else {
          resolve({
            ok: false, kind, status: res.statusCode,
            error: 'HTTP ' + res.statusCode + ': ' + (chunk || '').substring(0, 300)
          });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, kind: 'retryable', error: '网络错误: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, kind: 'retryable', error: '请求超时' }); });
    req.write(data);
    req.end();
  });
}

function _spoolWrite(dir, event) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, event.event_id.replace(/[^\w.\-]/g, '_') + '.json');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(event, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, status: 200, spooled: file };
  } catch (e) {
    return { ok: false, kind: 'retryable', error: 'spool 落盘失败: ' + e.message };
  }
}

/** 单条投递（不含状态流转）。 */
async function sendOne(row) {
  const cfg = store.getConfig();
  const st = store.transportStatus();
  if (!st.ready) return { ok: false, kind: 'unconfigured', error: st.reason };
  let event;
  try { event = JSON.parse(row.payload); } catch (e) {
    return { ok: false, kind: 'deterministic', error: '出站报文损坏: ' + e.message };
  }
  if (cfg.mode === 'dry_run') return { ok: true, status: 0, dryRun: true };
  if (cfg.mode === 'spool') return _spoolWrite(cfg.spoolDir, event);
  return _postJson(cfg.url, secrets.aeosOutboundToken(), event);
}

function markRow(id, patch) {
  return outboxTable().update(Number(id), Object.assign({ updated_at: now() }, patch));
}

/**
 * 投递所有到期 pending（含 failed 且已过退避时间的）。
 * 未配置投递时直接返回，不消耗尝试次数（断网/未部署 CRM 时只是队列等待，AC-S10）。
 */
async function flush(opts) {
  const o = opts || {};
  const cfg = store.getConfig();
  const st = store.transportStatus();
  if (!st.ready) {
    return {
      sent: 0, failed: 0, deadLetter: 0, skipped: 0, attempted: 0,
      configured: false, reason: st.reason, errors: []
    };
  }
  const limit = Math.max(1, parseInt(o.limit, 10) || cfg.batchSize || 200);
  const nowMs = Date.now();
  const due = outboxAll()
    .filter(r => r.status === OUTBOX_STATUS.PENDING || r.status === OUTBOX_STATUS.FAILED)
    .filter(r => {
      if (o.force) return true;
      if (r.status !== OUTBOX_STATUS.FAILED) return true;
      if (!r.next_retry_at) return true;
      return C.parseTime(r.next_retry_at) <= nowMs;
    })
    .sort((a, b) => (a.id || 0) - (b.id || 0))
    .slice(0, limit);

  let sent = 0, failed = 0, deadLetter = 0, skipped = 0;
  const errors = [];
  for (const row of due) {
    const r = await sendOne(row);
    if (r.ok) {
      await markRow(row.id, {
        status: OUTBOX_STATUS.SUCCESS,
        attempts: Number(row.attempts || 0) + 1,
        sent_at: now(),
        first_attempt_at: row.first_attempt_at || now(),
        finished_at: now(),
        last_error: r.skipped ? '接收侧返回 skipped（幂等吸收，未产生新业务记录）' : '',
        next_retry_at: ''
      });
      if (r.skipped) skipped++;
      sent++;
      await store.markStateSynced(row.object_type, row.object_id, {
        local_table: C.OBJECT_SPECS[row.object_type] ? (C.OBJECT_SPECS[row.object_type].table || '') : '',
        last_direction: 'OUT',
        last_event_id: row.event_id,
        idempotency_key: row.idempotency_key
      });
    } else if (r.kind === 'unconfigured') {
      // 期间配置被清空：本轮放弃，不消耗尝试
      errors.push({ id: row.id, object_id: row.object_id, error: r.error });
      break;
    } else if (r.kind === 'deterministic') {
      await markRow(row.id, {
        status: OUTBOX_STATUS.DEAD_LETTER,
        attempts: Number(row.attempts || 0) + 1,
        first_attempt_at: row.first_attempt_at || now(),
        finished_at: now(),
        last_error: r.error,
        next_retry_at: ''
      });
      deadLetter++;
      errors.push({ id: row.id, object_id: row.object_id, dead_letter: true, error: r.error });
    } else {
      const attempts = Number(row.attempts || 0) + 1;
      const dead = attempts >= (Number(row.max_retry) || MAX_RETRY);
      await markRow(row.id, {
        status: dead ? OUTBOX_STATUS.DEAD_LETTER : OUTBOX_STATUS.FAILED,
        attempts,
        first_attempt_at: row.first_attempt_at || now(),
        finished_at: dead ? now() : '',
        last_error: r.error,
        next_retry_at: dead ? '' : backoffDeadline(attempts)
      });
      if (dead) deadLetter++; else failed++;
      errors.push({ id: row.id, object_id: row.object_id, dead_letter: dead, error: r.error });
    }
  }
  return { sent, failed, deadLetter, skipped, attempted: due.length, configured: true, errors };
}

/** 手动单条重试。已 SUCCESS 的记录直接返回「无需重试」（AC-S4）。 */
async function retryOne(id) {
  const tb = outboxTable();
  const row = tb.all().find(r => Number(r.id) === Number(id));
  if (!row) return { ok: false, error: '记录不存在' };
  if (row.status === OUTBOX_STATUS.SUCCESS) {
    return { ok: false, noRetryNeeded: true, message: '该记录已 SUCCESS，无需重试' };
  }
  const r = await sendOne(row);
  if (r.ok) {
    await markRow(id, {
      status: OUTBOX_STATUS.SUCCESS,
      attempts: Number(row.attempts || 0) + 1,
      sent_at: now(), first_attempt_at: row.first_attempt_at || now(), finished_at: now(),
      last_error: '', next_retry_at: ''
    });
    await store.markStateSynced(row.object_type, row.object_id, { last_direction: 'OUT' });
    return { ok: true, status: r.status, skipped: !!r.skipped };
  }
  if (r.kind === 'deterministic') {
    await markRow(id, {
      status: OUTBOX_STATUS.DEAD_LETTER,
      attempts: Number(row.attempts || 0) + 1,
      first_attempt_at: row.first_attempt_at || now(), finished_at: now(),
      last_error: r.error, next_retry_at: ''
    });
    return { ok: false, deadLetter: true, error: r.error };
  }
  const attempts = Number(row.attempts || 0) + 1;
  const dead = attempts >= (Number(row.max_retry) || MAX_RETRY);
  await markRow(id, {
    status: dead ? OUTBOX_STATUS.DEAD_LETTER : OUTBOX_STATUS.FAILED,
    attempts, first_attempt_at: row.first_attempt_at || now(), finished_at: dead ? now() : '',
    last_error: r.error, next_retry_at: dead ? '' : backoffDeadline(attempts)
  });
  return { ok: false, deadLetter: dead, error: r.error };
}

/** 人工重置死信为待投递（运维用；不改 attempts 以保留留痕，仅清空退避）。 */
async function requeue(id) {
  const tb = outboxTable();
  const row = tb.all().find(r => Number(r.id) === Number(id));
  if (!row) return { ok: false, error: '记录不存在' };
  await markRow(id, { status: OUTBOX_STATUS.PENDING, next_retry_at: '', attempts: 0, finished_at: '' });
  return { ok: true };
}

async function dismiss(id) {
  const tb = outboxTable();
  const row = tb.all().find(r => Number(r.id) === Number(id));
  if (!row) return false;
  await tb.delete(Number(id));
  return true;
}

function list(opts) {
  const o = opts || {};
  const tb = outboxTable();
  let rows = tb.all().slice().sort((a, b) => (b.id || 0) - (a.id || 0));
  if (o.status) rows = rows.filter(r => r.status === o.status);
  if (o.object_type) rows = rows.filter(r => r.object_type === o.object_type);
  if (o.event_type) rows = rows.filter(r => r.event_type === o.event_type);
  if (o.keyword) {
    const kw = String(o.keyword).toLowerCase();
    rows = rows.filter(r =>
      String(r.object_id || '').toLowerCase().includes(kw) ||
      String(r.idempotency_key || '').toLowerCase().includes(kw) ||
      String(r.event_id || '').toLowerCase().includes(kw));
  }
  const total = rows.length;
  const page = Math.max(1, parseInt(o.page, 10) || 1);
  const pageSize = Math.max(1, Math.min(500, parseInt(o.pageSize, 10) || 50));
  return { rows: rows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize), total, page, pageSize };
}

function byStatusCounts() {
  const rows = outboxAll();
  const c = { pending: 0, success: 0, failed: 0, dead_letter: 0, total: rows.length };
  rows.forEach(r => { if (c[r.status] !== undefined) c[r.status]++; });
  return c;
}

function pendingCount() {
  return outboxAll().filter(r => r.status === OUTBOX_STATUS.PENDING || r.status === OUTBOX_STATUS.FAILED).length;
}

// ============================ 对账（§6.6 / AC-S5）============================
/**
 * 对账输出：按 event_type 的 produced/delivered/pending/failed + 全局 dead_letter，
 * 以及入站侧 ingested/skipped/conflict。
 *
 * `consistent` 按 §6.6 判据 = 两侧 pending=0 且 failed=0。EBMS 侧可自行观测到的是
 * 本侧出站队列；对侧（CRM）数字由调用方通过 `opts.remote` 传入（CRM 对账接口回传），
 * 未传时只判本侧并在 `remote_provided=false` 标注，不臆造对侧数字。
 */
function reconcile(opts) {
  const o = opts || {};
  const rows = outboxAll();
  const byEventType = {};
  rows.forEach(r => {
    const k = r.event_type || '(unknown)';
    if (!byEventType[k]) {
      byEventType[k] = { event_type: k, produced: 0, delivered: 0, pending: 0, failed: 0, dead_letter: 0 };
    }
    const b = byEventType[k];
    b.produced++;
    if (r.status === OUTBOX_STATUS.SUCCESS) b.delivered++;
    else if (r.status === OUTBOX_STATUS.PENDING) b.pending++;
    else if (r.status === OUTBOX_STATUS.FAILED) b.failed++;
    else if (r.status === OUTBOX_STATUS.DEAD_LETTER) b.dead_letter++;
  });
  const eventTypes = Object.values(byEventType).sort((a, b) => a.event_type.localeCompare(b.event_type));
  const deadLetter = rows.filter(r => r.status === OUTBOX_STATUS.DEAD_LETTER).length;
  const pending = rows.filter(r => r.status === OUTBOX_STATUS.PENDING).length;
  const failed = rows.filter(r => r.status === OUTBOX_STATUS.FAILED).length;
  const delivered = rows.filter(r => r.status === OUTBOX_STATUS.SUCCESS).length;

  const inbound = inboundCounters();

  // 逐对象计数对账（§7.5：EBMS 源条数 = 落库条数 ±0 的可核验底座）
  const objectCounts = {};
  const inboundApplied = {};
  store.all('inbound').forEach(r => {
    if (r.status === 'applied' && r.object_type) {
      inboundApplied[r.object_type] = (inboundApplied[r.object_type] || 0) + 1;
    }
  });
  Object.keys(C.OBJECT_SPECS).forEach(ot => {
    const spec = C.OBJECT_SPECS[ot];
    if (!spec.table) { objectCounts[ot] = null; return; }
    objectCounts[ot] = store.all('state').filter(s => s.object_type === ot).length;
  });

  const remote = o.remote && typeof o.remote === 'object' ? o.remote : null;
  const remotePending = remote ? (Number(remote.pending) || 0) : null;
  const remoteFailed = remote ? (Number(remote.failed) || 0) : null;
  const localOk = pending === 0 && failed === 0;
  const remoteOk = remote ? (remotePending === 0 && remoteFailed === 0) : null;

  return {
    target_system: TARGET,
    transport: store.transportStatus(),
    outbound: {
      produced: rows.length, delivered, pending, failed,
      dead_letter: deadLetter,
      by_event_type: eventTypes
    },
    dead_letter: deadLetter,
    inbound,
    // Result/Exception 通道（既有基线）：EBMS 是消费方，只报本侧落库计数；
    // 该通道的 produced/delivered 在对侧（CRM），由 remote 数字合并判定。
    result_exception: {
      direction: 'IN',
      results: store.all('results').length,
      exceptions: store.all('exceptions').length
    },
    remote_provided: !!remote,
    remote: remote ? { pending: remotePending, failed: remoteFailed } : null,
    sides: {
      own: { pending, failed },
      remote: remote ? { pending: remotePending, failed: remoteFailed } : null
    },
    object_sync_state_counts: objectCounts,
    inbound_applied_counts: inboundApplied,
    // 两侧判据：本侧可观测；对侧数字缺省时不虚报一致
    consistent: remote ? (localOk && remoteOk) : localOk,
    local_consistent: localOk,
    checked_at: now()
  };
}

/** 入站计数（§6.6：入站侧另加 ingested/skipped/conflict）。入站为同步处理，无 pending/dead_letter。 */
function inboundCounters() {
  const rows = store.all('inbound');
  return {
    produced: rows.length,
    ingested: rows.filter(r => r.status === 'applied').length,
    skipped: rows.filter(r => r.status === 'skipped').length,
    conflict: rows.filter(r => r.status === 'conflict').length,
    failed: rows.filter(r => r.status === 'failed').length,
    pending: 0,
    dead_letter: 0
  };
}

// ============================ 迁移导出（§7，依赖序一次性导出）============================
/**
 * 依赖序：字典组 → customers → inquiries(+items) → quote_library → orders → samples → feedback(+followups)
 * 幂等：重复执行按 idempotency_key 由接收方 skipped（§7.4）。
 * @param {{deliver?:boolean, objects?:string[], limit?:number}} opts
 */
async function exportAll(opts) {
  const o = opts || {};
  store.init();
  const order = ['Dictionary', 'Customer', 'Inquiry', 'QuoteLibrary', 'Order', 'Sample', 'Feedback'];
  const wanted = o.objects && o.objects.length ? order.filter(x => o.objects.includes(x))
    : order.filter(x => x !== 'Dictionary');   // 字典组为 P1，默认不导
  const result = { batch_id: 'EXP-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'), started_at: now(), objects: {}, warnings: [], queued: 0, skipped: 0 };
  const limit = Math.max(1, parseInt(o.limit, 10) || 100000);

  for (const objectType of wanted) {
    const built = collectObjectEvents(objectType, limit);
    let queued = 0, dup = 0;
    for (const item of built.events) {
      const r = await enqueueEntity(objectType, item.record, {
        operation: 'UPSERT',
        objectId: item.objectId,
        occurredAt: item.occurredAt,
        payloadOverride: { payload: item.payload, warnings: item.warnings }
      });
      if (r.queued) queued++; else dup++;
      if (r.warnings && r.warnings.length) result.warnings.push(...r.warnings);
    }
    result.objects[objectType] = {
      table: C.OBJECT_SPECS[objectType].table,
      scanned: built.scanned,
      queued,
      skipped: dup,
      source_count: built.events.length
    };
    result.queued += queued;
    result.skipped += dup;
    if (built.warnings.length) result.warnings.push(...built.warnings);
  }

  await store.insert('exportLog', {
    batch_id: result.batch_id,
    direction: 'OUT',
    objects: JSON.stringify(result.objects),
    queued: result.queued,
    skipped: result.skipped,
    warning_count: result.warnings.length,
    deliver: o.deliver ? 1 : 0,
    created_at: now()
  });

  if (o.deliver) {
    result.flush = await flush({ force: true, limit: 100000 });
  }
  result.finished_at = now();
  return result;
}

/** 按对象收集导出事件（Inquiry 需按基号聚合）。 */
function collectObjectEvents(objectType, limit) {
  const spec = C.OBJECT_SPECS[objectType];
  const warnings = [];
  const events = [];
  if (objectType === 'Dictionary') {
    return { scanned: 0, events, warnings };
  }
  let rows = [];
  try { rows = db.getTable(spec.table).all().slice(); } catch (e) {
    return { scanned: 0, events, warnings: [{ object_type: objectType, field: '', reason: '读取表 ' + spec.table + ' 失败: ' + e.message }] };
  }
  const scanned = rows.length;
  rows = rows.slice(0, limit);

  if (objectType === 'Inquiry') {
    const groups = new Map();
    rows.forEach(r => {
      const base = String(r.serial_number || '').replace(/-\d{2,}$/, '');
      if (!base) { warnings.push({ object_type: objectType, object_id: '', field: 'serial_number', value: r.serial_number, reason: '业务键为空，无法编码 object_id，已跳过该行' }); return; }
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push(r);
    });
    groups.forEach((list, base) => {
      try {
        const built = buildInquiryPayload(list);
        events.push({ record: list, objectId: built.objectId, payload: built.payload, occurredAt: built.payload.updated_at, warnings: built.warnings });
      } catch (e) {
        warnings.push({ object_type: objectType, object_id: base, field: '', reason: e.message });
      }
    });
    return { scanned, events, warnings };
  }

  rows.forEach(rec => {
    try {
      const objectId = C.objectIdOf(objectType, rec);
      if (!objectId || objectId === '' || (!rec[spec.keyFields[0]] && objectType !== 'Feedback')) {
        warnings.push({ object_type: objectType, object_id: '', field: spec.keyFields[0], value: rec[spec.keyFields[0]], reason: '业务键为空，无法编码 object_id，已跳过该行' });
        return;
      }
      const built = C.buildPayload(objectType, rec, { objectId });
      const payload = Object.assign({}, built.payload);
      if (objectType === 'Feedback') payload.feedback_no = objectId;
      events.push({ record: rec, objectId, payload, occurredAt: payload.updated_at || payload.created_at, warnings: built.warnings });
    } catch (e) {
      warnings.push({ object_type: objectType, object_id: '', field: '', reason: e.message });
    }
  });
  return { scanned, events, warnings };
}

module.exports = {
  TARGET, MAX_RETRY, BASE_BACKOFF_SEC, MAX_BACKOFF_SEC, OUTBOX_STATUS,
  backoffSeconds, backoffDeadline, classifyHttpStatus,
  enqueueEntity, enqueueEvent, buildInquiryPayload, buildEmbedded,
  sendOne, flush, retryOne, requeue, dismiss, list, pendingCount, byStatusCounts,
  reconcile, exportAll, collectObjectEvents
};
