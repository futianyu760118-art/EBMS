/**
 * 产销协调会总报告生成回归测试（隔离数据目录）。
 * 运行：node scripts/sop-report-regression.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebms-sop-report-'));
process.env.EBMS_DATA_DIR = tempDir;
process.env.USE_JSON_DB = '1';

const { generateSopFullReport } = require('../backend/lib/sop-report-generator');
const sopSeed = require('../backend/sop-seed');
const { getTable } = require('../backend/db');

async function main() {
  // 灌 SOP 种子（PSI 2026-07 / KPI / 行动项等）
  sopSeed.run();

  // 加一条 EDP 库存落库数据（验证实际值出现）
  const h = getTable('psi_headers').all()[0];
  const lines = getTable('psi_lines').all().filter((l) => Number(l.header_id) === Number(h.id) && Number(l.month_offset) === 0);
  const l1 = lines[0];
  await getTable('psi_lines').update(l1.id, { inventory_actual: 5, production_actual: 10, color_status: 'R' });

  // 加一条会议助手行动项
  await getTable('sop_actions').insert({
    action_code: 'ACT-EDP-TEST1', description: '会议助手测试行动', owner_name: '张三',
    due_date: '2026-01-01', priority: 'P0', status: 'PENDING', source_system: '会议助手', escalation_level: 0
  });

  const md = generateSopFullReport();
  assert.ok(md && md.length > 1000, '报告应有实质内容');
  assert.match(md, /# 产销协调会总报告/, '应含总报告标题');
  assert.match(md, /## 一、总览/, '应含总览');
  assert.match(md, /## 二、PSI 产销存/, '应含 PSI 章节');
  assert.match(md, /## 三、KPI 仪表盘/, '应含 KPI 章节');
  assert.match(md, /## 六、行动项闭环/, '应含行动项章节');
  assert.match(md, /会议助手 = EDP meeting-assistant-actions 同步/, '应标注来源分布');
  assert.match(md, /ACT-EDP-TEST1/, '行动项逾期明细应含 EDP 行动');
  assert.match(md, /销售达成 \| 计划 /, '应含销售达成统计');

  console.log('sop report regression checks passed（报告 ' + md.length + ' 字符）');
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
});
