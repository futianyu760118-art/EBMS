/**
 * EDP 对接回归测试（不触碰生产数据、不发真实请求，仅验证映射/契约/fail-closed）。
 * 运行：node scripts/edp-integration-regression.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebms-edp-'));
process.env.EBMS_DATA_DIR = tempDir;
process.env.USE_JSON_DB = '1';
delete process.env.EDP_BASE_URL;
delete process.env.EDP_PUSH_KEY;
delete process.env.EDP_READ_KEY;

const ingest = require('../backend/lib/edp-ingest');
const edp = require('../backend/lib/data-provider/edp-provider');

async function main() {
  // ---- 数据映射：EBMS 管理对象 → EDP 源记录 ----
  const indRecords = ingest.buildIndicatorRecords([
    { id: 1, name: '销售接单', department: '销售', category: 'core', target: '440万', actual: '280万', status: 'yellow', note: 'x', updated_at: '2026-11-01T00:00:00Z' }
  ], '2026-10');
  assert.equal(indRecords.length, 1);
  assert.equal(indRecords[0].object_type, 'Indicator');
  assert.equal(indRecords[0].source_id, 'ind-1');
  assert.equal(indRecords[0].payload.period, '2026-10');
  assert.equal(indRecords[0].payload.actual, '280万');
  assert.ok(indRecords[0].occurred_at, 'occurred_at 必须存在');

  const exc = ingest.buildExceptionRecords([{ id: 9, level: 'P1', title: '现金流', owner: '沈旭日' }], '2026-10');
  assert.equal(exc[0].object_type, 'Exception');
  assert.equal(exc[0].source_id, 'exc-9');

  const dec = ingest.buildDecisionRecords([{ id: 2, seq: 1, title: 'Q4回款', owner: 'x' }], '2026-10');
  assert.equal(dec[0].object_type, 'Decision');

  const todo = ingest.buildTodoRecords([{ work_item_id: 'ebms:sop_action:1', source_object_type: 'SopAction', title: 't', owner: 'o', status: 'pending' }]);
  assert.equal(todo[0].object_type, 'Action');
  assert.equal(todo[0].source_id, 'act-ebms:sop_action:1');
  assert.equal(todo[0].payload.work_item_id, 'ebms:sop_action:1');

  // ---- fail-closed：未配置 EDP 时，ingest/edp 都拒绝 ----
  assert.equal(ingest.configured(), false, '未配置 EDP_PUSH_KEY 应 fail-closed');
  assert.equal(edp.configured(), false, '未配置 EDP_READ_KEY 应 fail-closed');

  const fin = await edp.getFinanceResults('2026-10');
  assert.equal(fin.source, 'edp');
  assert.equal(fin.status, 'not_connected', '未配置时应返回 not_connected');
  assert.equal(fin.owner, 'M09_FAC');
  assert.equal(fin.contract, 'finance-result-v1');

  // ---- 数据集 code 映射 ----
  assert.equal(edp.datasetCode('finance'), 'finance_result');
  assert.equal(edp.datasetCode('indicators'), 'indicator');
  process.env.EDP_DATASET_FINANCE = 'ads_finance';
  assert.equal(edp.datasetCode('finance'), 'ads_finance', '环境变量应覆盖默认数据集 code');
  delete process.env.EDP_DATASET_FINANCE;

  // ---- .env.example 已声明 EDP 变量 ----
  const envExample = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.match(envExample, /EDP_BASE_URL/);
  assert.match(envExample, /EDP_PUSH_KEY/);
  assert.match(envExample, /EDP_READ_KEY/);

  console.log('edp integration regression checks passed');
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
});
