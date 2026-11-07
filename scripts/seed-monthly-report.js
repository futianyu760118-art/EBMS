// 月度经营报告种子数据：灌入 2026-10 宁波恒剑光电月度经营报告（幂等）
// 用法：node scripts/seed-monthly-report.js
// 说明：仅当 monthly_reports 中不存在 period=2026-10 时灌入；重复运行不会重复插入。
const path = require('path');
const { getTable, now } = require('../backend/db');

const ts = now();
const PERIOD = '2026-10';

async function seedChildren(name, reportId, rows) {
  const t = getTable(name);
  for (const row of rows) {
    await t.insertNoSave({ ...row, report_id: reportId, created_at: ts, updated_at: ts });
  }
  await t.saveNow();
}

async function main() {
  const rt = getTable('monthly_reports');
  const existing = rt.all().find(r => String(r.period) === PERIOD);
  if (existing) {
    console.log('[seed-monthly-report] 已存在 ' + PERIOD + ' 报告（id=' + existing.id + '），跳过。');
    return;
  }

  const r = await rt.insert({
    period: PERIOD,
    title: '2026年10月月度经营报告',
    summary: '10月不是9月那种「订单冲高、钱没回」的极端月，而是「全面回落到常态、且数据质量在恶化」的月。接单279.94万、达成63.6%；回款仍只做到43%；开票销售额177万、综合开票毛利率从9月的30.5%掉到14.4%。比单月数字更值得警惕的是「填报缺口」：计划交付达成率、排产物料齐套率、采购来料齐套率、品质检验及时率/首件合格率10月在系统里是空的。',
    report_date: '2026-11-05',
    prepared_by: '总经办',
    status: 'published',
    created_at: ts,
    updated_at: ts
  });
  const reportId = r.lastID;
  console.log('[seed-monthly-report] 创建报告 id=' + reportId);

  // 核心指标（category=core）
  const core = [
    { department: '销售', category: 'core', name: '销售接单', target: '440万', actual: '280万', unit: '万元', status: 'yellow', note: '达成63.6%，同比+95%（去年同期143万）', sort_order: 1 },
    { department: '销售', category: 'core', name: '回款达成', target: '800万', actual: '344万', unit: '万元', status: 'red', note: '达成43%，累计仅52%', sort_order: 2 },
    { department: '财务', category: 'core', name: '开票销售额', target: '', actual: '177万', unit: '万元', status: 'yellow', note: '滞后接单103万；毛利14.4%（待核）', sort_order: 3 },
    { department: '销售', category: 'core', name: '新产品销售', target: '100万', actual: '96万', unit: '万元', status: 'green', note: '达成96.3%', sort_order: 4 }
  ];

  // 关键瓶颈（category=bottleneck）
  const bottleneck = [
    { department: '销售', category: 'bottleneck', name: '回款达成率', target: '100%', actual: '43%', unit: '', status: 'red', note: '缺口456万（单月）', sort_order: 1 },
    { department: '采购', category: 'bottleneck', name: '购销比达成率', target: '90%', actual: '42.5%', unit: '', status: 'red', note: '73款中仅31款达标', sort_order: 2 },
    { department: '研发', category: 'bottleneck', name: '项目开发准时率', target: '60%', actual: '40.9%', unit: '', status: 'red', note: '较9月35%改善', sort_order: 3 },
    { department: '品质工程', category: 'bottleneck', name: '制程合格率', target: '98%', actual: '88.9%', unit: '', status: 'red', note: '99批中16批不良', sort_order: 4 }
  ];

  // 部门明细指标（category=dept）
  const deptIndicators = [
    { department: '销售', category: 'dept', name: '定制项目转化', target: '2个', actual: '0', unit: '个', status: 'red', note: '累计16/22=72.7%', sort_order: 1 },
    { department: '销售', category: 'dept', name: '销售二部接单达成', target: '335万/月', actual: '38.53万', unit: '万元', status: 'red', note: '全年36.8%，缺口866万', sort_order: 2 },
    { department: '研发', category: 'dept', name: '项目开发达成', target: '3个', actual: '0', unit: '个', status: 'red', note: '', sort_order: 1 },
    { department: '研发', category: 'dept', name: '样品交付达成率', target: '', actual: '80%', unit: '', status: 'green', note: '较9月55%大幅改善', sort_order: 2 },
    { department: '研发', category: 'dept', name: '研发爆品推出', target: '5个', actual: '5个', unit: '个', status: 'green', note: '累计100%', sort_order: 3 },
    { department: '计划', category: 'dept', name: '三天冷冻计划达成率', target: '', actual: '90.5%', unit: '', status: 'green', note: '74款完成67', sort_order: 1 },
    { department: '计划', category: 'dept', name: '交付达成率', target: '0.9', actual: '', unit: '', status: 'gray', note: '10月未填报', sort_order: 2 },
    { department: '计划', category: 'dept', name: '排产物料齐套率', target: '', actual: '', unit: '', status: 'gray', note: '9月35%→68%，10月空', sort_order: 3 },
    { department: '仓库', category: 'dept', name: '账卡物一致性', target: '95%', actual: '86.2%', unit: '', status: 'yellow', note: '536抽查462准确，持续改善', sort_order: 1 },
    { department: '仓库', category: 'dept', name: '七天备料及时率', target: '95%', actual: '92%', unit: '', status: 'yellow', note: '125欠料、报欠115', sort_order: 2 },
    { department: '采购', category: 'dept', name: '降本', target: '正降本', actual: '增本0.45万', unit: '万元', status: 'red', note: '铝锭电缆线-0.51万', sort_order: 1 },
    { department: '采购', category: 'dept', name: '供应商管理', target: '', actual: '100%', unit: '', status: 'green', note: '5/5', sort_order: 2 },
    { department: '采购', category: 'dept', name: '新供应商开发', target: '1个', actual: '4个', unit: '个', status: 'green', note: '400%，累计24/14', sort_order: 3 },
    { department: '采购', category: 'dept', name: '来料齐套率', target: '', actual: '', unit: '', status: 'gray', note: '10月未填报，数据止于8月59.05%', sort_order: 4 },
    { department: '品质工程', category: 'dept', name: '出货合格率', target: '', actual: '92.7%', unit: '', status: 'green', note: '55批中4批不良', sort_order: 1 },
    { department: '品质工程', category: 'dept', name: '验货合格率', target: '', actual: '100%', unit: '', status: 'green', note: '8批零未通过', sort_order: 2 },
    { department: '品质工程', category: 'dept', name: '品质问题闭环率', target: '', actual: '0%', unit: '', status: 'red', note: '异常30+41件闭环0，疑似未更新', sort_order: 3 },
    { department: '品质工程', category: 'dept', name: '客诉处理及时率', target: '', actual: '0%', unit: '', status: 'red', note: '4件客诉0处理', sort_order: 4 },
    { department: '装配车间', category: 'dept', name: '成品一次合格率', target: '', actual: '97.8%', unit: '', status: 'green', note: '45批中1批不良', sort_order: 1 },
    { department: '装配车间', category: 'dept', name: 'UPPH达成率', target: '', actual: '129%', unit: '', status: 'green', note: '', sort_order: 2 },
    { department: '装配车间', category: 'dept', name: '样品交付', target: '', actual: '83.3%', unit: '', status: 'green', note: '', sort_order: 3 },
    { department: '光电车间', category: 'dept', name: '成品一次合格率', target: '', actual: '', unit: '', status: 'gray', note: '0批次（未填报）', sort_order: 1 },
    { department: '前道车间', category: 'dept', name: '成品一次合格率', target: '', actual: '', unit: '', status: 'gray', note: '0批次（未填报）', sort_order: 1 },
    { department: '信息化', category: 'dept', name: '流程审批平均耗时降幅', target: '', actual: '51.1%', unit: '', status: 'green', note: '2025年45h→2026年22h', sort_order: 1 },
    { department: '信息化', category: 'dept', name: '关账异常率', target: '', actual: '0.78%', unit: '', status: 'green', note: '1916出入库、异常15', sort_order: 2 },
    { department: '信息化', category: 'dept', name: 'BOM及时率', target: '', actual: '82.4%', unit: '', status: 'yellow', note: '85合同', sort_order: 3 },
    { department: '人事行政', category: 'dept', name: '一线招聘达成', target: '0', actual: '+2人', unit: '人', status: 'green', note: '累计41/40超目标', sort_order: 1 },
    { department: '人事行政', category: 'dept', name: '后勤招聘', target: '1人', actual: '0', unit: '人', status: 'red', note: '编制缺口未补', sort_order: 2 },
    { department: '人事行政', category: 'dept', name: '绩效面谈及时性', target: '', actual: '66.7%', unit: '', status: 'yellow', note: '12项完成8', sort_order: 3 },
    { department: '财务', category: 'dept', name: '综合开票毛利率', target: '', actual: '14.4%', unit: '', status: 'red', note: '较9月30.5%腰斩，待核口径', sort_order: 1 },
    { department: '财务', category: 'dept', name: '开票销售额', target: '', actual: '177.47万', unit: '万元', status: 'yellow', note: '滞后接单102万', sort_order: 2 }
  ];

  const indicators = [...core, ...bottleneck, ...deptIndicators];

  // 12 部门红黄绿
  const deptSummary = [
    { department: '销售', indicator_count: 8, achieved: '接单63.6%、新产品96.3%', not_achieved: '回款43%、大客户2家零下单', judgment: 'yellow', note: '量达标、钱没回', sort_order: 1 },
    { department: '研发', indicator_count: 10, achieved: '准时率40.9%、样品80%、爆品100%', not_achieved: '项目达成0、新技术0', judgment: 'yellow', note: '边际改善', sort_order: 2 },
    { department: '计划', indicator_count: 4, achieved: '冷冻计划90.5%', not_achieved: '交付达成率/排产齐套率未填报', judgment: 'gray', note: '数据缺失', sort_order: 3 },
    { department: '仓库', indicator_count: 3, achieved: '七天备料92%', not_achieved: '账卡物86.2%、欠料125款', judgment: 'yellow', note: '账卡物持续改善', sort_order: 4 },
    { department: '采购', indicator_count: 5, achieved: '新供应商400%、供应商管理100%、照片4/4', not_achieved: '购销比42.5%、降本增本0.45万', judgment: 'red', note: '成本反向走', sort_order: 5 },
    { department: '品质工程', indicator_count: 12, achieved: '出货92.7%、验货100%、新品一次100%', not_achieved: '制程88.9%、闭环/客诉及时率0%', judgment: 'yellow', note: '出厂好、数据存疑', sort_order: 6 },
    { department: '装配车间', indicator_count: 7, achieved: '成品97.8%、UPPH129%、样品83.3%', not_achieved: '—', judgment: 'green', note: '本月最佳部门', sort_order: 7 },
    { department: '光电车间', indicator_count: 4, achieved: '—', not_achieved: '成品/账卡物0批次未填报', judgment: 'gray', note: '数据缺失', sort_order: 8 },
    { department: '前道车间', indicator_count: 3, achieved: '—', not_achieved: '成品0批次未填报', judgment: 'gray', note: '数据缺失', sort_order: 9 },
    { department: '信息化', indicator_count: 9, achieved: '时效提升51%、关账异常0.78%、归档93.8%', not_achieved: 'BOM82%、项目开发0、培训0', judgment: 'yellow', note: '效率突出、建设停摆', sort_order: 10 },
    { department: '人事行政', indicator_count: 7, achieved: '一线招聘超目标、绩效面谈66.7%', not_achieved: '后勤招聘0', judgment: 'yellow', note: '招得进、留不住', sort_order: 11 },
    { department: '财务', indicator_count: 5, achieved: '开票177万', not_achieved: '综合毛利14.4%待核', judgment: 'red', note: '毛利预警', sort_order: 12 }
  ];

  // 决议履约（25 项打X）
  const actions = [
    { seq: 1, content: '完成手头现有项目的签字版立项书', owner: '沈旭日', due_date: '10-09', new_due_date: '09-30', status: 'transferred', note: '已转' },
    { seq: 2, content: '跑净需求，9月25日后不能有毛需求', owner: '李玉英', due_date: '10-10', new_due_date: '10-25', status: 'transferred', note: '' },
    { seq: 3, content: '成品检/验货合格率差异大，10月起纳入成品检考核', owner: '孔令军', due_date: '10-12', new_due_date: '10-13', status: 'transferred', note: '' },
    { seq: 4, content: '输出10-11月关键订单关键节点进度表', owner: '李玉英', due_date: '10-12', new_due_date: '10-16', status: 'transferred', note: '' },
    { seq: 5, content: '135订单是否取消确认', owner: '沈旭日', due_date: '10-12', new_due_date: '10-16', status: 'transferred', note: '' },
    { seq: 6, content: '输出391客户（3米大灯）生产控制计划', owner: '李玉英', due_date: '10-13', new_due_date: '10-16', status: 'transferred', note: '' },
    { seq: 7, content: '更改已发现的铝基板尺寸描述不统一问题', owner: '虞周峰', due_date: '10-14', new_due_date: '10-19', status: 'transferred', note: '' },
    { seq: 8, content: '查清并处理研发9月其他领料10750元问题', owner: '虞周峰', due_date: '10-14', new_due_date: '11-27', status: 'transferred', note: '' },
    { seq: 9, content: '核查铝基板尺寸描述不统一问题', owner: '虞周峰', due_date: '10-14', new_due_date: '10-19', status: 'transferred', note: '' },
    { seq: 10, content: '产品计划、推品产品的推进讨论', owner: '虞周峰', due_date: '10-15', new_due_date: '10-16', status: 'transferred', note: '' },
    { seq: 11, content: '135订单是否取消确认', owner: '沈旭日', due_date: '10-16', new_due_date: '10-23', status: 'transferred', note: '' },
    { seq: 12, content: '制定收款确认及下推标准', owner: '沈旭日', due_date: '10-16', new_due_date: '10-20', status: 'transferred', note: '' },
    { seq: 13, content: '输出1008客户品质管控计划', owner: '孔令军', due_date: '10-16', new_due_date: '10-26', status: 'transferred', note: '' },
    { seq: 14, content: '输出391客户（3米大灯）品质管控计划', owner: '孔令军', due_date: '10-16', new_due_date: '10-19', status: 'transferred', note: '' },
    { seq: 15, content: '签批下发多次验货未过迭代版方案', owner: '孔令军', due_date: '10-16', new_due_date: '10-26', status: 'transferred', note: '' },
    { seq: 16, content: '中台系统物料图片/图纸 MVP 并制定计划', owner: '虞周峰', due_date: '10-16', new_due_date: '10-30', status: 'transferred', note: '' },
    { seq: 17, content: '制定收款确认及下推标准', owner: '沈旭日', due_date: '10-20', new_due_date: '10-28', status: 'transferred', note: '' },
    { seq: 18, content: '提交账期调整行动计划', owner: '廖新平', due_date: '10-20', new_due_date: '', status: 'transferred', note: '无日期' },
    { seq: 19, content: '调整高棚灯灯壳外购价格', owner: '廖新平', due_date: '10-20', new_due_date: '', status: 'transferred', note: '无日期' },
    { seq: 20, content: '135订单是否取消确认', owner: '沈旭日', due_date: '10-23', new_due_date: '11-06', status: 'transferred', note: '' },
    { seq: 21, content: '跑净需求，9月25日后不能有毛需求', owner: '李玉英', due_date: '10-25', new_due_date: '11-30', status: 'transferred', note: '' },
    { seq: 22, content: '供应商条约签订', owner: '廖新平', due_date: '10-25', new_due_date: '11-25', status: 'transferred', note: '' },
    { seq: 23, content: '制定收款确认及下推标准', owner: '沈旭日', due_date: '10-28', new_due_date: '11-06', status: 'transferred', note: '' },
    { seq: 24, content: '中台系统物料图片/图纸 MVP 并制定计划', owner: '虞周峰', due_date: '10-30', new_due_date: '', status: 'transferred', note: '无日期' },
    { seq: 25, content: '符合欧盟标准的供应商储备', owner: '廖新平', due_date: '10-31', new_due_date: '11-20', status: 'transferred', note: '' }
  ];

  // 问题诊断（5 个结构性问题）
  const issues = [
    { level: 'P1', title: '现金流缺口与回款失控', owner: '沈旭日 + 洪香', deadline: '立即', problem: '1-10月回款3,056.60/全年计划5,879.72万=52%；Q4还需净回2,823.12万，月均需1,411万，而10月只回344万。按现有节奏Q4回款缺口将超2,000万。', actions: '①11月内出《Q4回款客户级作战表》按周更新；②开票与回款绑定；③超期30/60/90天分级处置落地。', sort_order: 1 },
    { level: 'P2', title: '采购合规与成本反向走', owner: '廖新平 + 沈建凯', deadline: '立即', problem: '10月降本增本0.45万；来料与订单匹配率仅40.8%（1,146条入库678条对不上）；购销比达成率42.5%。供应商评审照片已补4/4——合规短板在修，成本短板未动。', actions: '①来料入库单强制关联订单号（系统硬约束）；②降本按物料品类包干先止增本；③10月降本/来料齐套数据限期补录。', sort_order: 2 },
    { level: 'P3', title: '研发交付是整条链的瓶颈', owner: '虞周峰', deadline: '本月', problem: '项目准时率40.9%、样品交付80%（改善）；但项目开发达成仍0（3目标0完成）、新技术新材料0，建设性产出弱。', actions: '①延续"试产技转"主攻方向盯三个量化承诺；②长期不结项项目做"继续投/止损"评审；③中台系统MVP需见实际交付。', sort_order: 3 },
    { level: 'P4', title: '数据填报与考核机制失效', owner: '戎双娇 + 信息化', deadline: '本月启动', problem: '多条关键指标10月留空（计划交付达成率/排产齐套率、采购来料齐套率、品质检验及时率/首件合格率、光电/前道成品合格率）；打X项25全转派但3项无新节点日期。', actions: '①建立月度指标填报清单+截止日，空白须书面说明；②打X必须给新节点日期；③品质闭环率/客诉及时率先核对补录再定性。', sort_order: 4 },
    { level: 'P5', title: '物料与呆滞资产治理空白', owner: '研发 + 仓储', deadline: '季度', problem: '物料9个月净增1,802个、通用化率55.13%→54.24%不升反降、6,839个禁用物料仅清理32个；采购来料匹配率40.8%低位印证物料主数据仍混乱。', actions: '①"实际禁用数清理"设为研发+仓储联合指标；②新物料准入加通用化审查；③呆滞/停用物料合并立项（财务参与）。', sort_order: 5 }
  ];

  // 决策清单（11 项）
  const decisions = [
    { seq: 1, level: '🔴', title: 'Q4回款2,823.12万怎么完成', owner: '沈旭日 + 洪香', deadline: '本会定方案', problem: 'Q4需回2,823.12万；月均1,411万，10月只回344万。', action: '①11月内《Q4回款客户级作战表》每周五更新；②开票与回款绑定推进；③超期30/60/90天分级处置11月落地。', sort_order: 1 },
    { seq: 2, level: '🔴', title: 'Q4接单缺口2,057万', owner: '沈旭日', deadline: '本会定方案', problem: '1-10月累计接单3,662.51/5,720=64%；剩余2,057万需Q4完成，月均1,029万（10月仅280万）。', action: '①明确Q4靠哪几个大客户；②销售二部单独立军令状；③老客户返单/新项目转化压缩节点出结果。', sort_order: 2 },
    { seq: 3, level: '🔴', title: '2家零下单+3家达成率不足20%', owner: '沈旭日', deadline: '本会逐个定性', problem: 'HJ003.18-52（200万）、HJ002.7-16（100万）10月零下单；3家弱达成。5家挂约1,200万仅贡献极少。', action: '逐家定性——已流失/暂时停滞/无人跟进；已流失剔除补替，无人跟进当场指定责任人。', sort_order: 3 },
    { seq: 4, level: '🔴', title: '内销业务：还做不做', owner: '沈旭日 + 总经办', deadline: '本会定性', problem: '内销部今年目标0、接单0，上年同期506万；10月仍0。', action: '恢复/暂停/不做。若恢复交付物降为《可售清单+定价建议》；若不做明确库存处置。', sort_order: 4 },
    { seq: 5, level: '🔴', title: '亏本单与开票毛利腰斩', owner: '沈旭日 + 洪香 + 供应链', deadline: '11-20前', problem: '≤0%亏本单17张（占18.9%）；综合开票毛利率14.4%较9月30.5%腰斩。', action: '①17张亏本单逐单归因；②开票毛利率差异请财务给口径说明；③A类客户单独定价复盘。', sort_order: 5 },
    { seq: 6, level: '🔴', title: '采购合规与来料', owner: '廖新平 + 信息化', deadline: '限11-20', problem: '来料未匹配率59.2%；10月降本增本0.45万。', action: '①来料入库单强制关联订单号11-30上线；②降本按品类包干先止增本；③10月降本/来料齐套数据限期补录。', sort_order: 6 },
    { seq: 7, level: '🔵', title: '研发试产/技转堵点', owner: '虞周峰', deadline: '11-30见效果', problem: '项目准时率40.9%、样品80%（改善）；但项目开发达成0、新技术0。', action: '①延续技转主攻方向；②盯三个量化承诺；③长期不结项项目定"继续投/止损"。', sort_order: 7 },
    { seq: 8, level: '🔵', title: '3项未稽核事项当场定论', owner: '沈旭挺/赵申/沈建凯', deadline: '本次会上', problem: '呆滞4年以上物料、生产超领率、6.5制程合格率——三项都是钱的事，连续两期无人给结论。', action: '逐项给结论，不允许以"再看看"带入11月。', sort_order: 8 },
    { seq: 9, level: '🔵', title: '物料治理指标', owner: '研发 + 仓储', deadline: '11-30入KPI', problem: '物料净增1,802个；通用化率反降；6,839个禁用物料仅清理32个；来料匹配率40.8%低位。', action: '①禁用数清理设为联合指标；②新料准入加通用化审查；③呆滞物料合并立项。', sort_order: 9 },
    { seq: 10, level: '🔵', title: '数据填报+考核机制硬规则', owner: '戎双娇 + 信息化', deadline: '11-30上线', problem: '多条关键指标10月留空；打X25项全转派但3项无新节点日期；闭环率/客诉及时率0%疑似未更新。', action: '①月度指标填报清单+截止日，空白须书面说明；②打X必须给新节点日期；③连续两期未稽核自动转督办。', sort_order: 10 },
    { seq: 11, level: '🔵', title: '四人承载超限与关键岗位留存', owner: '总经办 + 各分管', deadline: '11-20前', problem: '虞周峰/廖新平/沈旭日/李玉英行动项最集中；离职率8.61%但只考核招人不考核留人。', action: '①在办行动项封顶8-10项；②明确李玉英三线边界；③新增"关键岗位留存率"。', sort_order: 11 }
  ];

  await seedChildren('monthly_indicators', reportId, indicators);
  await seedChildren('monthly_dept_summary', reportId, deptSummary);
  await seedChildren('monthly_actions', reportId, actions);
  await seedChildren('monthly_issues', reportId, issues);
  await seedChildren('monthly_decisions', reportId, decisions);

  console.log('[seed-monthly-report] 完成：指标 ' + indicators.length + '、部门 ' + deptSummary.length +
    '、行动 ' + actions.length + '、问题 ' + issues.length + '、决策 ' + decisions.length);
}

main().then(() => {
  console.log('[seed-monthly-report] 种子数据灌入完成。');
  process.exit(0);
}).catch((e) => {
  console.error('[seed-monthly-report] 失败：', e);
  process.exit(1);
});
