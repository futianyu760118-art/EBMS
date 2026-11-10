const express = require('express');
const router = express.Router();

router.use('/inquiries', require('./inquiry'));
router.use('/products', require('./product'));
router.use('/customers', require('./customer'));
router.use('/materials', require('./material'));
router.use('/material-costs', require('./material-costs'));
router.use('/materials-ext', require('./material-ext'));
router.use('/procurement', require('./procurement'));
router.use('/suppliers', require('./supplier'));
router.use('/external-api', require('./external-api'));
router.use('/orders', require('./order'));
router.use('/samples', require('./sample'));
router.use('/projects', require('./project'));
router.use('/annual-plan', require('./annual-plan'));
router.use('/amiba', require('./amiba'));
router.use('/products/bom-types', require('./bom-type'));
router.use('/products/bom-issues', require('./bom-issue'));
router.use('/pricing', require('./pricing'));
router.use('/quote', require('./quote').router);
router.use('/users', require('./user'));
router.use('/reports', require('./report'));
router.use('/import', require('./import'));
router.use('/permissions', require('./permission'));
router.use('/feedback', require('./feedback'));
router.use('/settings', require('./settings'));
// 测试端点仅开发环境暴露，生产环境不挂载（P0-3）
if (process.env.NODE_ENV !== 'production') {
  router.use('/test', require('./test'));
}
router.use('/compliance', require('./compliance'));
router.use('/configs', require('./config'));
router.use('/chat', require('./chat'));
router.use('/rules', require('./rules'));
router.use('/spec-library', require('./spec-library'));
router.use('/data-clean', require('./data-clean'));
router.use('/ai-assistant', require('./ai-assistant'));
router.use('/bom', require('./bom'));
router.use('/external-sync', require('./external-sync'));
router.use('/external', require('./external-service'));

// EBMS 对外只读接口 v1（对齐恒聘通/会议中心/M06-SPC 的 external 规范：AppKey+AppSecret 鉴权、/docs、/openapi.json）
router.use('/v1/external', require('./external-v1'));
router.use('/tech', require('./tech-transfer'));
router.use('/organization', require('./organization'));
router.use('/data-scope', require('./data-scope'));
router.use('/material-check', require('./material-check'));
router.use('/expenses', require('./expense'));
router.use('/labor', require('./labor'));
router.use('/product-labor-rate', require('./product-labor-rate'));
router.use('/material-issues', require('./material-issue'));
router.use('/order-analysis', require('./order-analysis'));

router.use('/order-check', require('./order-check'));

router.use('/sop', require('./sop'));
router.use('/im', require('./im'));

// AEOS 销售数据同步通道（EBMS↔CRM 双向同步端点，契约见 contracts/aeos-contracts-v1.schema.json）
router.use('/aeos', require('./aeos'));

// M01 人员生命周期回写（离职后停用 EBMS 相关信息）
router.use('/m01', require('./m01'));

// M10 POMS 微系统对接（EBMS/M03 管理行动 → M10 执行面，契约见 contracts/m10-poms-v1.schema.json）
router.use('/m10', require('./m10'));

// 月度经营报告（M03 经营驾驶舱：核心指标/瓶颈/部门红黄绿/决议履约/问题诊断/决策清单）
router.use('/monthly-report', require('./monthly-report'));

module.exports = router;
