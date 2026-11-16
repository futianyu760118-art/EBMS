/**
 * 问题反馈 AI 自动分析（对齐 M04 PLM 的 feedback autofix：自动分类 + 方案建议 + 派单）。
 *
 * 复用系统 AI 配置（system_settings.ai_api_config，与 chat.js 同一套），
 * 无 AI 配置时自动跳过（返回 null），不影响反馈提交主流程。
 */
const { getTable } = require('../db');

function getAiConfig() {
  try {
    const table = getTable('system_settings');
    table._invalidate();
    const s = table.all().find((x) => x.key === 'ai_api_config');
    if (!s || !s.value) return null;
    const cfg = JSON.parse(s.value);
    return {
      apiKey: cfg.apiKey || '',
      apiBase: cfg.apiBase || 'https://api.openai.com/v1',
      model: cfg.model || 'gpt-4o-mini'
    };
  } catch (e) {
    return null;
  }
}

function parseAiResult(content) {
  if (!content) return null;
  try {
    const cleaned = String(content).replace(/```json|```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end < start) return null;
    const json = JSON.parse(cleaned.slice(start, end + 1));
    return {
      type: ['bug', 'feature', 'improvement', 'question'].includes(json.type) ? json.type : null,
      priority: ['low', 'medium', 'high', 'urgent'].includes(json.priority) ? json.priority : null,
      proposal: typeof json.proposal === 'string' ? json.proposal.trim() : '',
      assignee: typeof json.assignee === 'string' ? json.assignee.trim() : ''
    };
  } catch (e) {
    return null;
  }
}

/**
 * 调用 AI 分析反馈，返回 { type, priority, proposal, assignee }；失败/无配置返回 null。
 */
async function analyzeFeedback(feedback) {
  const cfg = getAiConfig();
  if (!cfg || !cfg.apiKey) return null;

  const prompt = [
    '你是企业管理系统的问题反馈分析助手。分析下面这条反馈，只输出一个 JSON 对象（不要 markdown 代码块、不要解释）：',
    '{"type":"bug|feature|improvement|question","priority":"low|medium|high|urgent","proposal":"解决方案建议（一句话，含建议负责方向）","assignee":"建议处理角色或部门（如 研发/采购/销售/品质/信息化）"}',
    '',
    '反馈标题：' + (feedback.title || ''),
    '反馈描述：' + (feedback.description || '（无）'),
    '所属模块：' + (feedback.module || '（未指定）')
  ].join('\n');

  try {
    const response = await globalThis.fetch(`${cfg.apiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: '你只输出一个 JSON 对象，不要任何额外文字。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 500
      })
    });
    const data = await response.json();
    if (data && data.error) return null;
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    return parseAiResult(content);
  } catch (e) {
    return null;
  }
}

module.exports = { getAiConfig, parseAiResult, analyzeFeedback };
