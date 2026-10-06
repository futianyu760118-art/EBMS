/**
 * PAND-87 端到端验证：真实启动 backend 服务，走真实 HTTP + 真实落库。
 *
 * 运行： cd backend && npm install   # 首次
 *        node scripts/decision-view-e2e.js
 *
 * 与 scripts/*.test.js（纯规则 / 静态断言）不同，本脚本会：
 *   1) 先在 127.0.0.1:3314 预热启动一次（见下方「预热启动」注释）、随后在 127.0.0.1:3313
 *      真实拉起 backend/server.js 跑断言（退出时只杀自己拉起的子进程）；
 *   2) 清空 database/{decisions,decision_changes,todos}.json 以保证断言可重复
 *      （todos 为 F8 共享事实源，本脚本仅用于隔离测试环境）。
 * 请勿在生产数据目录上运行。
 */
'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const BACKEND = path.join(REPO, 'backend');
const PORT = 3313;
const BASE = `http://127.0.0.1:${PORT}`;
const rules = require(path.join(BACKEND, 'lib', 'decision-rules.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(method, url, { token, body } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, body: json };
}

async function main() {
  // 测试隔离：清空本功能的三张表，使断言中的绝对计数可重复（todos 为 F8 共享事实源，
  // 本工作副本中仅由本脚本写入）
  const fs = require('node:fs');
  const DATA = path.join(REPO, 'database');
  ['decisions', 'decision_changes', 'todos'].forEach(n => {
    ['.json', '.json.bak', '.json.tmp'].forEach(ext => {
      try { fs.unlinkSync(path.join(DATA, n + ext)); } catch (e) { /* 不存在即忽略 */ }
    });
  });

  // ===== 预热启动 =====
  // 既有口径（基线提交 9456fa0 上同样复现，非本功能引入）：全新库的第一次启动中，
  // initData 先写入的 roles / permissions 在随后的「角色权限」播种阶段被读回为空表，
  // 于是除 admin（角色直通）外所有角色首启后没有任何权限，须再启动一次、表从磁盘载入后才生效。
  // 为让本脚本在全新检出上可重复，这里先做一次预热启动，让初始化数据落盘。
  {
    const WARM_PORT = PORT + 1;
    const warm = spawn(process.execPath, ['server.js'], {
      cwd: BACKEND,
      env: Object.assign({}, process.env, { PORT: String(WARM_PORT), NODE_ENV: 'development' }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let wlog = '';
    warm.stdout.on('data', d => { wlog += d.toString(); });
    warm.stderr.on('data', d => { wlog += d.toString(); });
    const warmReady = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${WARM_PORT}/api/users/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'admin123' })
        });
        return res.status === 200;
      } catch (e) { return false; }
    };
    let wready = false;
    for (let i = 0; i < 120; i++) {
      if (await warmReady()) { wready = true; break; }
      await sleep(500);
    }
    try { warm.kill(); } catch (e) {}
    assert.ok(wready, '预热启动未在预期时间内就绪；日志尾部：\n' + wlog.slice(-2000));
    await sleep(500); // 等预热进程退出、初始化数据落盘
  }

  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND,
    env: Object.assign({}, process.env, { PORT: String(PORT), NODE_ENV: 'development' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', d => { logs += d.toString(); });
  child.stderr.on('data', d => { logs += d.toString(); });
  const cleanup = () => { try { child.kill(); } catch (e) {} };
  process.on('exit', cleanup);

  const results = [];
  const step = name => results.push(name);

  try {
    // ===== 就绪 =====
    // 预热启动已让初始化数据落盘，这里的就绪条件取「路由可达 + 权限已生效」两个可观测事实。
    let ready = false;
    let auth = null;
    for (let i = 0; i < 120; i++) {
      try {
        const l = await req('POST', '/api/users/login', { body: { username: 'viewer01', password: 'view123' } });
        if (l.status === 200 && l.body && l.body.token) {
          const probe = await req('GET', '/api/decisions', { token: l.body.token });
          if (probe.status === 200) { ready = true; auth = l; break; }
        }
      } catch (e) { /* 未就绪，继续等 */ }
      await sleep(500);
    }
    assert.ok(ready, '服务/权限播种未在预期时间内就绪；日志尾部：\n' + logs.slice(-3000));

    // ===== 鉴权与权限码 =====
    const anon = await req('GET', '/api/decisions');
    assert.equal(anon.status, 401, '未登录访问决策接口必须 401');

    const badLogin = await req('POST', '/api/users/login', { body: { username: 'admin', password: 'wrong' } });
    assert.equal(badLogin.status, 401, '错误口令必须 401');

    const login = await req('POST', '/api/users/login', { body: { username: 'admin', password: 'admin123' } });
    assert.equal(login.status, 200, 'admin 登录应成功：' + JSON.stringify(login.body));
    const token = login.body.token;
    assert.ok(token, '登录应签发 token');
    step('鉴权：未登录 401 / 登录签发 token');

    const vToken = auth.body.token;
    const vRead = await req('GET', '/api/decisions', { token: vToken });
    assert.equal(vRead.status, 200, 'viewer 有 decision:view，应可读');
    const vCreate = await req('POST', '/api/decisions', {
      token: vToken, body: { title: '越权创建', background: [{ type: 'result', code: 'x' }], options: [{ name: 'A' }] }
    });
    assert.equal(vCreate.status, 403, 'viewer 无 decision:create，必须 403');
    assert.equal(vCreate.body.code, 'PERMISSION_DENIED', '403 应带 PERMISSION_DENIED');
    const vEdit = await req('PATCH', '/api/decisions/1/conclusion', { token: vToken, body: { conclusion: '越权决策' } });
    assert.equal(vEdit.status, 403, 'viewer 无 decision:edit，形成结论必须 403');
    const vDel = await req('DELETE', '/api/decisions/1', { token: vToken });
    assert.equal(vDel.status, 403, 'viewer 无 decision:delete，删除必须 403');
    step('权限码准入：viewer 只读（create/edit/delete 403）');

    // ===== 候选与筛选项 =====
    const refs = await req('GET', '/api/decisions/refs', { token });
    assert.equal(refs.status, 200, '/refs 应可访问');
    assert.deepEqual(refs.body.background_ref_types.map(t => t.value), ['result', 'reason'], '应下发背景关联类型 结果/原因');
    assert.deepEqual(refs.body.background_ref_types.map(t => t.label), ['结果', '原因'], '应下发中文标签');
    assert.deepEqual(refs.body.todo_statuses.map(s => s.value), ['todo', 'doing', 'done', 'cancelled'], '应下发执行项状态口径');
    assert.equal(refs.body.upstream.result_source_ready, false, 'F1 未接入应如实标注');
    assert.equal(refs.body.upstream.reason_source_ready, false, 'F2 未接入应如实标注');
    step('/refs 候选（结果 / 原因 / 执行项状态 / 上游接入实情）');

    const cands = await req('GET', '/api/decisions/todo-candidates', { token });
    assert.equal(cands.status, 200, '/todo-candidates 应可访问（且未被 /:id 吞掉）');
    step('/todo-candidates 未被 /:id 路由吞掉');

    // ===== 场景 1：创建（字段齐备 + 校验）=====
    const badNoBg = await req('POST', '/api/decisions', { token, body: { title: '缺背景', options: [{ name: 'A' }] } });
    assert.equal(badNoBg.status, 400, '缺背景必须 400');
    assert.match(badNoBg.body.error, /背景必填/, '错误信息应指明背景必填');

    const badNoTitle = await req('POST', '/api/decisions', {
      token, body: { background: [{ type: 'result', code: 'g' }], options: [{ name: 'A' }] }
    });
    assert.equal(badNoTitle.status, 400, '缺标题必须 400');

    const badOpt = await req('POST', '/api/decisions', {
      token, body: { title: '缺方案', background: [{ type: 'result', code: 'gross_margin' }], options: [] }
    });
    assert.equal(badOpt.status, 400, '候选方案为空必须 400');
    assert.match(badOpt.body.error, /候选方案必填/, '错误信息应指明候选方案必填');

    const badRef = await req('POST', '/api/decisions', {
      token, body: { title: '坏关联', background: [{ type: 'source', code: 'x' }], options: [{ name: 'A' }] }
    });
    assert.equal(badRef.status, 400, '背景关联类型非法必须 400');

    const created = await req('POST', '/api/decisions', {
      token,
      body: {
        title: '9 月毛利下滑归因与对策',
        summary: '毛利率环比下降 3.2pct',
        background: [
          { type: 'result', code: 'gross_margin', label: '毛利率' },
          { type: 'reason', code: 'MATERIAL_COST', label: '材料成本上升' }
        ],
        options: [
          { name: '方案A：集中采购议价', description: '与 Top5 重谈', pros: '见效快', cons: '依赖供应商', selected: true },
          { name: '方案B：替代料切换', description: '引入第二供应商', pros: '成本更优', cons: '需验证' }
        ],
        required_evidence: 'EVD202609-0001, EVD202609-0002'
      }
    });
    assert.equal(created.status, 200, '创建应成功：' + JSON.stringify(created.body));
    const id = created.body.id;
    assert.ok(id, '创建应返回 id');
    assert.match(created.body.data.decision_code, /^DEC\d{6}-\d{4}$/, '应自动生成决策编码 DEC+年月-流水');
    assert.equal(created.body.data.status, 'pending', '创建即「待决策」');
    assert.equal(created.body.data.conclusion, '', '初始结论应为空');
    assert.equal(created.body.data.contract_version, 'AEOS.Decision.V1', '应对齐 AEOS.Decision.V1 契约');
    assert.equal(created.body.data.background.length, 2, '背景应保留 2 条关联');
    assert.equal(created.body.data.options.length, 2, '候选方案应保留 2 条');
    assert.equal(created.body.data.required_evidence.length, 2, '所需证据应保留 2 条');
    step('场景 1 创建：背景(结果/原因) + 候选方案 + 所需证据 齐备');

    let detail = await req('GET', `/api/decisions/${id}`, { token });
    assert.equal(detail.status, 200, '详情应可访问');
    assert.deepEqual(detail.body.background.map(b => b.type_label), ['结果', '原因'], '背景应标注 结果/原因');
    assert.equal(detail.body.background[0].resolvable, false, '上游未接入应如实标注不可解析');
    assert.ok(detail.body.background_note, '应说明结果/原因事实源归属');
    assert.equal(detail.body.options.filter(o => o.selected).length, 1, '采纳方案恰好 1 条');
    assert.equal(detail.body.required_evidence[0].provided, false, 'Evidence 未接入时 provided=false');
    assert.ok(detail.body.required_evidence_note, '应说明 provided 的判定依据');
    step('场景 1 详情：字段齐备且来源标注清晰');

    // ===== 边界：待决策不计入已决策 =====
    let stats = await req('GET', '/api/decisions/stats', { token });
    assert.equal(stats.body.pending, 1, '待决策计 1');
    assert.equal(stats.body.decided, 0, '未形成结论不计入已决策数量');
    assert.equal(stats.body.pending_label, '待决策', '状态标签应为「待决策」');

    let list = await req('GET', '/api/decisions?status=pending', { token });
    assert.equal(list.body.total, 1, '待决策筛选取到该条');
    assert.equal(list.body.counts.pending, 1, '列表汇总：待决策 1');
    assert.equal(list.body.counts.decided, 0, '列表汇总：已决策 0');
    assert.equal(list.body.data[0].status_label, '待决策', '未形成结论必须标记「待决策」');
    assert.equal(list.body.data[0].conclusion_change_count, 0, '初始无变更记录');
    step('边界 未形成结论标记「待决策」且不计入已决策数量');

    // ===== 场景 2：形成结论 =====
    const c1 = await req('PATCH', `/api/decisions/${id}/conclusion`, {
      token, body: { conclusion: '采纳方案A，集中采购议价' }
    });
    assert.equal(c1.status, 200, '首次形成结论应成功：' + JSON.stringify(c1.body));
    assert.equal(c1.body.data.status, 'decided', '形成结论后状态为已决策');
    assert.equal(c1.body.data.decided_by, '超级管理员', '决策人应取当前操作者');
    assert.ok(c1.body.data.decided_at, '已决策必须有决策时间');

    stats = await req('GET', '/api/decisions/stats', { token });
    assert.equal(stats.body.decided, 1, '已决策计 1');
    assert.equal(stats.body.pending, 0, '待决策计 0');
    step('场景 2 首次形成结论（决策人 / 决策时间自动落）');

    const same = await req('PATCH', `/api/decisions/${id}/conclusion`, {
      token, body: { conclusion: '采纳方案A，集中采购议价', reason: '补一句' }
    });
    assert.equal(same.status, 422, '结论无变化应 422');
    detail = await req('GET', `/api/decisions/${id}`, { token });
    assert.equal(detail.body.conclusion_change_count, 1, '结论无变化不得虚增变更记录');
    step('场景 2 结论无变化 → 422 且不落变更记录');

    const silent = await req('PATCH', `/api/decisions/${id}/conclusion`, {
      token, body: { conclusion: '改为方案B：替代料切换' }
    });
    assert.equal(silent.status, 400, '未填理由的修改必须 400');
    assert.match(silent.body.error, /不可静默修改/, '错误信息应指明不可静默修改');
    step('场景 2 静默修改被拒（400）');

    const mod = await req('PATCH', `/api/decisions/${id}/conclusion`, {
      token, body: { conclusion: '改为方案B：替代料切换', reason: '供应商不接受议价' }
    });
    assert.equal(mod.status, 200, '带理由修改应成功');
    detail = await req('GET', `/api/decisions/${id}`, { token });
    assert.equal(detail.body.conclusion_change_count, 2, '两次成功形成/修改 → 2 条结论变更');
    assert.ok(detail.body.conclusion_change_count >= 2, '变更记录条数 ≥ 实际修改次数');
    const ch = detail.body.changes.filter(c => c.change_type === 'conclusion');
    assert.equal(ch.length, 2, '结论类变更 2 条');
    assert.equal(ch[0].before_value, '', '首次形成：变更前值为空');
    assert.equal(ch[0].after_value, '采纳方案A，集中采购议价', '首次形成：变更后值正确');
    assert.equal(ch[1].before_value, '采纳方案A，集中采购议价', '修改：变更前值正确');
    assert.equal(ch[1].after_value, '改为方案B：替代料切换', '修改：变更后值正确');
    assert.equal(ch[1].reason, '供应商不接受议价', '修改：变更理由已留痕');
    assert.equal(ch[1].changed_by, '超级管理员', '留痕须含变更人');
    assert.ok(ch[1].changed_at, '留痕须含变更时间');
    assert.deepEqual(detail.body.changes.map(c => c.seq), [1, 2], '变更历史按发生次序排列');
    assert.equal(detail.body.conclusion, '改为方案B：替代料切换', '结论已更新');
    assert.equal(detail.body.decided_by, ch[1].changed_by, '决策人更新为本次决策人');
    step('场景 2 修改留痕：变更人 / 时间 / 变更前后值 / 理由 齐备且次序正确');

    // ===== 场景 3：关联执行 TODO + 回看执行结果 =====
    const disp = await req('POST', `/api/decisions/${id}/execution-todos`, {
      token, body: { title: '重谈供应商价格', assignee_name: '赵采购', due_at: '2026-09-20', priority: 'high' }
    });
    assert.equal(disp.status, 200, '派发执行项应成功：' + JSON.stringify(disp.body));
    const todoId = disp.body.data.id;
    assert.equal(disp.body.data.decision_id, id, '派发的执行项应带 decision_id 关联键');
    assert.equal(disp.body.data.contract_version, 'AEOS.Action.V1', '执行项应对齐 AEOS.Action.V1');
    assert.match(disp.body.data.action_code, /^ACT/, '执行项应生成 action_code');

    const disp2 = await req('POST', `/api/decisions/${id}/execution-todos`, {
      token, body: { title: '引入第二供应商', assignee_name: '赵采购', due_at: '2026-10-15' }
    });
    assert.equal(disp2.status, 200, '第二条执行项派发应成功');

    const badStatus = await req('POST', `/api/decisions/${id}/execution-todos`, {
      token, body: { title: '状态非法', status: 'unknown' }
    });
    assert.equal(badStatus.status, 400, '执行项状态非法必须 400');

    detail = await req('GET', `/api/decisions/${id}`, { token });
    assert.equal(detail.body.execution.todos.length, 2, '应回看到 2 条执行项');
    assert.equal(detail.body.execution.summary.total, 2, '执行汇总总数 2');
    assert.equal(detail.body.execution.summary.overdue, 1, '过期未完成项应计入逾期');
    assert.equal(detail.body.execution.summary.todo, 1, '未到期未开始项计入待办');
    assert.equal(detail.body.execution.summary.completion_rate, 0, '尚无完成项，完成度 0');
    assert.equal(detail.body.execution.summary.total,
      detail.body.execution.summary.done + detail.body.execution.summary.doing +
      detail.body.execution.summary.todo + detail.body.execution.summary.overdue +
      detail.body.execution.summary.cancelled,
      '执行汇总各状态桶之和等于总数（不重复计数）');
    const od = detail.body.execution.todos.find(t => t.id === todoId);
    assert.equal(od.exec_label, '逾期', '已过截止时间的执行项应显示「逾期」');
    assert.equal(od.status_label, '待办', '逾期项自身状态仍为「待办」');
    assert.ok(detail.body.execution.note, '应说明不重算 F8 状态流转、不做效果评价');
    step('场景 3 派发执行项 + 回看执行结果（含逾期与完成度）');

    const c2 = await req('GET', '/api/decisions/todo-candidates?unlinked=1', { token });
    assert.equal(c2.body.data.length, 0, '已关联的执行项不应再出现在「未关联」候选中');
    step('场景 3 已关联项从候选中排除');

    // 关联已有执行项（跨决策 409 → 解除 → 关联成功）
    const d2 = await req('POST', '/api/decisions', {
      token, body: { title: '临时决策（用于验证关联已有执行项）', background: [{ type: 'reason', code: 'TEMP' }], options: [{ name: '保持现状' }] }
    });
    const d2id = d2.body.id;
    const d2todo = await req('POST', `/api/decisions/${d2id}/execution-todos`, {
      token, body: { title: '盘点替代料库存', assignee_name: '王工' }
    });
    const t3 = d2todo.body.data.id;

    const cross = await req('POST', `/api/decisions/${id}/execution-todos`, { token, body: { todo_id: t3 } });
    assert.equal(cross.status, 409, '关联到其他决策的执行项必须 409');

    const dup = await req('POST', `/api/decisions/${d2id}/execution-todos`, { token, body: { todo_id: t3 } });
    assert.equal(dup.status, 409, '重复关联本决策已有执行项必须 409');

    const unlink2 = await req('DELETE', `/api/decisions/${d2id}/execution-todos/${t3}`, { token, body: { reason: '改由本决策承接' } });
    assert.equal(unlink2.status, 200, '解除关联应成功');

    const link = await req('POST', `/api/decisions/${id}/execution-todos`, { token, body: { todo_id: t3 } });
    assert.equal(link.status, 200, '关联已有执行项应成功：' + JSON.stringify(link.body));
    assert.equal(link.body.message, '执行项已关联', '应返回「执行项已关联」');
    detail = await req('GET', `/api/decisions/${id}`, { token });
    assert.equal(detail.body.execution.todos.length, 3, '关联后 D1 有 3 条执行项');
    assert.ok(detail.body.execution.todos.some(t => t.id === t3), '被关联的执行项应出现在 D1 的执行列表');
    step('场景 3 关联已有执行项（跨决策 409 / 重复 409 / 解除后重新关联）');

    // 解除关联 → 留痕 + 回到候选
    const unlink = await req('DELETE', `/api/decisions/${id}/execution-todos/${todoId}`, { token, body: { reason: '改由项目组承接' } });
    assert.equal(unlink.status, 200, '解除关联应成功：' + JSON.stringify(unlink.body));
    detail = await req('GET', `/api/decisions/${id}`, { token });
    assert.equal(detail.body.execution.todos.length, 2, '解除后剩 2 条执行项');
    const types = detail.body.changes.map(c => c.change_type);
    assert.ok(types.indexOf('todo_dispatched') >= 0, '派发执行项应留痕（todo_dispatched）');
    assert.ok(types.indexOf('todo_linked') >= 0, '关联已有执行项应留痕（todo_linked）');
    assert.ok(types.indexOf('todo_unlinked') >= 0, '解除关联应留痕（todo_unlinked）');
    const unl = detail.body.changes.filter(c => c.change_type === 'todo_unlinked')[0];
    assert.equal(unl.before_value.indexOf('重谈供应商价格') >= 0, true, '解除留痕应记录被解除对象');
    assert.ok(unl.changed_by && unl.changed_at, '解除留痕应含变更人与时间');
    assert.equal(unl.reason, '改由项目组承接', '解除留痕应记录理由');

    const c3 = await req('GET', '/api/decisions/todo-candidates?unlinked=1', { token });
    assert.equal(c3.body.data.length, 1, '解除关联后该执行项回到「未关联」候选');
    step('场景 3 解除关联留痕 + 执行项回到候选');

    // ===== 判定：筛选 / 分页 / 404 =====
    const byKw = await req('GET', '/api/decisions?keyword=' + encodeURIComponent('毛利'), { token });
    assert.equal(byKw.body.total, 1, '关键字筛选应命中');
    const byStatus = await req('GET', '/api/decisions?status=decided', { token });
    assert.equal(byStatus.body.total, 1, '已决策筛选应命中 1 条');
    assert.equal(byStatus.body.data[0].decided_by, '超级管理员', '已决策条目决策人非空');
    assert.ok(byStatus.body.data[0].decided_at, '已决策条目决策时间非空');
    const byBg = await req('GET', '/api/decisions?background_code=MATERIAL_COST', { token });
    assert.equal(byBg.body.total, 1, '按背景关联编码筛选应命中');
    const byDecider = await req('GET', '/api/decisions?decided_by=' + encodeURIComponent('超级管理员'), { token });
    assert.equal(byDecider.body.total, 1, '按决策人筛选应命中');
    const pg = await req('GET', '/api/decisions?page=1&limit=1', { token });
    assert.equal(pg.body.data.length, 1, '分页 limit=1 应只返回 1 条');
    assert.equal(pg.body.total, 2, '分页 total 应为全量 2');
    assert.equal(pg.body.pages, 2, '分页页数应为 2');
    assert.deepEqual(pg.body.page_size_options, [10, 20, 50, 100, 200], '应下发可选每页条数');
    const bigLimit = await req('GET', '/api/decisions?limit=9999', { token });
    assert.equal(bigLimit.body.limit, 200, '每页条数应被上限 200 截断');

    assert.equal((await req('GET', '/api/decisions/999999', { token })).status, 404, '不存在的决策应 404');
    assert.equal((await req('PATCH', '/api/decisions/999999/conclusion', { token, body: { conclusion: 'x' } })).status, 404, '不存在决策的结论接口应 404');
    assert.equal((await req('POST', '/api/decisions/999999/execution-todos', { token, body: { title: 'x' } })).status, 404, '不存在决策派发执行项应 404');
    assert.equal((await req('POST', `/api/decisions/${id}/execution-todos`, { token, body: { todo_id: 999999 } })).status, 404, '不存在的执行项应 404');
    step('判定 筛选（关键字/状态/背景/决策人）、分页上限、404');

    // ===== 删除决策：解除关联、保留 F8 执行项事实 =====
    // 此时 D2 的执行项 t3 已被解除关联并转到 D1，故 D2 删除时 unlinked_todos 应为 0
    const delD2 = await req('DELETE', `/api/decisions/${d2id}`, { token });
    assert.equal(delD2.status, 200, '删除决策应成功：' + JSON.stringify(delD2.body));
    assert.equal(delD2.body.unlinked_todos, 0, 'D2 已无关联执行项，解除数应为 0');
    assert.equal((await req('GET', `/api/decisions/${d2id}`, { token })).status, 404, '删除后应 404');
    assert.equal((await req('GET', '/api/decisions/stats', { token })).body.total, 1, '删除后总数回到 1');
    const candDel = await req('GET', '/api/decisions/todo-candidates?unlinked=1', { token });
    assert.equal(candDel.body.data.length, 1, '解除关联的执行项仍在（F8 事实未被删除）');
    step('删除决策：记录消失、F8 执行项事实保留');

    // ===== 已决策不变量自检（读取侧兜底）=====
    // 说明：SqliteTable 的 _invalidate() 为无操作，进程内缓存即唯一真相源，
    // 外部进程写库不会影响服务端读到的数据，因此无法通过 HTTP 注入违规行；
    // 这里直接对路由同一函数做断言（路由接线由 scripts/decision-view-regression.test.js 静态断言覆盖）。
    assert.equal(rules.assertDecidedInvariant({ status: 'decided', conclusion: 'c', decided_by: 'u', decided_at: 't' }), null, '合规已决策记录应通过');
    assert.match(rules.assertDecidedInvariant({ status: 'decided', conclusion: 'c', decided_by: '', decided_at: 't' }), /决策人/, '缺决策人应被拦下');
    assert.match(rules.assertDecidedInvariant({ status: 'decided', conclusion: 'c', decided_by: 'u', decided_at: '' }), /决策时间/, '缺决策时间应被拦下');
    assert.match(rules.assertDecidedInvariant({ status: 'pending', conclusion: '', decided_by: '', decided_at: 't' }), /待决策/, '待决策带决策时间应被拦下');
    assert.match(rules.assertDecidedInvariant({ status: 'weird' }), /状态取值非法/, '非法状态应被拦下');
    step('判定 已决策不变量（路由读取前自检，同一函数）');

    // ===== 前端页面 =====
    const page = await fetch(BASE + '/decision.html');
    assert.equal(page.status, 200, '/decision.html 应可访问');
    const html = await page.text();
    assert.match(html, /data-page-perm="decision:view"/, '页面应受 decision:view 准入');
    assert.match(html, /data-page-title="Decision 视图"/, '页面标题应为 Decision 视图');
    step('前端页面可访问且受权限码准入');

    // ===== 删除带执行项的决策：解除关联而非删除执行项 =====
    detail = await req('GET', `/api/decisions/${id}`, { token });
    const linkedBefore = detail.body.execution.todos.length;
    assert.equal(linkedBefore, 2, '删除前 D1 有 2 条关联执行项');
    const delD1 = await req('DELETE', `/api/decisions/${id}`, { token });
    assert.equal(delD1.status, 200, '删除 D1 应成功：' + JSON.stringify(delD1.body));
    assert.equal(delD1.body.unlinked_todos, 2, '删除时应解除 2 条执行项的关联');
    assert.equal((await req('GET', `/api/decisions/${id}`, { token })).status, 404, '删除后 D1 应 404');
    assert.equal((await req('GET', '/api/decisions/stats', { token })).body.total, 0, '删除后决策总数为 0');
    const candFinal = await req('GET', '/api/decisions/todo-candidates?unlinked=1', { token });
    assert.equal(candFinal.body.data.length, 3, '3 条执行项均保留并回到候选（F8 事实未被删除）');
    step('删除带执行项的决策：解除关联、执行项事实完整保留');

    console.log('\nPAND-87 E2E 全部通过（真实 HTTP + 真实落库）：');
    results.forEach(r => console.log('  ✓ ' + r));
    console.log('\n共 ' + results.length + ' 项。');
  } finally {
    cleanup();
  }
}

main().catch(e => {
  console.error('\nE2E 失败：' + (e && e.stack || e));
  process.exitCode = 1;
});
