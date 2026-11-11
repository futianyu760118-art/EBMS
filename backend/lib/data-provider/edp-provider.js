/**
 * EBMS 数据接入层 —— EDP 数据源（EdpProvider）。
 *
 * 通过 EDP 数据服务（data-api）只读取数，替代 LocalProvider（本地表）。
 * 契约依据：edp-datasvc-integration SKILL（GET /api/v1/data-api/{code} + POST /query）。
 *
 * 环境变量：
 *   EDP_BASE_URL   EDP 根地址
 *   EDP_READ_KEY   data:read 的 API Key（绑定消费方）
 *   EDP_DATASET_*  各数据集 code（如 EDP_DATASET_FINANCE=finance_result）
 *
 * 切换：EBMS_DATA_PROVIDER=edp
 * fail-closed：未配置时返回 not_connected，不产生任何对外请求。
 */
const EDP_BASE = () => (process.env.EDP_BASE_URL || '').replace(/\/$/, '');
const EDP_READ_KEY = () => process.env.EDP_READ_KEY || '';

function configured() { return !!EDP_BASE() && !!EDP_READ_KEY(); }

function datasetCode(kind) {
  const envMap = {
    finance: 'EDP_DATASET_FINANCE',
    sales: 'EDP_DATASET_SALES',
    delivery: 'EDP_DATASET_DELIVERY',
    rd: 'EDP_DATASET_RD',
    quality: 'EDP_DATASET_QUALITY',
    indicators: 'EDP_DATASET_INDICATORS',
    dept: 'EDP_DATASET_DEPT_SUMMARY',
    exceptions: 'EDP_DATASET_EXCEPTIONS',
    decisions: 'EDP_DATASET_DECISIONS',
    actions: 'EDP_DATASET_ACTIONS'
  };
  const def = {
    finance: 'finance_result', sales: 'sales_result', delivery: 'delivery_result',
    rd: 'rd_result', quality: 'quality_result', indicators: 'indicator',
    dept: 'dept_summary', exceptions: 'exception', decisions: 'decision',
    actions: 'meeting-assistant-actions'
  };
  return process.env[envMap[kind]] || def[kind];
}

function notConnected(owner, contract, period, reason) {
  return { source: 'edp', owner, contract, period: period || null, data: [], status: 'not_connected', reason: reason || 'EDP 取数尚未接入' };
}

async function httpFetch(method, path, body) {
  const h = { 'X-API-Key': EDP_READ_KEY(), 'Content-Type': 'application/json' };
  const opts = { method, headers: h, timeout: 30000 };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(EDP_BASE() + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, body: json, text };
}

// 已授权数据集清单（自助发现）
async function catalog() {
  const r = await httpFetch('GET', '/api/v1/data-api/_catalog');
  if (r.status !== 200) throw new Error('EDP _catalog 失败 ' + r.status + ': ' + r.text);
  return r.body;
}

// 查询数据集（POST /query，参数按 JSON 类型，规避 GET 全字符串限制）
async function queryDataset(code, params, opts) {
  const o = opts || {};
  const body = { params: params || {}, limit: o.limit || 500 };
  if (o.cursor) body.cursor = o.cursor;
  if (o.version) body.version = o.version;
  const r = await httpFetch('POST', '/api/v1/data-api/' + encodeURIComponent(code) + '/query', body);
  if (r.status === 429) {
    const err = new Error('EDP 429 限流');
    err.retryAfter = (r.body && r.body.error && r.body.error.extra && r.body.error.extra.retry_after) || 1;
    throw err;
  }
  if (r.status !== 200) throw new Error('EDP query 失败 ' + r.status + ': ' + r.text);
  return r.body; // { dataset_code, dataset_version, rows, next_cursor, truncated }
}

async function fetchKind(owner, contract, period, kind, params) {
  if (!configured()) return notConnected(owner, contract, period);
  try {
    const code = datasetCode(kind);
    const res = await queryDataset(code, params);
    return {
      source: 'edp',
      owner,
      contract,
      period: period || null,
      dataset_code: code,
      dataset_version: res.dataset_version || null,
      data: res.rows || [],
      status: 'available'
    };
  } catch (e) {
    return notConnected(owner, contract, period, e.message);
  }
}

const edpProvider = {
  name: 'edp',
  configured,
  catalog,
  queryDataset,
  datasetCode,

  async getFinanceResults(period) { return fetchKind('M09_FAC', 'finance-result-v1', period, 'finance', { period }); },
  async getSalesResults(period) { return fetchKind('M05_CRM', 'aeos-contracts-v1', period, 'sales', { period }); },
  async getDeliveryResults(period) { return fetchKind('M06_SPC', 'business-event-v1', period, 'delivery', { period }); },
  async getRdResults(period) { return fetchKind('M04_PLM', 'business-event-v1', period, 'rd', { period }); },
  async getQualityResults(period) { return fetchKind('M08_QUALITY', 'business-event-v1', period, 'quality', { period }); },

  async getIndicators(period) { return fetchKind('M03_EBMS', null, period, 'indicators', { period }); },
  async getDeptSummary(period) { return fetchKind('M03_EBMS', null, period, 'dept', { period }); },
  async getExceptions(period) { return fetchKind('M03_EBMS', 'aeos-contracts-v1', period, 'exceptions', { period }); },
  async getDecisions(period) { return fetchKind('M03_EBMS', 'aeos-contracts-v1', period, 'decisions', { period }); },
  async getActions(period) { return fetchKind('M03_EBMS', 'm10-poms-v1', period, 'actions', { period }); }
};

module.exports = edpProvider;
