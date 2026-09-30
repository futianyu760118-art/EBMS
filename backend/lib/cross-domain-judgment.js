/**
 * 跨域经营判断领域规则（PAND-91 / AEOS M03）
 * ------------------------------------------------------------------
 * 口径红线（P0 架构冻结 · EBMS_GUARDRAILS_V1）：
 *  1. 「只汇聚、不重算」：EBMS 只读取各专业中心上报的字段原样引用
 *     （actual / target / deviation_abs / deviation_pct / threshold_pct / data_status），
 *     绝不从 target/actual 反推偏差，也不计算中心内部指标。
 *  2. 中心未上报偏差字段时保持空值，并以 deviation_available=false 显式声明口径；
 *     判断输出带 computation_scope 声明 recomputed=false。
 *  3. 单域数据缺失不阻断判断：缺失域以「该域数据缺失」标注、排除出参与判断与引用集合，
 *     其余域照常判断。
 *  4. 参与域少于 2 个时不输出层级结论，返回 insufficient_data（数据不足）。
 *  5. 中心口径范围：销售 / 生产·交付 / 财务 / 供应链 四域。
 *
 * 本模块为纯函数（不依赖 db / express / 时间），便于回归测试，
 * 与 backend/lib/order-analysis-rules.js 保持同一约定。
 */

const RULE_VERSION = 'M03-CROSS-DOMAIN-V1';

/** 跨域专业中心域范围（业务方 2026-09-23 确认的最终口径） */
const DOMAINS = [
  { code: 'sales', label: '销售', source_system: 'M05' },
  { code: 'production', label: '生产/交付', source_system: 'M06' },
  { code: 'finance', label: '财务', source_system: 'M09' },
  { code: 'supply_chain', label: '供应链', source_system: 'M06' }
];

const DOMAIN_BY_CODE = DOMAINS.reduce((acc, d) => { acc[d.code] = d; return acc; }, {});

/** 缺失域在界面上统一标注为「该域数据缺失」，reason 为可追溯的缺失原因 */
const MISSING_LABEL = '该域数据缺失';

const MISSING_REASONS = {
  no_conclusion: '该域未上报结论',
  empty_metrics: '该域结论未包含指标',
  data_status_missing: '该域上报数据缺失',
  invalid_payload: '该域结论格式不合法'
};

/** 判断层级：按「存在显著负向偏差的参与域」个数分档 */
const LEVELS = {
  insufficient_data: { code: 'insufficient_data', label: '数据不足', severity: 0 },
  stable: { code: 'stable', label: '平稳', severity: 1 },
  attention: { code: 'attention', label: '关注', severity: 2 },
  warning: { code: 'warning', label: '警示', severity: 3 },
  critical: { code: 'critical', label: '严重', severity: 4 }
};

/** 判断至少需要 2 个专业中心域产出结论（PAND-91 前置条件） */
const MIN_PARTICIPATING_DOMAINS = 2;

/** 判定标准：抽样不少于 10 条、一致率 100% */
const CONSISTENCY_REQUIREMENT = { min_sample: 10, required_match_rate: 1 };

/** 来源不可用时的展示文案（来源标注不可为空） */
const SOURCE_UNAVAILABLE = '来源不可用';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function normalizePeriod(period) {
  const p = String(period == null ? '' : period).trim();
  return PERIOD_RE.test(p) ? p : null;
}

function toNumberOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 归一化单条中心上报指标 —— 只做字段搬运，不做任何计算。
 * deviation_available 标记中心是否上报了偏差率；未上报时保持 null，不从 target/actual 反推。
 */
function normalizeMetric(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const pct = toNumberOrNull(m.deviation_pct);
  const abs = toNumberOrNull(m.deviation_abs);
  const deviationAvailable = pct !== null;
  return {
    code: String(m.code || ''),
    name: m.name ? String(m.name) : String(m.code || ''),
    unit: m.unit ? String(m.unit) : '',
    actual: m.actual === undefined ? null : m.actual,
    target: m.target === undefined ? null : m.target,
    deviation_abs: abs,
    deviation_pct: pct,
    threshold_pct: toNumberOrNull(m.threshold_pct),
    deviation_available: deviationAvailable,
    // 口径声明：偏差值只能来自中心上报，EBMS 不做任何推导
    deviation_basis: deviationAvailable ? 'center_reported' : 'center_not_reported',
    reported_status: m.status ? String(m.status) : null,
    recomputed: false
  };
}

/**
 * 指标是否为「显著负向偏差」—— 仅依据中心上报的 deviation_pct 与 threshold_pct 判定。
 * 中心未上报偏差率时不计为负向（不臆测）。
 */
function isNegativeMetric(metric) {
  if (!metric || !metric.deviation_available) return false;
  const threshold = metric.threshold_pct === null ? 0 : Math.abs(metric.threshold_pct);
  return metric.deviation_pct <= -threshold && metric.deviation_pct < 0;
}

function missingView(center, reason) {
  const def = DOMAIN_BY_CODE[center] || { code: center, label: center, source_system: '' };
  return {
    center,
    center_label: def.label,
    available: false,
    missing_label: MISSING_LABEL,
    missing_reason: reason,
    missing_reason_label: MISSING_REASONS[reason] || reason,
    conclusion_id: null,
    source_system: def.source_system,
    calculation_version: null,
    as_of: null,
    data_cutoff: null,
    trace_id: null,
    evidence_ids: [],
    metric_count: 0,
    metrics: [],
    negative_metrics: [],
    has_negative: false,
    payload: null
  };
}

/**
 * 把一条中心结论归一化为域视图。仅做结构与字段搬运，不重算任何中心内部指标。
 * @returns 域视图（available=false 时带 missing_reason）
 */
function evaluateConclusion(center, conclusion) {
  if (!conclusion || typeof conclusion !== 'object') return missingView(center, 'no_conclusion');
  const dataStatus = String(conclusion.data_status || '').toLowerCase();
  if (dataStatus === 'missing') return missingView(center, 'data_status_missing');
  const rawMetrics = Array.isArray(conclusion.metrics) ? conclusion.metrics : [];
  const metrics = rawMetrics.filter(m => m && m.code).map(normalizeMetric);
  if (!metrics.length) return missingView(center, 'empty_metrics');

  const def = DOMAIN_BY_CODE[center] || { code: center, label: center, source_system: '' };
  const negativeMetrics = metrics.filter(isNegativeMetric);
  return {
    center,
    center_label: def.label,
    available: true,
    missing_label: null,
    missing_reason: null,
    missing_reason_label: null,
    conclusion_id: conclusion.conclusion_id != null ? String(conclusion.conclusion_id) : null,
    source_system: conclusion.source_system ? String(conclusion.source_system) : def.source_system,
    calculation_version: conclusion.calculation_version ? String(conclusion.calculation_version) : null,
    as_of: conclusion.occurred_at ? String(conclusion.occurred_at) : null,
    data_cutoff: conclusion.data_cutoff ? String(conclusion.data_cutoff) : null,
    trace_id: conclusion.trace_id ? String(conclusion.trace_id) : null,
    evidence_ids: Array.isArray(conclusion.evidence_ids) ? conclusion.evidence_ids.slice() : [],
    metric_count: metrics.length,
    metrics,
    negative_metrics: negativeMetrics.map(m => m.code),
    has_negative: negativeMetrics.length > 0,
    payload: conclusion
  };
}

/**
 * 按四域汇总中心结论快照 → 域视图集合。
 * @param {Array} conclusions 中心结论快照列表（已按 中心+周期 归一的当前有效版本）
 * @returns {{domains, present, missing}}
 */
function evaluateDomains(conclusions) {
  const byCenter = {};
  (Array.isArray(conclusions) ? conclusions : []).forEach(c => {
    if (c && c.center && !byCenter[c.center]) byCenter[c.center] = c;
  });
  const domains = {};
  DOMAINS.forEach(d => {
    domains[d.code] = evaluateConclusion(d.code, byCenter[d.code]);
  });
  const present = DOMAINS.filter(d => domains[d.code].available).map(d => d.code);
  const missing = DOMAINS.filter(d => !domains[d.code].available).map(d => d.code);
  return { domains, present, missing };
}

function resolveLevel(negativeCount, participatingCount) {
  if (participatingCount < MIN_PARTICIPATING_DOMAINS) return LEVELS.insufficient_data;
  if (negativeCount >= 3) return LEVELS.critical;
  if (negativeCount === 2) return LEVELS.warning;
  if (negativeCount === 1) return LEVELS.attention;
  return LEVELS.stable;
}

/** 来源标注：只能产出「中心名称 · 结论时间 · 版本 x」或字面量「来源不可用」 */
function buildSourceLabel(view) {
  if (!view || !view.center_label) return SOURCE_UNAVAILABLE;
  const parts = [view.center_label];
  if (view.as_of) parts.push(view.as_of);
  if (view.calculation_version) parts.push('版本 ' + view.calculation_version);
  return parts.join(' · ');
}

/** 引用明细：跨域结论引用的各专业中心结论，逐条可追溯回中心快照 */
function buildReferences(domains, present) {
  return present.map(code => {
    const v = domains[code];
    return {
      center: v.center,
      center_label: v.center_label,
      conclusion_id: v.conclusion_id,
      version: v.calculation_version,
      as_of: v.as_of,
      data_cutoff: v.data_cutoff,
      source_system: v.source_system,
      trace_id: v.trace_id,
      evidence_ids: v.evidence_ids.slice(),
      metric_codes: v.metrics.map(m => m.code),
      source_label: buildSourceLabel(v)
    };
  });
}

function formatPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}

/** 生成可读的跨域判断结论文案（只复述中心上报值，不引入新数字） */
function buildConclusionText(period, level, domains, present, negativeCodes) {
  const labels = present.map(c => domains[c].center_label);
  if (level.code === 'insufficient_data') {
    return `${period} 跨域经营判断：${level.label}。仅 ${present.length} 个专业中心域产出结论`
      + `（${labels.join('、')}），少于 ${MIN_PARTICIPATING_DOMAINS} 个域，不输出层级结论。`;
  }
  const detail = negativeCodes.map(code => {
    const v = domains[code];
    const codes = v.metrics.filter(isNegativeMetric)
      .map(m => `${m.name} ${formatPct(m.deviation_pct)}`)
      .join('、');
    return `${v.center_label}（${codes}）`;
  }).join('；');
  const head = `${period} 跨域经营判断：${level.label}。${present.length} 个专业中心域参与判断`;
  const body = negativeCodes.length
    ? `，其中 ${negativeCodes.length} 个域存在显著负向偏差：${detail}`
    : `，各域均在中心上报的偏差阈值内`;
  return head + body + '。';
}

/**
 * 汇聚各专业中心结论形成跨域经营判断（不重算中心内部算法）。
 * @param {object} params
 * @param {string} params.period       判断周期 YYYY-MM
 * @param {Array}  params.conclusions  该周期各中心结论快照
 * @param {string} [params.judgmentId] 判断记录 id
 * @param {string} [params.generatedAt] 生成时间
 * @param {string} [params.ruleVersion] 规则版本
 * @returns 跨域判断对象（含域视图 / 引用 / 缺失域 / 口径声明）
 */
function buildJudgment(params) {
  const p = params || {};
  const period = normalizePeriod(p.period);
  if (!period) throw new Error('buildJudgment: 周期格式必须为 YYYY-MM');
  const evaluated = evaluateDomains(p.conclusions);
  const { domains, present, missing } = evaluated;

  const negativeCodes = present.filter(c => domains[c].has_negative);
  const level = resolveLevel(negativeCodes.length, present.length);

  const missingDetails = missing.map(code => ({
    center: code,
    center_label: domains[code].center_label,
    missing_label: MISSING_LABEL,
    missing_reason: domains[code].missing_reason,
    missing_reason_label: domains[code].missing_reason_label
  }));

  const references = buildReferences(domains, present);

  return {
    judgment_id: p.judgmentId != null ? String(p.judgmentId) : null,
    period,
    rule_version: p.ruleVersion || RULE_VERSION,
    level: level.code,
    level_label: level.label,
    severity: level.severity,
    conclusion_text: buildConclusionText(period, level, domains, present, negativeCodes),
    present_domains: present,
    present_domain_labels: present.map(c => domains[c].center_label),
    missing_domains: missing,
    missing_domain_details: missingDetails,
    negative_domains: negativeCodes,
    participating_count: present.length,
    reference_count: references.length,
    references,
    domains,
    // 口径声明：EBMS 只消费中心上报值，本判断不重算任何专业中心内部指标
    computation_scope: {
      module: 'M03',
      recomputed: false,
      basis: 'center_reported_values_only',
      note: '展示值一律取自专业中心上报结论，EBMS 不重算中心内部算法'
    },
    generated_at: p.generatedAt || null
  };
}

/**
 * 引用可追溯性核验：跨域结论引用的每条中心结论都能回查到中心快照。
 * @param {object} judgment
 * @param {object} conclusionIndex { [center]: conclusionSnapshot }
 */
function verifyReferences(judgment, conclusionIndex) {
  const refs = (judgment && Array.isArray(judgment.references)) ? judgment.references : [];
  const index = conclusionIndex || {};
  const unresolved = [];
  refs.forEach(ref => {
    const snap = index[ref.center];
    const snapId = snap && snap.conclusion_id != null ? String(snap.conclusion_id) : null;
    if (!snap || !ref.conclusion_id || snapId !== String(ref.conclusion_id)) {
      unresolved.push(ref.conclusion_id);
    }
  });
  return {
    all_resolved: unresolved.length === 0,
    reference_count: refs.length,
    unresolved_conclusion_ids: unresolved
  };
}

function sameValue(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a); const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  }
  return String(a) === String(b);
}

/**
 * 判定标准可执行化：轮转抽样比对「中心输出值」与「EBMS 展示值」。
 *  - 覆盖全部参与域（按域轮转取样，避免单域独占样本）；
 *  - 一致率要求 100%、有效样本不少于 10 条；
 *  - 缺失域样本以明确口径说明跳过，不计入一致率分母；
 *  - 差异必须由调用方登记明确口径说明（differenceExplanations）才视为已解释，
 *    EBMS 不自动为差异背书；出现未解释差异 → 判定不成立（passed=false），不静默通过。
 * @param {object} judgment 跨域判断对象
 * @param {Array}  conclusions 周期内中心结论快照
 * @param {object} [options] { minSample, sampleLimit, differenceExplanations }
 *        differenceExplanations: { '中心|指标编码': '口径说明' }
 */
function sampleConsistency(judgment, conclusions, options) {
  const opts = options || {};
  const minSample = Number.isFinite(opts.minSample) ? opts.minSample : CONSISTENCY_REQUIREMENT.min_sample;
  const sampleLimit = Number.isFinite(opts.sampleLimit) ? opts.sampleLimit : null;
  const differenceExplanations = opts.differenceExplanations || {};

  const byCenter = {};
  (Array.isArray(conclusions) ? conclusions : []).forEach(c => {
    if (c && c.center && !byCenter[c.center]) byCenter[c.center] = c;
  });

  const present = (judgment && judgment.present_domains) || [];
  // 按域轮转：每轮从各域取一条，保证样本覆盖全部参与域
  const queues = present.map(code => {
    const view = judgment.domains[code] || { metrics: [] };
    return { center: code, metrics: view.metrics.slice() };
  });
  const samples = [];
  let round = 0;
  while (queues.some(q => q.metrics.length > 0)) {
    queues.forEach(q => {
      if (!q.metrics.length) return;
      const metric = q.metrics.shift();
      const snap = byCenter[q.center];
      const snapMetric = snap && Array.isArray(snap.metrics)
        ? snap.metrics.find(m => m && String(m.code) === String(metric.code))
        : null;
      const centerValue = snapMetric ? (snapMetric.actual === undefined ? null : snapMetric.actual) : null;
      const ebmsValue = metric.actual;
      const consistent = sameValue(centerValue, ebmsValue);
      // 差异的口径说明必须由调用方显式登记，EBMS 不自动为差异背书
      const declared = differenceExplanations[q.center + '|' + metric.code];
      samples.push({
        center: q.center,
        center_label: (judgment.domains[q.center] || {}).center_label || q.center,
        metric_code: metric.code,
        metric_name: metric.name,
        unit: metric.unit,
        center_value: centerValue,
        ebms_value: ebmsValue,
        deviation_pct: metric.deviation_pct,
        consistent,
        explanation: consistent ? null : (declared ? String(declared) : null)
      });
    });
    round++;
  }

  const limited = sampleLimit && samples.length > sampleLimit ? samples.slice(0, sampleLimit) : samples;

  const skipped = ((judgment && judgment.missing_domain_details) || []).map(d => ({
    center: d.center,
    center_label: d.center_label,
    reason: d.missing_reason,
    explanation: `${d.missing_reason_label}（${MISSING_LABEL}），未纳入一致率分母`
  }));

  const mismatched = limited.filter(s => !s.consistent);
  const explained = mismatched.filter(s => s.explanation);
  const unexplained = mismatched.filter(s => !s.explanation);
  const matched = limited.filter(s => s.consistent).length;
  const sampleSize = limited.length;
  const matchRate = sampleSize ? matched / sampleSize : 0;

  // 判定口径：一致率 100% 是默认要求；出现差异时，差异必须带明确口径说明方可成立
  const failures = [];
  if (sampleSize < minSample) failures.push(`有效比对样本 ${sampleSize} 条，少于要求的 ${minSample} 条`);
  if (unexplained.length > 0) failures.push(`存在 ${unexplained.length} 条未解释差异`);

  return {
    period: judgment ? judgment.period : null,
    requirement: { min_sample: minSample, required_match_rate: CONSISTENCY_REQUIREMENT.required_match_rate },
    sample_size: sampleSize,
    domains_covered: [...new Set(limited.map(s => s.center))],
    matched,
    mismatched: mismatched.length,
    explained_difference_count: explained.length,
    unexplained_difference_count: unexplained.length,
    all_differences_explained: unexplained.length === 0,
    match_rate: matchRate,
    samples: limited,
    skipped_missing_domains: skipped,
    passed: failures.length === 0,
    conclusion: failures.length === 0
      ? `抽样 ${sampleSize} 条、覆盖 ${new Set(limited.map(s => s.center)).size} 个域，一致率 ${(matchRate * 100).toFixed(2)}%`
        + (explained.length ? `（其中 ${explained.length} 条差异已附口径说明）` : '')
        + '，EBMS 展示值与专业中心输出值一致，判定成立。'
      : `判定不成立：${failures.join('；')}。`,
    failures
  };
}

module.exports = {
  RULE_VERSION,
  DOMAINS,
  DOMAIN_BY_CODE,
  MISSING_LABEL,
  MISSING_REASONS,
  LEVELS,
  SOURCE_UNAVAILABLE,
  MIN_PARTICIPATING_DOMAINS,
  CONSISTENCY_REQUIREMENT,
  normalizePeriod,
  normalizeMetric,
  isNegativeMetric,
  evaluateConclusion,
  evaluateDomains,
  resolveLevel,
  buildSourceLabel,
  buildReferences,
  buildJudgment,
  verifyReferences,
  sampleConsistency
};
