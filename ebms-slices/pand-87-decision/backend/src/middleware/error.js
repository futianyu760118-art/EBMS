'use strict';

const { AppError } = require('../lib/errors');

function notFoundHandler(_req, res) {
  res.status(404).json({ error: { code: 'not_found', message: '接口不存在' } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'bad_request', message: '请求体不是合法 JSON' } });
  }
  // 数据层约束兜底（决策「已决策不变量」等 CHECK 命中）
  if (err && /CHECK constraint|constraint failed|violates check constraint/i.test(err.message || '')) {
    return res.status(400).json({
      error: {
        code: 'constraint_violation',
        message: '数据不满足业务约束',
        details: { raw: err.message },
      },
    });
  }
  console.error('[ebms] 未处理异常:', err);
  return res.status(500).json({ error: { code: 'internal', message: '服务内部错误' } });
}

module.exports = { errorHandler, notFoundHandler };
