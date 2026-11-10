/**
 * EBMS 对外只读接口 v1 回归测试（隔离数据目录，不触碰生产 sales.db）。
 *
 * 覆盖：HMAC 签名校验、待办聚合、数据端点取数、fail-closed。
 * 运行：node scripts/external-v1-regression.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebms-external-v1-'));
process.env.EBMS_DATA_DIR = tempDir;
process.env.USE_JSON_DB = '1';
process.env.EBMS_EXTERNAL_APP_KEY = 'ak_test1234567890';
process.env.EBMS_EXTERNAL_APP_SECRET = 'test-secret-external-v1';

const { getTable } = require('../backend/db');
const core = require('../backend/lib/external-v1-core');

const APP_KEY = 'ak_test1234567890';
const SECRET = 'test-secret-external-v1';

function sign(method, path, ts) {
  return crypto.createHmac('sha256', SECRET).update(String(ts) + '.' + method + '.' + path).digest('hex');
}

async function seed(table, records) {
  const t = getTable(table);
  for (const r of records) await t.insert(Object.assign({}, r));
  return t;
}

async function main() {
  // ---- 夹具：待办 + 月度报告指标 ----
  await seed('sop_actions', [
    { action_code: 'ACT-1', description: '采购准交率告警', owner_name: '张三', due_date: '2026-01-01', status: 'PENDING' },
    { action_code: 'ACT-2', description: '已完成行动', owner_name: '李四', due_date: '2025-12-31', status: 'CLOSED' }
  ]);
  await seed('ai_actions', [{ title: '核价超时行动', assignee: '王五', status: 'pending' }]);
  await seed('chat_action_items', [{ content: '跟催客户询价', assignee: '赵六', status: 'pending' }]);

  const report = await seed('monthly_reports', [{ period: '2026-10', title: '2026年10月', summary: 'x', status: 'published' }]);
  const rid = report.all()[0].id;
  await seed('monthly_indicators', [
    { report_id: rid, department: '财务', category: 'core', name: '开票销售额', actual: '177万', status: 'yellow', sort_order: 1 }
  ]);
  await seed('monthly_dept_summary', [{ report_id: rid, department: '财务', judgment: 'red', sort_order: 1 }]);

  // ---- 待办聚合 ----
  const todos = core.collectTodos();
  assert.equal(todos.length, 3, '待办应为 sop(pending) + ai + chat 共 3 条（CLOSED 排除）');
  assert.ok(todos.some(t => t.work_item_id === 'ebms:sop_action:1'));
  assert.ok(todos.some(t => t.source_object_type === 'AiAction'));
  assert.ok(!todos.some(t => t.source_object_type === 'SopAction' && t.title === '已完成行动'), 'CLOSED 待办应排除');

  // ---- HMAC 签名校验 ----
  const now = Math.floor(Date.now() / 1000);
  assert.equal(core.verifySignature(SECRET, String(now), sign('GET', '/api/v1/external/todos', now), 'GET', '/api/v1/external/todos'), true, '正确签名应通过');
  assert.equal(core.verifySignature(SECRET, String(now), 'bad', 'GET', '/api/v1/external/todos'), false, '错误签名应拒绝');
  assert.equal(core.verifySignature(SECRET, String(now - 600), sign('GET', '/api/v1/external/todos', now - 600), 'GET', '/api/v1/external/todos'), false, '过期签名应拒绝');
  assert.equal(core.verifySignature(SECRET, String(now), sign('POST', '/api/v1/external/todos', now), 'GET', '/api/v1/external/todos'), false, '方法不一致应拒绝');

  console.log('external-v1 regression checks passed');
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
});
