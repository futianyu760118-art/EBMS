/**
 * AEOS 人员生命周期同步端点 —— EBMS / M03 adapter（内部机机通道）。
 *
 *   POST /internal/aeos/person-lifecycle   接收 M02 EDP 分发的 PersonLifecycleEventV1
 *
 * 鉴权：X-AEOS-Key-Id + X-AEOS-Timestamp + X-AEOS-Signature（HMAC-SHA256）。
 * 密钥：环境变量 AEOS_PERSON_LIFECYCLE_SECRET（回退 M01_EBMS_SYNC_TOKEN）。
 * fail-closed：未配置密钥 → 503，不读不写业务表。
 * 回执：PersonLifecycleResultV1（synced / skipped / failed）。
 */
const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { verifySignature, handlePersonLifecycle } = require('../lib/aeos-person-lifecycle');

ensureTable('m01_personnel_sync_log');

function tables() {
  return {
    orgPersonnel: getTable('org_personnel'),
    personnel: getTable('personnel'),
    users: getTable('users'),
    personnelPerms: getTable('org_personnel_perms'),
    syncLog: getTable('m01_personnel_sync_log')
  };
}

router.post('/person-lifecycle', async (req, res) => {
  const timestamp = req.headers['x-aeos-timestamp'];
  const signature = req.headers['x-aeos-signature'];
  const body = JSON.stringify(req.body || {});
  const secret = process.env.AEOS_PERSON_LIFECYCLE_SECRET || process.env.M01_EBMS_SYNC_TOKEN || '';

  if (!secret) {
    return res.status(503).json({
      result: 'error',
      error: '未配置人员生命周期同步密钥（AEOS_PERSON_LIFECYCLE_SECRET）'
    });
  }
  if (!verifySignature({ secret, timestamp, signature, body })) {
    return res.status(401).json({ result: 'error', error: '签名无效或已过期' });
  }

  const r = await handlePersonLifecycle({ tables: tables(), payload: req.body || {}, now: now() });
  res.status(r.status).json(r.body);
});

module.exports = router;
