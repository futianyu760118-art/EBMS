/**
 * PAND-87 / F9「Decision 视图记录决策背景、候选方案、所需证据与决策结论」回归测试
 * 运行： node scripts/decision-view-regression.test.js
 *
 * 覆盖 AC：
 *   前置条件 存在至少 1 条决策记录（创建路径可产出记录）
 *   场景 1  每条含 背景（关联结果/原因）/ 候选方案（≥1）/ 所需 Evidence / 决策结论 / 决策人 / 决策时间
 *   场景 2  决策结论不可静默修改；修改须留痕（变更人 / 时间 / 变更前后值）
 *   场景 3  决策可关联其执行产生的 TODO，并可回看执行结果
 *   边界    未形成结论为「待决策」，不计入已决策数量；不强制做决策效果评价
 *   判定    已决策条目 决策人/决策时间 非空；变更记录条数 ≥ 实际修改次数；未形成结论均标记「待决策」
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const rules = require(path.join(root, 'backend', 'lib', 'decision-rules'));

// ===== 契约与枚举 =====
assert.equal(rules.CONTRACT_VERSION, 'AEOS.Decision.V1', '决策本体须对齐 AEOS.Decision.V1 契约');
assert.equal(rules.ACTION_CONTRACT_VERSION, 'AEOS.Action.V1', '执行项须对齐 AEOS.Action.V1 契约');
assert.deepEqual([...rules.STATUSES], ['pending', 'decided'], '状态取值只有 待决策 / 已决策 两种');
assert.equal(rules.STATUS_LABELS.pending, '待决策', 'pending 必须标记为「待决策」');
assert.equal(rules.STATUS_LABELS.decided, '已决策', 'decided 必须标记为「已决策」');
assert.deepEqual([...rules.BACKGROUND_REF_TYPES], ['result', 'reason'], '背景关联类型为 结果 / 原因');
assert.equal(rules.DEFAULT_PAGE_SIZE, 20, '默认单页 20 条');
assert.equal(rules.parsePageSize('50'), 50, '单页条数可配置');
assert.equal(rules.parsePageSize('9999'), rules.MAX_PAGE_SIZE, '单页条数超上限应收敛');

// ===== 场景 1：字段齐备 =====
const created = rules.normalizeDecision({
  title: '9 月毛利下滑归因与对策',
  summary: '毛利率环比下降 3.2pct，需确定主因与对策',
  background: [
    { type: 'result', code: 'gross_margin', label: '毛利率' },
    { type: 'reason', code: 'MATERIAL_COST', label: '材料成本上升' }
  ],
  options: [
    { name: '方案A：集中采购议价', description: '与 Top5 供应商重谈', pros: '见效快', cons: '依赖供应商配合', selected: true },
    { name: '方案B：替代料切换', description: '引入第二供应商', pros: '成本更优', cons: '需重新验证' }
  ],
  required_evidence: ['EVD202609-0001', { evidence_code: 'EVD202609-0002', title: '供应商报价单' }]
});
assert.equal(created.error, undefined, '合法决策应通过归一化');
const rec = created.record;
assert.equal(rec.contract_version, rules.CONTRACT_VERSION, '应写入 AEOS 契约版本');
assert.equal(rec.status, rules.STATUS_PENDING, '创建即「待决策」');
assert.equal(rec.conclusion, '', '未形成结论时结论必须为空');
assert.equal(rec.decided_by, '', '未形成结论时决策人必须为空');
assert.equal(rec.decided_at, '', '未形成结论时决策时间必须为空');
assert.equal(rec.background.length, 2, '背景须含 结果 / 原因 两类关联');
assert.equal(rec.background[0].type_label, '结果', '背景关联应带类型标签');
assert.equal(rec.options.length, 2, '候选方案须齐备');
assert.ok(rec.options.some(o => o.selected), '候选方案应可标记采纳项');
assert.equal(rec.required_evidence.length, 2, '所需证据须齐备（支持字符串与对象两种入参）');
assert.equal(rec.required_evidence[1].title, '供应商报价单', '所需证据应保留标题');

// 背景必填、类型受限
assert.ok(rules.normalizeDecision({ title: 'T', options: [{ name: 'A' }] }).error, '背景缺失必须被拒绝');
assert.ok(/关联类型/.test(rules.normalizeDecision({
  title: 'T', background: [{ type: 'source', code: 'x' }], options: [{ name: 'A' }]
}).error), '背景关联类型超出 result/reason 必须被拒绝');
assert.ok(/缺少关联编码/.test(rules.normalizeDecision({
  title: 'T', background: [{ type: 'result', code: '' }], options: [{ name: 'A' }]
}).error), '背景关联缺编码必须被拒绝');

// 候选方案 ≥1 且每项须有名称
assert.ok(/至少 1 条/.test(rules.normalizeDecision({
  title: 'T', background: [{ type: 'result', code: 'r' }], options: []
}).error), '候选方案为空必须被拒绝');
assert.ok(/方案名称/.test(rules.normalizeDecision({
  title: 'T', background: [{ type: 'result', code: 'r' }], options: [{ description: 'x' }]
}).error), '候选方案缺名称必须被拒绝');
assert.ok(/至多 1 条/.test(rules.normalizeDecision({
  title: 'T', background: [{ type: 'result', code: 'r' }],
  options: [{ name: 'A', selected: true }, { name: 'B', selected: true }]
}).error), '采纳方案至多 1 条');

// 所需证据允许为空：字段存在但为空 = 「本决策无需外部证据」，不算缺失
const noEvidence = rules.normalizeDecision({
  title: 'T', background: [{ type: 'result', code: 'r' }], options: [{ name: 'A' }]
});
assert.equal(noEvidence.error, undefined);
assert.deepEqual(noEvidence.record.required_evidence, [], '所需证据允许为空数组');

assert.ok(/标题必填/.test(rules.normalizeDecision({ background: [{ type: 'result', code: 'r' }], options: [{ name: 'A' }] }).error), '决策标题必填');

// ===== 场景 2：结论不可静默修改 + 留痕 =====
let decision = Object.assign({}, rec, { id: 1, decision_code: 'DEC202609-0001' });
const AT1 = '2026-09-30 10:00:00';
const AT2 = '2026-09-30 11:00:00';
const AT3 = '2026-09-30 12:00:00';

// 首次形成结论：不要求理由
const first = rules.applyConclusion(decision, { conclusion: '采纳方案A，集中采购议价' }, { id: '7', name: '陈经理（销售经理）' }, AT1);
assert.equal(first.error, undefined, '首次形成结论不应要求理由');
assert.equal(first.patch.status, rules.STATUS_DECIDED, '形成结论后状态转为已决策');
assert.equal(first.patch.decided_by, '陈经理（销售经理）', '决策人默认取当前操作者');
assert.equal(first.patch.decided_at, AT1, '决策时间默认取本次操作时间');
assert.equal(first.change.before_value, '', '首次形成结论的变更前值为空');
assert.equal(first.change.after_value, '采纳方案A，集中采购议价', '变更后值为新结论');
assert.equal(first.change.changed_by, '陈经理（销售经理）', '留痕须记录变更人');
assert.equal(first.change.changed_at, AT1, '留痕须记录变更时间');
decision = Object.assign({}, decision, first.patch);

// 修改：未填理由 → 拒绝（不可静默修改）
const silent = rules.applyConclusion(decision, { conclusion: '改为方案B：替代料切换' }, { id: '7', name: '陈经理' }, AT2);
assert.ok(silent.error && /不可静默修改/.test(silent.error), '修改已形成结论未填理由必须被拒绝');
assert.equal(silent.status, 400, '静默修改应返回 400');

// 修改：结论无变化 → 422，且不产生变更记录
const same = rules.applyConclusion(decision, { conclusion: decision.conclusion, reason: '补充说明' }, { id: '7', name: '陈经理' }, AT2);
assert.equal(same.status, 422, '结论无变化应返回 422');
assert.ok(!same.change, '结论无变化不得产生变更记录，避免虚增条数');

// 修改：带理由 → 成功，且留痕含变更前后值
const modified = rules.applyConclusion(decision, { conclusion: '改为方案B：替代料切换', reason: '供应商不接受议价' }, { id: '9', name: '周财务' }, AT3);
assert.equal(modified.error, undefined, '带理由的修改应通过');
assert.equal(modified.change.before_value, '采纳方案A，集中采购议价', '留痕须含变更前值');
assert.equal(modified.change.after_value, '改为方案B：替代料切换', '留痕须含变更后值');
assert.equal(modified.change.reason, '供应商不接受议价', '留痕须含变更理由');
assert.equal(modified.change.changed_by, '周财务', '留痕的变更人为实际操作者');
assert.equal(modified.patch.decided_by, '周财务', '改结论后决策人更新为本次决策人');
decision = Object.assign({}, decision, modified.patch);

// 判定：变更记录条数 ≥ 实际修改次数（2 次成功修改 → 2 条留痕，无变化不落记录）
const changes = [first.change, modified.change];
assert.equal(rules.conclusionChangeCount(changes), 2, '结论类变更条数应等于实际修改次数');

// 前后值排序：按写入序号（同一毫秒内多条变更也能定序）
assert.deepEqual(
  rules.sortChanges([{ seq: 2, change_type: 'conclusion' }, { seq: 1, change_type: 'todo_linked' }]).map(c => c.seq),
  [1, 2], '变更历史须按实际发生次序展示'
);

// 判定：已决策条目 决策人、决策时间 均非空
assert.equal(rules.assertDecidedInvariant(decision), null, '已决策条目决策人/决策时间非空应通过自检');
assert.ok(/必须同时具备/.test(rules.assertDecidedInvariant({ status: 'decided', conclusion: 'x', decided_by: '', decided_at: 't' })),
  '已决策但缺决策人必须被自检拦下');
assert.ok(/待决策记录不应带/.test(rules.assertDecidedInvariant({ status: 'pending', conclusion: 'x', decided_by: '', decided_at: '' })),
  '待决策却带结论必须被自检拦下');
assert.ok(/状态取值非法/.test(rules.assertDecidedInvariant({ status: 'draft' })), '状态取值只能是 pending/decided');

// ===== 边界：待决策不计入已决策数量 =====
const mixed = [
  { status: 'decided' }, { status: 'decided' },
  { status: 'pending' }, { status: 'pending' }, { status: 'pending' }
];
const counts = rules.countsByStatus(mixed);
assert.deepEqual(counts, { total: 5, decided: 2, pending: 3 }, '待决策不得计入已决策数量');
assert.deepEqual(rules.countsByStatus([]), { total: 0, decided: 0, pending: 0 }, '空数据应返回全 0');
assert.equal(rules.statusLabel('pending'), '待决策', '未形成结论的记录一律标记「待决策」');

// ===== 场景 3：关联执行 TODO + 回看结果 =====
const TODAY = '2026-09-30';
const execRows = [
  { id: 1, title: '重谈供应商价格', status: 'done', due_at: '2026-09-20', completed_at: '2026-09-19 16:00:00' },
  { id: 2, title: '引入第二供应商', status: 'doing', due_at: '2026-10-15' },
  { id: 3, title: '更新核价模板', status: 'todo', due_at: '2026-10-30' },
  { id: 4, title: '补充财务对账', status: 'todo', due_at: '2026-09-25' },
  { id: 5, title: '已取消的旧任务', status: 'cancelled', due_at: '2026-09-01' }
];
const d1 = rules.deriveExecutionStatus(execRows[0], TODAY);
assert.equal(d1.exec_status, 'done');
assert.equal(d1.exec_label, '已完成');
assert.equal(d1.overdue, false, '已完成项不得计为逾期');
const d3 = rules.deriveExecutionStatus(execRows[2], TODAY);
assert.equal(d3.exec_status, 'todo');
assert.equal(d3.exec_label, '待办');
assert.equal(rules.deriveExecutionStatus(execRows[1], TODAY).exec_status, 'doing');
const d4 = rules.deriveExecutionStatus(execRows[3], TODAY);
assert.equal(d4.exec_status, 'overdue', '未完成且已过截止时间应标记逾期');
assert.equal(d4.exec_label, '逾期');
assert.equal(rules.deriveExecutionStatus({ status: 'todo', due_at: '' }, TODAY).overdue, false, '无截止时间不得判逾期');

const sum = rules.executionSummary(execRows, TODAY);
assert.equal(sum.total, 5);
assert.equal(sum.done, 1);
assert.equal(sum.doing, 1);
assert.equal(sum.todo, 1, '未逾期待办计 1 条');
assert.equal(sum.overdue, 1, '逾期项单独统计');
assert.equal(sum.cancelled, 1);
assert.equal(sum.completion_rate, 25, '完成度 = 已完成 / (总数 − 已取消) = 1/4');
assert.deepEqual(rules.executionSummary([], TODAY).completion_rate, 0, '无执行项时完成度为 0，不抛错');

// ===== 编码 / 分页 / 筛选 =====
assert.equal(rules.genDecisionCode([], '2026-09'), 'DEC202609-0001', '空表生成 0001 流水号');
assert.equal(rules.genDecisionCode([{ decision_code: 'DEC202609-0003' }], '2026-09'), 'DEC202609-0004', '按同前缀最大流水号 +1');

const pageData = Array.from({ length: 45 }, (_, i) => ({ id: i + 1, status: i % 3 === 0 ? 'decided' : 'pending' }));
const p1 = rules.paginate(pageData, 1, 20);
assert.equal(p1.items.length, 20, '默认每页 20 条');
assert.equal(p1.total, 45, '总数与数据源匹配');
assert.equal(p1.pages, 3);
assert.deepEqual(rules.paginate([], 1, undefined).items, [], '空数据源返回空数组');

const filterRows = [
  { decision_code: 'DEC202609-0001', title: '毛利下滑对策', status: 'decided', decided_by: '陈经理',
    conclusion: '采纳方案A', created_at: '2026-09-10 09:00:00', decided_at: '2026-09-12 10:00:00',
    background: [{ type: 'result', code: 'gross_margin' }] },
  { decision_code: 'DEC202609-0002', title: '交付风险处置', status: 'pending', decided_by: '',
    conclusion: '', created_at: '2026-09-20 09:00:00', decided_at: '',
    background: [{ type: 'reason', code: 'DELIVERY_RISK' }] }
];
const hit = q => filterRows.filter(rules.buildFilter(q)).map(r => r.decision_code);
assert.equal(hit({}).length, 2, '无条件应返回全部');
assert.deepEqual(hit({ status: 'pending' }), ['DEC202609-0002'], '状态筛选应生效');
assert.deepEqual(hit({ status: 'decided' }), ['DEC202609-0001'], '状态筛选应生效（已决策）');
assert.deepEqual(hit({ status: 'draft' }), [], '状态取值非法时不得命中');
assert.deepEqual(hit({ decided_by: '陈经理' }), ['DEC202609-0001'], '决策人筛选应生效');
assert.deepEqual(hit({ background_code: 'DELIVERY_RISK' }), ['DEC202609-0002'], '按背景编码筛选应生效');
assert.deepEqual(hit({ created_from: '2026-09-15' }), ['DEC202609-0002'], '创建时间范围应生效');
assert.deepEqual(hit({ decided_from: '2026-09-01', decided_to: '2026-09-30' }), ['DEC202609-0001'], '决策时间范围应生效');
assert.deepEqual(hit({ keyword: '毛利' }), ['DEC202609-0001'], '关键字应匹配标题');
assert.deepEqual(hit({ keyword: 'gross_margin' }), ['DEC202609-0001'], '关键字应匹配背景关联编码');

// ===== 接入契约：路由挂载 + 权限码 + 写操作 await =====
const indexSource = fs.readFileSync(path.join(root, 'backend', 'routes', 'index.js'), 'utf8');
assert.match(indexSource, /router\.use\('\/decisions'/, 'Decision 路由必须挂载到 /decisions');
assert.match(indexSource, /M03 EBMS/, 'Decision 路由应标注 M03 EBMS 目标模块');

const routeSource = fs.readFileSync(path.join(root, 'backend', 'routes', 'decision.js'), 'utf8');
['decision:view', 'decision:create', 'decision:edit', 'decision:delete'].forEach(code => {
  assert.ok(routeSource.includes("'" + code + "'"), '路由应使用权限码 ' + code);
});
// /refs 与 /todo-candidates 必须先于 /:id 注册，否则会被详情路由吞掉
assert.ok(routeSource.indexOf("'/refs'") < routeSource.indexOf("'/:id'"), '/refs 必须先于 /:id 注册');
assert.ok(routeSource.indexOf("'/todo-candidates'") < routeSource.indexOf("'/:id'"), '/todo-candidates 必须先于 /:id 注册');
// 结论修改与执行项关联是写路由，必须 await 表写操作
assert.match(routeSource, /router\.patch\('\/:id\/conclusion',\s*requirePerm\('decision:edit'\),\s*async/, '结论路由必须为 async');
assert.match(routeSource, /router\.post\('\/:id\/execution-todos',\s*requirePerm\('decision:edit'\),\s*async/, '关联执行项路由必须为 async');
// 结论更新与留痕在同一提交函数内，留痕写入失败必须回滚结论
assert.match(routeSource, /commitConclusion/, '结论更新与留痕必须封装在同一提交路径');
assert.match(routeSource, /已回滚结论/, '留痕写入失败必须回滚结论，保证「改了结论却没有变更记录」不存在');

// ===== 前端页面 =====
const pageSource = fs.readFileSync(path.join(root, 'frontend', 'decision.html'), 'utf8');
assert.match(pageSource, /data-page-perm="decision:view"/, '页面应受 decision:view 准入控制');
assert.match(pageSource, /DEFAULT_PAGE_SIZE=20/, '前端默认单页应为 20');
assert.match(pageSource, /pageSizeSel/, '前端应提供单页条数配置入口');
assert.match(pageSource, /没有匹配的决策/, '无结果时应显示空态文案');
assert.match(pageSource, /条件已保留在筛选区/, '空态应说明检索条件被保留');
assert.ok(!/if\(!d\.data\|\|!d\.data\.length\)\{[^}]*resetFilter/.test(pageSource), '空态不得重置检索条件');
assert.match(pageSource, /待决策/, '前端应展示「待决策」口径');
assert.match(pageSource, /已决策/, '前端应展示「已决策」口径');
// 场景 2：修改已形成结论未填理由时保存按钮禁用
assert.match(pageSource, /btn\.disabled=/, '结论保存按钮应可被禁用');
assert.match(pageSource, /conclNeedsReason\(\)&&!reason/, '未填变更理由时必须禁用保存按钮');
assert.match(pageSource, /结论未变化/, '结论无变化时应提示且不提交');
// 场景 3：关联 / 派发执行项与回看
assert.match(pageSource, /execution-todos/, '页面应调用执行项关联接口');
assert.match(pageSource, /todo-candidates/, '页面应拉取可关联执行项候选');
assert.match(pageSource, /执行情况（关联 TODO）/, '详情应回看执行情况');

const navSource = fs.readFileSync(path.join(root, 'frontend', 'permission-check.js'), 'utf8');
assert.match(navSource, /href: 'decision\.html'.*decision:view/, 'Decision 视图应登记到侧边栏');

const permPage = fs.readFileSync(path.join(root, 'frontend', 'permission.html'), 'utf8');
assert.ok(/Decision 视图.*decision:view/.test(permPage), '权限管理页应登记 Decision 视图权限项');

const initSource = fs.readFileSync(path.join(root, 'backend', 'initData.js'), 'utf8');
['decision:view', 'decision:create', 'decision:edit', 'decision:delete'].forEach(code => {
  assert.ok(initSource.includes("'" + code + "'"), '权限种子应包含 ' + code);
});
assert.match(initSource, /decisionRolePerms/, '应有 Decision 视图的角色权限补充（增量，兼容已部署库）');

console.log('decision-view-regression: all assertions passed');
