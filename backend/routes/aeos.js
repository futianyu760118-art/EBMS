/**
 * AEOS 销售数据同步通道 —— HTTP 接入层（Express 适配）。
 *
 *   POST /api/aeos/ingest                 CRM→EBMS 入站（Bearer 机机鉴权，见 lib/aeos-http.js）
 *   GET  /api/aeos/status                 通道就绪状态与出站队列计数
 *   GET  /api/aeos/config · PUT /api/aeos/config     通道配置（不含任何密钥）
 *   GET  /api/aeos/outbox                 出站队列（分页/筛选）
 *   POST /api/aeos/outbox/flush           立即投递
 *   POST /api/aeos/outbox/:id/retry       单条重投（已 SUCCESS → 无需重试）
 *   POST /api/aeos/outbox/:id/requeue     死信人工复位为待投递
 *   DELETE /api/aeos/outbox/:id           丢弃一条出站记录
 *   POST /api/aeos/export                 迁移一次性导出（依赖序，可选投递）
 *   GET  /api/aeos/reconcile              对账（?remote={"pending":0,"failed":0} 可并入对侧数字）
 *   GET  /api/aeos/logs                   入站处理日志
 *   GET  /api/aeos/logs/:id               入站原始报文反查
 *   GET  /api/aeos/conflicts              冲突/留痕记录
 *
 * 管理面复用现有权限码 system:config，不新增权限码（避免部署期需补权限数据）。
 */
const express = require('express');
const router = express.Router();
const { requirePerm } = require('../auth-middleware');
const H = require('../lib/aeos-http');
const outbox = require('../lib/aeos-outbox');
const store = require('../lib/aeos-store');

const PERM = 'system:config';

function send(res, r) { res.status(r.status).json(r.body); }

/** 异步处理器的统一适配：解析 Promise 后按契约状态码回写，异常兜底 500。 */
function wrap(fn) {
  return async (req, res) => {
    try { send(res, await fn(req)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  };
}

// ---- 入站：机机通道，Bearer 凭据鉴权（不用会话权限）----
router.post('/ingest', async (req, res) => {
  try { send(res, await H.handleIngest({ headers: req.headers, body: req.body })); }
  catch (e) { res.status(500).json({ result: 'error', error: e.message }); }
});

// ---- 管理面 ----
router.get('/status', requirePerm(PERM), (req, res) => send(res, H.handleStatus()));

router.get('/config', requirePerm(PERM), (req, res) => send(res, H.handleConfigGet()));
router.put('/config', requirePerm(PERM), wrap((req) => H.handleConfigPut(req.body)));
router.post('/config', requirePerm(PERM), wrap((req) => H.handleConfigPut(req.body)));

router.get('/outbox', requirePerm(PERM), (req, res) => send(res, H.handleList(req.query)));

router.post('/outbox/flush', requirePerm(PERM), async (req, res) => {
  try { send(res, await H.handleFlush(req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/outbox/:id/retry', requirePerm(PERM), async (req, res) => {
  try { send(res, await H.handleRetry(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/outbox/:id/requeue', requirePerm(PERM), wrap(async (req) => {
  store.init();
  const r = await outbox.requeue(req.params.id);
  return { status: r.ok ? 200 : 404, body: r };
}));

router.delete('/outbox/:id', requirePerm(PERM), wrap(() => H.handleDismiss(req.params.id)));

router.post('/export', requirePerm(PERM), async (req, res) => {
  try { send(res, await H.handleExport(req.body)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/reconcile', requirePerm(PERM), (req, res) => send(res, H.handleReconcile(req.query)));

router.get('/logs', requirePerm(PERM), (req, res) => send(res, H.handleLogs(req.query)));
router.get('/logs/:id', requirePerm(PERM), (req, res) => send(res, H.handleInboundDetail(req.params.id)));

router.get('/conflicts', requirePerm(PERM), (req, res) => send(res, H.handleConflicts(req.query)));

module.exports = router;
