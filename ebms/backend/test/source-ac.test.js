'use strict';

// PAND-82（F4 每条证据标注来源）AC 逐条验证。
// 运行：npm test（需 PostgreSQL 可连，见 .env；测试库会被重置为夹具数据）

const test = require('node:test');
const assert = require('node:assert/strict');

const { migrate } = require('../src/db/migrate');
const { seed, IDS } = require('../src/db/seed');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { SOURCE_MISSING_MARKER, SOURCE_TYPES } = require('../src/domain/source/source-types');

// 夹具锚点：contract 外部数据 / systemRecord 与 warehouse 内部系统 /
// manualNote 人工录入 / document 刻意未标注来源（来源缺失边界）
const EXTERNAL_EVIDENCE = IDS.evidences.contract;
const INTERNAL_EVIDENCE = IDS.evidences.systemRecord;
const SECOND_INTERNAL_EVIDENCE = IDS.evidences.warehouse;
const MANUAL_EVIDENCE = IDS.evidences.manualNote;
const MISSING_EVIDENCE = IDS.evidences.document;
const MISSING_EVIDENCE_TITLE = '生产工单 GW-2026-0901';
const TOTAL_FIXTURE_EVIDENCE = 7;

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

function displayValue(detail, key) {
  const entry = detail.display.find((d) => d.key === key);
  return entry ? entry.value : undefined;
}

/** 清掉本文件临时造的证据（及其留痕），使统计类断言不受用例顺序影响。 */
async function removeEvidence(evidenceId) {
  await pool.query('DELETE FROM audit_log WHERE entity_type = $1 AND entity_id = $2', [
    'evidence',
    evidenceId,
  ]);
  await pool.query('DELETE FROM evidences WHERE id = $1', [evidenceId]);
}

test.before(async () => {
  await migrate();
  await seed();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  const login = await fetch(`${baseUrl}/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner' }),
  });
  token = (await login.json()).data.token;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ------------------------------------------------------------------ 前置条件

test('前置：来源是证据的属性，随证据新增即可标注，且不计入「来源缺失」', async () => {
  const created = await api('/evidences', {
    method: 'POST',
    body: {
      type: 'system_record',
      title: 'MES 工序良率导出（2026-09）',
      formedAt: '2026-09-25T00:00:00+08:00',
      owner: '生产中心 / 系统',
      source: {
        sourceType: 'internal',
        sourceSystem: 'MES 生产执行系统',
        sourceDocumentNo: 'MES-YIELD-2026-09',
        sourceDataTime: '2026-09-25T00:00:00+08:00',
        updateCycle: 'day',
      },
    },
  });

  assert.equal(created.status, 201);
  assert.equal(created.json.data.evidence.source.sourceMissing, false, '随新增标注的来源不应判为缺失');
  assert.equal(created.json.data.evidence.source.sourceSystem, 'MES 生产执行系统');

  const detail = await api(`/evidences/${created.json.data.evidence.id}/source`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.sourceMissing, false, '每条证据都应能解析出至少 1 个 Source');
  assert.equal(detail.json.data.sourceType, 'internal');

  // 清理：本用例只验证「新增即可标注」，不应改变后续统计的总条数
  await removeEvidence(created.json.data.evidence.id);
});

test('前置：来源类别与更新周期枚举为已确认口径（内部系统 / 外部数据 / 人工录入）', async () => {
  const catalog = await api('/source-catalog');
  assert.equal(catalog.status, 200);
  assert.deepEqual(
    catalog.json.data.sourceTypes.map((s) => s.code),
    ['internal', 'external', 'manual']
  );
  assert.deepEqual(
    catalog.json.data.sourceTypes.map((s) => s.label),
    ['内部系统', '外部数据', '人工录入']
  );
  assert.deepEqual(
    catalog.json.data.updateCycles.map((c) => c.code),
    ['day', 'week', 'month'],
    '口径：数据为周期更新（日/周/月），非实时'
  );
  assert.equal(catalog.json.data.missingMarker, SOURCE_MISSING_MARKER);
});

// ------------------------------------------------------------------ 场景 1

test('场景 1：明细展示来源系统 / 来源单据编号 / 来源数据时间 / 提供方', async () => {
  const { status, json } = await api(`/evidences/${EXTERNAL_EVIDENCE}/source`);
  assert.equal(status, 200);

  const detail = json.data;
  assert.equal(detail.sourceMissing, false);
  assert.equal(detail.missingMarker, null);

  // 四个展示字段的标签与取值（顺序即口径顺序）
  assert.deepEqual(
    detail.display.map((d) => d.label),
    ['来源系统', '来源单据编号', '来源数据时间', '提供方']
  );
  assert.equal(displayValue(detail, 'sourceSystem'), '供应商门户 SRM');
  assert.equal(displayValue(detail, 'sourceDocumentNo'), 'SC-2026-014');
  assert.equal(displayValue(detail, 'sourceProvider'), 'A 供应商（外部）');
  assert.ok(displayValue(detail, 'sourceDataTime'), '来源数据时间非空');
  assert.equal(new Date(displayValue(detail, 'sourceDataTime')).toISOString(), '2026-08-14T16:00:00.000Z');

  // 口径：须展示数据截止时间（与来源数据时间同源）
  assert.equal(detail.dataCutoffAt, detail.sourceDataTime);
});

test('场景 1：更新周期（日/周/月）随明细展示，说明数据非实时', async () => {
  const external = (await api(`/evidences/${EXTERNAL_EVIDENCE}/source`)).json.data;
  const internal = (await api(`/evidences/${INTERNAL_EVIDENCE}/source`)).json.data;

  assert.equal(external.updateCycle, 'month');
  assert.equal(external.updateCycleLabel, '月');
  assert.equal(internal.updateCycle, 'day');
  assert.equal(internal.updateCycleLabel, '日');
  assert.equal(internal.updateCycleDisplay.label, '更新周期');
});

// ------------------------------------------------------------------ 场景 2

test('场景 2：人工录入来源额外标注录入人与录入时间', async () => {
  const { status, json } = await api(`/evidences/${MANUAL_EVIDENCE}/source`);
  assert.equal(status, 200);

  const detail = json.data;
  assert.equal(detail.sourceType, 'manual');
  assert.equal(detail.sourceTypeLabel, '人工录入');
  assert.equal(detail.enteredBy, '钱厂长');
  assert.ok(detail.enteredAt, '录入时间非空');

  assert.deepEqual(
    detail.manualDisplay.map((d) => d.label),
    ['录入人', '录入时间'],
    '人工录入应在场景 1 四字段之外追加录入人 / 录入时间'
  );
  assert.equal(displayValue({ display: detail.manualDisplay }, 'enteredBy'), '钱厂长');
});

test('场景 2：非人工录入来源不出现录入人 / 录入时间', async () => {
  for (const id of [EXTERNAL_EVIDENCE, INTERNAL_EVIDENCE]) {
    const detail = (await api(`/evidences/${id}/source`)).json.data;
    assert.equal(detail.enteredBy, null);
    assert.equal(detail.enteredAt, null);
    assert.deepEqual(detail.manualDisplay, [], '系统来源不应渲染录入人 / 录入时间');
  }
});

// ------------------------------------------------------------------ 场景 3

test('场景 3：Source 覆盖内部系统与外部数据两类，且可区分展示', async () => {
  const external = (await api(`/evidences/${EXTERNAL_EVIDENCE}/source`)).json.data;
  const internal = (await api(`/evidences/${INTERNAL_EVIDENCE}/source`)).json.data;

  assert.equal(external.sourceType, 'external');
  assert.equal(external.sourceTypeLabel, '外部数据');
  assert.equal(internal.sourceType, 'internal');
  assert.equal(internal.sourceTypeLabel, '内部系统');
  assert.notEqual(external.sourceType, internal.sourceType, '两类来源可区分');
});

test('场景 3：外部数据的提供方非空（判定标准 2 的展示面）', async () => {
  for (const id of [EXTERNAL_EVIDENCE, SECOND_INTERNAL_EVIDENCE]) {
    const detail = (await api(`/evidences/${id}/source`)).json.data;
    if (detail.sourceType === 'external') {
      assert.ok(detail.sourceProvider, '外部数据必须有提供方');
    } else {
      // 内部系统不要求提供方，但字段仍存在于场景 1 的展示块中
      assert.ok(detail.display.some((d) => d.label === '提供方'));
    }
  }
});

// ------------------------------------------------------------------ 边界

test('边界：无 Source 的证据标记「来源缺失」', async () => {
  const { status, json } = await api(`/evidences/${MISSING_EVIDENCE}/source`);
  assert.equal(status, 200);

  const detail = json.data;
  assert.equal(detail.sourceMissing, true);
  assert.equal(detail.missingMarker, '来源缺失');
  assert.equal(detail.sourceType, null);
  assert.equal(detail.sourceTypeLabel, null);
  assert.equal(detail.sourceSystem, null);
  assert.deepEqual(detail.pendingFields, ['sourceSystem', 'sourceDataTime', 'sourceDocumentNo']);
  assert.deepEqual(detail.pendingFieldLabels, ['来源系统', '来源数据时间', '来源单据编号']);
});

test('边界：来源缺失的证据计入待补清单（含关联原因项上下文）', async () => {
  const { status, json } = await api('/sources/missing');
  assert.equal(status, 200);

  const list = json.data;
  assert.equal(list.marker, '来源缺失');
  assert.equal(list.total, 1);
  assert.equal(list.items.length, 1);

  const item = list.items[0];
  assert.equal(item.evidenceId, MISSING_EVIDENCE);
  assert.equal(item.title, MISSING_EVIDENCE_TITLE);
  assert.equal(item.sourceMissing, true);
  assert.equal(item.missingMarker, '来源缺失');
  assert.deepEqual(item.pendingFieldLabels, ['来源系统', '来源数据时间', '来源单据编号']);
  assert.ok(item.reasons.length >= 1, '待补清单应带出证据挂载的原因项，便于定位缺口');
  assert.ok(item.reasons.some((r) => r.name === '产能不足'));
});

test('边界：清单可按证据类型与标题过滤，并正确分页', async () => {
  const byType = await api('/sources/missing?evidenceType=document');
  assert.equal(byType.json.data.total, 1);

  const otherType = await api('/sources/missing?evidenceType=contract');
  assert.equal(otherType.json.data.total, 0, '外部数据类的证据已标注来源，不应出现在待补清单');

  const byTitle = await api('/sources/missing?q=生产工单');
  assert.equal(byTitle.json.data.total, 1);

  const paged = await api('/sources/missing?limit=1&offset=1');
  assert.equal(paged.json.data.total, 1, 'total 反映过滤后的总数，而非当页条数');
  assert.equal(paged.json.data.items.length, 0);
});

// ------------------------------------------------------------------ 判定标准

test('判定标准 1：来源缺失率可统计（缺失条数 ÷ 总条数）', async () => {
  const { status, json } = await api('/sources/stats');
  assert.equal(status, 200);

  const stats = json.data;
  assert.equal(stats.totalCount, TOTAL_FIXTURE_EVIDENCE);
  assert.equal(stats.missingCount, 1);
  // 1 ÷ 7 = 0.142857… → 保留 4 位
  assert.equal(stats.missingRate, 0.1429);
  assert.equal(stats.missingRateLabel, '14.29%');

  assert.deepEqual(stats.coverage, { internal: 4, external: 1, manual: 1, missing: 1 });
});

test('判定标准 1：0/0 语义 —— 范围内无证据时缺失率为 null 而非 0', async () => {
  const { json } = await api('/sources/stats?q=__no_such_evidence__');
  assert.equal(json.data.totalCount, 0);
  assert.equal(json.data.missingCount, 0);
  assert.equal(json.data.missingRate, null, '0/0 不得被读成「无缺失」');
  assert.equal(json.data.missingRateLabel, null);
});

test('判定标准 2：外部来源记录的「提供方」字段非空', async () => {
  const { json } = await api('/sources/stats');
  const criteria = json.data.criteria.externalProviderNonEmpty;

  assert.equal(criteria.externalCount, 1);
  assert.equal(criteria.providerNonEmptyCount, 1);
  assert.equal(criteria.satisfied, true);

  // 写入侧拒绝：缺提供方的外部数据不落库
  const rejected = await api(`/evidences/${MISSING_EVIDENCE}/source`, {
    method: 'PUT',
    body: {
      sourceType: 'external',
      sourceSystem: '外部行情数据平台',
      sourceDataTime: '2026-09-29T00:00:00+08:00',
    },
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.error.code, 'SOURCE_PROVIDER_REQUIRED');

  const blank = await api(`/evidences/${MISSING_EVIDENCE}/source`, {
    method: 'PUT',
    body: {
      sourceType: 'external',
      sourceSystem: '外部行情数据平台',
      sourceDataTime: '2026-09-29T00:00:00+08:00',
      sourceProvider: '   ',
    },
  });
  assert.equal(blank.status, 400, '空串等同于未标注提供方');
  assert.equal(blank.json.error.code, 'SOURCE_PROVIDER_REQUIRED');

  // 被拒绝后证据仍处于待补状态，缺失率不被污染
  const detail = await api(`/evidences/${MISSING_EVIDENCE}/source`);
  assert.equal(detail.json.data.sourceMissing, true);
});

test('判定标准 2：提供方非空由 DB CHECK 约束兜底（绕过接口也写不进非法数据）', async () => {
  await assert.rejects(
    pool.query(`UPDATE evidences SET source_provider = NULL WHERE id = $1`, [EXTERNAL_EVIDENCE]),
    /evidences_external_provider_required/,
    '外部来源的提供方为空应被数据库拒绝'
  );
});

test('判定标准 3：人工录入来源的 录入人、录入时间 均非空', async () => {
  const { json } = await api('/sources/stats');
  const criteria = json.data.criteria.manualTraceNonEmpty;

  assert.equal(criteria.manualCount, 1);
  assert.equal(criteria.traceNonEmptyCount, 1);
  assert.equal(criteria.satisfied, true);

  const noEnteredBy = await api(`/evidences/${MISSING_EVIDENCE}/source`, {
    method: 'PUT',
    body: {
      sourceType: 'manual',
      sourceSystem: '生产中心人工台账',
      sourceDataTime: '2026-09-29T00:00:00+08:00',
      enteredAt: '2026-09-29T10:00:00+08:00',
    },
  });
  assert.equal(noEnteredBy.status, 400);
  assert.equal(noEnteredBy.json.error.code, 'SOURCE_ENTERED_BY_REQUIRED');

  const noEnteredAt = await api(`/evidences/${MISSING_EVIDENCE}/source`, {
    method: 'PUT',
    body: {
      sourceType: 'manual',
      sourceSystem: '生产中心人工台账',
      sourceDataTime: '2026-09-29T00:00:00+08:00',
      enteredBy: '钱厂长',
    },
  });
  assert.equal(noEnteredAt.status, 400);
  assert.equal(noEnteredAt.json.error.code, 'SOURCE_ENTERED_AT_REQUIRED');
});

test('判定标准 3：录入人 / 录入时间非空由 DB CHECK 约束兜底', async () => {
  await assert.rejects(
    pool.query(`UPDATE evidences SET source_entered_by = NULL WHERE id = $1`, [MANUAL_EVIDENCE]),
    /evidences_manual_trace_required/
  );
  await assert.rejects(
    pool.query(`UPDATE evidences SET source_entered_at = NULL WHERE id = $1`, [MANUAL_EVIDENCE]),
    /evidences_manual_trace_required/
  );
});

// 上述「判定标准 2/3」只覆盖了**拒绝**路径（缺提供方 / 缺录入信息被拒），
// 未覆盖「合法输入是否真的落库」——写入侧字段名不一致时，接口会 200 但值被静默丢弃，
// 只在 DB CHECK 上才暴露成 500。以下三条补上成功路径与快照一致性。

test('写入：外部数据标注成功后提供方真正落库，且可被回读与统计', async () => {
  const created = await api('/evidences', {
    method: 'POST',
    body: {
      type: 'document',
      title: '临时：外部行情证据',
      formedAt: '2026-09-29T00:00:00+08:00',
      owner: '钱厂长',
    },
  });
  const id = created.json.data.evidence.id;

  try {
    const res = await api(`/evidences/${id}/source`, {
      method: 'PUT',
      body: {
        sourceType: 'external',
        sourceSystem: '外部行情平台',
        sourceDocumentNo: 'MKT-2026-0929',
        sourceDataTime: '2026-09-28T00:00:00+08:00',
        updateCycle: 'day',
        sourceProvider: '第三方行情机构',
      },
    });

    assert.equal(res.status, 200, JSON.stringify(res.json.error));
    assert.equal(res.json.data.sourceProvider, '第三方行情机构', '回包应带提供方');
    assert.equal(displayValue(res.json.data, 'sourceProvider'), '第三方行情机构', '明细字段应有值');
    assert.equal(res.json.data.audit.after.sourceProvider, '第三方行情机构', '留痕 after 应带提供方');

    const stored = await pool.query('SELECT source_provider, source_update_cycle FROM evidences WHERE id = $1', [id]);
    assert.equal(stored.rows[0].source_provider, '第三方行情机构', '提供方必须真的写进库');
    assert.equal(stored.rows[0].source_update_cycle, 'day');
  } finally {
    await removeEvidence(id);
  }
});

test('写入：人工录入标注成功后录入人与录入时间真正落库', async () => {
  const created = await api('/evidences', {
    method: 'POST',
    body: {
      type: 'manual_note',
      title: '临时：人工录入来源证据',
      formedAt: '2026-09-29T00:00:00+08:00',
      owner: '钱厂长',
      content: '线下登记',
    },
  });
  const id = created.json.data.evidence.id;

  try {
    const res = await api(`/evidences/${id}/source`, {
      method: 'PUT',
      body: {
        sourceType: 'manual',
        sourceSystem: '生产中心人工台账',
        sourceDataTime: '2026-09-28T00:00:00+08:00',
        updateCycle: 'week',
        enteredBy: '钱厂长',
        enteredAt: '2026-09-29T10:00:00+08:00',
      },
    });

    assert.equal(res.status, 200, JSON.stringify(res.json.error));
    const detail = await api(`/evidences/${id}/source`);
    assert.equal(detail.json.data.enteredBy, '钱厂长');
    assert.ok(detail.json.data.enteredAt, '录入时间应回传');
    // 场景 2 的追加字段只出现在 manualDisplay，不混进场景 1 的 display
    const manualEntry = detail.json.data.manualDisplay.find((f) => f.key === 'enteredBy');
    assert.equal(manualEntry.label, '录入人');
    assert.equal(manualEntry.value, '钱厂长');
    assert.equal(displayValue(detail.json.data, 'enteredBy'), undefined, 'display 只含场景 1 的四项字段');
    assert.equal(detail.json.data.manualDisplay.length, 2, '人工录入应有两条追加展示字段');
    assert.equal(detail.json.data.sourceProvider, null, '人工录入不要求提供方');
  } finally {
    await removeEvidence(id);
  }
});

test('留痕：更正来源时 before / after 快照字段名一致，可逐项对比', async () => {
  const created = await api('/evidences', {
    method: 'POST',
    body: {
      type: 'system_record',
      title: '临时：来源更正留痕',
      formedAt: '2026-09-29T00:00:00+08:00',
      owner: '钱厂长',
    },
  });
  const id = created.json.data.evidence.id;

  try {
    await api(`/evidences/${id}/source`, {
      method: 'PUT',
      body: {
        sourceType: 'internal',
        sourceSystem: 'ERP',
        sourceDataTime: '2026-09-28T00:00:00+08:00',
      },
    });
    const corrected = await api(`/evidences/${id}/source`, {
      method: 'PUT',
      body: {
        sourceType: 'internal',
        sourceSystem: 'MES',
        sourceDataTime: '2026-09-29T00:00:00+08:00',
      },
    });

    assert.equal(corrected.json.data.audit.action, 'evidence.source.update');
    assert.equal(corrected.json.data.audit.before.sourceSystem, 'ERP');
    assert.equal(corrected.json.data.audit.after.sourceSystem, 'MES');
    assert.deepEqual(
      Object.keys(corrected.json.data.audit.before).sort(),
      Object.keys(corrected.json.data.audit.after).sort(),
      'before / after 字段名必须一致，否则更正无法逐项对比'
    );
  } finally {
    await removeEvidence(id);
  }
});

test('来源不允许半截存在：缺来源系统或只有来源类别都被拒绝', async () => {
  // 接口层：缺来源系统
  const noSystem = await api(`/evidences/${MISSING_EVIDENCE}/source`, {
    method: 'PUT',
    body: { sourceType: 'internal', sourceDataTime: '2026-09-29T00:00:00+08:00' },
  });
  assert.equal(noSystem.status, 400);
  assert.equal(noSystem.json.error.code, 'SOURCE_SYSTEM_REQUIRED');

  // 存储层：只有类别没有来源系统
  await assert.rejects(
    pool.query(`UPDATE evidences SET source_type = 'internal' WHERE id = $1`, [MISSING_EVIDENCE]),
    /evidences_source_presence_check/
  );
  // 存储层：有来源系统但没有类别
  await assert.rejects(
    pool.query(`UPDATE evidences SET source_system = 'MES' WHERE id = $1`, [MISSING_EVIDENCE]),
    /evidences_source_presence_check/
  );
});

test('来源类别与更新周期取值受限（非法值被拒绝）', async () => {
  const badType = await api(`/evidences/${MISSING_EVIDENCE}/source`, {
    method: 'PUT',
    body: { sourceType: 'partner', sourceSystem: 'X', sourceDataTime: '2026-09-29T00:00:00+08:00' },
  });
  assert.equal(badType.status, 400);
  assert.equal(badType.json.error.code, 'SOURCE_TYPE_INVALID');
  assert.deepEqual(badType.json.error.details.allowed, ['internal', 'external', 'manual']);

  const badCycle = await api(`/evidences/${MISSING_EVIDENCE}/source`, {
    method: 'PUT',
    body: {
      sourceType: 'internal',
      sourceSystem: 'MES 生产执行系统',
      sourceDataTime: '2026-09-29T00:00:00+08:00',
      updateCycle: 'quarter',
    },
  });
  assert.equal(badCycle.status, 400);
  assert.equal(badCycle.json.error.code, 'SOURCE_UPDATE_CYCLE_INVALID');
});

// ------------------------------------------------------------------ 写入与留痕

test('写入：标注来源后该证据退出待补清单，缺失率随之下降', async () => {
  const before = (await api('/sources/stats')).json.data;

  const annotated = await api(`/evidences/${MISSING_EVIDENCE}/source`, {
    method: 'PUT',
    body: {
      sourceType: 'internal',
      sourceSystem: 'ERP 生产管理系统',
      sourceDocumentNo: 'GW-2026-0901',
      sourceDataTime: '2026-09-01T00:00:00+08:00',
      updateCycle: 'week',
    },
  });
  assert.equal(annotated.status, 200);
  assert.equal(annotated.json.data.sourceMissing, false);
  assert.equal(annotated.json.data.sourceTypeLabel, '内部系统');
  assert.deepEqual(annotated.json.data.pendingFields, [], '来源单据编号已补齐，无待补提示');

  const after = (await api('/sources/stats')).json.data;
  assert.equal(after.missingCount, before.missingCount - 1);
  assert.equal(after.totalCount, before.totalCount);
  assert.ok(after.missingRate < before.missingRate);

  const missing = await api('/sources/missing');
  assert.equal(missing.json.data.total, 0, '待补清单应已清空');
});

test('写入：首次标注记 annotate，更正来源记 update，且留痕与写入同事务', async () => {
  // 补回一条待补证据，用同一入口验证 annotate 留痕
  const fresh = await api('/evidences', {
    method: 'POST',
    body: {
      type: 'manual_note',
      title: '渠道库存盘点说明（9月）',
      formedAt: '2026-09-27T00:00:00+08:00',
      owner: '销售中心 / 孙渠道',
    },
  });
  const freshId = fresh.json.data.evidence.id;
  assert.equal(fresh.json.data.evidence.source.sourceMissing, true, '未给出 source 时进入待补状态');

  const annotated = await api(`/evidences/${freshId}/source`, {
    method: 'PUT',
    body: {
      sourceType: 'manual',
      sourceSystem: '销售中心人工台账',
      sourceDataTime: '2026-09-27T00:00:00+08:00',
      enteredBy: '孙渠道',
      enteredAt: '2026-09-27T14:20:00+08:00',
    },
  });
  assert.equal(annotated.status, 200);
  assert.equal(annotated.json.data.audit.action, 'evidence.source.annotate');
  assert.equal(annotated.json.data.audit.before, null, '首次标注无前值');
  assert.equal(annotated.json.data.audit.after.enteredBy, '孙渠道');

  // 同一证据再次更正 → 记 update，且 before 是上一次的值
  const corrected = await api(`/evidences/${freshId}/source`, {
    method: 'PUT',
    body: {
      sourceType: 'manual',
      sourceSystem: '销售中心人工台账',
      sourceDataTime: '2026-09-27T00:00:00+08:00',
      enteredBy: '孙渠道',
      enteredAt: '2026-09-28T09:00:00+08:00',
    },
  });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.json.data.audit.action, 'evidence.source.update');
  assert.equal(corrected.json.data.audit.before.enteredAt.slice(0, 10), '2026-09-27');
  assert.equal(corrected.json.data.audit.after.enteredAt.slice(0, 10), '2026-09-28');

  const { rows } = await pool.query(
    `SELECT action, count(*)::int AS n FROM audit_log
      WHERE entity_type = 'evidence' AND entity_id = $1
        AND action LIKE 'evidence.source.%'
      GROUP BY action ORDER BY action`,
    [freshId]
  );
  assert.deepEqual(rows, [
    { action: 'evidence.source.annotate', n: 1 },
    { action: 'evidence.source.update', n: 1 },
  ]);

  await removeEvidence(freshId);
});

test('写入：来源标注同样进入 audit_log（action 受限枚举已扩展）', async () => {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE entity_type = 'evidence' AND action = 'evidence.source.annotate'`
  );
  assert.ok(rows[0].n > 0, '夹具与接口写入的来源标注都应留痕');

  await assert.rejects(
    pool.query(
      `INSERT INTO audit_log (actor, actor_name, action, entity_type, entity_id)
       VALUES ('x', 'x', 'evidence.source.unknown', 'evidence', 'x')`
    ),
    /audit_log_action_check/,
    '留痕动作取值受限，未知动作写不进'
  );
});

test('写入：证据列表随证据带出来源摘要，缺失者带「来源缺失」标记', async () => {
  const detail = await api(`/evidences/${MANUAL_EVIDENCE}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.source.sourceMissing, false);
  assert.equal(detail.json.data.source.sourceTypeLabel, '人工录入');
  assert.equal(detail.json.data.source.sourceSystem, '生产中心人工台账');

  const missingOne = await api('/evidences', {
    method: 'POST',
    body: {
      type: 'contract',
      title: '临时合同（未标注来源）',
      formedAt: '2026-09-26T00:00:00+08:00',
      owner: '供应链中心 / 王采购',
    },
  });
  assert.equal(missingOne.json.data.evidence.source.sourceMissing, true);
  assert.equal(missingOne.json.data.evidence.source.missingMarker, '来源缺失');

  await removeEvidence(missingOne.json.data.evidence.id);
});

// ------------------------------------------------------------------ 鉴权与不存在

test('鉴权：写操作必须带 token；读操作按需鉴权', async () => {
  const unauthorized = await api(`/evidences/${MISSING_EVIDENCE}/source`, {
    method: 'PUT',
    auth: false,
    body: { sourceType: 'internal', sourceSystem: 'MES', sourceDataTime: '2026-09-29T00:00:00+08:00' },
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.json.error.code, 'AUTH_REQUIRED');

  const readOk = await api(`/evidences/${MISSING_EVIDENCE}/source`, { auth: false });
  assert.equal(readOk.status, 200);
});

test('不存在：证据不存在时明细与写入均返回 404', async () => {
  const ghost = '99999999-9999-4999-8999-999999999999';
  const read = await api(`/evidences/${ghost}/source`);
  assert.equal(read.status, 404);
  assert.equal(read.json.error.code, 'EVIDENCE_NOT_FOUND');

  const write = await api(`/evidences/${ghost}/source`, {
    method: 'PUT',
    body: { sourceType: 'internal', sourceSystem: 'MES', sourceDataTime: '2026-09-29T00:00:00+08:00' },
  });
  assert.equal(write.status, 404);
  assert.equal(write.json.error.code, 'EVIDENCE_NOT_FOUND');
});

test('一致性：来源类别注册表与数据库 CHECK 约束取值一致', async () => {
  const { rows } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'evidences_source_type_check'`
  );
  assert.equal(rows.length, 1, '约束必须存在（约束缺失即判定标准失去结构性保证）');

  const registered = Object.keys(SOURCE_TYPES);
  assert.deepEqual(registered, ['internal', 'external', 'manual']);
  for (const code of registered) {
    assert.ok(rows[0].def.includes(`'${code}'`), `DB 约束应包含来源类别 ${code}`);
  }
});
