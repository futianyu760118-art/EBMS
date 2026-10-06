'use strict';

const express = require('express');
const service = require('../../domain/reports/report-service');
const { requireActor } = require('../middleware/actor');

const router = express.Router();

// 筛选栏取值（责任域口径清单 + 已存在的报告周期）
router.get('/report-filters', async (_req, res, next) => {
  try {
    res.json({ ok: true, data: await service.listFilterOptions() });
  } catch (err) {
    next(err);
  }
});

// F7 场景 1~3 + 边界：REPORT 清单（落地视图；按周期与责任域筛选）
router.get('/reports', async (req, res, next) => {
  try {
    res.json({
      ok: true,
      data: await service.listReports({
        periodType: req.query.period_type,
        periodValue: req.query.period_value,
        domain: req.query.domain,
        limit: req.query.limit,
        offset: req.query.offset,
      }),
    });
  } catch (err) {
    next(err);
  }
});

// F7 场景 2：报告详情（结论 + 关键结果指标 + 偏差 + TODO / Decision / Evidence 三类关联入口）
router.get('/reports/:reportId', async (req, res, next) => {
  try {
    res.json({ ok: true, data: await service.getReport(req.params.reportId) });
  } catch (err) {
    next(err);
  }
});

// F7 边界：无 Report 时的创建入口
router.post('/reports', requireActor, async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, data: await service.createReport(req.actor, req.body || {}) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
