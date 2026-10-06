'use strict';

// PAND-85（F7 REPORT 视图）AC 逐条验证。
// 运行：npm test（需 PostgreSQL 可连，见 .env；测试库会被重置为夹具数据）
//
// AC 原文：
//   前置条件：系统中存在至少 1 份 Report。
//   场景 1：登录后到达任一份 Report 的点击次数 ≤ 1。
//   场景 2：每份 Report 含 结论、关键结果指标、偏差，以及关联的 TODO / Decision / Evidence 入口。
//   场景 3：Report 可按周期与责任域筛选。
//   边界  ：无 Report 时显示空态与创建入口。
//   判定标准：≤1 click；Report 内 TODO / Decision / Evidence 三类关联入口均存在；
//            按周期、责任域筛选均生效。

const test = require('node:test');
const assert = require('node:assert/strict');

const { migrate } = require('../src/db/migrate');
const { seed, IDS, REPORT_FIXTURES } = require('../src/db/seed');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { PERIOD_TYPES } = require('../src/domain/results/result-sources');
const { REPORT_DOMAINS } = require('../src/domain/reports/report-domains');
const { ENTRY_TYPES } = require('../src/domain/reports/report-service');

// 三类关联入口的固定顺序（与 view-object-types 的 otherViewObjectTypes(report) 一致）
const REQUIRED_ENTRY_TYPES = ['todo', 'decision', 'evidence'];
const NO_LINK_HINT = '无关联';

let baseUrl;
let server;
let token;

async function api(pathname, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function listReports(query = '') {
  const { status, json } = await api(`/reports${query}`);
  assert.equal(status, 200, `GET /reports${query} 应为 200`);
  assert.equal(json.ok, true);
  return json.data;
}

async function getReport(id) {
  const { status, json } = await api(`/reports/${id}`);
  assert.equal(status, 200);
  return json.data;
}

function reportByKey(data, key) {
  const id = IDS.reports[key];
  const found = data.items.find((item) => item.id === id);
  assert.ok(found, `清单中应包含报告 ${key}（${id}）`);
  return found;
}

function metricByCode(report, code) {
  return report.keyMetrics.find((m) => m.code === code);
}

function entryByType(report, type) {
  const entry = report.entries.find((e) => e.targetType === type);
  assert.ok(entry, `报告应含 ${type} 入口`);
  return entry;
}

test.before(async () => {
  await migrate();
  await seed();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  // AC 主体是「决策者登录后即可到达报告」→ 以决策者身份走查
  const login = await fetch(`${baseUrl}/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'decider' }),
  });
  token = (await login.json()).data.token;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ------------------------------------------------------------------ 前置条件

test('前置条件：系统中存在至少 1 份 Report', async () => {
  const data = await listReports();
  assert.ok(data.total >= 1, '应至少存在 1 份报告');
  assert.equal(data.items.length, REPORT_FIXTURES.length);
});

// ------------------------------------------------------------------ 场景 1 / 判定标准：≤1 click

test('场景 1：报告清单即落地视图，每份报告自带一次点击可达的落点', async () => {
  const data = await listReports();

  for (const item of data.items) {
    // 落地视图上的每一张卡片都直接携带落点：清单 → 详情 = 1 次点击
    assert.equal(item.landingHref, `/report/${item.id}`);

    // 落点确实是可解析的（不需要再经过任何中间层级）
    const detail = await getReport(item.id);
    assert.equal(detail.report.id, item.id);
    assert.equal(detail.report.landingHref, item.landingHref);
  }
});

test('场景 1：清单在筛选条件下同样保持 1 次点击可达（筛选不新增层级）', async () => {
  const data = await listReports('?period_type=month&period_value=2026-09&domain=delivery');
  assert.equal(data.items.length, 1);
  const [item] = data.items;
  assert.equal(item.landingHref, `/report/${IDS.reports.linked}`);
  const detail = await getReport(item.id);
  assert.equal(detail.report.code, 'RPT-2026-09-01');
});

// ------------------------------------------------------------------ 场景 2：结论 + 关键指标 + 偏差 + 三类入口

test('场景 2：每份 Report 都含结论（结论是 REPORT 的组织单位）', async () => {
  const data = await listReports();
  for (const item of data.items) {
    assert.equal(typeof item.conclusion, 'string');
    assert.ok(item.conclusion.trim().length > 0, `报告 ${item.code} 的结论不能为空`);
  }
});

test('场景 2：报告含关键结果指标，且每条给出 目标值 / 实际值 / 偏差', async () => {
  const data = await listReports();
  const report = reportByKey(data, 'linked');

  assert.equal(report.keyMetrics.length, 2);

  const delivery = metricByCode(report, 'order_delivery');
  assert.equal(delivery.targetValue, 100.0);
  assert.equal(delivery.actualValue, 87.0);
  assert.equal(delivery.hasData, true);
  assert.equal(delivery.deviation.computable, true);
  assert.equal(delivery.deviation.formula, '实际值 − 目标值');
  assert.equal(delivery.deviation.value, -13);
  assert.equal(delivery.deviation.pct, -13);
  assert.equal(delivery.deviation.attainment, 'MISSED');
  assert.equal(delivery.exceeded, true, '偏差率 13% 超过 5% 阈值 → 视为异常');

  const capacity = metricByCode(report, 'capacity_utilization');
  assert.equal(capacity.actualValue, 88.0);
  assert.equal(capacity.deviation.value, -2);
  assert.equal(capacity.exceeded, false, '偏差率 2.22% 在 5% 阈值内');
});

test('场景 2：越低越好的指标按方向判定达标与偏差（方向不写反）', async () => {
  const detail = await getReport(IDS.reports.financeAug);
  const arBalance = metricByCode(detail, 'ar_balance');

  assert.equal(arBalance.deviation.direction, 'lower_better');
  assert.equal(arBalance.targetValue, 3200);
  assert.equal(arBalance.actualValue, 3520);
  assert.equal(arBalance.deviation.value, 320);
  assert.equal(arBalance.deviation.pct, 10);
  assert.equal(arBalance.deviation.attainment, 'MISSED');
  assert.equal(arBalance.exceeded, true);
});

test('场景 2：关键指标无实际值时不伪造数值，偏差标记为不可计算', async () => {
  const detail = await getReport(IDS.reports.orphan);
  const newCustomer = metricByCode(detail, 'new_customer_count');

  assert.equal(newCustomer.hasData, false);
  assert.equal(newCustomer.actualValue, null, '无数据不得退化为 0');
  assert.equal(newCustomer.deviation.computable, false);
  assert.equal(newCustomer.deviation.value, null);
  assert.equal(newCustomer.noDataReason, '来源模块未同步本期数据');
});

test('场景 2：报告详情含 TODO / Decision / Evidence 三类入口，且带可点击落点', async () => {
  const detail = await getReport(IDS.reports.linked);

  assert.deepEqual(
    detail.entries.map((e) => e.targetType),
    REQUIRED_ENTRY_TYPES
  );
  assert.equal(detail.entryTotal, 3);

  const todo = entryByType(detail, 'todo');
  assert.equal(todo.disabled, false);
  assert.equal(todo.hint, null);
  assert.equal(todo.count, 1);
  assert.equal(todo.links[0].id, IDS.todos.linked);
  assert.equal(todo.links[0].href, `/todo/${IDS.todos.linked}`);

  const decision = entryByType(detail, 'decision');
  assert.equal(decision.count, 1);
  assert.equal(decision.links[0].href, `/decision/${IDS.decisions.linked}`);

  const evidence = entryByType(detail, 'evidence');
  assert.equal(evidence.count, 1);
  assert.equal(evidence.links[0].href, `/evidence/${IDS.evidences.contract}`);
});

// ------------------------------------------------------------------ 判定标准：三类入口「均存在」

test('判定标准：三类入口在每份报告上都存在（无关联也占位，不因缺关联而消失）', async () => {
  const data = await listReports();
  for (const item of data.items) {
    assert.deepEqual(
      item.entries.map((e) => e.targetType),
      REQUIRED_ENTRY_TYPES,
      `报告 ${item.code} 应固定含三类入口`
    );
    for (const entry of item.entries) {
      assert.equal(typeof entry.label, 'string');
      assert.ok(entry.label.length > 0);
      assert.ok(entry.landingPath.startsWith('/'), '入口应指明落点路由');
    }
  }
  assert.deepEqual(ENTRY_TYPES, REQUIRED_ENTRY_TYPES);
});

test('边界：无关联报告的三个入口均置灰并提示「无关联」', async () => {
  const data = await listReports();
  const orphan = reportByKey(data, 'orphan');

  for (const entry of orphan.entries) {
    assert.equal(entry.count, 0);
    assert.equal(entry.disabled, true);
    assert.equal(entry.hint, NO_LINK_HINT);
  }

  const detail = await getReport(IDS.reports.orphan);
  assert.equal(detail.entryTotal, 0);
  for (const entry of detail.entries) {
    assert.equal(entry.disabled, true);
    assert.equal(entry.hint, NO_LINK_HINT);
  }
});

test('边界：部分关联时逐入口判定（仅未关联的入口置灰）', async () => {
  const data = await listReports();
  const financeSep = reportByKey(data, 'financeSep');

  assert.equal(entryByType(financeSep, 'evidence').disabled, false);
  assert.equal(entryByType(financeSep, 'evidence').count, 1);
  assert.equal(entryByType(financeSep, 'todo').disabled, true);
  assert.equal(entryByType(financeSep, 'todo').hint, NO_LINK_HINT);
  assert.equal(entryByType(financeSep, 'decision').disabled, true);
  assert.equal(entryByType(financeSep, 'decision').hint, NO_LINK_HINT);
});

// ------------------------------------------------------------------ 场景 3：筛选

test('场景 3：按周期筛选生效（含筛选条件回显）', async () => {
  const sep = await listReports('?period_type=month&period_value=2026-09');
  assert.equal(sep.total, 3);
  assert.ok(sep.items.every((item) => item.periodValue === '2026-09'));
  assert.deepEqual(sep.filters, { periodType: 'month', periodValue: '2026-09', domain: null });

  const aug = await listReports('?period_type=month&period_value=2026-08');
  assert.equal(aug.total, 1);
  assert.equal(aug.items[0].id, IDS.reports.financeAug);
});

test('场景 3：按责任域筛选生效', async () => {
  const finance = await listReports('?domain=finance');
  assert.equal(finance.total, 2);
  assert.ok(finance.items.every((item) => item.domain.code === 'finance'));
  assert.ok(finance.items.every((item) => item.domain.label === '财务'));

  const delivery = await listReports('?domain=delivery');
  assert.equal(delivery.total, 1);
  assert.equal(delivery.items[0].id, IDS.reports.linked);

  const sales = await listReports('?domain=sales');
  assert.equal(sales.total, 1);
  assert.equal(sales.items[0].id, IDS.reports.orphan);
});

test('场景 3：周期与责任域为「与」关系，组合筛选同时生效', async () => {
  const hit = await listReports('?period_type=month&period_value=2026-08&domain=finance');
  assert.equal(hit.total, 1);
  assert.equal(hit.items[0].id, IDS.reports.financeAug);

  const miss = await listReports('?period_type=month&period_value=2026-08&domain=delivery');
  assert.equal(miss.total, 0);
  assert.equal(miss.empty, true);
  assert.deepEqual(miss.items, []);
});

test('场景 3：筛选参数非法时明确报错，而非静默返回全量', async () => {
  const incomplete = await api('/reports?period_type=month');
  assert.equal(incomplete.status, 400);
  assert.equal(incomplete.json.error.code, 'REPORT_PERIOD_INCOMPLETE');

  const invalidType = await api('/reports?period_type=quarter&period_value=2026-Q3');
  assert.equal(invalidType.status, 400);
  assert.equal(invalidType.json.error.code, 'REPORT_PERIOD_TYPE_INVALID');
  assert.deepEqual(invalidType.json.error.details.allowed, PERIOD_TYPES);
});

test('筛选栏取值来自责任域口径与已存在的报告周期', async () => {
  const { status, json } = await api('/report-filters');
  assert.equal(status, 200);

  assert.deepEqual(
    json.data.domains.map((d) => d.code),
    REPORT_DOMAINS.map((d) => d.code)
  );
  const periods = json.data.periods.map((p) => p.periodValue);
  assert.ok(periods.includes('2026-09'));
  assert.ok(periods.includes('2026-08'));
});

// ------------------------------------------------------------------ 边界：空态 + 创建入口

test('边界：无 Report 时返回空态（空集不是错误，前端据此渲染空态与创建入口）', async () => {
  const data = await listReports('?period_type=week&period_value=2026-W40');
  assert.equal(data.total, 0);
  assert.equal(data.empty, true);
  assert.deepEqual(data.items, []);
  assert.equal(data.limit, 50);
  assert.equal(data.offset, 0);
});

test('边界：创建入口可创建报告，并产生留痕', async () => {
  const { status, json } = await api('/reports', {
    method: 'POST',
    body: {
      code: 'RPT-2026-08-02',
      title: '8月财务月报：现金流专项',
      conclusion: '现金流达成目标，应收余额偏高需专项跟进。',
      periodType: 'month',
      periodValue: '2026-08',
      domain: 'finance',
      owner: '财经管理部',
      metricIds: [IDS.metrics.cashFlowAug, IDS.metrics.arBalanceAug],
    },
  });

  assert.equal(status, 201);
  assert.equal(json.ok, true);

  const created = json.data;
  assert.equal(created.report.code, 'RPT-2026-08-02');
  assert.equal(created.report.domain.code, 'finance');
  assert.equal(created.report.domain.label, '财务');
  assert.equal(created.report.landingHref, `/report/${created.report.id}`);
  assert.equal(created.keyMetrics.length, 2);
  assert.equal(created.metricSummary.suppliedCount, 2);

  // 新建报告尚无关联对象：三类入口均存在但均置灰
  assert.deepEqual(
    created.entries.map((e) => e.targetType),
    REQUIRED_ENTRY_TYPES
  );
  assert.ok(created.entries.every((e) => e.disabled === true && e.hint === NO_LINK_HINT));

  // 留痕：创建动作进入 audit_log，操作人可归属
  const audit = await pool.query(
    "SELECT action, entity_type, entity_id, actor FROM audit_log WHERE action = 'report.create' AND entity_id = $1",
    [created.report.id]
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].entity_type, 'report');
  assert.equal(audit.rows[0].actor, IDS.users.decider);

  // 创建后即可在清单中被筛到（周期 × 责任域组合筛选一致）
  const data = await listReports('?period_type=month&period_value=2026-08&domain=finance');
  assert.equal(data.total, 2);

  // 新报告此前无关联 → 详情三类入口仍全部置灰
  const detail = await getReport(created.report.id);
  assert.equal(detail.entryTotal, 0);
  assert.ok(detail.entries.every((e) => e.disabled === true));
});

test('边界：创建入参不合法时明确拒绝（结论是必填项）', async () => {
  const missingConclusion = await api('/reports', {
    method: 'POST',
    body: { title: '缺结论的报告', periodType: 'month', periodValue: '2026-09', domain: 'sales' },
  });
  assert.equal(missingConclusion.status, 400);
  assert.equal(missingConclusion.json.error.code, 'REPORT_CONCLUSION_REQUIRED');

  const badDomain = await api('/reports', {
    method: 'POST',
    body: { title: '域非法', conclusion: '结论', periodType: 'month', periodValue: '2026-09', domain: 'unknown_domain' },
  });
  assert.equal(badDomain.status, 400);
  assert.equal(badDomain.json.error.code, 'REPORT_DOMAIN_INVALID');

  const badPeriodType = await api('/reports', {
    method: 'POST',
    body: { title: '周期非法', conclusion: '结论', periodType: 'quarter', periodValue: '2026-Q3', domain: 'finance' },
  });
  assert.equal(badPeriodType.status, 400);
  assert.equal(badPeriodType.json.error.code, 'REPORT_PERIOD_TYPE_INVALID');

  const duplicateCode = await api('/reports', {
    method: 'POST',
    body: { code: 'RPT-2026-08-02', title: '编码重复', conclusion: '结论', periodType: 'month', periodValue: '2026-09', domain: 'sales' },
  });
  assert.equal(duplicateCode.status, 409);
  assert.equal(duplicateCode.json.error.code, 'REPORT_CODE_DUPLICATED');

  const noActor = await api('/reports', {
    method: 'POST',
    auth: false,
    body: { title: '无操作人', conclusion: '结论', periodType: 'month', periodValue: '2026-09', domain: 'sales' },
  });
  assert.equal(noActor.status, 401);
  assert.equal(noActor.json.error.code, 'AUTH_REQUIRED');
});

test('边界：关键指标必须存在且与报告同周期（报告不引用别期指标）', async () => {
  const notFound = await api('/reports', {
    method: 'POST',
    body: {
      title: '引用不存在的指标',
      conclusion: '结论',
      periodType: 'month',
      periodValue: '2026-09',
      domain: 'finance',
      metricIds: ['99999999-9999-4999-8999-999999999999'],
    },
  });
  assert.equal(notFound.status, 400);
  assert.equal(notFound.json.error.code, 'REPORT_METRIC_NOT_FOUND');

  const mismatched = await api('/reports', {
    method: 'POST',
    body: {
      title: '引用别期指标',
      conclusion: '结论',
      periodType: 'month',
      periodValue: '2026-09',
      domain: 'finance',
      metricIds: [IDS.metrics.cashFlowAug], // 2026-08 的指标
    },
  });
  assert.equal(mismatched.status, 400);
  assert.equal(mismatched.json.error.code, 'REPORT_METRIC_PERIOD_MISMATCH');
  assert.deepEqual(mismatched.json.error.details.mismatched, ['cash_flow']);
});

// ------------------------------------------------------------------ 红线：报告不自己取数、不重算

test('红线：报告的关键指标实际值与 F1 总览同口径（唯一取数路径，报告不另存数值）', async () => {
  const detail = await getReport(IDS.reports.financeSep);
  const revenue = metricByCode(detail, 'revenue');

  // 与 result_metrics / owner_results 的红线一致：实际值只来自 Owner Result
  assert.equal(revenue.actual.source.module, 'M09');
  assert.equal(revenue.actual.source.resultId, 'res-M09-revenue-2026-09');
  assert.equal(revenue.actual.source.calculationVersion, 'FIN-2026.09-v3');
  assert.equal(revenue.traceability.complete, true);
  assert.ok(revenue.traceability.evidenceIds.length > 0);

  // 报告库中不存在任何指标数值列（实际值不可能被报告侧改写）
  const columns = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('reports', 'report_metrics')`
  );
  const names = columns.rows.map((r) => r.column_name);
  for (const forbidden of ['value', 'actual_value', 'target_value', 'deviation']) {
    assert.ok(!names.includes(forbidden), `report 侧不得出现数值列 ${forbidden}`);
  }
});

test('边界：报告不存在时返回 404', async () => {
  const { status, json } = await api('/reports/99999999-9999-4999-8999-999999999999');
  assert.equal(status, 404);
  assert.equal(json.error.code, 'REPORT_NOT_FOUND');
});
