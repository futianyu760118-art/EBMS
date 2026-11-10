/**
 * EBMS 数据接入层 —— 本地数据源（LocalProvider）。
 *
 * 当前阶段：从本地表读取（数据库/JSON 表），用于测试。
 * 后续切换：环境变量 EBMS_DATA_PROVIDER=edp 时切换到 EdpProvider（M02 EDP 取数）。
 *
 * 统一返回形状（业务模块只依赖此形状）：
 *   { source, owner, contract, period, data, status }
 *   status: available（有数据）| not_connected（该专业系统未接入，本地无真实结果）
 */
const { getTable } = require('../../db');

function findReport(period) {
  const reports = getTable('monthly_reports').all();
  if (period) return reports.find(r => String(r.period) === String(period)) || null;
  return reports.slice().sort((a, b) => (b.period || '').localeCompare(a.period || ''))[0] || null;
}

function reportRows(period, tableName) {
  const report = findReport(period);
  if (!report) return [];
  return getTable(tableName).all()
    .filter(x => Number(x.report_id) === Number(report.id))
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
}

function result(owner, contract, period, data, status) {
  return { source: 'local', owner, contract, period: period || null, data: data || [], status: status || (data && data.length ? 'available' : 'not_connected') };
}

// 本地把「月度报告指标」映射为各系统的专业 Result 形状（测试用；真实值后续由专业系统经 EDP 供给）
function indicatorsOf(period, departments) {
  const set = new Set(departments);
  return reportRows(period, 'monthly_indicators').filter(i => set.has(i.department));
}

const localProvider = {
  name: 'local',

  // ---- 各系统专业结果（EBMS 只消费 Result）----
  getFinanceResults(period) {
    const rows = indicatorsOf(period, ['财务']);
    return result('M09_FAC', 'finance-result-v1', period, rows.map(i => ({
      result_type: 'MARGIN', object_id: i.name, amount: i.actual || null,
      target: i.target || null, status: i.status || null, note: i.note || '', rule_version: 'local-test'
    })));
  },
  getSalesResults(period) {
    const rows = indicatorsOf(period, ['销售']);
    return result('M05_CRM', 'aeos-contracts-v1', period, rows.map(i => ({
      object_id: i.name, actual: i.actual || null, target: i.target || null, status: i.status || null, note: i.note || ''
    })));
  },
  getDeliveryResults(period) {
    const rows = indicatorsOf(period, ['计划', '仓库', '采购']);
    return result('M06_SPC', 'business-event-v1', period, rows.map(i => ({
      object_id: i.name, actual: i.actual || null, target: i.target || null, status: i.status || null, note: i.note || ''
    })));
  },
  getRdResults(period) {
    const rows = indicatorsOf(period, ['研发']);
    return result('M04_PLM', 'business-event-v1', period, rows.map(i => ({
      object_id: i.name, actual: i.actual || null, target: i.target || null, status: i.status || null, note: i.note || ''
    })));
  },
  getQualityResults(period) {
    const rows = indicatorsOf(period, ['品质工程', '装配车间', '光电车间', '前道车间']);
    return result('M08_QUALITY', 'business-event-v1', period, rows.map(i => ({
      object_id: i.name, actual: i.actual || null, target: i.target || null, status: i.status || null, note: i.note || ''
    })));
  },

  // ---- 管理对象（M03 自有）----
  getIndicators(period) { return result('M03_EBMS', null, period, reportRows(period, 'monthly_indicators')); },
  getDeptSummary(period) { return result('M03_EBMS', null, period, reportRows(period, 'monthly_dept_summary')); },
  getExceptions(period) { return result('M03_EBMS', 'aeos-contracts-v1', period, reportRows(period, 'monthly_issues')); },
  getDecisions(period) { return result('M03_EBMS', 'aeos-contracts-v1', period, reportRows(period, 'monthly_decisions')); },
  getActions(period) { return result('M03_EBMS', 'm10-poms-v1', period, reportRows(period, 'monthly_actions')); }
};

module.exports = localProvider;
