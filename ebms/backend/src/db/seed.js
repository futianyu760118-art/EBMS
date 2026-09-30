'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config/env');
const { pool } = require('./pool');
const { canonicalPair } = require('../domain/links/link-repository');

// 自检夹具：固定 UUID，便于测试逐条断言。
const IDS = {
  users: {
    decider: '11111111-1111-4111-8111-111111111111',
    owner: '22222222-2222-4222-8222-222222222222',
  },
  // F1 指标集：沿用 001 的锚点 id（result_reasons 已按此 id 关联「订单交付」）
  metric: '33333333-3333-4333-8333-333333333333',
  metrics: {
    revenue: '44444444-0001-4000-8000-000000000001',
    grossMarginRate: '44444444-0002-4000-8000-000000000002',
    operatingCost: '44444444-0003-4000-8000-000000000003',
    cashFlow: '44444444-0004-4000-8000-000000000004',
    receivableDays: '44444444-0005-4000-8000-000000000005',
    arBalance: '44444444-0006-4000-8000-000000000006',
    orderAmount: '44444444-0007-4000-8000-000000000007',
    newCustomerCount: '44444444-0008-4000-8000-000000000008',
    orderDelivery: '33333333-3333-4333-8333-333333333333',
    onTimeDelivery: '44444444-0009-4000-8000-000000000009',
    capacityUtilization: '44444444-0010-4000-8000-000000000010',
    inventoryTurnover: '44444444-0011-4000-8000-000000000011',
  },
  reasons: {
    capacity: 'aaaaaaaa-0001-4000-8000-000000000001', // 已挂载证据
    channel: 'aaaaaaaa-0002-4000-8000-000000000002',  // 无证据支撑（边界）
    material: 'aaaaaaaa-0003-4000-8000-000000000003', // 已挂载证据
  },
  evidences: {
    contract: 'bbbbbbbb-0001-4000-8000-000000000001',
    document: 'bbbbbbbb-0002-4000-8000-000000000002',
    systemRecord: 'bbbbbbbb-0003-4000-8000-000000000003',
    manualNote: 'bbbbbbbb-0004-4000-8000-000000000004',
    warehouse: 'bbbbbbbb-0005-4000-8000-000000000005',
    financeReport: 'bbbbbbbb-0006-4000-8000-000000000006',
    orderLedger: 'bbbbbbbb-0007-4000-8000-000000000007',
  },
  // F11（PAND-89）四视图对象锚点：含「有关联」与「无关联」两组，
  // 前者覆盖全部 6 组类型对（→ 12 个有向组合），后者用于「入口置灰」的边界判定。
  reports: {
    linked: 'cccccccc-0001-4000-8000-000000000001', // 关联 TODO/Decision/Evidence
    orphan: 'cccccccc-0002-4000-8000-000000000002', // 无关联（边界）
  },
  todos: {
    linked: 'dddddddd-0001-4000-8000-000000000001', // 关联 Report/Decision/Evidence
    orphan: 'dddddddd-0002-4000-8000-000000000002', // 无关联（边界）
    partial: 'dddddddd-0003-4000-8000-000000000003', // 仅关联 Evidence（逐入口置灰）
  },
  decisions: {
    linked: 'eeeeeeee-0001-4000-8000-000000000001', // 关联 Report/TODO/Evidence
    orphan: 'eeeeeeee-0002-4000-8000-000000000002', // 无关联（边界）
  },
};

// F11 关联夹具：每行 = 一条关联（双向可达）。前 6 行覆盖全部 6 组类型对。
const VIEW_LINK_FIXTURES = [
  { from: ['report', 'linked'], to: ['todo', 'linked'], relationType: 'related' },
  { from: ['report', 'linked'], to: ['decision', 'linked'], relationType: 'derived_from' },
  { from: ['report', 'linked'], to: ['evidence', 'contract'], relationType: 'related' },
  { from: ['todo', 'linked'], to: ['decision', 'linked'], relationType: 'executes' },
  { from: ['todo', 'linked'], to: ['evidence', 'document'], relationType: 'evidences' },
  { from: ['decision', 'linked'], to: ['evidence', 'systemRecord'], relationType: 'evidences' },
  // 逐入口置灰用：仅一条关联，故其余两个入口应为「无关联」
  { from: ['todo', 'partial'], to: ['evidence', 'manualNote'], relationType: 'related' },
];

// F1 指标集夹具（PAND-79）：12 条，覆盖三家 Owner 模块（M09 财经 / M05 销售 / M06 交付）、
// 目标方向（越高越好 / 越低越好）、偏差阈值内/外，以及两种「无数据」边界。
// 目标值来自 M03 Management Goal（EBMS 自有）；实际值一律由 owner_results 供给。
const METRIC_FIXTURES = [
  { key: 'revenue', code: 'revenue', name: '营业收入', dimension: 'finance', unit: '万元', ownerModule: 'M09', direction: 'higher_better', target: 12000, goalRef: 'MG-2026-09-FIN-01', asOf: '2026-09-30T23:59:59+08:00' },
  { key: 'grossMarginRate', code: 'gross_margin_rate', name: '毛利率', dimension: 'finance', unit: '%', ownerModule: 'M09', direction: 'higher_better', target: 32.0, goalRef: 'MG-2026-09-FIN-02', asOf: '2026-09-30T23:59:59+08:00' },
  { key: 'operatingCost', code: 'operating_cost', name: '营业成本', dimension: 'finance', unit: '万元', ownerModule: 'M09', direction: 'lower_better', target: 8000, goalRef: 'MG-2026-09-FIN-03', asOf: '2026-09-30T23:59:59+08:00' },
  { key: 'cashFlow', code: 'cash_flow', name: '经营性现金流', dimension: 'finance', unit: '万元', ownerModule: 'M09', direction: 'higher_better', target: 1500, goalRef: 'MG-2026-09-FIN-04', asOf: '2026-09-30T23:59:59+08:00' },
  { key: 'receivableDays', code: 'receivable_days', name: '应收周转天数', dimension: 'finance', unit: '天', ownerModule: 'M09', direction: 'lower_better', target: 60, goalRef: 'MG-2026-09-FIN-05', asOf: '2026-09-30T23:59:59+08:00' },
  { key: 'arBalance', code: 'ar_balance', name: '应收账款余额', dimension: 'finance', unit: '万元', ownerModule: 'M09', direction: 'lower_better', target: 3000, goalRef: 'MG-2026-09-FIN-06', asOf: '2026-09-30T23:59:59+08:00' },
  { key: 'orderAmount', code: 'order_amount', name: '订单金额', dimension: 'business', unit: '万元', ownerModule: 'M05', direction: 'higher_better', target: 13500, goalRef: 'MG-2026-09-BIZ-01', asOf: '2026-09-28T00:00:00+08:00' },
  { key: 'newCustomerCount', code: 'new_customer_count', name: '新增客户数', dimension: 'business', unit: '家', ownerModule: 'M05', direction: 'higher_better', target: 40, goalRef: 'MG-2026-09-BIZ-02', asOf: '2026-09-28T00:00:00+08:00' },
  { key: 'orderDelivery', code: 'order_delivery', name: '订单交付达成率', dimension: 'business', unit: '%', ownerModule: 'M06', direction: 'higher_better', target: 100.0, goalRef: 'MG-2026-09-BIZ-03', asOf: '2026-09-28T00:00:00+08:00' },
  { key: 'onTimeDelivery', code: 'on_time_delivery', name: '准时交付率', dimension: 'business', unit: '%', ownerModule: 'M06', direction: 'higher_better', target: 98.0, goalRef: 'MG-2026-09-BIZ-04', asOf: '2026-09-28T00:00:00+08:00' },
  { key: 'capacityUtilization', code: 'capacity_utilization', name: '产能利用率', dimension: 'business', unit: '%', ownerModule: 'M06', direction: 'higher_better', target: 90.0, goalRef: 'MG-2026-09-BIZ-05', asOf: '2026-09-28T00:00:00+08:00' },
  { key: 'inventoryTurnover', code: 'inventory_turnover', name: '库存周转率', dimension: 'business', unit: '次', ownerModule: 'M06', direction: 'higher_better', target: 6.0, goalRef: 'MG-2026-09-BIZ-06', asOf: '2026-09-28T00:00:00+08:00' },
];

// Owner Result 夹具：实际值的唯一来源（EBMS 只登记、不重算）。
// 覆盖三种偏差形态：超阈值未达标、阈值内达标、越低越好方向。
const OWNER_RESULT_FIXTURES = [
  { resultId: 'res-M09-revenue-2026-09', metricKey: 'revenue', sourceSystem: 'M09', metricName: '营业收入', value: 11280, unit: '万元', calculationVersion: 'FIN-2026.09-v3', traceId: 'trace-fin-202609-rev', evidenceKeys: ['financeReport'] },
  { resultId: 'res-M09-gross-margin-rate-2026-09', metricKey: 'grossMarginRate', sourceSystem: 'M09', metricName: '毛利率', value: 30.6, unit: '%', calculationVersion: 'FIN-2026.09-v3', traceId: 'trace-fin-202609-gmr', evidenceKeys: ['financeReport'] },
  { resultId: 'res-M09-operating-cost-2026-09', metricKey: 'operatingCost', sourceSystem: 'M09', metricName: '营业成本', value: 8410, unit: '万元', calculationVersion: 'FIN-2026.09-v3', traceId: 'trace-fin-202609-cost', evidenceKeys: ['financeReport', 'contract'] },
  { resultId: 'res-M09-cash-flow-2026-09', metricKey: 'cashFlow', sourceSystem: 'M09', metricName: '经营性现金流', value: 1560, unit: '万元', calculationVersion: 'FIN-2026.09-v3', traceId: 'trace-fin-202609-cash', evidenceKeys: ['financeReport'] },
  { resultId: 'res-M09-receivable-days-2026-09', metricKey: 'receivableDays', sourceSystem: 'M09', metricName: '应收周转天数', value: 68, unit: '天', calculationVersion: 'FIN-2026.09-v3', traceId: 'trace-fin-202609-ar', evidenceKeys: ['financeReport'] },
  { resultId: 'res-M09-ar-balance-2026-09', metricKey: 'arBalance', sourceSystem: 'M09', metricName: '应收账款余额', value: 3480, unit: '万元', calculationVersion: 'FIN-2026.09-v3', traceId: 'trace-fin-202609-arb', evidenceKeys: ['financeReport'] },
  { resultId: 'res-M05-order-amount-2026-09', metricKey: 'orderAmount', sourceSystem: 'M05', metricName: '订单金额', value: 11800, unit: '万元', calculationVersion: 'SALES-ORD-2026.09-v2', traceId: 'trace-sales-202609-amt', evidenceKeys: ['orderLedger'] },
  { resultId: 'res-M06-order-delivery-2026-09', metricKey: 'orderDelivery', sourceSystem: 'M06', metricName: '订单交付达成率', value: 87.0, unit: '%', calculationVersion: 'DELIV-2026.09-v4', traceId: 'trace-deliv-202609-od', evidenceKeys: ['systemRecord', 'manualNote', 'document'] },
  { resultId: 'res-M06-capacity-utilization-2026-09', metricKey: 'capacityUtilization', sourceSystem: 'M06', metricName: '产能利用率', value: 88.0, unit: '%', calculationVersion: 'DELIV-2026.09-v4', traceId: 'trace-deliv-202609-cap', evidenceKeys: ['systemRecord', 'manualNote'] },
  { resultId: 'res-M06-inventory-turnover-2026-09', metricKey: 'inventoryTurnover', sourceSystem: 'M06', metricName: '库存周转率', value: 5.2, unit: '次', calculationVersion: 'DELIV-2026.09-v4', traceId: 'trace-deliv-202609-inv', evidenceKeys: ['warehouse'] },
  // 边界：M05 供给过「新增客户数」，但只到 8 月 → 9 月应判为「来源模块未同步本期数据」
  { resultId: 'res-M05-new-customer-2026-08', metricKey: 'newCustomerCount', sourceSystem: 'M05', metricName: '新增客户数', value: 37, unit: '家', calculationVersion: 'SALES-CUST-2026.08-v1', traceId: 'trace-sales-202608-cust', evidenceKeys: ['orderLedger'], periodValue: '2026-08', occurredAt: '2026-08-31T23:59:59+08:00' },
];

// F4 来源标注夹具（PAND-82）：覆盖内部系统 / 外部数据 / 人工录入三类，
// 并**刻意留 1 条未标注来源**（生产工单 GW-2026-0901）作为「来源缺失 / 待补清单」边界。
// 口径：外部数据必须带提供方；人工录入必须带录入人与录入时间。
const SOURCE_FIXTURES = {
  contract: {
    sourceType: 'external',
    sourceSystem: '供应商门户 SRM',
    sourceDocumentNo: 'SC-2026-014',
    sourceDataTime: '2026-08-15T00:00:00+08:00',
    updateCycle: 'month',
    sourceProvider: 'A 供应商（外部）',
  },
  systemRecord: {
    sourceType: 'internal',
    sourceSystem: 'MES 生产执行系统',
    sourceDocumentNo: 'MES-CAP-2026-09',
    sourceDataTime: '2026-09-20T00:00:00+08:00',
    updateCycle: 'day',
  },
  manualNote: {
    sourceType: 'manual',
    sourceSystem: '生产中心人工台账',
    // 人工录入常无内部单据号：留空以覆盖「非判定项待补提示」
    sourceDataTime: '2026-09-10T00:00:00+08:00',
    updateCycle: 'week',
    enteredBy: '钱厂长',
    enteredAt: '2026-09-10T09:30:00+08:00',
  },
  warehouse: {
    sourceType: 'internal',
    sourceSystem: 'WMS 仓储系统',
    sourceDocumentNo: 'WMS-INV-2026-09',
    sourceDataTime: '2026-09-18T00:00:00+08:00',
    updateCycle: 'month',
  },
  financeReport: {
    sourceType: 'internal',
    sourceSystem: 'M09 财经中心',
    sourceDocumentNo: 'FIN-MR-2026-09',
    sourceDataTime: '2026-09-30T00:00:00+08:00',
    updateCycle: 'month',
  },
  orderLedger: {
    sourceType: 'internal',
    sourceSystem: 'M05 销售中心',
    sourceDocumentNo: 'SALES-ORD-2026-09',
    sourceDataTime: '2026-09-28T00:00:00+08:00',
    updateCycle: 'month',
  },
  // document（生产工单 GW-2026-0901）刻意不在此：来源缺失边界
};

const CONTRACT_FILE = '采购框架合同_SC-2026-014.pdf';
const SEED_ACTOR_NAME = '李责任（管理责任人）';
const SEED_PERIOD = { periodType: 'month', periodValue: '2026-09' };

function minimalPdf(text) {
  const body = `BT /F1 12 Tf 40 750 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

async function seed() {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const pdfBuffer = minimalPdf('EBMS fixture attachment');
  fs.writeFileSync(path.join(config.uploadDir, CONTRACT_FILE), pdfBuffer);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 幂等：本脚本是开发/自检夹具，先清空 EBMS 自有数据再灌入。
    await client.query(
      'TRUNCATE reason_evidences, object_links, audit_log, evidences, owner_results, result_reasons, result_metrics, reports, todos, decisions CASCADE'
    );

    await client.query(
      `INSERT INTO ebms_users (id, username, display_name, role) VALUES
         ($1, 'decider', '张决策（决策者）', 'decider'),
         ($2, 'owner',   '李责任（管理责任人）', 'owner')
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
      [IDS.users.decider, IDS.users.owner]
    );

    // ---------------------------------------------------------------- F1 指标集（PAND-79）
    // 目标值来自 M03 Management Goal（EBMS 自有）；实际值不在此表，一律由 owner_results 供给。
    for (const [index, m] of METRIC_FIXTURES.entries()) {
      await client.query(
        `INSERT INTO result_metrics
           (id, code, name, dimension, period_type, period_value, as_of, unit, owner_module,
            direction, target_value, target_source_module, target_source_ref, threshold_pct, is_active, order_no)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'M03', $12, $13, TRUE, $14)`,
        [
          IDS.metrics[m.key],
          m.code,
          m.name,
          m.dimension,
          SEED_PERIOD.periodType,
          SEED_PERIOD.periodValue,
          m.asOf,
          m.unit,
          m.ownerModule,
          m.direction,
          m.target,
          m.goalRef,
          m.thresholdPct ?? 5.0,
          index + 1,
        ]
      );
    }

    // 登记 Owner Result（实际值的唯一来源）。EBMS 只按契约登记，不做任何重算。
    for (const r of OWNER_RESULT_FIXTURES) {
      const metric = METRIC_FIXTURES.find((m) => m.key === r.metricKey);
      const evidenceIds = r.evidenceKeys.map((k) => IDS.evidences[k]);
      const inserted = await client.query(
        `INSERT INTO owner_results
           (result_id, source_system, object_type, object_id, metric_code, metric_name, value, unit,
            period_type, period_value, calculation_version, evidence_ids, status, occurred_at, trace_id, received_by)
         VALUES ($1, $2, 'BusinessMetric', $3, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'VERIFIED', $11, $12, $13)
         RETURNING id`,
        [
          r.resultId,
          r.sourceSystem,
          metric.code,
          r.metricName,
          r.value,
          r.unit,
          SEED_PERIOD.periodType,
          r.periodValue ?? SEED_PERIOD.periodValue,
          r.calculationVersion,
          JSON.stringify(evidenceIds),
          r.occurredAt ?? metric.asOf,
          r.traceId,
          IDS.users.owner,
        ]
      );
      await client.query(
        `INSERT INTO audit_log (actor, actor_name, action, entity_type, entity_id, reason_id, after)
         VALUES ($1, $2, 'owner_result.receive', 'owner_result', $3, NULL, $4::jsonb)`,
        [
          IDS.users.owner,
          SEED_ACTOR_NAME,
          String(inserted.rows[0].id),
          JSON.stringify({
            resultId: r.resultId,
            sourceSystem: r.sourceSystem,
            metricCode: metric.code,
            value: r.value,
            periodType: SEED_PERIOD.periodType,
            periodValue: r.periodValue ?? SEED_PERIOD.periodValue,
            calculationVersion: r.calculationVersion,
            evidenceIds,
          }),
        ]
      );
    }

    await client.query(
      `INSERT INTO result_reasons (id, metric_id, name, direction, contribution_pct, owner, order_no) VALUES
         ($1, $4, '产能不足',     'negative', 40.00, '生产中心',   1),
         ($2, $4, '渠道压货',     'negative', 25.00, '销售中心',   2),
         ($3, $4, '原材料涨价',   'negative', 20.00, '供应链中心', 3)`,
      [IDS.reasons.capacity, IDS.reasons.channel, IDS.reasons.material, IDS.metric]
    );

    const evidenceRows = [
      {
        id: IDS.evidences.contract,
        type: 'contract',
        title: '采购框架合同 SC-2026-014',
        formedAt: '2026-08-15T00:00:00+08:00',
        owner: '供应链中心 / 王采购',
        content: '与 A 供应商签订的年度框架采购合同，附件为签署版扫描件。',
        attachments: [{ filename: CONTRACT_FILE, storage_key: CONTRACT_FILE, size_bytes: pdfBuffer.length }],
      },
      {
        id: IDS.evidences.document,
        type: 'document',
        title: '生产工单 GW-2026-0901',
        formedAt: '2026-09-01T00:00:00+08:00',
        owner: '生产中心 / 赵计划',
        content: '9 月首周生产工单，含计划产量与实际产量记录。',
        attachments: [],
      },
      {
        id: IDS.evidences.systemRecord,
        type: 'system_record',
        title: 'MES 产能达成率导出（2026-09）',
        formedAt: '2026-09-20T00:00:00+08:00',
        owner: '生产中心 / 系统',
        content: 'MES 导出的产能达成率明细：计划 1200 台，实际 1044 台，达成率 87%。',
        attachments: [],
      },
      {
        id: IDS.evidences.manualNote,
        type: 'manual_note',
        title: '产线技改停产说明',
        formedAt: '2026-09-10T00:00:00+08:00',
        owner: '生产中心 / 钱厂长',
        content: '2 号线于 9/8–9/12 进行技改停产，累计停产 5 天，折算影响产量约 180 台。',
        attachments: [],
      },
      {
        id: IDS.evidences.warehouse,
        type: 'system_record',
        title: 'WMS 库存周转导出（2026-09）',
        formedAt: '2026-09-18T00:00:00+08:00',
        owner: '供应链中心 / 系统',
        content: 'WMS 库存周转与呆滞物料导出，用于佐证原材料涨价的影响范围。',
        attachments: [],
      },
      {
        id: IDS.evidences.financeReport,
        type: 'system_record',
        title: '财务月结报表导出（2026-09）',
        formedAt: '2026-09-30T00:00:00+08:00',
        owner: '财务中心 / 系统',
        content: 'M09 财经自治月结导出：收入、成本、毛利率、现金流、应收应付口径明细。',
        attachments: [],
      },
      {
        id: IDS.evidences.orderLedger,
        type: 'system_record',
        title: '销售订单台账导出（2026-09）',
        formedAt: '2026-09-28T00:00:00+08:00',
        owner: '销售中心 / 系统',
        content: 'M05 销售自治台账导出：商务状态订单金额、新增客户数。',
        attachments: [],
      },
    ];

    for (const e of evidenceRows) {
      await client.query(
        `INSERT INTO evidences (id, type, title, formed_at, owner, content, attachment_refs, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [e.id, e.type, e.title, e.formedAt, e.owner, e.content, JSON.stringify(e.attachments), IDS.users.owner]
      );
    }

    // 为 6 条证据标注来源；document 保持「来源缺失」，进入待补清单。
    for (const [key, s] of Object.entries(SOURCE_FIXTURES)) {
      await client.query(
        `UPDATE evidences
            SET source_type = $2, source_system = $3, source_document_no = $4, source_data_time = $5,
                source_update_cycle = $6, source_provider = $7, source_entered_by = $8, source_entered_at = $9
          WHERE id = $1`,
        [
          IDS.evidences[key],
          s.sourceType,
          s.sourceSystem,
          s.sourceDocumentNo ?? null,
          s.sourceDataTime,
          s.updateCycle ?? null,
          s.sourceProvider ?? null,
          s.enteredBy ?? null,
          s.enteredAt ?? null,
        ]
      );
      await client.query(
        `INSERT INTO audit_log (actor, actor_name, action, entity_type, entity_id, reason_id, after)
         VALUES ($1, $2, 'evidence.source.annotate', 'evidence', $3, NULL, $4::jsonb)`,
        [IDS.users.owner, SEED_ACTOR_NAME, IDS.evidences[key], JSON.stringify(s)]
      );
    }

    const links = [
      [IDS.reasons.capacity, IDS.evidences.contract],
      [IDS.reasons.capacity, IDS.evidences.document],
      [IDS.reasons.capacity, IDS.evidences.systemRecord],
      [IDS.reasons.capacity, IDS.evidences.manualNote],
      [IDS.reasons.material, IDS.evidences.contract],
      [IDS.reasons.material, IDS.evidences.warehouse],
    ];
    for (const [reasonId, evidenceId] of links) {
      await client.query(
        `INSERT INTO reason_evidences (reason_id, evidence_id, linked_by) VALUES ($1, $2, $3)`,
        [reasonId, evidenceId, IDS.users.owner]
      );
      await client.query(
        `INSERT INTO audit_log (actor, actor_name, action, entity_type, entity_id, reason_id, after)
         VALUES ($1, $2, 'evidence.link', 'evidence', $3, $4, $5::jsonb)`,
        [IDS.users.owner, SEED_ACTOR_NAME, evidenceId, reasonId, JSON.stringify({ reasonId, evidenceId })]
      );
    }
    // 为「已挂载」证据补一条新增留痕，使留痕时间线完整
    for (const e of evidenceRows) {
      await client.query(
        `INSERT INTO audit_log (actor, actor_name, action, entity_type, entity_id, reason_id, after)
         VALUES ($1, $2, 'evidence.create', 'evidence', $3, NULL, $4::jsonb)`,
        [IDS.users.owner, SEED_ACTOR_NAME, e.id, JSON.stringify({ type: e.type, title: e.title, formedAt: e.formedAt, owner: e.owner })]
      );
    }

    // ---------------------------------------------------------------- F11 四视图对象（PAND-89）
    await client.query(
      `INSERT INTO reports (id, code, title, conclusion, period_type, period_value, domain, owner, created_by) VALUES
         ($1, 'RPT-2026-09-01', '9月经营月报：订单交付偏差', '订单交付达成 87%，低于目标 13 个百分点，主因产能不足。', 'month', '2026-09', '销售', '经营管理部', $3),
         ($2, 'RPT-2026-09-02', '9月经营月报：渠道库存',     '渠道库存周转放缓，暂未形成偏差结论。',                 'month', '2026-09', '销售', '经营管理部', $3)`,
      [IDS.reports.linked, IDS.reports.orphan, IDS.users.owner]
    );

    await client.query(
      `INSERT INTO todos (id, code, title, source, status, owner, due_at, created_by) VALUES
         ($1, 'TODO-2026-0901', '2号线排产调整以补产能缺口', 'rule',   'in_progress', '生产中心 / 赵计划', '2026-09-30T00:00:00+08:00', $4),
         ($2, 'TODO-2026-0902', '华东渠道库存清理',           'manual', 'pending',     '销售中心 / 孙渠道', '2026-10-15T00:00:00+08:00', $4),
         ($3, 'TODO-2026-0903', '补充技改停产影响说明材料',   'manual', 'pending',     '生产中心 / 钱厂长', NULL, $4)`,
      [IDS.todos.linked, IDS.todos.orphan, IDS.todos.partial, IDS.users.owner]
    );

    await client.query(
      `INSERT INTO decisions (id, code, title, background, conclusion, status, decider, decided_at, created_by) VALUES
         ($1, 'DEC-2026-0901', '是否追加2号线夜班产能', '交付偏差 13pp，产能缺口为主要归因。', '同意 10 月起追加夜班，先试运行一个月。', 'decided', '张决策', '2026-09-22T00:00:00+08:00', $3),
         ($2, 'DEC-2026-0902', '是否调整华东渠道政策',   '渠道库存周转放缓，尚未形成结论。',     NULL,                                    'pending', NULL,     NULL,                          $3)`,
      [IDS.decisions.linked, IDS.decisions.orphan, IDS.users.owner]
    );

    for (const fixture of VIEW_LINK_FIXTURES) {
      const [fromType, fromKey] = fixture.from;
      const [toType, toKey] = fixture.to;
      const fromId = IDS[`${fromType}s`][fromKey];
      const toId = IDS[`${toType}s`][toKey];
      const { pairA, pairB } = canonicalPair(fromType, fromId, toType, toId);
      const inserted = await client.query(
        `INSERT INTO object_links (from_type, from_id, to_type, to_id, pair_a, pair_b, relation_type, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [fromType, fromId, toType, toId, pairA, pairB, fixture.relationType, IDS.users.owner]
      );
      await client.query(
        `INSERT INTO audit_log (actor, actor_name, action, entity_type, entity_id, reason_id, after)
         VALUES ($1, $2, 'view_link.create', 'object_link', $3, NULL, $4::jsonb)`,
        [
          IDS.users.owner,
          SEED_ACTOR_NAME,
          String(inserted.rows[0].id),
          JSON.stringify({ fromType, fromId, toType, toId, relationType: fixture.relationType }),
        ]
      );
    }

    await client.query('COMMIT');
    console.log('[seed] done');
    console.log('[seed]   reason 已有证据 :', IDS.reasons.capacity, '(4 条)');
    console.log('[seed]   reason 无证据   :', IDS.reasons.channel, '(0 条 → 无证据支撑)');
    console.log('[seed]   reason 已有证据 :', IDS.reasons.material, '(2 条)');
    console.log('[seed]   四视图关联     :', VIEW_LINK_FIXTURES.length, '条（覆盖 6 组类型对）');
    console.log('[seed]   无关联对象     : report/todo/decision 各 1 + 证据 1（入口置灰边界）');
    console.log('[seed]   指标集         :', METRIC_FIXTURES.length, '条（M09 财经 6 / M05 销售 2 / M06 交付 4）');
    console.log('[seed]   Owner Result   :', OWNER_RESULT_FIXTURES.length, '条（实际值唯一来源）');
    console.log('[seed]   无数据边界     : on_time_delivery（未供给）/ new_customer_count（未同步本期）');
    console.log(
      '[seed]   来源标注       :',
      Object.keys(SOURCE_FIXTURES).length,
      '条（内部/外部/人工），缺失 1 条（生产工单 → 待补清单）'
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      console.error('[seed] failed:', err.message);
      process.exit(1);
    });
}

module.exports = {
  seed,
  IDS,
  CONTRACT_FILE,
  VIEW_LINK_FIXTURES,
  METRIC_FIXTURES,
  OWNER_RESULT_FIXTURES,
  SOURCE_FIXTURES,
  SEED_PERIOD,
};
