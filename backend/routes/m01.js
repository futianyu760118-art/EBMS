const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { applyOffboard, verifyRequestSignature } = require('../lib/m01-personnel-sync');

ensureTable('m01_personnel_sync_log');

// M01 → EBMS：已审批的离职结果回写。只接受带时间戳和签名的机机请求。
router.post('/personnel/offboard', async (req, res) => {
  const timestamp = req.headers['x-m01-timestamp'];
  const signature = req.headers['x-m01-signature'];
  const body = JSON.stringify(req.body || {});
  const secret = process.env.M01_EBMS_SYNC_TOKEN || '';
  if (!verifyRequestSignature({ secret, timestamp, signature, body })) {
    return res.status(401).json({ error: 'M01离职同步签名无效或已过期' });
  }

  const result = await applyOffboard({
    tables: {
      orgPersonnel: getTable('org_personnel'),
      personnel: getTable('personnel'),
      users: getTable('users'),
      personnelPerms: getTable('org_personnel_perms'),
      syncLog: getTable('m01_personnel_sync_log')
    },
    payload: req.body || {},
    now: now()
  });
  res.status(result.ok ? 200 : (result.status || 400)).json(result);
});

module.exports = router;
