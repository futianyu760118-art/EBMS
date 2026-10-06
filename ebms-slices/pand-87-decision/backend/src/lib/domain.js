'use strict';

const crypto = require('node:crypto');

// 责任域枚举（已确认口径：销售、生产/交付、财务、供应链 四域）
const DOMAINS = Object.freeze({
  SALES: 'sales',
  PRODUCTION: 'production',
  FINANCE: 'finance',
  SUPPLY_CHAIN: 'supply_chain',
  ALL: 'all',
});

const DOMAIN_LABELS = Object.freeze({
  sales: '销售',
  production: '生产/交付',
  finance: '财务',
  supply_chain: '供应链',
  all: '全企业',
});

const PERIOD_TYPES = Object.freeze(['day', 'week', 'month']);

// 四视图对象类型（架构 3.3 object_links，F11 交叉跳转用）
const OBJECT_TYPES = Object.freeze(['report', 'todo', 'decision', 'evidence']);

// 决策「背景」可关联的层级：Result 或 Reason（已确认口径：固定四层链路，Reason 可多级）
const BACKGROUND_REF_TYPES = Object.freeze(['result', 'reason']);
const BACKGROUND_REF_TYPE_LABELS = Object.freeze({
  result: '经营结果',
  reason: '原因项',
});

// 证据类型（已确认四类，F3/PAND-81 口径，与 evidences.type CHECK 约束一致）
const EVIDENCE_TYPE_LABELS = Object.freeze({
  document: '文档',
  contract: '合同',
  system_record: '系统记录',
  manual: '人工填报',
});

function newId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function isDomain(value) {
  return Object.prototype.hasOwnProperty.call(DOMAIN_LABELS, value);
}

function isPeriodType(value) {
  return PERIOD_TYPES.includes(value);
}

function isBackgroundRefType(value) {
  return BACKGROUND_REF_TYPES.includes(value);
}

// 责任域可见性：决策者（scope=*）看全企业；管理责任人只看其责任域
function domainVisible(scope, domain) {
  if (!scope || scope.mode === 'all') return true;
  if (domain === DOMAINS.ALL) return false;
  return (scope.domains || []).includes(domain);
}

module.exports = {
  DOMAINS,
  DOMAIN_LABELS,
  PERIOD_TYPES,
  OBJECT_TYPES,
  BACKGROUND_REF_TYPES,
  BACKGROUND_REF_TYPE_LABELS,
  EVIDENCE_TYPE_LABELS,
  newId,
  nowIso,
  isDomain,
  isPeriodType,
  isBackgroundRefType,
  domainVisible,
};
