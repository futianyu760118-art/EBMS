/**
 * 用 EDP 落库数据更新产销协调会（SOP）—— PSI 实际值 + 会议行动项。
 *
 * 数据源：edp_dataset_row（已由 /api/v1/edp/datasets/{code}/sync 同步落库）：
 *   ads-order-list            → PSI 销售实际（按产品+月份聚合订单量）
 *   ads-production-task-view  → PSI 生产实际（按物料+月份聚合任务量）
 *   ads-inventory-view        → PSI 库存实际（按物料聚合在手量，重算红黄绿）
 *   meeting-assistant-actions → sop_actions（会议助手行动项 upsert，source_system=会议助手）
 *
 * 计划/实际分离（FAC_GRAND GR-15 同源原则）：只写 *_actual 字段，不覆盖 sales_plan/production_plan 计划值。
 */
const { getTable, now } = require('../db');

function edpRows(code) {
  return getTable('edp_dataset_row').all()
    .filter((r) => r.dataset_code === code)
    .map((r) => {
      let payload = r.payload;
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch (e) { payload = {}; }
      }
      return { row_pk: r.row_pk, payload: payload || {} };
    });
}

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }

function monthOf(dateStr) { return String(dateStr || '').slice(0, 7); }

// 编码匹配：忽略 ERP 层级前缀（2.3.1. 等），双向包含即视为同一物料
function codeMatches(psiCode, edpCode) {
  if (!psiCode || !edpCode) return false;
  const strip = (s) => String(s).replace(/^\d+(\.\d+)*\./, '').trim();
  const a = strip(psiCode);
  const b = strip(edpCode);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

// ===== 1. PSI 实际值更新 =====
async function syncPsiFromEdp(periodMonth) {
  const headers = getTable('psi_headers').all();
  const header = periodMonth
    ? headers.find((h) => h.period_month === periodMonth)
    : headers.slice().sort((a, b) => (b.period_month || '').localeCompare(a.period_month || ''))[0];
  if (!header) return { ok: false, error: '未找到 PSI 头表（请先在产销协调会创建 PSI）' };

  // 聚合 EDP 订单 → 销售实际
  const salesByCode = {};
  edpRows('ads-order-list').forEach((r) => {
    const p = r.payload || {};
    const pc = p.product_code || '';
    const m = monthOf(p.order_date);
    const qty = num(p.order_qty);
    if (!pc || !m || !qty) return;
    salesByCode[pc] = salesByCode[pc] || {};
    salesByCode[pc][m] = (salesByCode[pc][m] || 0) + qty;
  });

  // 聚合 EDP 生产任务 → 生产实际
  const prodByCode = {};
  edpRows('ads-production-task-view').forEach((r) => {
    const p = r.payload || {};
    const mc = p.material_code || '';
    const m = monthOf(p.planned_start_date || p.actual_start_date);
    const qty = num(p.task_qty) || num(p.actual_qty);
    if (!mc || !m || !qty) return;
    prodByCode[mc] = prodByCode[mc] || {};
    prodByCode[mc][m] = (prodByCode[mc][m] || 0) + qty;
  });

  // 聚合 EDP 库存 → 库存实际（在手量）
  const invByCode = {};
  edpRows('ads-inventory-view').forEach((r) => {
    const p = r.payload || {};
    const mc = p.material_code || '';
    if (!mc) return;
    invByCode[mc] = (invByCode[mc] || 0) + num(p.qty_on_hand);
  });

  // 更新当期（month_offset=0）PSI 行
  const lineT = getTable('psi_lines');
  const lines = lineT.all().filter((l) => Number(l.header_id) === Number(header.id) && Number(l.month_offset) === 0);
  const matched = [];
  let updated = 0;
  for (const line of lines) {
    const pc = line.product_code;
    let salesActual = null, prodActual = null, invActual = null;
    for (const [code, byMonth] of Object.entries(salesByCode)) {
      if (codeMatches(pc, code) && byMonth[header.period_month] !== undefined) { salesActual = byMonth[header.period_month]; break; }
    }
    for (const [code, byMonth] of Object.entries(prodByCode)) {
      if (codeMatches(pc, code) && byMonth[header.period_month] !== undefined) { prodActual = byMonth[header.period_month]; break; }
    }
    for (const [code, v] of Object.entries(invByCode)) {
      if (codeMatches(pc, code)) { invActual = v; break; }
    }

    if (salesActual === null && prodActual === null && invActual === null) {
      matched.push({ product_code: pc, matched: false });
      continue;
    }
    const upd = { updated_at: now() };
    if (salesActual !== null) upd.sales_actual = salesActual;
    if (prodActual !== null) upd.production_actual = prodActual;
    if (invActual !== null) {
      upd.inventory_actual = invActual;
      const ss = num(line.safety_stock);
      upd.color_status = invActual < ss ? 'R' : (invActual < ss * 1.2 ? 'Y' : 'G');
    }
    await lineT.update(line.id, upd);
    updated++;
    matched.push({ product_code: pc, matched: true, sales_actual: salesActual, production_actual: prodActual, inventory_actual: invActual });
  }

  return { ok: true, psi_code: header.psi_code, period: header.period_month, lines: lines.length, updated, unmatched: matched.filter((m) => !m.matched).length, details: matched };
}

// ===== 2. 会议助手行动项 → sop_actions =====
// 计算 N 个月前的日期（YYYY-MM-DD，北京时间）
function monthsAgoDate(months) {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/**
 * 会议助手行动项 → sop_actions。
 * opts.months_back：只同步近 N 个月（按 due_date/created_at）的行动项；默认 2 个月，2 个月以前不拉取。
 * opts.cutoff_date：直接指定截止日（YYYY-MM-DD），优先于 months_back。
 */
async function syncActionsFromEdp(opts) {
  const o = opts || {};
  const startDate = o.start_date || '';
  const endDate = o.end_date || '';
  const cutoff = o.cutoff_date || (o.months_back === 0 ? '' : monthsAgoDate(o.months_back === undefined ? 2 : o.months_back));
  const allRows = edpRows('meeting-assistant-actions');
  // 时间过滤（开始/结束都可选）：无日期保留；指定 start/end 时按区间过滤；否则按 cutoff（默认近 2 个月）
  const rows = allRows.filter((r) => {
    const p = r.payload || {};
    const d = String(p.due_date || p.created_at || p.occurred_at || '').slice(0, 10);
    if (!d) return true;
    if (startDate && d < startDate) return false;
    if (endDate && d > endDate) return false;
    if (!startDate && !endDate && cutoff && d < cutoff) return false;
    return true;
  });
  const actT = getTable('sop_actions');
  const statusMap = { done: 'CLOSED', in_progress: 'IN_PROGRESS', todo: 'PENDING', pending: 'PENDING' };
  let created = 0, updated = 0, skipped = 0;
  for (const r of rows) {
    const p = r.payload || {};
    const srcId = p.id || p.source_id || r.row_pk;
    if (!srcId) { skipped++; continue; }
    const actionCode = 'ACT-EDP-' + String(srcId);
    const exist = actT.all().find((a) => a.action_code === actionCode);
    const newStatus = statusMap[p.status] || null;
    if (exist) {
      if (newStatus && newStatus !== exist.status) {
        await actT.update(exist.id, { status: newStatus, updated_at: now() });
        updated++;
      } else skipped++;
    } else {
      await actT.insert({
        action_code: actionCode,
        meeting_id: null,
        issue_no: '',
        description: p.theme || p.proposal || ('会议助手行动项 ' + srcId),
        owner_name: p.owner || '',
        owner_role: '',
        due_date: p.due_date || '',
        priority: p.priority === 'high' ? 'P1' : (p.priority === 'medium' ? 'P2' : 'P3'),
        status: newStatus || 'PENDING',
        escalation_level: 0,
        source_system: '会议助手',
        created_at: now(),
        updated_at: now()
      });
      created++;
    }
  }
  return { ok: true, start_date: startDate || null, end_date: endDate || null, cutoff: cutoff || null, source_rows: allRows.length, in_range_rows: rows.length, skipped_old: allRows.length - rows.length, created, updated, skipped };
}

module.exports = { syncPsiFromEdp, syncActionsFromEdp, monthsAgoDate };
module.exports.syncMeetingsFromEdp = syncMeetingsFromEdp;

// ===== 会议助手会议 → sop_meetings（EDP meeting-assistant-meetings，含 organizer/date/participants）=====
async function syncMeetingsFromEdp(opts) {
  const o = opts || {};
  const rows = edpRows('meeting-assistant-meetings');
  const t = getTable('sop_meetings');
  let created = 0, updated = 0, skipped = 0;
  for (const r of rows) {
    const p = r.payload || {};
    const a = p.attributes || p;
    const srcId = a.id || p.source_id || r.row_pk;
    if (!srcId) { skipped++; continue; }
    const code = 'EDP-MTG-' + String(srcId);
    const exist = t.all().find((m) => m.meeting_code === code);
    const rec = {
      meeting_code: code,
      meeting_type: a.type || 'REVIEW',
      meeting_date: String(a.meeting_date || a.created_at || '').slice(0, 10),
      status: (a.status === 'finished' || a.status === 'closed') ? 'CLOSED' : 'SCHEDULED',
      title: a.title || ('会议 ' + srcId),
      organizer: a.organizer || '',
      participants: Array.isArray(a.participants) ? a.participants : [],
      department: a.department || '',
      source_system: '会议助手'
    };
    if (exist) { await t.update(exist.id, rec); updated++; }
    else { await t.insert(Object.assign({}, rec, { created_at: now() })); created++; }
  }
  return { ok: true, source_rows: rows.length, created, updated, skipped };
}
