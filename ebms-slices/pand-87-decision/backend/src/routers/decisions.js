'use strict';

const express = require('express');
const decisionService = require('../services/decision-service');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// F9 Decision 视图：全部接口需登录（写操作在服务层留痕）
router.use(requireAuth);

// 创建表单候选（可关联的结果 / 原因 / 证据）—— 必须置于 /:id 之前
router.get('/refs', async (req, res, next) => {
  try {
    res.json(await decisionService.listCandidates({ identity: req.identity }));
  } catch (err) {
    next(err);
  }
});

// 场景 3：可关联的执行 TODO 候选 —— 同样置于 /:id 之前
router.get('/todo-candidates', async (req, res, next) => {
  try {
    res.json(
      await decisionService.listTodoCandidates({
        identity: req.identity,
        decisionId: req.query.decision_id ? String(req.query.decision_id) : null,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    res.json(await decisionService.listDecisions({ identity: req.identity, query: req.query }));
  } catch (err) {
    next(err);
  }
});

// 创建决策：背景（关联结果/原因）+ 候选方案（≥1）+ 所需 Evidence；初始为「待决策」
router.post('/', async (req, res, next) => {
  try {
    const data = await decisionService.createDecision({
      identity: req.identity,
      body: req.body || {},
    });
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json(await decisionService.getDecision({ identity: req.identity, id: req.params.id }));
  } catch (err) {
    next(err);
  }
});

// 形成 / 修改结论：修改须带 reason，且必定落一条变更留痕（不可静默修改）
router.patch('/:id/conclusion', async (req, res, next) => {
  try {
    res.json(
      await decisionService.decideConclusion({
        identity: req.identity,
        id: req.params.id,
        body: req.body || {},
      })
    );
  } catch (err) {
    next(err);
  }
});

// 场景 3：关联执行产生的 TODO（关联已有 / 由决策派发新 TODO）
router.post('/:id/execution-todos', async (req, res, next) => {
  try {
    res.json(
      await decisionService.linkExecutionTodos({
        identity: req.identity,
        id: req.params.id,
        body: req.body || {},
      })
    );
  } catch (err) {
    next(err);
  }
});

// 场景 3：解除执行 TODO 关联（留痕）
router.delete('/:id/execution-todos/:todoId', async (req, res, next) => {
  try {
    res.json(
      await decisionService.unlinkExecutionTodo({
        identity: req.identity,
        id: req.params.id,
        todoId: req.params.todoId,
      })
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
