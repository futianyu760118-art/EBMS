/**
 * F2 结果偏差归因穿透视图状态（PAND-80）。
 *
 * 展示口径（对应 AC）：
 *   - 场景 1：每条原因项展示 原因名称 / 严重度 / 影响方向 / 影响量或贡献占比 / 责任方；
 *   - 场景 2：完全归因时顶层贡献占比合计 100%（容差 ≤ 1%）；
 *   - 场景 3：展开深度由归因关系（parentId）决定，不因导航层级截断；
 *   - 场景 4：每条原因项展示类型判定（映射至 Exception / M03 自有归因分析）；
 *   - 边界 1：无关联原因时展示「未归因」空态与关联入口，不显示空列表；
 *   - 边界 2：缺少 reason_code / severity 的原因项按 M03 自有归因分析展示并标注。
 *
 * 纯函数与状态容器分开导出，便于直接对口径做单测。
 */

import { reactive } from 'vue';

/** 影响方向取值域 —— 前端只认这三者，越界取值不外显。 */
export const DIRECTION_LABELS = Object.freeze({
  positive: '正向',
  negative: '负向',
  neutral: '中性',
});

export const SEVERITY_LABELS = Object.freeze({
  high: '高',
  medium: '中',
  low: '低',
});

export const KIND_LABELS = Object.freeze({
  exception: '映射至 Exception',
  m03_analysis: 'M03 自有归因分析',
});

export const ATTRIBUTION_STATUS_LABELS = Object.freeze({
  FULLY_ATTRIBUTED: '完全归因',
  PARTIALLY_ATTRIBUTED: '部分归因',
  UNATTRIBUTED: '未归因',
});

/** 越界取值返回 null，避免把非法方向当合法值渲染出来。 */
export function directionLabel(value) {
  return DIRECTION_LABELS[value] ?? null;
}

export function severityLabel(value) {
  return value ? (SEVERITY_LABELS[value] ?? value) : null;
}

/** 场景 4：类型判定标签，不依赖颜色单独区分。 */
export function kindLabel(node) {
  return KIND_LABELS[node?.kind] ?? null;
}

export function isUnattributed(payload) {
  return Boolean(payload) && payload.state === 'UNATTRIBUTED';
}

/** 偏差方向：用于在指标头上标注偏差是正向还是负向。 */
export function deviationDirection(payload) {
  const deviation = payload?.deviation?.deviation;
  if (typeof deviation !== 'number') return null;
  if (deviation > 0) return 'positive';
  if (deviation < 0) return 'negative';
  return 'neutral';
}

/**
 * 场景 1：一条原因项的五个展示字段。
 * 字段缺失的项不会静默丢弃 —— 以「—」占位并标记缺失，便于暴露数据问题。
 */
export function reasonFields(node) {
  return [
    { key: 'name', label: '原因名称', value: node?.name ?? '—', missing: !node?.name },
    {
      key: 'severity',
      label: '严重度',
      value: severityLabel(node?.severity) ?? '—',
      missing: !node?.severity,
    },
    {
      key: 'direction',
      label: '影响方向',
      value: directionLabel(node?.direction) ?? '—',
      missing: !directionLabel(node?.direction),
    },
    {
      key: 'impact',
      label: node?.impactDisplay?.basis === 'impact_value' ? '影响量' : '贡献占比',
      value: node?.impactDisplay?.text ?? '—',
      missing: !node?.impactDisplay,
    },
    { key: 'owner', label: '责任方', value: node?.owner ?? '—', missing: !node?.owner },
  ];
}

/**
 * 场景 3：按当前展开状态摊平原因项。
 *
 * 递归只依据 `children`（即归因关系），与导航层级无关：
 * 任意层级都能继续展开，展开的层数就是数据里存在的层数。
 */
export function visibleReasons(payload, expandedIds = []) {
  const expanded = new Set(expandedIds);
  const out = [];
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      const expandable = (node.children ?? []).length > 0;
      out.push({
        ...node,
        childCount: (node.children ?? []).length,
        expandable,
        // 只有可展开的节点才谈得上「已展开」
        expanded: expandable && expanded.has(node.attributionId),
        // 后端仅在显式收窄时给出 truncated；界面上要提示「还有更深一层」
        truncated: Boolean(node.truncated),
      });
      if (expanded.has(node.attributionId)) walk(node.children);
    }
  };
  walk(payload?.reasons ?? []);
  return out;
}

/** 已摊平结果里最深的一级，用于展示「当前展开到第几级」。 */
export function visibleDepth(nodes) {
  return (nodes ?? []).reduce((max, node) => Math.max(max, node.depth ?? 0), 0);
}

/** 场景 2：顶部汇总口径。 */
export function summarize(payload) {
  if (!payload) {
    return {
      state: 'IDLE',
      statusLabel: null,
      reasonCount: 0,
      rootCount: 0,
      rootContributionPct: null,
      tolerancePct: 1,
      sumsTo100WithinTolerance: false,
      maxDepthReached: 0,
      exceptionCount: 0,
      m03Count: 0,
    };
  }
  const list = payload.reasonList ?? [];
  return {
    state: payload.state,
    statusLabel:
      payload.statusLabel ?? ATTRIBUTION_STATUS_LABELS[payload.attributionStatus] ?? null,
    reasonCount: list.length,
    rootCount: payload.rootCount ?? payload.summary?.rootCount ?? 0,
    rootContributionPct: payload.summary?.rootContributionPct ?? null,
    tolerancePct: payload.summary?.tolerancePct ?? 1,
    sumsTo100WithinTolerance: Boolean(payload.summary?.sumsTo100WithinTolerance),
    maxDepthReached: payload.maxDepthReached ?? 0,
    exceptionCount: list.filter((item) => item.kind === 'exception').length,
    m03Count: list.filter((item) => item.kind === 'm03_analysis').length,
  };
}

/** 边界 2：登记结果里的兜底标注（缺少 reason_code / severity 时的显式说明）。 */
export function fallbackNotice(row) {
  if (!row?.fallback) return null;
  return { code: row.fallback.code, message: row.fallback.message };
}

/** 空的原因项输入表单（关联入口与「新增原因」共用）。 */
export function emptyReasonForm() {
  return {
    exceptionRef: '',
    name: '',
    direction: 'negative',
    contributionPct: '',
    impactValue: '',
    owner: '',
  };
}

/**
 * 把表单转成接口载荷：空的数值字段不下发（避免把 '' 当 0）。
 * 影响量与贡献占比至少给一个，否则不提交。
 */
export function toReasonPayload(form, { parentId = null } = {}) {
  const payload = {
    direction: form.direction,
  };
  if (form.exceptionRef?.trim()) payload.exceptionRef = form.exceptionRef.trim();
  if (form.name?.trim()) payload.name = form.name.trim();
  if (form.owner?.trim()) payload.owner = form.owner.trim();
  if (parentId) payload.parentId = parentId;

  const pct = form.contributionPct === '' || form.contributionPct == null
    ? null
    : Number(form.contributionPct);
  const impact = form.impactValue === '' || form.impactValue == null
    ? null
    : Number(form.impactValue);
  if (Number.isFinite(pct)) payload.contributionPct = pct;
  if (Number.isFinite(impact)) payload.impactValue = impact;
  return payload;
}

export function validateReasonPayload(payload) {
  if (!DIRECTION_LABELS[payload.direction]) {
    return { code: 'INVALID_DIRECTION', message: '影响方向只能取 正向 / 负向 / 中性' };
  }
  if (payload.contributionPct == null && payload.impactValue == null) {
    return { code: 'IMPACT_BASIS_REQUIRED', message: '请至少填写贡献占比或影响量' };
  }
  if (!payload.exceptionRef && !payload.name) {
    return {
      code: 'REASON_NAME_REQUIRED',
      message: '请填写 exceptionRef（映射 Exception）或 name（M03 自有归因分析）',
    };
  }
  return null;
}

export function createReasonDrilldownStore({ api }) {
  const state = reactive({
    metricRef: '',
    loading: false,
    error: null,
    payload: null,
    // 展开的原因项 id（场景 3：多级展开，深度由归因关系决定）
    expandedIds: [],
    // 关联入口表单
    form: emptyReasonForm(),
    formParentId: null,
    submitting: false,
    formError: null,
    lastCreated: [],
  });

  function endpoint(metricRef) {
    return `/results/${encodeURIComponent(metricRef)}/reasons`;
  }

  async function load(metricRef = state.metricRef) {
    const ref = String(metricRef ?? '').trim();
    if (!ref) {
      state.error = { code: 'METRIC_REQUIRED', message: '请填写结果指标（id 或 code）' };
      return null;
    }
    state.metricRef = ref;
    state.loading = true;
    state.error = null;
    try {
      const payload = await api.get(endpoint(ref));
      state.payload = payload;
      // 顶层默认展开，便于一眼看到全部一级原因
      state.expandedIds = (payload.reasons ?? []).map((node) => node.attributionId);
      return payload;
    } catch (err) {
      state.error = { code: err?.code ?? 'QUERY_FAILED', message: err?.message ?? '查询失败' };
      state.payload = null;
      return null;
    } finally {
      state.loading = false;
    }
  }

  function isExpanded(attributionId) {
    return state.expandedIds.includes(attributionId);
  }

  function toggle(attributionId) {
    if (isExpanded(attributionId)) {
      state.expandedIds = state.expandedIds.filter((id) => id !== attributionId);
    } else {
      state.expandedIds = [...state.expandedIds, attributionId];
    }
  }

  function expandAll() {
    state.expandedIds = (state.payload?.reasonList ?? []).map((node) => node.attributionId);
  }

  function collapseAll() {
    state.expandedIds = [];
  }

  function setForm(patch) {
    state.form = { ...state.form, ...patch };
  }

  function setFormParent(parentId) {
    state.formParentId = parentId;
  }

  function resetForm() {
    state.form = emptyReasonForm();
    state.formParentId = null;
    state.formError = null;
  }

  /** 关联入口：登记原因项并就地刷新（含兜底标注回显）。 */
  async function submitReason() {
    const payload = toReasonPayload(state.form, { parentId: state.formParentId });
    const invalid = validateReasonPayload(payload);
    if (invalid) {
      state.formError = invalid;
      return null;
    }
    state.submitting = true;
    state.formError = null;
    try {
      const result = await api.post(endpoint(state.metricRef), payload);
      state.lastCreated = result.created ?? [];
      resetForm();
      await load(state.metricRef);
      return result;
    } catch (err) {
      state.formError = {
        code: err?.code ?? 'LINK_FAILED',
        message: err?.message ?? '关联原因失败',
      };
      return null;
    } finally {
      state.submitting = false;
    }
  }

  function reset() {
    state.metricRef = '';
    state.payload = null;
    state.error = null;
    state.expandedIds = [];
    state.lastCreated = [];
    resetForm();
  }

  return {
    state,
    load,
    toggle,
    isExpanded,
    expandAll,
    collapseAll,
    setForm,
    setFormParent,
    resetForm,
    submitReason,
    reset,
  };
}
