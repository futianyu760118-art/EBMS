/**
 * EBMS 数据接入层回归测试（隔离数据目录，不触碰生产 sales.db）。
 *
 * 覆盖：LocalProvider 取数、各系统结果映射、EDP 切换 fail-closed、系统 adapter 注册表。
 * 运行：node scripts/data-provider-regression.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebms-dataprovider-'));
process.env.EBMS_DATA_DIR = tempDir;
process.env.USE_JSON_DB = '1';
process.env.EBMS_DATA_PROVIDER = 'local';

const { getTable } = require('../backend/db');
const contracts = require('../backend/lib/data-provider/contracts');
const local = require('../backend/lib/data-provider/local-provider');
const edp = require('../backend/lib/data-provider/edp-provider');

async function seed(table, records) {
  const t = getTable(table);
  for (const r of records) await t.insert(Object.assign({}, r));
  return t;
}

async function main() {
  // ---- 夹具：一个 2026-10 报告 + 指标 + 管理对象 ----
  const report = await seed('monthly_reports', [{
    period: '2026-10', title: '2026年10月月度经营报告', summary: 'test', report_date: '2026-11-05', status: 'published'
  }]);
  const reportId = report.all()[0].id;

  await seed('monthly_indicators', [
    { report_id: reportId, department: '财务', category: 'core', name: '开票销售额', target: '500万', actual: '177万', unit: '万元', status: 'yellow', sort_order: 1 },
    { report_id: reportId, department: '财务', category: 'core', name: '综合开票毛利率', target: '', actual: '14.4%', unit: '', status: 'red', sort_order: 2 },
    { report_id: reportId, department: '销售', category: 'core', name: '销售接单', target: '440万', actual: '280万', unit: '万元', status: 'yellow', sort_order: 3 },
    { report_id: reportId, department: '研发', category: 'dept', name: '项目准时率', target: '60%', actual: '40.9%', unit: '', status: 'red', sort_order: 4 }
  ]);
  await seed('monthly_dept_summary', [
    { report_id: reportId, department: '财务', indicator_count: 5, achieved: '开票177万', not_achieved: '毛利14.4%', judgment: 'red', sort_order: 1 }
  ]);
  await seed('monthly_issues', [
    { report_id: reportId, level: 'P1', title: '现金流缺口', owner: '沈旭日', deadline: '立即', problem: 'x', actions: 'y', sort_order: 1 }
  ]);
  await seed('monthly_decisions', [
    { report_id: reportId, seq: 1, level: '🔴', title: 'Q4回款', owner: '沈旭日', deadline: '本会', problem: 'p', action: 'a', sort_order: 1 }
  ]);
  await seed('monthly_actions', [
    { report_id: reportId, seq: 1, content: '完成立项书', owner: '沈旭日', due_date: '10-09', new_due_date: '09-30', status: 'transferred', sort_order: 1 }
  ]);

  // ---- 系统 adapter 注册表：覆盖 M01~M14 ----
  const modules = contracts.SYSTEM_ADAPTERS.map(a => a.module);
  for (const m of ['M01', 'M02', 'M04', 'M05', 'M06', 'M08', 'M09', 'M10', 'M13', 'M14']) {
    assert.ok(modules.includes(m), '注册表应包含 ' + m);
  }
  assert.equal(contracts.getSystemAdapter('M09_FAC').system_id, 'M09_FAC');
  assert.equal(contracts.getSystemAdapter('M05').system_id, 'M05_CRM');
  assert.equal(contracts.PROVIDER_CONTRACT.getFinanceResults.owner, 'M09_FAC');

  // ---- LocalProvider：管理对象 ----
  const indicators = local.getIndicators('2026-10');
  assert.equal(indicators.source, 'local');
  assert.equal(indicators.data.length, 4);
  assert.equal(indicators.data.filter(i => i.department === '财务').length, 2);

  const dept = local.getDeptSummary('2026-10');
  assert.equal(dept.data.length, 1);
  assert.equal(dept.data[0].judgment, 'red');

  const exceptions = local.getExceptions('2026-10');
  assert.equal(exceptions.data.length, 1);
  assert.equal(exceptions.owner, 'M03_EBMS');
  assert.equal(exceptions.contract, 'aeos-contracts-v1');

  assert.equal(local.getDecisions('2026-10').data.length, 1);
  assert.equal(local.getActions('2026-10').data.length, 1);

  // ---- LocalProvider：各系统专业结果映射 ----
  const fin = local.getFinanceResults('2026-10');
  assert.equal(fin.owner, 'M09_FAC');
  assert.equal(fin.contract, 'finance-result-v1');
  assert.equal(fin.status, 'available');
  assert.equal(fin.data.length, 2, '财务指标应映射为 FinanceResult');

  const sales = local.getSalesResults('2026-10');
  assert.equal(sales.owner, 'M05_CRM');
  assert.equal(sales.data.length, 1);

  const rd = local.getRdResults('2026-10');
  assert.equal(rd.owner, 'M04_PLM');
  assert.equal(rd.data.length, 1);

  // 未接入的专业系统：本地无该部门指标 → not_connected
  const delivery = local.getDeliveryResults('2026-10');
  assert.equal(delivery.owner, 'M06_SPC');
  assert.equal(delivery.status, 'not_connected', '本地无交付指标应返回 not_connected');

  // ---- EdpProvider：未配置 EDP → fail-closed not_connected ----
  delete process.env.EBMS_EDP_URL;
  const edpFin = await edp.getFinanceResults('2026-10');
  assert.equal(edpFin.source, 'edp');
  assert.equal(edpFin.status, 'not_connected', '未配置 EBMS_EDP_URL 应 fail-closed 返回 not_connected');

  console.log('data provider regression checks passed');
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
});
