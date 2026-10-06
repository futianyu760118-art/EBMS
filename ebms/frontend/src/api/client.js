const BASE = '/api/v1';

let token = sessionStorage.getItem('ebms_token') || '';

export function getToken() {
  return token;
}

export function setToken(next) {
  token = next;
  if (next) sessionStorage.setItem('ebms_token', next);
  else sessionStorage.removeItem('ebms_token');
}

async function request(path, { method = 'GET', body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok || (payload && payload.ok === false)) {
    const error = new Error(payload?.error?.message || `请求失败（HTTP ${res.status}）`);
    error.code = payload?.error?.code || 'HTTP_ERROR';
    error.details = payload?.error?.details;
    throw error;
  }
  return payload.data;
}

export const api = {
  devLogin: (username) => request('/auth/dev-login', { method: 'POST', body: { username } }),
  evidenceTypes: () => request('/evidence-types'),
  reasons: () => request('/reasons'),
  reasonEvidences: (reasonId) => request(`/reasons/${reasonId}/evidences`),
  evidenceCandidates: (reasonId, q) =>
    request(`/evidences?unlinkedToReason=${encodeURIComponent(reasonId)}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  evidenceDetail: (evidenceId) => request(`/evidences/${evidenceId}`),
  createEvidence: (input) => request('/evidences', { method: 'POST', body: input, auth: true }),
  linkEvidence: (reasonId, evidenceId) =>
    request(`/reasons/${reasonId}/evidences`, { method: 'POST', body: { evidenceId }, auth: true }),
  unlinkEvidence: (reasonId, evidenceId) =>
    request(`/reasons/${reasonId}/evidences/${evidenceId}`, { method: 'DELETE', auth: true }),

  // F1（PAND-79）经营结果指标集
  results: (query = '') => request(`/results${query}`),
  resultMetric: (metricId) => request(`/results/${metricId}`),
  resultSources: () => request('/result-sources'),
  ownerResults: (query = '') => request(`/owner-results${query}`),
  receiveOwnerResult: (input) => request('/owner-results', { method: 'POST', body: input, auth: true }),

  // F4（PAND-82）证据来源标注
  sourceCatalog: () => request('/source-catalog'),
  sourceStats: (query = '') => request(`/sources/stats${query}`),
  missingSources: (query = '') => request(`/sources/missing${query}`),
  sourceDetail: (evidenceId) => request(`/evidences/${evidenceId}/source`),
  annotateSource: (evidenceId, input) =>
    request(`/evidences/${evidenceId}/source`, { method: 'PUT', body: input, auth: true }),

  // F5（PAND-83）四层链路穿透：起点固定为结果指标
  traceAnchors: (query = '') => request(`/trace/anchors${query}`),
  traceChain: (metricId) => request(`/trace/${metricId}`),

  // F7（PAND-85）REPORT 视图：以报告 / 结论为单位组织信息
  reportFilters: () => request('/report-filters'),
  reports: (query = '') => request(`/reports${query}`),
  report: (reportId) => request(`/reports/${reportId}`),
  createReport: (input) => request('/reports', { method: 'POST', body: input, auth: true }),

  // F11（PAND-89）四视图对象交叉跳转
  viewObjectTypes: () => request('/view-object-types'),
  viewObjects: (type) => request(`/objects/${type}`),
  viewObject: (type, id) => request(`/objects/${type}/${id}`),
  viewNavigation: (type, id) => request(`/objects/${type}/${id}/links`),

  // F8（PAND-86）TODO 待办视图：状态/来源枚举、列表、详情、认领、指派、流转、规则产生
  todoMeta: () => request('/todo-meta'),
  todos: (query = '') => request(`/todos${query}`),
  todo: (id) => request(`/todos/${id}`),
  createTodo: (input) => request('/todos', { method: 'POST', body: input, auth: true }),
  claimTodo: (id) => request(`/todos/${id}/claim`, { method: 'POST', body: {}, auth: true }),
  assignTodo: (id, owner) => request(`/todos/${id}/assign`, { method: 'POST', body: { owner }, auth: true }),
  transitionTodo: (id, status) =>
    request(`/todos/${id}/transitions`, { method: 'POST', body: { status }, auth: true }),
  scanTodos: (input = {}) => request('/todos/rule-scan', { method: 'POST', body: input, auth: true }),
};
