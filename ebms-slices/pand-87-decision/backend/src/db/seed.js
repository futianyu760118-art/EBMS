'use strict';

// 演示/自检数据：覆盖 PAND-87（F9 Decision 视图）的全部 AC 场景与边界。
//   前置    存在至少 1 条决策记录
//   场景 1  每条含 背景（关联结果/原因）+ 候选方案（≥1）+ 所需 Evidence + 结论 + 决策人 + 决策时间
//   场景 2  结论不可静默修改 —— 存在一条被修改过结论的决策，且留痕含变更人/时间/变更前后值
//   场景 3  决策关联其执行产生的 TODO，并可回看执行结果（含已完成的执行项）
//   边界    未形成结论的记录为「待决策」，不计入已决策数量；不做决策效果评价
const { getDb, closeDb, schemaText } = require('./index');
const { hashPassword } = require('../lib/password');
const { newId, nowIso } = require('../lib/domain');
const { DECISION_CHANGE_ACTION } = require('../lib/decision-status');

const PASSWORD = process.env.EBMS_SEED_PASSWORD || 'ebms@2026';

// FK / 依赖顺序（先删子表）
const TABLES = [
  'decision_changes',
  'object_links',
  'audit_log',
  'decisions',
  'todos',
  'evidences',
  'result_reasons',
  'result_metrics',
  'role_scope',
  'user_roles',
  'roles',
  'users',
];

function deviation(target, actual) {
  if (target === null || actual === null) return { abs: null, pct: null };
  const abs = Math.round((actual - target) * 100) / 100;
  const pct = target === 0 ? null : Math.round(((actual - target) / target) * 10000) / 100;
  return { abs, pct };
}

async function seed() {
  const db = getDb();
  await db.runScript(schemaText(db.dialect));

  for (const table of TABLES) {
    await db.execute(`DELETE FROM ${table}`);
  }

  const at = nowIso();
  const days = (n) => new Date(Date.now() + n * 24 * 3600 * 1000).toISOString();
  // 演示数据的时间一律相对「当前」生成：绝对日期会随时间推移变成未来时间，
  // 使「决策早于其背景数据」这类时序关系失真。
  const ago = (n) => days(-n);

  // ---- 角色与账号 -------------------------------------------------------
  const roleDecision = newId();
  const roleOwner = newId();
  await db.execute('INSERT INTO roles (id, code, name) VALUES (?, ?, ?)', [roleDecision, 'decision_maker', '决策者']);
  await db.execute('INSERT INTO roles (id, code, name) VALUES (?, ?, ?)', [roleOwner, 'domain_owner', '管理责任人']);
  await db.execute('INSERT INTO role_scope (id, role_id, scope_type, scope_value) VALUES (?, ?, ?, ?)', [
    newId(), roleDecision, 'enterprise', '*',
  ]);
  // 管理责任人：责任域 = 销售（验证数据范围：看不到生产/财务域决策）
  await db.execute('INSERT INTO role_scope (id, role_id, scope_type, scope_value) VALUES (?, ?, ?, ?)', [
    newId(), roleOwner, 'domain', 'sales',
  ]);

  const users = [
    { id: newId(), username: 'dm', displayName: '张决策', roles: [roleDecision] },
    { id: newId(), username: 'owner_sales', displayName: '赵销售', roles: [roleOwner] },
    { id: newId(), username: 'no_role', displayName: '未配置角色账号', roles: [] },
  ];
  for (const u of users) {
    await db.execute(
      'INSERT INTO users (id, username, display_name, password_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [u.id, u.username, u.displayName, hashPassword(PASSWORD), 'active', at]
    );
    for (const roleId of u.roles) {
      await db.execute('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [u.id, roleId]);
    }
  }
  const dm = users[0];

  // ---- 经营结果指标（F1 域，决策「背景」只读取不重算）-------------------
  const m = {};
  const metrics = [
    { key: 'delivery', code: 'delivery', name: '订单交付率', dimension: 'business', domain: 'production', unit: '%', target: 95, actual: 87, threshold: 3, asOf: ago(10) },
    { key: 'revenue', code: 'revenue', name: '营业收入', dimension: 'finance', domain: 'finance', unit: '万元', target: 12000, actual: 10860, threshold: 5, asOf: ago(10) },
    { key: 'orders', code: 'orders', name: '新增订单', dimension: 'business', domain: 'sales', unit: '单', target: 320, actual: 288, threshold: 5, asOf: ago(10) },
    { key: 'cash', code: 'cash', name: '经营性现金流', dimension: 'finance', domain: 'finance', unit: '万元', target: 2000, actual: 1580, threshold: 5, asOf: ago(10) },
  ];
  for (const def of metrics) {
    const id = newId();
    m[def.key] = id;
    const dev = deviation(def.target, def.actual);
    await db.execute(
      `INSERT INTO result_metrics
         (id, code, name, dimension, domain, period_type, period_value, target, actual, unit,
          deviation_abs, deviation_pct, data_status, missing_reason, threshold, as_of, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, def.code, def.name, def.dimension, def.domain, 'month', '2026-09', def.target, def.actual,
       def.unit, dev.abs, dev.pct, 'ok', null, def.threshold, def.asOf, at]
    );
  }

  // ---- 原因项（F2 域）---------------------------------------------------
  const r = {};
  const reasons = [
    { key: 'capacity', metric: 'delivery', name: '产能不足', direction: 'negative', contribution_pct: 40, owner: '生产/交付' },
    { key: 'scheduling', metric: 'delivery', name: '排产冲突', direction: 'negative', contribution_pct: 25, owner: '生产/交付' },
    { key: 'churn', metric: 'revenue', name: '大客户流失', direction: 'negative', contribution_pct: 55, owner: '销售' },
    { key: 'demand', metric: 'orders', name: '需求季节性回落', direction: 'negative', contribution_pct: 62, owner: '销售' },
  ];
  let order = 0;
  for (const def of reasons) {
    const id = newId();
    r[def.key] = id;
    await db.execute(
      `INSERT INTO result_reasons
         (id, metric_id, parent_id, name, direction, contribution_pct, owner, order_no, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, m[def.metric], null, def.name, def.direction, def.contribution_pct, def.owner, order++, at]
    );
  }

  // ---- 证据（F3 域）：覆盖已确认四类 --------------------------------
  const e = {};
  const evidences = [
    { key: 'erp', type: 'system_record', title: 'ERP 交付达成明细（2026-09）', owner: '生产中心', formedAt: ago(6) },
    { key: 'overtime', type: 'manual', title: '车间加班排班说明', owner: '生产责任人', formedAt: ago(8) },
    { key: 'churnReport', type: 'contract', title: '大客户年度框架协议（变更条款）', owner: '销售中心', formedAt: ago(12) },
    { key: 'capacityBudget', type: 'document', title: '产能扩充投资预算书', owner: '生产中心', formedAt: ago(9) },
  ];
  for (const def of evidences) {
    const id = newId();
    e[def.key] = id;
    await db.execute(
      'INSERT INTO evidences (id, type, title, formed_at, owner, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, def.type, def.title, def.formedAt, def.owner, at]
    );
  }

  // ---- TODO（F8 域）：决策执行产生的 TODO + 流转留痕 ------------------
  const t = {};
  // 由决策派发的执行 TODO 携带该决策的背景关联（F9 场景 3 口径：执行项可回溯到决策依据）
  const todos = [
    { key: 't1', title: '交付线加班与外部协作补产能', owner: '李生产', due_at: days(-5), status: 'done',
      relatedRefs: [{ type: 'result', id: m.delivery, label: '订单交付率' }, { type: 'reason', id: r.capacity, label: '产能不足' }] },
    { key: 't2', title: '排产冲突专项复盘并固化排产规则', owner: '李生产', due_at: days(-2), status: 'in_progress',
      relatedRefs: [{ type: 'result', id: m.delivery, label: '订单交付率' }, { type: 'reason', id: r.scheduling, label: '排产冲突' }] },
    { key: 't3', title: '大客户流失复盘与挽回方案', owner: '赵销售', due_at: days(-1), status: 'pending',
      relatedRefs: [{ type: 'result', id: m.orders, label: '新增订单' }, { type: 'reason', id: r.churn, label: '大客户流失' }] },
    { key: 't4', title: '补齐财务中心现金流同步通道', owner: '王财务', due_at: days(-6), status: 'done',
      relatedRefs: [{ type: 'result', id: m.cash, label: '经营性现金流' }] },
    // 未被任何决策关联的 TODO：证明执行列表是决策关联的子集
    { key: 't5', title: '存货周转口径与年度计划对齐', owner: '供应链责任人', due_at: days(7), status: 'pending',
      relatedRefs: [] },
  ];
  for (const def of todos) {
    const id = newId();
    t[def.key] = id;
    await db.execute(
      `INSERT INTO todos
         (id, title, source, trigger_basis, related_refs, owner, due_at, status, rule_key,
          created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, def.title, 'manual', null, JSON.stringify(def.relatedRefs || []), def.owner, def.due_at, def.status, null,
       dm.id, at, at]
    );
    // 执行轨迹（回看执行结果时展示）
    await db.execute(
      `INSERT INTO audit_log (id, actor_id, actor_name, action, entity_type, entity_id, detail, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), dm.id, '张决策', 'todo.created', 'todo', id,
       JSON.stringify({ source: 'manual', owner: def.owner, seeded: true }), at]
    );
    if (def.status !== 'pending') {
      await db.execute(
        `INSERT INTO audit_log (id, actor_id, actor_name, action, entity_type, entity_id, detail, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId(), dm.id, '张决策', 'todo.status_changed', 'todo', id,
         JSON.stringify({ before: { status: 'pending' }, after: { status: def.status } }), at]
      );
    }
  }

  // ---- 决策（F9/PAND-87）-----------------------------------------------
  // 直接写库以复现「历史决策」，但状态/结论字段严格遵守已决策不变量。
  const decisionIds = {};

  async function insertDecision(def) {
    const id = newId();
    decisionIds[def.key] = id;
    const decided = !!def.conclusion;
    await db.execute(
      `INSERT INTO decisions
         (id, title, domain, background, related_refs, options, required_evidence_ids,
          conclusion, status, decider, decider_id, decided_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, def.title, def.domain, def.background,
        JSON.stringify(def.relatedRefs), JSON.stringify(def.options),
        JSON.stringify(def.requiredEvidenceIds),
        decided ? def.conclusion : null,
        decided ? 'decided' : 'pending',
        decided ? def.decider : null,
        decided ? dm.id : null,
        decided ? def.decidedAt : null,
        dm.id, def.createdAt || at, at,
      ]
    );

    let seq = 1;
    await db.execute(
      `INSERT INTO decision_changes
         (id, decision_id, seq, action, reason, before, after, changed_by, changed_by_name, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), id, seq, DECISION_CHANGE_ACTION.CREATED, null, null,
       JSON.stringify({
         title: def.title,
         domain: def.domain,
         status: 'pending',
         related_refs: def.relatedRefs.map((x) => ({ type: x.type, id: x.id, label: x.label })),
         option_names: def.options.map((o) => o.name),
         required_evidence_ids: def.requiredEvidenceIds,
       }),
       dm.id, '张决策', def.createdAt || at]
    );

    // 结论形成 + 可选的一次修改（场景 2：变更前后值留痕）
    let previous = null;
    for (const step of def.conclusionHistory || []) {
      const action = previous === null
        ? DECISION_CHANGE_ACTION.DECIDED
        : DECISION_CHANGE_ACTION.REVISED;
      seq += 1;
      await db.execute(
        `INSERT INTO decision_changes
           (id, decision_id, seq, action, reason, before, after, changed_by, changed_by_name, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(), id, seq, action, step.reason || null,
          JSON.stringify(previous === null
            ? { conclusion: null, status: 'pending', decider: null, decided_at: null }
            : { conclusion: previous, status: 'decided', decider: def.decider, decided_at: step.at }),
          JSON.stringify({ conclusion: step.conclusion, status: 'decided', decider: def.decider, decided_at: step.at }),
          dm.id, def.decider, step.at,
        ]
      );
      previous = step.conclusion;
    }
    return { id, nextSeq: seq + 1 };
  }

  const decisions = [
    {
      // 场景 1/2/3 全量演示：已决策 + 结论被修改过一次（留痕含前后值）+ 2 条执行 TODO（含已完成）
      key: 'd1',
      title: '是否追加产线投入以修复订单交付偏差',
      domain: 'production',
      background: '2026-09 订单交付率 87%，低于目标 95%（偏差 -8pp）；归因显示产能不足（40%）与排产冲突（25%）为主要负向原因。',
      relatedRefs: [
        { type: 'result', id: m.delivery, label: '订单交付率', domain: 'production' },
        { type: 'reason', id: r.capacity, label: '产能不足', domain: 'production' },
        { type: 'reason', id: r.scheduling, label: '排产冲突', domain: 'production' },
      ],
      options: [
        { id: newId(), name: '追加一条产线', summary: '一次性投入较大，3 个月后产能到位', pros: ['根治产能瓶颈'], cons: ['投资回收期长'] },
        { id: newId(), name: '加班 + 外部协作补产能', summary: '短期见效，成本可控', pros: ['当月即可改善交付'], cons: ['毛利承压'] },
        { id: newId(), name: '调整排产规则并优先保交付', summary: '零投入，依赖管理动作', pros: ['无资本开支'], cons: ['效果取决于执行'] },
      ],
      requiredEvidenceIds: [e.erp, e.overtime],
      conclusion: '先以加班与外部协作补产能，同时调整排产规则；追加产线留待 Q4 预算评审后再定。',
      conclusionHistory: [
        { conclusion: '先以加班补产能，暂不追加产线。', at: ago(4), reason: null },
        { conclusion: '先以加班与外部协作补产能，同时调整排产规则；追加产线留待 Q4 预算评审后再定。', at: ago(2), reason: '外部协作已确认可补充 5% 产能，且排产规则调整无需资本开支，原结论过于保守。' },
      ],
      decider: '张决策',
      decidedAt: ago(2),
      createdAt: ago(5),
      executionTodos: ['t1', 't2'],
    },
    {
      // 已决策 + 1 条逾期未完成的执行 TODO
      key: 'd2',
      title: '大客户流失的挽回是否投入专项资源',
      domain: 'sales',
      background: '2026-09 新增订单 288 单，低于目标 320 单；归因显示大客户流失贡献 55% 负向影响。',
      relatedRefs: [
        { type: 'result', id: m.orders, label: '新增订单', domain: 'sales' },
        { type: 'reason', id: r.churn, label: '大客户流失', domain: 'sales' },
      ],
      options: [
        { id: newId(), name: '成立大客户专项组', summary: '销售 + 交付联合跟进重点客户' },
        { id: newId(), name: '以价格条款挽留', summary: '短期让利换取续约' },
      ],
      requiredEvidenceIds: [e.churnReport],
      conclusion: '成立大客户专项组，先复盘流失原因再做条款让利，避免无差别降价。',
      conclusionHistory: [
        { conclusion: '成立大客户专项组，先复盘流失原因再做条款让利，避免无差别降价。', at: ago(6), reason: null },
      ],
      decider: '张决策',
      decidedAt: ago(6),
      createdAt: ago(7),
      executionTodos: ['t3'],
    },
    {
      // 边界：未形成结论 ⇒ 待决策，不计入已决策数量；且尚未关联执行 TODO
      key: 'd3',
      title: '2026-Q4 产能扩充预算是否立项',
      domain: 'production',
      background: '产能利用率已接近上限，若交付目标继续上调需提前锁定产能投资；当前仍在收集各方案数据。',
      relatedRefs: [
        { type: 'result', id: m.delivery, label: '订单交付率', domain: 'production' },
      ],
      options: [
        { id: newId(), name: '按原计划立项', summary: '2026-Q4 追加一条产线' },
        { id: newId(), name: '延后至 2027-Q1', summary: '先观察两个月交付趋势' },
        { id: newId(), name: '不立项，改用外部产能', summary: '全部依赖协作产能' },
      ],
      requiredEvidenceIds: [e.capacityBudget],
      conclusion: null,
      conclusionHistory: [],
      decider: null,
      decidedAt: null,
      createdAt: ago(1),
      executionTodos: [],
    },
    {
      // 边界：无需外部证据（所需 Evidence 为空但字段存在）
      key: 'd4',
      title: '现金流同步滞后是否升级为财务中心专项',
      domain: 'finance',
      background: '2026-09 经营性现金流 1580 万元，低于目标 2000 万元，且数据同步存在滞后。',
      relatedRefs: [
        { type: 'result', id: m.cash, label: '经营性现金流', domain: 'finance' },
      ],
      options: [
        { id: newId(), name: '升级为财务中心专项', summary: '由财务中心牵头对齐同步口径' },
        { id: newId(), name: '维持现有周期同步', summary: '仅在本月内补齐' },
      ],
      requiredEvidenceIds: [],
      conclusion: '升级为财务中心专项，30 日内完成同步通道补齐。',
      conclusionHistory: [
        { conclusion: '升级为财务中心专项，30 日内完成同步通道补齐。', at: ago(5), reason: null },
      ],
      decider: '张决策',
      decidedAt: ago(5),
      createdAt: ago(6),
      executionTodos: ['t4'],
    },
  ];

  for (const def of decisions) {
    const { id, nextSeq } = await insertDecision(def);
    for (const todoKey of def.executionTodos) {
      await db.execute(
        'INSERT INTO object_links (id, from_type, from_id, to_type, to_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [newId(), 'decision', id, 'todo', t[todoKey], at]
      );
    }
    if (def.executionTodos.length) {
      await db.execute(
        `INSERT INTO decision_changes
           (id, decision_id, seq, action, reason, before, after, changed_by, changed_by_name, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId(), id, nextSeq, DECISION_CHANGE_ACTION.TODO_LINKED, null,
         JSON.stringify({ execution_todo_ids: [] }),
         JSON.stringify({ execution_todo_ids: def.executionTodos.map((k) => t[k]) }),
         dm.id, '张决策', def.decidedAt || def.createdAt || at]
      );
    }
  }

  const counts = await db.query(
    `SELECT status, COUNT(*) AS total FROM decisions GROUP BY status`
  );

  return {
    users: users.map((u) => u.username),
    decisions: decisions.length,
    decisionStatus: counts.rows.reduce((acc, row) => ({ ...acc, [row.status]: Number(row.total) }), {}),
    metrics: Object.keys(m).length,
    reasons: Object.keys(r).length,
    evidences: Object.keys(e).length,
    todos: Object.keys(t).length,
    password: PASSWORD,
  };
}

if (require.main === module) {
  seed()
    .then((summary) => {
      // eslint-disable-next-line no-console
      console.log('[ebms] 演示数据写入完成:', JSON.stringify(summary));
      return closeDb();
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[ebms] 写入失败:', err.message);
      process.exitCode = 1;
    });
}

module.exports = { seed, PASSWORD };
