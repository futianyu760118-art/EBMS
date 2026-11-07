/**
 * AEOS 人员生命周期同步回归测试（隔离数据目录，不触碰生产 sales.db）。
 *
 * 运行：node scripts/person-lifecycle-regression.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebms-person-lifecycle-'));
process.env.EBMS_DATA_DIR = tempDir;
process.env.USE_JSON_DB = '1';

const { getTable } = require('../backend/db');
const {
  TARGET_SYSTEM,
  EVENT_TYPES,
  validateEvent,
  verifySignature,
  handlePersonLifecycle
} = require('../backend/lib/aeos-person-lifecycle');
const { signRequest } = require('../backend/lib/m01-personnel-sync');

async function seed(table, records) {
  const t = getTable(table);
  for (const r of records) await t.insert(Object.assign({}, r));
  return t;
}

function tables() {
  return {
    orgPersonnel: getTable('org_personnel'),
    personnel: getTable('personnel'),
    users: getTable('users'),
    personnelPerms: getTable('org_personnel_perms'),
    syncLog: getTable('m01_personnel_sync_log')
  };
}

function offboardEvent(overrides) {
  return Object.assign({
    tenant_id: 'hj',
    event_id: 'EVT-OFF-001',
    event_type: 'person.offboarded',
    event_version: 1,
    source_system: 'M01_KERNEL',
    object_type: 'Person',
    object_id: 'P-1',
    revision: 1,
    occurred_at: '2026-11-06T00:00:00Z',
    effective_at: '2026-11-06T00:00:00Z',
    correlation_id: 'CORR-1',
    trace_id: 'TRACE-1',
    idempotency_key: 'person-lifecycle:hj:P-1:1',
    person: { person_id: 'P-1', emp_code: 'E001' },
    status: 'inactive',
    employment_action: 'offboard',
    occurred_by: 'test'
  }, overrides || {});
}

async function main() {
  await seed('users', [{ username: 'zhangsan', password: 'x', name: '张三', role: 'sales', status: 'active' }]);
  await seed('org_personnel', [{ emp_code: 'E001', name: '张三', linked_user_id: 1, status: 'active', position_name: '销售' }]);
  await seed('personnel', [{ emp_code: 'E001', name: '张三', status: 'active' }]);
  await seed('org_personnel_perms', [{ personnel_id: 1, permission_id: 100, type: 'grant' }]);

  const t = tables();

  // ---- 事件校验 ----
  assert.equal(EVENT_TYPES.has('person.offboarded'), true);
  assert.equal(EVENT_TYPES.has('person.reinstated'), true);
  assert.equal(validateEvent(offboardEvent()).ok, true, '合法 offboard 事件应通过校验');
  assert.equal(validateEvent(offboardEvent({ event_type: 'person.updated' })).ok, false, '未知 event_type 应被拒绝');
  assert.equal(validateEvent(offboardEvent({ object_type: 'Org' })).ok, false, 'object_type 非 Person 应被拒绝');

  // ---- 签名校验（兼容秒级 AEOS 契约与毫秒级旧用法）----
  const secret = 'test-secret';
  const body = JSON.stringify(offboardEvent());
  const ts = String(Date.now());
  const sig = signRequest(secret, ts, body);
  assert.equal(verifySignature({ secret, timestamp: ts, signature: sig, body }), true, '毫秒级正确签名应通过');
  const tsSec = String(Math.floor(Date.now() / 1000));
  assert.equal(verifySignature({ secret, timestamp: tsSec, signature: signRequest(secret, tsSec, body), body }), true, '秒级正确签名应通过');
  assert.equal(verifySignature({ secret, timestamp: ts, signature: 'sha256=bad', body }), false, '错误签名应拒绝');
  const stale = String(Date.now() - 10 * 60 * 1000);
  assert.equal(verifySignature({ secret, timestamp: stale, signature: signRequest(secret, stale, body), body }), false, '过期签名应拒绝');

  // ---- offboard：停用 + 撤权 + 留痕 ----
  const r1 = await handlePersonLifecycle({ tables: t, payload: offboardEvent(), now: '2026-11-06 00:00:00' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.status, 'synced');
  assert.equal(r1.body.target_system, TARGET_SYSTEM);
  assert.equal(getTable('org_personnel').findById(1).status, 'inactive', 'offboard 后组织人员应 inactive');
  assert.equal(getTable('users').findById(1).status, 'inactive', 'offboard 后关联用户应 inactive');
  assert.equal(getTable('org_personnel_perms').findById(1).type, 'deny', 'offboard 后权限应转 deny');

  // ---- 幂等：重复事件（同 event_id / idempotency_key）跳过 ----
  const r2 = await handlePersonLifecycle({ tables: t, payload: offboardEvent(), now: '2026-11-06 00:00:01' });
  assert.equal(r2.body.status, 'skipped', '重复事件应返回 skipped');
  assert.equal(getTable('m01_personnel_sync_log').all().filter(x => x.status === 'applied').length, 1, '重复事件不得重复记账');

  // ---- 幂等：不同 event_id 但同 idempotency_key 也应跳过 ----
  const r3 = await handlePersonLifecycle({ tables: t, payload: offboardEvent({ event_id: 'EVT-OFF-002' }), now: '2026-11-06 00:00:02' });
  assert.equal(r3.body.status, 'skipped', '同 idempotency_key 不同 event_id 应跳过');

  // ---- reinstate：恢复登录，权限保留 deny ----
  const reinstate = {
    tenant_id: 'hj', event_id: 'EVT-RE-001', event_type: 'person.reinstated', event_version: 1,
    source_system: 'M01_KERNEL', object_type: 'Person', object_id: 'P-1', revision: 2,
    occurred_at: '2026-11-06T01:00:00Z', effective_at: '2026-11-06T01:00:00Z',
    correlation_id: 'CORR-2', trace_id: 'TRACE-2', idempotency_key: 'person-lifecycle:hj:P-1:2',
    person: { person_id: 'P-1', emp_code: 'E001' }, status: 'active', employment_action: 'reinstate', occurred_by: 'test'
  };
  const r4 = await handlePersonLifecycle({ tables: t, payload: reinstate, now: '2026-11-06 01:00:00' });
  assert.equal(r4.body.status, 'synced');
  assert.equal(getTable('org_personnel').findById(1).status, 'active', 'reinstate 后组织人员应 active');
  assert.equal(getTable('users').findById(1).status, 'active', 'reinstate 后关联用户应 active');
  assert.equal(getTable('org_personnel_perms').findById(1).type, 'deny', 'reinstate 后权限仍应 deny（等管理员确认）');

  // ---- 人员未找到 ----
  const missing = offboardEvent({ event_id: 'EVT-MISS-1', idempotency_key: 'person-lifecycle:hj:P-X:9', person: { person_id: 'P-X', emp_code: 'E999' } });
  const r5 = await handlePersonLifecycle({ tables: t, payload: missing, now: '2026-11-06 02:00:00' });
  assert.equal(r5.body.status, 'failed', '找不到人员应返回 failed');
  assert.equal(r5.body.last_error_code, 'M03_PERSON_NOT_FOUND');

  // ---- 契约文件可解析且与实现一致 ----
  const schemaPath = path.join(__dirname, '..', 'contracts', 'aeos-v1', 'person-lifecycle-event-v1.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.deepEqual(schema.properties.event_type.enum, ['person.offboarded', 'person.reinstated']);
  const resultSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', 'aeos-v1', 'person-lifecycle-result-v1.schema.json'), 'utf8'));
  assert.ok(resultSchema.properties.status.enum.includes('synced'));
  assert.ok(resultSchema.properties.status.enum.includes('skipped'));
  assert.ok(resultSchema.properties.status.enum.includes('failed'));

  // ---- 路由挂载检查 ----
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
  assert.match(serverSrc, /app\.use\('\/internal\/aeos'/, '内部端点必须挂载到 /internal/aeos');

  console.log('person lifecycle regression checks passed');
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
});
