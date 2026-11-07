/**
 * M10 POMS 微系统对接回归测试（隔离数据目录，不触碰生产 sales.db）。
 *
 * 运行：node scripts/m10-integration-regression.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebms-m10-'));
process.env.EBMS_DATA_DIR = tempDir;
process.env.USE_JSON_DB = '1';
process.env.M10_PARTNER_TOKEN = 'test-m10-token';
process.env.M10_PORTAL_URL = 'http://m10.local/';

const { getTable } = require('../backend/db');
const C = require('../backend/lib/m10-contract');
const store = require('../backend/lib/m10-store');
const service = require('../backend/lib/m10-service');
const H = require('../backend/lib/m10-http');

async function seed(table, records) {
  const t = getTable(table);
  for (const r of records) await t.insert(Object.assign({}, r));
  return t;
}

function itemById(items, slug, id) {
  return items.find(x => x.work_item_id === C.workItemId(slug, id));
}

async function main() {
  // ---- 夹具：人员 / 组织 / 角色 / 管理行动 ----
  await seed('users', [{ username: 'zhangsan', password: 'x', name: '张三', role: 'sales_manager' }]);
  await seed('org_personnel', [{
    emp_code: 'E001', name: '张三', linked_user_id: 1,
    position_name: '销售经理', department_name: '销售部', status: 'active'
  }]);
  await seed('roles', [{ code: 'sales_manager', name: '销售经理' }]);
  await seed('user_roles', [{ user_id: 1, role_id: 1 }]);

  const sop = await seed('sop_actions', [
    {
      action_code: 'ACT-T-001', description: '采购准交率告警', owner_name: '张三',
      owner_role: 'PURCHASE_HEAD', due_date: '2026-01-01', priority: 'P0',
      status: 'PENDING', source_system: 'SOP', created_at: '2026-01-01 00:00:00'
    },
    {
      action_code: 'ACT-T-002', description: '销售预测偏差纠正', owner_name: '',
      owner_role: 'SALES_DIRECTOR', due_date: '2026-12-31', priority: 'P1',
      status: 'PENDING', source_system: 'SOP_AUTO', created_at: '2026-01-01 00:00:00'
    },
    {
      action_code: 'ACT-T-003', description: '他人的行动项', owner_name: '李四',
      owner_role: 'QUALITY_HEAD', due_date: '2026-12-31', priority: 'P1',
      status: 'PENDING', source_system: 'SOP', created_at: '2026-01-01 00:00:00'
    },
    {
      action_code: 'ACT-T-004', description: '已完成并留证的行动', owner_name: '张三',
      owner_role: 'DEPT_HEAD', due_date: '2025-12-31', priority: 'P0',
      status: 'CLOSED', evidence_url: 'https://ebms.local/evidence/4.pdf',
      closed_at: '2026-02-01 10:00:00', source_system: 'SOP', created_at: '2026-01-01 00:00:00'
    }
  ]);
  const ownSopId = sop.all().find(r => r.action_code === 'ACT-T-001').id;
  const roleSopId = sop.all().find(r => r.action_code === 'ACT-T-002').id;
  const otherSopId = sop.all().find(r => r.action_code === 'ACT-T-003').id;
  const closedSopId = sop.all().find(r => r.action_code === 'ACT-T-004').id;

  await seed('ai_actions', [{
    title: '核价超时行动', content: '1 个核价超 5 天未完成', assignee: '张三',
    priority: 'medium', deadline: '2026-12-31', user: 'admin',
    status: 'pending', created_at: '2026-01-01 00:00:00'
  }]);
  await seed('chat_action_items', [{
    content: '跟催客户询价', assignee: '张三', priority: '高',
    status: 'pending', created_at: '2026-01-01 00:00:00'
  }]);

  // ---- 人员解析 ----
  const person = service.resolvePerson({ person_id: 'E001' });
  assert.ok(person, '工号 E001 应能解析到 EBMS 人员');
  assert.equal(person.ebms_user_id, 1);
  assert.equal(person.name, '张三');
  assert.ok(person.role_codes.includes('sales_manager'));

  const personByStableId = service.resolvePerson({ person_id: 'ebms:user:1' });
  assert.ok(personByStableId, 'EBMS 输出的 ebms:user:<id> 应可反解');
  assert.equal(personByStableId.ebms_user_id, 1);

  // ---- 工作台 manifest ----
  const workspace = service.buildWorkspace(person);
  assert.equal(workspace.contract_version, C.CONTRACT_VERSION);
  assert.equal(workspace.source, 'ebms');
  assert.equal(workspace.person_unmapped, false);
  assert.equal(workspace.portal_url, 'http://m10.local/');
  assert.ok(workspace.actions.includes('ebms.work_item.complete'));
  assert.ok(workspace.actions.includes('ebms.portal.open'));
  const todoWidget = workspace.widgets.find(w => w.id === 'future_todos');
  assert.ok(todoWidget, '必须下发 future_todos 部件');
  assert.equal(todoWidget.count, 4, '本人 + 角色映射 + AI 行动 + 会话行动项，共 4 条未完成');
  assert.ok(todoWidget.summary.overdue >= 1, '应识别逾期项');

  // ---- 工作项过滤与映射 ----
  const items = service.collectWorkItems(person, {});
  assert.equal(items.length, 4);
  assert.ok(itemById(items, 'sop_action', ownSopId), '本人负责的 SOP 行动必须可见');
  assert.ok(itemById(items, 'sop_action', roleSopId), '角色映射命中的 SOP 行动必须可见');
  assert.ok(!itemById(items, 'sop_action', otherSopId), '他人行动不得出现在个人工作项');
  assert.ok(itemById(items, 'ai_action', 1), 'AI 行动必须接入');
  assert.ok(itemById(items, 'chat_action_item', 1), '会话行动项必须接入');

  const ownItem = itemById(items, 'sop_action', ownSopId);
  assert.equal(ownItem.source_system, 'M03');
  assert.equal(ownItem.source_object_type, 'SopAction');
  assert.equal(ownItem.display_status, 'pending');
  assert.ok(ownItem.deep_link.includes('/sop.html?actionId='));
  assert.equal(ownItem.overdue, true);

  // ---- 结果引用 ----
  const results = service.collectResults(person, {});
  assert.equal(results.length, 1);
  assert.equal(results[0].source_object_id, String(closedSopId));
  assert.equal(results[0].verification, 'pending', '仅有证据不等于管理侧已验证（done != verified）');
  assert.deepEqual(results[0].evidence_refs, ['https://ebms.local/evidence/4.pdf']);

  // ---- 执行反馈：完成并留证 ----
  const envelope = C.validateFeedback({
    feedback_id: 'fb-test-001',
    idempotency_key: 'idem-test-001',
    person_id: 'E001',
    items: [{
      work_item_id: C.workItemId('sop_action', ownSopId),
      status: 'done',
      evidence_refs: ['https://ebms.local/evidence/act-1.pdf'],
      remark: '已复盘并锁定替代料',
      completed_at: '2026-03-01T09:00:00+08:00'
    }]
  });
  assert.equal(envelope.ok, true, '反馈报文应通过契约校验');

  return service.applyFeedback(envelope.value, person, {}).then(r1 => {
    assert.equal(r1.result, 'applied');
    assert.equal(r1.applied, 1);
    const row = getTable('sop_actions').findById(ownSopId);
    assert.equal(row.status, 'CLOSED', '反馈完成应回写原 SOP Action 状态');
    assert.equal(row.evidence_url, 'https://ebms.local/evidence/act-1.pdf');
    assert.equal(row.remark, '已复盘并锁定替代料');
    assert.ok(row.closed_at);

    // 幂等：同一 feedback_id 重放不产生第二条源数据变更
    return service.applyFeedback(envelope.value, person, {});
  }).then(r2 => {
    assert.equal(r2.result, 'skipped');
    assert.equal(r2.duplicate, true);
    assert.equal(store.feedbackCounts().total, 1, '重复反馈不得重复记账');

    // 越权：把他人行动标记完成必须被拒绝
    const otherEnv = C.validateFeedback({
      feedback_id: 'fb-test-002',
      person_id: 'E001',
      items: [{ work_item_id: C.workItemId('sop_action', otherSopId), status: 'done' }]
    });
    return service.applyFeedback(otherEnv.value, person, {});
  }).then(async r3 => {
    assert.equal(r3.result, 'conflict');
    assert.equal(r3.conflicts, 1);
    assert.equal(getTable('sop_actions').findById(otherSopId).status, 'PENDING', '越权反馈不得改变原单据');

    // 机器通道 fail-closed / 鉴权
    const noToken = H.handlePartnerWorkItems({ person_id: 'E001' }, {});
    assert.equal(noToken.status, 401, '缺少 token 必须 401');

    const wrongToken = H.handlePartnerWorkItems({ person_id: 'E001' }, { authorization: 'Bearer wrong' });
    assert.equal(wrongToken.status, 401, '错误 token 必须 401');

    const okToken = H.handlePartnerWorkItems({ person_id: 'E001' }, { authorization: 'Bearer test-m10-token' });
    assert.equal(okToken.status, 200);
    assert.ok(Array.isArray(okToken.body.items));

    const partnerStatus = H.handlePartnerStatus({ authorization: 'Bearer test-m10-token' });
    assert.equal(partnerStatus.status, 200);
    assert.equal(partnerStatus.body.contract_version, C.CONTRACT_VERSION);
    assert.equal(partnerStatus.body.enabled, true);

    const unmapped = H.handlePartnerWorkspace({ person_id: 'p-unmapped' }, { authorization: 'Bearer test-m10-token' });
    assert.equal(unmapped.status, 200);
    assert.equal(unmapped.body.person_unmapped, true);
    assert.equal(unmapped.body.widgets[0].count, 0, '未映射人员不得回退为全量待办');

    const viaHttp = await H.handlePartnerFeedback(
      { authorization: 'Bearer test-m10-token' },
      {
        feedback_id: 'fb-http-001',
        person_id: 'E001',
        items: [{
          work_item_id: C.workItemId('sop_action', roleSopId),
          status: 'in_progress',
          remark: '已开始处理'
        }]
      },
      '127.0.0.1'
    );
    assert.equal(viaHttp.status, 200);
    assert.equal(viaHttp.body.result, 'applied');
    assert.equal(getTable('sop_actions').findById(roleSopId).status, 'IN_PROGRESS');

    const replay = await H.handlePartnerFeedback(
      { authorization: 'Bearer test-m10-token' },
      {
        feedback_id: 'fb-http-001',
        person_id: 'E001',
        items: [{
          work_item_id: C.workItemId('sop_action', roleSopId),
          status: 'in_progress'
        }]
      },
      '127.0.0.1'
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.body.result, 'skipped');
    assert.equal(replay.body.duplicate, true);

    delete process.env.M10_PARTNER_TOKEN;
    const unconfigured = H.handlePartnerWorkItems({ person_id: 'E001' }, { authorization: 'Bearer any' });
    assert.equal(unconfigured.status, 503, '未配置 M10_PARTNER_TOKEN 必须 fail-closed 503');
    process.env.M10_PARTNER_TOKEN = 'test-m10-token';

    // 契约示例与 schema 可解析
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', 'm10-poms-v1.schema.json'), 'utf8'));
    assert.equal(schema.contract_version, C.CONTRACT_VERSION);
    const examples = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', 'm10-poms-v1.examples.json'), 'utf8'));
    assert.equal(examples.workspace.contract_version, C.CONTRACT_VERSION);
    assert.equal(C.validateFeedback(examples.feedback).ok, true, '契约示例必须通过校验');

    const routeIndex = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'index.js'), 'utf8');
    assert.match(routeIndex, /router\.use\('\/m10',\s*require\('\.\/m10'\)\)/, 'M10 路由必须挂载到 /api/m10');
    const navSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'permission-check.js'), 'utf8');
    assert.match(navSource, /href:\s*'m10\.html'/, '微系统页面必须进入导航');

    const link = await H.handleUpsertPersonLink({ m10_person_id: 'p-002', ebms_user_id: 1, name: '张三' });
    assert.equal(link.status, 200);
    const linkedPerson = service.resolvePerson({ person_id: 'p-002' });
    assert.equal(linkedPerson.ebms_user_id, 1, 'M10 人员映射应能解析到 EBMS 用户');
    const badLink = await H.handleUpsertPersonLink({ m10_person_id: 'p-404', ebms_user_id: 99999 });
    assert.equal(badLink.status, 422, '不存在的 EBMS 用户不得写入人员映射');

    console.log('M10 POMS integration regression checks passed');
  });
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
});
