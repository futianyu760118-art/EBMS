/**
 * AEOS 人员生命周期同步（Phase 1 统一契约）—— EBMS / M03 adapter 落地逻辑。
 *
 * 接收 M02 EDP 分发的 PersonLifecycleEventV1 事件（契约 contracts/aeos-v1/person-lifecycle-event-v1.schema.json），
 * 按事件类型落到 EBMS，回执 PersonLifecycleResultV1。
 *
 * 能力映射（对应 registry M03_EBMS 的 sync_capabilities）：
 *   - person.offboarded → offboard（停用登录）+ hide（status=inactive 使不在在职名单）
 *                        + revoke（org_personnel_perms 置 deny）+ audit（sync_log 留痕）
 *   - person.reinstated → reinstate（恢复基本登录，权限仍保留 deny 等管理员确认）+ audit
 *
 * 鉴权：X-AEOS-Key-Id + X-AEOS-Timestamp + X-AEOS-Signature（HMAC-SHA256(secret, "{timestamp}.{body}")）
 *        timestamp 兼容秒级（AEOS 契约，ToUnixTimeSeconds）与毫秒级（EBMS 旧 M01 用法）。
 * 幂等：按 event_id / idempotency_key 判重
 * fail-closed：未配置密钥时上层返回 503，不读不写业务表
 */
const crypto = require('crypto');

const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
const TARGET_SYSTEM = 'M03_EBMS';
const EVENT_TYPES = new Set(['person.offboarded', 'person.reinstated']);

function verifySignature({ secret, timestamp, signature, body, now = Date.now() }) {
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  // 秒级（AEOS 契约）归一化为毫秒用于窗口判断；签名体仍用原始 timestamp 字符串
  const tsMs = ts < 1e12 ? ts * 1000 : ts;
  if (Math.abs(Number(now) - tsMs) > SIGNATURE_WINDOW_MS) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', String(secret))
    .update(String(timestamp) + '.' + String(body || ''))
    .digest('hex');
  const actual = String(signature).startsWith('sha256=') ? String(signature) : 'sha256=' + String(signature);
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validateEvent(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') return { ok: false, errors: ['事件体为空或非对象'] };
  if (!EVENT_TYPES.has(payload.event_type)) errors.push('event_type 必须是 person.offboarded 或 person.reinstated');
  if (!payload.event_id) errors.push('event_id 缺失');
  if (payload.object_type !== 'Person') errors.push('object_type 必须为 Person');
  const person = payload.person || {};
  if (!person.person_id && !person.emp_code) errors.push('person.person_id / person.emp_code 至少提供一项');
  return { ok: errors.length === 0, errors };
}

function findPersonByEvent(rows, payload) {
  const person = (payload && payload.person) || {};
  const empCode = String(person.emp_code || '');
  const personId = String(person.person_id || '');
  if (empCode) {
    const byCode = rows.find(r => String(r.emp_code || '') === empCode);
    if (byCode) return byCode;
  }
  const m = personId.match(/^P_EBMS_(\d+)$/i);
  if (m) return rows.find(r => Number(r.id) === Number(m[1])) || null;
  return null;
}

function findPrevious(rows, payload) {
  const eventId = String((payload && payload.event_id) || '');
  const idemKey = String((payload && payload.idempotency_key) || '');
  return rows.find(r =>
    (eventId && String(r.event_id || '') === eventId) ||
    (idemKey && String(r.idempotency_key || '') === idemKey)
  ) || null;
}

async function updateRows(table, rows, fields) {
  let changed = 0;
  for (const row of rows) {
    const result = await table.update(row.id, fields);
    if (result && result.changes) changed += result.changes;
  }
  return changed;
}

async function applyOffboard({ tables, payload, person, now }) {
  const update = {
    status: 'inactive',
    offboarded_at: payload.effective_at || now,
    offboarded_source: 'M01',
    offboarded_event_id: payload.event_id,
    updated_at: now
  };
  const changed = {
    org_personnel: await updateRows(tables.orgPersonnel, [person], update),
    personnel: await updateRows(tables.personnel, tables.personnel.all().filter(row =>
      String(row.emp_code || '') === String(person.emp_code || '')
    ), update),
    users: 0,
    permissions: 0
  };
  if (person.linked_user_id !== undefined && person.linked_user_id !== null) {
    changed.users = await updateRows(tables.users, tables.users.all().filter(u =>
      Number(u.id) === Number(person.linked_user_id)
    ), { status: 'inactive', updated_at: now });
  }
  changed.permissions = await updateRows(tables.personnelPerms, tables.personnelPerms.all().filter(p =>
    Number(p.personnel_id) === Number(person.id)
  ), {
    type: 'deny',
    source: 'M01',
    reason: '人员已离职，系统自动停止权限',
    updated_at: now
  });
  return changed;
}

async function applyReinstate({ tables, payload, person, now }) {
  const update = {
    status: 'active',
    reinstated_at: payload.effective_at || now,
    reinstated_source: 'M01',
    reinstated_event_id: payload.event_id,
    updated_at: now
  };
  const changed = {
    org_personnel: await updateRows(tables.orgPersonnel, [person], update),
    personnel: await updateRows(tables.personnel, tables.personnel.all().filter(row =>
      String(row.emp_code || '') === String(person.emp_code || '')
    ), update),
    users: 0,
    permissions: 0
  };
  if (person.linked_user_id !== undefined && person.linked_user_id !== null) {
    changed.users = await updateRows(tables.users, tables.users.all().filter(u =>
      Number(u.id) === Number(person.linked_user_id)
    ), { status: 'active', updated_at: now });
  }
  // 复职只恢复基本登录；原权限仍保留 deny，由管理员确认后手动恢复（不在此自动 grant）
  return changed;
}

async function handlePersonLifecycle({ tables, payload, now = new Date().toISOString() }) {
  const receivedAt = new Date().toISOString();
  const v = validateEvent(payload);
  if (!v.ok) {
    return { status: 422, body: { result: 'invalid', errors: v.errors } };
  }

  const previous = findPrevious(tables.syncLog.all(), payload);
  if (previous) {
    return {
      status: 200,
      body: {
        event_id: payload.event_id,
        target_system: TARGET_SYSTEM,
        status: 'skipped',
        changed: {},
        received_at: receivedAt,
        reason: 'duplicate'
      }
    };
  }

  const person = findPersonByEvent(tables.orgPersonnel.all(), payload);
  if (!person) {
    await tables.syncLog.insert({
      event_id: payload.event_id,
      idempotency_key: payload.idempotency_key || '',
      person_id: String((payload.person || {}).person_id || ''),
      emp_code: String((payload.person || {}).emp_code || ''),
      person_name: '',
      trace_id: String(payload.trace_id || ''),
      status: 'failed',
      changed: '{}',
      created_at: now
    });
    return {
      status: 200,
      body: {
        event_id: payload.event_id,
        target_system: TARGET_SYSTEM,
        status: 'failed',
        changed: {},
        received_at: receivedAt,
        reason: 'person not found',
        last_error_code: 'M03_PERSON_NOT_FOUND'
      }
    };
  }

  const changed = payload.event_type === 'person.offboarded'
    ? await applyOffboard({ tables, payload, person, now })
    : await applyReinstate({ tables, payload, person, now });

  await tables.syncLog.insert({
    event_id: payload.event_id,
    idempotency_key: payload.idempotency_key || '',
    person_id: String((payload.person || {}).person_id || ''),
    emp_code: String(person.emp_code || (payload.person || {}).emp_code || ''),
    person_name: person.name || '',
    trace_id: String(payload.trace_id || ''),
    status: 'applied',
    changed: JSON.stringify(changed),
    created_at: now
  });

  return {
    status: 200,
    body: {
      event_id: payload.event_id,
      target_system: TARGET_SYSTEM,
      status: 'synced',
      changed,
      received_at: receivedAt
    }
  };
}

module.exports = {
  TARGET_SYSTEM,
  EVENT_TYPES,
  SIGNATURE_WINDOW_MS,
  verifySignature,
  validateEvent,
  findPersonByEvent,
  findPrevious,
  handlePersonLifecycle
};
