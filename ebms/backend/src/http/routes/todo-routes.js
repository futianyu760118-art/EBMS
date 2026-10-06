'use strict';

const express = require('express');
const service = require('../../domain/todos/todo-service');
const ruleEngine = require('../../domain/todos/todo-rule-engine');
const { requireActor } = require('../middleware/actor');

const router = express.Router();

// 状态与来源枚举（前端筛选栏的唯一取值来源）
router.get('/todo-meta', (_req, res) => {
  res.json({
    ok: true,
    data: {
      statuses: service.listStatuses(),
      sources: service.listSources(),
      rules: ruleEngine.listRules(),
      relatedRefTypes: Object.values(service.RELATED_REF_TYPES),
    },
  });
});

// 场景 1 + 场景 4：列表（事项/来源/关联结果或原因/责任人/截止时间/状态 + 逾期标记与筛选）
router.get('/todos', async (req, res, next) => {
  try {
    res.json({
      ok: true,
      data: await service.listTodos({
        owner: req.query.owner,
        status: req.query.status,
        source: req.query.source,
        dueBefore: req.query.due_before,
        overdue: req.query.overdue,
        limit: req.query.limit,
      }),
    });
  } catch (err) {
    next(err);
  }
});

// 规则自动产生（场景 2 的来源之一）：dry_run=1 只返回候选，不写库
router.post('/todos/rule-scan', requireActor, async (req, res, next) => {
  try {
    const body = req.body || {};
    const data = await ruleEngine.scanRules(req.actor, {
      periodType: body.periodType ?? req.query.period_type,
      periodValue: body.periodValue ?? req.query.period_value,
      dryRun: body.dryRun === true || req.query.dry_run === '1',
    });
    res.status(data.created.length > 0 ? 201 : 200).json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

// 场景 3：详情（七列字段 + 流转留痕时间线）
router.get('/todos/:id', async (req, res, next) => {
  try {
    res.json({ ok: true, data: await service.getTodoDetail(req.params.id) });
  } catch (err) {
    next(err);
  }
});

// 场景 2 的来源之二：人工派发
router.post('/todos', requireActor, async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, data: await service.createTodo(req.actor, req.body || {}) });
  } catch (err) {
    next(err);
  }
});

// 认领
router.post('/todos/:id/claim', requireActor, async (req, res, next) => {
  try {
    const data = await service.claimTodo(req.actor, req.params.id);
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

// 指派
router.post('/todos/:id/assign', requireActor, async (req, res, next) => {
  try {
    const data = await service.assignTodo(req.actor, req.params.id, { owner: req.body?.owner });
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

// 状态流转
router.post('/todos/:id/transitions', requireActor, async (req, res, next) => {
  try {
    const data = await service.transitionTodo(req.actor, req.params.id, { status: req.body?.status });
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
