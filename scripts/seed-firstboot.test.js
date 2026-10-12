/**
 * 全新库首启播种回归（PAND-183 / PAND-87）。
 *
 * 背景：initData 是顶层同步代码，而 db 的每表写锁曾把写操作一律排到事件循环微任务，
 * 于是「写完 roles/permissions 后紧接着读回」只能取到空表 —— 角色权限关联整段落不下去，
 * 全新库首启 role_permissions=0、decision_maker 无 m03:view.decision-maker，入口 403，
 * 须重启一次（表从磁盘载入）才自愈。本脚本锁住「首启即收敛」这一不变量。
 *
 * 用法：node scripts/seed-firstboot.test.js
 * 实现：把 backend 复制到临时目录后用空 database/ 跑两次 initData（每次都只探测自己拉起的
 *      子进程），比对两次结果是否一致。不触碰仓库运行时的 database/。
 * 说明：数据层断言（授权是否落库）已覆盖 403 的成因；HTTP 入口断言需 express，见 PAND-183 自检记录。
 */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');

// 尽量在 Windows 盘符（fs.rename/rmSync 更稳）与外层 os.tmpdir() 之间取一个可用目录
const BASE_TMP = fs.existsSync(os.tmpdir()) ? os.tmpdir() : ROOT;
const TMP = fs.mkdtempSync(path.join(BASE_TMP, 'ebms-seed-firstboot-'));
const SANDBOX = path.join(TMP, 'sandbox');

const PROBE = `
const { getTable } = require('./backend/db');
require('./backend/initData');
setImmediate(() => {
  const roles = getTable('roles').all();
  const perms = getTable('permissions').all();
  const rp = getTable('role_permissions').all();
  const permById = new Map(perms.map(p => [Number(p.id), p]));
  const codesOf = (role) => rp
    .filter(x => Number(x.role_id) === Number(role.id))
    .map(x => { const p = permById.get(Number(x.permission_id)); return p ? p.code : '?' + x.permission_id; })
    .sort();
  const dm = roles.find(r => r.code === 'decision_maker');
  const admin = roles.find(r => r.code === 'admin');
  const pairs = rp.map(x => Number(x.role_id) + ':' + Number(x.permission_id));
  console.log('__RESULT__' + JSON.stringify({
    roles: roles.length,
    permissions: perms.length,
    role_permissions: rp.length,
    unique_pairs: new Set(pairs).size,
    decision_maker: !!dm,
    dm_perms: dm ? codesOf(dm) : [],
    admin_perm_count: admin ? codesOf(admin).length : -1,
    by_role: roles.map(r => r.code + '=' + codesOf(r).join(',')).sort()
  }));
});
`;

function copyBackend() {
  fs.cpSync(BACKEND, path.join(SANDBOX, 'backend'), {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== 'node_modules' && base !== 'database';
    }
  });
  // 空运行时数据目录（db.js 取 backend 的上一级 database/）
  fs.mkdirSync(path.join(SANDBOX, 'database'), { recursive: true });
  fs.writeFileSync(path.join(SANDBOX, 'probe.js'), PROBE, 'utf8');
}

function boot(label) {
  const r = spawnSync(process.execPath, ['probe.js'], {
    cwd: SANDBOX,
    env: Object.assign({}, process.env, { NODE_ENV: 'development' }),
    encoding: 'utf8'
  });
  const line = (r.stdout || '').split('\n').find(l => l.includes('__RESULT__'));
  assert.ok(line, `[${label}] 未取到播种结果，stderr:\n${r.stderr}\nstdout:\n${r.stdout}`);
  return JSON.parse(line.slice(line.indexOf('__RESULT__') + '__RESULT__'.length));
}

function assertConverged(snap, label) {
  assert.ok(snap.role_permissions > 0,
    `[${label}] role_permissions=0：角色权限关联未落库（首启播种顺序缺陷复发）`);
  assert.equal(snap.role_permissions, snap.unique_pairs,
    `[${label}] 存在重复角色权限行`);
  assert.ok(snap.decision_maker, `[${label}] decision_maker 角色缺失`);
  assert.ok(snap.dm_perms.includes('m03:view.decision-maker'),
    `[${label}] decision_maker 缺 m03:view.decision-maker（入口将被 403 NO_EBMS_ACCESS）`);
  assert.ok(snap.dm_perms.includes('m03:access'),
    `[${label}] decision_maker 缺 m03:access`);
  assert.equal(snap.admin_perm_count, snap.permissions,
    `[${label}] admin 未拥有全部权限`);
}

function main() {
  try {
    copyBackend();
    const first = boot('首启');
    assertConverged(first, '首启');

    const second = boot('重启');
    assertConverged(second, '重启');
    assert.deepEqual(second.by_role, first.by_role,
      '重启后各角色权限集发生变化（播种非幂等）');
    assert.equal(second.role_permissions, first.role_permissions, '重启后 role_permissions 数变化');

    console.log('seed first-boot regression checks passed'
      + `（首启 role_permissions=${first.role_permissions}，重启后一致）`);
  } finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }
}

main();
