/**
 * 月度经营总报告生成器 —— 从系统结构化数据生成完整 Markdown 总报告。
 *
 * 结构对齐《月度经营报告（完整版）》：
 *   驾驶舱（一句话/核心指标/瓶颈/12部门红黄绿/持续项）
 *   → 一 经营结果（销售/财务） 二 交付链（研发/计划/采购/仓储）
 *   → 三 制造与质量（车间/品质） 四 支撑体系（信息化/人事行政）
 *   → 五 决议与履约（打X + 持续项） 六 问题诊断 七 决策清单 八 附录（数据来源与口径）
 */
const { getTable } = require('../db');

const CHAPTER_OF = {
  '销售': 1, '财务': 1,
  '研发': 2, '计划': 2, '采购': 2, '仓库': 2,
  '装配车间': 3, '光电车间': 3, '前道车间': 3, '品质工程': 3,
  '信息化': 4, '人事行政': 4
};
const CHAPTER_TITLE = { 1: '一、经营结果', 2: '二、交付链', 3: '三、制造与质量', 4: '四、支撑体系' };

function esc(s) { return s === null || s === undefined ? '' : String(s); }
function bySort(rows) { return (rows || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)); }

function reportRows(reportId) {
  const id = Number(reportId);
  const pick = (t) => getTable(t).all().filter((x) => Number(x.report_id) === id);
  return {
    report: getTable('monthly_reports').findById(reportId),
    indicators: pick('monthly_indicators'),
    dept_summary: pick('monthly_dept_summary'),
    actions: pick('monthly_actions'),
    issues: pick('monthly_issues'),
    decisions: pick('monthly_decisions'),
    dept_narrative: pick('monthly_dept_narrative'),
    continuous_items: pick('monthly_continuous_items'),
    data_sources: pick('monthly_data_sources')
  };
}

function statusBadge(v) {
  return { green: '🟢', yellow: '🟡', red: '🔴', gray: '⚪' }[v] || '⚪';
}

function generateFullReport(reportId) {
  const d = reportRows(reportId);
  if (!d.report) return null;
  const r = d.report;
  const core = bySort(d.indicators.filter((i) => i.category === 'core'));
  const bottle = bySort(d.indicators.filter((i) => i.category === 'bottleneck'));
  const depts = bySort(d.dept_summary);
  const narr = bySort(d.dept_narrative);
  const cont = bySort(d.continuous_items);
  const actions = bySort(d.actions);
  const issues = bySort(d.issues);
  const decisions = bySort(d.decisions);
  const sources = bySort(d.data_sources.filter((x) => x.name !== '口径说明'));
  const calibers = bySort(d.data_sources.filter((x) => x.name === '口径说明'));

  const L = [];
  const push = (s) => L.push(s);
  const h1 = (s) => push('\n## ' + s);
  const h2 = (s) => push('\n### ' + s);

  // ===== 头部 =====
  push('# ' + esc(r.title || (r.period + ' 月度经营报告')) + '（总报告）');
  push('');
  push('- 报告日期：' + esc(r.report_date || ''));
  push('- 数据期间：' + esc(r.period));
  push('- 编制：' + esc(r.prepared_by || '') + ' · 覆盖：' + depts.length + ' 个部门 · ' + d.indicators.length + ' 项指标');
  push('- 生成方式：EBMS 系统数据一键生成（结构化台账 + 部门叙事 + 持续项 + 口径）');
  push('');
  push('---');

  // ===== 目录 =====
  push('\n## 目录');
  push('1. 经营驾驶舱');
  CHAPTER_TITLE && [1, 2, 3, 4].forEach((c) => push((c + 1) + '. ' + CHAPTER_TITLE[c]));
  push('6. 五、决议与履约');
  push('7. 六、问题诊断');
  push('8. 七、决策清单');
  push('9. 八、附录（数据来源与口径）');

  // ===== 驾驶舱 =====
  h1('经营驾驶舱');
  h2('本月一句话');
  push(esc(r.summary || '（未填写）'));
  h2('核心指标（经营结果四项）');
  push('| 指标 | 实际 | 目标 | 状态 | 说明 |');
  push('|---|---|---|---|---|');
  core.forEach((k) => push('| ' + esc(k.name) + ' | ' + esc(k.actual) + ' | ' + esc(k.target) + ' | ' + statusBadge(k.status) + ' | ' + esc(k.note) + ' |'));
  h2('关键瓶颈（四项）');
  push('| 指标 | 实际 | 目标 | 状态 | 说明 |');
  push('|---|---|---|---|---|');
  bottle.forEach((k) => push('| ' + esc(k.name) + ' | ' + esc(k.actual) + ' | ' + esc(k.target) + ' | ' + statusBadge(k.status) + ' | ' + esc(k.note) + ' |'));
  h2('12 部门红黄绿');
  push('> 绿=达标，黄=承压/改善中，红=未达标，灰=数据未填报');
  push('');
  push('| 部门 | 指标数 | 达标 | 未达标/承压 | 判断 |');
  push('|---|---|---|---|---|');
  depts.forEach((dpt) => push('| ' + esc(dpt.department) + ' | ' + esc(dpt.indicator_count) + ' | ' + esc(dpt.achieved) + ' | ' + esc(dpt.not_achieved) + ' | ' + statusBadge(dpt.judgment) + ' |'));

  // ===== 四大章（部门叙事）=====
  for (const c of [1, 2, 3, 4]) {
    const rows = narr.filter((n) => CHAPTER_OF[n.department] === c);
    if (!rows.length) continue;
    h1(CHAPTER_TITLE[c]);
    rows.forEach((n) => {
      h2(esc(n.department) + (n.owner ? '（' + esc(n.owner) + '）' : ''));
      if (n.indicator_status) push('- **指标达成**：' + esc(n.indicator_status));
      if (n.reason) push('- **未达标原因**：' + esc(n.reason));
      if (n.impact) push('- **对下游影响**：' + esc(n.impact));
      if (n.next_action) push('- **下月动作**：' + esc(n.next_action));
      if (n.coordination) push('- **需公司协调**：' + esc(n.coordination));
    });
  }

  // ===== 五、决议与履约 =====
  h1('五、决议与履约');
  h2('决议履约（' + actions.length + ' 项）');
  push('| No. | 项目内容 | 责任人 | 原节点 | 新节点 | 状态 |');
  push('|---|---|---|---|---|---|');
  actions.forEach((a) => push('| ' + esc(a.seq) + ' | ' + esc(a.content) + ' | ' + esc(a.owner) + ' | ' + esc(a.due_date) + ' | ' + esc(a.new_due_date) + ' | ' + esc(a.status) + ' |'));
  h2('持续项与自动取数');
  push('| 项目 | 结果 | 趋势 | 明细 | 说明 | 取数方式 |');
  push('|---|---|---|---|---|---|');
  const trendText = { up: '↑改善', down: '↓恶化', flat: '持平' };
  cont.forEach((c) => push('| ' + esc(c.name) + ' | ' + esc(c.value) + ' | ' + (trendText[c.trend] || '—') + ' | ' + esc(c.detail) + ' | ' + esc(c.note) + ' | ' + esc(c.auto) + ' |'));

  // ===== 六、问题诊断 =====
  h1('六、问题诊断');
  issues.forEach((x) => {
    h2(esc(x.level) + ' ' + esc(x.title) + '｜' + esc(x.owner) + '｜' + esc(x.deadline));
    if (x.problem) push('- **问题**：' + esc(x.problem));
    if (x.actions) push('- **关键动作**：' + esc(x.actions));
  });

  // ===== 七、决策清单 =====
  h1('七、决策清单（' + decisions.length + ' 项）');
  decisions.forEach((dc, idx) => {
    h2((idx + 1) + '. ' + esc(dc.level) + ' ' + esc(dc.title) + '｜' + esc(dc.owner) + '｜' + esc(dc.deadline));
    if (dc.problem) push('- **问题**：' + esc(dc.problem));
    if (dc.action) push('- **拍什么**：' + esc(dc.action));
  });

  // ===== 八、附录 =====
  h1('八、附录');
  h2('数据来源');
  push('| 数据源 | 地址 | 取数范围 | 状态 |');
  push('|---|---|---|---|');
  sources.forEach((s) => push('| ' + esc(s.name) + ' | ' + esc(s.address) + ' | ' + esc(s.range) + ' | ' + esc(s.status) + ' |'));
  h2('口径说明');
  calibers.forEach((c) => push('- ' + esc(c.note)));
  push('');
  push('---');
  push('');
  push('*本报告由 EBMS 系统自动生成 · 数据截至 ' + esc(r.updated_at || '') + '*');

  return L.join('\n');
}

module.exports = { generateFullReport, reportRows };
