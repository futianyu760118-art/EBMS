'use strict';

// PAND-83（F5 四层链路 Result → Reason → Evidence → Source）AC 逐条验证。
// 口径为 PAND-97 返工后的统一口径：四层仅作 M03 视图导航，
// 段 2 对齐 Exception（归因）、段 4 取值来自 Evidence 的 source_system 字段。
//
// 运行：npm test（需 PostgreSQL 可连，见 .env；测试库会被重置为夹具数据）

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { migrate } = require('../src/db/migrate');
const { seed, IDS, REASON_FIXTURES, METRIC_FIXTURES, SEED_PERIOD } = require('../src/db/seed');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { LAYERS, LAYER_KEYS, LAYER_COUNT, CONTRACT_INVENTORY } = require('../src/domain/chain/layers');

let baseUrl;
let server;

async function get(pathname) {
  const res = await fetch(`${baseUrl}${pathname}`);
  const json = await res.json();
  return { status: res.status, json };
}

async function chain(metricId) {
  const { status, json } = await get(`/trace/${metricId}`);
  assert.equal(status, 200, `链路读取应成功：${metricId}`);
  return json.data;
}

function segmentOf(data, key) {
  return data.segments.find((s) => s.key === key);
}

function reasonByName(data, name) {
  return data.reasons.find((r) => r.name === name);
}

function evidenceById(data, id) {
  return data.evidences.find((e) => e.id === id);
}

/** 该指标下所有原因项关联的证据主键（用于制造/还原断点场景）。 */
async function linkedEvidenceIds(metricId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT re.evidence_id FROM reason_evidences re
       JOIN result_reasons r ON r.id = re.reason_id
      WHERE r.metric_id = $1`,
    [metricId]
  );
  return rows.map((r) => r.evidence_id);
}

async function snapshotLinks(metricId) {
  const { rows } = await pool.query(
    `SELECT re.reason_id, re.evidence_id, re.linked_by
       FROM reason_evidences re
       JOIN result_reasons r ON r.id = re.reason_id
      WHERE r.metric_id = $1`,
    [metricId]
  );
  return rows;
}

async function restoreLinks(rows) {
  for (const row of rows) {
    await pool.query(
      `INSERT INTO reason_evidences (reason_id, evidence_id, linked_by)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [row.reason_id, row.evidence_id, row.linked_by]
    );
  }
}

test.before(async () => {
  await migrate();
  await seed();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ------------------------------------------------------------------ 前置条件 / 场景 3 / 导航口径

test('前置条件：至少存在 1 条完整「结果 → 原因 → 证据 → 来源」链路', async () => {
  const data = await chain(IDS.metrics.orderDelivery);

  const complete = data.reasons.filter((r) =>
    data.evidences.some((e) => e.reasonId === r.id && e.source.marked)
  );
  assert.ok(complete.length >= 1, '应至少有一条可走到来源信息（source_system）的完整链路');

  // 完整链路可直接走通四段：结果 → 原因 → 证据 → 来源
  const reason = complete[0];
  const evidence = data.evidences.find((e) => e.reasonId === reason.id && e.source.marked);
  assert.ok(data.result.resultId, '段 1 结果应含 Result 契约标识');
  assert.ok(reason.attribution.kind, '段 2 原因应含归因判定');
  assert.notEqual(evidence.typeLabel, null, '段 3 证据应含证据类型');
  assert.ok(evidence.source.sourceSystem, '段 4 来源应取到 source_system 值');
});

test('场景 3 / 导航口径：导航段固定四段，顺序与契约对应不可增减', async () => {
  const data = await chain(IDS.metrics.orderDelivery);

  assert.equal(LAYER_COUNT, 4);
  assert.deepEqual(LAYER_KEYS, ['result', 'reason', 'evidence', 'source']);
  assert.equal(data.segmentCount, 4, '段数固定为 4');
  assert.deepEqual(data.segments.map((s) => s.key), ['result', 'reason', 'evidence', 'source']);
  assert.deepEqual(data.segments.map((s) => s.index), [1, 2, 3, 4]);
  // 判定标准：面包屑段数与导航段数一致 —— 第 2 段标注为「原因（归因）」
  assert.equal(data.segments[1].label, '原因（归因）');
  assert.deepEqual(data.segments.map((s) => s.label), ['结果', '原因（归因）', '证据', '来源信息']);
  // 层级定义为冻结常量：结构上杜绝运行时增删层级
  assert.ok(Object.isFrozen(LAYERS) && Object.isFrozen(LAYER_KEYS));
});

test('导航口径：段与 AEOS 契约的对应关系固定（段 2 = Exception 归因、段 4 = source_system 字段）', async () => {
  const data = await chain(IDS.metrics.orderDelivery);
  const byKey = Object.fromEntries(data.segments.map((s) => [s.key, s]));

  assert.equal(byKey.result.contractRef, 'Result');
  assert.equal(byKey.reason.contractRef, 'Exception');
  assert.equal(byKey.evidence.contractRef, 'Evidence');
  assert.equal(byKey.source.contractRef, 'Evidence.source_system');
  // 段 4 是字段而非独立层级
  assert.equal(byKey.source.kind, 'field');
  assert.equal(byKey.result.kind, 'object');
  assert.equal(byKey.source.contractVersion, null, '来源段不是契约对象，无独立契约版本');
});

test('导航口径 / 判定标准：链路消费对象清点 = Result / Exception / Evidence + source_system 字段，无额外跨域契约对象', async () => {
  const data = await chain(IDS.metrics.orderDelivery);

  assert.deepEqual(data.contractInventory, {
    objects: ['Result', 'Exception', 'Evidence'],
    fields: ['Evidence.source_system'],
    extras: [],
  });
  assert.deepEqual(data.contractInventory, CONTRACT_INVENTORY);
  assert.deepEqual(data.contractInventory.extras, [], '不得引入任何其他跨域契约对象');

  // 结构性保证：库里不存在独立的「来源」实体表（旧稿的 sources 表未采用）
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('sources', 'source_records', 'source_entities')`
  );
  assert.deepEqual(rows, [], '来源必须是 Evidence 上的字段，不得建独立来源实体表');
});

// ------------------------------------------------------------------ 场景 1 / 判定标准：≤4 次操作

test('场景 1 / 判定标准：层间下钻次数固定为 3（≤4）即可看到来源信息 source_system', async () => {
  const data = await chain(IDS.metrics.orderDelivery);

  assert.equal(data.drillOpsToSource, 3, '结果→原因→证据→来源 = 3 次层间下钻');
  assert.ok(data.drillOpsToSource <= 4, '≤4 次操作可看到来源信息');

  // 三次下钻依次落到：原因段 → 证据段 → 来源段，且中途不跳出上下文（单次请求即含全部四段）
  assert.equal(segmentOf(data, 'result').status, 'OK');
  assert.equal(segmentOf(data, 'reason').status, 'OK');
  assert.equal(segmentOf(data, 'evidence').status, 'OK');
  assert.equal(segmentOf(data, 'source').status, 'OK');
  // 来源段的取值确实来自所挂载 Evidence 的 source_system
  const picked = data.evidences.find((e) => e.source.marked);
  assert.equal(picked.source.resolvedFrom, 'Evidence.source_system');
  assert.equal(picked.source.displayText, picked.source.sourceSystemLabel);
});

// ------------------------------------------------------------------ 场景 2 / 判定标准：逐层返回

test('场景 2 / 判定标准：逐层返回不改变数据——同一链路重复读取，四段结构与结果段完全一致', async () => {
  const first = await chain(IDS.metrics.orderDelivery);
  const second = await chain(IDS.metrics.orderDelivery);

  // 返回上一层时前端停留在原层级，所用数据仍是同一份链路；后端读取必须无副作用、可重复。
  // 逐段比对（不含随其它用例增删证据而变化的条目清单），结构一致即「返回后与操作前一致」。
  const projection = (d) => ({
    result: d.result,
    layers: d.layers,
    segmentCount: d.segmentCount,
    contractInventory: d.contractInventory,
    drillOpsToSource: d.drillOpsToSource,
    segments: d.segments.map((s) => ({
      key: s.key,
      index: s.index,
      label: s.label,
      contractRef: s.contractRef,
      status: s.status,
      blocked: s.blocked,
    })),
  });

  assert.deepEqual(projection(second), projection(first), '重复读取同一链路应完全一致');
});

// ------------------------------------------------------------------ 场景 4

test('场景 4：查看来源信息展示所挂载 Evidence 的 source_system 字段值，不打开新的独立来源实体', async () => {
  const data = await chain(IDS.metrics.orderDelivery);
  assert.ok(data.evidences.length > 0);

  for (const e of data.evidences) {
    assert.equal(e.source.resolvedFrom, 'Evidence.source_system');
    // 来源段没有独立实体标识：只有字段值，没有 entity/id 之类的独立对象
    assert.equal(e.source.id, undefined, '不得为来源生成独立实体标识');
    assert.equal(e.source.entityId, undefined);
  }

  // 内部专业系统：字段值 + 可读标签
  const internal = evidenceById(data, IDS.evidences.systemRecord);
  assert.equal(internal.source.sourceSystem, 'M06');
  assert.equal(internal.source.displayText, 'M06 交付自治');
  // 外部数据提供方：同样只作字段值展示，不引入独立来源实体
  const external = evidenceById(data, IDS.evidences.contract);
  assert.equal(external.source.sourceSystem, 'SUPPLIER-A');
  assert.equal(external.source.sourceSystemLabel, 'SUPPLIER-A');
});

// ------------------------------------------------------------------ 边界

test('边界：Evidence 缺失 source_system 时来源段显示「来源未标注」，且不回落专业原始表查询', async () => {
  const data = await chain(IDS.metrics.orderDelivery);
  const unsourced = evidenceById(data, IDS.evidences.document);

  assert.notEqual(unsourced, undefined, '未标注来源的证据应在链路中可见');
  assert.equal(unsourced.source.marked, false);
  assert.equal(unsourced.source.sourceSystem, null);
  assert.equal(unsourced.source.displayText, '来源未标注');
  assert.equal(unsourced.source.fallbackToRawTables, false, '不得回落到专业原始表查询');
  // 未标注就到此为止：载荷里不得出现任何原始表记录
  assert.equal(unsourced.source.rawRecords, undefined);
  assert.equal(unsourced.source.rawTable, undefined);
});

test('边界：某段缺失时该段给断点 + 补录入口，不阻断其余段查看（证据段断点）', async () => {
  const snapshot = await snapshotLinks(IDS.metrics.orderDelivery);

  try {
    // 造出「该指标下所有原因项都没有证据」的状态 → 证据段断点
    await pool.query(
      `DELETE FROM reason_evidences WHERE reason_id IN (SELECT id FROM result_reasons WHERE metric_id = $1)`,
      [IDS.metrics.orderDelivery]
    );

    const data = await chain(IDS.metrics.orderDelivery);
    const evidence = segmentOf(data, 'evidence');
    assert.equal(evidence.status, 'MISSING');
    assert.equal(evidence.breakpoint.code, 'NO_EVIDENCE');
    assert.equal(evidence.breakpoint.label, '无证据支撑');
    assert.ok(evidence.breakpoint.refill.label, '断点必须带补录入口');
    assert.equal(evidence.blocked, false, '断点不得阻断其余段');

    // 其余段照常可看（原因段仍在，只是证据段为断点）
    assert.equal(segmentOf(data, 'reason').status, 'OK');
    assert.equal(data.reasons.length > 0, true);
    assert.equal(segmentOf(data, 'source').breakpoint.code, 'UPSTREAM_MISSING');
    assert.equal(data.segments.every((s) => s.blocked === false), true);
  } finally {
    await restoreLinks(snapshot);
  }
});

test('边界：原因段整体缺失（未归因）时给断点 + 补录入口，四段仍固定占位', async () => {
  const orphan = await chain(IDS.metrics.cashFlow);

  const reasonSeg = segmentOf(orphan, 'reason');
  assert.equal(reasonSeg.status, 'MISSING');
  assert.equal(reasonSeg.breakpoint.code, 'NO_ATTRIBUTION');
  assert.equal(reasonSeg.breakpoint.label, '未归因');
  assert.ok(reasonSeg.breakpoint.refill.label, '断点必须带补录入口');
  assert.equal(reasonSeg.blocked, false, '断点不得阻断其余段');

  // 上游缺失时，其余段仍照常返回（各自标断点），导航不中断
  assert.equal(orphan.reasons.length, 0);
  assert.equal(segmentOf(orphan, 'result').status, 'OK');
  assert.equal(segmentOf(orphan, 'evidence').status, 'MISSING');
  assert.equal(segmentOf(orphan, 'evidence').breakpoint.code, 'UPSTREAM_MISSING');
  assert.equal(segmentOf(orphan, 'source').breakpoint.code, 'UPSTREAM_MISSING');
  assert.equal(orphan.segments.every((s) => s.blocked === false), true);
  assert.equal(orphan.segments.length, 4, '即便链条缺段，四段仍固定占位');
});

test('边界：链路上全部证据均未标注来源时，来源段整体为断点（来源未标注），且不阻断其余段', async () => {
  const ids = await linkedEvidenceIds(IDS.metrics.orderDelivery);
  assert.ok(ids.length > 0);
  const { rows: original } = await pool.query(
    `SELECT id, source_type, source_system, source_document_no, source_data_time,
            source_update_cycle, source_provider, source_entered_by, source_entered_at
       FROM evidences WHERE id = ANY($1::uuid[])`,
    [ids]
  );

  try {
    // F4（PAND-82）的结构性约束要求来源「整体为空」或「整体齐全」；
    // 这里把来源标注整体清空（而非只清 source_system），使该链接路上证据均为「来源未标注」。
    await pool.query(
      `UPDATE evidences
          SET source_type = NULL, source_system = NULL, source_document_no = NULL,
              source_data_time = NULL, source_update_cycle = NULL, source_provider = NULL,
              source_entered_by = NULL, source_entered_at = NULL
        WHERE id = ANY($1::uuid[])`,
      [ids]
    );

    const data = await chain(IDS.metrics.orderDelivery);
    const source = segmentOf(data, 'source');
    assert.equal(source.status, 'MISSING');
    assert.equal(source.breakpoint.code, 'SOURCE_UNMARKED');
    assert.equal(source.breakpoint.label, '来源未标注');
    assert.ok(source.breakpoint.refill.label, '来源段断点必须带补录入口');
    assert.equal(source.blocked, false, '来源段断点不得阻断其余段');
    assert.equal(data.sourceContract.fallbackToRawTables, false);
    // 其余三段照常可看
    assert.equal(segmentOf(data, 'result').status, 'OK');
    assert.equal(segmentOf(data, 'reason').status, 'OK');
    assert.equal(segmentOf(data, 'evidence').status, 'OK');
    // 逐条证据的来源段均为「来源未标注」
    assert.equal(data.evidences.every((e) => e.source.displayText === '来源未标注'), true);
  } finally {
    for (const row of original) {
      await pool.query(
        `UPDATE evidences
            SET source_type = $2, source_system = $3, source_document_no = $4, source_data_time = $5,
                source_update_cycle = $6, source_provider = $7, source_entered_by = $8, source_entered_at = $9
          WHERE id = $1`,
        [
          row.id,
          row.source_type,
          row.source_system,
          row.source_document_no,
          row.source_data_time,
          row.source_update_cycle,
          row.source_provider,
          row.source_entered_by,
          row.source_entered_at,
        ]
      );
    }
  }
});

// ------------------------------------------------------------------ 归因口径（段 2 对齐 Exception）

test('归因口径：原因项 100% 可判定归属——或映射至 Exception（reason_code + severity），或标为 M03 自有归因分析', async () => {
  const data = await chain(IDS.metrics.orderDelivery);

  assert.ok(data.reasons.length >= REASON_FIXTURES.length);
  for (const r of data.reasons) {
    assert.ok(['exception', 'm03_analysis'].includes(r.attribution.kind), `原因项必须可判定归属：${r.name}`);
  }

  const capacity = reasonByName(data, '产能不足');
  assert.equal(capacity.attribution.kind, 'exception');
  assert.equal(capacity.attribution.kindLabel, '映射至 Exception（归因）');
  assert.equal(capacity.attribution.contractVersion, 'AEOS.Exception.V1');
  assert.equal(capacity.attribution.reasonCode, 'CAPACITY_SHORTAGE');
  assert.equal(capacity.attribution.severity, 'high');
  assert.equal(capacity.attribution.severityLabel, '高');

  // 兜底口径：缺 reason_code / severity → M03 自有归因分析，并标注不属于任何专业维度
  const channel = reasonByName(data, '渠道压货');
  assert.equal(channel.attribution.kind, 'm03_analysis');
  assert.equal(channel.attribution.kindLabel, 'M03 自有归因分析');
  assert.equal(channel.attribution.contractVersion, null);
  assert.equal(channel.attribution.reasonCode, null);
  assert.equal(channel.attribution.severity, null);
  assert.equal(channel.attribution.ownedByProfessionalDomain, false, '须显式标注不属于任何专业维度');
});

test('归因口径：归属判定由库内生成列保证，写入路径无法绕过', async () => {
  const { rows } = await pool.query(
    `SELECT is_generated FROM information_schema.columns
      WHERE table_name = 'result_reasons' AND column_name = 'attribution_kind'`
  );
  assert.equal(rows.length, 1, 'attribution_kind 必须是库内列');
  assert.equal(rows[0].is_generated, 'ALWAYS', 'attribution_kind 必须是生成列，不由应用层判定');

  // severity 取值受约束（对齐 AEOS Exception 严重度枚举）
  await assert.rejects(
    () => pool.query(`UPDATE result_reasons SET severity = 'urgent' WHERE id = $1`, [IDS.reasons.capacity]),
    /result_reasons_severity_check/
  );
});

// ------------------------------------------------------------------ 只读与红线

test('只读：链路仓储层只实现 SELECT，未新增任何写方法', async () => {
  const repo = require('../src/domain/chain/chain-repository');
  assert.deepEqual(Object.keys(repo).sort(), ['listEvidencesByReason', 'listReasons']);

  const source = fs.readFileSync(
    path.join(__dirname, '../src/domain/chain/chain-repository.js'),
    'utf8'
  );
  assert.equal(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(source), false, '链路读取不得包含写语句');
});

test('红线：链路不读取 orders / materials 等专业原始表', async () => {
  for (const file of ['chain-repository.js', 'chain-service.js', 'layers.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../src/domain/chain', file), 'utf8');
    assert.equal(
      /(FROM|JOIN)\s+(orders|materials|bom|pricing|quotes)\b/i.test(source),
      false,
      `${file} 不得直读专业原始表`
    );
  }
});

// ------------------------------------------------------------------ 入口与错误

test('入口：链路起点固定为结果指标，未知指标返回 404', async () => {
  const { status, json } = await get('/trace/anchors');
  assert.equal(status, 200);
  assert.equal(json.data.total, METRIC_FIXTURES.length, '入口清单 = 配置的指标集条目数');
  assert.equal(json.data.period.periodValue, SEED_PERIOD.periodValue);
  assert.deepEqual(
    json.data.items.map((i) => i.metricId),
    METRIC_FIXTURES.map((m) => IDS.metrics[m.key])
  );

  const missing = await get('/trace/ffffffff-0000-4000-8000-000000000000');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'RESULT_METRIC_NOT_FOUND');
});

test('场景 1：任一结果指标均可作为链路起点（含无数据与未归因指标，不因缺段而无法进入）', async () => {
  for (const m of METRIC_FIXTURES) {
    const data = await chain(IDS.metrics[m.key]);
    assert.equal(data.result.code, m.code);
    assert.equal(data.segments.length, 4);
    assert.equal(data.result.contractVersion, 'AEOS.Result.V1');
  }
});
