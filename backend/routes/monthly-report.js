const express = require('express');
const router = express.Router();
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

// 月度经营报告模块（M03 经营驾驶舱）
// 数据表：monthly_reports / monthly_indicators / monthly_dept_summary
//         monthly_actions / monthly_issues / monthly_decisions
// 权限码：monthly-report:view / create / edit / delete

const VIEW = 'monthly-report:view';
const CREATE = 'monthly-report:create';
const EDIT = 'monthly-report:edit';
const DELETE = 'monthly-report:delete';

const CHILD_TABLES = [
  'monthly_indicators',
  'monthly_dept_summary',
  'monthly_actions',
  'monthly_issues',
  'monthly_decisions',
  'monthly_dept_narrative',
  'monthly_continuous_items',
  'monthly_data_sources'
];

function reportRows(reportId) {
  const id = Number(reportId);
  return {
    indicators: getTable('monthly_indicators').all().filter(x => Number(x.report_id) === id),
    dept_summary: getTable('monthly_dept_summary').all().filter(x => Number(x.report_id) === id),
    actions: getTable('monthly_actions').all().filter(x => Number(x.report_id) === id),
    issues: getTable('monthly_issues').all().filter(x => Number(x.report_id) === id),
    decisions: getTable('monthly_decisions').all().filter(x => Number(x.report_id) === id),
    dept_narrative: getTable('monthly_dept_narrative').all().filter(x => Number(x.report_id) === id),
    continuous_items: getTable('monthly_continuous_items').all().filter(x => Number(x.report_id) === id),
    data_sources: getTable('monthly_data_sources').all().filter(x => Number(x.report_id) === id)
  };
}

// 报告列表
router.get('/reports', requirePerm(VIEW), (req, res) => {
  const table = getTable('monthly_reports');
  const reports = table.all().sort((a, b) => (b.period || '').localeCompare(a.period || ''));
  res.json(reports);
});

// 新建报告
router.post('/reports', requirePerm(CREATE), async (req, res) => {
  const { period, title, summary, report_date, prepared_by } = req.body || {};
  if (!period) return res.status(400).json({ error: 'period（报告周期，如 2026-10）为必填项' });
  const table = getTable('monthly_reports');
  const dup = table.all().find(r => String(r.period) === String(period));
  if (dup) return res.status(409).json({ error: '该周期报告已存在' });
  const r = await table.insert({
    period,
    title: title || (period + ' 月度经营报告'),
    summary: summary || '',
    report_date: report_date || '',
    prepared_by: prepared_by || '',
    status: 'draft',
    created_at: now(),
    updated_at: now()
  });
  res.json({ id: r.lastID });
});

// 报告详情（含全部子表）
router.get('/reports/:id', requirePerm(VIEW), (req, res) => {
  const rt = getTable('monthly_reports');
  const report = rt.findById(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  res.json({ report, ...reportRows(req.params.id) });
});

// 更新报告基本信息
router.put('/reports/:id', requirePerm(EDIT), async (req, res) => {
  const rt = getTable('monthly_reports');
  const report = rt.findById(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  const { title, summary, report_date, prepared_by, status } = req.body || {};
  const patch = { updated_at: now() };
  if (title !== undefined) patch.title = title;
  if (summary !== undefined) patch.summary = summary;
  if (report_date !== undefined) patch.report_date = report_date;
  if (prepared_by !== undefined) patch.prepared_by = prepared_by;
  if (status !== undefined) patch.status = status;
  await rt.update(req.params.id, patch);
  res.json({ ok: true });
});

// 删除报告（级联删除子表）
router.delete('/reports/:id', requirePerm(DELETE), async (req, res) => {
  const id = Number(req.params.id);
  const rt = getTable('monthly_reports');
  if (!rt.findById(id)) return res.status(404).json({ error: '报告不存在' });
  await rt.delete(id);
  for (const name of CHILD_TABLES) {
    const t = getTable(name);
    await t.deleteWhereNoSave(r => Number(r.report_id) === id);
    await t.saveNow();
  }
  res.json({ ok: true });
});

// 子表批量保存（整体替换某报告下的全部记录）
function bulkSave(tableName) {
  return async (req, res) => {
    const reportId = Number(req.params.id);
    if (!getTable('monthly_reports').findById(reportId)) {
      return res.status(404).json({ error: '报告不存在' });
    }
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    const t = getTable(tableName);
    await t.deleteWhereNoSave(r => Number(r.report_id) === reportId);
    for (const it of items) {
      // 去除前端可能回传的 id / report_id / __new，交由数据库重新分配
      const clean = Object.assign({}, it);
      delete clean.id;
      delete clean.report_id;
      delete clean.__new;
      clean.report_id = reportId;
      clean.created_at = now();
      clean.updated_at = now();
      await t.insertNoSave(clean);
    }
    await t.saveNow();
    res.json({ ok: true, count: items.length });
  };
}

router.put('/reports/:id/indicators', requirePerm(EDIT), bulkSave('monthly_indicators'));
router.put('/reports/:id/dept-summary', requirePerm(EDIT), bulkSave('monthly_dept_summary'));
router.put('/reports/:id/actions', requirePerm(EDIT), bulkSave('monthly_actions'));
router.put('/reports/:id/issues', requirePerm(EDIT), bulkSave('monthly_issues'));
router.put('/reports/:id/decisions', requirePerm(EDIT), bulkSave('monthly_decisions'));
router.put('/reports/:id/dept-narrative', requirePerm(EDIT), bulkSave('monthly_dept_narrative'));
router.put('/reports/:id/continuous-items', requirePerm(EDIT), bulkSave('monthly_continuous_items'));
router.put('/reports/:id/data-sources', requirePerm(EDIT), bulkSave('monthly_data_sources'));

// ===== 数据接入层：统一取数接口（本地 / EDP 切换，见 docs/EBMS数据接入层设计.md）=====
router.get('/data-provider/status', requirePerm(VIEW), (req, res) => {
  const provider = require('../lib/data-provider');
  const contracts = require('../lib/data-provider/contracts');
  res.json({
    provider: provider.PROVIDER,
    contract_methods: Object.keys(contracts.PROVIDER_CONTRACT),
    systems: contracts.SYSTEM_ADAPTERS
  });
});

router.get('/data-provider/fetch', requirePerm(VIEW), async (req, res) => {
  const provider = require('../lib/data-provider');
  const contracts = require('../lib/data-provider/contracts');
  const period = req.query.period || '';
  const results = {};
  for (const key of Object.keys(contracts.PROVIDER_CONTRACT)) {
    try {
      results[key] = await provider[key](period);
    } catch (e) {
      results[key] = { source: provider.PROVIDER, status: 'error', reason: e.message };
    }
  }
  res.json({ provider: provider.PROVIDER, period, results });
});

module.exports = router;
