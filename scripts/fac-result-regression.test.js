/**
 * M09 FAC FinanceResult 消费回归测试（隔离数据目录，不触碰生产 sales.db）。
 * 运行：node scripts/fac-result-regression.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebms-fac-result-'));
process.env.EBMS_DATA_DIR = tempDir;
process.env.USE_JSON_DB = '1';

const { getTable } = require('../backend/db');
const store = require('../backend/lib/fac-result-store');
const local = require('../backend/lib/data-provider/local-provider');

async function seed(table, records) {
  const t = getTable(table);
  for (const r of records) await t.insert(Object.assign({}, r));
  return t;
}

async function main() {
  // ---- 落库幂等 + 版本追加 ----
  const r1 = await store.saveFinanceResult({
    result_id: 'FR-001', revision: 1, result_type: 'MARGIN', status: 'VERIFIED',
    accounting_period: '2026-10', currency: 'CNY', total_revenue: '2110000',
    total_cost: '1997017', gross_margin: '112983', margin_rate: '0.0535',
    verified_at: '2026-11-01T00:00:00Z', verified_by: 'finance', rule_version: 'FAC-GM-V1'
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.idempotent, false);

  const dup = await store.saveFinanceResult({
    result_id: 'FR-001', revision: 1, status: 'VERIFIED'
  });
  assert.equal(dup.idempotent, true, '同 result_id + revision 应幂等跳过');

  const r2 = await store.saveFinanceResult({
    result_id: 'FR-001', revision: 2, status: 'SUPERSEDED', accounting_period: '2026-10'
  });
  assert.equal(r2.idempotent, false, '新 revision 应追加不覆盖');

  // ---- 读取：只返回 VERIFIED ----
  const verified = store.getVerifiedFinanceResults('2026-10');
  assert.equal(verified.length, 1, '只返回 VERIFIED（SUPERSEDED 排除）');
  assert.equal(verified[0].result_id, 'FR-001');
  assert.equal(verified[0].revision, 1);
  assert.equal(verified[0].gross_margin, '112983');

  // ---- 历史版本 ----
  const history = store.getHistory('FR-001');
  assert.equal(history.length, 2, '同 result_id 历史版本应保留');
  assert.deepEqual(history.map((x) => x.revision), [1, 2]);

  // ---- DataProvider 优先消费 FAC 结果 ----
  const report = await seed('monthly_reports', [{ period: '2026-10', title: 'x', summary: 'x', status: 'published' }]);
  const rid = report.all()[0].id;
  await seed('monthly_indicators', [
    { report_id: rid, department: '财务', category: 'core', name: '综合开票毛利率', actual: '14.4%', status: 'red', sort_order: 1 }
  ]);
  const fin = local.getFinanceResults('2026-10');
  assert.equal(fin.status, 'available');
  assert.equal(fin.data.length, 1);
  assert.equal(fin.data[0].object_id, 'FR-001', '应优先返回 FAC FinanceResult 而非本地财务指标');
  assert.equal(fin.data[0].gross_margin, '112983');
  assert.equal(fin.data[0].rule_version, 'FAC-GM-V1');

  // ---- 无 FAC 结果时回退本地指标 ----
  const fin2 = local.getFinanceResults('2026-11'); // 该周期无 FAC 结果，也无本地指标
  assert.equal(fin2.data.length, 0);

  console.log('fac result regression checks passed');
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
});
