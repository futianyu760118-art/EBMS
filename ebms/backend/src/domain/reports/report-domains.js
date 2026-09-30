'use strict';

/**
 * 责任域（REPORT 的筛选维度之一）的唯一取值来源。
 *
 * 口径：责任域描述「这份报告由哪个经营管理条线负责」，与 F1 的 Owner 模块
 * （M05 销售 / M06 交付 / M09 财经，见 result-sources.js）对齐，使报告落到责任主体时
 * 能明确指向对应的专业 Owner。`ownerModule` 为域与该 Owner 模块的对应关系（可空表示跨域）。
 *
 * 与 reports.domain 的关系：domain 列存本清单的 code。列上不设 CHECK 约束
 * （002 已建的锚点行不保证落在本清单内），合法性在 report-service 写入时校验。
 */

const REPORT_DOMAINS = [
  { code: 'finance', label: '财务', ownerModule: 'M09' },
  { code: 'sales', label: '销售', ownerModule: 'M05' },
  { code: 'delivery', label: '交付', ownerModule: 'M06' },
  { code: 'supply_chain', label: '供应链', ownerModule: 'M06' },
];

const REPORT_DOMAIN_CODES = REPORT_DOMAINS.map((d) => d.code);

function isReportDomain(code) {
  return REPORT_DOMAIN_CODES.includes(code);
}

function reportDomain(code) {
  return REPORT_DOMAINS.find((d) => d.code === code) || null;
}

/**
 * 归一化展示：未知/历史取值（如 002 期间写入的中文域）不丢弃，按原值展示，
 * 使「筛选生效」与「历史数据可见」不冲突。
 */
function describeDomain(code) {
  if (code === null || code === undefined || code === '') return null;
  const found = reportDomain(code);
  return found ? { code: found.code, label: found.label } : { code, label: code };
}

function listReportDomains() {
  return REPORT_DOMAINS.map((d) => ({ code: d.code, label: d.label, ownerModule: d.ownerModule }));
}

module.exports = {
  REPORT_DOMAINS,
  REPORT_DOMAIN_CODES,
  isReportDomain,
  reportDomain,
  describeDomain,
  listReportDomains,
};
