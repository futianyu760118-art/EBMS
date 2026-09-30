/**
 * 跨域经营判断（PAND-91 / AEOS M03）
 * ------------------------------------------------------------------
 * 定位：管理者的 RESULT 工作面 —— 汇聚销售 / 生产·交付 / 财务 / 供应链 四个专业中心
 * 上报的经营结论，形成跨域经营判断；只做结论汇聚与跨域判断，不重算专业中心内部算法。
 *
 * 归属与红线（EBMS_GUARDRAILS_V1 / DATA_OWNERSHIP）：
 *  - M03 自有数据：cross_domain_judgments（跨域判断结果）、Management Goal/Decision/Action；
 *    domain_conclusions 是 M03 收到的「中心 Result 收件箱」（快照原样留存，非第二事实源）。
 *  - 不写任何专业中心表；不读专业原始表重算指标。
 *  - 新增字段/新逻辑均标注 Owner：本模块所有表 Accountable Owner = M03。
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const rules = require('../lib/cross-domain-judgment');
const demo = require('../lib/cross-domain-demo-data');

ensureTable('domain_conclusions');
ensureTable('cross_domain_judgments');

const VIEW_PERM = 'ebms:judgment:view';
const MANAGE_PERM = 'ebms:judgment:manage';

// ============================ 工具 ============================

function conclusionKey(center, period) {
  return String(center) + '|' + String(period);
}

function listConclusions(period, center) {
  const table = getTable('domain_conclusions');
  table._invalidate();
  return table.all().filter(r => {
    if (period && r.period !== period) return false;
    if (center && r.center !== center) return false;
    return true;
  });
}

/** 判断记录内含各域展示值（不含中心原始报文，避免重复存储） */
function slimDomains(domains) {
  const out = {};
  Object.keys(domains).forEach(code => {
    const v = domains[code];
    out[code] = Object.assign({}, v, { payload: undefined });
  });
  return out;
}

function persistJudgment(judgment) {
  const table = getTable('cross_domain_judgments');
  const record = Object.assign({}, judgment, { domains: slimDomains(judgment.domains) });
  const existing = table.all().find(r => r.period === record.period && r.rule_version === record.rule_version);
  if (existing) {
    // 同一 (周期, 规则版本) 只保留一条：重新生成覆盖旧结论（含审计留痕）
    record.id = existing.id;
    record.created_at = existing.created_at;
    table.update(existing.id, record);
    return record;
  }
  record.created_at = now();
  const res = table.insert(record);
  record.id = res.lastID;
  return record;
}

// ============================ 领域元信息 ============================

// 四域范围 + 规则版本 + 判定标准（前端据此渲染口径说明）
router.get('/domains', requirePerm(VIEW_PERM), (req, res) => {
  res.json({
    rule_version: rules.RULE_VERSION,
    domains: rules.DOMAINS,
    min_participating_domains: rules.MIN_PARTICIPATING_DOMAINS,
    missing_label: rules.MISSING_LABEL,
    consistency_requirement: rules.CONSISTENCY_REQUIREMENT,
    computation_scope: {
      module: 'M03',
      recomputed: false,
      basis: 'center_reported_values_only',
      note: '展示值一律取自专业中心上报结论，EBMS 不重算中心内部算法'
    }
  });
});

// ============================ 中心结论快照 ============================

// 中心结论接入（契约化）：中心推送或人工录入，按 (中心, 周期) 覆盖为一条快照。
// 只做格式校验与入库，不改写中心上报的任何字段值。
router.post('/conclusions', requirePerm(MANAGE_PERM), (req, res) => {
  const body = req.body;
  const items = Array.isArray(body) ? body : (body && Array.isArray(body.conclusions) ? body.conclusions : [body]);
  if (!items.length || !items[0]) return res.status(400).json({ error: '缺少中心结论数据' });

  const table = getTable('domain_conclusions');
  const accepted = [];
  const rejected = [];

  items.forEach((item, idx) => {
    const errs = [];
    const center = item && item.center ? String(item.center) : '';
    if (!rules.DOMAIN_BY_CODE[center]) errs.push('center 必须为 sales/production/finance/supply_chain 之一');
    const period = rules.normalizePeriod(item && item.period);
    if (!period) errs.push('period 必须为 YYYY-MM');
    if (!item || item.conclusion_id === undefined || item.conclusion_id === null || item.conclusion_id === '') {
      errs.push('缺少 conclusion_id');
    }
    if (!item || !Array.isArray(item.metrics)) errs.push('metrics 必须为数组');
    if (errs.length) {
      rejected.push({ index: idx, center: center || null, errors: errs });
      return;
    }

    const snapshot = {
      center,
      period,
      conclusion_id: String(item.conclusion_id),
      source_system: item.source_system ? String(item.source_system) : rules.DOMAIN_BY_CODE[center].source_system,
      calculation_version: item.calculation_version ? String(item.calculation_version) : null,
      occurred_at: item.occurred_at ? String(item.occurred_at) : null,
      data_cutoff: item.data_cutoff ? String(item.data_cutoff) : null,
      trace_id: item.trace_id ? String(item.trace_id) : null,
      evidence_ids: Array.isArray(item.evidence_ids) ? item.evidence_ids.slice() : [],
      data_status: item.data_status ? String(item.data_status) : 'ok',
      summary: item.summary ? String(item.summary) : '',
      // 中心上报报文原样留存：这是「展示值与中心输出值一致」的结构性保证
      payload: item,
      metrics: item.metrics.slice(),
      ingest_channel: item.ingest_channel ? String(item.ingest_channel) : 'api',
      ingested_at: now()
    };

    const existing = table.all().find(r => r.center === center && r.period === period);
    if (existing) {
      table.update(existing.id, snapshot);
      accepted.push(Object.assign({ id: existing.id, replaced: true }, pickSnapshotMeta(snapshot)));
    } else {
      const r = table.insert(snapshot);
      accepted.push(Object.assign({ id: r.lastID, replaced: false }, pickSnapshotMeta(snapshot)));
    }
  });

  if (rejected.length && !accepted.length) return res.status(400).json({ error: '中心结论格式不合法', rejected });
  res.json({ ingested: accepted.length, rejected: rejected.length, accepted, errors: rejected });
});

function pickSnapshotMeta(s) {
  return {
    center: s.center,
    period: s.period,
    conclusion_id: s.conclusion_id,
    source_system: s.source_system,
    calculation_version: s.calculation_version,
    occurred_at: s.occurred_at
  };
}

// 已接入的中心结论快照（按周期/域过滤）
router.get('/conclusions', requirePerm(VIEW_PERM), (req, res) => {
  const period = req.query.period ? rules.normalizePeriod(req.query.period) : null;
  if (req.query.period && !period) return res.status(400).json({ error: 'period 必须为 YYYY-MM' });
  const rows = listConclusions(period, req.query.center ? String(req.query.center) : null);
  res.json({
    total: rows.length,
    items: rows.map(r => Object.assign({}, pickSnapshotMeta(r), {
      data_status: r.data_status,
      trace_id: r.trace_id,
      evidence_ids: r.evidence_ids || [],
      metric_count: Array.isArray(r.metrics) ? r.metrics.length : 0,
      ingested_at: r.ingested_at,
      ingest_channel: r.ingest_channel
    }))
  });
});

// 联调演示数据：2026-08 四域齐全 / 2026-09 供应链域缺失（幂等，仅演示周期）
router.post('/conclusions/seed-demo', requirePerm(MANAGE_PERM), (req, res) => {
  const table = getTable('domain_conclusions');
  let added = 0; let updated = 0;
  demo.buildDemoConclusions(now()).forEach(item => {
    const existing = table.all().find(r => r.center === item.center && r.period === item.period);
    if (existing) {
      table.update(existing.id, item);
      updated++;
    } else {
      table.insert(item);
      added++;
    }
  });
  res.json({ message: '演示数据已载入', added, updated, periods: demo.DEMO_PERIODS });
});

// ============================ 跨域判断 ============================

function normalizeExplanations(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  Object.keys(input).forEach(k => {
    const v = input[k];
    if (v === undefined || v === null) return;
    const text = String(v).trim();
    if (text) out[String(k)] = text;
  });
  return out;
}

function loadConclusionIndex(period) {
  const index = {};
  listConclusions(period).forEach(r => {
    if (!index[r.center]) index[r.center] = r;
  });
  return index;
}

// 生成（物化）某周期的跨域经营判断；数据不足 / 缺域均在结果内显式标注
router.post('/generate', requirePerm(MANAGE_PERM), (req, res) => {
  const period = rules.normalizePeriod(req.body && req.body.period);
  if (!period) return res.status(400).json({ error: 'period 必须为 YYYY-MM' });
  const index = loadConclusionIndex(period);
  const raw = req.body || {};
  const judgment = rules.buildJudgment({
    period,
    conclusions: Object.values(index),
    judgmentId: crypto.randomUUID(),
    generatedAt: now(),
    ruleVersion: raw.rule_version ? String(raw.rule_version) : rules.RULE_VERSION
  });
  // 差异口径说明登记表：{ '中心|指标编码': '口径说明' }，用于抽样判定中解释已确认的差异
  judgment.difference_explanations = normalizeExplanations(raw.difference_explanations);
  const saved = persistJudgment(judgment);
  res.json(publicJudgment(saved));
});

// 判断记录列表
router.get('/list', requirePerm(VIEW_PERM), (req, res) => {
  const table = getTable('cross_domain_judgments');
  table._invalidate();
  let rows = table.all();
  if (req.query.period) {
    const period = rules.normalizePeriod(req.query.period);
    if (!period) return res.status(400).json({ error: 'period 必须为 YYYY-MM' });
    rows = rows.filter(r => r.period === period);
  }
  rows = rows.slice().sort((a, b) => String(b.generated_at || '').localeCompare(String(a.generated_at || '')));
  res.json({
    total: rows.length,
    items: rows.map(r => ({
      id: r.id,
      judgment_id: r.judgment_id,
      period: r.period,
      rule_version: r.rule_version,
      level: r.level,
      level_label: r.level_label,
      conclusion_text: r.conclusion_text,
      participating_count: r.participating_count,
      reference_count: r.reference_count,
      missing_domains: r.missing_domains,
      generated_at: r.generated_at
    }))
  });
});

// 指定周期最新一条判断（无则 404，语义明确，不返回空壳结论）
router.get('/latest', requirePerm(VIEW_PERM), (req, res) => {
  const period = req.query.period ? rules.normalizePeriod(req.query.period) : null;
  if (req.query.period && !period) return res.status(400).json({ error: 'period 必须为 YYYY-MM' });
  const table = getTable('cross_domain_judgments');
  table._invalidate();
  let rows = table.all();
  if (period) rows = rows.filter(r => r.period === period);
  rows.sort((a, b) => String(b.generated_at || '').localeCompare(String(a.generated_at || '')));
  if (!rows.length) {
    return res.status(404).json({ error: period ? `${period} 尚无跨域经营判断，请先生成` : '尚无跨域经营判断，请先生成' });
  }
  res.json(publicJudgment(rows[0]));
});

// 判定标准可执行化：抽样比对中心输出值与 EBMS 展示值
router.get('/consistency', requirePerm(VIEW_PERM), (req, res) => {
  const period = rules.normalizePeriod(req.query.period);
  if (!period) return res.status(400).json({ error: 'period 必须为 YYYY-MM' });
  const table = getTable('cross_domain_judgments');
  table._invalidate();
  const rows = table.all().filter(r => r.period === period)
    .sort((a, b) => String(b.generated_at || '').localeCompare(String(a.generated_at || '')));
  if (!rows.length) return res.status(404).json({ error: `${period} 尚无跨域经营判断，请先生成` });
  const judgment = rows[0];
  const index = loadConclusionIndex(period);
  const result = rules.sampleConsistency(judgment, Object.values(index), {
    minSample: rules.CONSISTENCY_REQUIREMENT.min_sample,
    differenceExplanations: normalizeExplanations(judgment.difference_explanations)
  });
  result.judgment_id = judgment.judgment_id;
  result.rule_version = judgment.rule_version;
  res.json(result);
});

// 判断详情
router.get('/:id', requirePerm(VIEW_PERM), (req, res) => {
  const table = getTable('cross_domain_judgments');
  table._invalidate();
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '跨域经营判断不存在' });
  res.json(publicJudgment(row));
});

// 引用明细 + 可追溯性核验
router.get('/:id/references', requirePerm(VIEW_PERM), (req, res) => {
  const table = getTable('cross_domain_judgments');
  table._invalidate();
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '跨域经营判断不存在' });
  const index = loadConclusionIndex(row.period);
  const traceability = rules.verifyReferences(row, index);
  res.json({
    judgment_id: row.judgment_id,
    period: row.period,
    rule_version: row.rule_version,
    reference_count: row.reference_count,
    references: row.references || [],
    missing_domain_details: row.missing_domain_details || [],
    computation_scope: row.computation_scope,
    traceability
  });
});

function publicJudgment(row) {
  return Object.assign({}, row, {
    references: row.references || [],
    missing_domain_details: row.missing_domain_details || [],
    computation_scope: row.computation_scope
  });
}

module.exports = router;
