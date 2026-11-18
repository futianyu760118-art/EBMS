/**
 * 产销协调会 EDP 数据更新回归测试（隔离数据目录）。
 * 运行：node scripts/sop-edp-sync-regression.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebms-sop-edp-'));
process.env.EBMS_DATA_DIR = tempDir;
process.env.USE_JSON_DB = '1';

const { getTable } = require('../backend/db');
const sopSync = require('../backend/lib/sop-edp-sync');

async function seed(table, records) {
  const t = getTable(table);
  for (const r of records) await t.insert(Object.assign({}, r));
  return t;
}

async function main() {
  // ---- 夹具：PSI（2026-10，3 产品当期行）+ EDP 落库数据 ----
  const h = await seed('psi_headers', [
    { psi_code: 'PSI-202610-001', sales_type: '内销', period_month: '2026-10', version_no: 1, status: 'CONFIRMED', is_rolled: 0, created_by: 1 }
  ]);
  const headerId = h.all()[0].id;
  const lineT = await seed('psi_lines', [
    { header_id: headerId, product_code: 'JFS01B-B1WA10', month_offset: 0, inventory_begin: 1200, sales_plan: 1000, production_plan: 950, inventory_end: 1150, safety_stock: 300, color_status: 'G', is_editable: 0 },
    { header_id: headerId, product_code: 'JFS03-B1WB20', month_offset: 0, inventory_begin: 800, sales_plan: 900, production_plan: 950, inventory_end: 850, safety_stock: 250, color_status: 'G', is_editable: 0 },
    { header_id: headerId, product_code: 'JFS04-B1WB50', month_offset: 0, inventory_begin: 500, sales_plan: 400, production_plan: 450, inventory_end: 550, safety_stock: 200, color_status: 'G', is_editable: 0 }
  ]);

  // EDP 落库数据（edp_dataset_row）：订单/生产/库存/会议行动
  const rowT = await seed('edp_dataset_row', []);
  const addRow = (code, pk, payload) => rowT.insert({ dataset_code: code, row_pk: pk, payload: JSON.stringify(payload), dataset_version: 1, synced_at: 'x' });
  await addRow('ads-order-list', 'o1', { product_code: '2.1.JFS01B-B1WA10', order_date: '2026-10-05', order_qty: '880' });   // 层级前缀匹配
  await addRow('ads-order-list', 'o2', { product_code: 'JFS03-B1WB20', order_date: '2026-09-28', order_qty: '999' });        // 非 10 月不计
  await addRow('ads-production-task-view', 't1', { material_code: '2.3.1.JFS01B-B1WA10', planned_start_date: '2026-10-12', task_qty: '920' });
  await addRow('ads-production-task-view', 't2', { material_code: 'JFS04-B1WB50', planned_start_date: '2026-10-20', task_qty: '460' });
  await addRow('ads-inventory-view', 'i1', { material_code: '2.6.1.JFS01B-B1WA10', qty_on_hand: '320' });  // 320 ∈ [300, 360) → Y
  await addRow('ads-inventory-view', 'i2', { material_code: 'JFS04-B1WB50', qty_on_hand: '90' });          // 90 < 200 → R

  // 会议助手行动项
  await addRow('meeting-assistant-actions', 'ACT_A', { id: 'ACT_A', theme: '采购齐套率提升至70%', owner: '沈建凯', status: 'in_progress', due_date: '2026-11-15', priority: 'high' });
  await addRow('meeting-assistant-actions', 'ACT_B', { id: 'ACT_B', theme: '客诉24h及时率制度重建', owner: '李玉英', status: 'done', due_date: '2026-11-10', priority: 'medium' });

  // ---- PSI 实际值更新 ----
  const psi = await sopSync.syncPsiFromEdp('2026-10');
  assert.equal(psi.ok, true);
  assert.equal(psi.period, '2026-10');
  assert.equal(psi.updated, 2, 'JFS01/JFS04 应匹配到 EDP 数据；JFS03 只有 9 月订单（非当期）→ 不匹配');
  assert.equal(psi.unmatched, 1);
  const lines = lineT.all().filter((l) => Number(l.header_id) === headerId && Number(l.month_offset) === 0).sort((a, b) => (a.product_code || '').localeCompare(b.product_code || ''));
  const l1 = lines.find((l) => l.product_code === 'JFS01B-B1WA10');
  const l3 = lines.find((l) => l.product_code === 'JFS04-B1WB50');
  assert.equal(l1.sales_actual, 880, '层级前缀编码应匹配（销售实际 880）');
  assert.equal(l1.production_actual, 920);
  assert.equal(l1.inventory_actual, 320);
  assert.equal(l1.color_status, 'Y', '库存 320 ∈ [安全库存300, 300×1.2) → 黄');
  assert.equal(l1.sales_plan, 1000, '计划值不得被覆盖（GR-15 计划/实际分离）');
  assert.equal(l3.inventory_actual, 90);
  assert.equal(l3.color_status, 'R', '库存 90 < 安全库存 200 → 红');

  // ---- 幂等：重复同步不重复改值 ----
  const psi2 = await sopSync.syncPsiFromEdp('2026-10');
  assert.equal(psi2.updated, 2);

  // ---- 行动项同步 ----
  const acts = await sopSync.syncActionsFromEdp();
  assert.equal(acts.created, 2, '应创建 2 条 SOP 行动');
  const actTable = getTable('sop_actions');
  const a1 = actTable.all().find((a) => a.action_code === 'ACT-EDP-ACT_A');
  const a2 = actTable.all().find((a) => a.action_code === 'ACT-EDP-ACT_B');
  assert.ok(a1, 'ACT_A 已创建');
  assert.equal(a1.status, 'IN_PROGRESS');
  assert.equal(a1.owner_name, '沈建凯');
  assert.equal(a1.source_system, '会议助手');
  assert.equal(a2.status, 'CLOSED', 'done 应映射为 CLOSED');

  // ---- 行动项幂等：状态变化才更新 ----
  const acts2 = await sopSync.syncActionsFromEdp();
  assert.equal(acts2.created, 0, '重复同步不得重复创建');
  assert.equal(acts2.updated, 0, '状态未变化不更新');

  console.log('sop edp sync regression checks passed');
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
});
