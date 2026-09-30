/**
 * 跨域经营判断联调演示数据（PAND-91）
 * ------------------------------------------------------------------
 * 用途：专业中心结论接口尚未定版前，供联调/验收演示「汇聚不重算」「缺域不阻断」
 * 两个关键口径。数据按中心结论契约构造，与真实中心上报走同一条接入路径
 * （POST /api/judgments/conclusions），不绕过校验。
 *
 * 演示场景：
 *  - 2026-08：销售 / 生产·交付 / 财务 / 供应链 四域齐全 → 跨域判断可输出层级结论。
 *  - 2026-09：供应链域缺失 → 标注「该域数据缺失」，其余域仍可判断。
 *
 * 注意：财务 net_profit 的中心上报偏差率刻意与 (actual-target)/target 不一致
 * （中心按自身经营性口径上报），用于验证 EBMS 原样引用、不从 target/actual 反推；
 * 供应链 inventory_days 中心未上报偏差率，用于验证「中心未上报」不被补齐。
 */

const PERIOD_FULL = '2026-08';
const PERIOD_MISSING = '2026-09';
const DEMO_PERIODS = [PERIOD_FULL, PERIOD_MISSING];

const DEMO_CONCLUSIONS = [
  // ===================== 2026-08 四域齐全 =====================
  {
    center: 'sales',
    period: PERIOD_FULL,
    conclusion_id: 'M05-CONC-202608-001',
    source_system: 'M05',
    calculation_version: 'M05-SALES-V1',
    occurred_at: '2026-09-03T09:20:00+08:00',
    data_cutoff: '2026-08-31',
    trace_id: 'TRACE-M05-202608-001',
    evidence_ids: ['EVD-M05-202608-001'],
    data_status: 'ok',
    summary: '8 月销售收入未达目标，订单额与客户数达标。',
    metrics: [
      { code: 'revenue', name: '营业收入', unit: '万元', target: 1280, actual: 1180, deviation_abs: -100, deviation_pct: -7.81, threshold_pct: 5, status: 'below' },
      { code: 'order_amount', name: '订单额', unit: '万元', target: 5000, actual: 5150, deviation_abs: 150, deviation_pct: 3.00, threshold_pct: 5, status: 'normal' },
      { code: 'new_customers', name: '新增客户数', unit: '家', target: 40, actual: 42, deviation_abs: 2, deviation_pct: 5.00, threshold_pct: 5, status: 'normal' },
      { code: 'quote_conversion', name: '报价转化率', unit: '%', target: 32, actual: 33.6, deviation_abs: 1.6, deviation_pct: 5.00, threshold_pct: 5, status: 'normal' }
    ]
  },
  {
    center: 'production',
    period: PERIOD_FULL,
    conclusion_id: 'M06-CONC-202608-001',
    source_system: 'M06',
    calculation_version: 'M06-DELIVERY-V1',
    occurred_at: '2026-09-03T10:05:00+08:00',
    data_cutoff: '2026-08-31',
    trace_id: 'TRACE-M06-202608-001',
    evidence_ids: ['EVD-M06-202608-001'],
    data_status: 'ok',
    summary: '8 月交付与产能整体平稳，产量略低于目标但仍在阈值内。',
    metrics: [
      { code: 'on_time_delivery_rate', name: '准时交付率', unit: '%', target: 95, actual: 96.2, deviation_abs: 1.2, deviation_pct: 1.26, threshold_pct: 2, status: 'normal' },
      { code: 'output_qty', name: '产量', unit: '台', target: 20000, actual: 19800, deviation_abs: -200, deviation_pct: -1.00, threshold_pct: 3, status: 'normal' },
      { code: 'capacity_utilization', name: '产能利用率', unit: '%', target: 85, actual: 87.1, deviation_abs: 2.1, deviation_pct: 2.47, threshold_pct: 5, status: 'normal' },
      { code: 'defect_closure_rate', name: '不良闭环率', unit: '%', target: 90, actual: 90.9, deviation_abs: 0.9, deviation_pct: 1.00, threshold_pct: 5, status: 'normal' }
    ]
  },
  {
    center: 'finance',
    period: PERIOD_FULL,
    conclusion_id: 'M09-CONC-202608-001',
    source_system: 'M09',
    calculation_version: 'M09-FIN-V1',
    occurred_at: '2026-09-04T08:40:00+08:00',
    data_cutoff: '2026-08-31',
    trace_id: 'TRACE-M09-202608-001',
    evidence_ids: ['EVD-M09-202608-001'],
    data_status: 'ok',
    summary: '8 月毛利率与净利润低于目标，回款与周转正常。',
    metrics: [
      { code: 'gross_margin', name: '毛利率', unit: '%', target: 30, actual: 28.0, deviation_abs: -2.0, deviation_pct: -6.67, threshold_pct: 3, status: 'below' },
      // 中心按自身经营性口径上报：naive (760-800)/800 = -5.00%，中心上报 -4.20%（剔除汇兑损益）
      { code: 'net_profit', name: '净利润', unit: '万元', target: 800, actual: 760, deviation_abs: -40, deviation_pct: -4.20, threshold_pct: 3, status: 'below', calc_note: '口径：剔除汇兑损益后的经营性口径' },
      { code: 'cash_collection', name: '回款额', unit: '万元', target: 1100, actual: 1119.8, deviation_abs: 19.8, deviation_pct: 1.80, threshold_pct: 5, status: 'normal' },
      { code: 'ar_turnover', name: '应收周转率', unit: '次', target: 4.2, actual: 4.15, deviation_abs: -0.05, deviation_pct: -1.19, threshold_pct: 5, status: 'normal' }
    ]
  },
  {
    center: 'supply_chain',
    period: PERIOD_FULL,
    conclusion_id: 'M06-CONC-202608-SC01',
    source_system: 'M06',
    calculation_version: 'M06-SCM-V1',
    occurred_at: '2026-09-03T11:15:00+08:00',
    data_cutoff: '2026-08-31',
    trace_id: 'TRACE-M06-202608-SC01',
    evidence_ids: ['EVD-M06-202608-SC01'],
    data_status: 'ok',
    summary: '8 月供应保障整体正常，物料齐套率小幅低于目标但仍在阈值内。',
    metrics: [
      { code: 'supplier_otd', name: '供应商准时交付率', unit: '%', target: 93, actual: 93.5, deviation_abs: 0.5, deviation_pct: 0.54, threshold_pct: 2, status: 'normal' },
      { code: 'material_availability', name: '物料齐套率', unit: '%', target: 96, actual: 94.1, deviation_abs: -1.9, deviation_pct: -1.98, threshold_pct: 5, status: 'normal' },
      { code: 'purchase_cost_saving', name: '采购降本额', unit: '万元', target: 50, actual: 56, deviation_abs: 6, deviation_pct: 12.00, threshold_pct: 5, status: 'normal' },
      // 中心未上报偏差率：EBMS 保持空值并标记「中心未上报」，绝不从 target/actual 反推
      { code: 'inventory_days', name: '库存周转天数', unit: '天', target: 45, actual: 47 }
    ]
  },

  // ===================== 2026-09 供应链域缺失 =====================
  {
    center: 'sales',
    period: PERIOD_MISSING,
    conclusion_id: 'M05-CONC-202609-001',
    source_system: 'M05',
    calculation_version: 'M05-SALES-V1',
    occurred_at: '2026-09-30T09:10:00+08:00',
    data_cutoff: '2026-09-29',
    trace_id: 'TRACE-M05-202609-001',
    evidence_ids: ['EVD-M05-202609-001'],
    data_status: 'ok',
    summary: '9 月销售收入明显低于目标。',
    metrics: [
      { code: 'revenue', name: '营业收入', unit: '万元', target: 1300, actual: 1170, deviation_abs: -130, deviation_pct: -10.00, threshold_pct: 5, status: 'below' },
      { code: 'order_amount', name: '订单额', unit: '万元', target: 5200, actual: 4940, deviation_abs: -260, deviation_pct: -5.00, threshold_pct: 5, status: 'below' },
      { code: 'new_customers', name: '新增客户数', unit: '家', target: 42, actual: 44, deviation_abs: 2, deviation_pct: 4.76, threshold_pct: 5, status: 'normal' },
      { code: 'quote_conversion', name: '报价转化率', unit: '%', target: 33, actual: 34.3, deviation_abs: 1.3, deviation_pct: 3.94, threshold_pct: 5, status: 'normal' }
    ]
  },
  {
    center: 'production',
    period: PERIOD_MISSING,
    conclusion_id: 'M06-CONC-202609-001',
    source_system: 'M06',
    calculation_version: 'M06-DELIVERY-V1',
    occurred_at: '2026-09-30T10:20:00+08:00',
    data_cutoff: '2026-09-29',
    trace_id: 'TRACE-M06-202609-001',
    evidence_ids: ['EVD-M06-202609-001'],
    data_status: 'ok',
    summary: '9 月准时交付率低于目标，产能与产量正常。',
    metrics: [
      { code: 'on_time_delivery_rate', name: '准时交付率', unit: '%', target: 95, actual: 91.5, deviation_abs: -3.5, deviation_pct: -3.68, threshold_pct: 2, status: 'below' },
      { code: 'output_qty', name: '产量', unit: '台', target: 20500, actual: 20800, deviation_abs: 300, deviation_pct: 1.46, threshold_pct: 3, status: 'normal' },
      { code: 'capacity_utilization', name: '产能利用率', unit: '%', target: 86, actual: 86.9, deviation_abs: 0.9, deviation_pct: 1.05, threshold_pct: 5, status: 'normal' },
      { code: 'defect_closure_rate', name: '不良闭环率', unit: '%', target: 90, actual: 89.1, deviation_abs: -0.9, deviation_pct: -1.00, threshold_pct: 5, status: 'normal' }
    ]
  },
  {
    center: 'finance',
    period: PERIOD_MISSING,
    conclusion_id: 'M09-CONC-202609-001',
    source_system: 'M09',
    calculation_version: 'M09-FIN-V1',
    occurred_at: '2026-09-30T11:00:00+08:00',
    data_cutoff: '2026-09-29',
    trace_id: 'TRACE-M09-202609-001',
    evidence_ids: ['EVD-M09-202609-001'],
    data_status: 'ok',
    summary: '9 月毛利率与净利润低于目标。',
    metrics: [
      { code: 'gross_margin', name: '毛利率', unit: '%', target: 30, actual: 27.6, deviation_abs: -2.4, deviation_pct: -8.00, threshold_pct: 3, status: 'below' },
      { code: 'net_profit', name: '净利润', unit: '万元', target: 820, actual: 779, deviation_abs: -41, deviation_pct: -5.00, threshold_pct: 3, status: 'below' },
      { code: 'cash_collection', name: '回款额', unit: '万元', target: 1150, actual: 1127, deviation_abs: -23, deviation_pct: -2.00, threshold_pct: 5, status: 'normal' },
      { code: 'ar_turnover', name: '应收周转率', unit: '次', target: 4.1, actual: 4.18, deviation_abs: 0.08, deviation_pct: 1.95, threshold_pct: 5, status: 'normal' }
    ]
  }
  // 2026-09 供应链域无结论上报：接入层缺失 → 判断标注「该域数据缺失」，其余域仍可判断
];

/** 构造入库用的中心结论快照记录 */
function buildDemoConclusions(ingestedAt) {
  return DEMO_CONCLUSIONS.map(c => ({
    center: c.center,
    period: c.period,
    conclusion_id: c.conclusion_id,
    source_system: c.source_system,
    calculation_version: c.calculation_version,
    occurred_at: c.occurred_at,
    data_cutoff: c.data_cutoff,
    trace_id: c.trace_id,
    evidence_ids: c.evidence_ids.slice(),
    data_status: c.data_status,
    summary: c.summary,
    payload: JSON.parse(JSON.stringify(c)),
    metrics: JSON.parse(JSON.stringify(c.metrics)),
    ingest_channel: 'demo',
    ingested_at: ingestedAt
  }));
}

module.exports = { DEMO_PERIODS, PERIOD_FULL, PERIOD_MISSING, buildDemoConclusions };
