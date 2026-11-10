/**
 * EBMS 对外只读接口 v1（对齐恒聘通 / 会议中心 / M06-SPC 的统一 external 规范）。
 *
 *   Base:    /api/v1/external
 *   文档:    GET /api/v1/external/docs          （公开）
 *   OpenAPI: GET /api/v1/external/openapi.json  （公开）
 *
 *   鉴权：X-App-Key + X-Timestamp + X-Signature
 *         signature = HMAC-SHA256(AppSecret, "{timestamp}.{method}.{path}")
 *         密钥来自环境变量 EBMS_EXTERNAL_APP_KEY / EBMS_EXTERNAL_APP_SECRET（fail-closed）
 *
 *   只读端点（供云服务 / 微系统待办总表拉取）：
 *     GET /indicators?period=      经营指标
 *     GET /finance-results?period= 财务结果（M09 FAC）
 *     GET /dept-summary?period=    部门红黄绿
 *     GET /exceptions?period=      经营异常
 *     GET /decisions?period=       决策清单
 *     GET /todos                   待办（接入微系统待办总表）
 */
const express = require('express');
const router = express.Router();
const dataProvider = require('../lib/data-provider');
const { appKey, appSecret, verifySignature, collectTodos } = require('../lib/external-v1-core');

function apiAuth(req, res, next) {
  const key = req.headers['x-app-key'] || '';
  const secret = appSecret();
  if (!appKey() || !secret) {
    return res.status(503).json({ code: 503, message: '服务端未配置 EBMS_EXTERNAL_APP_KEY/SECRET，外部接口已停用' });
  }
  if (!key || key !== appKey()) {
    return res.status(401).json({ code: 401, message: 'X-App-Key 缺失或无效' });
  }
  const timestamp = req.headers['x-timestamp'];
  const signature = req.headers['x-signature'];
  const path = req.originalUrl || req.url;
  if (!verifySignature(secret, timestamp, signature, req.method, path)) {
    return res.status(401).json({ code: 401, message: '签名无效或已过期' });
  }
  next();
}

// ===== 公开：接口文档 =====
router.get('/docs', (req, res) => {
  const base = '/api/v1/external';
  res.json({
    service: 'EBMS External API v1',
    base: base,
    auth: 'X-App-Key + X-Timestamp + X-Signature（HMAC-SHA256(AppSecret, "{timestamp}.{method}.{path}")）',
    endpoints: [
      { method: 'GET', path: base + '/docs', desc: '本文档（公开）', auth: false },
      { method: 'GET', path: base + '/openapi.json', desc: 'OpenAPI 规范（公开）', auth: false },
      { method: 'GET', path: base + '/indicators?period=', desc: '经营指标', auth: true },
      { method: 'GET', path: base + '/finance-results?period=', desc: '财务结果（M09）', auth: true },
      { method: 'GET', path: base + '/dept-summary?period=', desc: '部门红黄绿', auth: true },
      { method: 'GET', path: base + '/exceptions?period=', desc: '经营异常', auth: true },
      { method: 'GET', path: base + '/decisions?period=', desc: '决策清单', auth: true },
      { method: 'GET', path: base + '/todos', desc: '待办（接入微系统待办总表）', auth: true }
    ]
  });
});

// ===== 公开：OpenAPI 规范 =====
router.get('/openapi.json', (req, res) => {
  res.json({
    openapi: '3.0.0',
    info: { title: 'EBMS External API', version: '1.0.0' },
    servers: [{ url: '/api/v1/external' }],
    security: [{ AppKeySecret: [] }],
    components: {
      securitySchemes: {
        AppKeySecret: { type: 'apiKey', in: 'header', name: 'X-App-Key', description: '配合 X-Timestamp + X-Signature（HMAC-SHA256）' }
      }
    },
    paths: {
      '/indicators': { get: { summary: '经营指标', parameters: [{ name: 'period', in: 'query', required: false }] } },
      '/finance-results': { get: { summary: '财务结果', parameters: [{ name: 'period', in: 'query', required: false }] } },
      '/dept-summary': { get: { summary: '部门红黄绿', parameters: [{ name: 'period', in: 'query', required: false }] } },
      '/exceptions': { get: { summary: '经营异常', parameters: [{ name: 'period', in: 'query', required: false }] } },
      '/decisions': { get: { summary: '决策清单', parameters: [{ name: 'period', in: 'query', required: false }] } },
      '/todos': { get: { summary: '待办' } }
    }
  });
});

// ===== 只读数据端点（需鉴权）=====
router.get('/indicators', apiAuth, (req, res) => res.json(dataProvider.getIndicators(req.query.period)));
router.get('/finance-results', apiAuth, (req, res) => res.json(dataProvider.getFinanceResults(req.query.period)));
router.get('/dept-summary', apiAuth, (req, res) => res.json(dataProvider.getDeptSummary(req.query.period)));
router.get('/exceptions', apiAuth, (req, res) => res.json(dataProvider.getExceptions(req.query.period)));
router.get('/decisions', apiAuth, (req, res) => res.json(dataProvider.getDecisions(req.query.period)));

// 待办（接入微系统待办总表）
router.get('/todos', apiAuth, (req, res) => {
  const items = collectTodos();
  res.json({
    source: 'ebms',
    contract_version: 'M10-POMS.V1',
    total: items.length,
    items
  });
});

module.exports = router;
