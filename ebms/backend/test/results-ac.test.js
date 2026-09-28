'use strict';

// PAND-79（F1 结果指标集）AC 逐条验证，含 PAND-96 返工新增的数据来源口径红线。
// 运行：npm test（需 PostgreSQL 可连，见 .env；测试库会被重置为夹具数据）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { migrate } = require('../src/db/migrate');
const { seed, IDS, METRIC_FIXTURES, OWNER_RESULT_FIXTURES, SEED_PERIOD } = require('../src/db/seed');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { OWNER_MODULE_CODES, TARGET_SOURCE_MODULE } = require('../src/domain/results/result-sources');

let baseUrl;
let server;
let token;

async function api(pathname, { method = 'GET', body, auth = true, raw = false } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return res;
  const json = await res.json();
  return { status: res.status, json };
}

async function overview(query = '') {
  const { status, json } = await api(`/results${query}`);
  assert.equal(status, 200);
  return json.data;
}

function byCode(items) {
  return new Map(items.map((item) => [item.code, item]));
}

// 「抽查不少于 10 条指标」：抽查口径 = 该周期所有已供给实际值的指标
function suppliedItems(items) {
  return items.filter((item) => item.actualValue !== null);
}

test.before(async () => {
  await migrate();
  await seed();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  // AC 主体是「决策者登录 EBMS 即可看到指标集」→ 以决策者身份走查
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

// ------------------------------------------------------------------ 场景 1 / 判定标准

test('场景 1：决策者登录后即可看到指标集，每条含 目标值 / 实际值 / 偏差值', async () => {
  const data = await overview();

  assert.equal(data.period.periodType, SEED_PERIOD.periodType);
  assert.equal(data.period.periodValue, SEED_PERIOD.periodValue);
  assert.ok(data.items.length > 0);

  for (const item of data.items) {
    assert.ok(item.code && item.name, `指标有编码与名称：${item.code}`);
    assert.ok(item.unit, `指标有单位：${item.code}`);
    // 目标值：来自 M03 Management Goal
    assert.equal(typeof item.targetValue, 'number', `目标值可读：${item.code}`);
    assert.equal(item.targetValue, item.target.value, `目标值与其来源块一致：${item.code}`);
    assert.equal(item.target.source.module, TARGET_SOURCE_MODULE, `目标值来源为 M03：${item.code}`);
    assert.ok(['higher_better', 'lower_better'].includes(item.target.direction), `目标方向合法：${item.code}`);
    // 实际值：无数据时为 null（不是 0、不是空字符串）
    assert.ok(item.actualValue === null || typeof item.actualValue === 'number', `实际值类型正确：${item.code}`);
    assert.ok(item.actual === null || typeof item.actual.value === 'number', `实际值结构正确：${item.code}`);
    // 偏差值：结构恒在（无数据时 computable=false）
    assert.equal(item.deviation.formula, '实际值 − 目标值', `偏差口径自述：${item.code}`);
    assert.equal(typeof item.deviation.computable, 'boolean', `偏差可计算性有标记：${item.code}`);
  }
});

test('判定标准：条目数 = 配置的指标集条目数（无数据条目同样占位，不被过滤）', async () => {
  const data = await overview();

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM result_metrics
      WHERE is_active = TRUE AND period_type = $1 AND period_value = $2`,
    [SEED_PERIOD.periodType, SEED_PERIOD.periodValue]
  );

  assert.equal(data.configuredCount, METRIC_FIXTURES.length, '条目数等于配置的指标集条目数');
  assert.equal(data.items.length, data.configuredCount, '返回条目数与配置条目数一致');
  assert.equal(data.configuredCount, rows[0].n, '与库中配置的指标集条目数一致');
  // 边界：无数据的两条指标仍然出现在指标集里
  assert.equal(data.noDataCount, 2);
  assert.equal(data.suppliedCount + data.noDataCount, data.configuredCount);

  const codes = data.items.map((item) => item.code);
  assert.ok(codes.includes('on_time_delivery'), '未供给的指标仍在指标集内占位');
  assert.ok(codes.includes('new_customer_count'), '未同步的指标仍在指标集内占位');
});

test('判定标准：每条指标都有数据截止时间', async () => {
  const data = await overview();
  for (const item of data.items) {
    assert.ok(item.dataCutoffAt, `数据截止时间非空：${item.code}`);
    assert.ok(!Number.isNaN(new Date(item.dataCutoffAt).getTime()), `数据截止时间合法：${item.code}`);
  }
});

test('判定标准：抽查不少于 10 条指标，偏差值 = 实际值 − 目标值', async () => {
  const data = await overview();
  const sample = suppliedItems(data.items);

  assert.ok(sample.length >= 10, `抽查条数不少于 10：实际 ${sample.length}`);

  for (const item of sample) {
    assert.ok(item.deviation.computable, `偏差可计算：${item.code}`);
    const expected = Number((item.actualValue - item.targetValue).toFixed(2));
    assert.equal(item.deviation.value, expected, `偏差值 = 实际值 − 目标值：${item.code}`);
    assert.ok(['ACHIEVED', 'MISSED'].includes(item.deviation.attainment), `达标判定取值合法：${item.code}`);

    // 达标判定按目标方向（越低越好的指标，实际值不高于目标才算达标）
    const attained =
      item.target.direction === 'lower_better'
        ? item.actualValue <= item.targetValue
        : item.actualValue >= item.targetValue;
    assert.equal(item.deviation.attainment, attained ? 'ACHIEVED' : 'MISSED', `达标判定符合方向：${item.code}`);
  }

  // 抽查若干条的偏差值与口径确定性（含「越低越好」方向）
  const map = byCode(sample);
  assert.equal(map.get('revenue').deviation.value, -720);
  assert.equal(map.get('revenue').deviation.pct, -6);
  assert.equal(map.get('order_delivery').deviation.value, -13);
  assert.equal(map.get('order_delivery').deviation.pct, -13);
  assert.equal(map.get('operating_cost').deviation.value, 410);
  assert.equal(map.get('operating_cost').deviation.direction, 'lower_better');
  assert.equal(map.get('operating_cost').deviation.attainment, 'MISSED', '成本超目标 → 未达标');
  assert.equal(map.get('cash_flow').deviation.attainment, 'ACHIEVED');
});

test('判定标准：偏差阈值设定生效（阈值内不提示，超阈值醒目提示）', async () => {
  const data = await overview();
  const map = byCode(data.items);

  // 阈值内（|偏差率| <= threshold_pct）
  assert.equal(map.get('gross_margin_rate').deviation.exceeded, false);
  assert.equal(map.get('cash_flow').deviation.exceeded, false);
  assert.equal(map.get('capacity_utilization').deviation.exceeded, false);
  // 超阈值
  assert.equal(map.get('revenue').deviation.exceeded, true);
  assert.equal(map.get('order_delivery').deviation.exceeded, true);

  for (const item of suppliedItems(data.items)) {
    if (item.deviation.pct === null) continue;
    assert.equal(
      item.deviation.exceeded,
      Math.abs(item.deviation.pct) > item.deviation.thresholdPct,
      `是否超阈值按口径判定：${item.code}`
    );
  }
});

// ------------------------------------------------------------------ 红线：数据来源口径

test('红线：实际值 100% 来自 Owner Result，且与 Owner Result 登记值无差异', async () => {
  const data = await overview();
  const { json: resultList } = await api('/owner-results');
  const resultById = new Map(resultList.data.items.map((r) => [r.resultId, r]));

  const sample = suppliedItems(data.items);
  assert.ok(sample.length >= 10);

  for (const item of sample) {
    const resultId = item.actual.source.resultId;
    assert.ok(resultId, `实际值带 Owner Result 标识：${item.code}`);

    const ownerResult = resultById.get(resultId);
    assert.ok(ownerResult, `能定位到对应 Owner Result：${item.code}`);
    // 抽查：实际值与对应 Owner Result 展示值一致，无差异
    assert.equal(item.actualValue, ownerResult.value, `实际值与 Owner Result 一致：${item.code}`);
    assert.equal(item.actual.source.module, ownerResult.sourceSystem, `来源模块一致：${item.code}`);

    // 独立核对：直接读库中 Owner Result 原始值（绕过接口序列化）
    const { rows } = await pool.query('SELECT value FROM owner_results WHERE result_id = $1', [resultId]);
    assert.equal(rows.length, 1, `Owner Result 已落库：${resultId}`);
    assert.equal(item.actualValue, Number(rows[0].value), `实际值等于库中 Owner Result 原值：${item.code}`);
  }
});

test('红线：无数据的指标不给任何数值，EBMS 不兜底计算', async () => {
  const data = await overview();
  const map = byCode(data.items);

  for (const code of ['on_time_delivery', 'new_customer_count']) {
    const item = map.get(code);
    assert.equal(item.hasData, false, `${code} 应为无数据`);
    assert.equal(item.actualValue, null, `${code} 实际值必须是 null（不得为 0）`);
    assert.equal(item.actual, null, `${code} 无实际值对象`);
    assert.equal(item.deviation.value, null, `${code} 偏差不得给出数字`);
    assert.equal(item.deviation.computable, false);
    assert.equal(item.deviation.attainment, null);
  }

  // 全表：任何「无 dataStatus 供给」的条目都不得携带数值
  for (const item of data.items) {
    if (item.dataStatus !== 'SUPPLIED') {
      assert.equal(item.actualValue, null, `${item.code} 未供给时不得有实际值`);
      assert.notEqual(item.actualValue, 0, `${item.code} 不得兜底为 0`);
    }
  }
});

test('红线：result_metrics 表不存在任何实际值列（结构上无法兜底计算）', async () => {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'result_metrics'`
  );
  const actualish = rows.map((r) => r.column_name).filter((c) => /actual|deviation/i.test(c));
  assert.deepEqual(actualish, [], `result_metrics 不得存放实际值/偏差列：${actualish.join(', ')}`);
});

test('红线：逐指标核对来源声明（实际值仅 M05/M06/M09，目标值仅 M03）', async () => {
  const data = await overview();
  const { json: sources } = await api('/result-sources');

  assert.equal(sources.data.targetSourceModule, TARGET_SOURCE_MODULE);
  assert.deepEqual(sources.data.ownerModules.map((m) => m.code).sort(), OWNER_MODULE_CODES.slice().sort());

  for (const item of data.items) {
    assert.ok(item.owner, `指标声明了归属模块：${item.code}`);
    assert.ok(OWNER_MODULE_CODES.includes(item.owner.module), `归属模块在白名单内：${item.code}`);
    assert.equal(item.target.source.module, 'M03', `目标值来源只能是 M03：${item.code}`);

    if (item.hasData) {
      // 来源声明与实际来源必须一致（不存在「声明 M09、实际取 M05」的路径）
      assert.equal(item.actual.source.module, item.owner.module, `实际值来源与归属声明一致：${item.code}`);
      assert.equal(item.traceability.sourceModule, item.owner.module, `追溯来源与归属声明一致：${item.code}`);
    }
  }
});

test('红线：EBMS 结果域不读取专业原始表（orders / materials 等）', () => {
  const dir = path.join(__dirname, '..', 'src', 'domain', 'results');
  const forbidden = /\b(from|join)\s+(orders|order_items|materials|inventory|production_orders|delivery_orders)\b/i;

  for (const file of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(!forbidden.test(src), `${file} 不得直读专业原始表`);
  }
});

test('红线：非 Owner 模块的 Owner Result 被拒绝登记', async () => {
  const { status, json } = await api('/owner-results', {
    method: 'POST',
    body: {
      resultId: 'res-M04-illegal-2026-09',
      sourceSystem: 'M04',
      objectId: 'revenue',
      metricCode: 'revenue',
      value: 1,
      periodType: 'month',
      periodValue: SEED_PERIOD.periodValue,
      calculationVersion: 'X-v1',
      evidenceIds: [IDS.evidences.financeReport],
      status: 'VERIFIED',
      occurredAt: '2026-09-30T00:00:00+08:00',
      traceId: 'trace-illegal',
    },
  });
  assert.equal(status, 400);
  assert.equal(json.error.code, 'OWNER_RESULT_SOURCE_INVALID');
  assert.deepEqual(json.error.details.allowedSourceSystems, OWNER_MODULE_CODES);
});

test('红线：缺少 calculation_version / evidence_ids 的 Owner Result 被拒绝', async () => {
  const base = {
    resultId: 'res-M09-missing-trace-2026-09',
    sourceSystem: 'M09',
    objectId: 'revenue',
    metricCode: 'revenue',
    value: 1,
    periodType: 'month',
    periodValue: SEED_PERIOD.periodValue,
    status: 'VERIFIED',
    occurredAt: '2026-09-30T00:00:00+08:00',
    traceId: 'trace-missing',
  };

  const noVersion = await api('/owner-results', { method: 'POST', body: { ...base, evidenceIds: ['x'] } });
  assert.equal(noVersion.status, 400);
  assert.equal(noVersion.json.error.code, 'OWNER_RESULT_CALCULATION_VERSION_REQUIRED');

  const noEvidence = await api('/owner-results', {
    method: 'POST',
    body: { ...base, calculationVersion: 'FIN-2026.09-v3', evidenceIds: [] },
  });
  assert.equal(noEvidence.status, 400);
  assert.equal(noEvidence.json.error.code, 'OWNER_RESULT_EVIDENCE_IDS_REQUIRED');

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM owner_results WHERE result_id = $1', [base.resultId]);
  assert.equal(rows[0].n, 0, '校验失败不得留下半条记录');
});

// ------------------------------------------------------------------ 场景 4：口径版本与证据

test('场景 4：每个指标可查看实际值的 calculation_version 与 evidence_ids', async () => {
  const data = await overview();

  assert.equal(data.allTraceable, true, '抽查 100% 无缺项');
  assert.equal(data.traceableCount, data.suppliedCount);

  for (const item of suppliedItems(data.items)) {
    assert.ok(item.traceability.resultId, `有 Owner Result 标识：${item.code}`);
    assert.ok(item.traceability.calculationVersion, `有口径版本：${item.code}`);
    assert.ok(item.traceability.evidenceIds.length > 0, `有证据引用：${item.code}`);
    assert.equal(item.traceability.complete, true, `追溯三要素无缺项：${item.code}`);
  }
});

test('场景 4：由 evidence_ids 可定位到对应证据', async () => {
  const detail = await api(`/results/${IDS.metrics.orderDelivery}`);
  assert.equal(detail.status, 200);

  const refs = detail.json.data.traceability.evidence;
  assert.ok(refs.length >= 1);

  const mecEvidence = refs.find((r) => r.id === IDS.evidences.systemRecord);
  assert.ok(mecEvidence, 'evidence_ids 中的 MES 系统记录被解析出来');
  assert.equal(mecEvidence.resolved, true);
  assert.equal(mecEvidence.typeLabel, '系统记录');
  assert.ok(mecEvidence.title.includes('MES'));
  assert.equal(mecEvidence.viewPath, `#/evidence/${IDS.evidences.systemRecord}`);

  // 定位到证据本体：按该 id 调用证据详情接口，得到同一实体
  const evidence = await api(`/evidences/${IDS.evidences.systemRecord}`);
  assert.equal(evidence.status, 200);
  assert.equal(evidence.json.data.title, mecEvidence.title, '由 evidence_ids 定位到的证据与证据详情一致');
  assert.equal(evidence.json.data.type, mecEvidence.type);
});

test('场景 4：详情返回 计算口径版本 / 证据引用 / 目标值来源', async () => {
  const { status, json } = await api(`/results/${IDS.metrics.revenue}`);
  assert.equal(status, 200);
  const data = json.data;

  assert.equal(data.actual.source.calculationVersion, 'FIN-2026.09-v3');
  assert.equal(data.actual.source.module, 'M09');
  assert.equal(data.ownerResult.resultId, 'res-M09-revenue-2026-09');
  assert.equal(data.ownerResult.contractVersion, 'AEOS.Result.V1');
  assert.equal(data.ownerResult.traceId, 'trace-fin-202609-rev');
  assert.equal(data.targetTrace.module, 'M03');
  assert.equal(data.targetTrace.ref, 'MG-2026-09-FIN-01');
  assert.equal(data.traceability.calculationVersion, 'FIN-2026.09-v3');
});

// ------------------------------------------------------------------ 边界

test('边界：来源模块未供给 → 「无数据」+「来源模块未供给」', async () => {
  const data = await overview();
  const item = byCode(data.items).get('on_time_delivery');

  assert.equal(item.dataStatus, 'NOT_SUPPLIED');
  assert.equal(item.dataStatusLabel, '无数据');
  assert.equal(item.noDataReason, '来源模块未供给');
  assert.equal(item.actualValue, null);
});

test('边界：来源模块未同步本期 → 「无数据」+「来源模块未同步本期数据」', async () => {
  const data = await overview();
  const item = byCode(data.items).get('new_customer_count');

  assert.equal(item.dataStatus, 'NOT_SYNCED');
  assert.equal(item.dataStatusLabel, '无数据');
  assert.equal(item.noDataReason, '来源模块未同步本期数据');
  assert.equal(item.actualValue, null);

  // 佐证：M05 确实供给过该指标，只是周期不同（8 月）
  const { rows } = await pool.query(
    `SELECT period_value FROM owner_results WHERE metric_code = 'new_customer_count'`
  );
  assert.deepEqual(rows.map((r) => r.period_value), ['2026-08']);
});

test('边界：未指定周期时落到已配置的最新周期（登录即可看到）', async () => {
  const data = await overview();
  assert.equal(data.period.periodType, SEED_PERIOD.periodType);
  assert.equal(data.period.periodValue, SEED_PERIOD.periodValue);
  assert.equal(data.configuredCount, METRIC_FIXTURES.length);
});

test('边界：非法数据周期取值被拒绝，并给出允许的取值', async () => {
  const bad = await api('/results?period_type=quarter&period_value=2026-Q3');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'RESULT_PERIOD_TYPE_INVALID');
  assert.deepEqual(bad.json.error.details.allowed, ['day', 'week', 'month']);

  const partial = await api('/results?period_type=month');
  assert.equal(partial.status, 400);
  assert.equal(partial.json.error.code, 'RESULT_PERIOD_INCOMPLETE');
});

test('边界：指标不存在时返回 404，而非误导性的空指标', async () => {
  const { status, json } = await api('/results/44444444-0000-4000-8000-000000000000');
  assert.equal(status, 404);
  assert.equal(json.error.code, 'RESULT_METRIC_NOT_FOUND');
});

test('边界：登记 Owner Result 缺少 token 时返回 401（操作人不可缺省，留痕必须可归属）', async () => {
  const { status, json } = await api('/owner-results', {
    method: 'POST',
    auth: false,
    body: {
      resultId: 'res-anon',
      sourceSystem: 'M09',
      objectId: 'revenue',
      metricCode: 'revenue',
      value: 1,
      periodType: 'month',
      periodValue: SEED_PERIOD.periodValue,
      calculationVersion: 'v1',
      evidenceIds: ['x'],
      status: 'VERIFIED',
      occurredAt: '2026-09-30T00:00:00+08:00',
      traceId: 't',
    },
  });
  assert.equal(status, 401);
  assert.equal(json.error.code, 'AUTH_REQUIRED');
});

// ------------------------------------------------------------------ 登记幂等 / 留痕

test('登记 Owner Result 产生留痕；重复登记幂等且不新增留痕', async () => {
  const body = {
    resultId: 'res-M06-order-delivery-2026-09-v2',
    sourceSystem: 'M06',
    objectId: 'order_delivery',
    metricCode: 'order_delivery',
    metricName: '订单交付达成率',
    value: 88.5,
    unit: '%',
    periodType: 'month',
    periodValue: SEED_PERIOD.periodValue,
    calculationVersion: 'DELIV-2026.09-v5',
    evidenceIds: [IDS.evidences.systemRecord],
    status: 'VERIFIED',
    occurredAt: '2026-09-30T23:59:59+08:00',
    traceId: 'trace-deliv-202609-od-v2',
  };

  const first = await api('/owner-results', { method: 'POST', body });
  assert.equal(first.status, 201);
  assert.equal(first.json.data.changed, true);
  assert.equal(first.json.data.audit.action, 'owner_result.receive');
  assert.ok(first.json.data.audit.actor && first.json.data.audit.at, '留痕含操作人与时间');
  assert.equal(first.json.data.audit.actorName, '张决策（决策者）');

  const replay = await api('/owner-results', { method: 'POST', body });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.data.changed, false);
  assert.equal(replay.json.data.alreadyReceived, true);
  assert.equal(replay.json.data.audit, null);

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE entity_id = (SELECT id::text FROM owner_results WHERE result_id = $1)`,
    [body.resultId]
  );
  assert.equal(rows[0].n, 1, '重复登记不产生第二条留痕');

  const { rows: resultRows } = await pool.query('SELECT count(*)::int AS n FROM owner_results WHERE result_id = $1', [
    body.resultId,
  ]);
  assert.equal(resultRows[0].n, 1, '重复登记不产生第二条 Owner Result');

  // 同一指标同一周期出现新口径结果 → 总览取最新一条
  const data = await overview();
  const item = byCode(data.items).get('order_delivery');
  assert.equal(item.actualValue, 88.5, '取最新口径的 Owner Result');
  assert.equal(item.traceability.calculationVersion, 'DELIV-2026.09-v5');

  // 复原夹具，避免影响其它断言
  await pool.query(
    `DELETE FROM audit_log WHERE entity_id = (SELECT id::text FROM owner_results WHERE result_id = $1)`,
    [body.resultId]
  );
  await pool.query('DELETE FROM owner_results WHERE result_id = $1', [body.resultId]);
});

test('边界：未在本系统登记的来源证据被显式标注，不静默丢弃', async () => {
  const unknownEvidenceId = 'bbbbbbbb-0009-4000-8000-0000000000ff';
  const { status } = await api('/owner-results', {
    method: 'POST',
    body: {
      resultId: 'res-M06-on-time-delivery-2026-09',
      sourceSystem: 'M06',
      objectId: 'on_time_delivery',
      metricCode: 'on_time_delivery',
      metricName: '准时交付率',
      value: 96.4,
      unit: '%',
      periodType: 'month',
      periodValue: SEED_PERIOD.periodValue,
      calculationVersion: 'DELIV-2026.09-v4',
      evidenceIds: [unknownEvidenceId],
      status: 'VERIFIED',
      occurredAt: '2026-09-30T23:59:59+08:00',
      traceId: 'trace-deliv-202609-otd',
    },
  });
  assert.equal(status, 201);

  const detail = await api(`/results/${IDS.metrics.onTimeDelivery}`);
  assert.equal(detail.status, 200);
  const ref = detail.json.data.traceability.evidence[0];

  assert.equal(ref.id, unknownEvidenceId);
  assert.equal(ref.resolved, false, '未登记的来源证据显式标注为未解析');
  assert.equal(ref.title, '来源证据未在本系统登记');
  assert.equal(ref.viewPath, null);
  // 引用本身仍在，不被丢弃
  assert.deepEqual(detail.json.data.traceability.evidenceIds, [unknownEvidenceId]);

  // 复原夹具
  await pool.query(
    `DELETE FROM audit_log WHERE entity_id = (SELECT id::text FROM owner_results WHERE result_id = $1)`,
    ['res-M06-on-time-delivery-2026-09']
  );
  await pool.query('DELETE FROM owner_results WHERE result_id = $1', ['res-M06-on-time-delivery-2026-09']);

  const restored = await overview();
  assert.equal(byCode(restored.items).get('on_time_delivery').dataStatus, 'NOT_SUPPLIED');
});

test('边界：Owner Result 清单可按指标与来源模块核对（逐指标来源声明）', async () => {
  const all = await api('/owner-results');
  assert.equal(all.status, 200);
  assert.equal(all.json.data.total, OWNER_RESULT_FIXTURES.length);

  const m09 = await api('/owner-results?source_system=M09');
  assert.equal(m09.json.data.total, OWNER_RESULT_FIXTURES.filter((r) => r.sourceSystem === 'M09').length);

  const byMetric = await api('/owner-results?metric_code=revenue');
  assert.equal(byMetric.json.data.total, 1);
  assert.equal(byMetric.json.data.items[0].calculationVersion, 'FIN-2026.09-v3');

  const illegal = await api('/owner-results?source_system=M04');
  assert.equal(illegal.status, 400);
  assert.equal(illegal.json.error.code, 'OWNER_RESULT_SOURCE_INVALID');
});
