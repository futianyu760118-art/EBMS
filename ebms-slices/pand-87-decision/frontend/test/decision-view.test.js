import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';

// 以真实响应形状打桩 API，逐条验证 F9/Decision 视图的 AC。
const h = vi.hoisted(() => ({
  calls: {
    listDecisions: [],
    getDecision: [],
    createDecision: [],
    saveConclusion: [],
    linkExecutionTodos: [],
    unlinkExecutionTodo: [],
    todoCandidates: [],
  },
  landing: null,
  listResult: null,
  detailResult: null,
  refsResult: null,
  candidatesResult: null,
}));

vi.mock('../src/api/client', () => ({
  getToken: () => 'test-token',
  setToken: () => {},
  api: {
    login: async () => ({ token: 'test-token', user: { displayName: '张决策' }, landing: h.landing }),
    landing: async () => ({ landing: h.landing }),
    listDecisions: async (filters) => {
      h.calls.listDecisions.push({ ...filters });
      return h.listResult;
    },
    getDecision: async (id) => {
      h.calls.getDecision.push(id);
      return h.detailResult;
    },
    decisionRefs: async () => h.refsResult,
    todoCandidates: async (decisionId) => {
      h.calls.todoCandidates.push(decisionId);
      return h.candidatesResult;
    },
    createDecision: async (payload) => {
      h.calls.createDecision.push(payload);
      return { id: 'new-1' };
    },
    saveConclusion: async (id, payload) => {
      h.calls.saveConclusion.push({ id, payload });
      return h.afterConclusion || h.detailResult;
    },
    linkExecutionTodos: async (id, payload) => {
      h.calls.linkExecutionTodos.push({ id, payload });
      return h.afterLink || h.detailResult;
    },
    unlinkExecutionTodo: async (id, todoId) => {
      h.calls.unlinkExecutionTodo.push({ id, todoId });
      return h.afterUnlink || h.detailResult;
    },
  },
}));

import App from '../src/App.vue';
import { routes } from '../src/router/routes.js';
import { clearSession, setSession } from '../src/store/session.js';

const LANDING_DECISION_MAKER = {
  view: 'decision',
  route: '/decisions',
  reportRoute: '/reports',
  scope: { mode: 'all', label: '全企业口径' },
  availableViews: ['decision', 'report', 'todo', 'evidence'],
};

const LANDING_DOMAIN_OWNER = {
  view: 'decision',
  route: '/decisions',
  reportRoute: '/reports',
  scope: { mode: 'domain', domains: ['sales'], label: '销售' },
  availableViews: ['decision', 'report', 'todo'],
};

function ref(type, id, label, domain) {
  return { type, id, label, domain };
}

// 列表项：与后端 decision-service.baseView + 变更计数一致
function listItem(overrides = {}) {
  return {
    id: 'd1',
    title: '是否追加产线投入以修复订单交付偏差',
    domain: 'production',
    background: '2026-09 订单交付率 87%，低于目标 95%。',
    status: 'decided',
    statusLabel: '已决策',
    decided: true,
    countsAsDecided: true,
    conclusion: '先以加班与外部协作补产能，追加产线留待 Q4 预算评审后再定。',
    decider: '张决策',
    decidedAt: '2026-09-22T09:30:00.000Z',
    optionCount: 3,
    requiredEvidenceCount: 2,
    createdAt: '2026-09-19T01:20:00.000Z',
    updatedAt: '2026-09-22T09:30:00.000Z',
    changeCount: 4,
    conclusionChangeCount: 2,
    ...overrides,
  };
}

function pendingItem(overrides = {}) {
  return listItem({
    id: 'd3',
    title: '2026-Q4 产能扩充预算是否立项',
    domain: 'production',
    status: 'pending',
    statusLabel: '待决策',
    decided: false,
    countsAsDecided: false,
    conclusion: null,
    decider: null,
    decidedAt: null,
    optionCount: 3,
    requiredEvidenceCount: 1,
    changeCount: 1,
    conclusionChangeCount: 0,
    ...overrides,
  });
}

function executionItem(overrides = {}) {
  return {
    id: 't1',
    title: '交付线加班与外部协作补产能',
    status: 'done',
    statusLabel: '已完成',
    source: 'manual',
    sourceLabel: '人工派发',
    owner: '李生产',
    dueAt: '2026-09-19T02:00:00.000Z',
    overdue: false,
    relatedRefs: [ref('result', 'm-delivery', '订单交付率', 'production')],
    history: [{ action: 'todo.status_changed', actorName: '张决策', at: '2026-09-21T02:00:00.000Z' }],
    ...overrides,
  };
}

function detail(overrides = {}) {
  return {
    ...listItem(),
    options: [
      { id: 'o1', name: '追加一条产线', summary: '一次性投入较大', pros: ['根治产能瓶颈'], cons: ['投资回收期长'] },
      { id: 'o2', name: '加班 + 外部协作补产能', summary: '短期见效' },
    ],
    relatedRefs: [
      ref('result', 'm-delivery', '订单交付率', 'production'),
      ref('reason', 'r-capacity', '产能不足', 'production'),
    ],
    requiredEvidence: [
      { id: 'e1', type: 'system_record', typeLabel: '系统记录', title: 'ERP 交付达成明细', provided: true, owner: '生产中心', formedAt: '2026-09-18T00:00:00.000Z' },
      { id: 'e2', type: 'manual', typeLabel: '人工填报', title: '车间加班排班说明', provided: false, owner: null, formedAt: null },
    ],
    evidenceSummary: { required: 2, provided: 1, missing: 1 },
    changes: [
      {
        id: 'c1', seq: 1, action: 'decision.created', actionLabel: '创建决策', reason: null,
        before: null, after: { status: 'pending' }, changedByName: '张决策',
        changedAt: '2026-09-19T01:20:00.000Z', conclusionChanged: false,
      },
      {
        id: 'c2', seq: 2, action: 'decision.decided', actionLabel: '形成决策结论', reason: null,
        before: { conclusion: null, status: 'pending' },
        after: { conclusion: '先以加班补产能，暂不追加产线。', status: 'decided' },
        changedByName: '张决策', changedAt: '2026-09-21T02:00:00.000Z', conclusionChanged: true,
      },
      {
        id: 'c3', seq: 3, action: 'decision.revised', actionLabel: '修改决策结论',
        reason: '外部协作已确认可补充 5% 产能，原结论过于保守。',
        before: { conclusion: '先以加班补产能，暂不追加产线。', status: 'decided' },
        after: { conclusion: '先以加班与外部协作补产能，追加产线留待 Q4 预算评审后再定。', status: 'decided' },
        changedByName: '张决策', changedAt: '2026-09-22T09:30:00.000Z', conclusionChanged: true,
      },
    ],
    changeCount: 3,
    conclusionChangeCount: 2,
    execution: {
      total: 2,
      done: 1,
      inProgress: 1,
      pending: 0,
      overdue: 1,
      progressPct: 50,
      note: '执行结果只读取 F8 TODO 域现状，不做决策效果评价（口径：不强制）',
      items: [
        executionItem(),
        executionItem({
          id: 't2', title: '排产冲突专项复盘并固化排产规则', status: 'in_progress', statusLabel: '进行中',
          dueAt: '2026-09-22T02:00:00.000Z', overdue: true,
        }),
      ],
    },
    decidedFieldsPresent: true,
    ...overrides,
  };
}

function pendingDetail(overrides = {}) {
  return {
    ...detail(),
    ...pendingItem(),
    options: [{ id: 'o1', name: '按原计划立项' }, { id: 'o2', name: '延后至 2027-Q1' }],
    changes: [
      {
        id: 'c1', seq: 1, action: 'decision.created', actionLabel: '创建决策', reason: null,
        before: null, after: { status: 'pending' }, changedByName: '张决策',
        changedAt: '2026-09-23T01:00:00.000Z', conclusionChanged: false,
      },
    ],
    changeCount: 1,
    conclusionChangeCount: 0,
    execution: { total: 0, done: 0, inProgress: 0, pending: 0, overdue: 0, progressPct: 0, items: [], note: '尚未关联执行 TODO —— 决策可关联其执行产生的 TODO 并回看执行结果（不强制效果评价）' },
    decidedFieldsPresent: false,
    ...overrides,
  };
}

function refs() {
  return {
    results: [
      { type: 'result', id: 'm-delivery', label: '订单交付率', domain: 'production' },
      { type: 'result', id: 'm-orders', label: '新增订单', domain: 'sales' },
    ],
    reasons: [
      { type: 'reason', id: 'r-capacity', label: '产能不足', domain: 'production' },
      { type: 'reason', id: 'r-churn', label: '大客户流失', domain: 'sales' },
    ],
    evidences: [{ id: 'e1', type: 'system_record', typeLabel: '系统记录', title: 'ERP 交付达成明细' }],
    meta: { background_ref_types: [] },
  };
}

function resetFixtures() {
  h.landing = LANDING_DECISION_MAKER;
  h.listResult = {
    items: [listItem(), pendingItem()],
    summary: { total: 2, decided: 1, pending: 1 },
    paging: { page: 1, limit: 100, total: 2 },
    filters: { status: null, domain: null },
    meta: {
      statuses: [{ value: 'pending', label: '待决策' }, { value: 'decided', label: '已决策' }],
      required_statuses: ['pending', 'decided'],
      background_ref_types: [
        { value: 'result', label: '经营结果' },
        { value: 'reason', label: '原因项' },
      ],
    },
  };
  h.detailResult = detail();
  h.refsResult = refs();
  h.candidatesResult = {
    items: [
      { id: 't5', title: '存货周转口径与年度计划对齐', status: 'pending', statusLabel: '未开始', source: 'manual', sourceLabel: '人工派发', owner: '供应链责任人', dueAt: '2026-10-01T02:00:00.000Z', overdue: false, relatedRefs: [], linkedDecisionId: null, linkedHere: false },
      { id: 't1', title: '交付线加班与外部协作补产能', status: 'done', statusLabel: '已完成', source: 'manual', sourceLabel: '人工派发', owner: '李生产', dueAt: '2026-09-19T02:00:00.000Z', overdue: false, relatedRefs: [], linkedDecisionId: 'd1', linkedHere: true },
    ],
    meta: { statuses: [] },
  };
  h.afterConclusion = null;
  h.afterLink = null;
  h.afterUnlink = null;
  for (const key of Object.keys(h.calls)) h.calls[key] = [];
}

function buildRouter() {
  return createRouter({ history: createMemoryHistory(), routes });
}

async function mountApp(initialPath = '/') {
  const router = buildRouter();
  router.push(initialPath);
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router };
}

beforeEach(() => {
  clearSession();
  setSession({ user: { displayName: '张决策' }, landing: LANDING_DECISION_MAKER });
  resetFixtures();
});

describe('PAND-87 场景 1：每条决策含 背景 / 候选方案 / 所需 Evidence / 结论 / 决策人 / 决策时间', () => {
  it('列表落地即展示上述要素，无需点进详情', async () => {
    const { wrapper, router } = await mountApp('/');

    expect(router.currentRoute.value.path).toBe('/decisions');
    expect(h.calls.listDecisions).toHaveLength(1);

    const cards = wrapper.findAll('[data-test="decision-card"]');
    expect(cards).toHaveLength(2);

    const card = cards[0];
    expect(card.find('[data-test="decision-background"]').text()).toContain('订单交付率 87%');
    expect(card.find('[data-test="decision-conclusion"]').text()).toContain('先以加班与外部协作补产能');
    expect(card.find('[data-test="decision-decider"]').text()).toContain('张决策');
    expect(card.find('[data-test="decision-decided-at"]').text()).not.toBe('—');
    expect(card.find('[data-test="decision-options"]').text()).toContain('3 项');
    expect(card.find('[data-test="decision-evidence"]').text()).toContain('2 项');
  });

  it('详情页展示背景关联的结果/原因、候选方案与所需证据', async () => {
    const { wrapper } = await mountApp('/decisions/d1');
    await flushPromises();

    expect(h.calls.getDecision).toEqual(['d1']);
    expect(wrapper.find('[data-test="detail-title"]').text()).toContain('追加产线投入');

    // 背景：至少关联 1 条 Result / Reason
    const resultRef = wrapper.find('[data-test="background-ref-result"]');
    const reasonRef = wrapper.find('[data-test="background-ref-reason"]');
    expect(resultRef.text()).toContain('订单交付率');
    expect(resultRef.text()).toContain('经营结果');
    expect(reasonRef.text()).toContain('产能不足');
    expect(reasonRef.text()).toContain('原因项');

    // 候选方案 ≥ 1
    const options = wrapper.findAll('[data-test="option"]');
    expect(options.length).toBeGreaterThanOrEqual(1);
    expect(options[0].find('[data-test="option-name"]').text()).toBe('追加一条产线');

    // 所需 Evidence：齐备与缺失分别标注，缺失不阻断展示
    const evidenceItems = wrapper.findAll('[data-test="evidence-item"]');
    expect(evidenceItems).toHaveLength(2);
    expect(evidenceItems[0].find('[data-test="evidence-flag"]').text()).toBe('已具备');
    expect(evidenceItems[1].find('[data-test="evidence-flag"]').text()).toBe('缺失');
    expect(wrapper.find('[data-test="evidence-summary"]').text()).toContain('缺 1 项');

    // 结论 + 决策人 + 决策时间
    expect(wrapper.find('[data-test="detail-conclusion"]').text()).toContain('先以加班与外部协作补产能');
    expect(wrapper.find('[data-test="detail-decider"]').text()).toContain('张决策');
    expect(wrapper.find('[data-test="detail-decided-at"]').text()).not.toBe('—');
  });

  it('创建决策要求背景关联与候选方案，提交后带完整字段请求后端', async () => {
    const { wrapper } = await mountApp('/decisions');
    await wrapper.find('[data-test="open-create"]').trigger('click');
    await flushPromises();
    expect(h.refsResult).toBeTruthy();

    const form = wrapper.find('[data-test="create-form"]');
    await form.find('[data-test="create-title"]').setValue('Q4 是否追加仓配投入');
    await form.find('[data-test="create-background"]').setValue('仓配时效偏差扩大');
    await form.find('[data-test="create-domain"]').setValue('production');

    // 未选背景关联时提交被拦下（边界：背景必须关联 ≥1 条结果/原因）
    await form.find('form').trigger('submit');
    await flushPromises();
    expect(h.calls.createDecision).toHaveLength(0);
    expect(form.find('[data-test="create-error"]').text()).toContain('至少关联 1 条');

    await form.find('[data-test="create-ref-result"]').setValue(true);
    await form.find('[data-test="create-option-0"]').setValue('追加仓配投入');
    await form.find('[data-test="create-evidence"]').setValue(true);
    await form.find('form').trigger('submit');
    await flushPromises();

    expect(h.calls.createDecision).toHaveLength(1);
    expect(h.calls.createDecision[0]).toMatchObject({
      title: 'Q4 是否追加仓配投入',
      domain: 'production',
      background: '仓配时效偏差扩大',
      related_refs: [{ type: 'result', id: 'm-delivery' }],
      options: [{ name: '追加仓配投入' }],
      required_evidence_ids: ['e1'],
    });
    // 新建决策一律为「待决策」：结论由结论表单单独形成，不在创建时写入
    expect(h.calls.createDecision[0].conclusion).toBeUndefined();
    expect(h.calls.listDecisions.length).toBeGreaterThanOrEqual(2);
  });
});

describe('PAND-87 场景 2：决策结论不可静默修改', () => {
  it('修改已有结论时未填理由不可提交（交互层拦截）', async () => {
    const { wrapper } = await mountApp('/decisions/d1');
    await flushPromises();

    const form = wrapper.find('[data-test="conclusion-form"]');
    expect(form.exists()).toBe(true);
    expect(form.text()).toContain('修改决策结论');
    expect(form.text()).toContain('不可静默修改');

    await form.find('[data-test="conclusion-input"]').setValue('改为直接追加产线。');
    await flushPromises();

    // 未填变更理由：提交按钮禁用 + 明确提示
    expect(form.find('[data-test="conclusion-submit"]').attributes('disabled')).toBeDefined();
    expect(form.find('[data-test="conclusion-reason-required"]').exists()).toBe(true);

    // 直接触发 submit 也不得发出请求
    await form.find('form').trigger('submit');
    await flushPromises();
    expect(h.calls.saveConclusion).toHaveLength(0);
  });

  it('填写变更理由后提交，携带变更后的结论与理由', async () => {
    h.afterConclusion = detail({
      conclusion: '改为直接追加产线以彻底消除产能瓶颈。',
      conclusionChangeCount: 3,
      changeCount: 4,
    });
    const { wrapper } = await mountApp('/decisions/d1');
    await flushPromises();

    const form = wrapper.find('[data-test="conclusion-form"]');
    await form.find('[data-test="conclusion-input"]').setValue('改为直接追加产线以彻底消除产能瓶颈。');
    await form.find('[data-test="conclusion-reason"]').setValue('Q4 预算提前释放，投资窗口打开。');
    await flushPromises();

    expect(form.find('[data-test="conclusion-submit"]').attributes('disabled')).toBeUndefined();
    await form.find('form').trigger('submit');
    await flushPromises();

    expect(h.calls.saveConclusion).toEqual([
      {
        id: 'd1',
        payload: {
          conclusion: '改为直接追加产线以彻底消除产能瓶颈。',
          reason: 'Q4 预算提前释放，投资窗口打开。',
        },
      },
    ]);
    expect(wrapper.find('[data-test="detail-notice"]').text()).toContain('变更记录');
  });

  it('结论未发生变化时不提交（避免产生无意义的变更记录）', async () => {
    const { wrapper } = await mountApp('/decisions/d1');
    await flushPromises();

    const form = wrapper.find('[data-test="conclusion-form"]');
    // 初值与既有结论一致 ⇒ 提交按钮禁用，且不显示任何报错
    expect(form.find('[data-test="conclusion-submit"]').attributes('disabled')).toBeDefined();
    expect(form.find('[data-test="conclusion-error"]').exists()).toBe(false);
    expect(form.find('[data-test="conclusion-reason-required"]').exists()).toBe(false);

    // 改过又改回原值 ⇒ 明确提示未变化，不得产生变更记录
    await form.find('[data-test="conclusion-input"]').setValue('临时改动');
    await flushPromises();
    await form.find('[data-test="conclusion-input"]').setValue(h.detailResult.conclusion);
    await flushPromises();

    expect(form.find('[data-test="conclusion-unchanged"]').exists()).toBe(true);
    expect(form.find('[data-test="conclusion-submit"]').attributes('disabled')).toBeDefined();

    await form.find('form').trigger('submit');
    await flushPromises();
    expect(h.calls.saveConclusion).toHaveLength(0);
  });

  it('首次形成结论（待决策）不要求变更理由', async () => {
    h.detailResult = pendingDetail();
    const { wrapper } = await mountApp('/decisions/d3');
    await flushPromises();

    const form = wrapper.find('[data-test="conclusion-form"]');
    expect(form.text()).toContain('形成决策结论');
    // 尚无线索：理由输入框不应出现
    expect(form.find('[data-test="conclusion-reason"]').exists()).toBe(false);

    await form.find('[data-test="conclusion-input"]').setValue('按原计划立项。');
    await flushPromises();
    await form.find('form').trigger('submit');
    await flushPromises();

    expect(h.calls.saveConclusion).toHaveLength(1);
    expect(h.calls.saveConclusion[0].payload).toEqual({ conclusion: '按原计划立项。' });
    expect(h.calls.saveConclusion[0].payload.reason).toBeUndefined();
  });

  it('变更历史展示 变更人 / 变更时间 / 变更前后值 与变更理由', async () => {
    const { wrapper } = await mountApp('/decisions/d1');
    await flushPromises();

    const items = wrapper.findAll('[data-test="change-item"]');
    expect(items.length).toBe(h.detailResult.changes.length);

    const revised = items.find((item) => item.attributes('data-action') === 'decision.revised');
    expect(revised).toBeTruthy();
    expect(revised.find('[data-test="change-action"]').text()).toBe('修改决策结论');
    expect(revised.find('[data-test="change-meta"]').text()).toContain('张决策');

    // 变更前 / 变更后值
    expect(revised.find('[data-test="change-before"]').text()).toContain('先以加班补产能，暂不追加产线。');
    expect(revised.find('[data-test="change-after"]').text()).toContain('先以加班与外部协作补产能');
    expect(revised.find('[data-test="change-reason"]').text()).toContain('外部协作已确认可补充 5% 产能');

    // 变更记录条数 ≥ 实际修改次数
    expect(wrapper.find('[data-test="change-count"]').text()).toContain('共 3 条');
    expect(wrapper.find('[data-test="change-count"]').text()).toContain('结论变更 2 次');
  });
});

describe('PAND-87 场景 3：决策可关联执行 TODO 并回看执行结果', () => {
  it('详情展示关联的执行 TODO 及其状态、逾期与完成度', async () => {
    const { wrapper } = await mountApp('/decisions/d1');
    await flushPromises();

    const items = wrapper.findAll('[data-test="execution-item"]');
    expect(items).toHaveLength(2);
    expect(items[0].find('[data-test="execution-title"]').text()).toContain('交付线加班');
    expect(items[0].find('[data-test="execution-status"]').text()).toBe('已完成');
    expect(items[0].find('[data-test="execution-source"]').text()).toBe('人工派发');
    expect(items[0].find('[data-test="execution-history"]').exists()).toBe(true);
    expect(items[1].find('[data-test="execution-overdue"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="execution"]').text()).toContain('完成度 50%');
    // 口径：不强制效果评价
    expect(wrapper.find('[data-test="execution-note"]').text()).toContain('不强制');
  });

  it('关联已有 TODO 会带 todo_ids 请求后端并刷新执行情况', async () => {
    h.afterLink = detail();
    h.afterLink.execution.total = 3;
    const { wrapper } = await mountApp('/decisions/d1');
    await flushPromises();

    await wrapper.find('[data-test="open-link"]').trigger('click');
    await flushPromises();
    expect(h.calls.todoCandidates).toEqual(['d1']);

    const candidates = wrapper.findAll('[data-test="candidate-item"]');
    expect(candidates).toHaveLength(2);
    // 已关联本决策的候选被标注
    expect(wrapper.find('[data-test="candidate-linked-here"]').exists()).toBe(true);

    // 未选中时不可提交
    expect(wrapper.find('[data-test="link-submit"]').attributes('disabled')).toBeDefined();

    await candidates[0].find('input').setValue(true);
    await flushPromises();
    await wrapper.find('[data-test="link-submit"]').trigger('click');
    await flushPromises();

    expect(h.calls.linkExecutionTodos).toEqual([{ id: 'd1', payload: { todo_ids: ['t5'] } }]);
    expect(wrapper.find('[data-test="detail-notice"]').text()).toContain('变更记录');
  });

  it('可由决策派发新 TODO（要求标题 / 责任人 / 截止时间）', async () => {
    const { wrapper } = await mountApp('/decisions/d1');
    await flushPromises();

    await wrapper.find('[data-test="open-link"]').trigger('click');
    await flushPromises();

    // 缺必填项时不发请求
    await wrapper.find('[data-test="dispatch-submit"]').trigger('click');
    await flushPromises();
    expect(h.calls.linkExecutionTodos).toHaveLength(0);
    expect(wrapper.find('[data-test="detail-error"]').text()).toContain('责任人与截止时间');

    await wrapper.find('[data-test="dispatch-title"]').setValue('跟踪外部协作产能到位情况');
    await wrapper.find('[data-test="dispatch-owner"]').setValue('李生产');
    await wrapper.find('[data-test="dispatch-due"]').setValue('2026-10-31T18:00');
    await wrapper.find('[data-test="dispatch-submit"]').trigger('click');
    await flushPromises();

    expect(h.calls.linkExecutionTodos).toHaveLength(1);
    const payload = h.calls.linkExecutionTodos[0].payload;
    expect(payload.todos).toHaveLength(1);
    expect(payload.todos[0]).toMatchObject({
      title: '跟踪外部协作产能到位情况',
      owner: '李生产',
    });
    expect(payload.todos[0].due_at).toBeTruthy();
  });

  it('可解除执行 TODO 关联（留痕）', async () => {
    h.afterUnlink = detail();
    h.afterUnlink.execution.total = 1;
    const { wrapper } = await mountApp('/decisions/d1');
    await flushPromises();

    await wrapper.findAll('[data-test="execution-unlink"]')[0].trigger('click');
    await flushPromises();

    expect(h.calls.unlinkExecutionTodo).toEqual([{ id: 'd1', todoId: 't1' }]);
    expect(wrapper.find('[data-test="detail-notice"]').text()).toContain('解除');
  });
});

describe('PAND-87 边界：待决策记录不计入已决策数量，无记录时显示空态', () => {
  it('汇总区分已决策 / 待决策并注明不计入', async () => {
    const { wrapper } = await mountApp('/decisions');
    await flushPromises();

    expect(wrapper.find('[data-test="summary-decided"]').text()).toBe('1');
    expect(wrapper.find('[data-test="summary-pending"]').text()).toBe('1');
    expect(wrapper.find('[data-test="summary-note"]').text()).toContain('不计入已决策数量');
  });

  it('待决策条目不显示结论，并明确标注不计入已决策数量', async () => {
    const { wrapper } = await mountApp('/decisions');
    await flushPromises();

    const pendingCard = wrapper.findAll('[data-test="decision-card"]')[1];
    expect(pendingCard.find('[data-test="decision-status"]').text()).toBe('待决策');
    expect(pendingCard.find('[data-test="decision-status"]').attributes('data-status')).toBe('pending');
    expect(pendingCard.find('[data-test="decision-conclusion-empty"]').text()).toContain('不计入已决策数量');
    expect(pendingCard.find('[data-test="decision-decider"]').text()).toContain('—');
    expect(pendingCard.find('[data-test="decision-decided-at"]').text()).toContain('—');
  });

  it('无决策记录时显示空态与创建入口', async () => {
    h.listResult = {
      items: [],
      summary: { total: 0, decided: 0, pending: 0 },
      paging: { page: 1, limit: 100, total: 0 },
      filters: {},
      meta: { statuses: [] },
    };
    const { wrapper } = await mountApp('/decisions');
    await flushPromises();

    expect(wrapper.findAll('[data-test="decision-card"]')).toHaveLength(0);
    const empty = wrapper.find('[data-test="empty-state"]');
    expect(empty.exists()).toBe(true);
    expect(empty.find('[data-test="empty-description"]').text()).toContain('暂无决策');

    await empty.find('[data-test="create-decision"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="create-form"]').exists()).toBe(true);
  });
});

describe('PAND-87 数据范围 / 筛选', () => {
  it('状态与责任域筛选带参请求后端，并写入 URL 查询串', async () => {
    const { wrapper, router } = await mountApp('/decisions');

    await wrapper.find('[data-test="filter-status"]').setValue('decided');
    await flushPromises();
    expect(h.calls.listDecisions.at(-1).status).toBe('decided');
    expect(router.currentRoute.value.query.status).toBe('decided');

    await wrapper.find('[data-test="filter-domain"]').setValue('production');
    await flushPromises();
    expect(h.calls.listDecisions.at(-1).domain).toBe('production');

    await wrapper.find('[data-test="filter-reset"]').trigger('click');
    await flushPromises();
    const last = h.calls.listDecisions.at(-1);
    expect(last.status).toBe('');
    expect(last.domain).toBe('');
  });

  it('管理责任人的责任域下拉仅含本责任域', async () => {
    clearSession();
    setSession({ user: { displayName: '赵销售' }, landing: LANDING_DOMAIN_OWNER });
    h.landing = LANDING_DOMAIN_OWNER;

    const { wrapper } = await mountApp('/decisions');
    await flushPromises();

    const options = wrapper.find('[data-test="filter-domain"]').findAll('option');
    const values = options.map((option) => option.attributes('value')).filter(Boolean);
    expect(values).toEqual(['sales']);
  });
});
