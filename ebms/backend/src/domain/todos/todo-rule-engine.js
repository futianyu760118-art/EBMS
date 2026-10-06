'use strict';

// F8（PAND-86）规则引擎：TODO 的两种来源之一「系统按规则自动产生」。
//
// 分层口径：规则只读 EBMS 已汇聚的结论（F1 指标集的偏差 / F2 归因锚点），
// 不读 orders / materials 等专业中心原始表，也不重算专业算法（P0 边界）。
// 「无数据」不触发：Owner 模块未供给实际值时不存在偏差，不能凭空产生待办。
//
// 幂等：rule_key = "<rule_code>:<ref_id>"，同一规则对同一锚点重复扫描只留一行
// （库层唯一索引 + 扫描前一次性取回既有键集合）。

const { withTransaction } = require('../../db/pool');
const auditRepo = require('../audit/audit-repository');
const reasonRepo = require('../reason/reason-repository');
const resultService = require('../results/result-service');
const todoRepo = require('./todo-repository');
const { DEFAULT_STATUS } = require('./todo-status');

const DAY = 24 * 60 * 60 * 1000;

// 规则目录：接口下发的唯一取值来源，也是「自动待办触发依据」里 rule_code 的合法集合。
const RULES = Object.freeze({
  'R-RESULT-DEVIATION': Object.freeze({
    code: 'R-RESULT-DEVIATION',
    label: '结果指标偏差达阈值',
    description: '指标已供给实际值，且偏差率绝对值超过该指标配置的阈值 → 自动产生待办。无数据的指标不触发。',
    anchor: 'result',
    dueDays: 7,
  }),
  'R-REASON-NEGATIVE': Object.freeze({
    code: 'R-REASON-NEGATIVE',
    label: '原因项负向贡献达阈值',
    description: '归因项方向为负向，且贡献占比达到阈值 → 自动产生待办。',
    anchor: 'reason',
    dueDays: 14,
  }),
});

const RULE_CODES = Object.freeze(Object.keys(RULES));
const DEFAULT_REASON_CONTRIBUTION_PCT = 20;

function listRules() {
  return RULE_CODES.map((code) => {
    const rule = RULES[code];
    return { code: rule.code, label: rule.label, description: rule.description, anchor: rule.anchor };
  });
}

function daysAfter(iso, days) {
  if (!iso) return null;
  const base = new Date(iso);
  if (Number.isNaN(base.getTime())) return null;
  return new Date(base.getTime() + days * DAY).toISOString();
}

function ruleKeyOf(ruleCode, refId) {
  return `${ruleCode}:${refId}`;
}

// ---------------------------------------------------------------- 候选计算（纯逻辑，可 dry-run）

function candidatesFromMetrics(overview, now) {
  const rule = RULES['R-RESULT-DEVIATION'];
  const candidates = [];

  for (const metric of overview.items) {
    // 边界：无数据 ≠ 偏差。未供给实际值的指标一律不产生待办。
    if (!metric.hasData || !metric.deviation || !metric.deviation.computable) continue;
    if (metric.deviation.exceeded !== true) continue;

    const pct = metric.deviation.pct;
    const threshold = metric.deviation.thresholdPct;
    candidates.push({
      ruleCode: rule.code,
      ruleKey: ruleKeyOf(rule.code, metric.id),
      refId: metric.id,
      title: `处理指标「${metric.name}」偏差：当前 ${pct === null ? '—' : `${pct}%`}，阈值 ${threshold}%`,
      dueAt: daysAfter(metric.dataCutoffAt, rule.dueDays),
      relatedRefs: [
        {
          refType: 'result',
          refTypeLabel: '结果指标',
          refId: metric.id,
          code: metric.code,
          label: metric.name,
        },
      ],
      triggerBasis: {
        ruleCode: rule.code,
        ruleLabel: rule.label,
        summary: `${metric.periodType}/${metric.periodValue} 指标「${metric.name}」偏差 ${
          metric.deviation.value === null ? '—' : metric.deviation.value
        }（${pct === null ? '—' : `${pct}%`}），超过阈值 ${threshold}%`,
        periodType: metric.periodType,
        periodValue: metric.periodValue,
        resultMetricId: metric.id,
        resultMetricCode: metric.code,
        reasonId: null,
        detectedAt: now.toISOString(),
      },
    });
  }
  return candidates;
}

function candidatesFromReasons(reasons, { now, thresholdPct = DEFAULT_REASON_CONTRIBUTION_PCT } = {}) {
  const rule = RULES['R-REASON-NEGATIVE'];
  const candidates = [];

  for (const reason of reasons) {
    if (reason.direction !== 'negative') continue;
    const contribution = reason.contribution_pct === null || reason.contribution_pct === undefined
      ? null
      : Number(reason.contribution_pct);
    if (contribution === null || !Number.isFinite(contribution)) continue;
    if (contribution < thresholdPct) continue;

    candidates.push({
      ruleCode: rule.code,
      ruleKey: ruleKeyOf(rule.code, reason.id),
      refId: reason.id,
      title: `处理原因项「${reason.name}」：负向贡献 ${contribution}%`,
      dueAt: daysAfter(now.toISOString(), rule.dueDays),
      relatedRefs: [
        {
          refType: 'reason',
          refTypeLabel: '原因项',
          refId: reason.id,
          code: null,
          label: reason.name,
          direction: reason.direction,
        },
      ],
      triggerBasis: {
        ruleCode: rule.code,
        ruleLabel: rule.label,
        summary: `原因项「${reason.name}」为负向归因，贡献占比 ${contribution}%（阈值 ${thresholdPct}%）`,
        periodType: null,
        periodValue: null,
        resultMetricId: null,
        reasonId: reason.id,
        contributionPct: contribution,
        detectedAt: now.toISOString(),
      },
    });
  }
  return candidates;
}

// ---------------------------------------------------------------- 扫描与落库

/**
 * 扫描规则并产生待办。
 * dryRun=true 时只返回候选与判定依据，不写库（联调与判定核对用）。
 */
async function scanRules(actor, { periodType, periodValue, dryRun = false, now = new Date() } = {}) {
  const overview = await resultService.getOverview({ periodType, periodValue });
  const reasons = await reasonRepo.listAll();

  const candidates = [
    ...candidatesFromMetrics(overview, now),
    ...candidatesFromReasons(reasons, { now }),
  ];

  const existingKeys = await todoRepo.listRuleKeys();
  const pending = candidates.filter((c) => !existingKeys.has(c.ruleKey));
  const skipped = candidates
    .filter((c) => existingKeys.has(c.ruleKey))
    .map((c) => ({ ruleKey: c.ruleKey, reason: '已存在（幂等跳过）' }));

  if (dryRun) {
    return {
      dryRun: true,
      scannedAt: now.toISOString(),
      period: overview.period,
      rules: listRules(),
      candidateCount: candidates.length,
      newCount: pending.length,
      candidates,
      created: [],
      skipped,
    };
  }

  const created = [];
  for (const candidate of pending) {
    const row = await persistCandidate(actor, candidate);
    // 并发扫描时唯一索引兜底：写不进去说明别人已经产生，按幂等跳过
    if (row) created.push(row);
    else skipped.push({ ruleKey: candidate.ruleKey, reason: '已存在（唯一键兜底跳过）' });
  }

  return {
    dryRun: false,
    scannedAt: now.toISOString(),
    period: overview.period,
    rules: listRules(),
    candidateCount: candidates.length,
    newCount: created.length,
    candidates: pending,
    created,
    skipped,
  };
}

async function persistCandidate(actor, candidate) {
  return withTransaction(async (client) => {
    const row = await todoRepo.insert(client, {
      code: buildRuleCode(candidate),
      title: candidate.title,
      source: 'rule',
      status: DEFAULT_STATUS,
      // 自动产生的待办默认不指派：留给责任人「认领」（AC 场景 2 的并存形态）
      owner: null,
      dueAt: candidate.dueAt,
      relatedRefs: candidate.relatedRefs,
      triggerBasis: candidate.triggerBasis,
      ruleKey: candidate.ruleKey,
      createdBy: actor.id,
    });
    if (!row) return null;

    await auditRepo.record(client, {
      actor: actor.id,
      actorName: actor.displayName || actor.username || actor.id,
      action: 'todo.rule_generate',
      entityType: 'todo',
      entityId: String(row.id),
      after: {
        code: row.code,
        title: row.title,
        ruleKey: row.rule_key,
        ruleCode: candidate.ruleCode,
        triggerBasis: candidate.triggerBasis,
      },
    });
    return {
      id: row.id,
      code: row.code,
      title: row.title,
      source: row.source,
      status: row.status,
      owner: row.owner,
      dueAt: row.due_at,
      ruleKey: row.rule_key,
      triggerBasis: row.trigger_basis,
      relatedRefs: row.related_refs,
    };
  });
}

/** 规则产生的编号可读且与锚点一一对应：TODO-<规则短码>-<锚点前 12 位>。 */
function buildRuleCode(candidate) {
  const short = candidate.ruleCode.replace(/^R-/, '').split('-')[0];
  const ref = String(candidate.refId).replace(/-/g, '').slice(0, 12);
  return `TODO-${short}-${ref.toUpperCase()}`;
}

module.exports = {
  RULES,
  RULE_CODES,
  DEFAULT_REASON_CONTRIBUTION_PCT,
  listRules,
  ruleKeyOf,
  scanRules,
  candidatesFromMetrics,
  candidatesFromReasons,
};
