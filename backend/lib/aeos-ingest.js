/**
 * AEOS 入站落地（EBMS 侧）—— CRM→EBMS 方向的消费方实现，架构方案 §2 / §6 的代码化。
 *
 * 处理链（对每条已经通过契约校验的报文）：
 *   1. 幂等判重  —— idempotency_key 命中已处理记录 → 200 skipped，不产生新业务记录（AC-S3）
 *   2. 乱序/过期 —— occurred_at < last_sync_at → 整条 skipped，resolution=STALE（§6.4）
 *   3. 字段归属  —— 只应用 Owner=CRM 的字段；Owner=EBMS 的字段（成本块）不被覆盖，
 *                   值有差异时留痕 resolution=OWNER_KEPT（§6.1）
 *   4. 人工锁    —— 订单状态锁生效时跳过 status，留痕 resolution=LOCKED（§6.2）
 *   5. 同窗口双改—— 本地存在未同步变更时，Owner 侧（CRM）胜出，本地旧值丢弃并留痕 STALE（§6.3）
 *   6. DELETE    —— 本地有未同步变更 → 跳过删除并留痕 OWNER_KEPT；否则删除镜像行（§6.5）
 *
 * 红线：只做数据同步点，不重算任何专业中心算法；不直写 CRM 库；不写死任何密钥。
 * 本模块只用契约通道收到的报文驱动本地落库，绝不反向回改 CRM。
 */
const db = require('../db');
const { now } = db;
const store = require('./aeos-store');
const C = require('./aeos-contract');

/** §6.2 人工锁字段：由人在 CRM 侧对订单状态做的决定，事件不得改写。 */
const ORDER_LOCK_FIELDS = ['user_status_locked', 'user_status_modified_at', 'user_status_modified_by'];

const _fmaps = {};
function fieldMap(spec) {
  const key = spec.eventBase;
  if (_fmaps[key]) return _fmaps[key];
  const m = {};
  spec.fields.forEach(f => { m[f.name] = f; });
  (spec.itemFields || []).forEach(f => { m[f.name] = f; });
  _fmaps[key] = m;
  return m;
}

function truthy(v) { return v === true || v === 1 || v === '1' || v === 'true'; }

/** 线格式 → EBMS 本地值。数值/布尔类 null 视为「未提供」，保留本地值；
 *  文本类 null 视为「清空」，写入空串（CRM 是文本字段的 Owner）。 */
function wireToLocal(f, v) {
  if (v === undefined || v === null || v === '') {
    if (f.wire === 'str') return '';
    return undefined; // 不覆盖
  }
  switch (f.wire) {
    case 'str-dec':
    case 'int': {
      const n = C.fromWireValue(f, v);
      return n === null ? undefined : n;
    }
    case 'bool':
      return C.fromWireValue(f, v);
    default:
      return String(v);
  }
}

// ============================ 本地定位 ============================
function keyOf(objectType, objectId, payload) {
  const decoded = C.decodeObjectId(objectType, objectId);
  const p = payload || {};
  const out = {};
  Object.keys(decoded).forEach(k => {
    out[k] = (p[k] === undefined || p[k] === null) ? decoded[k] : p[k];
  });
  return out;
}

/** 按业务键定位 EBMS 本地行（Inquiry 命中基号全体行；Feedback 支持派生键兜底匹配）。 */
function locateRows(objectType, objectId, payload) {
  const spec = C.OBJECT_SPECS[objectType];
  const rows = db.getTable(spec.table).all().slice();
  const k = keyOf(objectType, objectId, payload);
  switch (objectType) {
    case 'Customer':
      return rows.filter(r => String(r.name || '') === String(k.name));
    case 'Inquiry': {
      const base = String(k.serial_number || '');
      return rows.filter(r => {
        const sn = String(r.serial_number || '');
        return sn === base || sn.startsWith(base + '-');
      });
    }
    case 'QuoteLibrary':
      return rows.filter(r => String(r.external_model || '') === String(k.external_model || '') &&
        String(r.certificate_level || '') === String(k.certificate_level || ''));
    case 'Order':
      return rows.filter(r => String(r.order_no || '') === String(k.order_no || '') &&
        String(r.line_no || '') === String(k.line_no || ''));
    case 'Sample':
      return rows.filter(r => String(r.sample_no || '') === String(k.sample_no || ''));
    case 'Feedback': {
      const no = String(k.feedback_no || '');
      const hit = rows.filter(r => String(r.feedback_no || '') === no);
      if (hit.length) return hit;
      // CRM 未回传 feedback_no 时按 §2 派生键兜底匹配，避免同一反馈被建成两条对象
      return rows.filter(r => C.feedbackDerivedKey(r) === String(objectId));
    }
    default:
      return [];
  }
}

// ============================ 字段应用 ============================
/**
 * 计算并应用字段。返回 {applied, conflicts}。
 * @param {object} a {objectType, objectId, event, localRow, fields, isInsert}
 */
function applyFields(a) {
  const spec = C.OBJECT_SPECS[a.objectType];
  const fmap = fieldMap(spec);
  const applied = [];
  const conflicts = [];
  const patch = {};
  const lockActive = a.objectType === 'Order' &&
    (truthy(a.localRow && a.localRow.user_status_locked) || truthy(a.event.payload.user_status_locked));
  const sameWindow = !!(a.localRow && store.hasPendingLocalChange(a.objectType, a.objectId));

  for (const name of Object.keys(a.fields)) {
    const v = a.fields[name];
    if ((name === 'serial_number' || spec.keyFields.includes(name)) && !a.isInsert) continue; // 键不改
    const f = fmap[name];
    if (!f) continue; // 契约未声明的本地字段一律不动
    // created_at/updated_at（meta）：不参与 §6 冲突比对（时间戳差异不是业务冲突），
    // 故不进 patch；落库时另外处理——created_at 镜像源值（对象诞生事实），updated_at 取本地落库时刻。
    if (f.meta) continue;

    // 人工锁优先（§6.2）
    if (a.objectType === 'Order' && (f.lockField || ORDER_LOCK_FIELDS.includes(name)) && lockActive) {
      const localVal = a.localRow ? a.localRow[name] : undefined;
      if (String(localVal === undefined || localVal === null ? '' : localVal) !== String(v === undefined || v === null ? '' : v)) {
        conflicts.push({
          field: name, resolution: 'LOCKED',
          incoming_value: v, local_value: localVal,
          remark: '订单状态人工锁生效，事件不得改写'
        });
      }
      continue;
    }

    // 字段归属：Owner=EBMS 的字段不被入站覆盖（§6.1）
    if (f.owner === 'EBMS') {
      if (a.isInsert || !a.localRow) continue;      // 本地无值可争：新建时也不写入（EBMS 侧权威，等本地计算）
      const localVal = a.localRow[name];
      const lv = localVal === undefined || localVal === null ? '' : String(localVal);
      const iv = v === undefined || v === null ? '' : String(v);
      if (lv !== iv && !(lv === '' && iv === '')) {
        conflicts.push({
          field: name, resolution: 'OWNER_KEPT',
          incoming_value: v, local_value: localVal,
          remark: '字段 Owner=EBMS，入站值不覆盖'
        });
      }
      continue;
    }

    // 同窗口双改：Owner 侧胜出，但本地旧值留痕（§6.3）
    if (sameWindow && !a.isInsert && a.localRow) {
      const lv = a.localRow[name];
      const lvs = lv === undefined || lv === null ? '' : String(lv);
      const ivs = v === undefined || v === null ? '' : String(v);
      if (lvs !== ivs) {
        conflicts.push({
          field: name, resolution: 'STALE',
          incoming_value: v, local_value: lv,
          remark: '同窗口内双方均有变更，按 Owner 侧（CRM）取值，本地旧值丢弃'
        });
      }
    }

    const lv = wireToLocal(f, v);
    if (lv === undefined) continue; // 数值/布尔类空值不覆盖本地
    patch[name] = lv;
    applied.push(name);
  }
  return { patch, applied, conflicts };
}

function conflictRows(objectType, objectId, event, conflicts) {
  return conflicts.map(c => ({
    object_type: objectType,
    object_id: objectId,
    field: c.field,
    source_system: event.source_system,
    incoming_value: c.incoming_value,
    local_value: c.local_value,
    resolution: c.resolution,
    event_id: event.event_id,
    idempotency_key: event.idempotency_key,
    remark: c.remark,
    occurred_at: event.occurred_at
  }));
}

// ============================ 各对象落地 ============================
async function applyCustomer(a) {
  const spec = C.OBJECT_SPECS.Customer;
  const tb = db.getTable(spec.table);
  const local = a.rows[0] || null;
  const r = applyFields({ objectType: 'Customer', objectId: a.objectId, event: a.event, localRow: local, fields: a.payload, isInsert: !local });
  if (local) {
    if (r.applied.length) await tb.update(local.id, Object.assign({}, r.patch, { updated_at: now() }));
  } else {
    await tb.insert(Object.assign({}, r.patch, {
      name: String(a.payload.name || ''),
      created_at: a.payload.created_at || now(),
      updated_at: now()
    }));
  }
  return { applied: r.applied, conflicts: r.conflicts };
}

async function applySample(a) {
  const spec = C.OBJECT_SPECS.Sample;
  const tb = db.getTable(spec.table);
  const local = a.rows[0] || null;
  const r = applyFields({ objectType: 'Sample', objectId: a.objectId, event: a.event, localRow: local, fields: a.payload, isInsert: !local });
  if (local) {
    if (r.applied.length) await tb.update(local.id, Object.assign({}, r.patch, { updated_at: now() }));
  } else {
    await tb.insert(Object.assign({}, r.patch, {
      sample_no: String(a.payload.sample_no || ''),
      created_at: a.payload.created_at || now(),
      updated_at: now()
    }));
  }
  return { applied: r.applied, conflicts: r.conflicts };
}

async function applyOrder(a) {
  const spec = C.OBJECT_SPECS.Order;
  const tb = db.getTable(spec.table);
  const local = a.rows[0] || null;
  const r = applyFields({ objectType: 'Order', objectId: a.objectId, event: a.event, localRow: local, fields: a.payload, isInsert: !local });
  if (local) {
    if (r.applied.length) await tb.update(local.id, Object.assign({}, r.patch, { updated_at: now() }));
  } else {
    await tb.insert(Object.assign({}, r.patch, {
      order_no: String(a.payload.order_no || ''),
      line_no: a.payload.line_no === undefined || a.payload.line_no === null ? '' : String(a.payload.line_no),
      created_at: a.payload.created_at || now(),
      updated_at: now()
    }));
  }
  return { applied: r.applied, conflicts: r.conflicts };
}

async function applyQuoteLibrary(a) {
  const spec = C.OBJECT_SPECS.QuoteLibrary;
  const tb = db.getTable(spec.table);
  const local = a.rows[0] || null;
  const r = applyFields({ objectType: 'QuoteLibrary', objectId: a.objectId, event: a.event, localRow: local, fields: a.payload, isInsert: !local });
  if (local) {
    if (r.applied.length) await tb.update(local.id, Object.assign({}, r.patch, { updated_at: now() }));
  } else {
    await tb.insert(Object.assign({}, r.patch, {
      external_model: String(a.payload.external_model || ''),
      certificate_level: a.payload.certificate_level === undefined || a.payload.certificate_level === null ? '' : String(a.payload.certificate_level),
      created_at: a.payload.created_at || now(),
      updated_at: now()
    }));
  }
  return { applied: r.applied, conflicts: r.conflicts };
}

/**
 * 询价全量快照落地：items[] 逐行 → EBMS 行（首行 = 基号，第 i 行 = 基号-0i，与
 * routes/inquiry.js:2610-2625 的编号规则一致）；本次未出现的旧行删除。
 */
async function applyInquiry(a) {
  const spec = C.OBJECT_SPECS.Inquiry;
  const tb = db.getTable(spec.table);
  const base = String(a.payload.serial_number || '').replace(/-\d{2,}$/, '');
  const itemFields = spec.itemFields.map(f => f.name);
  const headerFields = {};
  Object.keys(a.payload).forEach(k => {
    if (k === 'items' || k === 'serial_number') return;
    if (itemFields.includes(k)) return;
    headerFields[k] = a.payload[k];
  });
  const items = Array.isArray(a.payload.items) ? a.payload.items : [];
  const applied = [];
  const conflicts = [];
  const existing = a.rows.slice();
  const usedIds = [];

  const plan = items.length ? items.map((item, i) => ({
    serial: i === 0 ? base : base + '-' + String(i + 1).padStart(2, '0'),
    parent: i === 0 ? '' : base
  })) : [{ serial: base, parent: '' }];

  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const local = existing.find(r => String(r.serial_number || '') === p.serial) || null;
    const item = items[i] || {};
    // item 级字段按对象头字段同表存放；header 与 item 合并后统一按 Owner 规则处理
    const fields = Object.assign({}, headerFields, item);
    const r = applyFields({
      objectType: 'Inquiry', objectId: a.objectId, event: a.event,
      localRow: local, fields, isInsert: !local
    });
    if (local) {
      if (r.applied.length) await tb.update(local.id, Object.assign({}, r.patch, { updated_at: now() }));
      usedIds.push(local.id);
    } else {
      const rec = Object.assign({}, r.patch, {
        serial_number: p.serial,
        created_at: a.payload.created_at || now(),
        updated_at: now()
      });
      if (p.parent) rec.parent_serial = p.parent;
      const ins = await tb.insert(rec);
      usedIds.push(ins.lastID);   // 新行也登记，避免随后的全量快照删除误删刚建的行
    }
    r.applied.forEach(f => { if (!applied.includes(f)) applied.push(f); });
    conflicts.push(...r.conflicts);
  }

  // 全量快照：本次未出现的旧行删除（询价行集合以 Owner 侧为准）
  for (const r of existing) {
    if (!usedIds.includes(r.id)) await tb.delete(r.id);
  }
  return { applied, conflicts };
}

/** 反馈落地：header 字段 + followups[] 全量替换（§4.1 内嵌、不做独立事件）。 */
async function applyFeedback(a) {
  const spec = C.OBJECT_SPECS.Feedback;
  const tb = db.getTable(spec.table);
  const local = a.rows[0] || null;
  const fields = {};
  Object.keys(a.payload).forEach(k => { if (k !== 'followups') fields[k] = a.payload[k]; });
  const r = applyFields({ objectType: 'Feedback', objectId: a.objectId, event: a.event, localRow: local, fields, isInsert: !local });

  let localId;
  if (local) {
    if (r.applied.length) await tb.update(local.id, Object.assign({}, r.patch, { updated_at: now() }));
    localId = local.id;
  } else {
    // 注意：insert 是异步的，必须 await 才能拿到 lastID；否则 followups 会以 undefined 外键落库
    const ins = await tb.insert(Object.assign({}, r.patch, {
      title: String(a.payload.title || ''),
      feedback_no: a.payload.feedback_no || a.objectId,
      created_at: a.payload.created_at || now(),
      updated_at: now()
    }));
    localId = ins.lastID;
  }

  // 跟进全量快照
  const ftb = db.getTable('feedback_followups');
  const emb = spec.embedded[0];
  const desired = Array.isArray(a.payload.followups) ? a.payload.followups : [];
  const old = ftb.all().filter(x => Number(x.feedback_id) === Number(localId));
  // 先删后建，保证集合一致（跟进为内嵌从属，不参与字段级冲突）
  for (const x of old) await ftb.delete(x.id);
  for (const row of desired) {
    const rec = { feedback_id: localId };
    emb.fields.forEach(f => {
      const lv = wireToLocal(f, row[f.name]);
      if (lv !== undefined) rec[f.name] = lv;
      else if (f.wire === 'str') rec[f.name] = '';
    });
    if (!rec.created_at) rec.created_at = now();
    await ftb.insert(rec);
  }
  return { applied: r.applied, conflicts: r.conflicts, followups: desired.length };
}

function applyEntity(a) {
  switch (a.event.object_type) {
    case 'Customer': return applyCustomer(a);
    case 'Inquiry': return applyInquiry(a);
    case 'QuoteLibrary': return applyQuoteLibrary(a);
    case 'Order': return applyOrder(a);
    case 'Sample': return applySample(a);
    case 'Feedback': return applyFeedback(a);
    default: throw new Error('不支持的 object_type: ' + a.event.object_type);
  }
}

// ============================ DELETE ============================
async function applyDelete(a) {
  const objectType = a.event.object_type;
  const spec = C.OBJECT_SPECS[objectType];
  const tb = db.getTable(spec.table);
  // §6.5 DELETE 保护
  if (store.hasPendingLocalChange(objectType, a.objectId)) {
    return {
      resolution: 'OWNER_KEPT',
      conflicts: [{
        object_type: objectType, object_id: a.objectId, field: '',
        source_system: a.event.source_system,
        incoming_value: 'DELETE', local_value: '本地存在未同步变更',
        resolution: 'OWNER_KEPT',
        event_id: a.event.event_id, idempotency_key: a.event.idempotency_key,
        remark: '目标对象存在本地未同步变更，跳过删除（§6.5）',
        occurred_at: a.event.occurred_at
      }],
      deleted: 0, applied: []
    };
  }
  let deleted = 0;
  for (const r of a.rows) { await tb.delete(r.id); deleted++; }
  if (objectType === 'Feedback') {
    const ftb = db.getTable('feedback_followups');
    for (const r of a.rows) {
      const mine = ftb.all().filter(x => Number(x.feedback_id) === Number(r.id));
      for (const x of mine) await ftb.delete(x.id);
    }
  }
  return { resolution: 'DELETED', conflicts: [], deleted, applied: [] };
}

// ============================ 字典组（P1）============================
async function applyDictionary(event) {
  const dictType = String((event.payload && event.payload.dict_type) || event.object_id);
  if (event.operation === 'UPSERT') {
    const tb = store.t('dictionary');
    const entries = Array.isArray(event.payload.entries) ? event.payload.entries : [];
    let row = tb.all().find(r => r.dict_type === dictType);
    if (row) await tb.update(row.id, { sync_status: 'SYNCED', last_sync_at: now(), entry_count: entries.length, updated_at: now() });
    else {
      const ins = await tb.insert({ dict_type: dictType, source_system: event.source_system, sync_status: 'SYNCED', last_sync_at: now(), entry_count: entries.length, created_at: now(), updated_at: now() });
      row = { id: ins.lastID };
    }
    const etb = store.t('dictionaryEntry');
    for (const r of etb.all().filter(r => r.dict_type === dictType)) await etb.delete(r.id);
    for (const e of entries) await etb.insert({
      dict_type: dictType,
      label: e.label === undefined || e.label === null ? '' : String(e.label),
      value: e.value === undefined || e.value === null ? '' : String(e.value),
      sort: Number.isInteger(e.sort) ? e.sort : 0,
      enabled: e.enabled === false ? 0 : 1,
      created_at: now()
    });
    return { applied: ['entries'], conflicts: [], entry_count: entries.length, local_id: row.id };
  }
  return { applied: [], conflicts: [] };
}

// ============================ Result / Exception 落地（M03 驾驶舱消费）============================
async function applyResult(env) {
  const tb = store.t('results');
  const existing = tb.all().find(r => r.result_id === env.result_id);
  const rec = {
    result_id: env.result_id,
    contract_version: env.contract_version,
    source_system: env.source_system,
    object_type: env.object_type,
    object_id: String(env.object_id),
    period_start: env.period ? env.period.start : '',
    period_end: env.period ? env.period.end : '',
    metric_code: env.metric ? env.metric.code : '',
    metric_name: env.metric ? (env.metric.name || '') : '',
    metric_value: env.metric ? env.metric.value : null,
    metric_unit: env.metric ? env.metric.unit : '',
    calculation_version: env.metric ? env.metric.calculation_version : '',
    status: env.status,
    evidence_ids: JSON.stringify(env.evidence_ids || []),
    trace_id: env.trace_id,
    occurred_at: env.occurred_at,
    payload: JSON.stringify(env),
    updated_at: now()
  };
  if (existing) await tb.update(existing.id, rec);
  else await tb.insert(Object.assign({}, rec, { created_at: now() }));
  return { applied: true, result_id: env.result_id };
}

async function applyException(env) {
  const tb = store.t('exceptions');
  const existing = tb.all().find(r => r.exception_id === env.exception_id);
  const rec = {
    exception_id: env.exception_id,
    contract_version: env.contract_version,
    source_system: env.source_system,
    object_type: env.object_type,
    object_id: String(env.object_id),
    severity: env.severity,
    reason_code: env.reason_code,
    status: env.status,
    evidence_ids: JSON.stringify(env.evidence_ids || []),
    trace_id: env.trace_id,
    occurred_at: env.occurred_at,
    payload: JSON.stringify(env),
    updated_at: now()
  };
  if (existing) await tb.update(existing.id, rec);
  else await tb.insert(Object.assign({}, rec, { created_at: now() }));
  return { applied: true, exception_id: env.exception_id };
}

// ============================ 主入口 ============================
/**
 * 处理一条已通过契约校验的报文。
 *
 * 整条处理链在**单把锁**内串行：幂等判重 → 乱序判定 → 落地 → 冲突留痕 → 同步态 → 日志。
 * 表写操作本身是异步的（db 层 FIFO 锁），若不加这层锁，两条并发到达的同一对象事件
 * 会各自读到「尚无记录」，从而绕过幂等判重重复落库（AC-S3/AC-S6 会在并发下失守）。
 *
 * @returns {Promise<{status:number, body:object}>}
 */
function applyEnvelope(env) {
  return db.withTableLock('aeos:ingest', () => applyEnvelopeLocked(env));
}

async function applyEnvelopeLocked(env) {
  store.init();
  const version = env.contract_version;
  const startedAt = now();

  if (version === 'AEOS.Result.V1') {
    const r = await applyResult(env);
    await store.logInbound({
      contract_version: version, kind: 'result', event_id: env.result_id,
      object_type: env.object_type, object_id: env.object_id, operation: '',
      idempotency_key: '', source_system: env.source_system, status: 'applied',
      resolution: 'APPLIED', request_payload: JSON.stringify(env),
      trace_id: env.trace_id, occurred_at: env.occurred_at, started_at: startedAt
    });
    return { status: 200, body: { result: 'applied', kind: 'result', result_id: r.result_id } };
  }
  if (version === 'AEOS.Exception.V1') {
    const r = await applyException(env);
    await store.logInbound({
      contract_version: version, kind: 'exception', event_id: env.exception_id,
      object_type: env.object_type, object_id: env.object_id, operation: '',
      idempotency_key: '', source_system: env.source_system, status: 'applied',
      resolution: 'APPLIED', request_payload: JSON.stringify(env),
      trace_id: env.trace_id, occurred_at: env.occurred_at, started_at: startedAt
    });
    return { status: 200, body: { result: 'applied', kind: 'exception', exception_id: r.exception_id } };
  }

  // ---- Event ----
  const objectType = env.object_type;
  const objectId = String(env.object_id);
  const logBase = {
    contract_version: version, kind: 'event', event_id: env.event_id, event_type: env.event_type,
    object_type: objectType, object_id: objectId, operation: env.operation,
    idempotency_key: env.idempotency_key, source_system: env.source_system,
    request_payload: JSON.stringify(env), trace_id: env.trace_id, occurred_at: env.occurred_at,
    started_at: startedAt
  };

  // 1) 幂等判重（AC-S3）
  const dup = store.findInboundByIdempotency(env.idempotency_key);
  if (dup) {
    await store.logInbound(Object.assign({}, logBase, {
      status: 'skipped', resolution: 'DUPLICATE', retry_count: 0,
      last_error: '幂等键已处理，不重复落库'
    }));
    return {
      status: 200,
      body: { result: 'skipped', object_type: objectType, object_id: objectId, reason: 'idempotency_key 已处理', ref_inbound_id: dup.id }
    };
  }

  try {
    // 2) 乱序/过期（§6.4）
    const st = store.findState(objectType, objectId);
    if (st && st.last_sync_at && C.parseTime(env.occurred_at) < C.parseTime(st.last_sync_at)) {
      await store.logInbound(Object.assign({}, logBase, {
        status: 'skipped', resolution: 'STALE',
        last_error: '事件 occurred_at 早于 last_sync_at，判定为乱序/过期'
      }));
      return {
        status: 200,
        body: { result: 'skipped', resolution: 'STALE', object_type: objectType, object_id: objectId, reason: '事件早于本地 last_sync_at' }
      };
    }

    // 字典组走独立 sidecar
    if (objectType === 'Dictionary') {
      const d = await applyDictionary(env);
      await store.markStateSynced(objectType, objectId, {
        local_table: 'aeos_dictionary', local_id: d.local_id || null,
        last_direction: 'IN', last_event_id: env.event_id, idempotency_key: env.idempotency_key,
        external_id: objectId
      });
      await store.logInbound(Object.assign({}, logBase, {
        status: 'applied', resolution: 'APPLIED', applied_fields: JSON.stringify(d.applied)
      }));
      return { status: 200, body: { result: 'applied', object_type: objectType, object_id: objectId, applied_fields: d.applied } };
    }

    const rows = locateRows(objectType, objectId, env.payload);
    const a = { event: env, objectId, payload: env.payload || {}, rows };

    let outcome;
    if (env.operation === 'DELETE') {
      outcome = await applyDelete(a);
    } else {
      outcome = await applyEntity(a);
    }

    // 冲突留痕（§6 / AC-S7）
    const cRows = (env.operation === 'DELETE' && outcome.resolution === 'OWNER_KEPT')
      ? outcome.conflicts
      : conflictRows(objectType, objectId, env, outcome.conflicts || []);
    for (const c of cRows) await store.recordConflict(c);

    // 同步态：本地落点登记（AC-S6 可双向定位）
    const after = locateRows(objectType, objectId, env.payload);
    if (env.operation === 'DELETE' && outcome.resolution === 'DELETED') {
      await store.removeState(objectType, objectId);
    } else {
      await store.markStateSynced(objectType, objectId, {
        local_table: C.OBJECT_SPECS[objectType].table,
        local_id: after.length ? after[0].id : null,
        external_id: objectId,
        last_direction: 'IN',
        last_event_id: env.event_id,
        idempotency_key: env.idempotency_key,
        source_updated_at: (env.payload && env.payload.updated_at) || env.occurred_at
      });
    }

    const status = (outcome.conflicts && outcome.conflicts.length) || outcome.resolution === 'OWNER_KEPT'
      ? 'conflict' : 'applied';
    await store.logInbound(Object.assign({}, logBase, {
      status,
      resolution: outcome.resolution || 'APPLIED',
      applied_fields: JSON.stringify(outcome.applied || []),
      conflict_count: cRows.length
    }));

    return {
      status: 200,
      body: {
        result: 'applied',
        object_type: objectType,
        object_id: objectId,
        operation: env.operation,
        resolution: outcome.resolution || 'APPLIED',
        applied_fields: outcome.applied || [],
        deleted: outcome.deleted || 0,
        conflicts: cRows.map(c => ({ field: c.field, resolution: c.resolution }))
      }
    };
  } catch (e) {
    try {
      await store.logInbound(Object.assign({}, logBase, {
        status: 'failed', resolution: 'ERROR', last_error: e.message
      }));
    } catch (_) { /* 日志失败不掩盖原始错误 */ }
    // 处理期异常按可重试处理（5xx），让对侧按退避重投（§5.3 重试策略）
    return { status: 500, body: { result: 'error', error: e.message, object_type: objectType, object_id: objectId } };
  }
}

module.exports = {
  ORDER_LOCK_FIELDS, wireToLocal, keyOf, locateRows, applyFields,
  applyEnvelope, applyResult, applyException, applyDictionary, applyDelete
};
