'use strict';

const express = require('express');
const service = require('../../domain/results/result-service');
const { requireActor } = require('../middleware/actor');

const router = express.Router();

// 来源声明口径（F1）：Owner 模块白名单 + Owner Result 契约必填字段
router.get('/result-sources', (_req, res) => {
  res.json({ ok: true, data: service.listSourceModules() });
});

// F1 场景 1~3 + 边界：经营结果指标集总览（不带周期时落到已配置的最新周期）
router.get('/results', async (req, res, next) => {
  try {
    res.json({
      ok: true,
      data: await service.getOverview({
        periodType: req.query.period_type,
        periodValue: req.query.period_value,
      }),
    });
  } catch (err) {
    next(err);
  }
});

// F1 场景 4：单指标详情（口径版本 + 证据引用可定位到证据）
router.get('/results/:metricId', async (req, res, next) => {
  try {
    res.json({ ok: true, data: await service.getMetricDetail(req.params.metricId) });
  } catch (err) {
    next(err);
  }
});

// 已登记的 Owner Result 清单（来源声明逐条核对 / 抽查用）
router.get('/owner-results', async (req, res, next) => {
  try {
    res.json({
      ok: true,
      data: await service.listOwnerResults({
        metricCode: req.query.metric_code,
        sourceSystem: req.query.source_system,
        limit: req.query.limit,
      }),
    });
  } catch (err) {
    next(err);
  }
});

// 登记 Owner Result：实际值进入 EBMS 的唯一通道（幂等，写留痕）
router.post('/owner-results', requireActor, async (req, res, next) => {
  try {
    const result = await service.receiveOwnerResult(req.actor, req.body || {});
    res.status(result.changed ? 201 : 200).json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
