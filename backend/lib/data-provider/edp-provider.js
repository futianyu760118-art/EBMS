/**
 * EBMS 数据接入层 —— EDP 数据源（EdpProvider，骨架）。
 *
 * 后续阶段：从 M02 EDP（企业数据与证据平台）拉取各专业系统的 Result/Event，
 *           替代 LocalProvider（本地表），实现「本地测试 → EDP 取数」的平滑切换。
 *
 * 契约对齐：finance-result-v1 / business-event-v1 / person-lifecycle-*（见 contracts/aeos-v1/）。
 * 配置：EBMS_EDP_URL（EDP 基址）+ EBMS_EDP_TOKEN（机机 Bearer 令牌）。
 * fail-closed：未配置时所有取数返回 not_connected，不产生任何对外请求。
 */
const EDP_BASE = () => (process.env.EBMS_EDP_URL || '').replace(/\/$/, '');
const EDP_TOKEN = () => process.env.EBMS_EDP_TOKEN || '';

function notConnected(owner, contract, period, reason) {
  return { source: 'edp', owner, contract, period: period || null, data: [], status: 'not_connected', reason: reason || 'EDP 取数尚未接入' };
}

async function fetchFromEdp(path) {
  const base = EDP_BASE();
  if (!base) throw new Error('EBMS_EDP_URL 未配置');
  const token = EDP_TOKEN();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(base + path, { headers, timeout: 10000 });
  if (!res.ok) throw new Error('EDP 请求失败 ' + res.status);
  return res.json();
}

function mapResult(owner, contract, period) {
  return async (path) => {
    try {
      const data = await fetchFromEdp(path);
      return { source: 'edp', owner, contract, period: period || null, data: Array.isArray(data) ? data : (data.items || data.data || []), status: 'available' };
    } catch (e) {
      return notConnected(owner, contract, period, e.message);
    }
  };
}

const edpProvider = {
  name: 'edp',

  // ---- 各系统专业结果（经 EDP 拉取）----
  async getFinanceResults(period) {
    return mapResult('M09_FAC', 'finance-result-v1', period)('/api/v1/results/finance?period=' + encodeURIComponent(period || ''));
  },
  async getSalesResults(period) {
    return mapResult('M05_CRM', 'aeos-contracts-v1', period)('/api/v1/results/sales?period=' + encodeURIComponent(period || ''));
  },
  async getDeliveryResults(period) {
    return mapResult('M06_SPC', 'business-event-v1', period)('/api/v1/results/delivery?period=' + encodeURIComponent(period || ''));
  },
  async getRdResults(period) {
    return mapResult('M04_PLM', 'business-event-v1', period)('/api/v1/results/rd?period=' + encodeURIComponent(period || ''));
  },
  async getQualityResults(period) {
    return mapResult('M08_QUALITY', 'business-event-v1', period)('/api/v1/results/quality?period=' + encodeURIComponent(period || ''));
  },

  // ---- 管理对象（M03 自有，经 EDP 持久化读取）----
  async getIndicators(period) { return mapResult('M03_EBMS', null, period)('/api/v1/management/indicators?period=' + encodeURIComponent(period || '')); },
  async getDeptSummary(period) { return mapResult('M03_EBMS', null, period)('/api/v1/management/dept-summary?period=' + encodeURIComponent(period || '')); },
  async getExceptions(period) { return mapResult('M03_EBMS', 'aeos-contracts-v1', period)('/api/v1/management/exceptions?period=' + encodeURIComponent(period || '')); },
  async getDecisions(period) { return mapResult('M03_EBMS', 'aeos-contracts-v1', period)('/api/v1/management/decisions?period=' + encodeURIComponent(period || '')); },
  async getActions(period) { return mapResult('M03_EBMS', 'm10-poms-v1', period)('/api/v1/management/actions?period=' + encodeURIComponent(period || '')); }
};

module.exports = edpProvider;
