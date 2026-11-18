/**
 * 产销协调会（SOP）总报告生成器 —— 汇总各模块数据生成一份总的情况（Markdown）。
 *
 * 模块覆盖：PSI 产销存（计划 vs EDP 实际）、KPI 红黄绿、需求预测、会议、行动项闭环、预警、自检。
 */
const { getTable, now } = require('../db');

function esc(s) { return s === null || s === undefined ? '' : String(s); }
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
function pct(a, b) { return b > 0 ? Math.round((a / b) * 1000) / 10 + '%' : '—'; }

function generateSopFullReport(periodMonth) {
  const L = [];
  const push = (s) => L.push(s);

  // ===== PSI 产销存 =====
  const headers = getTable('psi_headers').all();
  const header = periodMonth
    ? headers.find((h) => h.period_month === periodMonth)
    : headers.slice().sort((a, b) => (b.period_month || '').localeCompare(a.period_month || ''))[0];
  const lines = header ? getTable('psi_lines').all().filter((l) => Number(l.header_id) === Number(header.id)) : [];
  const cur = lines.filter((l) => Number(l.month_offset) === 0);
  const withActual = cur.filter((l) => l.sales_actual !== undefined || l.production_actual !== undefined || l.inventory_actual !== undefined);
  const colorCount = { G: 0, Y: 0, R: 0 };
  cur.forEach((l) => { if (colorCount[l.color_status] !== undefined) colorCount[l.color_status]++; });
  let salesPlanTotal = 0, salesActualTotal = 0, prodPlanTotal = 0, prodActualTotal = 0;
  cur.forEach((l) => {
    salesPlanTotal += num(l.sales_plan); salesActualTotal += num(l.sales_actual);
    prodPlanTotal += num(l.production_plan); prodActualTotal += num(l.production_actual);
  });

  // ===== KPI =====
  const kpiAct = getTable('kpi_actuals').all();
  const kpiStd = getTable('kpi_standards').all();
  const stdMap = {}; kpiStd.forEach((s) => { stdMap[s.id] = s; });
  const kpiRows = kpiAct.map((r) => { const s = stdMap[r.kpi_id] || {}; return Object.assign({}, r, { kpi_code: r.kpi_code || s.kpi_code, kpi_name: s.kpi_name, category: s.category, target_value: s.target_value }); });
  const kpiPeriod = periodMonth || (kpiRows[0] && kpiRows[0].period_month) || '';
  const kpiCur = kpiPeriod ? kpiRows.filter((r) => r.period_month === kpiPeriod) : kpiRows;
  const red = kpiCur.filter((r) => r.status === 'R');
  const yellow = kpiCur.filter((r) => r.status === 'Y');
  const green = kpiCur.filter((r) => r.status === 'G');

  // ===== 需求预测 =====
  const forecasts = getTable('demand_forecasts').all();

  // ===== 会议 =====
  const meetings = getTable('sop_meetings').all();

  // ===== 行动项 =====
  const actions = getTable('sop_actions').all();
  const statusDist = {};
  actions.forEach((a) => { statusDist[a.status] = (statusDist[a.status] || 0) + 1; });
  const sourceDist = {};
  actions.forEach((a) => { const s = a.source_system || 'SOP'; sourceDist[s] = (sourceDist[s] || 0) + 1; });
  const today = now().slice(0, 10);
  const openActions = actions.filter((a) => a.status !== 'CLOSED' && a.status !== 'CANCELLED');
  const overdue = openActions.filter((a) => a.due_date && String(a.due_date) < today);
  const escalating = openActions.filter((a) => num(a.escalation_level) > 0);

  // ===== 预警 =====
  const alerts = getTable('alert_logs').all();
  const openAlerts = alerts.filter((a) => !a.is_resolved);
  const alertLevelDist = {};
  openAlerts.forEach((a) => { const lv = a.level || 'INFO'; alertLevelDist[lv] = (alertLevelDist[lv] || 0) + 1; });

  // ===== 自检 =====
  const selfChecks = getTable('self_check_records').all();

  // ================= 生成 Markdown =================
  const period = header ? header.period_month : (periodMonth || '');
  push('# 产销协调会总报告（S&OP 综合情况）');
  push('');
  push('- 报告期：' + esc(period) + (header ? '（' + esc(header.psi_code) + ' · ' + esc(header.sales_type || '') + '）' : ''));
  push('- 生成时间：' + esc(now()));
  push('- 数据来源：EDP 数据服务（订单/生产/库存实际）+ 会议助手（行动项）+ SOP 各模块台账');
  push('');
  push('---');

  // ===== 一、总览 =====
  push('\n## 一、总览');
  push('');
  push('| 模块 | 关键数字 |');
  push('|---|---|');
  push('| PSI 产销存 | 当期产品 ' + cur.length + ' 个；红 ' + colorCount.R + ' / 黄 ' + colorCount.Y + ' / 绿 ' + colorCount.G + '；已回填实际 ' + withActual.length + ' 个 |');
  push('| 销售达成 | 计划 ' + salesPlanTotal + ' vs 实际 ' + salesActualTotal + '（达成 ' + pct(salesActualTotal, salesPlanTotal) + '）|');
  push('| 生产达成 | 计划 ' + prodPlanTotal + ' vs 实际 ' + prodActualTotal + '（达成 ' + pct(prodActualTotal, prodPlanTotal) + '）|');
  push('| KPI 仪表盘 | 总 ' + kpiCur.length + ' 项：红 ' + red.length + ' / 黄 ' + yellow.length + ' / 绿 ' + green.length + ' |');
  push('| 行动项 | 总 ' + actions.length + ' 条；未闭环 ' + openActions.length + '；逾期 ' + overdue.length + '；升级督办 ' + escalating.length + ' |');
  push('| 会议 | ' + meetings.length + ' 场 |');
  push('| 预警 | 未处理 ' + openAlerts.length + ' 条 |');
  push('| 需求预测 | ' + forecasts.length + ' 条 |');
  push('| 自检记录 | ' + selfChecks.length + ' 条 |');

  // ===== 二、PSI 产销存 =====
  push('\n## 二、PSI 产销存（当期 计划 vs 实际）');
  push('');
  if (!header) {
    push('（未找到 PSI 头表，请先在产销协调会创建 PSI）');
  } else {
    push('| 产品 | 销售计划 | 销售实际 | 生产计划 | 生产实际 | 期初 | 期末库存 | 安全库存 | 红黄绿 |');
    push('|---|---|---|---|---|---|---|---|---|');
    cur.forEach((l) => {
      push('| ' + esc(l.product_code) + ' | ' + num(l.sales_plan) + ' | ' + (l.sales_actual !== undefined ? num(l.sales_actual) : '—') +
        ' | ' + num(l.production_plan) + ' | ' + (l.production_actual !== undefined ? num(l.production_actual) : '—') +
        ' | ' + num(l.inventory_begin) + ' | ' + (l.inventory_actual !== undefined ? num(l.inventory_actual) : num(l.inventory_end)) +
        ' | ' + num(l.safety_stock) + ' | ' + (l.color_status || '—') + ' |');
    });
    push('');
    push('> 红黄绿口径：期末（实际优先）< 安全库存 = 红；< 安全库存×1.2 = 黄；其余 = 绿。计划值不被实际覆盖。');
    if (withActual.length < cur.length) {
      push('> ⚠️ ' + (cur.length - withActual.length) + ' 个产品暂无 EDP 实际数据（EDP 订单源数据缺 product_code 或无匹配编码）');
    }
  }

  // ===== 三、KPI 仪表盘 =====
  push('\n## 三、KPI 仪表盘（' + esc(kpiPeriod) + '）');
  push('');
  push('红 ' + red.length + ' / 黄 ' + yellow.length + ' / 绿 ' + green.length + '（共 ' + kpiCur.length + ' 项）');
  if (red.length) {
    push('');
    push('**红灯明细：**');
    push('');
    push('| KPI | 名称 | 实际 | 目标 |');
    push('|---|---|---|---|');
    red.forEach((r2) => push('| ' + esc(r2.kpi_code) + ' | ' + esc(r2.kpi_name) + ' | ' + esc(r2.actual_value) + ' | ' + esc(r2.target_value) + ' |'));
  }

  // ===== 四、需求与供应 =====
  push('\n## 四、需求预测');
  push('');
  if (forecasts.length) {
    push('| 产品 | 期间 | 预测量 | 类型 | 方法 |');
    push('|---|---|---|---|---|');
    forecasts.slice(0, 20).forEach((f) => push('| ' + esc(f.product_code) + ' | ' + esc(f.period_month) + ' | ' + esc(f.forecast_qty) + ' | ' + esc(f.forecast_type) + ' | ' + esc(f.method) + ' |'));
    if (forecasts.length > 20) push('| …（其余 ' + (forecasts.length - 20) + ' 条略）| | | | |');
  } else {
    push('（暂无需求预测数据）');
  }

  // ===== 五、会议与决议 =====
  push('\n## 五、会议');
  push('');
  if (meetings.length) {
    push('| 会议编号 | 类型 | 日期 | 标题 | 状态 |');
    push('|---|---|---|---|---|');
    meetings.slice(0, 20).forEach((m) => push('| ' + esc(m.meeting_code) + ' | ' + esc(m.meeting_type) + ' | ' + esc((m.meeting_date || '').slice(0, 10)) + ' | ' + esc(m.title) + ' | ' + esc(m.status) + ' |'));
  } else {
    push('（暂无会议记录）');
  }

  // ===== 六、行动项闭环 =====
  push('\n## 六、行动项闭环');
  push('');
  push('- 总数：**' + actions.length + '** 条');
  push('- 状态分布：' + Object.entries(statusDist).map(([k, v]) => k + '=' + v).join('，'));
  push('- 来源分布：' + Object.entries(sourceDist).map(([k, v]) => k + '=' + v).join('，') + '（会议助手 = EDP meeting-assistant-actions 同步）');
  push('- 未闭环：' + openActions.length + ' 条，其中**逾期 ' + overdue.length + ' 条**、升级督办 ' + escalating.length + ' 条');
  if (overdue.length) {
    push('');
    push('**逾期 Top 10：**');
    push('');
    push('| 行动编号 | 内容 | 责任人 | 应完成 | 状态 |');
    push('|---|---|---|---|---|');
    overdue.slice(0, 10).forEach((a) => push('| ' + esc(a.action_code) + ' | ' + esc((a.description || '').slice(0, 40)) + ' | ' + esc(a.owner_name) + ' | ' + esc(a.due_date) + ' | ' + esc(a.status) + ' |'));
  }

  // ===== 七、预警 =====
  push('\n## 七、预警');
  push('');
  if (openAlerts.length) {
    push('未处理预警 ' + openAlerts.length + ' 条：' + Object.entries(alertLevelDist).map(([k, v]) => k + '=' + v).join('，'));
    push('');
    push('| 级别 | 内容 | 时间 |');
    push('|---|---|---|');
    openAlerts.slice(0, 10).forEach((a) => push('| ' + esc(a.level) + ' | ' + esc((a.message || '').slice(0, 60)) + ' | ' + esc((a.triggered_at || '').slice(0, 16)) + ' |'));
  } else {
    push('（当前无未处理预警）');
  }

  // ===== 八、自检 =====
  push('\n## 八、自检记录');
  push('');
  push('自检记录 ' + selfChecks.length + ' 条' + (selfChecks.length ? '（最近：' + esc((selfChecks[selfChecks.length - 1] || {}).created_at || '') + '）' : '') + '。');

  push('');
  push('---');
  push('');
  push('*本报告由 EBMS 产销协调会模块自动汇总生成 · ' + esc(now()) + '*');

  return L.join('\n');
}

module.exports = { generateSopFullReport };
