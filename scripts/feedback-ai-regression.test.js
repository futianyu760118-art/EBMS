/**
 * 问题反馈 AI 自动分析回归测试（隔离数据目录，不触碰生产、不发真实 AI 请求）。
 * 运行：node scripts/feedback-ai-regression.test.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebms-feedback-ai-'));
process.env.EBMS_DATA_DIR = tempDir;
process.env.USE_JSON_DB = '1';

const { getTable } = require('../backend/db');
const feedbackAi = require('../backend/lib/feedback-ai');

async function main() {
  // ---- parseAiResult：解析 AI JSON 输出 ----
  const r1 = feedbackAi.parseAiResult(
    '{"type":"bug","priority":"high","proposal":"修复订单成本计算精度问题","assignee":"研发"}'
  );
  assert.equal(r1.type, 'bug');
  assert.equal(r1.priority, 'high');
  assert.equal(r1.proposal, '修复订单成本计算精度问题');
  assert.equal(r1.assignee, '研发');

  // markdown 代码块包裹也能解析
  const r2 = feedbackAi.parseAiResult(
    '```json\n{"type":"feature","priority":"medium","proposal":"增加导出","assignee":"信息化"}\n```'
  );
  assert.equal(r2.type, 'feature');
  assert.equal(r2.assignee, '信息化');

  // 非法输出返回 null
  assert.equal(feedbackAi.parseAiResult('不是 JSON'), null);
  assert.equal(feedbackAi.parseAiResult(''), null);

  // 非法枚举被过滤
  const r3 = feedbackAi.parseAiResult('{"type":"hack","priority":"urgent","proposal":"x","assignee":"y"}');
  assert.equal(r3.type, null, '非法 type 应置 null');
  assert.equal(r3.priority, 'urgent');

  // ---- getAiConfig：无配置返回 null ----
  assert.equal(feedbackAi.getAiConfig(), null, '无 ai_api_config 配置应返回 null');

  // ---- analyzeFeedback：无 AI 配置 fail-closed 返回 null（不发请求）----
  const result = await feedbackAi.analyzeFeedback({ title: '测试', description: '', module: '' });
  assert.equal(result, null, '无 AI 配置应跳过自动分析');

  console.log('feedback ai regression checks passed');
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
});
