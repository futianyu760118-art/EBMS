/**
 * M10 POMS 微系统对接路由（EBMS / M03 侧）。
 *
 * 机器通道：/api/m10/partner/*（Bearer M10_PARTNER_TOKEN，fail-closed）
 * 个人工作面：/api/m10/me/*（现有登录态，仅本人）
 * 管理面：/api/m10/status|config|logs|person-links（system:config）
 */
const express = require('express');
const router = express.Router();
const { requirePerm, extractUserId, getUserPermissions } = require('../auth-middleware');
const H = require('../lib/m10-http');
const service = require('../lib/m10-service');
const C = require('../lib/m10-contract');

function send(res, r) { res.status(r.status).json(r.body); }

function wrap(fn) {
  return async (req, res) => {
    try { send(res, await fn(req)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  };
}

/**
 * 解析当前工作面人员。
 * 默认只返回登录人本人；管理员可通过 person_id 查询他人（供 M10 适配器以服务账号拉取岗位工作面）。
 * 写入反馈始终只允许本人，避免管理员代写他人执行结果。
 */
function requireUser(req, res, opts) {
  const uid = extractUserId(req);
  if (!uid) {
    res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
    return null;
  }
  const person = service.resolvePerson({ ebms_user_id: uid });
  if (!person) {
    res.status(403).json({ error: '当前账号未关联 EBMS 人员信息', code: 'M10_PERSON_UNMAPPED' });
    return null;
  }
  const allowPersonQuery = !!(opts && opts.allowPersonQuery);
  const requested = req.query.person_id || (req.query.m10_person_id || '');
  if (!allowPersonQuery || !requested) return person;
  if (String(requested) === String(person.m10_person_id) || String(requested) === String(person.ebms_user_id)) return person;

  const { isAdmin } = getUserPermissions(uid);
  if (!isAdmin) {
    res.status(403).json({ error: '仅管理员可查看他人工作面', code: 'M10_PERSON_FORBIDDEN' });
    return null;
  }
  const target = service.resolvePerson({ person_id: requested, m10_person_id: requested });
  if (!target) {
    res.status(404).json({ error: '目标人员未映射到 EBMS', code: 'M10_PERSON_UNMAPPED' });
    return null;
  }
  return target;
}

// ============================ 机器通道 ============================
router.get('/partner/status', (req, res) => {
  try { send(res, H.handlePartnerStatus(req.headers)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/partner/workspace', (req, res) => {
  try { send(res, H.handlePartnerWorkspace(req.query, req.headers)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/partner/work-items', (req, res) => {
  try { send(res, H.handlePartnerWorkItems(req.query, req.headers)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/partner/results', (req, res) => {
  try { send(res, H.handlePartnerResults(req.query, req.headers)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/partner/feedback', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket && req.socket.remoteAddress || '';
    send(res, await H.handlePartnerFeedback(req.headers, req.body, String(ip)));
  } catch (e) {
    res.status(500).json({ result: 'error', error: e.message });
  }
});

// ============================ 个人工作面 ============================
router.get('/me/workspace', (req, res) => {
  const person = requireUser(req, res, { allowPersonQuery: true });
  if (!person) return;
  res.json(service.buildWorkspace(person));
});

router.get('/me/work-items', (req, res) => {
  const person = requireUser(req, res, { allowPersonQuery: true });
  if (!person) return;
  const q = req.query || {};
  const items = service.collectWorkItems(person, {
    status: q.status,
    include_done: q.include_done === '1' || q.include_done === 'true',
    limit: q.limit
  });
  res.json({ contract_version: C.CONTRACT_VERSION, items, summary: service.summarize(items), source: 'ebms' });
});

router.get('/me/results', (req, res) => {
  const person = requireUser(req, res, { allowPersonQuery: true });
  if (!person) return;
  res.json({ contract_version: C.CONTRACT_VERSION, results: service.collectResults(person, { limit: (req.query || {}).limit }), source: 'ebms' });
});

router.post('/me/work-items/:workItemId/feedback', async (req, res) => {
  const person = requireUser(req, res);
  if (!person) return;
  const parsed = C.parseWorkItemId(decodeURIComponent(req.params.workItemId));
  if (!parsed) return res.status(400).json({ error: 'work_item_id 非法', code: 'M10_WORK_ITEM_INVALID' });

  const body = req.body || {};
  const v = C.validateFeedback({
    feedback_id: body.feedback_id || ('ui-' + person.ebms_user_id + '-' + Date.now()),
    idempotency_key: body.idempotency_key || ('ui:' + person.ebms_user_id + ':' + parsed.slug + ':' + parsed.sourceObjectId + ':' + Date.now()),
    person_id: person.m10_person_id,
    ebms_user_id: person.ebms_user_id,
    items: [{
      work_item_id: C.workItemId(parsed.slug, parsed.sourceObjectId),
      status: body.status || 'done',
      evidence_refs: body.evidence_refs || (body.evidence_url ? [body.evidence_url] : []),
      remark: body.remark || '',
      completed_at: body.completed_at || ''
    }]
  });
  if (!v.ok) return res.status(422).json({ result: 'invalid', errors: v.errors });

  try {
    const r = await service.applyFeedback(v.value, person, { source_ip: req.socket && req.socket.remoteAddress || '' });
    const status = r.result === 'conflict' ? 409 : 200;
    res.status(status).json(Object.assign({ contract_version: C.CONTRACT_VERSION, source: 'ebms' }, r));
  } catch (e) {
    res.status(500).json({ result: 'error', error: e.message });
  }
});

// ============================ 管理面 ============================
router.get('/status', requirePerm('system:config'), (req, res) => send(res, H.handleStatus()));

router.get('/config', requirePerm('system:config'), (req, res) => send(res, H.handleConfigGet()));
router.put('/config', requirePerm('system:config'), wrap((req) => H.handleConfigPut(req.body)));
router.post('/config', requirePerm('system:config'), wrap((req) => H.handleConfigPut(req.body)));

router.get('/logs', requirePerm('system:config'), (req, res) => send(res, H.handleLogs(req.query)));

router.get('/person-links', requirePerm('system:config'), (req, res) => send(res, H.handlePersonLinks()));
router.post('/person-links', requirePerm('system:config'), wrap((req) => H.handleUpsertPersonLink(req.body)));
router.delete('/person-links/:id', requirePerm('system:config'), wrap((req) => H.handleRemovePersonLink(req.params.id)));

module.exports = router;
