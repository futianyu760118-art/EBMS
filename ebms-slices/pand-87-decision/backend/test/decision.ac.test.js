'use strict';

// PAND-87（F9 Decision 视图）AC 逐条验证 —— 走真实 HTTP 接口 + 真实数据库，不打桩。
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const TEST_DB = path.resolve(__dirname, '..', 'data', 'test-pand87.sqlite');
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_FILE = TEST_DB;

if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);

const { createApp } = require('../src/app');
const { seed } = require('../src/db/seed');
const { getDb, closeDb } = require('../src/db');

let server;
let base;

async function api(pathname, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function login(username) {
  const res = await api('/auth/login', {
    method: 'POST',
    body: { username, password: 'ebms@2026' },
  });
  assert.equal(res.status, 200, `${username} 登录应成功: ${JSON.stringify(res.json)}`);
  return res.json;
}

async function allDecisions(token) {
  const res = await api('/decisions?limit=100', { token });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json;
}

test.before(async () => {
  await seed();
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDb();
  if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);
});

// ---------------------------------------------------------------- 前置条件

test('前置条件：存在至少 1 条决策记录', async () => {
  const { token } = await login('dm');
  const list = await allDecisions(token);
  assert.ok(list.items.length >= 1, '决策记录数应 ≥ 1');
  assert.ok(list.summary.total >= 1);
});

// ------------------------------------------------------------------ 场景 1

test('场景 1：每条决策含 背景（关联结果/原因）· 候选方案（≥1）· 所需 Evidence · 结论 · 决策人 · 决策时间', async () => {
  const { token } = await login('dm');
  const list = await allDecisions(token);
  assert.ok(list.items.length >= 4);

  for (const item of list.items) {
    const { json: decision } = await api(`/decisions/${item.id}`, { token });

    // 背景：文字说明 + 关联的 Result / Reason
    assert.ok(decision.background && decision.background.trim(), `${decision.title} 背景非空`);
    assert.ok(decision.relatedRefs.length >= 1, `${decision.title} 背景应关联结果或原因`);
    for (const ref of decision.relatedRefs) {
      assert.ok(['result', 'reason'].includes(ref.type));
      assert.ok(['经营结果', '原因项'].includes(ref.typeLabel));
      assert.ok(ref.id && ref.label);
    }

    // 候选方案 ≥ 1 条
    assert.ok(decision.options.length >= 1, `${decision.title} 候选方案应 ≥ 1 条`);
    assert.ok(decision.options.every((o) => o.name && o.name.trim()));

    // 所需 Evidence：字段必存在（可为空 = 无需外部证据），引用项可核对是否齐备
    assert.ok(Array.isArray(decision.requiredEvidence), '所需 Evidence 字段必须存在');
    assert.equal(decision.evidenceSummary.required, decision.requiredEvidence.length);
    for (const evidence of decision.requiredEvidence) {
      assert.ok(evidence.id);
      assert.equal(typeof evidence.provided, 'boolean');
      if (evidence.provided) assert.ok(evidence.title, '已提供的证据应含标题');
    }

    // 决策人 / 决策时间：已决策条目必须非空（判定标准）
    if (decision.decided) {
      assert.ok(decision.conclusion && decision.conclusion.trim(), '已决策条目结论非空');
      assert.ok(decision.decider && decision.decider.trim(), '已决策条目决策人非空');
      assert.ok(decision.decidedAt && decision.decidedAt.trim(), '已决策条目决策时间非空');
      assert.equal(decision.statusLabel, '已决策');
    }
  }
});

test('场景 1（创建）：新建决策须齐备背景/候选方案/所需证据，初始为「待决策」', async () => {
  const { token } = await login('dm');
  const refs = await api('/decisions/refs', { token });
  assert.equal(refs.status, 200);
  const metricId = refs.json.results[0].id;
  const reasonId = refs.json.reasons[0].id;
  const evidenceId = refs.json.evidences[0].id;

  const created = await api('/decisions', {
    token,
    method: 'POST',
    body: {
      title: '自检新建决策',
      domain: 'production',
      background: '自检用背景说明',
      related_refs: [{ type: 'result', id: metricId }],
      options: [{ name: '方案甲', summary: '说明' }, { name: '方案乙' }],
      required_evidence_ids: [evidenceId],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const decision = created.json;

  assert.equal(decision.status, 'pending');
  assert.equal(decision.statusLabel, '待决策');
  assert.equal(decision.decided, false);
  assert.equal(decision.conclusion, null);
  assert.equal(decision.decider, null);
  assert.equal(decision.decidedAt, null);
  assert.equal(decision.options.length, 2);
  assert.equal(decision.requiredEvidence.length, 1);
  assert.equal(decision.requiredEvidence[0].provided, true);
  // 标签回填为权威名称（不采信前端传入的 label）
  assert.ok(decision.relatedRefs[0].label.length > 0);

  // 背景必须至少关联一条结果/原因
  const noRefs = await api('/decisions', {
    token,
    method: 'POST',
    body: { title: 'x', domain: 'production', background: 'b', options: [{ name: 'a' }] },
  });
  assert.equal(noRefs.status, 400);

  // 候选方案至少 1 条
  const noOptions = await api('/decisions', {
    token,
    method: 'POST',
    body: {
      title: 'x', domain: 'production', background: 'b',
      related_refs: [{ type: 'result', id: metricId }], options: [],
    },
  });
  assert.equal(noOptions.status, 400);

  // 引用不存在的结果/原因或证据应被拒绝
  const badRef = await api('/decisions', {
    token,
    method: 'POST',
    body: {
      title: 'x', domain: 'production', background: 'b',
      related_refs: [{ type: 'reason', id: 'no-such-reason' }], options: [{ name: 'a' }],
    },
  });
  assert.equal(badRef.status, 400);

  const badEvidence = await api('/decisions', {
    token,
    method: 'POST',
    body: {
      title: 'x', domain: 'production', background: 'b',
      related_refs: [{ type: 'result', id: metricId }], options: [{ name: 'a' }],
      required_evidence_ids: ['no-such-evidence'],
    },
  });
  assert.equal(badEvidence.status, 400);
});

// ------------------------------------------------------------------ 场景 2

test('场景 2：决策结论不可静默修改 —— 修改须留痕（变更人/时间/变更前后值）且必须给出变更理由', async () => {
  const { token } = await login('dm');
  const list = await allDecisions(token);
  // 种子中的 D1 已被修改过一次结论（含 before/after 留痕）
  const revisedSeed = list.items.find((d) => d.title.includes('追加产线投入'));
  assert.ok(revisedSeed, '种子应含一条结论被修改过的决策');
  // 列表页即展示变更计数（无需点进详情）
  assert.ok(revisedSeed.changeCount >= 2);
  assert.ok(revisedSeed.conclusionChangeCount >= 2, '列表中的结论变更次数应 ≥ 实际修改次数');

  const before = await api(`/decisions/${revisedSeed.id}`, { token });
  const seededChanges = before.json.changes.filter((c) => c.conclusionChanged);
  assert.equal(seededChanges.length, 2, '种子决策应有「形成结论 + 修改结论」两条结论变更记录');

  const revisedRecord = before.json.changes.find((c) => c.action === 'decision.revised');
  assert.ok(revisedRecord, '应存在一条 action=decision.revised 的变更记录');
  assert.ok(revisedRecord.changedByName && revisedRecord.changedByName.trim(), '变更人非空');
  assert.ok(revisedRecord.changedAt && revisedRecord.changedAt.trim(), '变更时间非空');
  assert.ok(revisedRecord.reason && revisedRecord.reason.trim(), '修改须记录变更理由');
  // 变更前后值
  assert.ok(revisedRecord.before.conclusion, '应记录变更前结论');
  assert.ok(revisedRecord.after.conclusion, '应记录变更后结论');
  assert.notEqual(revisedRecord.before.conclusion, revisedRecord.after.conclusion);
  assert.equal(revisedRecord.before.status, 'decided');
  assert.equal(revisedRecord.after.status, 'decided');

  // 静默修改被拒绝：已形成结论后再改，不带 reason → 400
  const silent = await api(`/decisions/${revisedSeed.id}/conclusion`, {
    token,
    method: 'PATCH',
    body: { conclusion: '试图静默修改的结论' },
  });
  assert.equal(silent.status, 400, '不带变更理由的结论修改应被拒绝');
  assert.match(silent.json.error.message, /不可静默修改/);

  // 带 reason 的修改成功，且新增留痕
  const initialCount = before.json.conclusionChangeCount;
  const initialTotal = before.json.changeCount;

  const ok = await api(`/decisions/${revisedSeed.id}/conclusion`, {
    token,
    method: 'PATCH',
    body: { conclusion: '经复评，改为直接追加一条产线以彻底消除产能瓶颈。', reason: 'Q4 预算提前释放，投资窗口打开。' },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));

  const after = ok.json;
  assert.equal(after.conclusionChangeCount, initialCount + 1, '每次结论修改都应新增一条结论变更记录');
  assert.ok(after.changeCount > initialTotal, '变更记录总数应增加');

  const last = after.changes[after.changes.length - 1];
  assert.equal(last.action, 'decision.revised');
  assert.equal(last.reason, 'Q4 预算提前释放，投资窗口打开。');
  assert.equal(last.before.conclusion, '先以加班与外部协作补产能，同时调整排产规则；追加产线留待 Q4 预算评审后再定。');
  assert.equal(last.after.conclusion, '经复评，改为直接追加一条产线以彻底消除产能瓶颈。');

  // 结论未变化 → 不产生虚假变更记录
  const noop = await api(`/decisions/${revisedSeed.id}/conclusion`, {
    token,
    method: 'PATCH',
    body: { conclusion: after.conclusion, reason: '重复提交' },
  });
  assert.equal(noop.status, 422);

  const finalState = await api(`/decisions/${revisedSeed.id}`, { token });
  assert.equal(finalState.json.conclusionChangeCount, initialCount + 1, '被拒绝的请求不得产生变更记录');
});

test('场景 2（判定）：变更记录条数 ≥ 实际修改次数', async () => {
  const { token } = await login('dm');
  const { json: created } = await api('/decisions', {
    token,
    method: 'POST',
    body: {
      title: '变更计数自检决策',
      domain: 'sales',
      background: '自检背景',
      related_refs: [{ type: 'result', id: (await api('/decisions/refs', { token })).json.results.find((x) => x.domain === 'sales').id }],
      options: [{ name: '唯一方案' }],
    },
  });

  const initial = created.conclusionChangeCount; // 0
  const modifications = 3;
  for (let i = 1; i <= modifications; i += 1) {
    const res = await api(`/decisions/${created.id}/conclusion`, {
      token,
      method: 'PATCH',
      body: i === 1
        ? { conclusion: '第 1 版结论' } // 首次形成结论，无需变更理由
        : { conclusion: `第 ${i} 版结论`, reason: `第 ${i} 次修改理由` },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
  }

  const final = await api(`/decisions/${created.id}`, { token });
  const changeCount = final.json.conclusionChangeCount;
  assert.equal(changeCount, initial + modifications);
  assert.ok(changeCount >= modifications, '变更记录条数应 ≥ 实际修改次数（含首次形成结论）');
  assert.ok(final.json.changeCount >= changeCount);
  // 每条结论变更记录都具备 变更人 / 变更时间
  for (const change of final.json.changes.filter((c) => c.conclusionChanged)) {
    assert.ok(change.changedByName);
    assert.ok(change.changedAt);
  }
});

// ------------------------------------------------------------------ 场景 3

test('场景 3：决策可关联其执行产生的 TODO，并可回看执行结果', async () => {
  const { token } = await login('dm');
  const list = await allDecisions(token);
  const seeded = list.items.find((d) => d.title.includes('追加产线投入'));
  const { json: decision } = await api(`/decisions/${seeded.id}`, { token });

  // 回看执行结果：执行 TODO 列表 + 完成进度 + 逾期标记
  assert.equal(decision.execution.total, 2, '该决策应关联 2 条执行 TODO');
  assert.equal(decision.execution.done, 1, '应有 1 条执行 TODO 已完成');
  assert.equal(decision.execution.progressPct, 50);
  assert.ok(decision.execution.items.every((t) => t.title && t.statusLabel));
  const doneItem = decision.execution.items.find((t) => t.status === 'done');
  assert.equal(doneItem.statusLabel, '已完成');
  assert.ok(doneItem.history.length >= 1, '执行结果应可回看留痕轨迹');
  assert.ok(doneItem.relatedRefs.length >= 1, '执行 TODO 应携带决策背景关联');

  // 关联一条已有 TODO
  const allTodos = await api('/decisions/refs', { token }); // 仅用于确认接口可用
  assert.equal(allTodos.status, 200);

  const linkExisting = await api(`/decisions/${seeded.id}/execution-todos`, {
    token,
    method: 'POST',
    body: { todo_ids: [decision.execution.items[0].id] },
  });
  assert.equal(linkExisting.status, 200);
  assert.deepEqual(linkExisting.json.skipped, [decision.execution.items[0].id], '重复关联应被跳过');
  assert.equal(linkExisting.json.execution.total, 2);

  // 由决策派发新的执行 TODO（F8 口径：source=manual，必须指定责任人）
  const dispatched = await api(`/decisions/${seeded.id}/execution-todos`, {
    token,
    method: 'POST',
    body: {
      todos: [
        { title: '跟踪外部协作产能到位情况', owner: '李生产', due_at: '2026-10-31T18:00:00+08:00' },
      ],
    },
  });
  assert.equal(dispatched.status, 200, JSON.stringify(dispatched.json));
  assert.equal(dispatched.json.execution.total, 3);
  assert.equal(dispatched.json.linked.length, 1);

  const dispatchedTodo = dispatched.json.execution.items.find((t) => t.title === '跟踪外部协作产能到位情况');
  assert.ok(dispatchedTodo, '派发的执行 TODO 应出现在执行结果中');
  assert.equal(dispatchedTodo.source, 'manual');
  assert.equal(dispatchedTodo.sourceLabel, '人工派发');
  assert.equal(dispatchedTodo.owner, '李生产');
  assert.equal(dispatchedTodo.status, 'pending');

  // 派发 TODO 必须指定责任人
  const noOwner = await api(`/decisions/${seeded.id}/execution-todos`, {
    token,
    method: 'POST',
    body: { todos: [{ title: '缺责任人', due_at: '2026-10-31T18:00:00+08:00' }] },
  });
  assert.equal(noOwner.status, 400);

  // 关联/派发均产生留痕
  const afterLink = await api(`/decisions/${seeded.id}`, { token });
  const linkChanges = afterLink.json.changes.filter((c) => c.action === 'decision.todo_linked');
  assert.ok(linkChanges.length >= 1, '关联执行 TODO 应留痕');
  assert.ok(linkChanges[linkChanges.length - 1].after.execution_todo_ids.length >= 3);

  // 解除关联：执行结果减少且留痕
  const beforeUnlink = afterLink.json.changeCount;
  const unlinked = await api(
    `/decisions/${seeded.id}/execution-todos/${dispatchedTodo.id}`,
    { token, method: 'DELETE' }
  );
  assert.equal(unlinked.status, 200);
  assert.equal(unlinked.json.execution.total, 2);
  assert.ok(unlinked.json.changeCount > beforeUnlink, '解除关联应留痕');
  assert.ok(unlinked.json.changes.some((c) => c.action === 'decision.todo_unlinked'));

  const unlinkAgain = await api(
    `/decisions/${seeded.id}/execution-todos/${dispatchedTodo.id}`,
    { token, method: 'DELETE' }
  );
  assert.equal(unlinkAgain.status, 404);
});

// -------------------------------------------------------------------- 边界

test('边界：未形成结论的记录状态为「待决策」，不计入已决策数量', async () => {
  const { token } = await login('dm');
  const list = await allDecisions(token);

  const pending = list.items.filter((d) => d.status === 'pending');
  assert.ok(pending.length >= 1, '种子应含至少 1 条待决策记录');
  for (const item of pending) {
    assert.equal(item.statusLabel, '待决策');
    assert.equal(item.decided, false);
    assert.equal(item.countsAsDecided, false);
    assert.equal(item.conclusion, null);
    assert.equal(item.decider, null);
    assert.equal(item.decidedAt, null);
  }

  // 已决策数量 = 已决策条目数，待决策不计入
  const decidedItems = list.items.filter((d) => d.status === 'decided');
  assert.equal(list.summary.decided, decidedItems.length);
  assert.equal(list.summary.pending, pending.length);
  assert.equal(list.summary.total, list.summary.decided + list.summary.pending);

  // 按状态筛选：待决策与已决策互斥且并集为全量
  const onlyPending = await api('/decisions?status=pending&limit=100', { token });
  assert.equal(onlyPending.json.items.length, pending.length);
  assert.ok(onlyPending.json.items.every((d) => d.status === 'pending'));

  const onlyDecided = await api('/decisions?status=decided&limit=100', { token });
  assert.equal(onlyDecided.json.items.length, decidedItems.length);
  assert.ok(onlyDecided.json.items.every((d) => d.status === 'decided'));

  // DB 层兜底：待决策记录不得带结论/决策人/决策时间
  const db = getDb();
  const { rows } = await db.query(
    `SELECT COUNT(*) AS total FROM decisions
      WHERE status = 'pending'
        AND (conclusion IS NOT NULL OR decider IS NOT NULL OR decided_at IS NOT NULL)`
  );
  assert.equal(Number(rows[0].total), 0, '待决策记录不得带结论/决策人/决策时间');

  // 已决策条目：决策人、决策时间 均非空（判定标准）
  const { rows: decidedRows } = await db.query(
    `SELECT COUNT(*) AS total FROM decisions
      WHERE status = 'decided'
        AND (decider IS NULL OR trim(decider) = '' OR decided_at IS NULL OR trim(decided_at) = '')`
  );
  assert.equal(Number(decidedRows[0].total), 0, '已决策条目的决策人与决策时间必须非空');
});

test('边界：不强制决策效果评价（可关联执行 TODO 并回看结果即可）', async () => {
  const { token } = await login('dm');
  const list = await allDecisions(token);
  const seeded = list.items.find((d) => d.title.includes('追加产线投入'));
  const { json: decision } = await api(`/decisions/${seeded.id}`, { token });

  // 决策在其执行 TODO 尚未全部完成时同样成立为「已决策」，无需先做效果评价
  assert.equal(decision.decided, true);
  assert.ok(decision.execution.done < decision.execution.total);
  assert.equal(decision.effects, undefined, '不引入效果评价字段');
  assert.equal(decision.effectEvaluation, undefined);
  assert.match(decision.execution.note, /不强制/);
});

test('边界：数据库层兜底「已决策不变量」（已决策缺决策人/时间不可写入）', async () => {
  const db = getDb();
  await assert.rejects(
    () =>
      db.execute(
        `INSERT INTO decisions
           (id, title, domain, background, related_refs, options, required_evidence_ids,
            conclusion, status, decider, decider_id, decided_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ 'malformed-decision', 't', 'sales', 'b', '[]', '[]', '[]',
          '有结论', 'decided', null, null, null, 'x', 'now', 'now' ]
      ),
    /CHECK|constraint/i,
    '已决策但缺决策人/决策时间应被数据库约束拒绝'
  );

  await assert.rejects(
    () =>
      db.execute(
        `INSERT INTO decisions
           (id, title, domain, background, related_refs, options, required_evidence_ids,
            conclusion, status, decider, decider_id, decided_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ 'malformed-pending', 't', 'sales', 'b', '[]', '[]', '[]',
          null, 'pending', '张决策', null, '2026-09-30T00:00:00Z', 'x', 'now', 'now' ]
      ),
    /CHECK|constraint/i,
    '待决策却带决策人应被数据库约束拒绝'
  );
});

// ------------------------------------------------------ 判定标准 / 数据范围

test('判定标准：全部已决策条目 决策人、决策时间 非空', async () => {
  const { token } = await login('dm');
  const list = await allDecisions(token);
  const decided = list.items.filter((d) => d.status === 'decided');
  assert.ok(decided.length >= 1);
  for (const item of decided) {
    const { json: decision } = await api(`/decisions/${item.id}`, { token });
    assert.equal(decision.decidedFieldsPresent, true, `${decision.title} 应有决策人与决策时间`);
    assert.ok(decision.decider.trim());
    assert.ok(decision.decidedAt.trim());
  }
});

test('数据范围：管理责任人仅见本责任域决策，决策者见全企业', async () => {
  const owner = await login('owner_sales');
  const ownerList = await api('/decisions?limit=100', { token: owner.token });
  assert.equal(ownerList.status, 200);
  assert.ok(ownerList.json.items.length >= 1);
  assert.ok(ownerList.json.items.every((d) => d.domain === 'sales'), '管理责任人不应看到责任域外决策');

  const dm = await login('dm');
  const dmList = await allDecisions(dm.token);
  assert.ok(dmList.summary.total > ownerList.json.summary.total, '决策者可见范围应更宽');

  // 责任域外决策详情不可读
  const other = dmList.items.find((d) => d.domain === 'production');
  const denied = await api(`/decisions/${other.id}`, { token: owner.token });
  assert.equal(denied.status, 403);

  // 不可创建非本责任域决策
  const forbiddenCreate = await api('/decisions', {
    token: owner.token,
    method: 'POST',
    body: {
      title: '越权创建', domain: 'finance', background: 'b',
      related_refs: [{ type: 'result', id: (await api('/decisions/refs', { token: dm.token })).json.results[0].id }],
      options: [{ name: 'a' }],
    },
  });
  assert.equal(forbiddenCreate.status, 403);
});

test('未登录不可访问 Decision 视图；无角色账号不进入主体功能', async () => {
  const anonymous = await api('/decisions');
  assert.equal(anonymous.status, 401);

  const noRole = await login('no_role');
  assert.equal(noRole.landing.view, null);
  assert.ok(noRole.landing.notice, '无角色账号应给出明确提示');

  const decisionMaker = await login('dm');
  assert.ok(decisionMaker.landing.availableViews.includes('decision'));
});

test('列表筛选：状态与责任域为「与」关系', async () => {
  const { token } = await login('dm');

  const production = await api('/decisions?domain=production&limit=100', { token });
  assert.ok(production.json.items.length >= 2);
  assert.ok(production.json.items.every((d) => d.domain === 'production'));

  const combined = await api('/decisions?domain=production&status=pending&limit=100', { token });
  assert.ok(combined.json.items.length >= 1);
  assert.ok(combined.json.items.every((d) => d.domain === 'production' && d.status === 'pending'));

  const empty = await api('/decisions?domain=sales&status=pending&limit=100', { token });
  assert.equal(empty.json.items.length, 0);
  assert.equal(empty.json.paging.total, 0);

  const badStatus = await api('/decisions?status=unknown', { token });
  assert.equal(badStatus.status, 400);

  const notFound = await api('/decisions/does-not-exist', { token });
  assert.equal(notFound.status, 404);
});
