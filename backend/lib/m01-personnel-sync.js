const crypto = require('crypto');

const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

function signRequest(secret, timestamp, body) {
  return 'sha256=' + crypto.createHmac('sha256', String(secret || ''))
    .update(String(timestamp) + '.' + String(body || ''))
    .digest('hex');
}

function verifyRequestSignature({ secret, timestamp, signature, body, now = Date.now() }) {
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Number(now) - ts) > SIGNATURE_WINDOW_MS) return false;
  const expected = signRequest(secret, timestamp, body);
  const actual = String(signature).startsWith('sha256=') ? String(signature) : 'sha256=' + String(signature);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function sourceIdFromPersonId(personId) {
  const match = String(personId || '').match(/^P_EBMS_(\d+)$/i);
  return match ? Number(match[1]) : null;
}

function findPerson(rows, payload) {
  const empCode = payload.emp_code === undefined || payload.emp_code === null ? '' : String(payload.emp_code);
  const sourceId = sourceIdFromPersonId(payload.person_id);
  return rows.find(row => empCode && String(row.emp_code || '') === empCode)
    || (sourceId ? rows.find(row => Number(row.id) === sourceId) : null)
    || null;
}

async function updateRows(table, rows, fields) {
  let changed = 0;
  for (const row of rows) {
    const result = await table.update(row.id, fields);
    if (result && result.changes) changed += result.changes;
  }
  return changed;
}

async function applyOffboard({ tables, payload, now = new Date().toISOString() }) {
  const eventId = String(payload && payload.event_id || '');
  if (!eventId || !payload || (!payload.person_id && !payload.emp_code)) {
    return { ok: false, status: 400, error: '缺少离职事件编号或人员编号' };
  }

  const previous = tables.syncLog.all().find(row => row.event_id === eventId);
  if (previous) return { ok: true, idempotent: true, event_id: eventId, sync_id: previous.id };

  const orgRows = tables.orgPersonnel.all();
  const orgPerson = findPerson(orgRows, payload);
  if (!orgPerson) return { ok: false, status: 404, error: 'EBMS找不到对应人员，未执行停用' };

  const update = {
    status: 'inactive',
    offboarded_at: payload.offboarded_at || now,
    offboarded_source: 'M01',
    offboarded_event_id: eventId,
    updated_at: now
  };
  const changed = {
    org_personnel: await updateRows(tables.orgPersonnel, [orgPerson], update),
    personnel: await updateRows(tables.personnel, tables.personnel.all().filter(row =>
      String(row.emp_code || '') === String(orgPerson.emp_code || '') || Number(row.id) === sourceIdFromPersonId(payload.person_id)
    ), update),
    users: 0,
    permissions: 0
  };

  if (orgPerson.linked_user_id !== undefined && orgPerson.linked_user_id !== null) {
    const linkedUsers = tables.users.all().filter(row => Number(row.id) === Number(orgPerson.linked_user_id));
    changed.users = await updateRows(tables.users, linkedUsers, update);
  }

  const personPermissions = tables.personnelPerms.all().filter(row => Number(row.personnel_id) === Number(orgPerson.id));
  changed.permissions = await updateRows(tables.personnelPerms, personPermissions, {
    type: 'deny',
    source: 'M01',
    reason: '人员已离职，系统自动停止权限',
    updated_at: now
  });

  const inserted = await tables.syncLog.insert({
    event_id: eventId,
    person_id: String(payload.person_id || ''),
    emp_code: String(orgPerson.emp_code || payload.emp_code || ''),
    person_name: orgPerson.name || payload.name || '',
    trace_id: String(payload.trace_id || ''),
    status: 'applied',
    changed: JSON.stringify(changed),
    created_at: now
  });
  return { ok: true, idempotent: false, event_id: eventId, sync_id: inserted.lastID, person_id: orgPerson.id, changed };
}

function filterActivePersonnel(rows) {
  return rows.filter(row => row && row.status === 'active');
}

module.exports = {
  SIGNATURE_WINDOW_MS,
  signRequest,
  verifyRequestSignature,
  applyOffboard,
  filterActivePersonnel,
  sourceIdFromPersonId
};
