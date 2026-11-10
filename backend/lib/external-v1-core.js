/**
 * EBMS 对外只读接口 v1 —— 核心逻辑（不依赖 express，供路由与回归测试共用）。
 *
 * 鉴权：X-App-Key + X-Timestamp + X-Signature
 *       signature = HMAC-SHA256(AppSecret, "{timestamp}.{method}.{path}")
 */
const crypto = require('crypto');
const { getTable } = require('../db');

const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

function appKey() { return process.env.EBMS_EXTERNAL_APP_KEY || ''; }
function appSecret() { return process.env.EBMS_EXTERNAL_APP_SECRET || ''; }

function verifySignature(secret, timestamp, signature, method, path, now = Date.now()) {
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const tsMs = ts < 1e12 ? ts * 1000 : ts;
  if (Math.abs(Number(now) - tsMs) > SIGNATURE_WINDOW_MS) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(String(timestamp) + '.' + String(method) + '.' + String(path))
    .digest('hex');
  const actual = String(signature).replace(/^sha256=/, '');
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function mapSopStatus(s) {
  const map = { PENDING: 'pending', IN_PROGRESS: 'in_progress', VERIFYING: 'awaiting_acceptance', CLOSED: 'done', CANCELLED: 'cancelled' };
  return map[s] || 'pending';
}

function collectTodos() {
  const items = [];
  const add = (item) => items.push(item);
  try {
    getTable('sop_actions').all()
      .filter(a => a.status && !['CLOSED', 'CANCELLED'].includes(a.status))
      .forEach(a => add({
        work_item_id: 'ebms:sop_action:' + a.id,
        source_object_type: 'SopAction',
        title: a.description || a.action_code || '',
        owner: a.owner_name || a.owner_role || '',
        status: mapSopStatus(a.status),
        due_date: a.due_date || '',
        source_system: 'M03'
      }));
  } catch (e) {}
  try {
    getTable('ai_actions').all()
      .filter(a => !a.status || ['pending', 'in_progress'].includes(a.status))
      .forEach(a => add({
        work_item_id: 'ebms:ai_action:' + a.id,
        source_object_type: 'AiAction',
        title: a.title || a.content || '',
        owner: a.assignee || a.user || '',
        status: a.status === 'in_progress' ? 'in_progress' : 'pending',
        due_date: a.deadline || '',
        source_system: 'M03'
      }));
  } catch (e) {}
  try {
    getTable('chat_action_items').all()
      .filter(a => !a.status || a.status === 'pending')
      .forEach(a => add({
        work_item_id: 'ebms:chat_action_item:' + a.id,
        source_object_type: 'ChatActionItem',
        title: a.content || '',
        owner: a.assignee || a.created_by || '',
        status: 'pending',
        due_date: '',
        source_system: 'M03'
      }));
  } catch (e) {}
  return items;
}

module.exports = {
  SIGNATURE_WINDOW_MS,
  appKey,
  appSecret,
  verifySignature,
  mapSopStatus,
  collectTodos
};
