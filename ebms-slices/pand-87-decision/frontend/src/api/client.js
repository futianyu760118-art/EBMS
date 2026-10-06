const TOKEN_KEY = 'ebms.token';
const BASE = '/api/v1';

export function getToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || '';
  } catch (_err) {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch (_err) {
    /* 私密模式下忽略 */
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((payload && payload.error && payload.error.message) || '请求失败');
    err.status = res.status;
    err.code = payload && payload.error ? payload.error.code : 'unknown';
    throw err;
  }
  return payload;
}

function toQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export const api = {
  login: (username, password) =>
    request('/auth/login', { method: 'POST', body: { username, password } }),
  landing: () => request('/me/landing'),

  listDecisions: (filters = {}) => request(`/decisions${toQuery(filters)}`),
  getDecision: (id) => request(`/decisions/${id}`),
  decisionRefs: () => request('/decisions/refs'),
  todoCandidates: (decisionId) =>
    request(`/decisions/todo-candidates${toQuery({ decision_id: decisionId })}`),
  createDecision: (payload) => request('/decisions', { method: 'POST', body: payload }),
  // 结论形成/修改：已形成结论后的每次修改都必须带 reason，否则后端拒绝（不可静默修改）
  saveConclusion: (id, payload) =>
    request(`/decisions/${id}/conclusion`, { method: 'PATCH', body: payload }),
  linkExecutionTodos: (id, payload) =>
    request(`/decisions/${id}/execution-todos`, { method: 'POST', body: payload }),
  unlinkExecutionTodo: (id, todoId) =>
    request(`/decisions/${id}/execution-todos/${todoId}`, { method: 'DELETE' }),
};
