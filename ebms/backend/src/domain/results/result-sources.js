'use strict';

/**
 * 数据来源口径的唯一取值来源（AEOS V7.2 数据归属 + PAND-79 AC 红线）。
 *
 * 实际值只能由下列三个专业 Owner 模块供给；EBMS 既不重算，也不从专业原始表取数。
 * 目标值则固定来自 M03（EBMS 自有的 Management Goal），不属于任何专业模块。
 */

const OWNER_MODULES = [
  { code: 'M09', label: 'M09 财经自治', scope: '收入 / 成本 / 毛利 / 现金 / 应收应付' },
  { code: 'M05', label: 'M05 销售自治', scope: '订单 / 客户 / 报价' },
  { code: 'M06', label: 'M06 交付自治', scope: '交付 / 产能 / 库存 / 物料' },
];

const OWNER_MODULE_CODES = OWNER_MODULES.map((m) => m.code);

const TARGET_SOURCE_MODULE = 'M03';

const PERIOD_TYPES = ['day', 'week', 'month'];

const RESULT_STATUSES = ['VERIFIED', 'DRAFT', 'REJECTED'];

/**
 * AEOS.Result.V1（BusinessMetric）登记时的必填字段。
 * `calculationVersion` 与 `evidenceIds` 为团队口径硬要求：专业指标必须记录口径版本与证据引用，
 * 否则「实际值可追溯到 Owner Result + 口径版本 + 证据」无法成立，故在接入处即拒绝。
 */
const OWNER_RESULT_CONTRACT = {
  version: 'AEOS.Result.V1',
  requiredFields: [
    'resultId',
    'sourceSystem',
    'objectType',
    'objectId',
    'metricCode',
    'value',
    'periodType',
    'periodValue',
    'calculationVersion',
    'evidenceIds',
    'status',
    'occurredAt',
    'traceId',
  ],
};

function isOwnerModule(code) {
  return OWNER_MODULE_CODES.includes(code);
}

function ownerModule(code) {
  return OWNER_MODULES.find((m) => m.code === code) || null;
}

module.exports = {
  OWNER_MODULES,
  OWNER_MODULE_CODES,
  TARGET_SOURCE_MODULE,
  PERIOD_TYPES,
  RESULT_STATUSES,
  OWNER_RESULT_CONTRACT,
  isOwnerModule,
  ownerModule,
};
