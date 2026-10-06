'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { resolveLanding } = require('../services/landing-service');

const router = express.Router();

// 登录后的默认落地视图（F15 口径：决策者 → REPORT，管理责任人 → 本责任域）
router.get('/landing', requireAuth, (req, res) => {
  res.json({ landing: resolveLanding(req.identity) });
});

module.exports = router;
