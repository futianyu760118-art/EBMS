/**
 * EBMS · EDP 数据服务对接接口（参考 M05 CRM：/api/v1/edp/*）。
 *
 *   GET  /api/v1/edp/status                 EDP 连接状态 + 本地同步统计
 *   GET  /api/v1/edp/datasets               已授权数据集清单（data-api _catalog）
 *   GET  /api/v1/edp/datasets/:code         数据集 schema
 *   GET  /api/v1/edp/datasets/:code/rows    本地已同步行
 *   POST /api/v1/edp/datasets/:code/sync    触发同步（data-api 取数 → 本地落库）
 *   GET  /api/v1/edp/sync-runs              同步记录
 *
 * 鉴权：管理面复用 system:config（与 /api/aeos、/api/m10 一致）。
 */
const express = require('express');
const router = express.Router();
const { getTable } = require('../db');
const { requirePerm } = require('../auth-middleware');
const edp = require('../lib/data-provider/edp-provider');
const sync = require('../lib/edp-sync');
const facResult = require('../lib/fac-result-store');
const sopSync = require('../lib/sop-edp-sync');

const PERM = 'system:config';

router.get('/status', requirePerm(PERM), async (req, res) => {
  const local = sync.runTable().all();
  const stored = sync.rowTable().all();
  const byDataset = {};
  stored.forEach((r) => { byDataset[r.dataset_code] = (byDataset[r.dataset_code] || 0) + 1; });
  res.json({
    source: 'edp',
    configured: edp.configured(),
    base_url: process.env.EDP_BASE_URL || '',
    local_stored_rows: stored.length,
    datasets: byDataset,
    sync_runs: local.length
  });
});

router.get('/datasets', requirePerm(PERM), async (req, res) => {
  try {
    res.json({ source: 'edp', datasets: await edp.catalog() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/datasets/:code/schema', requirePerm(PERM), async (req, res) => {
  try {
    const r = await edp.queryDataset(req.params.code, {}, { limit: 1 });
    res.json({ dataset_code: r.dataset_code, dataset_version: r.dataset_version, sample: r.rows });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/datasets/:code/rows', requirePerm(PERM), (req, res) => {
  const rows = sync.rowTable().all().filter((r) => r.dataset_code === req.params.code);
  res.json({ dataset_code: req.params.code, total: rows.length, rows });
});

router.post('/datasets/:code/sync', requirePerm(PERM), async (req, res) => {
  try {
    const r = await sync.syncDataset(req.params.code, req.body || {});
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.get('/sync-runs', requirePerm(PERM), (req, res) => {
  const list = sync.runTable().all().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 50);
  res.json({ total: list.length, runs: list });
});

// ===== M09 FAC FinanceResult 消费（GR-13：EBMS 只消费 VERIFIED 结果，不重算）=====
router.get('/finance-results', requirePerm(PERM), (req, res) => {
  const period = req.query.period;
  const rows = facResult.getVerifiedFinanceResults(period);
  res.json({ source: 'M09_FAC', contract: 'finance-result-v1', period: period || null, total: rows.length, data: rows });
});

router.get('/finance-results/:resultId/history', requirePerm(PERM), (req, res) => {
  const rows = facResult.getHistory(req.params.resultId);
  res.json({ result_id: req.params.resultId, total: rows.length, data: rows });
});

router.post('/finance-results', requirePerm(PERM), async (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body) ? body : (Array.isArray(body.items) ? body.items : [body]);
  const results = [];
  for (const item of items) {
    if (!item.result_id) { results.push({ result_id: null, ok: false, error: 'result_id 必填' }); continue; }
    try {
      const r = await facResult.saveFinanceResult(item);
      results.push({ result_id: item.result_id, revision: item.revision, ok: true, ...r });
    } catch (e) {
      results.push({ result_id: item.result_id, ok: false, error: e.message });
    }
  }
  res.json({ ok: true, count: results.length, results });
});

// ===== 产销协调会数据更新（EDP → SOP）=====
// 先确保源数据集已同步（可传 datasets 数组，缺省同步 SOP 相关 6 个），再更新 PSI 实际值 + 行动项。
router.post('/sop/sync', requirePerm(PERM), async (req, res) => {
  const body = req.body || {};
  const periodMonth = body.period_month || '';
  const datasets = Array.isArray(body.datasets) && body.datasets.length
    ? body.datasets
    : ['ads-order-list', 'ads-production-task-view', 'ads-inventory-view', 'meeting-assistant-actions'];
  const syncResults = [];
  for (const code of datasets) {
    try {
      const r = await sync.syncDataset(code, {});
      syncResults.push({ dataset: code, status: r.status, rows_stored: r.rows_stored, pages: r.pages });
    } catch (e) {
      syncResults.push({ dataset: code, status: 'failed', error: e.message });
    }
  }
  let psi = null, actions = null, meetings = null;
  try { psi = await sopSync.syncPsiFromEdp(periodMonth); } catch (e) { psi = { ok: false, error: e.message }; }
  // 待办只拉近 N 个月（默认 2 个月，2 个月以前不获取）；支持 cutoff_date 自定义截止日
  try {
    actions = await sopSync.syncActionsFromEdp({ start_date: body.start_date, end_date: body.end_date, months_back: body.months_back, cutoff_date: body.cutoff_date });
  } catch (e) { actions = { ok: false, error: e.message }; }
  try { meetings = await sopSync.syncMeetingsFromEdp(); } catch (e) { meetings = { ok: false, error: e.message }; }
  res.json({ ok: true, dataset_syncs: syncResults, psi, actions, meetings });
});

module.exports = router;
