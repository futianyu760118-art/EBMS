/**
 * M10 POMS 微系统对接的 HTTP 处理核心（与 Express 解耦，便于回归脚本直接调用）。
 *
 * 机器通道（M10 BFF -> EBMS）：
 *   GET  /api/m10/partner/status
 *   GET  /api/m10/partner/workspace?person_id=
 *   GET  /api/m10/partner/work-items?person_id=&status=&limit=
 *   GET  /api/m10/partner/results?person_id=&limit=
 *   POST /api/m10/partner/feedback
 *   统一要求 Authorization: Bearer ${M10_PARTNER_TOKEN}；未配置令牌时 fail-closed 返回 503。
 *
 * 管理面（EBMS 前端 / 运维，权限码 system:config）：
 *   GET/PUT /api/m10/config · GET /api/m10/status · GET /api/m10/logs · person-links
 */
const crypto = require('crypto');
const secrets = require('./secrets');
const store = require('./m10-store');
const service = require('./m10-service');
const C = require('./m10-contract');

function lower(h) {
  const out = {};
  Object.keys(h || {}).forEach(k => { out[String(k).toLowerCase()] = h[k]; });
  return out;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (e) { return false; }
}

/** 机器通道鉴权：未配置令牌 → 503；缺失/错误 → 401。 */
function checkPartnerToken(headers) {
  const h = lower(headers);
  const configured = secrets.m10PartnerToken();
  if (!configured) {
    return { ok: false, status: 503, body: { error: 'M10 对接未启用：未配置 M10_PARTNER_TOKEN', code: 'M10_NOT_CONFIGURED' } };
  }
  const auth = String(h['authorization'] || '');
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const token = m ? m[1].trim() : String(h['x-m10-token'] || '').trim();
  if (!token) return { ok: false, status: 401, body: { error: '缺少 Authorization: Bearer <token>', code: 'M10_TOKEN_REQUIRED' } };
  if (!safeEqual(token, configured)) return { ok: false, status: 401, body: { error: 'M10 凭据无效', code: 'M10_TOKEN_INVALID' } };
  return { ok: true };
}

function checkEnabled() {
  const cfg = store.getConfig();
  if (cfg.enabled === false) {
    return { ok: false, status: 503, body: { error: 'M10 对接已在 EBMS 配置中停用', code: 'M10_DISABLED' } };
  }
  return { ok: true };
}

function personQuery(query) {
  const q = query || {};
  return {
    m10_person_id: q.m10_person_id || (q.person_id && !/^\d+$/.test(String(q.person_id)) ? q.person_id : ''),
    person_id: q.person_id,
    ebms_user_id: q.ebms_user_id,
    emp_code: q.emp_code,
    name: q.name
  };
}

function unmappedResponse() {
  return {
    status: 200,
    body: {
      contract_version: C.CONTRACT_VERSION,
      person_unmapped: true,
      items: [],
      results: [],
      source: 'ebms',
      hint: '未找到 EBMS 人员映射。请先在 /api/m10/person-links 建立 M10 person_id → EBMS 用户映射，或改用 EBMS 用户名 / 工号查询。'
    }
  };
}

/** M10 侧健康检查：只暴露通道状态，不返回配置中的任何机密。 */
function handlePartnerStatus(headers) {
  const auth = checkPartnerToken(headers);
  if (!auth.ok) return auth;
  const cfg = store.getConfig();
  return {
    status: 200,
    body: {
      contract_version: C.CONTRACT_VERSION,
      enabled: !!cfg.enabled,
      transport: store.transportStatus(),
      feedback: store.feedbackCounts(),
      server_time: require('../db').now()
    }
  };
}

function handlePartnerWorkspace(query, headers) {
  const auth = checkPartnerToken(headers);
  if (!auth.ok) return auth;
  const enabled = checkEnabled();
  if (!enabled.ok) return enabled;
  const person = service.resolvePerson(personQuery(query));
  if (!person) {
    const r = unmappedResponse();
    return { status: 200, body: Object.assign(r.body, {
      contract_version: C.CONTRACT_VERSION,
      tenant_id: 'EBMS',
      person_id: (query && query.person_id) || '',
      name: '',
      positions: [],
      widgets: [
        { id: 'future_todos', visible: true, count: 0, summary: service.summarize([]) },
        { id: 'past_results', visible: true, count: 0 },
        { id: 'personal_agent', visible: false }
      ],
      actions: []
    }) };
  }
  return { status: 200, body: service.buildWorkspace(person) };
}

function handlePartnerWorkItems(query, headers) {
  const auth = checkPartnerToken(headers);
  if (!auth.ok) return auth;
  const enabled = checkEnabled();
  if (!enabled.ok) return enabled;
  const person = service.resolvePerson(personQuery(query));
  if (!person) return { status: 200, body: unmappedResponse().body };

  const q = query || {};
  const items = service.collectWorkItems(person, {
    status: q.status,
    include_done: q.include_done === '1' || q.include_done === 'true',
    limit: q.limit
  });
  return { status: 200, body: { contract_version: C.CONTRACT_VERSION, items, summary: service.summarize(items), source: 'ebms' } };
}

function handlePartnerResults(query, headers) {
  const auth = checkPartnerToken(headers);
  if (!auth.ok) return auth;
  const enabled = checkEnabled();
  if (!enabled.ok) return enabled;
  const person = service.resolvePerson(personQuery(query));
  if (!person) return { status: 200, body: unmappedResponse().body };

  const results = service.collectResults(person, { limit: (query || {}).limit });
  return { status: 200, body: { contract_version: C.CONTRACT_VERSION, results, source: 'ebms' } };
}

async function handlePartnerFeedback(headers, body, sourceIp) {
  const auth = checkPartnerToken(headers);
  if (!auth.ok) return auth;
  const enabled = checkEnabled();
  if (!enabled.ok) return enabled;

  const cfg = store.getConfig();
  if (cfg.allowFeedback === false) {
    return { status: 503, body: { error: 'M10 执行反馈已在 EBMS 配置中停用', code: 'M10_FEEDBACK_DISABLED' } };
  }

  const v = C.validateFeedback(body);
  if (!v.ok) return { status: 422, body: { result: 'invalid', errors: v.errors } };

  const person = service.resolvePerson({
    m10_person_id: v.value.person_id,
    person_id: v.value.person_id,
    ebms_user_id: v.value.ebms_user_id
  });
  if (!person) {
    return {
      status: 422,
      body: {
        result: 'invalid',
        code: 'M10_PERSON_UNMAPPED',
        errors: [{ field: 'person_id', message: '未找到 EBMS 人员映射；请先建立 person-link 或传 ebms_user_id' }]
      }
    };
  }

  const r = await service.applyFeedback(v.value, person, { source_ip: sourceIp || '' });
  const status = r.result === 'conflict' ? 409 : 200;
  return { status, body: Object.assign({ contract_version: C.CONTRACT_VERSION, source: 'ebms' }, r) };
}

// ============================ 管理面 ============================
function handleStatus() {
  store.init();
  const cfg = store.getConfig();
  return {
    status: 200,
    body: {
      contract_version: C.CONTRACT_VERSION,
      transport: store.transportStatus(),
      config: {
        enabled: cfg.enabled,
        portalUrl: cfg.portalUrl,
        allowFeedback: cfg.allowFeedback,
        includeSopActions: cfg.includeSopActions,
        includeAiActions: cfg.includeAiActions,
        includeChatActions: cfg.includeChatActions,
        pageSize: cfg.pageSize,
        owner: cfg.owner
      },
      feedback: store.feedbackCounts(),
      person_links: store.listPersonLinks().length,
      server_time: require('../db').now()
    }
  };
}

function handleConfigGet() {
  store.init();
  return { status: 200, body: store.getConfig() };
}

async function handleConfigPut(body) {
  store.init();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { error: '参数必须是对象' } };
  }
  const next = await store.setConfig(body);
  return { status: 200, body: { ok: true, config: next, transport: store.transportStatus() } };
}

function handleLogs(query) {
  store.init();
  return { status: 200, body: store.listFeedback(query) };
}

function handlePersonLinks() {
  store.init();
  return { status: 200, body: { rows: store.listPersonLinks() } };
}

async function handleUpsertPersonLink(body) {
  store.init();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { error: '参数必须是对象' } };
  }
  if (!String(body.m10_person_id || '').trim()) {
    return { status: 422, body: { error: 'm10_person_id 必填' } };
  }
  if (body.ebms_user_id !== undefined && body.ebms_user_id !== null && body.ebms_user_id !== '') {
    const uid = Number(body.ebms_user_id);
    const found = Number.isFinite(uid) && require('../db').getTable('users').all().some(u => Number(u.id) === uid);
    if (!found) return { status: 422, body: { error: 'ebms_user_id 不存在：' + body.ebms_user_id } };
  }
  if (body.ebms_personnel_id !== undefined && body.ebms_personnel_id !== null && body.ebms_personnel_id !== '') {
    const pid = Number(body.ebms_personnel_id);
    const found = Number.isFinite(pid) && require('../db').getTable('org_personnel').all().some(p => Number(p.id) === pid);
    if (!found) return { status: 422, body: { error: 'ebms_personnel_id 不存在：' + body.ebms_personnel_id } };
  }
  try {
    const row = await store.upsertPersonLink(body);
    return { status: 200, body: { ok: true, row } };
  } catch (e) {
    return { status: 400, body: { error: e.message } };
  }
}

async function handleRemovePersonLink(id) {
  store.init();
  const ok = await store.removePersonLink(id);
  return { status: ok ? 200 : 404, body: { ok } };
}

module.exports = {
  lower,
  safeEqual,
  checkPartnerToken,
  handlePartnerStatus,
  handlePartnerWorkspace,
  handlePartnerWorkItems,
  handlePartnerResults,
  handlePartnerFeedback,
  handleStatus,
  handleConfigGet,
  handleConfigPut,
  handleLogs,
  handlePersonLinks,
  handleUpsertPersonLink,
  handleRemovePersonLink
};
