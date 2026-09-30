/**
 * 接口层：F2 结果偏差归因路由（PAND-80）。
 *
 * 读路径：指标 → 原因列表 / 多级展开 / 类型判定；
 * 写路径：关联原因（唯一的写入端点，登记 M03 归因元数据 + 留痕）。
 * 归因所依据的专业事实一律消费专业模块 Result，本模块不重算专业指标。
 */

import { Router } from 'express';

import { DEFAULT_FACT_SAMPLE } from '../services/attributionService.js';

/** `?max_depth=` 仅用于显式收窄；默认按归因关系展开（不因导航层级截断）。 */
function readMaxDepth(query) {
  const raw = Number(query?.max_depth);
  return Number.isInteger(raw) && raw > 0 ? raw : Infinity;
}

export function createReasonRouter({ attributionService, actor }) {
  const router = Router();

  // AC 场景 1：从任一结果指标的偏差穿透到原因列表
  router.get('/results/:metricRef/reasons', actor, (req, res, next) => {
    try {
      res.json(
        attributionService.reasonsForMetric(req.params.metricRef, {
          maxDepth: readMaxDepth(req.query),
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  // AC 边界（关联入口）：登记原因项，兜底判为 M03 自有归因分析
  router.post('/results/:metricRef/reasons', actor, (req, res, next) => {
    try {
      res.status(201).json(attributionService.linkReasons(req.params.metricRef, req.body, req.actor.id));
    } catch (err) {
      next(err);
    }
  });

  // AC 场景 3：多级展开（深度由归因关系决定）
  router.get('/reasons/:attributionId/children', actor, (req, res, next) => {
    try {
      res.json(
        attributionService.childrenOf(req.params.attributionId, {
          maxDepth: readMaxDepth(req.query),
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  // AC 场景 4：类型判定 —— 映射至 Exception / M03 自有归因分析
  router.get('/reasons/:attributionId/type-verdict', actor, (req, res, next) => {
    try {
      res.json(attributionService.typeVerdict(req.params.attributionId));
    } catch (err) {
      next(err);
    }
  });

  // 影响方向与严重度取值域（判定标准：方向仅限 正向 / 负向 / 中性）
  router.get('/attribution/directions', actor, (req, res, next) => {
    try {
      res.json(attributionService.directionOptions());
    } catch (err) {
      next(err);
    }
  });

  // 自证：抽查 ≥ 10 条归因所引用的专业事实均可溯源，且无 EBMS 自建事实源
  router.get('/attribution/professional-fact-trace', actor, (req, res, next) => {
    try {
      const raw = Number(req.query.sample);
      const sample = Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_FACT_SAMPLE;
      res.json(attributionService.professionalFactTrace(sample));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
