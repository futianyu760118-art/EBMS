'use strict';

const { withTransaction } = require('../../db/pool');
const { badRequest, notFound, conflict } = require('../../http/errors');
const { PERIOD_TYPES } = require('../results/result-sources');
const resultRepo = require('../results/result-repository');
const resultService = require('../results/result-service');
const evidenceRepo = require('../evidence/evidence-repository');
const linkService = require('../links/link-service');
const auditRepo = require('../audit/audit-repository');
const { labelOf, landingHref } = require('../views/view-object-types');
const reportRepo = require('./report-repository');
const { isReportDomain, describeDomain, listReportDomains } = require('./report-domains');

/**
 * PAND-85（F7 REPORT 视图）领域服务。
 *
 * 口径：REPORT 以「报告 / 结论」为单位组织信息——
 *   结论（conclusion）+ 关键结果指标（含目标值 / 实际值 / 偏差）+ 关联的 TODO / Decision / Evidence 入口。
 * 红线（沿用 F1）：报告不自己取数、不重算指标；关键指标的实际值仍只来自 owner_results，
 *   本服务只做「引用 + 装配」，取数走 result-repository 的唯一路径。
 */

// AC 判定：Report 内 TODO / Decision / Evidence 三类关联入口「均存在」——固定三类，与是否有关联无关。
const ENTRY_TYPES = Object.freeze(['todo', 'decision', 'evidence']);

function actorNameOf(actor) {
  return actor.displayName || actor.username || actor.id;
}

// ---------------------------------------------------------------- 序列化

/** 三类关联入口的紧凑形态（列表卡片用）。无关联时置灰并提示「无关联」。 */
function buildEntrySkeleton(countByType = new Map()) {
  return ENTRY_TYPES.map((type) => {
    const count = countByType.get(type) ?? 0;
    const disabled = count === 0;
    return {
      targetType: type,
      label: labelOf(type),
      landingPath: `/${type}`,
      count,
      disabled,
      hint: disabled ? linkService.NO_LINK_HINT : null,
      links: [],
    };
  });
}

/** 后端 /objects/report/:id/links 的 target → 入口模型（与列表形态一致，另带可点击落点）。 */
function toEntryFromTarget(target) {
  const count = Number(target?.count ?? 0);
  const disabled = Boolean(target?.disabled) || count === 0;
  return {
    targetType: target?.targetType,
    label: target?.label ?? '',
    fullLabel: target?.fullLabel ?? target?.label ?? '',
    landingPath: target?.landingPath ?? `/${target?.targetType ?? ''}`,
    count,
    disabled,
    hint: disabled ? linkService.NO_LINK_HINT : null,
    links: (target?.entries ?? []).map((e) => ({
      id: e.id,
      code: e.code ?? '',
      title: e.title ?? '',
      badge: e.badge ?? '',
      subtitle: e.subtitle ?? '',
      href: e.landingHref ?? null,
    })),
  };
}

/** 报告基础字段（列表与详情共用）。 */
function serializeReportBase(row) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    conclusion: row.conclusion,
    periodType: row.period_type,
    periodValue: row.period_value,
    domain: describeDomain(row.domain),
    owner: row.owner,
    createdAt: row.created_at,
    landingHref: landingHref('report', row.id),
  };
}

/** 关键结果指标汇总（偏差超阈值项计数用于「一眼看到异常」）。 */
function metricSummaryOf(items) {
  const supplied = items.filter((item) => item.hasData);
  return {
    count: items.length,
    suppliedCount: supplied.length,
    noDataCount: items.length - supplied.length,
    exceededCount: items.filter((item) => item.exceeded).length,
  };
}

// ---------------------------------------------------------------- 指标装配

async function loadEvidenceMap(rows) {
  const ids = [
    ...new Set(rows.flatMap((r) => (Array.isArray(r.result_evidence_ids) ? r.result_evidence_ids : []))),
  ];
  const evidences = await evidenceRepo.listByIds(ids);
  return new Map(evidences.map((e) => [e.id, e]));
}

/** 按报告既定的顺序装配关键指标；实际值口径与 F1 总览完全一致（同一个 serializeMetric）。 */
async function loadKeyMetrics(metricIds) {
  if (metricIds.length === 0) return [];
  const rows = await resultRepo.listByIds(metricIds);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const evidenceById = await loadEvidenceMap(rows);
  return metricIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((row) => resultService.serializeMetric(row, evidenceById));
}

/** 报告 → 关键指标 id（保持报告内顺序）。返回 Map<reportId, metricId[]>。 */
async function metricIdsByReport(reportIds) {
  const links = await reportRepo.listMetricLinksByReportIds(reportIds);
  const map = new Map(reportIds.map((id) => [id, []]));
  for (const link of links) {
    map.get(link.report_id)?.push(link.metric_id);
  }
  return map;
}

// ---------------------------------------------------------------- 用例：读取

/**
 * 场景 3：按周期与责任域筛选。
 * 两个筛选条件为「与」关系；缺省时返回全部报告。
 */
async function listReports({ periodType, periodValue, domain, limit, offset } = {}) {
  const hasType = periodType !== undefined && periodType !== null && periodType !== '';
  const hasValue = periodValue !== undefined && periodValue !== null && periodValue !== '';
  if (hasType !== hasValue) {
    throw badRequest('REPORT_PERIOD_INCOMPLETE', '按周期筛选时必须同时给出 period_type 与 period_value', {
      fields: { period: 'period_type 与 period_value 需成对提供' },
    });
  }
  if (hasType && !PERIOD_TYPES.includes(periodType)) {
    throw badRequest('REPORT_PERIOD_TYPE_INVALID', '数据周期取值不合法', {
      fields: { periodType: '数据周期只能是 day / week / month' },
      received: periodType,
      allowed: PERIOD_TYPES,
    });
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  const { rows, total } = await reportRepo.list({
    periodType: hasType ? periodType : null,
    periodValue: hasValue ? String(periodValue) : null,
    domain: domain ? String(domain) : null,
    limit: safeLimit,
    offset: safeOffset,
  });

  const ids = rows.map((row) => row.id);
  const [metricIdsByReportMap, linkCounts] = await Promise.all([
    metricIdsByReport(ids),
    reportRepo.linkCountsByReportIds(ids),
  ]);

  const countsByReport = new Map(ids.map((id) => [id, new Map()]));
  for (const row of linkCounts) {
    countsByReport.get(row.report_id)?.set(row.other_type, row.count);
  }

  const allMetricIds = [...new Set([...metricIdsByReportMap.values()].flat())];
  const metricsById = new Map();
  for (const metric of await loadKeyMetrics(allMetricIds)) {
    metricsById.set(metric.id, metric);
  }

  const items = rows.map((row) => {
    const keyMetrics = (metricIdsByReportMap.get(row.id) ?? [])
      .map((id) => metricsById.get(id))
      .filter(Boolean);
    return {
      ...serializeReportBase(row),
      keyMetrics,
      metricSummary: metricSummaryOf(keyMetrics),
      // 判定标准：三类关联入口均存在（无关联时置灰并提示「无关联」）
      entries: buildEntrySkeleton(countsByReport.get(row.id)),
    };
  });

  return {
    total,
    limit: safeLimit,
    offset: safeOffset,
    filters: {
      periodType: hasType ? periodType : null,
      periodValue: hasValue ? String(periodValue) : null,
      domain: domain ? String(domain) : null,
    },
    items,
    // 边界：无 Report 时返回空集（前端据此渲染空态与创建入口），不是错误
    empty: total === 0,
  };
}

/** 报告详情：结论 + 关键结果指标（含目标值/实际值/偏差）+ 三类关联入口（含可点击落点）。 */
async function getReport(reportId) {
  const row = await reportRepo.findById(reportId);
  if (!row) {
    throw notFound('REPORT_NOT_FOUND', `报告不存在：${reportId}`);
  }

  const metricIds = (await metricIdsByReport([row.id])).get(row.id) ?? [];
  const [keyMetrics, navigation] = await Promise.all([
    loadKeyMetrics(metricIds),
    linkService.getNavigation({ type: 'report', id: row.id }),
  ]);

  return {
    report: serializeReportBase(row),
    keyMetrics,
    metricSummary: metricSummaryOf(keyMetrics),
    entries: navigation.targets.map(toEntryFromTarget),
    entryTotal: navigation.total,
  };
}

/** 筛选栏取值：责任域为口径清单，周期为「已存在的报告周期」。 */
async function listFilterOptions() {
  const periods = await reportRepo.listPeriods();
  const present = await reportRepo.listDomains();
  const canonical = listReportDomains();
  const known = new Set(canonical.map((d) => d.code));
  return {
    domains: [...canonical, ...present.filter((code) => !known.has(code)).map((code) => describeDomain(code))],
    periods: periods.map((p) => ({ periodType: p.period_type, periodValue: p.period_value })),
  };
}

// ---------------------------------------------------------------- 用例：创建（空态入口）

function validateCreateInput(input) {
  const fields = {};
  const payload = {};
  const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

  payload.title = text(input.title);
  if (!payload.title) fields.title = '报告标题不能为空';

  payload.conclusion = text(input.conclusion);
  if (!payload.conclusion) fields.conclusion = '结论不能为空：REPORT 以结论为单位组织信息';

  if (!PERIOD_TYPES.includes(input.periodType)) {
    fields.periodType = '数据周期只能是 day / week / month';
  } else {
    payload.periodType = input.periodType;
  }

  payload.periodValue = text(input.periodValue);
  if (!payload.periodValue) fields.periodValue = '数据周期取值（periodValue）不能为空';

  if (!isReportDomain(input.domain)) {
    fields.domain = '责任域不在取值范围内';
  } else {
    payload.domain = input.domain;
  }

  payload.owner = text(input.owner);
  payload.code = text(input.code);

  const metricIds = Array.isArray(input.metricIds)
    ? input.metricIds.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
    : [];
  payload.metricIds = metricIds;

  if (Object.keys(fields).length === 0) return payload;

  const details = { fields };
  if (fields.domain) details.allowedDomains = listReportDomains().map((d) => d.code);
  if (fields.periodType) details.allowedPeriodTypes = PERIOD_TYPES;

  const codes = {
    title: 'REPORT_TITLE_REQUIRED',
    conclusion: 'REPORT_CONCLUSION_REQUIRED',
    periodType: 'REPORT_PERIOD_TYPE_INVALID',
    periodValue: 'REPORT_PERIOD_VALUE_REQUIRED',
    domain: 'REPORT_DOMAIN_INVALID',
  };
  const [field] = Object.keys(fields);
  throw badRequest(codes[field], fields[field], details);
}

function generateCode(periodValue) {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RPT-${periodValue}-${suffix}`;
}

/** 校验关键指标：必须存在，且与报告同周期（报告不该引用别的周期的指标）。 */
async function validateMetricIds(metricIds, periodType, periodValue) {
  if (metricIds.length === 0) return;
  const rows = await resultRepo.listByIds(metricIds);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = metricIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw badRequest('REPORT_METRIC_NOT_FOUND', '关键结果指标不存在', {
      fields: { metricIds: '存在无法解析的指标标识' },
      missing,
    });
  }
  const mismatched = rows
    .filter((row) => row.period_type !== periodType || row.period_value !== periodValue)
    .map((row) => row.code);
  if (mismatched.length > 0) {
    throw badRequest('REPORT_METRIC_PERIOD_MISMATCH', '关键结果指标必须与报告同周期', {
      fields: { metricIds: '存在与报告周期不一致的指标' },
      mismatched,
      reportPeriod: { periodType, periodValue },
    });
  }
}

/**
 * 创建报告（空态下的创建入口）。写入 + 关键指标关联 + 留痕同事务提交。
 * 新建报告尚无关联对象 → 三类入口均置灰（由读接口按实际关联计算，不在此处写死）。
 */
async function createReport(actor, input) {
  const payload = validateCreateInput(input || {});
  await validateMetricIds(payload.metricIds, payload.periodType, payload.periodValue);

  const actorName = actorNameOf(actor);
  const created = await withTransaction(async (client) => {
    let row;
    try {
      row = await reportRepo.insert(client, {
        code: payload.code || generateCode(payload.periodValue),
        title: payload.title,
        conclusion: payload.conclusion,
        periodType: payload.periodType,
        periodValue: payload.periodValue,
        domain: payload.domain,
        owner: payload.owner,
        createdBy: actor.id,
      });
    } catch (err) {
      // 唯一约束：报告编码重复
      if (err && err.code === '23505') {
        throw conflict('REPORT_CODE_DUPLICATED', `报告编码已存在：${payload.code}`);
      }
      throw err;
    }

    await reportRepo.attachMetrics(client, row.id, payload.metricIds);
    const audit = await auditRepo.record(client, {
      actor: actor.id,
      actorName,
      action: 'report.create',
      entityType: 'report',
      entityId: row.id,
      after: {
        code: row.code,
        title: row.title,
        periodType: row.period_type,
        periodValue: row.period_value,
        domain: row.domain,
        metricIds: payload.metricIds,
      },
    });
    return { row, audit };
  });

  const keyMetrics = await loadKeyMetrics(payload.metricIds);
  return {
    report: serializeReportBase(created.row),
    keyMetrics,
    metricSummary: metricSummaryOf(keyMetrics),
    // 新建报告：三类入口均存在但均无关联（置灰）
    entries: buildEntrySkeleton(),
    audit: {
      id: String(created.audit.id),
      action: created.audit.action,
      actor: created.audit.actor,
      actorName: created.audit.actor_name,
      at: created.audit.at,
    },
  };
}

module.exports = {
  ENTRY_TYPES,
  listReports,
  getReport,
  createReport,
  listFilterOptions,
  buildEntrySkeleton,
  metricSummaryOf,
  serializeReportBase,
};
