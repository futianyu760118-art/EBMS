'use strict';

const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

router.get('/', async (_req, res) => {
  const db = getDb();
  res.json({ service: 'ebms-backend', status: 'ok', dialect: db.dialect });
});

module.exports = router;
