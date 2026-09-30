/**
 * 跨域经营判断回归测试（PAND-91 / AEOS M03）
 * 运行：node scripts/cross-domain-judgment.test.js
 *
 * 覆盖 AC：
 *  - 前置：≥2 个专业中心域产出结论；<2 个域输出「数据不足」
 *  - 场景 1：展示跨域判断结论 + 列出引用的各中心结论
 *  - 场景 2：不重算，展示值与中心输出值一致
 *  - 边界：某域数据缺失标注「该域数据缺失」，其余域仍可判断
 *  - 判定标准：抽样 ≥10 条、一致率 100%；差异须有口径说明；引用可列出且可追溯
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const rules = require(path.join(root, 'backend', 'lib', 'cross-domain-judgment'));
const demo = require(path.join(root, 'backend', 'lib', 'cross-domain-demo-data'));

const conclusions = demo.buildDemoConclusions('2026-09-30 12:00:00');
const periodConcls = p => conclusions.filter(c => c.period === p);

// ============ 前置条件：专业中心域范围 ============
assert.deepEqual(rules.DOMAINS.map(d => d.code), ['sales', 'production', 'finance', 'supply_chain'],
  '跨域专业中心范围必须是 销售/生产·交付/财务/供应链 四域');
assert.equal(rules.MIN_PARTICIPATING_DOMAINS, 2, '前置条件：至少 2 个专业中心域产出结论');

// ============ 场景 2：不重算，展示值 = 中心上报值 ============
const fin202608 = periodConcls('2026-08').find(c => c.center === 'finance');
const netProfit = fin202608.metrics.find(m => m.code === 'net_profit');
const naivePct = Number((((netProfit.actual - netProfit.target) / netProfit.target) * 100).toFixed(2));
assert.equal(naivePct, -5, '样例数据：净利润按 target/actual 反推应为 -5.00%');
assert.equal(netProfit.deviation_pct, -4.2, '样例数据：中心上报口径为 -4.20%');

const finView = rules.evaluateConclusion('finance', fin202608);
const netProfitView = finView.metrics.find(m => m.code === 'net_profit');
assert.equal(netProfitView.deviation_pct, -4.2, 'EBMS 必须原样引用中心上报值，不得按 target/actual 重算');
assert.equal(netProfitView.deviation_basis, 'center_reported');
assert.equal(netProfitView.recomputed, false);
assert.equal(netProfitView.actual, netProfit.actual, '展示值必须等于中心输出值');

// 中心未上报偏差率 → 保持空值，不补齐
const sc202608 = periodConcls('2026-08').find(c => c.center === 'supply_chain');
const invDays = rules.evaluateConclusion('supply_chain', sc202608).metrics.find(m => m.code === 'inventory_days');
assert.equal(invDays.deviation_available, false, '中心未上报偏差率时不得补齐');
assert.equal(invDays.deviation_pct, null);
assert.equal(invDays.deviation_basis, 'center_not_reported');
assert.equal(invDays.actual, 47, '未上报偏差的指标仍展示中心上报的实际值');
assert.equal(rules.isNegativeMetric(invDays), false, '未上报偏差率的指标不得被计为负向');

// ============ 场景 1（四域齐全）：结论 + 引用明细 ============
const j08 = rules.buildJudgment({ period: '2026-08', conclusions: periodConcls('2026-08'), generatedAt: '2026-09-30 12:00:00' });
assert.equal(j08.present_domains.length, 4);
assert.equal(j08.missing_domains.length, 0);
assert.equal(j08.reference_count, 4, '四域齐全时引用明细应为 4 条');
assert.equal(j08.level, 'warning', '2026-08：销售 / 财务 两域负向 → 警示');
assert.equal(j08.level_label, '警示');
assert.deepEqual(j08.negative_domains, ['sales', 'finance']);
assert.equal(j08.computation_scope.recomputed, false, '判断输出必须声明不重算');
assert.equal(j08.computation_scope.basis, 'center_reported_values_only');
assert.match(j08.conclusion_text, /2026-08 跨域经营判断：警示/);

// 引用明细逐条可追溯：来源中心 / 结论时间 / 版本 / 快照 id
const refSales = j08.references.find(r => r.center === 'sales');
assert.equal(refSales.conclusion_id, 'M05-CONC-202608-001');
assert.equal(refSales.version, 'M05-SALES-V1');
assert.equal(refSales.as_of, '2026-09-03T09:20:00+08:00');
assert.equal(refSales.source_system, 'M05');
assert.equal(refSales.metric_codes.length, 4);
assert.equal(refSales.source_label, '销售 · 2026-09-03T09:20:00+08:00 · 版本 M05-SALES-V1');

// 来源不可用时必须是明确文案，不能为空
assert.equal(rules.buildSourceLabel(null), '来源不可用');
assert.equal(rules.buildSourceLabel({ center_label: '财务' }), '财务');

// 引用可追溯性核验
const index08 = {}; periodConcls('2026-08').forEach(c => { index08[c.center] = c; });
const trace08 = rules.verifyReferences(j08, index08);
assert.equal(trace08.all_resolved, true, '引用必须全部可回查中心快照');
assert.equal(trace08.reference_count, 4);
assert.deepEqual(trace08.unresolved_conclusion_ids, []);

// 快照被替换后引用应判定为不可追溯（核验不是空跑）
const tamperedIndex = Object.assign({}, index08, { sales: Object.assign({}, index08.sales, { conclusion_id: 'M05-CONC-OTHER' }) });
assert.equal(rules.verifyReferences(j08, tamperedIndex).all_resolved, false);

// ============ 边界：单域缺失不阻断其余域判断 ============
const j09 = rules.buildJudgment({ period: '2026-09', conclusions: periodConcls('2026-09'), generatedAt: '2026-09-30 12:00:00' });
assert.deepEqual(j09.present_domains, ['sales', 'production', 'finance']);
assert.deepEqual(j09.missing_domains, ['supply_chain']);
assert.equal(j09.reference_count, 3, '缺失域不得进入引用明细');
assert.equal(j09.references.some(r => r.center === 'supply_chain'), false);
assert.equal(j09.level, 'critical', '2026-09：销售/生产·交付/财务 三域负向 → 严重');

const missingSc = j09.missing_domain_details.find(d => d.center === 'supply_chain');
assert.equal(missingSc.missing_label, '该域数据缺失');
assert.equal(missingSc.missing_reason, 'no_conclusion');
assert.match(missingSc.missing_reason_label, /未上报结论/);
assert.equal(j09.domains.sales.available, true, '缺失域不影响其余域的判断输出');
assert.equal(j09.domains.sales.metrics.length, 4);
assert.match(j09.conclusion_text, /2026-09 跨域经营判断：严重/);

// 缺失原因细分：data_status=missing / 空指标
const missingByStatus = rules.evaluateConclusion('finance', { conclusion_id: 'X', data_status: 'missing', metrics: [{ code: 'a', actual: 1 }] });
assert.equal(missingByStatus.available, false);
assert.equal(missingByStatus.missing_reason, 'data_status_missing');
const emptyMetrics = rules.evaluateConclusion('finance', { conclusion_id: 'X', metrics: [] });
assert.equal(emptyMetrics.missing_reason, 'empty_metrics');
assert.equal(rules.evaluateConclusion('finance', null).missing_reason, 'no_conclusion');

// ============ 前置条件边界：参与域 < 2 → 数据不足 ============
const onlyOne = rules.buildJudgment({ period: '2026-09', conclusions: periodConcls('2026-09').filter(c => c.center === 'sales') });
assert.equal(onlyOne.level, 'insufficient_data');
assert.equal(onlyOne.level_label, '数据不足');
assert.match(onlyOne.conclusion_text, /数据不足/);
assert.equal(onlyOne.participating_count, 1);

const none = rules.buildJudgment({ period: '2026-10', conclusions: [] });
assert.equal(none.level, 'insufficient_data');
assert.equal(none.reference_count, 0);
assert.equal(none.missing_domains.length, 4);

assert.throws(() => rules.buildJudgment({ period: '2026/08', conclusions: [] }), /周期格式/);

// ============ 判定标准：抽样比对（中心输出值 vs EBMS 展示值） ============
const c08 = rules.sampleConsistency(j08, periodConcls('2026-08'));
assert.equal(c08.sample_size, 16, '2026-08 四域 × 4 指标 = 16 条比对');
assert.equal(c08.domains_covered.length, 4, '抽样必须覆盖全部参与域');
assert.equal(c08.matched, 16);
assert.equal(c08.unexplained_difference_count, 0);
assert.equal(c08.match_rate, 1);
assert.equal(c08.passed, true, '抽样 ≥10 条且一致率 100% → 判定成立');
assert.match(c08.conclusion, /判定成立/);

const c09 = rules.sampleConsistency(j09, periodConcls('2026-09'));
assert.equal(c09.sample_size, 12);
assert.equal(c09.passed, true);
assert.equal(c09.skipped_missing_domains.length, 1, '缺失域样本须以口径说明跳过');
assert.equal(c09.skipped_missing_domains[0].center, 'supply_chain');
assert.match(c09.skipped_missing_domains[0].explanation, /该域数据缺失/);
assert.match(c09.skipped_missing_domains[0].explanation, /未纳入一致率分母/);

// 差异必须可解释：构造一处 EBMS 展示值与中心输出值不一致 → 判定不成立
const tampered = JSON.parse(JSON.stringify(j08));
tampered.domains.finance.metrics.find(m => m.code === 'net_profit').actual = 999;
const cTampered = rules.sampleConsistency(tampered, periodConcls('2026-08'));
assert.equal(cTampered.mismatched, 1);
assert.equal(cTampered.unexplained_difference_count, 1, '未解释差异必须被计数，EBMS 不自动为差异背书');
assert.equal(cTampered.all_differences_explained, false);
assert.equal(cTampered.passed, false, '存在未解释差异时判定不成立，不得静默通过');
assert.match(cTampered.conclusion, /判定不成立/);
assert.match(cTampered.failures.join(' '), /未解释差异/);

// 差异登记了明确口径说明 → 视为已解释，判定成立
const cExplained = rules.sampleConsistency(tampered, periodConcls('2026-08'), {
  differenceExplanations: { 'finance|net_profit': '口径差异：中心按经营性口径上报，EBMS 展示其中心输出值' }
});
assert.equal(cExplained.mismatched, 1);
assert.equal(cExplained.explained_difference_count, 1);
assert.equal(cExplained.unexplained_difference_count, 0);
assert.equal(cExplained.all_differences_explained, true);
assert.equal(cExplained.passed, true, '差异有明确口径说明时判定成立');
assert.match(cExplained.conclusion, /差异已附口径说明/);

// 样本不足 10 条 → 判定不成立
const sparse = periodConcls('2026-08').map(c => Object.assign({}, c, { metrics: c.metrics.slice(0, 1) }));
const jSparse = rules.buildJudgment({ period: '2026-08', conclusions: sparse });
const cSparse = rules.sampleConsistency(jSparse, sparse);
assert.equal(cSparse.sample_size, 4);
assert.equal(cSparse.passed, false);
assert.match(cSparse.conclusion, /判定不成立/);
assert.match(cSparse.failures.join(' '), /少于要求的 10 条/);

// ============ 只汇聚不重算：EBMS 不读专业原始表 ============
const routeSource = fs.readFileSync(path.join(root, 'backend', 'routes', 'judgments.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'backend', 'routes', 'index.js'), 'utf8');
const libSource = fs.readFileSync(path.join(root, 'backend', 'lib', 'cross-domain-judgment.js'), 'utf8');
assert.match(indexSource, /router\.use\('\/judgments'/, '跨域判断路由必须挂载到 /api/judgments');
assert.match(routeSource, /ebms:judgment:view/, '读取判断须校验查看权限');
assert.match(routeSource, /ebms:judgment:manage/, '结论接入 / 判断生成须校验管理权限');
assert.equal(/getTable\('(orders|inquiries|materials|suppliers|production|finance)'\)/.test(routeSource), false,
  '跨域判断模块不得直读专业中心业务表（避免重算）');
assert.match(libSource, /deviation_available/, '未上报偏差必须显式标记口径');

// ============ 前端视图（AC 场景 1 / 边界） ============
const pageSource = fs.readFileSync(path.join(root, 'frontend', 'judgment.html'), 'utf8');
assert.match(pageSource, /该域数据缺失/, '缺失域须以「该域数据缺失」呈现');
assert.match(pageSource, /EBMS 展示值/, '抽样比对须展示 EBMS 展示值列');
assert.match(pageSource, /中心输出值/, '抽样比对须展示中心输出值列');
assert.match(pageSource, /口径/, '页面须展示不重算口径声明');
assert.match(pageSource, /引用明细/, '页面须列出引用的专业中心结论');

const dashboardSource = fs.readFileSync(path.join(root, 'frontend', 'dashboard.html'), 'utf8');
assert.match(dashboardSource, /judgment\.html/, '仪表盘须提供跨域经营判断入口');

console.log('cross-domain judgment regression checks passed');
