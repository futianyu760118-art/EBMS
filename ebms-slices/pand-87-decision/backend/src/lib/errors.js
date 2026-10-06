'use strict';

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new AppError(400, 'bad_request', message, details);
const unauthorized = (message = '未登录或登录已失效') =>
  new AppError(401, 'unauthorized', message);
const forbidden = (message = '无权访问该资源') => new AppError(403, 'forbidden', message);
const notFound = (message = '资源不存在') => new AppError(404, 'not_found', message);
// 语义可解析但被领域规则拒绝（如结论不可静默修改、执行 TODO 重复关联）
const unprocessable = (message, details) =>
  new AppError(422, 'unprocessable', message, details);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, unprocessable };
