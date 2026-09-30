'use strict';

const express = require('express');
const service = require('../../domain/source/source-service');
const { requireActor } = require('../middleware/actor');

const router = express.Router();

// 来源枚举（来源类别 / 更新周期 / 缺失标记），前端下拉与展示标签的唯一来源
router.get('/source-catalog', (_req, res) => {
  res.json({ ok: true, data: service.listSourceCatalog() });
});

// 判定标准：来源缺失率与内部/外部/人工覆盖分布
router.get('/sources/stats', async (req, res, next) => {
  try {
    res.json({
      ok: true,
      data: await service.getSourceStats({ q: req.query.q, evidenceType: req.query.evidenceType }),
    });
  } catch (err) {
    next(err);
  }
});

// 边界：待补清单（无 Source 的证据，标记「来源缺失」）
router.get('/sources/missing', async (req, res, next) => {
  try {
    res.json({
      ok: true,
      data: await service.listMissingSources({
        q: req.query.q,
        evidenceType: req.query.evidenceType,
        limit: req.query.limit,
        offset: req.query.offset,
      }),
    });
  } catch (err) {
    next(err);
  }
});

// 场景 1/2/3 + 边界：单条证据的来源明细（无来源时带「来源缺失」标记）
router.get('/evidences/:evidenceId/source', async (req, res, next) => {
  try {
    res.json({ ok: true, data: await service.getEvidenceSource(req.params.evidenceId) });
  } catch (err) {
    next(err);
  }
});

// 场景 3-a：标注 / 更正来源（唯一写入入口，留痕同事务）
router.put('/evidences/:evidenceId/source', requireActor, async (req, res, next) => {
  try {
    res.json({
      ok: true,
      data: await service.annotateSource(req.actor, req.params.evidenceId, req.body || {}),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
