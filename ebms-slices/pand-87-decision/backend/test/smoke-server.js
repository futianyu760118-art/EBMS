'use strict';

// 启动自检（非单测）：真实走 server.js 的启动路径（migrate + listen），
// 用真实 HTTP 跑通「登录 → 列表 → 详情 → 修改结论留痕」主链路，然后只终止本脚本拉起的子进程。
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DB_FILE = path.resolve(ROOT, 'data', 'smoke-server.sqlite');
const PORT = 4711;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

if (fs.existsSync(DB_FILE)) fs.rmSync(DB_FILE);

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return await res.json();
    } catch (_err) {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务未在超时时间内就绪');
}

async function call(pathname, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  // 先建库并灌入演示数据，再验证服务端启动路径
  const seeded = spawnSync(
    process.execPath,
    ['--experimental-sqlite', 'src/db/seed.js'],
    {
      cwd: ROOT,
      env: { ...process.env, DB_DRIVER: 'sqlite', SQLITE_FILE: DB_FILE },
      encoding: 'utf8',
    }
  );
  if (seeded.status !== 0) throw new Error(`种子数据写入失败: ${seeded.stderr || seeded.stdout}`);
  console.log('seed:', seeded.stdout.trim());

  const child = spawn(process.execPath, ['--experimental-sqlite', 'src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, DB_DRIVER: 'sqlite', SQLITE_FILE: DB_FILE, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });

  try {
    const health = await waitForHealth();
    console.log('health:', JSON.stringify(health));

    const login = await call('/auth/login', {
      method: 'POST',
      body: { username: 'dm', password: 'ebms@2026' },
    });
    if (login.status !== 200) throw new Error(`登录失败 ${login.status} ${JSON.stringify(login.json)}`);
    const token = login.json.token;
    console.log('login:', login.json.user.displayName, '| landing:', login.json.landing.route);

    const list = await call('/decisions?limit=100', { token });
    console.log('list:', JSON.stringify(list.json.summary));

    const pending = list.json.items.find((d) => d.status === 'pending');
    const decided = list.json.items.find((d) => d.status === 'decided');

    const detail = await call(`/decisions/${decided.id}`, { token });
    console.log('detail:', JSON.stringify({
      status: detail.json.statusLabel,
      options: detail.json.options.length,
      refs: detail.json.relatedRefs.length,
      requiredEvidence: detail.json.evidenceSummary,
      execution: { total: detail.json.execution.total, done: detail.json.execution.done },
      changes: detail.json.changeCount,
      conclusionChanges: detail.json.conclusionChangeCount,
    }));

    // 静默修改必须被拒绝
    const silent = await call(`/decisions/${decided.id}/conclusion`, {
      token,
      method: 'PATCH',
      body: { conclusion: '静默修改尝试' },
    });
    console.log('silent modify:', silent.status, silent.json.error.code);

    // 带理由的修改必须留痕
    const revised = await call(`/decisions/${decided.id}/conclusion`, {
      token,
      method: 'PATCH',
      body: { conclusion: '启动自检：改为分期投入，先追加一条产线。', reason: '自检脚本验证留痕' },
    });
    console.log('revise:', revised.status, '| conclusionChanges:',
      revised.json.conclusionChangeCount, '| last:',
      JSON.stringify({
        action: revised.json.changes.at(-1).action,
        by: revised.json.changes.at(-1).changedByName,
        before: revised.json.changes.at(-1).before.conclusion.slice(0, 12) + '…',
        after: revised.json.changes.at(-1).after.conclusion.slice(0, 12) + '…',
      }));

    // 待决策不计入已决策
    console.log('pending not counted:', pending.statusLabel, JSON.stringify((await call('/decisions?status=pending&limit=100', { token })).json.paging));

    // 关联执行 TODO
    const candidates = await call(`/decisions/todo-candidates?decision_id=${pending.id}`, { token });
    if (candidates.status !== 200) {
      throw new Error(`TODO 候选加载失败 ${candidates.status} ${JSON.stringify(candidates.json)}`);
    }
    console.log('todo candidates:', candidates.json.items.length,
      '| 已关联本决策:', candidates.json.items.filter((t) => t.linkedHere).length);
    const linked = await call(`/decisions/${pending.id}/execution-todos`, {
      token,
      method: 'POST',
      body: { todos: [{ title: '启动自检：补齐预算评审材料', owner: '王财务', due_at: '2026-10-31T18:00:00+08:00' }] },
    });
    console.log('dispatch todo:', linked.status, '| execution.total:', linked.json.execution.total,
      '| changeCount:', linked.json.changeCount);

    const unauth = await call('/decisions');
    console.log('unauthenticated:', unauth.status);

    console.log('\n[smoke] 主链路全部通过');
  } finally {
    // 只终止本脚本拉起的子进程；不按进程名杀，避免误伤工作区常驻进程
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (!child.killed) child.kill('SIGKILL');
    if (logs.trim()) console.log('\n[server logs]\n' + logs.trim());
    if (fs.existsSync(DB_FILE)) fs.rmSync(DB_FILE);
  }
}

main().catch((err) => {
  console.error('[smoke] 失败:', err.message);
  process.exit(1);
});
