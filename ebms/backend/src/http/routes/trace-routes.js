'use strict';

const express = require('express');
const service = require('../../domain/chain/chain-service');

const router = express.Router();

// F5（PAND-83）链路入口清单：可穿透的结果指标（起点必须是 Result）
// 注：必须声明在 /trace/:metricId 之前，否则 anchors 会被当成 metricId。
router.get('/trace/anchors', async (req, res, next) => {
  try {
    res.json({
      ok: true,
      data: await service.listAnchors({
        periodType: req.query.period_type,
        periodValue: req.query.period_value,
      }),
    });
  } catch (err) {
    next(err);
  }
});

// F5（PAND-83）四层链路：Result → Reason（归因）→ Evidence → Source
// 一次返回四段；某段缺失返回断点而非错误（不阻断其余段查看）。
router.get('/trace/:metricId', async (req, res, next) => {
  try {
    res.json({ ok: true, data: await service.getChain(req.params.metricId) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
