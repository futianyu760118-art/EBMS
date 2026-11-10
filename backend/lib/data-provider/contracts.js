/**
 * EBMS 数据接入层 —— 取数接口契约 + 各系统 adapter 注册表。
 *
 * 定位：EBMS（M03）的经营数据从「本地表」抽离为统一取数接口，隔离数据来源，
 *       当前用 LocalProvider（本地表）测试，后续切换 EdpProvider（M02 EDP 取数），
 *       并为与每个系统（M01~M14）的对接预留接口。
 *
 * 切换：环境变量 EBMS_DATA_PROVIDER=local（默认）| edp
 */

// ===== 各系统 adapter 注册表（对齐 AEOS registry/systems.yaml + contracts/v1）=====
// 记录 EBMS 与每个系统的对接关系：模块、system_id、领域、取数类型、契约、接入状态。
const SYSTEM_ADAPTERS = [
  { module: 'M01', system_id: 'M01_KERNEL', domain: 'identity-and-control', name: 'AEOS Kernel',
    consumes: ['person', 'organization', 'position', 'permission'],
    contract: 'principal-context-v1', direction: 'inbound', status: 'adapter' },
  { module: 'M02', system_id: 'M02_EDP', domain: 'data-and-evidence', name: '企业数据与证据平台',
    consumes: ['event', 'evidence', 'audit', 'result', 'metric'],
    contract: 'business-event-v1', direction: 'bidirectional', status: 'dispatcher' },
  { module: 'M04', system_id: 'M04_PLM', domain: 'research-and-development', name: '研发自治中心',
    consumes: ['rd_result', 'bom', 'eco', 'release'],
    contract: 'business-event-v1', direction: 'inbound', status: 'adapter' },
  { module: 'M05', system_id: 'M05_CRM', domain: 'sales', name: '销售自治中心',
    consumes: ['sales_result', 'customer', 'inquiry', 'quote', 'order'],
    contract: 'aeos-contracts-v1', direction: 'bidirectional', status: 'adapter' },
  { module: 'M06', system_id: 'M06_SPC', domain: 'delivery-and-supply-chain', name: '交付自治中心',
    consumes: ['delivery_result', 'material', 'po', 'plan', 'shipment'],
    contract: 'business-event-v1', direction: 'inbound', status: 'adapter' },
  { module: 'M08', system_id: 'M08_QUALITY', domain: 'quality', name: '品控自治中心',
    consumes: ['quality_result', 'nc', 'capa', 'release_gate'],
    contract: 'business-event-v1', direction: 'inbound', status: 'not-deployed' },
  { module: 'M09', system_id: 'M09_FAC', domain: 'finance', name: '财经自治中心',
    consumes: ['finance_result', 'revenue', 'cost', 'margin', 'cash'],
    contract: 'finance-result-v1', direction: 'inbound', status: 'adapter' },
  { module: 'M10', system_id: 'M10_POMS', domain: 'personal-operations', name: '岗位个人操作微系统',
    consumes: ['todo', 'action', 'feedback', 'evidence_submit'],
    contract: 'm10-poms-v1', direction: 'bidirectional', status: 'adapter' },
  { module: 'M13', system_id: 'M13_AEOS_HUB', domain: 'agent-runtime', name: '智能体员工自治管理中心',
    consumes: ['agent_performance', 'agent_result'],
    contract: 'business-event-v1', direction: 'inbound', status: 'adapter' },
  { module: 'M14', system_id: 'M14_NOMI', domain: 'development-operations', name: '系统研发自治中心',
    consumes: ['dev_performance', 'delivery_status'],
    contract: 'business-event-v1', direction: 'inbound', status: 'adapter' }
];

// ===== 统一取数接口契约 =====
// 每个方法：入参 + 返回结构（对齐 AEOS 契约对象）。业务模块只依赖此契约，不感知数据来源。
const PROVIDER_CONTRACT = {
  // 各系统专业结果（EBMS 只消费 Result，不重算专业算法）
  getFinanceResults:  { params: ['period'], returns: 'FinanceResultV1[]',   owner: 'M09_FAC', contract: 'finance-result-v1' },
  getSalesResults:    { params: ['period'], returns: 'SalesResult[]',       owner: 'M05_CRM', contract: 'aeos-contracts-v1' },
  getDeliveryResults: { params: ['period'], returns: 'DeliveryResult[]',    owner: 'M06_SPC', contract: 'business-event-v1' },
  getRdResults:       { params: ['period'], returns: 'RdResult[]',          owner: 'M04_PLM', contract: 'business-event-v1' },
  getQualityResults:  { params: ['period'], returns: 'QualityResult[]',     owner: 'M08_QUALITY', contract: 'business-event-v1' },
  // 管理对象（M03 自有，本地表 / 后续经 EDP 持久化）
  getIndicators:      { params: ['period'], returns: 'Indicator[]',         owner: 'M03_EBMS', contract: null },
  getDeptSummary:     { params: ['period'], returns: 'DeptSummary[]',       owner: 'M03_EBMS', contract: null },
  getExceptions:      { params: ['period'], returns: 'Exception[]',         owner: 'M03_EBMS', contract: 'aeos-contracts-v1' },
  getDecisions:       { params: ['period'], returns: 'Decision[]',          owner: 'M03_EBMS', contract: 'aeos-contracts-v1' },
  getActions:         { params: ['period'], returns: 'Action[]',            owner: 'M03_EBMS', contract: 'm10-poms-v1' }
};

function getSystemAdapter(module) {
  return SYSTEM_ADAPTERS.find(a => a.module === module || a.system_id === module) || null;
}

module.exports = {
  SYSTEM_ADAPTERS,
  PROVIDER_CONTRACT,
  getSystemAdapter
};
