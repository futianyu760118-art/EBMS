/**
 * F2 偏差归因穿透视图口径单测：
 * 五字段展示、多级展开、类型判定、未归因空态与兜底标注、关联入口。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DIRECTION_LABELS,
  createReasonDrilldownStore,
  deviationDirection,
  directionLabel,
  emptyReasonForm,
  fallbackNotice,
  isUnattributed,
  kindLabel,
  reasonFields,
  severityLabel,
  summarize,
  toReasonPayload,
  validateReasonPayload,
  visibleDepth,
  visibleReasons,
} from '../src/stores/reasonDrilldown.js';

function node(overrides = {}) {
  return {
    attributionId: 'A-REV1',
    metricId: 'M-REV',
    parentId: null,
    depth: 0,
    name: 'LOW_PRICE_ORDER',
    kind: 'exception',
    reasonCode: 'LOW_PRICE_ORDER',
    severity: 'high',
    direction: 'negative',
    contributionPct: 50,
    impactValue: null,
    impactDisplay: { basis: 'contribution_pct', label: '贡献占比', text: '50%' },
    owner: '销售中心',
    children: [],
    truncated: false,
    ...overrides,
  };
}

const OK_PAYLOAD = {
  state: 'OK',
  result: { code: 'revenue', name: '营业收入' },
  deviation: { target: 1000, actual: 880, unit: '万元', deviation: -120, deviationPct: -12 },
  consumption: {
    contract: 'AEOS.Result.V1',
    resultId: 'R-REV',
    sourceSystem: 'M05',
    calculationVersion: 'M05-REV-V1',
    ownedByEbms: false,
    note: '归因所依据的专业事实一律消费专业模块 Result；EBMS 不重算专业指标、不自建专业事实源。',
  },
  directions: [
    { value: 'positive', label: '正向' },
    { value: 'negative', label: '负向' },
    { value: 'neutral', label: '中性' },
  ],
  statusLabel: '完全归因',
  attributionStatus: 'FULLY_ATTRIBUTED',
  summary: {
    rootContributionPct: 100,
    rootCount: 4,
    tolerancePct: 1,
    sumsTo100WithinTolerance: true,
  },
  count: 5,
  rootCount: 4,
  maxDepthReached: 3,
  notices: [],
  reasons: [
    node({
      children: [
        node({
          attributionId: 'A-REV1-1',
          parentId: 'A-REV1',
          depth: 1,
          kind: 'm03_analysis',
          name: '渠道结构变化',
          reasonCode: null,
          severity: null,
          contributionPct: null,
          impactValue: -12,
          impactDisplay: { basis: 'impact_value', label: '影响量', text: '-12' },
          owner: 'M03',
          children: [
            node({
              attributionId: 'A-REV1-1-1',
              parentId: 'A-REV1-1',
              depth: 2,
              kind: 'm03_analysis',
              name: '大客户转投竞品',
              reasonCode: null,
              severity: null,
              contributionPct: null,
              impactValue: -12,
              impactDisplay: { basis: 'impact_value', label: '影响量', text: '-12' },
              owner: 'M03',
            }),
          ],
        }),
      ],
    }),
    node({ attributionId: 'A-REV2', name: 'KEY_ACCOUNT_CHURN', severity: 'medium', contributionPct: 30 }),
    node({ attributionId: 'A-REV3', name: 'DELIVERY_SLIP', severity: 'low', contributionPct: 20 }),
  ],
  reasonList: [],
};
OK_PAYLOAD.reasonList = visibleReasons(OK_PAYLOAD, []).concat(
  visibleReasons(OK_PAYLOAD, ['A-REV1', 'A-REV1-1']).filter((n) => n.depth > 0),
);

const UNATTRIBUTED_PAYLOAD = {
  state: 'UNATTRIBUTED',
  result: { code: 'order_backlog', name: '订单积压' },
  deviation: { target: 200, actual: 265, unit: '万元', deviation: 65, deviationPct: 32.5 },
  empty: {
    code: 'UNATTRIBUTED',
    title: '未归因',
    message: '该结果指标当前没有任何关联原因项。',
    hint: '请通过下方关联入口登记原因项；系统不回落到专业原始表查询。',
  },
  linkEntry: {
    label: '关联原因',
    method: 'POST',
    path: '/api/v1/results/M-BACKLOG/reasons',
    accepts: ['exceptionRef', 'name', 'direction', 'contributionPct', 'impactValue', 'owner'],
  },
  reasons: [],
  reasonList: [],
  count: 0,
  rootCount: 0,
  maxDepthReached: 0,
  directions: OK_PAYLOAD.directions,
  statusLabel: '未归因',
  attributionStatus: 'UNATTRIBUTED',
  notices: [{ code: 'UNATTRIBUTED', message: '该结果指标当前未归因，已提供关联入口；不显示空列表、不回落专业原始表。' }],
  fallbackPolicy: 'none',
};

describe('场景 1：原因项五字段展示', () => {
  it('每条原因项给出 原因名称 / 严重度 / 影响方向 / 影响量或贡献占比 / 责任方', () => {
    const fields = reasonFields(node());
    expect(fields.map((field) => field.label)).toEqual([
      '原因名称',
      '严重度',
      '影响方向',
      '贡献占比',
      '责任方',
    ]);
    const byKey = Object.fromEntries(fields.map((field) => [field.key, field.value]));
    expect(byKey.name).toBe('LOW_PRICE_ORDER');
    expect(byKey.severity).toBe('高');
    expect(byKey.direction).toBe('负向');
    expect(byKey.impact).toBe('50%');
    expect(byKey.owner).toBe('销售中心');
  });

  it('仅有影响量时改标「影响量」，仍满足「至少一项」', () => {
    const fields = reasonFields(
      node({
        kind: 'm03_analysis',
        severity: null,
        contributionPct: null,
        impactValue: -12,
        impactDisplay: { basis: 'impact_value', label: '影响量', text: '-12' },
      }),
    );
    const byKey = Object.fromEntries(fields.map((field) => [field.key, field.value]));
    expect(byKey.impact).toBe('-12');
    expect(fields.find((field) => field.key === 'impact').label).toBe('影响量');
  });

  it('字段缺失不静默丢弃，以 — 占位并标记缺失', () => {
    const fields = reasonFields({ name: 'X', direction: 'negative', owner: 'M03' });
    const missing = fields.filter((field) => field.missing).map((field) => field.key);
    expect(missing).toEqual(['severity', 'impact']);
    expect(fields.find((field) => field.key === 'severity').value).toBe('—');
  });
});

describe('判定标准 2：影响方向仅限 正向 / 负向 / 中性', () => {
  it('只认三个取值', () => {
    expect(Object.keys(DIRECTION_LABELS)).toEqual(['positive', 'negative', 'neutral']);
    expect(directionLabel('negative')).toBe('负向');
    expect(directionLabel('neutral')).toBe('中性');
  });

  it('越界取值返回 null，不当作合法方向渲染', () => {
    expect(directionLabel('up')).toBeNull();
    expect(directionLabel('正向')).toBeNull();
    expect(directionLabel(undefined)).toBeNull();
  });

  it('严重度越界时原样回显，不误标为已知档位', () => {
    expect(severityLabel('high')).toBe('高');
    expect(severityLabel('urgent')).toBe('urgent');
    expect(severityLabel(null)).toBeNull();
  });
});

describe('场景 2：完全归因口径展示', () => {
  it('汇总给出顶层合计、容差与归因状态', () => {
    const result = summarize(OK_PAYLOAD);
    expect(result.statusLabel).toBe('完全归因');
    expect(result.rootContributionPct).toBe(100);
    expect(result.tolerancePct).toBe(1);
    expect(result.sumsTo100WithinTolerance).toBe(true);
    expect(result.reasonCount).toBe(5);
    expect(result.rootCount).toBe(4);
  });

  it('偏差方向由 实际 − 目标 得出', () => {
    expect(deviationDirection(OK_PAYLOAD)).toBe('negative');
    expect(deviationDirection(UNATTRIBUTED_PAYLOAD)).toBe('positive');
    expect(deviationDirection({ deviation: { deviation: 0 } })).toBe('neutral');
    expect(deviationDirection({ deviation: {} })).toBeNull();
  });

  it('未查询时返回 IDLE 而非抛错', () => {
    expect(summarize(null).state).toBe('IDLE');
  });
});

describe('场景 3：多级展开深度由归因关系决定', () => {
  it('默认只摊平顶层，子项随展开出现', () => {
    const collapsed = visibleReasons(OK_PAYLOAD, []);
    expect(collapsed.map((n) => n.attributionId)).toEqual(['A-REV1', 'A-REV2', 'A-REV3']);
    expect(collapsed[0].expandable).toBe(true);
    expect(collapsed[0].childCount).toBe(1);
  });

  it('逐级展开可达第三级，不被导航层级截断', () => {
    const once = visibleReasons(OK_PAYLOAD, ['A-REV1']);
    expect(once.map((n) => n.attributionId)).toEqual(['A-REV1', 'A-REV1-1', 'A-REV2', 'A-REV3']);
    expect(visibleDepth(once)).toBe(1);

    const twice = visibleReasons(OK_PAYLOAD, ['A-REV1', 'A-REV1-1']);
    expect(twice.map((n) => n.attributionId)).toEqual([
      'A-REV1',
      'A-REV1-1',
      'A-REV1-1-1',
      'A-REV2',
      'A-REV3',
    ]);
    expect(visibleDepth(twice)).toBe(2);
  });

  it('展开状态与层级无关：任意深度的节点都能继续展开', () => {
    const third = visibleReasons(OK_PAYLOAD, ['A-REV1', 'A-REV1-1', 'A-REV1-1-1']);
    const leaf = third.find((n) => n.attributionId === 'A-REV1-1-1');
    expect(leaf.expandable).toBe(false);
    expect(leaf.expanded).toBe(false);
    expect(third).toHaveLength(5);
  });

  it('后端显式收窄时透出 truncated 提示', () => {
    const narrowed = visibleReasons(
      { reasons: [node({ truncated: true, children: [] })] },
      [],
    );
    expect(narrowed[0].truncated).toBe(true);
  });
});

describe('场景 4：类型判定展示', () => {
  it('给出两种判定文案', () => {
    expect(kindLabel({ kind: 'exception' })).toBe('映射至 Exception');
    expect(kindLabel({ kind: 'm03_analysis' })).toBe('M03 自有归因分析');
  });

  it('未知类型不渲染成任何已知判定', () => {
    expect(kindLabel({ kind: 'other' })).toBeNull();
    expect(kindLabel(null)).toBeNull();
  });
});

describe('边界 1：未归因指标显示空态与关联入口', () => {
  it('识别未归因状态', () => {
    expect(isUnattributed(UNATTRIBUTED_PAYLOAD)).toBe(true);
    expect(isUnattributed(OK_PAYLOAD)).toBe(false);
    expect(isUnattributed(null)).toBe(false);
  });

  it('空态带标题、说明与可操作入口，而不是空列表', () => {
    expect(UNATTRIBUTED_PAYLOAD.empty.title).toBe('未归因');
    expect(UNATTRIBUTED_PAYLOAD.linkEntry.method).toBe('POST');
    expect(UNATTRIBUTED_PAYLOAD.linkEntry.accepts).toContain('exceptionRef');
    expect(summarize(UNATTRIBUTED_PAYLOAD).reasonCount).toBe(0);
  });
});

describe('边界 2：兜底标注与表单校验', () => {
  it('登记结果里的兜底标注被透出', () => {
    expect(
      fallbackNotice({
        fallback: { code: 'MISSING_SEVERITY', message: '缺少 severity，按 M03 自有归因分析登记' },
      }),
    ).toEqual({ code: 'MISSING_SEVERITY', message: '缺少 severity，按 M03 自有归因分析登记' });
    expect(fallbackNotice({ fallback: null })).toBeNull();
    expect(fallbackNotice(null)).toBeNull();
  });

  it('空的数值字段不下发为 0', () => {
    const payload = toReasonPayload({ ...emptyReasonForm(), name: '渠道变化', contributionPct: '30' });
    expect(payload).toEqual({ direction: 'negative', name: '渠道变化', contributionPct: 30 });
  });

  it('细分时带上父原因项', () => {
    const payload = toReasonPayload(
      { ...emptyReasonForm(), name: '子原因', impactValue: '-12' },
      { parentId: 'A-REV1' },
    );
    expect(payload.parentId).toBe('A-REV1');
    expect(payload.impactValue).toBe(-12);
  });

  it('校验拦住越界方向与缺失影响依据', () => {
    expect(validateReasonPayload({ direction: 'up', name: 'X', contributionPct: 5 }).code).toBe(
      'INVALID_DIRECTION',
    );
    expect(validateReasonPayload({ direction: 'negative', name: 'X' }).code).toBe(
      'IMPACT_BASIS_REQUIRED',
    );
    expect(validateReasonPayload({ direction: 'negative', contributionPct: 5 }).code).toBe(
      'REASON_NAME_REQUIRED',
    );
    expect(validateReasonPayload({ direction: 'negative', name: 'X', contributionPct: 5 })).toBeNull();
  });
});

describe('状态容器', () => {
  it('查询成功后写入结果并默认展开顶层', async () => {
    const api = { get: vi.fn().mockResolvedValue(OK_PAYLOAD) };
    const store = createReasonDrilldownStore({ api });

    await store.load('M-REV');

    expect(api.get).toHaveBeenCalledWith('/results/M-REV/reasons');
    expect(store.state.payload.state).toBe('OK');
    expect(store.state.expandedIds).toEqual(['A-REV1', 'A-REV2', 'A-REV3']);
    expect(store.state.error).toBeNull();
  });

  it('指标引用编码进请求路径', async () => {
    const api = { get: vi.fn().mockResolvedValue(OK_PAYLOAD) };
    const store = createReasonDrilldownStore({ api });
    await store.load('M REV/1');
    expect(api.get).toHaveBeenCalledWith('/results/M%20REV%2F1/reasons');
  });

  it('展开 / 收起切换幂等', async () => {
    const api = { get: vi.fn().mockResolvedValue(OK_PAYLOAD) };
    const store = createReasonDrilldownStore({ api });
    await store.load('M-REV');

    store.collapseAll();
    expect(store.state.expandedIds).toEqual([]);
    store.toggle('A-REV1');
    expect(store.isExpanded('A-REV1')).toBe(true);
    store.toggle('A-REV1');
    expect(store.isExpanded('A-REV1')).toBe(false);
    store.expandAll();
    expect(store.state.expandedIds).toHaveLength(5);
  });

  it('空指标不发请求并提示', async () => {
    const api = { get: vi.fn() };
    const store = createReasonDrilldownStore({ api });
    const payload = await store.load('   ');
    expect(payload).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
    expect(store.state.error.code).toBe('METRIC_REQUIRED');
  });

  it('查询失败时保留错误码且不残留结果', async () => {
    const api = {
      get: vi.fn().mockRejectedValue(
        Object.assign(new Error('未找到结果指标: nope'), { code: 'METRIC_NOT_FOUND' }),
      ),
    };
    const store = createReasonDrilldownStore({ api });
    await store.load('nope');

    expect(store.state.error.code).toBe('METRIC_NOT_FOUND');
    expect(store.state.payload).toBeNull();
  });

  it('未归因指标同样写入结果（供空态渲染）', async () => {
    const api = { get: vi.fn().mockResolvedValue(UNATTRIBUTED_PAYLOAD) };
    const store = createReasonDrilldownStore({ api });
    await store.load('M-BACKLOG');

    expect(isUnattributed(store.state.payload)).toBe(true);
    expect(store.state.expandedIds).toEqual([]);
  });

  it('关联入口提交后就地刷新并回显兜底标注', async () => {
    const created = {
      created: [
        { attributionId: 'A-M-BACKLOG-手工判断', fallback: { code: 'NO_EXCEPTION_REF', message: '未引用已消费的 Exception，按 M03 自有归因分析登记' } },
      ],
    };
    const api = {
      get: vi.fn().mockResolvedValue(UNATTRIBUTED_PAYLOAD),
      post: vi.fn().mockResolvedValue(created),
    };
    const store = createReasonDrilldownStore({ api });
    await store.load('M-BACKLOG');

    store.setForm({ name: '手工判断：产能瓶颈', contributionPct: '100' });
    const result = await store.submitReason();

    expect(api.post).toHaveBeenCalledWith('/results/M-BACKLOG/reasons', {
      direction: 'negative',
      name: '手工判断：产能瓶颈',
      contributionPct: 100,
    });
    expect(result).toBe(created);
    expect(store.state.lastCreated[0].attributionId).toBe('A-M-BACKLOG-手工判断');
    expect(store.state.form.name).toBe('');
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('表单校验不通过时不发请求', async () => {
    const api = { get: vi.fn().mockResolvedValue(UNATTRIBUTED_PAYLOAD), post: vi.fn() };
    const store = createReasonDrilldownStore({ api });
    await store.load('M-BACKLOG');

    store.setForm({ name: '缺影响依据' });
    const result = await store.submitReason();

    expect(result).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
    expect(store.state.formError.code).toBe('IMPACT_BASIS_REQUIRED');
  });

  it('细分入口记录父原因项并在提交后清空', async () => {
    const api = {
      get: vi.fn().mockResolvedValue(OK_PAYLOAD),
      post: vi.fn().mockResolvedValue({ created: [] }),
    };
    const store = createReasonDrilldownStore({ api });
    await store.load('M-REV');

    store.setFormParent('A-REV1');
    store.setForm({ name: '子原因', impactValue: '-5' });
    await store.submitReason();

    expect(api.post).toHaveBeenCalledWith('/results/M-REV/reasons', {
      direction: 'negative',
      name: '子原因',
      impactValue: -5,
      parentId: 'A-REV1',
    });
    expect(store.state.formParentId).toBeNull();
  });
});
