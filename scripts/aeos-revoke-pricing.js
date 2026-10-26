/**
 * PAND-309 R3：切流后收回 EBMS 侧「核价写询价」路径。
 *
 * 决策（读法 A：CRM 为销售中心唯一主写侧）：
 *   - 从所有非 admin 角色移除 `inquiry:price`，核价/报价在 CRM 完成；
 *   - 保留 admin 角色，仅作应急与回滚通道（与 PAND-307 权限收敛口径一致）。
 *
 * 每执行一次都会写出回滚清单（被删除的 role_permissions 行），可用 --restore 还原。
 * 幂等：重复执行时 changes 为空。
 *
 * 用法（在 EBMS 后端目录或容器内执行）：
 *   node scripts/aeos-revoke-pricing.js --out /app/database/backups/inquiry-price-rollback.json
 *   node scripts/aeos-revoke-pricing.js --restore /app/database/backups/inquiry-price-rollback.json
 */
const fs = require('fs');
const path = require('path');

function tables() {
  // 延迟 require：DB 引擎（sqlite/json）在 db.js 初始化时确定
  const db = require(path.join(__dirname, '..', 'backend', 'db'));
  return {
    permissions: db.getTable('permissions'),
    roles: db.getTable('roles'),
    rolePerms: db.getTable('role_permissions')
  };
}

function findByCode(code) {
  const t = tables();
  const perm = t.permissions.all().find(p => p.code === code);
  if (!perm) throw new Error(`未找到权限 ${code}`);
  return { t, perm };
}

function adminRoleIds(roles) {
  return new Set(roles.filter(r => r.code === 'admin' || Number(r.id) === 1).map(r => Number(r.id)));
}

function revoke(outFile) {
  const { t, perm } = findByCode('inquiry:price');
  const roles = t.roles.all();
  const admins = adminRoleIds(roles);
  const roleName = id => (roles.find(r => Number(r.id) === Number(id)) || {}).name || String(id);

  const removed = [];
  for (const row of t.rolePerms.all()) {
    if (Number(row.permission_id) !== Number(perm.id)) continue;
    if (admins.has(Number(row.role_id))) continue;
    removed.push(row);
    t.rolePerms.delete(row.id);
  }

  const payload = {
    generated_at: new Date().toISOString(),
    permission: { id: perm.id, code: perm.code, name: perm.name },
    kept_admin_role_ids: [...admins],
    removed: removed.map(r => ({ id: r.id, role_id: r.role_id, role_name: roleName(r.role_id), permission_id: r.permission_id })),
    restore_hint: 'node scripts/aeos-revoke-pricing.js --restore <this-file>'
  };
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  }
  return { removed: removed.length, roles: [...new Set(removed.map(r => roleName(r.role_id)))], out: outFile || null };
}

function restore(file) {
  const { t } = findByCode('inquiry:price');
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const existing = new Set(t.rolePerms.all().map(r => `${r.role_id}:${r.permission_id}`));
  let restored = 0;
  for (const row of payload.removed || []) {
    if (existing.has(`${row.role_id}:${row.permission_id}`)) continue;
    t.rolePerms.insert({
      role_id: row.role_id,
      permission_id: row.permission_id,
      granted_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
    });
    restored++;
  }
  return { restored };
}

function main() {
  const args = process.argv.slice(2);
  const restoreIdx = args.indexOf('--restore');
  if (restoreIdx >= 0) {
    const file = args[restoreIdx + 1];
    if (!file) throw new Error('--restore 需要文件路径');
    console.log(JSON.stringify(restore(file), null, 2));
    return;
  }
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : null;
  console.log(JSON.stringify(revoke(out), null, 2));
}

if (require.main === module) main();

module.exports = { revoke, restore };
