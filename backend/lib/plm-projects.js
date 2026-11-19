/**
 * M04 PLM 研发自治中心取数适配器（EBMS → PLM REST API）。
 *
 * PLM 无 external 机机接口，需账号登录拿 JWT：
 *   POST /api/auth/login { username, password } → { token, tokenPrefix }
 *   GET  /api/v1/projects?page=&size=            → 研发项目列表
 * 账号走环境变量 PLM_USERNAME / PLM_PASSWORD（未配置则 not_connected）。
 *
 * 研发项目"上期计划vs实际 / 下期预测"：项目按 start_date/plan 归入周期，statistics 计划数/完成数。
 */
const HOST = () => (process.env.PLM_API_HOST || 'http://150.158.13.110:8081').replace(/\/$/, '');
const USER = () => process.env.PLM_USERNAME || '';
const PASS = () => process.env.PLM_PASSWORD || '';

function configured() { return !!(USER() && PASS()); }

let _token = null, _tokenAt = 0;
const TOKEN_TTL = 10 * 60 * 1000;

async function login() {
  if (!configured()) throw new Error('PLM 账号未配置（PLM_USERNAME/PLM_PASSWORD）');
  const res = await fetch(HOST() + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER(), password: PASS() }), timeout: 15000
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  if (!res.ok || !json || json.code !== 200 || !json.data || !json.data.token) {
    throw new Error('PLM 登录失败 ' + res.status + ': ' + text.slice(0, 160));
  }
  _token = (json.data.tokenPrefix || 'Bearer ') + json.data.token;
  _tokenAt = Date.now();
  return _token;
}

async function getToken() {
  if (_token && Date.now() - _tokenAt < TOKEN_TTL) return _token;
  return login();
}

async function plmGet(pathAndQuery) {
  const token = await getToken();
  const res = await fetch(HOST() + pathAndQuery, { headers: { Authorization: token }, timeout: 20000 });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  if (!res.ok || !json || json.code !== 200) {
    // token 过期重登一次
    if (json && json.code === 401) {
      _token = null;
      const t2 = await getToken();
      const res2 = await fetch(HOST() + pathAndQuery, { headers: { Authorization: t2 }, timeout: 20000 });
      const txt2 = await res2.text();
      let j2 = null; try { j2 = JSON.parse(txt2); } catch (e) {}
      if (res2.ok && j2 && j2.code === 200) return j2.data;
    }
    throw new Error('PLM 请求失败 ' + res.status + ': ' + text.slice(0, 160));
  }
  return json.data;
}

async function listProjects() {
  const pageSize = 100;
  let page = 1, all = [];
  for (;;) {
    const data = await plmGet('/api/v1/projects?page=' + page + '&pageSize=' + pageSize);
    const items = (data && (data.records || data.items || data.list)) || [];
    all = all.concat(items);
    const total = (data && (data.total)) || all.length;
    if (all.length >= total || items.length === 0 || page >= 50) break;
    page++;
  }
  return all;
}

function periodOffset(base, n) {
  let [y, m] = String(base).split('-').map(Number);
  m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; }
  return y + '-' + String(m).padStart(2, '0');
}
const ymOf = (d) => String(d || '').slice(0, 7);

/**
 * 研发项目看板：上期/本期计划数 vs 完成数、下期在研预测。
 * 字段：status(ACTIVE/COMPLETED…)、startDate、targetDate、closeDate、createdAt。
 * 完成判定：status ∈ {COMPLETED,CLOSED,DONE,FINISHED} 或 closeDate 有值。
 */
async function getProjectsBoard(currentPeriod) {
  if (!configured()) return { source: 'M04_PLM', connected: false, reason: 'PLM 账号未配置（PLM_USERNAME/PLM_PASSWORD）' };
  const cur = currentPeriod, prev = periodOffset(cur, -1), next = periodOffset(cur, 1);
  let projects = [];
  try { projects = await listProjects(); } catch (e) {
    return { source: 'M04_PLM', connected: false, reason: e.message };
  }
  const isDone = (p) => ['COMPLETED', 'CLOSED', 'DONE', 'FINISHED'].includes(String(p.status || '').toUpperCase()) || !!p.closeDate;
  const inPeriod = (p, period) => ymOf(p.startDate || p.createdAt) === period;
  const stat = (period) => {
    const list = projects.filter(p => inPeriod(p, period));
    return { plan: list.length, done: list.filter(isDone).length, rate: list.length ? Math.round(list.filter(isDone).length / list.length * 100) : null };
  };
  const nextActive = projects.filter(p => !isDone(p) && ymOf(p.targetDate || p.startDate) >= next);
  return {
    source: 'M04_PLM',
    connected: true,
    period: { previous: prev, current: cur, next },
    previous: stat(prev),
    current: stat(cur),
    next_forecast: { count: nextActive.length },
    total_projects: projects.length,
    done_projects: projects.filter(isDone).length
  };
}

module.exports = { configured, login, listProjects, getProjectsBoard, periodOffset };
