'use strict';

const express = require('express');
const authService = require('../services/auth-service');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    res.json(await authService.login(req.body || {}));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
